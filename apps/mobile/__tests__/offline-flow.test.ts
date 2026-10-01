/**
 * The add, the unsubscribe and the server's answer between them (increment 10 review, ruling X7),
 * through the SqliteLike fake, the real outbox with its settling hooks and a scripted transport:
 *
 * 1. 200 `created: false` means the add was a no-op on the server: the optimistic row and every
 *    mutation queued for it go, a DELETE is never pointed at the account's existing row, and the
 *    server's row and flight are still written. A restored tombstone (`created: true` under
 *    another id) keeps the re-point.
 * 2. A pending add the store already holds as a live row (same designator and date, a codeshare
 *    included) is hidden, never shown twice, and its POST settles it.
 * 4. The outbox stamps `last_attempt_at` before the request exists, and never stamps or sends while
 *    the phone knows it is offline (ruling Y1); an add removed before it was ever sent is
 *    cancelled outright, and nothing reaches the network.
 * 5. The id replacement is recorded, and a reader of the optimistic id follows it; the records are
 *    bounded (ruling Y5): gone once the row they point at was read, after a day, or on sign-out.
 */

import { FlightSubscriptionRowV1 } from '@planeahead/shared';
import type { RawRequest, RawResponse } from '../src/lib/api-client';
import { kv } from '../src/lib/db/kv';
import {
  clearReplacements,
  readReplacement,
  recordReplacement,
  replacedKey,
  REPLACEMENT_TTL_MS,
} from '../src/lib/flight-replacements';
import { listFlights, readFlight, readFlightFollowing } from '../src/lib/flight-queries';
import { addFlight, flightOutboxHooks, removeFlight } from '../src/lib/flights';
import { applySyncPage, SyncPageShell } from '../src/lib/sync/apply';
import { ApplyGate } from '../src/lib/sync/gate';
import { createOutbox, pendingCount } from '../src/lib/sync/outbox';
import {
  AA100_ID,
  AA100_KEY,
  BA117_ID,
  DL1_ID,
  NOW,
  aa100Snapshot,
  seedStore,
} from './support/flight-fixtures';
import { createMemorySqlite, type MemorySqlite } from './support/memory-sqlite';
import { cursorAt, envelope, id, page, subscriptionUpsert } from './support/sync-fixtures';

jest.mock('../src/lib/db/kv', () =>
  jest.requireActual<typeof import('./support/memory-kv')>('./support/memory-kv').memoryKvModule(),
);

const OPTIMISTIC_ID = id(5);

/**
 * A transport that answers from a script (a thrown entry is the network failing), behind the
 * phone's known connectivity (`online`, ruling Y1).
 */
function network(db: MemorySqlite) {
  const sent: string[] = [];
  const stampedAtSend: (number | null)[] = [];
  const script: (RawResponse | Error)[] = [];
  const connectivity = { online: true };
  let clock = 0;
  const outbox = createOutbox({
    db,
    gate: new ApplyGate(),
    onAccountDeleted: jest.fn(),
    ...flightOutboxHooks(db),
    isOnline: () => connectivity.online,
    now: () => clock,
    transport: {
      send(request: RawRequest) {
        sent.push(`${request.method} ${request.path}`);
        const row = db.raw
          .prepare('SELECT last_attempt_at FROM outbox ORDER BY seq LIMIT 1')
          .get() as { last_attempt_at: number | null } | undefined;
        stampedAtSend.push(row?.last_attempt_at ?? null);
        const next = script.shift();
        if (next === undefined || next instanceof Error) {
          return Promise.reject(next ?? new TypeError('Network request failed'));
        }
        return Promise.resolve(next);
      },
    },
  });
  return {
    outbox,
    sent,
    stampedAtSend,
    connectivity,
    answer(...responses: (RawResponse | Error)[]) {
      script.push(...responses);
    },
    /** Past any backoff. */
    later() {
      clock += 10 * 60_000;
    },
  };
}

function serverRow(n: number, overrides: Record<string, unknown> = {}): FlightSubscriptionRowV1 {
  return FlightSubscriptionRowV1.parse(subscriptionUpsert(n, AA100_KEY, overrides)['row']);
}

function subscribeAnswer(row: FlightSubscriptionRowV1, created: boolean): RawResponse {
  return {
    status: created ? 201 : 200,
    replayed: false,
    body: {
      subscription: row,
      flight: {
        key: AA100_KEY,
        phase: 'scheduled',
        version: 3,
        snapshot: aa100Snapshot(),
        source: 'tracker',
      },
      created,
    },
  };
}

function row(db: MemorySqlite, rowId: string) {
  return db.raw
    .prepare(
      'SELECT id, flight_key, deleted_at, added_as, superseded FROM flight_subscriptions WHERE id = ?',
    )
    .get(rowId) as
    | {
        id: string;
        flight_key: string;
        deleted_at: string | null;
        added_as: string | null;
        superseded: number;
      }
    | undefined;
}

function designators(db: MemorySqlite): string[] {
  return listFlights(db)
    .map((item) => item.designator)
    .sort();
}

describe('1. 200 created false: the add was a no-op on the server', () => {
  it('cancelling the pending codeshare BA1511 never deletes the tracked AA100 (sent, then offline)', async () => {
    const db = createMemorySqlite();
    // The provider listed no codeshares, so nothing on this phone names BA1511: it is queued and
    // shown as being added (a codeshare the snapshot lists is answered locally, ruling Y3).
    seedStore(db, { codeshares: [] });
    const net = network(db);
    const added = addFlight(
      db,
      { designator: 'BA1511', date: '2026-09-23' },
      { newId: () => OPTIMISTIC_ID },
    );
    expect(added.kind).toBe('queued');
    expect(designators(db)).toEqual(['AA100', 'BA117', 'BA1511', 'DL1']);

    // The first drain goes out and gets no answer: the server may have the POST.
    net.answer(new TypeError('Network request failed'));
    await expect(net.outbox.drain()).resolves.toMatchObject({ kind: 'deferred' });
    // Stop tracking the "Adding" row: the POST was sent, so a DELETE is queued behind it.
    expect(removeFlight(db, OPTIMISTIC_ID)).toBe('queued');

    net.later();
    net.answer(subscribeAnswer(serverRow(1), false));
    await expect(net.outbox.drain()).resolves.toMatchObject({ kind: 'drained', sent: 1 });

    expect(net.sent).toEqual(['POST /v1/flights', 'POST /v1/flights']);
    // AA100 is still tracked, under the name this phone showed for it.
    expect(designators(db)).toEqual(['AA100', 'BA117', 'DL1']);
    expect(row(db, AA100_ID)).toMatchObject({ deleted_at: null, added_as: null });
    expect(row(db, OPTIMISTIC_ID)).toBeUndefined();
    expect(pendingCount(db)).toBe(0);
  });

  it('keeps the account row live and drops the queued DELETE, and records where the add went', async () => {
    const db = createMemorySqlite();
    const net = network(db);
    // The account holds AA100 under id 1 on another device; this store has not pulled it yet.
    addFlight(db, { designator: 'AA100', date: '2026-09-23' }, { newId: () => OPTIMISTIC_ID });
    net.answer(new TypeError('Network request failed'));
    await net.outbox.drain();
    removeFlight(db, OPTIMISTIC_ID);

    net.later();
    net.answer(subscribeAnswer(serverRow(1), false));
    await net.outbox.drain();

    expect(net.sent).toEqual(['POST /v1/flights', 'POST /v1/flights']);
    // The tombstone of the cancelled add is never copied onto the account's row, nor its name.
    expect(row(db, AA100_ID)).toMatchObject({ deleted_at: null, added_as: null, superseded: 0 });
    expect(listFlights(db).map((item) => [item.id, item.flightKey, item.scheduledOut])).toEqual([
      [AA100_ID, AA100_KEY, '2026-09-23T22:00:00Z'],
    ]);
    // Item 5: a detail screen on the optimistic id follows the replacement; the record goes once
    // the row it points at has been read.
    expect(readFlight(db, OPTIMISTIC_ID)).toBeNull();
    expect(readReplacement(OPTIMISTIC_ID)).toBe(AA100_ID);
    const followed = readFlightFollowing(db, OPTIMISTIC_ID);
    expect(followed.id).toBe(AA100_ID);
    expect(followed.item?.designator).toBe('AA100');
    expect(readReplacement(OPTIMISTIC_ID)).toBeNull();
  });

  it('keeps a DELETE this phone queued for the account row itself', async () => {
    const db = createMemorySqlite();
    seedStore(db, { codeshares: [] });
    const net = network(db);
    addFlight(db, { designator: 'BA1511', date: '2026-09-23' }, { newId: () => OPTIMISTIC_ID });
    // Then AA100 itself is removed here: its DELETE waits behind the add.
    removeFlight(db, AA100_ID);
    net.answer(subscribeAnswer(serverRow(1), false), {
      status: 503,
      replayed: false,
      body: envelope('unavailable'),
    });
    await expect(net.outbox.drain()).resolves.toMatchObject({ kind: 'deferred', sent: 1 });
    expect(net.sent).toEqual(['POST /v1/flights', `DELETE /v1/flights/${AA100_ID}`]);
    // The answer carried AA100 live, but this phone removed it and the DELETE is still queued.
    expect(listFlights(db).map((item) => item.id)).not.toContain(AA100_ID);
    expect(row(db, AA100_ID)?.deleted_at).not.toBeNull();
    expect(pendingCount(db)).toBe(1);
  });

  it('names a row this store did not hold yet after the designator typed here', async () => {
    const db = createMemorySqlite();
    const net = network(db);
    addFlight(db, { designator: 'BA1511', date: '2026-09-23' }, { newId: () => OPTIMISTIC_ID });
    net.answer(subscribeAnswer(serverRow(1), false));
    await net.outbox.drain();
    expect(
      listFlights(db).map((item) => [item.id, item.designator, item.operatingDesignator]),
    ).toEqual([[AA100_ID, 'BA1511', 'AA100']]);
  });

  it('a restored tombstone (201 created true under another id) keeps the re-pointed DELETE', async () => {
    const db = createMemorySqlite();
    const net = network(db);
    addFlight(db, { designator: 'AA100', date: '2026-09-23' }, { newId: () => OPTIMISTIC_ID });
    net.answer(new TypeError('Network request failed'));
    await net.outbox.drain();
    removeFlight(db, OPTIMISTIC_ID);

    net.later();
    net.answer(subscribeAnswer(serverRow(9), true), {
      status: 200,
      replayed: false,
      body: { deleted: true },
    });
    await net.outbox.drain();
    expect(net.sent).toEqual([
      'POST /v1/flights',
      'POST /v1/flights',
      `DELETE /v1/flights/${id(9)}`,
    ]);
    expect(listFlights(db)).toEqual([]);
  });
});

describe('2. a pending add the store already holds as a live row is shown once', () => {
  it.each([
    ['a snapshot replace', true],
    ['a delta page', false],
  ] as const)('while its POST is held, after %s', async (_name, replace) => {
    const db = createMemorySqlite();
    const net = network(db);
    addFlight(db, { designator: 'AA100', date: '2026-09-23' }, { newId: () => OPTIMISTIC_ID });
    net.answer({ status: 503, replayed: false, body: envelope('provider_unavailable') });
    await expect(net.outbox.drain()).resolves.toMatchObject({ kind: 'deferred' });

    // The account's own row for the same flight, added on another device (id 77).
    applySyncPage(
      db,
      SyncPageShell.parse(
        page({
          changes: [subscriptionUpsert(77, AA100_KEY)],
          flights: [aa100Snapshot()],
          cursor: cursorAt(2),
        }),
      ),
      { replace },
    );
    expect(listFlights(db).map((item) => [item.id, item.designator, item.pending])).toEqual([
      [id(77), 'AA100', false],
    ]);
    expect(pendingCount(db)).toBe(1);

    // The held POST settles it: 200 created false with the account's row.
    net.later();
    net.answer(subscribeAnswer(serverRow(77), false));
    await net.outbox.drain();
    expect(listFlights(db).map((item) => item.id)).toEqual([id(77)]);
    expect(row(db, OPTIMISTIC_ID)).toBeUndefined();
    expect(pendingCount(db)).toBe(0);
  });
});

describe('4. an add removed before it was ever sent', () => {
  it('is cancelled outright: no POST, no DELETE, no row', async () => {
    const db = createMemorySqlite();
    seedStore(db);
    const net = network(db);
    addFlight(db, { designator: 'UA901', date: '2026-09-24' }, { newId: () => OPTIMISTIC_ID });
    const before = db.transactions.length;
    expect(removeFlight(db, OPTIMISTIC_ID)).toBe('cancelled');
    expect(db.transactions.slice(before)).toHaveLength(1);

    await expect(net.outbox.drain()).resolves.toMatchObject({ kind: 'drained', sent: 0 });
    expect(net.sent).toEqual([]);
    expect(row(db, OPTIMISTIC_ID)).toBeUndefined();
    expect(pendingCount(db)).toBe(0);
    expect(
      listFlights(db)
        .map((item) => item.id)
        .sort(),
    ).toEqual([AA100_ID, BA117_ID, DL1_ID].sort());
  });

  it('the drain stamps last_attempt_at before the request goes out', async () => {
    const db = createMemorySqlite();
    const net = network(db);
    addFlight(db, { designator: 'UA901', date: '2026-09-24' }, { newId: () => OPTIMISTIC_ID });
    const unsent = db.raw.prepare('SELECT last_attempt_at FROM outbox').get() as {
      last_attempt_at: number | null;
    };
    expect(unsent.last_attempt_at).toBeNull();
    net.answer(new TypeError('Network request failed'));
    await net.outbox.drain();
    expect(net.stampedAtSend).toEqual([0]);
    // Sent once (no answer came back): removing it now needs the DELETE.
    expect(removeFlight(db, OPTIMISTIC_ID)).toBe('queued');
    expect(
      (
        db.raw.prepare('SELECT method, path FROM outbox ORDER BY seq').all() as {
          method: string;
          path: string;
        }[]
      ).map((item) => `${item.method} ${item.path}`),
    ).toEqual(['POST /v1/flights', `DELETE /v1/flights/${OPTIMISTIC_ID}`]);
  });

  it('known offline: no stamp, no attempt, nothing sent, and the add is still cancellable (ruling Y1)', async () => {
    const db = createMemorySqlite();
    const net = network(db);
    addFlight(db, { designator: 'UA901', date: '2026-09-24' }, { newId: () => OPTIMISTIC_ID });
    net.connectivity.online = false;
    await expect(net.outbox.drain()).resolves.toEqual({ kind: 'deferred', sent: 0, dropped: 0 });
    expect(net.sent).toEqual([]);
    expect(
      db.raw.prepare('SELECT last_attempt_at, attempts, next_attempt_at FROM outbox').all(),
    ).toEqual([{ last_attempt_at: null, attempts: 0, next_attempt_at: 0 }]);
    expect(removeFlight(db, OPTIMISTIC_ID)).toBe('cancelled');
    expect(row(db, OPTIMISTIC_ID)).toBeUndefined();
    expect(pendingCount(db)).toBe(0);

    // Back online, a queued add goes out at once, stamped before the request exists.
    net.connectivity.online = true;
    addFlight(db, { designator: 'UA901', date: '2026-09-24' });
    net.answer(new TypeError('Network request failed'));
    await net.outbox.drain();
    expect(net.sent).toEqual(['POST /v1/flights']);
    expect(net.stampedAtSend).toEqual([0]);
  });
});

describe('5. the replacement records are bounded (ruling Y5)', () => {
  function replacementKeys(): string[] {
    return kv
      .getAllKeysSync()
      .filter((key) => key.startsWith('replaced:'))
      .sort();
  }

  beforeEach(() => {
    clearReplacements();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps a record until the row it points at has been read, then drops it', () => {
    // readFlightFollowing reads the record against the real clock, so pin it to the fixtures'
    // NOW: recorded at a fixed date and read against today, the record was a week old and swept
    // (the test passed until a day after 2026-09-23 and failed from then on).
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const db = createMemorySqlite();
    recordReplacement(OPTIMISTIC_ID, AA100_ID, NOW);
    // The row it points at is not in this store yet: nothing read, the record stays.
    expect(readFlightFollowing(db, OPTIMISTIC_ID)).toEqual({ id: AA100_ID, item: null });
    expect(readReplacement(OPTIMISTIC_ID, NOW)).toBe(AA100_ID);
    seedStore(db);
    expect(readFlightFollowing(db, OPTIMISTIC_ID).item?.id).toBe(AA100_ID);
    expect(replacementKeys()).toEqual([]);
  });

  it('drops every record older than a day when one is read or written', () => {
    recordReplacement(id(6), AA100_ID, NOW - REPLACEMENT_TTL_MS - 1);
    recordReplacement(id(7), BA117_ID, NOW - 60_000);
    kv.setItemSync(replacedKey(id(8)), DL1_ID); // written before records carried a time
    expect(replacementKeys()).toHaveLength(3);

    expect(readReplacement(id(6), NOW)).toBeNull();
    expect(replacementKeys()).toEqual([replacedKey(id(7))]);
    expect(readReplacement(id(7), NOW)).toBe(BA117_ID);

    // A write sweeps too, so records nothing ever reads do not pile up.
    recordReplacement(id(9), DL1_ID, NOW + REPLACEMENT_TTL_MS);
    expect(replacementKeys()).toEqual([replacedKey(id(9))]);
  });

  it('clearReplacements drops every record and nothing else in the kv-store', () => {
    kv.setItemSync('planeahead.settings', '{}');
    recordReplacement(id(6), AA100_ID, NOW);
    recordReplacement(id(7), BA117_ID, NOW);
    clearReplacements();
    expect(replacementKeys()).toEqual([]);
    expect(kv.getItemSync('planeahead.settings')).toBe('{}');
  });
});
