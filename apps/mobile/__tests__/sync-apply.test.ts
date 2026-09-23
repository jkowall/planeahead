/**
 * The offline store's write paths against a real in-memory SQLite (ruling P5): the page apply,
 * the pull loop and its 410, 400 and 401 branches, the owner and store-version checks, per-element
 * forward compatibility, and the outbox drain with its suspension, key regeneration and order.
 */

import { applySyncPage } from '../src/lib/sync/apply';
import {
  createSyncClient,
  MAX_RESETS_PER_PULL,
  SyncError,
  type SyncTransport,
} from '../src/lib/sync/client';
import { ApplyGate } from '../src/lib/sync/gate';
import { createOutbox, enqueueMutation, pendingCount } from '../src/lib/sync/outbox';
import { readCursor, readSyncState } from '../src/lib/sync/store';
import { STORE_SCHEMA_VERSION } from '../src/lib/sync/version';
import { subscribeToTable } from '../src/lib/db/store-signal';
import { SyncEnvelopeV1 } from '@planeahead/shared';
import type { RawRequest, RawResponse } from '../src/lib/api-client';
import {
  createMemorySqlite,
  migrationStatements,
  type MemorySqlite,
} from './support/memory-sqlite';
import {
  AA100,
  BA117,
  cursorAt,
  envelope,
  flight,
  id,
  page,
  preferencesUpsert,
  subscriptionDelete,
  subscriptionUpsert,
} from './support/sync-fixtures';

interface SubscriptionRow {
  id: string;
  flight_key: string;
  label: string | null;
  muted: number;
  flight_status: string | null;
  scheduled_out: string | null;
  origin_gate: string | null;
  snapshot_json: string | null;
}

function subscriptions(db: MemorySqlite): SubscriptionRow[] {
  return db.raw
    .prepare('SELECT * FROM flight_subscriptions ORDER BY id')
    .all() as SubscriptionRow[];
}

function parsePage(raw: Record<string, unknown>) {
  return SyncEnvelopeV1.parse(raw);
}

const USER = 'user-anon-0001';
const OTHER_USER = 'user-account-0002';

/** A store that holds rows pulled for `owner` at `cursor`, written by this build. */
function seeded(owner: string, cursor: string, changes: Record<string, unknown>[]) {
  const db = createMemorySqlite();
  applySyncPage(db, parsePage(page({ changes, cursor })), {
    ownerUserId: owner,
    storeVersion: STORE_SCHEMA_VERSION,
  });
  return db;
}

function count(db: MemorySqlite, table: string): number {
  return (db.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** A transport that answers from a script and records the cursor of every request. */
function scripted(responses: { status: number; body: unknown }[]) {
  const cursors: (string | null)[] = [];
  const transport: SyncTransport = {
    pull(cursor) {
      cursors.push(cursor);
      const next = responses.shift();
      if (next === undefined) {
        throw new Error('the sync transport ran out of scripted responses');
      }
      return Promise.resolve(next);
    },
  };
  return { transport, cursors };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('the store schema', () => {
  it('never uses the constructs that silence the update hook', () => {
    const ddl = migrationStatements().join('\n');
    expect(ddl).not.toMatch(/WITHOUT\s+ROWID/i);
    expect(ddl).toMatch(/CREATE TABLE `flight_subscriptions`/);
    expect(ddl).toMatch(/`snapshot_json` text/);
    expect(ddl).toMatch(/CREATE TABLE `sync_state`/);
    expect(ddl).toMatch(/CREATE TABLE `outbox`/);
    expect(ddl).toMatch(/CREATE TABLE `trips`/);
    expect(ddl).toMatch(/CREATE TABLE `logbook_entries`/);
  });
});

describe('applySyncPage', () => {
  it('applies a page and its cursor in ONE immediate transaction', () => {
    const db = createMemorySqlite();
    const outcome = applySyncPage(
      db,
      parsePage(
        page({
          changes: [
            subscriptionUpsert(1, AA100),
            subscriptionUpsert(2, BA117),
            preferencesUpsert(),
          ],
          flights: [flight(AA100), flight(BA117, { status: 'boarding', originGate: 'A10' })],
          cursor: cursorAt(3),
        }),
      ),
    );

    expect(db.transactions).toHaveLength(1);
    const [transaction] = db.transactions;
    expect(transaction?.behavior).toBe('immediate');
    expect(transaction?.outcome).toBe('committed');
    // The cursor is written inside the same transaction, after the rows.
    const last = transaction?.statements.at(-1) ?? '';
    expect(last).toMatch(/INSERT INTO sync_state/);
    expect(readCursor(db)).toBe(cursorAt(3));

    expect(outcome.changes).toBe(3);
    expect(outcome.flights).toBe(2);
    expect(outcome.preferences).toEqual({
      distanceUnit: 'km',
      temperatureUnit: 'c',
      timeFormat: '24h',
      showLocalTimes: true,
      settings: {},
    });

    const rows = subscriptions(db);
    expect(rows.map((row) => [row.flight_key, row.flight_status, row.origin_gate])).toEqual([
      [AA100, 'scheduled', 'B22'],
      [BA117, 'boarding', 'A10'],
    ]);
    expect(rows[0]?.scheduled_out).toBe('2026-09-20T03:50:00Z');
    expect(JSON.parse(rows[0]?.snapshot_json ?? '{}')).toMatchObject({ key: AA100 });
  });

  it('rolls the rows AND the cursor back together when a statement fails mid-page', () => {
    const db = createMemorySqlite();
    applySyncPage(
      db,
      parsePage(page({ changes: [subscriptionUpsert(1, AA100)], cursor: cursorAt(1) })),
    );
    db.failNext(/UPDATE flight_subscriptions SET/);

    expect(() =>
      applySyncPage(
        db,
        parsePage(
          page({
            changes: [subscriptionUpsert(2, BA117)],
            flights: [flight(BA117)],
            cursor: cursorAt(2),
          }),
        ),
      ),
    ).toThrow(/injected failure/);

    expect(db.transactions.at(-1)?.outcome).toBe('rolled_back');
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(1)]);
    expect(readCursor(db)).toBe(cursorAt(1));
  });

  it('keeps the denormalised snapshot when a later page only changes the subscription', () => {
    const db = createMemorySqlite();
    applySyncPage(
      db,
      parsePage(
        page({
          changes: [subscriptionUpsert(1, AA100)],
          flights: [flight(AA100)],
          cursor: cursorAt(1),
        }),
      ),
    );
    applySyncPage(
      db,
      parsePage(
        page({
          changes: [subscriptionUpsert(1, AA100, { label: 'Home', muted: true })],
          cursor: cursorAt(2),
        }),
      ),
    );
    const [row] = subscriptions(db);
    expect(row).toMatchObject({
      label: 'Home',
      muted: 1,
      flight_status: 'scheduled',
      origin_gate: 'B22',
    });
  });

  it('deletes by id, with a WHERE clause, never an unqualified DELETE or INSERT OR REPLACE', () => {
    const db = createMemorySqlite();
    applySyncPage(
      db,
      parsePage(
        page({
          changes: [subscriptionUpsert(1, AA100), subscriptionUpsert(2, BA117)],
          cursor: cursorAt(2),
        }),
      ),
    );
    applySyncPage(db, parsePage(page({ changes: [subscriptionDelete(1)], cursor: cursorAt(3) })));

    expect(subscriptions(db).map((row) => row.id)).toEqual([id(2)]);
    for (const statement of db.statements) {
      expect(statement).not.toMatch(/INSERT\s+OR\s+REPLACE/i);
      expect(statement).not.toMatch(/REPLACE\s+INTO/i);
      if (/^\s*DELETE\s+FROM/i.test(statement)) {
        expect(statement).toMatch(/\bWHERE\b/i);
      }
    }
  });

  it('skips a row that does not parse, names it, and still commits the rest and the cursor', () => {
    const db = createMemorySqlite();
    const broken = subscriptionUpsert(2, BA117);
    (broken['row'] as Record<string, unknown>)['muted'] = 'yes';
    const outcome = applySyncPage(
      db,
      parsePage(page({ changes: [subscriptionUpsert(1, AA100), broken], cursor: cursorAt(2) })),
    );
    expect(outcome.skipped).toEqual([
      { entity: 'flight_subscriptions', id: id(2), field: 'row.muted' },
    ]);
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(1)]);
    expect(readCursor(db)).toBe(cursorAt(2));
  });
  it('signals each touched table ONCE per page, after the commit', () => {
    const db = createMemorySqlite();
    const calls: string[] = [];
    const unsubscribe = [
      subscribeToTable('flight_subscriptions', () => {
        calls.push(`flight_subscriptions (in transaction: ${String(db.inTransaction)})`);
      }),
      subscribeToTable('user_preferences', () => calls.push('user_preferences')),
      subscribeToTable('trips', () => calls.push('trips')),
    ];
    try {
      const changes = Array.from({ length: 200 }, (_, n) =>
        subscriptionUpsert(n + 1, n % 2 === 0 ? AA100 : BA117),
      );
      applySyncPage(
        db,
        parsePage(page({ changes, flights: [flight(AA100), flight(BA117)], cursor: cursorAt(1) })),
      );
      expect(count(db, 'flight_subscriptions')).toBe(200);
      expect(calls).toEqual(['flight_subscriptions (in transaction: false)']);
    } finally {
      unsubscribe.forEach((stop) => {
        stop();
      });
    }
  });

  it('skips an element a newer server sends (provider, entity, op) and still commits the page', () => {
    const db = createMemorySqlite();
    const outcome = applySyncPage(
      db,
      page({
        changes: [
          subscriptionUpsert(1, AA100),
          subscriptionUpsert(2, BA117),
          { ...subscriptionUpsert(3, BA117), entity: 'shared_boards' },
          { ...subscriptionUpsert(4, BA117), op: 'patch' },
        ],
        flights: [flight(AA100), flight(BA117, { source: 'flightaware_firehose' })],
        cursor: cursorAt(5),
      }) as never,
    );
    expect(outcome.changes).toBe(2);
    expect(outcome.flights).toBe(1);
    expect(outcome.skipped).toEqual([
      { entity: 'shared_boards', id: id(3), field: 'entity' },
      { entity: 'flight_subscriptions', id: id(4), field: 'op' },
      { entity: 'flight', id: '#1', field: 'source' },
    ]);
    // Never a value, never a flight key.
    expect(JSON.stringify(outcome.skipped)).not.toContain('flightaware_firehose');
    expect(JSON.stringify(outcome.skipped)).not.toContain(BA117);
    expect(subscriptions(db).map((row) => [row.id, row.flight_status])).toEqual([
      [id(1), 'scheduled'],
      [id(2), null],
    ]);
    expect(readCursor(db)).toBe(cursorAt(5));
  });
});

describe('the sync client', () => {
  it('pulls page after page until hasMore is false, one transaction per page', async () => {
    const db = createMemorySqlite();
    const { transport, cursors } = scripted([
      {
        status: 200,
        body: page({ changes: [subscriptionUpsert(1, AA100)], cursor: cursorAt(1), hasMore: true }),
      },
      {
        status: 200,
        body: page({ changes: [subscriptionUpsert(2, BA117)], cursor: cursorAt(2), hasMore: true }),
      },
      { status: 200, body: page({ cursor: cursorAt(3) }) },
    ]);
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    });

    await expect(client.sync(USER)).resolves.toEqual({
      kind: 'synced',
      pages: 3,
      changes: 2,
      resets: 0,
    });
    expect(cursors).toEqual([null, cursorAt(1), cursorAt(2)]);
    expect(db.transactions.map((transaction) => transaction.behavior)).toEqual([
      'immediate',
      'immediate',
      'immediate',
    ]);
    expect(readCursor(db)).toBe(cursorAt(3));
  });

  it('410 resync_required keeps the rows, then the no-cursor snapshot replaces them in ONE transaction', async () => {
    const db = seeded(USER, cursorAt(9), [subscriptionUpsert(1, AA100), preferencesUpsert()]);
    enqueueMutation(db, { method: 'POST', path: '/v1/flights', body: { flightKey: BA117 } });
    const seen: number[] = [];
    const { cursors } = scripted([]);
    const transport: SyncTransport = {
      pull(cursor) {
        cursors.push(cursor);
        // What a live query would show while the request is in flight.
        seen.push(count(db, 'flight_subscriptions'));
        return Promise.resolve(
          cursor === null
            ? {
                status: 200,
                body: page({ changes: [subscriptionUpsert(2, BA117)], cursor: cursorAt(1) }),
              }
            : { status: 410, body: envelope('resync_required') },
        );
      },
    };
    const onPreferences = jest.fn();
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      onPreferences,
    });
    const before = db.transactions.length;

    await expect(client.sync(USER)).resolves.toMatchObject({ kind: 'synced', resets: 1 });
    // The stale cursor first, then no cursor at all: the snapshot. The rows stayed on screen
    // for both requests.
    expect(cursors).toEqual([cursorAt(9), null]);
    expect(seen).toEqual([1, 1]);
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(2)]);
    expect(count(db, 'user_preferences')).toBe(0);
    expect(pendingCount(db)).toBe(1);
    expect(readSyncState(db)).toEqual({
      cursor: cursorAt(1),
      resetPending: false,
      ownerUserId: USER,
      storeVersion: STORE_SCHEMA_VERSION,
    });
    // One transaction after the seed: the deletes, the snapshot and the cursor together.
    const applied = db.transactions.slice(before);
    expect(applied).toHaveLength(1);
    const statements = applied[0]?.statements ?? [];
    const firstDelete = statements.findIndex((statement) => /^\s*DELETE/i.test(statement));
    const insert = statements.findIndex((statement) =>
      /INSERT INTO flight_subscriptions/.test(statement),
    );
    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeLessThan(insert);
    expect(statements.at(-1)).toMatch(/INSERT INTO sync_state/);
    for (const statement of statements.filter((line) => /^\s*DELETE/i.test(line))) {
      expect(statement).toMatch(/\bWHERE\b/i);
    }
  });

  it('keeps the last known rows when the snapshot after a 410 cannot be fetched (offline)', async () => {
    const db = seeded(USER, cursorAt(9), [
      subscriptionUpsert(1, AA100),
      subscriptionUpsert(2, BA117),
    ]);
    let calls = 0;
    const client = createSyncClient({
      db,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      transport: {
        pull() {
          calls += 1;
          return calls === 1
            ? Promise.resolve({ status: 410, body: envelope('resync_required') })
            : Promise.reject(new TypeError('Network request failed'));
        },
      },
    });

    await expect(client.sync(USER)).rejects.toThrow('Network request failed');
    expect(count(db, 'flight_subscriptions')).toBe(2);
    expect(readSyncState(db)).toMatchObject({
      cursor: null,
      resetPending: true,
      ownerUserId: USER,
    });

    // The next launch pulls the snapshot, which replaces the rows and clears the mark.
    const { transport, cursors } = scripted([
      { status: 200, body: page({ changes: [subscriptionUpsert(2, BA117)], cursor: cursorAt(3) }) },
    ]);
    await createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    }).sync(USER);
    expect(cursors).toEqual([null]);
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(2)]);
    expect(readSyncState(db)).toMatchObject({ cursor: cursorAt(3), resetPending: false });
  });

  it('empties the store at once when the session user is not its owner (sign-in to an existing account)', async () => {
    const db = seeded(USER, cursorAt(4), [subscriptionUpsert(1, AA100)]);
    enqueueMutation(db, { method: 'POST', path: '/v1/flights', body: { flightKey: BA117 } });
    const seen: number[] = [];
    const cursors: (string | null)[] = [];
    const client = createSyncClient({
      db,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      transport: {
        pull(cursor) {
          cursors.push(cursor);
          seen.push(count(db, 'flight_subscriptions'));
          return Promise.resolve({
            status: 200,
            body: page({
              changes: [subscriptionUpsert(1, AA100), subscriptionUpsert(3, BA117)],
              cursor: cursorAt(7),
            }),
          });
        },
      },
    });

    await client.sync(OTHER_USER);
    // No cursor was sent (it was bound to the other user) and nothing of theirs was on screen.
    expect(cursors).toEqual([null]);
    expect(seen).toEqual([0]);
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(1), id(3)]);
    expect(readSyncState(db)?.ownerUserId).toBe(OTHER_USER);
    // The outbox is this installation's intent and survives the switch.
    expect(pendingCount(db)).toBe(1);
  });

  it('treats a 410 after sign-in the same way when the store already belongs to the new user', async () => {
    const db = seeded(OTHER_USER, cursorAt(4), [subscriptionUpsert(1, AA100)]);
    const { transport, cursors } = scripted([
      {
        status: 410,
        body: envelope('resync_required', { message: 'cursor issued to another user' }),
      },
      {
        status: 200,
        body: page({
          changes: [subscriptionUpsert(1, AA100), subscriptionUpsert(3, BA117)],
          cursor: cursorAt(7),
        }),
      },
    ]);
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    });
    await client.sync(OTHER_USER);
    expect(cursors).toEqual([cursorAt(4), null]);
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(1), id(3)]);
  });

  it.each([
    ['400 invalid_cursor', 400, 'invalid_cursor'],
    ['400 validation_failed on the cursor', 400, 'validation_failed'],
  ])('recovers from %s like a 410: snapshot without a cursor', async (_label, status, code) => {
    const db = seeded(USER, cursorAt(8), [subscriptionUpsert(1, AA100)]);
    const { transport, cursors } = scripted([
      { status, body: envelope(code) },
      { status: 200, body: page({ changes: [subscriptionUpsert(2, BA117)], cursor: cursorAt(2) }) },
    ]);
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    });
    await expect(client.sync(USER)).resolves.toMatchObject({ kind: 'synced', resets: 1 });
    expect(cursors).toEqual([cursorAt(8), null]);
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(2)]);
  });

  it('gives up after MAX_RESETS_PER_PULL refusals, and never resets over a 400 without a cursor', async () => {
    const db = seeded(USER, cursorAt(8), [subscriptionUpsert(1, AA100)]);
    const refusals = Array.from({ length: MAX_RESETS_PER_PULL + 1 }, () => ({
      status: 400,
      body: envelope('invalid_cursor'),
    }));
    const { transport, cursors } = scripted(refusals);
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    });
    // After the first reset the pull has no cursor, so a 400 is a plain error.
    await expect(client.sync(USER)).rejects.toMatchObject({ status: 400, code: 'invalid_cursor' });
    expect(cursors).toEqual([cursorAt(8), null]);
    expect(count(db, 'flight_subscriptions')).toBe(1);

    const { transport: gone } = scripted(
      Array.from({ length: MAX_RESETS_PER_PULL + 1 }, () => ({
        status: 410,
        body: envelope('resync_required'),
      })),
    );
    await expect(
      createSyncClient({
        db,
        transport: gone,
        gate: new ApplyGate(),
        onAccountDeleted: jest.fn(),
      }).sync(USER),
    ).rejects.toMatchObject({ status: 410, code: 'resync_required' });
  });

  it('401 account_deleted wipes the store AND the outbox and hands over to onAccountDeleted', async () => {
    const db = createMemorySqlite();
    applySyncPage(
      db,
      parsePage(page({ changes: [subscriptionUpsert(1, AA100)], cursor: cursorAt(1) })),
    );
    enqueueMutation(db, { method: 'DELETE', path: `/v1/flights/${id(1)}` });
    const onAccountDeleted = jest.fn();
    const { transport } = scripted([{ status: 401, body: envelope('account_deleted') }]);
    const client = createSyncClient({ db, transport, gate: new ApplyGate(), onAccountDeleted });

    await expect(client.sync(USER)).resolves.toEqual({ kind: 'account_deleted' });
    expect(onAccountDeleted).toHaveBeenCalledTimes(1);
    expect(subscriptions(db)).toEqual([]);
    expect(pendingCount(db)).toBe(0);
    expect(readCursor(db)).toBeNull();
  });

  it('refuses a page that is not a SyncEnvelopeV1 at all and applies nothing', async () => {
    const db = createMemorySqlite();
    const { transport } = scripted([{ status: 200, body: { cursor: 'nope', changes: 'x' } }]);
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    });
    await expect(client.sync(USER)).rejects.toBeInstanceOf(SyncError);
    expect(db.transactions).toEqual([]);
  });

  it('keeps pulling past a value a newer server sends instead of stalling on it', async () => {
    const db = createMemorySqlite();
    const newer = page({
      changes: [subscriptionUpsert(1, AA100)],
      flights: [flight(AA100, { source: 'flightaware_firehose' })],
      cursor: cursorAt(1),
    });
    const { transport, cursors } = scripted([
      { status: 200, body: newer },
      { status: 200, body: page({ cursor: cursorAt(2) }) },
    ]);
    const onSkipped = jest.fn();
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      onSkipped,
    });
    await expect(client.sync(USER)).resolves.toMatchObject({ kind: 'synced', changes: 1 });
    await client.sync(USER);
    expect(cursors).toEqual([null, cursorAt(1)]);
    expect(onSkipped).toHaveBeenCalledWith([{ entity: 'flight', id: '#0', field: 'source' }]);
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(1)]);
  });

  it('pulls the snapshot again after an app update changes the store version, recovering skipped rows', async () => {
    const db = createMemorySqlite();
    const newer = page({
      changes: [subscriptionUpsert(1, AA100)],
      flights: [flight(AA100, { source: 'flightaware_firehose' })],
      cursor: cursorAt(1),
    });
    // The old build: the flight's snapshot is skipped, the cursor moves past it.
    const old = scripted([{ status: 200, body: newer }]);
    await createSyncClient({
      db,
      transport: old.transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      storeVersion: 'm2-oldbuild',
    }).sync(USER);
    expect(subscriptions(db)[0]?.flight_status).toBeNull();
    expect(readSyncState(db)?.storeVersion).toBe('m2-oldbuild');

    // The updated build can read it: it drops the cursor and takes the snapshot.
    const updated = scripted([
      {
        status: 200,
        body: page({
          changes: [subscriptionUpsert(1, AA100)],
          flights: [flight(AA100, { status: 'boarding' })],
          cursor: cursorAt(4),
        }),
      },
    ]);
    await createSyncClient({
      db,
      transport: updated.transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    }).sync(USER);
    expect(updated.cursors).toEqual([null]);
    expect(subscriptions(db)[0]?.flight_status).toBe('boarding');
    expect(readSyncState(db)).toMatchObject({
      cursor: cursorAt(4),
      storeVersion: STORE_SCHEMA_VERSION,
    });

    // And with the same build again, the cursor is kept.
    const again = scripted([{ status: 200, body: page({ cursor: cursorAt(5) }) }]);
    await createSyncClient({
      db,
      transport: again.transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    }).sync(USER);
    expect(again.cursors).toEqual([cursorAt(4)]);
  });

  it('refuses a page whose shell is not a SyncEnvelopeV1 and applies nothing', async () => {
    const db = createMemorySqlite();
    const { transport } = scripted([
      { status: 200, body: { ...page({ cursor: cursorAt(1) }), hasMore: 'no' } },
    ]);
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    });
    await expect(client.sync(USER)).rejects.toBeInstanceOf(SyncError);
    expect(db.transactions).toEqual([]);
  });

  it('shares one pull between concurrent callers', async () => {
    const db = createMemorySqlite();
    const { transport, cursors } = scripted([{ status: 200, body: page({ cursor: cursorAt(1) }) }]);
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    });
    await Promise.all([client.sync(USER), client.sync(USER), client.sync(USER)]);
    expect(cursors).toEqual([null]);
  });
});

describe('the outbox', () => {
  function sender(responses: RawResponse[]) {
    const sent: RawRequest[] = [];
    return {
      sent,
      transport: {
        send(request: RawRequest) {
          sent.push(request);
          const next = responses.shift();
          if (next === undefined) {
            throw new Error('the outbox transport ran out of scripted responses');
          }
          return Promise.resolve(next);
        },
      },
    };
  }

  it('drains oldest first with each item Idempotency-Key, and a replayed answer counts as sent', async () => {
    const db = createMemorySqlite();
    const first = enqueueMutation(db, {
      method: 'POST',
      path: '/v1/flights',
      body: { flightKey: AA100 },
    });
    const second = enqueueMutation(db, { method: 'DELETE', path: `/v1/flights/${id(1)}` });
    const { transport, sent } = sender([
      { status: 201, body: {}, replayed: true },
      { status: 200, body: {}, replayed: false },
    ]);
    const outbox = createOutbox({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    });

    await expect(outbox.drain()).resolves.toEqual({ kind: 'drained', sent: 2, dropped: 0 });
    expect(sent.map((request) => [request.method, request.idempotencyKey])).toEqual([
      ['POST', first.idempotencyKey],
      ['DELETE', second.idempotencyKey],
    ]);
    expect(pendingCount(db)).toBe(0);
  });

  it('regenerates the key on 422 idempotency_payload_mismatch and resends before anything behind it', async () => {
    const db = createMemorySqlite();
    const item = enqueueMutation(db, {
      method: 'POST',
      path: '/v1/flights',
      body: { flightKey: AA100 },
    });
    enqueueMutation(db, { method: 'POST', path: '/v1/flights', body: { flightKey: BA117 } });
    const { transport, sent } = sender([
      { status: 422, body: envelope('idempotency_payload_mismatch'), replayed: false },
      { status: 201, body: {}, replayed: false },
      { status: 201, body: {}, replayed: false },
    ]);
    const onKeyRegenerated = jest.fn();
    const outbox = createOutbox({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      onKeyRegenerated,
      newKey: () => 'fresh-key-0000000001',
    });

    await expect(outbox.drain()).resolves.toMatchObject({ kind: 'drained', sent: 2 });
    expect(sent.map((request) => request.idempotencyKey)).toEqual([
      item.idempotencyKey,
      'fresh-key-0000000001',
      expect.any(String),
    ]);
    // The re-keyed item went again BEFORE the second item.
    expect(sent[1]?.body).toEqual({ flightKey: AA100 });
    expect(sent[2]?.body).toEqual({ flightKey: BA117 });
    expect(onKeyRegenerated).toHaveBeenCalledWith(expect.objectContaining({ id: item.id }));
    // Reported without the body.
    expect(JSON.stringify(onKeyRegenerated.mock.calls)).not.toContain(BA117);
  });

  it('drops a terminal 4xx after surfacing it, and stops at a retryable failure (strict FIFO)', async () => {
    const db = createMemorySqlite();
    enqueueMutation(db, { method: 'POST', path: '/v1/flights', body: { number: 'XX' } });
    enqueueMutation(db, {
      method: 'PATCH',
      path: '/v1/me/preferences',
      body: { timeFormat: '24h' },
    });
    enqueueMutation(db, { method: 'DELETE', path: `/v1/flights/${id(2)}` });
    const responses: RawResponse[] = [
      { status: 400, body: envelope('validation_failed'), replayed: false },
      { status: 503, body: envelope('unavailable'), replayed: false },
    ];
    const { transport, sent } = sender(responses);
    const onDropped = jest.fn();
    let clock = 1_000;
    const outbox = createOutbox({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      onDropped,
      now: () => clock,
    });

    await expect(outbox.drain()).resolves.toEqual({ kind: 'deferred', sent: 0, dropped: 1 });
    expect(onDropped).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, code: 'validation_failed' }),
    );
    expect(sent).toHaveLength(2);
    expect(pendingCount(db)).toBe(2);
    expect(db.raw.prepare('SELECT attempts FROM outbox ORDER BY seq LIMIT 1').get()).toEqual({
      attempts: 1,
    });
    // Before its backoff ends the head waits, and nothing behind it overtakes it.
    await expect(outbox.drain()).resolves.toEqual({ kind: 'deferred', sent: 0, dropped: 0 });
    expect(sent).toHaveLength(2);
    // After it, the head goes first.
    clock += 60_000;
    responses.push(
      { status: 200, body: {}, replayed: false },
      { status: 204, body: null, replayed: false },
    );
    await expect(outbox.drain()).resolves.toEqual({ kind: 'drained', sent: 2, dropped: 0 });
    expect(sent.slice(2).map((request) => request.method)).toEqual(['PATCH', 'DELETE']);
  });

  it('drains in insertion order even when the clock stepped backwards between two launches', async () => {
    const db = createMemorySqlite();
    // Launch 1 at T queues the subscribe; launch 2, after the clock moved back two minutes,
    // queues the unsubscribe. Their uuidv7 ids sort the other way round.
    const later = '0199a000-0000-7000-8000-000000000002';
    const earlier = '0199a000-0000-7000-8000-000000000001';
    enqueueMutation(
      db,
      { method: 'POST', path: '/v1/flights', body: { flightKey: AA100 } },
      { id: later },
    );
    enqueueMutation(db, { method: 'DELETE', path: `/v1/flights/${id(1)}` }, { id: earlier });
    const { transport, sent } = sender([
      { status: 201, body: {}, replayed: false },
      { status: 204, body: null, replayed: false },
    ]);
    const outbox = createOutbox({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    });
    await outbox.drain();
    expect(sent.map((request) => request.method)).toEqual(['POST', 'DELETE']);
  });

  it('picks up an item queued while a drain was emptying the queue', async () => {
    const db = createMemorySqlite();
    enqueueMutation(db, { method: 'POST', path: '/v1/flights', body: { flightKey: AA100 } });
    const sent: string[] = [];
    const outbox = createOutbox({
      db,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      transport: {
        send(request) {
          sent.push(request.method);
          if (sent.length === 1) {
            enqueueMutation(db, { method: 'DELETE', path: `/v1/flights/${id(1)}` });
          }
          return Promise.resolve({ status: 200, body: {}, replayed: false });
        },
      },
    });
    await expect(outbox.drain()).resolves.toEqual({ kind: 'drained', sent: 2, dropped: 0 });
    expect(sent).toEqual(['POST', 'DELETE']);
  });

  it('401 account_deleted wipes the store and the outbox', async () => {
    const db = createMemorySqlite();
    applySyncPage(
      db,
      parsePage(page({ changes: [subscriptionUpsert(1, AA100)], cursor: cursorAt(1) })),
    );
    enqueueMutation(db, { method: 'DELETE', path: `/v1/flights/${id(1)}` });
    const onAccountDeleted = jest.fn();
    const { transport } = sender([
      { status: 401, body: envelope('account_deleted'), replayed: false },
    ]);
    const outbox = createOutbox({ db, transport, gate: new ApplyGate(), onAccountDeleted });
    await expect(outbox.drain()).resolves.toEqual({ kind: 'account_deleted' });
    expect(onAccountDeleted).toHaveBeenCalledTimes(1);
    expect(pendingCount(db)).toBe(0);
    expect(subscriptions(db)).toEqual([]);
  });

  it('is suspended while a sync pull holds the gate, and resumes when the pages are applied', async () => {
    const db = createMemorySqlite();
    enqueueMutation(db, { method: 'POST', path: '/v1/flights', body: { flightKey: AA100 } });
    const gate = new ApplyGate();
    const firstPage = deferred<{ status: number; body: unknown }>();
    const order: string[] = [];
    const client = createSyncClient({
      db,
      gate,
      onAccountDeleted: jest.fn(),
      transport: {
        async pull() {
          order.push('pull');
          const response = await firstPage.promise;
          order.push('page applied next');
          return response;
        },
      },
    });
    const outbox = createOutbox({
      db,
      gate,
      onAccountDeleted: jest.fn(),
      transport: {
        send() {
          order.push(
            `send (gate busy: ${String(gate.busy)}, in transaction: ${String(db.inTransaction)})`,
          );
          return Promise.resolve({ status: 201, body: {}, replayed: false });
        },
      },
    });

    const pulling = client.sync(USER);
    const draining = outbox.drain();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual(['pull']);
    expect(pendingCount(db)).toBe(1);

    firstPage.resolve({
      status: 200,
      body: page({ changes: [subscriptionUpsert(1, AA100)], cursor: cursorAt(1) }),
    });
    await pulling;
    await draining;
    expect(order).toEqual([
      'pull',
      'page applied next',
      'send (gate busy: false, in transaction: false)',
    ]);
    expect(pendingCount(db)).toBe(0);
  });
});
