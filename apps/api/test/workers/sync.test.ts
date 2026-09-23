/**
 * `GET /v1/sync` (ruling K4, ADR 0012) through the real Worker against the embedded Postgres 18.
 *
 * What is pinned here: the no-cursor snapshot and the `(watermark, 0)` cursor it answers; the
 * incremental feed of subscribe, unsubscribe and preference changes, each written in its entity's
 * transaction; a page of exactly 200 rows with `hasMore`, and the one after it; pagination that
 * neither skips nor repeats while other transactions keep inserting; the `flights` sibling array
 * built from `flight_sync_changes` for the caller's subscriptions only; the persist consumer
 * writing that table in its upsert transaction and not on a replay; the 410 and 400 answers; the
 * primary check; and the EXPLAIN that shows the `(user_id, xid, seq)` index driving the row-value
 * comparison. The late-commit hazard has its own file (sync.late-commit.test.ts).
 *
 * Every test first writes a change row of its own before it takes a cursor, so the oldest
 * retained row of the shared database (other files write theirs in parallel) is always older
 * than any cursor a test holds. And every expectation of rows is met by pulling until they
 * arrive (`drain`): the watermark is cluster-global, so a transaction another file holds open
 * (the late-commit test does so on purpose) legitimately delays what a pull may serve.
 */

import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PersistMessageV1,
  SyncEnvelopeV1,
  decodeSyncCursor,
  encodeSyncCursor,
  flightTrackerOrigin,
  type FlightInstanceMessageV1,
  type SyncEnvelopeV1 as SyncEnvelope,
} from '@planeahead/shared';
import { isCursorStale } from '../../src/lib/sync-cursor';
import { upsertFlightInstance } from '../../src/queues/persist';
import { ReadOnlyConnectionError, readSyncBounds, userChangesQuery } from '../../src/routes/sync';
import { jsonRequest, signInAnonymously, worker, type AnonymousSession } from './helpers/auth';
import { drainTouched, type TestFlight } from './helpers/flights';
import {
  authed,
  db,
  eventually,
  seedTracker,
  seededFlightFor,
  statusFor,
  subscribe,
  type ErrorBody,
  type SubscribeBody,
} from './helpers/routes';

afterEach(drainTouched);

async function pull(session: AnonymousSession, cursor?: string): Promise<SyncEnvelope> {
  const response = await authed(
    session,
    cursor === undefined ? '/v1/sync' : `/v1/sync?cursor=${encodeURIComponent(cursor)}`,
  );
  if (response.status !== 200) {
    throw new Error(`sync failed: ${String(response.status)} ${await response.text()}`);
  }
  return SyncEnvelopeV1.parse(await response.json());
}

interface Drained {
  readonly changes: SyncEnvelope['changes'];
  readonly flights: SyncEnvelope['flights'];
  readonly cursor: string;
}

/** Pulls from `cursor` until at least `changes` changes and `flights` flights have arrived. */
async function drain(
  session: AnonymousSession,
  cursor: string,
  want: { changes?: number; flights?: number },
): Promise<Drained> {
  const changes: SyncEnvelope['changes'] = [];
  const flights: SyncEnvelope['flights'] = [];
  let current = cursor;
  const deadline = Date.now() + 15_000;
  for (;;) {
    const page = await pull(session, current);
    changes.push(...page.changes);
    flights.push(...page.flights);
    current = page.cursor;
    if (
      !page.hasMore &&
      changes.length >= (want.changes ?? 0) &&
      flights.length >= (want.flights ?? 0)
    ) {
      return { changes, flights, cursor: current };
    }
    if (Date.now() > deadline) {
      throw new Error(`sync did not deliver ${JSON.stringify(want)} in time`);
    }
    if (!page.hasMore) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function subscribed(session: AnonymousSession, flight: TestFlight): Promise<string> {
  const response = await subscribe(session, { flightKey: flight.flightKey });
  if (response.status !== 201) {
    throw new Error(`subscribe failed: ${String(response.status)}`);
  }
  return (await response.json<SubscribeBody>()).subscription.id;
}

/** Inserts `count` change rows for the user in ONE transaction (one xid, increasing seq). */
async function insertChanges(userId: string, count: number): Promise<void> {
  await db().execute(sql`
    insert into user_sync_changes (user_id, entity, entity_id, op, row)
    select ${userId}::uuid, 'trips', uuidv7(), 'upsert', jsonb_build_object('n', n)
    from generate_series(1, ${count}) as n
  `);
}

async function patchPreferences(session: AnonymousSession, body: unknown): Promise<Response> {
  return worker(
    jsonRequest('/v1/me/preferences', 'PATCH', body, { ip: session.ip, cookie: session.cookie }),
  );
}

describe('GET /v1/sync', () => {
  it('answers the current state without a cursor, then only what changed after it', async () => {
    const session = await signInAnonymously();
    const first = seededFlightFor();
    const second = seededFlightFor();
    await seedTracker(first);
    await seedTracker(second);
    const firstId = await subscribed(session, first);
    expect((await patchPreferences(session, { distanceUnit: 'km' })).status).toBe(200);

    const snapshot = await eventually(
      () => pull(session),
      (page) => page.changes.length === 2,
    );
    expect(snapshot.hasMore).toBe(false);
    expect(snapshot.rpcVersion).toBe(1);
    expect(snapshot.changes.map((c) => [c.entity, c.op]).sort()).toEqual([
      ['flight_subscriptions', 'upsert'],
      ['user_preferences', 'upsert'],
    ]);
    expect(decodeSyncCursor(snapshot.cursor).seq).toBe('0');

    const secondId = await subscribed(session, second);
    const afterSubscribe = await drain(session, snapshot.cursor, { changes: 1 });
    expect(afterSubscribe.changes.map((c) => [c.entity, c.op, c.id])).toEqual([
      ['flight_subscriptions', 'upsert', secondId],
    ]);
    expect(afterSubscribe.changes[0]?.row?.['flightKey']).toBe(second.flightKey);

    expect((await authed(session, `/v1/flights/${firstId}`, 'DELETE')).status).toBe(200);
    expect((await patchPreferences(session, { timeFormat: '24h' })).status).toBe(200);
    const afterDelete = await drain(session, afterSubscribe.cursor, { changes: 2 });
    expect(afterDelete.changes.map((c) => [c.entity, c.op, c.id === firstId])).toEqual([
      ['flight_subscriptions', 'delete', true],
      ['user_preferences', 'upsert', false],
    ]);
    expect(afterDelete.changes[0]?.row?.['deletedAt']).toEqual(expect.any(String));

    const idle = await pull(session, afterDelete.cursor);
    expect(idle.changes).toEqual([]);
    expect(idle.hasMore).toBe(false);
  });

  it('serves a page of exactly 200 with hasMore, then the rest, in (xid, seq) order', async () => {
    const session = await signInAnonymously();
    await insertChanges(session.userId, 1);
    const start = await pull(session);
    await insertChanges(session.userId, 201);

    // One transaction wrote all 201 rows (one xid), so they become visible together.
    const page = await eventually(
      () => pull(session, start.cursor),
      (candidate) => candidate.changes.length > 0,
    );
    const rest = await pull(session, page.cursor);

    expect(page.changes).toHaveLength(200);
    expect(page.hasMore).toBe(true);
    expect(page.changes.map((c) => c.row?.['n'])).toEqual(
      Array.from({ length: 200 }, (_, index) => index + 1),
    );
    const last = decodeSyncCursor(page.cursor);
    expect(last.seq).not.toBe('0');
    expect(rest.changes.map((c) => c.row?.['n'])).toEqual([201]);
    expect(rest.hasMore).toBe(false);
    expect(decodeSyncCursor(rest.cursor).seq).toBe('0');
  });

  it('neither skips nor repeats a row while other transactions keep inserting', async () => {
    const session = await signInAnonymously();
    await insertChanges(session.userId, 1);
    let cursor = (await pull(session)).cursor;
    const delivered: number[] = [];
    let writing = true;
    const writer = (async () => {
      for (let batch = 0; batch < 12; batch += 1) {
        await db().execute(sql`
          insert into user_sync_changes (user_id, entity, entity_id, op, row)
          select ${session.userId}::uuid, 'trips', uuidv7(), 'upsert',
                 jsonb_build_object('n', ${batch * 100} + n)
          from generate_series(1, 60) as n
        `);
      }
      writing = false;
    })();

    // Pull while the writer runs, then until everything it wrote has arrived.
    const expected = Array.from({ length: 12 }, (_, batch) =>
      Array.from({ length: 60 }, (__, n) => batch * 100 + n + 1),
    ).flat();
    const deadline = Date.now() + 30_000;
    let pulls = 0;
    while ((writing || delivered.length < expected.length) && Date.now() < deadline) {
      const page = await pull(session, cursor);
      pulls += 1;
      delivered.push(...page.changes.map((c) => Number(c.row?.['n'])));
      cursor = page.cursor;
    }
    await writer;
    const after = await pull(session, cursor);

    expect(pulls).toBeGreaterThan(1);
    expect(delivered).toEqual(expected);
    expect(after.changes).toEqual([]);
  });

  it('carries the flights of the caller subscriptions, once each, and nobody else flights', async () => {
    const session = await signInAnonymously();
    const stranger = await signInAnonymously();
    const flight = seededFlightFor();
    await seedTracker(flight);
    await subscribed(session, flight);
    await insertChanges(stranger.userId, 1);
    // The persist consumer writes the flight's first change row from the seed's outbox.
    await eventually(
      () =>
        db().execute<{ n: number }>(sql`
          select count(*)::int as n from flight_sync_changes f
          join flight_instances fi on fi.id = f.flight_instance_id
          where fi.flight_key = ${flight.flightKey}
        `),
      (rows) => (rows[0]?.n ?? 0) > 0,
    );

    const snapshot = await eventually(
      () => pull(session),
      (page) => page.flights.length === 1,
    );
    expect(snapshot.flights.map((f) => f.key)).toEqual([flight.flightKey]);
    const strangerStart = await pull(stranger);

    // A flight change after the cursor (as the persist consumer writes one).
    await db().execute(sql`
      insert into flight_sync_changes (flight_instance_id, snapshot)
      select id, ${JSON.stringify({ ...statusFor(flight, { status: 'boarding', originGate: 'B22' }), key: flight.flightKey })}::jsonb
      from flight_instances where flight_key = ${flight.flightKey}
    `);
    const next = await drain(session, snapshot.cursor, { flights: 1 });
    const strangerNext = await pull(stranger, strangerStart.cursor);

    expect(next.changes).toEqual([]);
    expect(next.flights.map((f) => [f.key, f.originGate])).toContainEqual([
      flight.flightKey,
      'B22',
    ]);
    expect(strangerNext.flights).toEqual([]);
  });

  it('answers 410 resync_required to a cursor this cluster never issued, and 400 to garbage', async () => {
    const session = await signInAnonymously();
    const future = encodeSyncCursor({ xid: '18000000000000000000', seq: '1' });

    const stale = await authed(session, `/v1/sync?cursor=${future}`);
    const garbage = await authed(session, '/v1/sync?cursor=not-a-cursor');

    expect(stale.status).toBe(410);
    expect((await stale.json<ErrorBody>()).error).toBe('resync_required');
    expect(garbage.status).toBe(400);
    expect((await garbage.json<ErrorBody>()).error).toBe('invalid_cursor');
  });

  it('answers 401 without a session', async () => {
    const response = await worker(jsonRequest('/v1/sync', 'GET', undefined));

    expect(response.status).toBe(401);
  });
});

describe('the watermark and the cursor', () => {
  it('judges a cursor stale below the oldest retained row or beyond the next xid', () => {
    const bounds = { nextXid: '1000', oldestRetainedXid: '500' };
    expect(isCursorStale({ xid: '499', seq: '9' }, bounds)).toBe(true);
    expect(isCursorStale({ xid: '500', seq: '0' }, bounds)).toBe(false);
    expect(isCursorStale({ xid: '999', seq: '0' }, bounds)).toBe(false);
    expect(isCursorStale({ xid: '1001', seq: '0' }, bounds)).toBe(true);
    expect(
      isCursorStale({ xid: '1', seq: '0' }, { nextXid: '1000', oldestRetainedXid: null }),
    ).toBe(false);
    // Strings all the way: 2^63 and beyond compare exactly.
    expect(
      isCursorStale(
        { xid: '9223372036854775809', seq: '0' },
        { nextXid: '9223372036854775808', oldestRetainedXid: null },
      ),
    ).toBe(true);
  });

  it('refuses to read the watermark from a read-only connection (the primary check)', async () => {
    await expect(
      db().transaction((tx) => readSyncBounds(tx), { accessMode: 'read only' }),
    ).rejects.toBeInstanceOf(ReadOnlyConnectionError);
    const bounds = await readSyncBounds(db());
    expect(BigInt(bounds.watermark)).toBeLessThanOrEqual(BigInt(bounds.nextXid));
  });

  it('drives the row-value comparison through the (user_id, xid, seq) index (EXPLAIN on PostgreSQL 18)', async () => {
    const session = await signInAnonymously();
    await insertChanges(session.userId, 5);
    const bounds = await readSyncBounds(db());

    const plan = await db().transaction(async (tx) => {
      // The table is tiny under test, so the planner would scan it whole; forbidding the scans
      // asks whether the index CAN carry the predicate, which is the question.
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const rows = await tx.execute<{ 'QUERY PLAN': unknown }>(
        sql`explain (format json) ${userChangesQuery(session.userId, bounds.watermark, {
          xid: '0',
          seq: '0',
        })}`,
      );
      return JSON.stringify(rows[0]?.['QUERY PLAN']);
    });

    // Measured on PostgreSQL 18.4: Index Scan using user_sync_changes_user_id_xid_seq_idx,
    // Index Cond: ((user_id = $1) AND (xid < $W) AND (ROW(xid, seq) > ROW($x::xid8, $s::bigint))).
    expect(plan).toContain('user_sync_changes_user_id_xid_seq_idx');
    const indexCond = /"Index Cond":\s*"([^"]*)"/.exec(plan)?.[1] ?? '';
    // The row comparison is an index qualification, not a filter applied after the scan.
    expect(indexCond).toMatch(/ROW\((c\.)?xid, (c\.)?seq\) > ROW\(/);
    expect(indexCond).toContain('user_id =');
    expect(plan).not.toMatch(/"Filter":[^"]*"[^"]*ROW\(/);
  });
});

describe('the persist consumer writes flight_sync_changes in its upsert transaction', () => {
  function instanceMessage(flight: TestFlight, version: number): FlightInstanceMessageV1 {
    const parsed = PersistMessageV1.parse({
      kind: 'flight_instance',
      flightKey: flight.flightKey,
      seq: version,
      origin: flightTrackerOrigin(flight.flightKey, 4_102_444_800_000),
      payload: {
        operatingCarrierIcao: 'AAL',
        flightNumber: flight.number,
        scheduledDepartureDate: flight.dateLocal,
        originIcao: 'KJFK',
        legSeq: 1,
        version,
        phase: 'scheduled',
        trackingState: 'tracking',
        refreshCadence: 'A2',
        nextRefreshAt: null,
        lastRefreshedAt: null,
        doSchemaVersion: 2,
        snapshot: statusFor(flight, { originGate: `G${String(version)}` }),
        providerCallCount: version,
        providerCostUnits: 2 * version,
        subscriberCount: 0,
        operatorSource: 'provider',
        finishedAt: null,
        eventsR2Key: null,
      },
    });
    if (parsed.kind !== 'flight_instance') {
      throw new Error('not an instance message');
    }
    return parsed;
  }

  it('adds one change row per applied upsert, none for a replay or a stale version', async () => {
    const flight = seededFlightFor();
    const handle = db();
    const rows = () =>
      handle.execute<{ gate: string }>(sql`
        select f.snapshot->>'originGate' as gate from flight_sync_changes f
        join flight_instances fi on fi.id = f.flight_instance_id
        where fi.flight_key = ${flight.flightKey} order by f.xid, f.seq
      `);

    await upsertFlightInstance(handle, instanceMessage(flight, 1));
    await upsertFlightInstance(handle, instanceMessage(flight, 1));
    await upsertFlightInstance(handle, instanceMessage(flight, 3));
    await upsertFlightInstance(handle, instanceMessage(flight, 2));

    expect((await rows()).map((row) => row.gate)).toEqual(['G1', 'G3']);
    const [snapshot] = await handle.execute<{ key: string }>(sql`
      select f.snapshot->>'key' as key from flight_sync_changes f
      join flight_instances fi on fi.id = f.flight_instance_id
      where fi.flight_key = ${flight.flightKey} limit 1
    `);
    expect(snapshot?.key).toBe(flight.flightKey);
  });
});
