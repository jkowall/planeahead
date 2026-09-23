/**
 * The offline store's write paths against a real in-memory SQLite (ruling P5): the page apply,
 * the pull loop and its 410 and 401 branches, and the outbox drain with its suspension and key
 * regeneration.
 */

import { applySyncPage } from '../src/lib/sync/apply';
import { createSyncClient, SyncError, type SyncTransport } from '../src/lib/sync/client';
import { ApplyGate } from '../src/lib/sync/gate';
import { createOutbox, enqueueMutation, pendingCount } from '../src/lib/sync/outbox';
import { readCursor } from '../src/lib/sync/store';
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
    expect(outcome.skipped).toEqual([{ entity: 'flight_subscriptions', id: id(2) }]);
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(1)]);
    expect(readCursor(db)).toBe(cursorAt(2));
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

    await expect(client.sync()).resolves.toEqual({
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

  it('410 resync_required resets the synced tables (not the outbox) and re-pulls the no-cursor snapshot', async () => {
    const db = createMemorySqlite();
    applySyncPage(
      db,
      parsePage(
        page({ changes: [subscriptionUpsert(1, AA100), preferencesUpsert()], cursor: cursorAt(9) }),
      ),
    );
    enqueueMutation(db, { method: 'POST', path: '/v1/flights', body: { flightKey: BA117 } });
    const { transport, cursors } = scripted([
      { status: 410, body: envelope('resync_required') },
      { status: 200, body: page({ changes: [subscriptionUpsert(2, BA117)], cursor: cursorAt(1) }) },
    ]);
    const onPreferences = jest.fn();
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
      onPreferences,
    });

    await expect(client.sync()).resolves.toMatchObject({ kind: 'synced', resets: 1 });
    // The stale cursor first, then no cursor at all: the snapshot.
    expect(cursors).toEqual([cursorAt(9), null]);
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(2)]);
    expect(db.raw.prepare('SELECT count(*) AS n FROM user_preferences').get()).toEqual({ n: 0 });
    expect(pendingCount(db)).toBe(1);
    expect(readCursor(db)).toBe(cursorAt(1));
    // The reset deleted row by row: every DELETE named its rows.
    const deletes = db.statements.filter((statement) => /^\s*DELETE/i.test(statement));
    expect(deletes.length).toBeGreaterThan(0);
    for (const statement of deletes) {
      expect(statement).toMatch(/\bWHERE\b/i);
    }
  });

  it('treats a 410 after sign-in (a cursor bound to the anonymous user) the same way', async () => {
    const db = createMemorySqlite();
    applySyncPage(
      db,
      parsePage(page({ changes: [subscriptionUpsert(1, AA100)], cursor: cursorAt(4) })),
    );
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
    await client.sync();
    expect(cursors).toEqual([cursorAt(4), null]);
    expect(subscriptions(db).map((row) => row.id)).toEqual([id(1), id(3)]);
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

    await expect(client.sync()).resolves.toEqual({ kind: 'account_deleted' });
    expect(onAccountDeleted).toHaveBeenCalledTimes(1);
    expect(subscriptions(db)).toEqual([]);
    expect(pendingCount(db)).toBe(0);
    expect(readCursor(db)).toBeNull();
  });

  it('refuses a page that is not a SyncEnvelopeV1 and applies nothing', async () => {
    const db = createMemorySqlite();
    const { transport } = scripted([{ status: 200, body: { cursor: 'nope', changes: 'x' } }]);
    const client = createSyncClient({
      db,
      transport,
      gate: new ApplyGate(),
      onAccountDeleted: jest.fn(),
    });
    await expect(client.sync()).rejects.toBeInstanceOf(SyncError);
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
    await Promise.all([client.sync(), client.sync(), client.sync()]);
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
    expect(db.raw.prepare('SELECT attempts FROM outbox ORDER BY id LIMIT 1').get()).toEqual({
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

    const pulling = client.sync();
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
