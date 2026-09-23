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
import { isBelowHorizon, staleBeforePage, syncCursorBinding } from '../../src/lib/sync-cursor';
import { upsertFlightInstance } from '../../src/queues/persist';
import {
  ReadOnlyConnectionError,
  readSyncBounds,
  readSyncHorizon,
  userChangesQuery,
} from '../../src/routes/sync';
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

/**
 * A pull whose cursor is past every change row the user has: the cursor a drained client holds.
 * A no-cursor pull answers `(watermark, 0)`, and while another file holds a writing transaction
 * open the watermark can sit below rows the snapshot already carried, which the next pull then
 * serves again (the documented, idempotent re-delivery); a test that counts rows after a cursor
 * waits for a cursor past them.
 */
async function settledPull(
  session: AnonymousSession,
  also: (page: SyncEnvelope) => boolean = () => true,
): Promise<SyncEnvelope> {
  const [latest] = await db().execute<{ xid: string | null }>(sql`
    select max(xid)::text as xid from user_sync_changes where user_id = ${session.userId}::uuid
  `);
  const floor = BigInt(latest?.xid ?? '0');
  return eventually(
    () => pull(session),
    (page) => BigInt(decodeSyncCursor(page.cursor).xid) > floor && also(page),
  );
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

    const snapshot = await settledPull(session);
    expect(snapshot.changes).toHaveLength(2);
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
    const start = await settledPull(session);
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
    let cursor = (await settledPull(session)).cursor;
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

    const snapshot = await settledPull(session, (page) => page.flights.length === 1);
    expect(snapshot.flights.map((f) => f.key)).toEqual([flight.flightKey]);
    const strangerStart = await settledPull(stranger);

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
    const { epoch } = await readSyncBounds(db());
    const future = encodeSyncCursor({
      xid: '18000000000000000000',
      seq: '1',
      epoch,
      binding: await syncCursorBinding(session.userId),
    });
    // The two-part form every cursor had before the principal binding (ruling O12).
    const unbound = btoa('1:0').replaceAll('=', '');

    const stale = await authed(session, `/v1/sync?cursor=${future}`);
    const garbage = await authed(session, '/v1/sync?cursor=not-a-cursor');
    const legacy = await authed(session, `/v1/sync?cursor=${unbound}`);

    expect(stale.status).toBe(410);
    expect((await stale.json<ErrorBody>()).error).toBe('resync_required');
    expect(garbage.status).toBe(400);
    expect((await garbage.json<ErrorBody>()).error).toBe('invalid_cursor');
    expect(legacy.status).toBe(400);
  });

  it('binds the cursor to its principal and its timeline: another user or epoch answers 410', async () => {
    // Ruling O12. A device that upgraded from an anonymous user to an existing account still holds
    // the anonymous user's cursor; served as-is it would hide every older row of the account. And
    // after a point-in-time restore the xids repeat, so a cursor from the lost timeline would look
    // current once the new one caught up.
    const anonymous = await signInAnonymously();
    const account = await signInAnonymously();
    await insertChanges(account.userId, 1);
    const held = await pull(anonymous);
    const decoded = decodeSyncCursor(held.cursor);
    expect(decoded.binding).toBe(await syncCursorBinding(anonymous.userId));
    const otherTimeline = encodeSyncCursor({
      ...decoded,
      epoch: String(BigInt(decoded.epoch) + 1n),
    });

    const asAccount = await authed(account, `/v1/sync?cursor=${encodeURIComponent(held.cursor)}`);
    const afterRestore = await authed(
      anonymous,
      `/v1/sync?cursor=${encodeURIComponent(otherTimeline)}`,
    );
    const own = await authed(anonymous, `/v1/sync?cursor=${encodeURIComponent(held.cursor)}`);

    expect(asAccount.status).toBe(410);
    expect(await asAccount.json<ErrorBody>()).toMatchObject({ error: 'resync_required' });
    expect(afterRestore.status).toBe(410);
    expect(await afterRestore.json<ErrorBody>()).toMatchObject({ error: 'resync_required' });
    expect(own.status).toBe(200);
    // The resync: without a cursor the account gets its own rows, older ones included.
    const snapshot = await pull(account);
    expect(decodeSyncCursor(snapshot.cursor).binding).toBe(await syncCursorBinding(account.userId));
  });

  it('answers 401 without a session', async () => {
    const response = await worker(jsonRequest('/v1/sync', 'GET', undefined));

    expect(response.status).toBe(401);
  });
});

describe('the watermark and the cursor', () => {
  it('judges a cursor stale on another epoch or principal, beyond the next xid, or below H', () => {
    const binding = '0123456789abcdef';
    const context = { nextXid: '1000', epoch: '1', binding };
    const at = (xid: string, seq = '0', epoch = '1', owner = binding) => ({
      xid,
      seq,
      epoch,
      binding: owner,
    });
    expect(staleBeforePage(at('999'), context)).toBeNull();
    expect(staleBeforePage(at('1000'), context)).toBeNull();
    expect(staleBeforePage(at('1001'), context)).toBe('unassigned');
    expect(staleBeforePage(at('5', '0', '2'), context)).toBe('epoch');
    expect(staleBeforePage(at('5', '0', '1', 'fedcba9876543210'), context)).toBe('binding');
    // The horizon is exact: strictly below H is stale, H itself is not (ruling O9).
    expect(isBelowHorizon(at('499', '9'), '500')).toBe(true);
    expect(isBelowHorizon(at('500'), '500')).toBe(false);
    expect(isBelowHorizon(at('1'), null)).toBe(false);
    // Strings all the way: 2^63 and beyond compare exactly.
    expect(
      staleBeforePage(at('9223372036854775809'), { ...context, nextXid: '9223372036854775808' }),
    ).toBe('unassigned');
    expect(isBelowHorizon(at('9223372036854775808'), '9223372036854775809')).toBe(true);
  });

  it('reads the horizon a purge records, and null before the first purge', async () => {
    class RolledBack extends Error {}
    let inside: string | null = 'unread';
    await expect(
      db().transaction(async (tx) => {
        await tx.execute(sql`update sync_horizon set horizon_xid = '123'::xid8 where id = 1`);
        inside = await readSyncHorizon(tx);
        throw new RolledBack();
      }),
    ).rejects.toBeInstanceOf(RolledBack);

    expect(inside).toBe('123');
    // Nothing in the suite purges; the rollback left the seeded row as the migration wrote it.
    expect(await readSyncHorizon(db())).toBeNull();
    expect((await readSyncBounds(db())).epoch).toBe('1');
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

  it('draws seq for both change tables from one sequence, so one transaction orders across them', async () => {
    // Ruling O3 has the persist consumer write both tables in one transaction; ADR 0012 item 3.
    const [column] = await db().execute<{ column_default: string; is_identity: string }>(sql`
      select column_default, is_identity from information_schema.columns
      where table_name = 'flight_sync_changes' and column_name = 'seq'
    `);
    expect(column?.column_default).toContain('user_sync_changes_seq_seq');
    expect(column?.is_identity).toBe('NO');

    const session = await signInAnonymously();
    const flight = seededFlightFor();
    await upsertFlightInstance(db(), instanceMessage(flight, 1));
    const seqs = await db().transaction(async (tx) => {
      const [user] = await tx.execute<{ xid: string; seq: string }>(sql`
        insert into user_sync_changes (user_id, entity, entity_id, op, row)
        values (${session.userId}::uuid, 'trips', uuidv7(), 'upsert', '{}'::jsonb)
        returning xid::text as xid, seq::text as seq
      `);
      const [flightRow] = await tx.execute<{ xid: string; seq: string }>(sql`
        insert into flight_sync_changes (flight_instance_id, snapshot)
        select id, '{}'::jsonb from flight_instances where flight_key = ${flight.flightKey}
        returning xid::text as xid, seq::text as seq
      `);
      return { user, flightRow };
    });
    expect(seqs.user?.xid).toBe(seqs.flightRow?.xid);
    expect(BigInt(seqs.flightRow?.seq ?? '0')).toBeGreaterThan(BigInt(seqs.user?.seq ?? '0'));
  });

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
