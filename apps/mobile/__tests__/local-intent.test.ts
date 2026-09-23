/**
 * Local intent survives a pull (increment 10 review, rulings X3 and X7 item 3), through the
 * SqliteLike fake, the real outbox with a scripted transport and the real sync client:
 *
 * - a DELETE deferred by a 5xx keeps its local tombstone through a successful pull, a snapshot
 *   replace and a delta page that carries a server-side change to the row alike, and the row goes
 *   for good when the DELETE settles;
 * - the local-only columns (`finished_at` from a 410, `added_as` from the add) are carried across
 *   a snapshot replace, inside the page's transaction.
 */

import type { RawRequest, RawResponse } from '../src/lib/api-client';
import { listFlights, readFlight } from '../src/lib/flight-queries';
import { flightOutboxHooks, removeFlight } from '../src/lib/flights';
import { applySyncPage, SyncPageShell } from '../src/lib/sync/apply';
import { createSyncClient } from '../src/lib/sync/client';
import { ApplyGate } from '../src/lib/sync/gate';
import { createOutbox, pendingCount } from '../src/lib/sync/outbox';
import { STORE_SCHEMA_VERSION } from '../src/lib/sync/version';
import {
  AA100_ID,
  AA100_KEY,
  BA117_ID,
  BA117_KEY,
  DL1_ID,
  DL1_KEY,
  aa100Snapshot,
  ba117Snapshot,
  dl1Snapshot,
  seedStore,
} from './support/flight-fixtures';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import { cursorAt, envelope, page, subscriptionUpsert } from './support/sync-fixtures';

const USER = 'user-1';

function outboxOver(db: MemorySqlite, gate: ApplyGate, answers: RawResponse[], nowMs = 0) {
  const sent: RawRequest[] = [];
  const outbox = createOutbox({
    db,
    gate,
    onAccountDeleted: jest.fn(),
    ...flightOutboxHooks(db),
    now: () => nowMs,
    transport: {
      send(request) {
        sent.push(request);
        const next = answers.shift();
        return next === undefined
          ? Promise.reject(new TypeError('offline'))
          : Promise.resolve(next);
      },
    },
  });
  return { outbox, sent };
}

function pullOver(db: MemorySqlite, gate: ApplyGate, body: unknown) {
  return createSyncClient({
    db,
    gate,
    onAccountDeleted: jest.fn(),
    storeVersion: STORE_SCHEMA_VERSION,
    transport: { pull: () => Promise.resolve({ status: 200, body }) },
  });
}

/** The account's three rows as the server still has them (it has not seen the DELETE). */
function serverPage(overrides: { readonly liveTracked?: boolean } = {}) {
  return page({
    changes: [
      subscriptionUpsert(1, AA100_KEY, overrides),
      subscriptionUpsert(2, BA117_KEY),
      subscriptionUpsert(3, DL1_KEY),
    ],
    flights: [aa100Snapshot(), ba117Snapshot(), dl1Snapshot()],
    cursor: cursorAt(20),
  });
}

function tombstoneOf(db: MemorySqlite, id: string): string | null {
  const row = db.raw.prepare('SELECT deleted_at FROM flight_subscriptions WHERE id = ?').get(id) as
    { deleted_at: string | null } | undefined;
  return row === undefined ? 'gone' : row.deleted_at;
}

/** A store seeded for USER at cursor 1, written by this build (so a pull is a delta pull). */
function seededStore(): MemorySqlite {
  const db = createMemorySqlite();
  applySyncPage(
    db,
    SyncPageShell.parse(
      page({
        changes: [
          subscriptionUpsert(1, AA100_KEY),
          subscriptionUpsert(2, BA117_KEY),
          subscriptionUpsert(3, DL1_KEY),
        ],
        flights: [aa100Snapshot(), ba117Snapshot(), dl1Snapshot()],
        cursor: cursorAt(1),
      }),
    ),
    { ownerUserId: USER, storeVersion: STORE_SCHEMA_VERSION },
  );
  return db;
}

describe('a DELETE deferred by a 5xx, then a successful pull (ruling X3)', () => {
  it.each([
    ['a snapshot replace', 'replace'],
    ['a delta page that changes the row on the server', 'delta'],
  ] as const)('keeps the local tombstone through %s', async (_name, kind) => {
    const db = seededStore();
    if (kind === 'replace') {
      // A store version from an older build: the next pull is the no-cursor snapshot.
      db.run("UPDATE sync_state SET store_version = 'm0-older' WHERE id = 1");
    }
    const gate = new ApplyGate();
    removeFlight(db, AA100_ID);
    const { outbox, sent } = outboxOver(db, gate, [
      { status: 503, replayed: false, body: envelope('provider_unavailable') },
    ]);
    await expect(outbox.drain()).resolves.toMatchObject({ kind: 'deferred' });
    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
      `DELETE /v1/flights/${AA100_ID}`,
    ]);

    // The pull succeeds while the DELETE waits: the server still has AA100 live (and, on the
    // delta page, the persist consumer flipped its live_tracked).
    const before = db.transactions.length;
    await pullOver(db, gate, serverPage({ liveTracked: false })).sync(USER);

    expect(
      listFlights(db)
        .map((item) => item.id)
        .sort(),
    ).toEqual([BA117_ID, DL1_ID].sort());
    expect(readFlight(db, AA100_ID)).toBeNull();
    expect(tombstoneOf(db, AA100_ID)).not.toBeNull();
    expect(pendingCount(db)).toBe(1);
    // Re-stamped inside the page's own transaction.
    const applied = db.transactions.slice(before).filter((tx) => tx.behavior === 'immediate');
    expect(applied).toHaveLength(1);
    expect(
      applied[0]?.statements.some((sql) => /UPDATE flight_subscriptions SET deleted_at/.test(sql)),
    ).toBe(true);

    // Past its backoff, the DELETE settles: the row goes for good.
    const retry = outboxOver(
      db,
      gate,
      [{ status: 200, replayed: false, body: { deleted: true } }],
      10 * 60_000,
    );
    await expect(retry.outbox.drain()).resolves.toMatchObject({ kind: 'drained', sent: 1 });
    expect(tombstoneOf(db, AA100_ID)).toBe('gone');
    expect(pendingCount(db)).toBe(0);
  });

  it('a DELETE the server answers 404 (another device removed it first) drops the tombstone too', async () => {
    const db = seededStore();
    removeFlight(db, BA117_ID);
    const { outbox } = outboxOver(db, new ApplyGate(), [
      { status: 404, replayed: false, body: envelope('subscription_not_found') },
    ]);
    await outbox.drain();
    expect(tombstoneOf(db, BA117_ID)).toBe('gone');
  });
});

describe('local-only columns across a snapshot replace (ruling X7 item 3)', () => {
  it('carries finished_at and added_as over to the page rows with the same id, in its transaction', () => {
    const db = createMemorySqlite();
    seedStore(db);
    db.run(
      "UPDATE flight_subscriptions SET finished_at = '2026-09-23T14:00:00.000Z' WHERE id = ?",
      [DL1_ID],
    );
    db.run("UPDATE flight_subscriptions SET added_as = 'BA1511' WHERE id = ?", [AA100_ID]);

    const before = db.transactions.length;
    applySyncPage(db, SyncPageShell.parse(serverPage()), { replace: true, ownerUserId: USER });

    const rows = db.raw
      .prepare('SELECT id, finished_at, added_as FROM flight_subscriptions ORDER BY id')
      .all() as { id: string; finished_at: string | null; added_as: string | null }[];
    expect(rows).toEqual([
      { id: AA100_ID, finished_at: null, added_as: 'BA1511' },
      { id: BA117_ID, finished_at: null, added_as: null },
      { id: DL1_ID, finished_at: '2026-09-23T14:00:00.000Z', added_as: null },
    ]);
    expect(db.transactions.slice(before)).toHaveLength(1);
    expect(listFlights(db).find((item) => item.id === AA100_ID)?.designator).toBe('BA1511');
  });

  it('a row the replace does not carry is gone with its columns', () => {
    const db = createMemorySqlite();
    seedStore(db);
    db.run(
      "UPDATE flight_subscriptions SET finished_at = '2026-09-23T14:00:00.000Z' WHERE id = ?",
      [DL1_ID],
    );
    applySyncPage(
      db,
      SyncPageShell.parse(
        page({ changes: [subscriptionUpsert(1, AA100_KEY)], flights: [], cursor: cursorAt(30) }),
      ),
      { replace: true },
    );
    expect(tombstoneOf(db, DL1_ID)).toBe('gone');
  });
});
