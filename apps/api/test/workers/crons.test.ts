/**
 * The crons and the housekeeping queue (increment 12, rulings W1 to W3).
 *
 * Every cron is driven through `scheduled()` with capturing queue producers: each one plans or
 * pages within its budget and enqueues, and nothing runs inline. Every housekeeping step is then
 * driven through the real queue consumer (`handleHousekeepingBatch`) against the embedded
 * Postgres 18, and the test reads back the rows it planted and the ONE `audit_log` row each
 * message writes, with its counts.
 *
 * The database is shared by every file running in parallel, so each step's test plants rows no
 * other file would (old timestamps, unique subjects, a provider nobody else calls) and asserts
 * on those rows; counts are asserted exactly where only this file can produce them and as lower
 * bounds where another file's rows could legitimately match. Two steps have global effects a
 * parallel file would feel, so they run against test seams: the sync purge against this file's
 * own copies of the two change tables and the horizon (the one `sync_horizon` row is what every
 * sync test pulls against), and the tracker reconciliation scoped to this file's instances.
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { flightInstances, userKeys } from '@planeahead/db';
import {
  RPC_SCHEMA_VERSION,
  type FlightKey,
  type ListSubscribersResponseV1,
} from '@planeahead/shared';
import { DAILY_CRON, RECONCILE_CRON, scheduled } from '../../src/cron/index';
import { RECONCILE_OVERDUE_MS } from '../../src/cron/reconcile';
import { Envelope } from '../../src/crypto/envelope';
import {
  UnknownKeyVersionError,
  createWorkersSecretKeyProvider,
  readKekSecrets,
  type KeyProvider,
} from '../../src/crypto/key-provider';
import type { Env } from '../../src/env';
import { sessionTombstoneKey } from '../../src/lib/session-tombstone';
import { chooseHorizon, stepHorizon } from '../../src/lib/sync-purge';
import { isBelowHorizon } from '../../src/lib/sync-cursor';
import {
  ROLLUP_PLAUSIBILITY_TOLERANCE,
  isPlausibleRollup,
  rollupDays,
  rollupRows,
} from '../../src/lib/provider-rollup';
import type { SubscriberListingTracker } from '../../src/lib/trackers';
import { createLogger } from '../../src/observability/log';
import {
  AE_ROLLUP_STEP,
  HOUSEKEEPING_STEPS,
  handleHousekeepingBatch,
  type HousekeepingDeps,
} from '../../src/queues/housekeeping';
import { drainTouched, testEnv } from './helpers/flights';
import { db, seedTracker, seededFlightFor, trackerStub } from './helpers/routes';

afterEach(drainTouched);

const quietLog = createLogger({}, () => undefined);
const MINUTE = 60_000;

interface CapturedQueue {
  readonly sent: unknown[];
  send(body: unknown): Promise<void>;
  sendBatch(messages: Iterable<MessageSendRequest<unknown>>): Promise<void>;
}

function capturingQueue(): CapturedQueue {
  const sent: unknown[] = [];
  return {
    sent,
    send: (body) => {
      sent.push(body);
      return Promise.resolve();
    },
    sendBatch: (messages) => {
      for (const message of messages) {
        sent.push(message.body);
      }
      return Promise.resolve();
    },
  };
}

/** A capturing queue where a producer binding is expected. */
function asQueue(queue: CapturedQueue): Queue {
  return queue as unknown as Queue;
}

/** The Worker's env with overrides (capturing queues, the Cloudflare API vars). */
function envWith(overrides: Record<string, unknown>): Env {
  return { ...testEnv, ...overrides };
}

function runId(): string {
  return `test-${crypto.randomUUID()}`;
}

function message(step: string, run: string, extra: Record<string, unknown> = {}) {
  return { kind: 'housekeeping', step, runId: run, page: 0, cursor: null, ...extra };
}

interface StepRun {
  readonly acked: readonly string[];
  /** Messages the consumer handed back for a retry (the step threw). */
  readonly retried: readonly string[];
  readonly continued: readonly Record<string, unknown>[];
  readonly audits: Record<string, unknown>[];
}

/** Runs one message through the consumer and reads back the audit rows of its run and step. */
async function runStep(
  body: ReturnType<typeof message> | Record<string, unknown>,
  deps: HousekeepingDeps = {},
  environment: Env = testEnv,
): Promise<StepRun> {
  const sink = capturingQueue();
  const batch = createMessageBatch('planeahead-housekeeping-local', [
    { id: `hk-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body },
  ]);
  const ctx = createExecutionContext();
  await handleHousekeepingBatch(
    batch,
    { env: environment, ctx, log: quietLog },
    { db: db(), sink: asQueue(sink), ...deps },
  );
  const result = await getQueueResult(batch, ctx);
  const run = typeof body['runId'] === 'string' ? body['runId'] : '';
  const audits = await db().execute<{ details: Record<string, unknown> }>(sql`
    select details from audit_log
    where request_id = ${`housekeeping:${run}`} and action = ${`housekeeping.${String(body['step'])}`}
    order by created_at
  `);
  return {
    acked: result.explicitAcks,
    retried: result.retryMessages.map((retry) => retry.msgId),
    continued: sink.sent as Record<string, unknown>[],
    audits: audits.map((row) => row.details),
  };
}

async function insertUser(
  options: { anonymous?: boolean; status?: string; deletionRequestedAgoMs?: number } = {},
): Promise<string> {
  const [row] = await db().execute<{ id: string }>(sql`
    insert into users (name, email, is_anonymous, status, deletion_requested_at)
    values ('hk', ${`hk-${crypto.randomUUID()}@housekeeping.test`}, ${options.anonymous === true},
            ${options.status ?? 'active'},
            ${
              options.deletionRequestedAgoMs === undefined
                ? null
                : new Date(Date.now() - options.deletionRequestedAgoMs).toISOString()
            })
    returning id::text as id
  `);
  if (row === undefined) {
    throw new Error('no user inserted');
  }
  return row.id;
}

async function insertInstance(
  trackingState = 'tracking',
): Promise<{ id: string; flightKey: FlightKey }> {
  const flight = seededFlightFor();
  const [row] = await db()
    .insert(flightInstances)
    .values({
      operatingCarrierIcao: 'AAL',
      flightNumber: flight.number,
      scheduledDepartureDate: flight.dateLocal,
      originIcao: 'KJFK',
      trackingState,
      version: 1,
    })
    .returning({ id: flightInstances.id, flightKey: flightInstances.flightKey });
  if (row === undefined) {
    throw new Error('no instance inserted');
  }
  return { id: row.id, flightKey: row.flightKey as FlightKey };
}

async function insertSubscription(
  userId: string,
  instanceId: string,
  options: { deletedAgo?: string; updatedAgo?: string; liveTracked?: boolean } = {},
): Promise<string> {
  const [row] = await db().execute<{ id: string }>(sql`
    insert into flight_subscriptions (user_id, flight_instance_id, live_tracked, deleted_at,
                                      updated_at, created_at)
    values (${userId}::uuid, ${instanceId}::uuid, ${options.liveTracked === true},
            ${options.deletedAgo === undefined ? null : sql`now() - ${options.deletedAgo}::interval`},
            now() - ${options.updatedAgo ?? '0 seconds'}::interval,
            now() - ${options.updatedAgo ?? '0 seconds'}::interval)
    returning id::text as id
  `);
  if (row === undefined) {
    throw new Error('no subscription inserted');
  }
  return row.id;
}

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const [row] = await db().execute<{ n: number }>(query);
  return row?.n ?? 0;
}

describe('scheduled(): every cron plans or pages within its budget and enqueues', () => {
  it('the reconcile cron pages overdue active trackers onto the reconcile queue', async () => {
    const overdue = await insertInstance('tracking');
    await db()
      .update(flightInstances)
      .set({ nextRefreshAt: new Date(Date.now() - RECONCILE_OVERDUE_MS - MINUTE).toISOString() })
      .where(eq(flightInstances.id, overdue.id));
    const queue = capturingQueue();
    const started = Date.now();

    await scheduled(
      { cron: RECONCILE_CRON, scheduledTime: Date.now(), noRetry: () => undefined },
      envWith({ RECONCILE_QUEUE: queue, HOUSEKEEPING_QUEUE: capturingQueue() }),
      createExecutionContext(),
    );

    expect(queue.sent.map((body) => (body as { flightKey: string }).flightKey)).toContain(
      overdue.flightKey,
    );
    // Inside the sub-hourly cron's 30 s CPU (a 25 s wall budget); here, milliseconds.
    expect(Date.now() - started).toBeLessThan(25_000);
  });

  it('the daily cron plans the housekeeping steps in order and two rollup days, and does no work', async () => {
    const queue = capturingQueue();
    const scheduledTime = Date.UTC(2026, 8, 23, 3, 0, 0);
    const run = new Date(scheduledTime).toISOString();

    await scheduled(
      { cron: DAILY_CRON, scheduledTime, noRetry: () => undefined },
      envWith({ HOUSEKEEPING_QUEUE: queue, RECONCILE_QUEUE: capturingQueue() }),
      createExecutionContext(),
    );

    expect(queue.sent).toEqual([
      ...HOUSEKEEPING_STEPS.map((step) => ({
        kind: 'housekeeping',
        step,
        runId: run,
        page: 0,
        cursor: null,
      })),
      ...['2026-09-22', '2026-09-21'].map((day) => ({
        kind: 'housekeeping',
        step: AE_ROLLUP_STEP,
        runId: run,
        page: 0,
        cursor: null,
        day,
      })),
    ]);
    expect(rollupDays(scheduledTime)).toEqual(['2026-09-22', '2026-09-21']);
    // Planned, not done: nothing of that run reached the audit log.
    expect(
      await count(
        sql`select count(*)::int as n from audit_log where request_id = ${`housekeeping:${run}`}`,
      ),
    ).toBe(0);
  });
});

describe('housekeeping step 1: idempotency_keys', () => {
  it('purges expired rows only, and writes one audit row with the count', async () => {
    const user = await insertUser();
    await db().execute(sql`
      insert into idempotency_keys (user_id, key, request_hash, response_status, response_body,
                                    expires_at, created_at)
      values (${user}::uuid, 'hk-expired-0001', decode('00', 'hex'), 201, '{}'::jsonb,
              now() - interval '1 hour', now() - interval '25 hours'),
             (${user}::uuid, 'hk-live-000001', decode('00', 'hex'), 201, '{}'::jsonb,
              now() + interval '1 hour', now())
    `);
    const run = runId();

    const result = await runStep(message('idempotency_keys', run));

    expect(result.acked).toHaveLength(1);
    expect(
      await count(
        sql`select count(*)::int as n from idempotency_keys where user_id = ${user}::uuid`,
      ),
    ).toBe(1);
    expect(result.audits).toHaveLength(1);
    expect(result.audits[0]).toMatchObject({ step: 'idempotency_keys', page: 0, done: true });
    expect(Number(result.audits[0]?.['deleted'])).toBeGreaterThanOrEqual(1);
    expect(result.continued).toEqual([]);
  });
});

/** This file's own copies of the change tables and the horizon (no foreign keys come along). */
async function syncCopies() {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const tables = {
    userChanges: `hk_user_sync_changes_${suffix}`,
    flightChanges: `hk_flight_sync_changes_${suffix}`,
    horizon: `hk_sync_horizon_${suffix}`,
  };
  await db().execute(sql`
    create table ${sql.identifier(tables.userChanges)} (like user_sync_changes including all)
  `);
  await db().execute(sql`
    create table ${sql.identifier(tables.flightChanges)} (like flight_sync_changes including all)
  `);
  await db().execute(sql`
    create table ${sql.identifier(tables.horizon)} (like sync_horizon including all)
  `);
  await db().execute(sql`insert into ${sql.identifier(tables.horizon)} (id) values (1)`);
  return tables;
}

async function userChange(table: string, xid: string, age: string): Promise<void> {
  await db().execute(sql`
    insert into ${sql.identifier(table)} (user_id, xid, entity, entity_id, op, created_at)
    values (uuidv7(), ${xid}::xid8, 'trips', uuidv7(), 'upsert', now() - ${age}::interval)
  `);
}

async function flightChange(table: string, xid: string, age: string): Promise<void> {
  await db().execute(sql`
    insert into ${sql.identifier(table)} (flight_instance_id, xid, snapshot, created_at)
    values (uuidv7(), ${xid}::xid8, '{}'::jsonb, now() - ${age}::interval)
  `);
}

async function xidsOf(table: string): Promise<string[]> {
  // Ordered by the xid8 column itself: a bare `xid` would name the `::text` alias and sort text.
  const rows = await db().execute<{ x: string }>(
    sql`select xid::text as x from ${sql.identifier(table)} order by ${sql.identifier(table)}.xid`,
  );
  return rows.map((row) => row.x);
}

describe('housekeeping step 2: the sync purge by xid', () => {
  it('purges both tables below ONE horizon, the smallest young xid, and records it in the same transaction', async () => {
    const tables = await syncCopies();
    // Inserted young-first, so the old rows get the HIGHER seqs: a seq-ordered purge would take
    // the young row first. And one old row sits ABOVE a young one in xid order (the late-commit
    // inversion): it stays, because a cursor below it may not have passed it.
    await userChange(tables.userChanges, '120', '10 days'); // young
    await userChange(tables.userChanges, '130', '45 days'); // old, above the young xid: kept
    await userChange(tables.userChanges, '100', '40 days'); // old, below: purged
    await flightChange(tables.flightChanges, '110', '35 days'); // old, below: purged
    await flightChange(tables.flightChanges, '150', '1 day'); // young
    const run = runId();

    const first = await runStep(message('sync_purge', run), { syncTables: tables });

    expect(first.audits).toHaveLength(1);
    expect(first.audits[0]).toMatchObject({
      horizon: '120',
      previous_horizon: null,
      user_changes_deleted: 1,
      flight_changes_deleted: 1,
      done: true,
    });
    expect(await xidsOf(tables.userChanges)).toEqual(['120', '130']);
    expect(await xidsOf(tables.flightChanges)).toEqual(['150']);
    const [horizon] = await db().execute<{ h: string }>(
      sql`select horizon_xid::text as h from ${sql.identifier(tables.horizon)} where id = 1`,
    );
    expect(horizon?.h).toBe('120');

    // Re-entrant: a redelivery finds the same horizon and nothing to delete.
    const second = await runStep(message('sync_purge', run), { syncTables: tables });
    expect(second.audits[1]).toMatchObject({
      horizon: '120',
      previous_horizon: '120',
      user_changes_deleted: 0,
      flight_changes_deleted: 0,
    });
  });

  it('never places the horizon above a transaction still in flight (pg_snapshot_xmin)', async () => {
    const tables = await syncCopies();
    let inFlightXid = '';
    let far = '';
    let audit: Record<string, unknown> = {};
    // A transaction on one of the file client's pooled connections writes a young change row and
    // stays open while the purge runs on the others. (A second client opened for the purpose kept
    // the Workers pool from shutting down at the end of a full run.)
    await db().transaction(async (tx) => {
      const [row] = await tx.execute<{ xid: string }>(sql`
        insert into ${sql.identifier(tables.userChanges)} (user_id, entity, entity_id, op)
        values (uuidv7(), 'trips', uuidv7(), 'upsert')
        returning xid::text as xid
      `);
      inFlightXid = row?.xid ?? '';
      // Only old rows are visible, all with xids far above anything assigned: without the cap the
      // horizon would be one above them and would pass the open transaction.
      far = (BigInt(inFlightXid) + 1_000_000n).toString();
      await userChange(tables.userChanges, far, '40 days');

      const result = await runStep(message('sync_purge', runId()), { syncTables: tables });
      audit = result.audits[0] ?? {};
    });

    expect(audit['horizon']).toBe(audit['xmin']);
    expect(BigInt(String(audit['horizon']))).toBeLessThanOrEqual(BigInt(inFlightXid));
    // The in-flight row committed after the purge and is at or above H: nothing lost.
    expect(await xidsOf(tables.userChanges)).toEqual([inFlightXid, far]);
  });

  it('chooses H by the rules: young minimum, else one above the old maximum, capped, never lower', () => {
    expect(chooseHorizon({ youngMin: '50', oldMax: '70', xmin: '1000', existing: null })).toBe(
      '50',
    );
    expect(chooseHorizon({ youngMin: null, oldMax: '70', xmin: '1000', existing: null })).toBe(
      '71',
    );
    expect(chooseHorizon({ youngMin: '5000', oldMax: null, xmin: '1000', existing: null })).toBe(
      '1000',
    );
    expect(chooseHorizon({ youngMin: '50', oldMax: null, xmin: '1000', existing: '60' })).toBe(
      '60',
    );
    expect(
      chooseHorizon({ youngMin: null, oldMax: null, xmin: '1000', existing: null }),
    ).toBeNull();
    expect(chooseHorizon({ youngMin: null, oldMax: null, xmin: '1000', existing: '9' })).toBe('9');
    // xid8 is 64-bit: BigInt, never Number.
    expect(
      chooseHorizon({
        youngMin: null,
        oldMax: '9223372036854775806',
        xmin: '9223372036854775807',
        existing: null,
      }),
    ).toBe('9223372036854775807');
  });
});

interface ChangeRow {
  readonly table: 'user' | 'flight';
  readonly xid: string;
  readonly seq: string;
}

async function changeRows(tables: Awaited<ReturnType<typeof syncCopies>>): Promise<ChangeRow[]> {
  const rows = await db().execute<{ table: 'user' | 'flight'; xid: string; seq: string }>(sql`
    select 'user' as "table", xid::text as xid, seq::text as seq
    from ${sql.identifier(tables.userChanges)}
    union all
    select 'flight', xid::text, seq::text from ${sql.identifier(tables.flightChanges)}
  `);
  return rows
    .map((row) => ({ table: row.table, xid: row.xid, seq: row.seq }))
    .sort((a, b) =>
      BigInt(a.xid) === BigInt(b.xid)
        ? Number(BigInt(a.seq) - BigInt(b.seq))
        : BigInt(a.xid) < BigInt(b.xid)
          ? -1
          : 1,
    );
}

/**
 * What `GET /v1/sync` owes a cursor at `(xid, 0)` against these tables and horizon, by the route's
 * own rule (`isBelowHorizon`): 410, or every row after the cursor.
 */
function answerFor(
  rows: readonly ChangeRow[],
  horizon: string | null,
  cursorXid: bigint,
): 'resync_required' | string[] {
  if (isBelowHorizon({ xid: cursorXid.toString(), seq: '0' }, horizon)) {
    return 'resync_required';
  }
  return rows
    .filter((row) => BigInt(row.xid) >= cursorXid)
    .map((row) => `${row.table}:${row.xid}:${row.seq}`);
}

describe('housekeeping step 2: the paged purge (ruling AA15)', () => {
  async function plant(tables: Awaited<ReturnType<typeof syncCopies>>): Promise<void> {
    for (const [xid, age] of [
      ['100', '40 days'],
      ['101', '40 days'],
      ['102', '39 days'],
      ['103', '38 days'],
      ['104', '35 days'],
    ] as const) {
      await userChange(tables.userChanges, xid, age);
    }
    await userChange(tables.userChanges, '120', '10 days'); // young: the one-pass horizon
    await userChange(tables.userChanges, '130', '45 days'); // old, above the young xid: kept
    await flightChange(tables.flightChanges, '110', '35 days');
    await flightChange(tables.flightChanges, '111', '33 days');
    await flightChange(tables.flightChanges, '150', '1 day');
  }

  it('advances the horizon in bounded steps to the one-pass horizon, every step exact for any cursor', async () => {
    const paged = await syncCopies();
    const onePass = await syncCopies();
    await plant(paged);
    await plant(onePass);
    const original = await changeRows(paged);

    const reference = await runStep(message('sync_purge', runId()), { syncTables: onePass });
    expect(reference.audits[0]).toMatchObject({ horizon: '120', done: true });
    expect(reference.continued).toEqual([]);

    const run = runId();
    let body: Record<string, unknown> = message('sync_purge', run);
    const horizons: string[] = [];
    const deleted: number[] = [];
    for (let page = 0; page < 20; page += 1) {
      const step = await runStep(body, { syncTables: paged, syncPurgeRowsPerStep: 2 });
      const audit = step.audits.at(-1) ?? {};
      const horizon = String(audit['horizon']);
      horizons.push(horizon);
      deleted.push(Number(audit['user_changes_deleted']) + Number(audit['flight_changes_deleted']));
      expect(audit).toMatchObject({ page, rows_per_step: 2 });
      // Between steps the recorded horizon is exact: every cursor below it answers 410, every
      // cursor at or above it gets exactly the rows the unpurged tables held after it.
      const now = await changeRows(paged);
      for (let cursor = 95n; cursor <= 155n; cursor += 1n) {
        const expected =
          cursor < BigInt(horizon) ? 'resync_required' : answerFor(original, null, cursor);
        expect(answerFor(now, horizon, cursor), `cursor ${String(cursor)} at H ${horizon}`).toEqual(
          expected,
        );
      }
      const next = step.continued[0];
      if (next === undefined) {
        expect(audit['done']).toBe(true);
        break;
      }
      expect(audit['done']).toBe(false);
      expect(next).toMatchObject({ kind: 'housekeeping', step: 'sync_purge', runId: run });
      body = next;
    }

    // Four steps of at most two rows each, never above the one-pass horizon, ending on it.
    expect(horizons).toEqual(['102', '104', '111', '120']);
    expect(deleted.every((n) => n <= 2)).toBe(true);
    expect(await xidsOf(paged.userChanges)).toEqual(await xidsOf(onePass.userChanges));
    expect(await xidsOf(paged.flightChanges)).toEqual(await xidsOf(onePass.flightChanges));
  });

  it('never splits one transaction: a step takes every row of the oldest xid even past the bound', async () => {
    const tables = await syncCopies();
    for (let i = 0; i < 3; i += 1) {
      await userChange(tables.userChanges, '200', '40 days');
    }
    await userChange(tables.userChanges, '300', '2 days');
    const run = runId();

    const first = await runStep(message('sync_purge', run), {
      syncTables: tables,
      syncPurgeRowsPerStep: 2,
    });
    expect(first.audits[0]).toMatchObject({ horizon: '201', user_changes_deleted: 3, done: false });
    const second = await runStep(first.continued[0] ?? {}, {
      syncTables: tables,
      syncPurgeRowsPerStep: 2,
    });
    expect(second.audits.at(-1)).toMatchObject({ horizon: '300', done: true });
    expect(await xidsOf(tables.userChanges)).toEqual(['300']);
  });

  it('chooses each step horizon by the rules, capped at xmin and never below the recorded one', () => {
    const old = (xid: string) => ({ xid, young: false });
    const young = (xid: string) => ({ xid, young: true });
    expect(
      stepHorizon({
        rows: [old('1'), old('2'), old('3')],
        rowsPerStep: 2,
        xmin: '99',
        existing: null,
      }),
    ).toEqual({ horizon: '3', done: false });
    expect(
      stepHorizon({
        rows: [old('1'), young('2'), old('3')],
        rowsPerStep: 2,
        xmin: '99',
        existing: null,
      }),
    ).toEqual({ horizon: '2', done: true });
    expect(
      stepHorizon({ rows: [old('1'), old('2')], rowsPerStep: 2, xmin: '99', existing: null }),
    ).toEqual({
      horizon: '3',
      done: true,
    });
    expect(
      stepHorizon({
        rows: [old('5'), old('5'), old('5')],
        rowsPerStep: 2,
        xmin: '99',
        existing: null,
      }),
    ).toEqual({ horizon: '6', done: false });
    expect(
      stepHorizon({
        rows: [old('1'), old('2'), old('90')],
        rowsPerStep: 2,
        xmin: '50',
        existing: null,
      }),
    ).toEqual({ horizon: '50', done: true });
    expect(
      stepHorizon({ rows: [young('40')], rowsPerStep: 2, xmin: '99', existing: '60' }),
    ).toEqual({
      horizon: '60',
      done: true,
    });
    expect(stepHorizon({ rows: [], rowsPerStep: 2, xmin: '99', existing: null })).toEqual({
      horizon: null,
      done: true,
    });
  });
});

describe('housekeeping step 3: provider_calls', () => {
  it('purges whole days older than 90 days only for the days a plausible rollup already holds', async () => {
    const tag = `hk-pc-${crypto.randomUUID()}`;
    await db().execute(sql`
      insert into provider_calls (id, provider, operation, trigger, result, request_id, created_at)
      values (uuidv7(), 'open_meteo', 'forecast', 'cron', 'ok', ${tag}, now() - interval '100 days'),
             (uuidv7(), 'open_meteo', 'forecast', 'cron', 'ok', ${tag}, now() - interval '101 days'),
             (uuidv7(), 'open_meteo', 'forecast', 'cron', 'ok', ${tag}, now())
    `);
    // A per-operation rollup row for day -100 that matches its one call; day -101 has nothing but
    // the ProviderBudget object's own row, which is not a rollup.
    await db().execute(sql`
      insert into provider_call_daily (day, provider, operation, result, calls)
      values (((now() - interval '100 days') at time zone 'UTC')::date, 'open_meteo', 'forecast', 'ok', 1),
             (((now() - interval '101 days') at time zone 'UTC')::date, 'open_meteo', 'budget_daily', 'ok', 1)
      on conflict (day, provider, operation, result) do nothing
    `);
    const run = runId();

    const result = await runStep(message('provider_calls', run));

    const left = await db().execute<{ age: number }>(sql`
      select extract(day from now() - created_at)::int as age
      from provider_calls where request_id = ${tag} order by created_at
    `);
    expect(left.map((row) => row.age)).toEqual([101, 0]);
    expect(Number(result.audits[0]?.['deleted'])).toBeGreaterThanOrEqual(1);
    expect(Number(result.audits[0]?.['days_purged'])).toBeGreaterThanOrEqual(1);
    expect(Number(result.audits[0]?.['days_without_rollup'])).toBeGreaterThanOrEqual(1);
    // A rollup row older than `ledger_calls` was judged against the live count once, and the
    // purge recorded that count on it before its first delete (ruling AB3).
    const [rollup] = await db().execute<{ ledger_calls: number | null }>(sql`
      select ledger_calls from provider_call_daily
      where day = ((now() - interval '100 days') at time zone 'UTC')::date
        and provider = 'open_meteo' and operation = 'forecast'
    `);
    expect(rollup?.ledger_calls).toBe(1);
  });

  it('judges a rollup plausible only above zero and within the tolerance of the ledger', () => {
    expect(ROLLUP_PLAUSIBILITY_TOLERANCE).toBe(0.2);
    expect(isPlausibleRollup(25, 25)).toBe(true);
    expect(isPlausibleRollup(20, 25)).toBe(true);
    expect(isPlausibleRollup(30, 25)).toBe(true);
    expect(isPlausibleRollup(19, 25)).toBe(false);
    expect(isPlausibleRollup(31, 25)).toBe(false);
    expect(isPlausibleRollup(0, 25)).toBe(false);
    expect(isPlausibleRollup(3, 25)).toBe(false);
    expect(isPlausibleRollup(5, 0)).toBe(false);
    expect(isPlausibleRollup(Number.NaN, 25)).toBe(false);
  });
});

describe('the rollup and the purge gate together (ruling AA13)', () => {
  const ACCOUNT = 'fedcba9876543210fedcba9876543210';
  const rollupEnv = () => envWith({ CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: 'test-token' });

  /** The SQL API answering `row` for aerodatabox and nothing for the other providers. */
  function sqlApiAnswering(row: Record<string, unknown>): typeof fetch {
    const answer = (_input: RequestInfo | URL, init?: RequestInit) => {
      const statement = typeof init?.body === 'string' ? init.body : '';
      const data = statement.includes("index1 = 'aerodatabox'") ? [row] : [];
      return Promise.resolve(Response.json({ meta: [], data, rows: data.length }));
    };
    return answer;
  }

  /** `count` aerodatabox calls at noon UTC `daysAgo` days back; returns the day. */
  async function plantLedger(daysAgo: number, count: number): Promise<string> {
    const [row] = await db().execute<{ day: string }>(sql`
      select ((now() at time zone 'UTC')::date - ${daysAgo}::int)::text as day
    `);
    const day = row?.day ?? '';
    await db().execute(sql`
      insert into provider_calls (id, provider, operation, trigger, result, request_id, created_at)
      select uuidv7(), 'aerodatabox', 'flight_status', 'cron', 'ok', ${`hk-gate-${day}`},
             (${day}::date)::timestamp at time zone 'UTC' + interval '12 hours'
      from generate_series(1, ${count}::int)
    `);
    return day;
  }

  const ledgerLeft = (day: string) =>
    count(
      sql`select count(*)::int as n from provider_calls where request_id = ${`hk-gate-${day}`}`,
    );

  const rollupOf = (day: string) =>
    db().execute<{ operation: string; calls: number; ledger_calls: number | null }>(sql`
      select operation, calls, ledger_calls from provider_call_daily
      where day = ${day}::date and provider = 'aerodatabox' order by operation
    `);

  it.each([
    ['null sums', 1_001, { calls: null, cost_units: null, cost_usd_micros: null }],
    ['missing sums', 1_002, {}],
    ['non-numeric sums', 1_003, { calls: '25.0x', cost_units: 'n/a', cost_usd_micros: '1' }],
  ] as const)(
    'never writes a zero row for %s: the message fails loudly and the ledger stays',
    async (_label, daysAgo, sums) => {
      const day = await plantLedger(daysAgo, 25);
      const run = runId();

      const rollup = await runStep(
        message(AE_ROLLUP_STEP, run, { day }),
        { fetch: sqlApiAnswering({ operation: 'flight_status', result: 'ok', ...sums }) },
        rollupEnv(),
      );

      // Retried (and, past the retries, dead-lettered with the ops alert), never acknowledged.
      expect(rollup.acked).toEqual([]);
      expect(rollup.retried).toHaveLength(1);
      expect(rollup.audits).toEqual([]);
      expect(await rollupOf(day)).toEqual([]);

      const purge = await runStep(message('provider_calls', runId()));
      expect(await ledgerLeft(day)).toBe(25);
      expect(Number(purge.audits[0]?.['days_without_rollup'])).toBeGreaterThanOrEqual(1);
    },
  );

  it('keeps a day whose rollup is zero or implausibly low against the ledger, and logs it', async () => {
    const low = await plantLedger(1_004, 25);
    const zero = await plantLedger(1_005, 25);
    await runStep(
      message(AE_ROLLUP_STEP, runId(), { day: low }),
      {
        fetch: sqlApiAnswering({
          operation: 'flight_status',
          result: 'ok',
          calls: '3',
          cost_units: 6,
          cost_usd_micros: 1_500,
        }),
      },
      rollupEnv(),
    );
    await runStep(
      message(AE_ROLLUP_STEP, runId(), { day: zero }),
      {
        fetch: sqlApiAnswering({
          operation: 'flight_status',
          result: 'ok',
          calls: 0,
          cost_units: 0,
          cost_usd_micros: 0,
        }),
      },
      rollupEnv(),
    );
    // The rollup recorded the ledger's count beside its sums (ruling AB3).
    expect(await rollupOf(low)).toEqual([
      { operation: 'flight_status', calls: 3, ledger_calls: 25 },
    ]);
    expect(await rollupOf(zero)).toEqual([
      { operation: 'flight_status', calls: 0, ledger_calls: 25 },
    ]);

    const purge = await runStep(message('provider_calls', runId()));

    expect(await ledgerLeft(low)).toBe(25);
    expect(await ledgerLeft(zero)).toBe(25);
    expect(Number(purge.audits[0]?.['days_without_plausible_rollup'])).toBeGreaterThanOrEqual(2);
  });

  it('purges a day whose sampled rollup lies within the tolerance across a continuation, judged again against the recorded count', async () => {
    const day = await plantLedger(1_010, 25);
    await runStep(
      message(AE_ROLLUP_STEP, runId(), { day }),
      {
        fetch: sqlApiAnswering({
          operation: 'flight_status',
          result: 'ok',
          calls: '24',
          cost_units: '48',
          cost_usd_micros: '12000',
        }),
      },
      rollupEnv(),
    );
    const run = runId();

    // Ten rows per batch and no budget: the first message deletes one batch and hands the rest on.
    const first = await runStep(message('provider_calls', run), {
      deleteBatch: 10,
      wallBudgetMs: 0,
    });
    expect(await ledgerLeft(day)).toBe(15);
    expect(first.continued).toEqual([
      expect.objectContaining({ step: 'provider_calls', cursor: `from:${day}|aerodatabox` }),
    ]);

    // 15 left against a rollup of 24 is outside the band now; the continuation judges the day
    // again, against the 25 the rollup recorded, and finishes it.
    const second = await runStep(first.continued[0] ?? {}, { deleteBatch: 10 });
    expect(await ledgerLeft(day)).toBe(0);
    expect(second.audits.at(-1)).toMatchObject({ done: true });
    expect(Number(second.audits.at(-1)?.['deleted'])).toBeGreaterThanOrEqual(15);
    expect(Number(second.audits.at(-1)?.['days_purged'])).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['recorded by the rollup', 1_020, true],
    ['older than the column, recorded by the purge itself', 1_021, false],
  ] as const)(
    'purges the whole day on a retry after the continuation send failed past a partial delete, the count %s',
    async (_label, daysAgo, viaRollup) => {
      // The re-review's reproduction (rr-ops-3): 100 rows, a rollup of 100, 30 rows per batch, a
      // continuation send that throws once. Before ruling AB3 the retried message judged the day
      // by its live count of 70, found 100 implausible and kept the rest for good.
      const day = await plantLedger(daysAgo, 100);
      if (viaRollup) {
        await runStep(
          message(AE_ROLLUP_STEP, runId(), { day }),
          {
            fetch: sqlApiAnswering({
              operation: 'flight_status',
              result: 'ok',
              calls: '100',
              cost_units: '200',
              cost_usd_micros: '50000',
            }),
          },
          rollupEnv(),
        );
      } else {
        await db().execute(sql`
          insert into provider_call_daily (day, provider, operation, result, calls)
          values (${day}::date, 'aerodatabox', 'flight_status', 'ok', 100)
          on conflict (day, provider, operation, result) do update
            set calls = excluded.calls, ledger_calls = null
        `);
      }
      expect(await rollupOf(day)).toEqual([
        { operation: 'flight_status', calls: 100, ledger_calls: viaRollup ? 100 : null },
      ]);
      const run = runId();
      const failing = { send: () => Promise.reject(new Error('transient queue send failure')) };

      // One batch, the audit row, then the send throws: the queue redelivers the message as it
      // was, with its original cursor, not the continuation it never managed to send.
      const first = await runStep(message('provider_calls', run), {
        deleteBatch: 30,
        wallBudgetMs: 0,
        sink: failing as unknown as Queue,
      });
      expect(first.retried).toHaveLength(1);
      expect(first.acked).toEqual([]);
      expect(await ledgerLeft(day)).toBe(70);
      // Whichever way the count got there, it is on the rollup row before the first delete.
      expect(await rollupOf(day)).toEqual([
        { operation: 'flight_status', calls: 100, ledger_calls: 100 },
      ]);

      // The redelivery: 70 left against a rollup of 100 is outside the band, but the day is
      // judged against the recorded 100 and purged to the end.
      const retry = await runStep(message('provider_calls', run), { deleteBatch: 30 });
      expect(retry.acked).toHaveLength(1);
      expect(await ledgerLeft(day)).toBe(0);
      expect(retry.audits.at(-1)).toMatchObject({ done: true });
      expect(Number(retry.audits.at(-1)?.['days_purged'])).toBeGreaterThanOrEqual(1);
    },
  );

  it('parses only numeric sums into rows (the pure half)', () => {
    expect(
      rollupRows([
        {
          operation: 'flight_status',
          result: 'ok',
          calls: '7',
          cost_units: 14,
          cost_usd_micros: '3500',
        },
        { operation: 'budget_daily', result: 'ok', calls: null },
      ]),
    ).toEqual({
      rows: [
        { operation: 'flight_status', result: 'ok', calls: 7, costUnits: 14, costUsdMicros: 3_500 },
      ],
      skipped: 1,
    });
    expect(() =>
      rollupRows([
        { operation: 'flight_status', result: 'ok', calls: '', cost_units: 1, cost_usd_micros: 1 },
      ]),
    ).toThrow(/non-numeric calls/);
    expect(() =>
      rollupRows([
        { operation: 'flight_status', result: 'ok', calls: 1, cost_units: -5, cost_usd_micros: 1 },
      ]),
    ).toThrow(/non-numeric cost_units/);
  });
});

describe('housekeeping step 4: retention', () => {
  it('purges each table past its window and keeps what is inside it', async () => {
    const user = await insertUser();
    const instance = await insertInstance();
    const tag = crypto.randomUUID();
    const handle = db();
    await handle.execute(sql`
      insert into notifications (user_id, kind, dedupe_key, title, body, created_at)
      values (${user}::uuid, 'system', ${`${tag}:old`}, 't', 'b', now() - interval '91 days'),
             (${user}::uuid, 'system', ${`${tag}:new`}, 't', 'b', now())
    `);
    await handle.execute(sql`
      insert into data_export_jobs (user_id, requested_at)
      values (${user}::uuid, now() - interval '8 days'), (${user}::uuid, now())
    `);
    await handle.execute(sql`
      insert into deleted_subjects (subject_id, reason, expires_at)
      values (${user}::uuid, 'user_request', now() - interval '1 second'),
             (${user}::uuid, 'user_request', now() + interval '1 day')
    `);
    const nowMs = Date.now();
    await handle.execute(sql`
      insert into rate_limits (key, count, last_request)
      values (${`${tag}:old`}, 1, ${nowMs - 2 * 3_600_000}), (${`${tag}:new`}, 1, ${nowMs})
    `);
    await handle.execute(sql`
      insert into verifications (identifier, value, expires_at)
      values (${`${tag}:old`}, 'v', now() - interval '1 minute'),
             (${`${tag}:new`}, 'v', now() + interval '10 minutes')
    `);
    await handle.execute(sql`
      insert into flight_events (flight_instance_id, seq, occurred_at, type, source, created_at)
      values (${instance.id}::uuid, 1, now(), 'created', 'system', now() - interval '91 days'),
             (${instance.id}::uuid, 2, now(), 'created', 'system', now())
    `);
    await handle.execute(sql`
      insert into sessions (token, user_id, expires_at)
      values (${`${tag}-old`}, ${user}::uuid, now() - interval '1 day'),
             (${`${tag}-new`}, ${user}::uuid, now() + interval '1 day')
    `);
    await handle.execute(sql`
      insert into usage_counters (scope, subject, counter, window_start, count)
      values ('user', ${user}, 'instances_created', date_trunc('day', now() - interval '31 days'), 3),
             ('user', ${user}, 'instances_created', date_trunc('day', now()), 1),
             ('user', ${user}, 'active_subscriptions', '1970-01-01T00:00:00Z', 1)
    `);
    await insertSubscription(user, instance.id, { deletedAgo: '31 days' });
    await insertSubscription(user, instance.id, { deletedAgo: '1 day' });
    const run = runId();

    const result = await runStep(message('retention', run));

    const n = (query: ReturnType<typeof sql>) => count(query);
    expect(
      await n(sql`select count(*)::int as n from notifications where user_id = ${user}::uuid`),
    ).toBe(1);
    expect(
      await n(sql`select count(*)::int as n from data_export_jobs where user_id = ${user}::uuid`),
    ).toBe(1);
    expect(
      await n(
        sql`select count(*)::int as n from deleted_subjects where subject_id = ${user}::uuid`,
      ),
    ).toBe(1);
    expect(
      await n(sql`select count(*)::int as n from rate_limits where key like ${`${tag}:%`}`),
    ).toBe(1);
    expect(
      await n(
        sql`select count(*)::int as n from verifications where identifier like ${`${tag}:%`}`,
      ),
    ).toBe(1);
    expect(
      await n(
        sql`select count(*)::int as n from flight_events where flight_instance_id = ${instance.id}::uuid`,
      ),
    ).toBe(1);
    expect(
      await n(sql`select count(*)::int as n from sessions where user_id = ${user}::uuid`),
    ).toBe(1);
    // The day window 31 days old goes; today's and the epoch window of a non-monotonic cap stay.
    expect(
      await n(sql`select count(*)::int as n from usage_counters where subject = ${user}`),
    ).toBe(2);
    expect(
      await n(sql`
        select count(*)::int as n from flight_subscriptions
        where user_id = ${user}::uuid and deleted_at is not null`),
    ).toBe(1);
    const audit = result.audits[0] ?? {};
    for (const purge of [
      'notifications',
      'data_export_jobs',
      'deleted_subjects',
      'rate_limits',
      'verifications',
      'flight_events',
      'sessions',
      'usage_counter_windows',
      'flight_subscriptions_tombstones',
    ]) {
      expect(Number(audit[purge]), purge).toBeGreaterThanOrEqual(1);
    }
    expect(audit['done']).toBe(true);
  });

  it('hands the rest to a continuation when the budget runs out, with the page and the cursor', async () => {
    const run = runId();

    const result = await runStep(message('retention', run), { wallBudgetMs: 0 });

    expect(result.acked).toHaveLength(1);
    expect(result.continued).toEqual([
      { kind: 'housekeeping', step: 'retention', runId: run, page: 1, cursor: '1' },
    ]);
    expect(result.audits[0]).toMatchObject({ page: 0, done: false });
  });
});

describe('housekeeping step 5: usage_counters', () => {
  it('repairs quiet drifted counters to the live rows, creates missing ones, removes orphans, logs the drift', async () => {
    const drifted = await insertUser();
    const busy = await insertUser();
    const uncounted = await insertUser();
    const orphan = crypto.randomUUID();
    const one = await insertInstance();
    const two = await insertInstance();
    await insertSubscription(drifted, one.id, { updatedAgo: '1 hour', liveTracked: true });
    await insertSubscription(drifted, two.id, { updatedAgo: '1 hour' });
    await insertSubscription(busy, one.id, { updatedAgo: '1 hour' });
    await insertSubscription(uncounted, one.id, { updatedAgo: '1 hour' });
    await db().execute(sql`
      insert into usage_counters (scope, subject, counter, window_start, count, updated_at)
      values ('user', ${drifted}, 'active_subscriptions', '1970-01-01T00:00:00Z', 5,
              now() - interval '1 hour'),
             ('user', ${drifted}, 'live_tracked', '1970-01-01T00:00:00Z', 0, now() - interval '1 hour'),
             ('user', ${busy}, 'active_subscriptions', '1970-01-01T00:00:00Z', 4, now()),
             ('user', ${orphan}, 'instances_created', date_trunc('day', now()), 2,
              now() - interval '1 hour')
    `);
    const run = runId();

    const result = await runStep(message('usage_counters', run));

    const value = async (subject: string, counter: string) =>
      count(sql`
        select coalesce(sum(count), 0)::int as n from usage_counters
        where scope = 'user' and subject = ${subject} and counter = ${counter}`);
    expect(await value(drifted, 'active_subscriptions')).toBe(2);
    expect(await value(drifted, 'live_tracked')).toBe(1);
    // Touched a moment ago: a request may be between its take and its row; left for tomorrow.
    expect(await value(busy, 'active_subscriptions')).toBe(4);
    expect(await value(uncounted, 'active_subscriptions')).toBe(1);
    expect(await value(orphan, 'instances_created')).toBe(0);
    const audit = result.audits[0] ?? {};
    expect(Number(audit['repaired'])).toBeGreaterThanOrEqual(2);
    expect(Number(audit['created'])).toBeGreaterThanOrEqual(1);
    expect(Number(audit['orphans_deleted'])).toBeGreaterThanOrEqual(1);
    expect(audit['drift']).toEqual(
      expect.arrayContaining([
        { subject: drifted, counter: 'active_subscriptions', before: 5, after: 2 },
        { subject: drifted, counter: 'live_tracked', before: 0, after: 1 },
      ]),
    );
  });
});

interface FakeTrackerCall {
  readonly method: 'subscribe' | 'unsubscribe';
  readonly input: Record<string, unknown>;
}

function fakeTracker(flightKey: FlightKey, entries: ListSubscribersResponseV1['subscribers']) {
  const calls: FakeTrackerCall[] = [];
  const tracker: SubscriberListingTracker = {
    listSubscribers: () =>
      Promise.resolve({ rpcVersion: 1, flightKey, phase: 'scheduled', subscribers: entries }),
    subscribe: (input) => {
      calls.push({ method: 'subscribe', input: input as Record<string, unknown> });
      return Promise.resolve({
        rpcVersion: 1,
        status: 'subscribed',
        flightKey,
      });
    },
    unsubscribe: (input) => {
      calls.push({ method: 'unsubscribe', input: input as Record<string, unknown> });
      return Promise.resolve({ rpcVersion: 1, status: 'unsubscribed', subscriberCount: 0 });
    },
  };
  return { tracker, calls };
}

describe('housekeeping step 6: tracker subscribers', () => {
  it('makes the tracker list follow Postgres, then deletes the merged anonymous user', async () => {
    const instance = await insertInstance();
    const kept = await insertUser();
    const mergedTo = await insertUser();
    const other = await insertUser();
    const anonymous = await insertUser({
      anonymous: true,
      status: 'deleting',
      deletionRequestedAgoMs: 2 * 60 * MINUTE,
    });
    const s1 = await insertSubscription(kept, instance.id, { updatedAgo: '1 hour' });
    const s2 = await insertSubscription(mergedTo, instance.id, { updatedAgo: '1 hour' });
    const s3 = await insertSubscription(anonymous, instance.id, { updatedAgo: '1 hour' });
    const s5 = await insertSubscription(other, instance.id, { updatedAgo: '1 hour' });
    const lost = crypto.randomUUID();
    const young = crypto.randomUUID();
    const old = Date.now() - 60 * MINUTE;
    const fake = fakeTracker(instance.flightKey, [
      { subscriptionId: s1, userId: kept, createdAtMs: old }, // kept
      { subscriptionId: s2, userId: anonymous, createdAtMs: old }, // moved by a lost merge message
      { subscriptionId: s3, userId: anonymous, createdAtMs: old }, // the deleting user's stray
      { subscriptionId: lost, userId: kept, createdAtMs: old }, // no row at all
      { subscriptionId: young, userId: kept, createdAtMs: Date.now() }, // may be mid-subscribe
    ]);
    const run = runId();

    const result = await runStep(message('tracker_subscribers', run), {
      trackerFor: () => fake.tracker,
      instanceScope: inArray(flightInstances.id, [instance.id]),
    });

    expect(result.audits[0]).toMatchObject({
      instances: 1,
      kept: 1,
      repointed: 1,
      unsubscribed: 2,
      resubscribed: 1,
      young: 1,
      failed_calls: 0,
      anonymous_strays_unsubscribed: 1,
      anonymous_users_deleted: 1,
      anonymous_user_ids: [anonymous],
      done: true,
    });
    expect(fake.calls).toEqual([
      { method: 'unsubscribe', input: { rpcVersion: 1, subscriptionId: s2 } },
      {
        method: 'subscribe',
        input: expect.objectContaining({ subscriptionId: s2, userId: mergedTo }) as unknown,
      },
      { method: 'unsubscribe', input: { rpcVersion: 1, subscriptionId: s3 } },
      { method: 'unsubscribe', input: { rpcVersion: 1, subscriptionId: lost } },
      {
        method: 'subscribe',
        input: expect.objectContaining({ subscriptionId: s5, userId: other }) as unknown,
      },
      { method: 'unsubscribe', input: { rpcVersion: 1, subscriptionId: s3 } },
    ]);
    expect(
      await count(sql`select count(*)::int as n from users where id = ${anonymous}::uuid`),
    ).toBe(0);
    expect(
      await count(sql`select count(*)::int as n from flight_subscriptions where id = ${s3}::uuid`),
    ).toBe(0);
  });

  it('reads a real FlightTracker through listSubscribers and removes the stray', async () => {
    const flight = seededFlightFor();
    const stub = await seedTracker(flight);
    const [instance] = await db()
      .insert(flightInstances)
      .values({
        operatingCarrierIcao: 'AAL',
        flightNumber: flight.number,
        scheduledDepartureDate: flight.dateLocal,
        originIcao: 'KJFK',
        trackingState: 'tracking',
        version: 1,
      })
      .returning({ id: flightInstances.id });
    const user = await insertUser();
    const live = await insertSubscription(user, instance?.id ?? '', { updatedAgo: '1 hour' });
    const stray = crypto.randomUUID();
    for (const subscriptionId of [live, stray]) {
      await stub.subscribe({ rpcVersion: RPC_SCHEMA_VERSION, subscriptionId, userId: user });
    }
    expect(
      (await stub.listSubscribers({})).subscribers.map((s) => s.subscriptionId).sort(),
    ).toEqual([live, stray].sort());
    const run = runId();

    const result = await runStep(message('tracker_subscribers', run), {
      trackerFor: (key) => trackerStub(key),
      instanceScope: inArray(flightInstances.id, [instance?.id ?? '']),
      // Eleven minutes on: the entries the test just wrote are past the grace.
      now: () => Date.now() + 11 * MINUTE,
    });

    expect(result.audits[0]).toMatchObject({ kept: 1, unsubscribed: 1, failed_calls: 0 });
    const after = await stub.listSubscribers({});
    expect(after.flightKey).toBe(flight.flightKey);
    expect(after.subscribers).toEqual([
      expect.objectContaining({ subscriptionId: live, userId: user }),
    ]);
  });

  it('answers phase absent with an empty list for a tracker that holds no flight', async () => {
    const stub = trackerStub(seededFlightFor().flightKey);
    expect(await stub.listSubscribers({})).toEqual({
      rpcVersion: 1,
      flightKey: null,
      phase: 'absent',
      subscribers: [],
    });
  });
});

describe('housekeeping step 7: dlq_replay', () => {
  it('replays the archives only the DLQ holds (resolver, budget) and deletes each once sent; keeps a tracker archive; parks a poison one', async () => {
    const bucket = env.PRIVATE_BUCKET;
    const record = (body: unknown) =>
      JSON.stringify({ queue: 'planeahead-persist-local', kind: 'persist', attempts: 6, body });
    const resolver = {
      kind: 'provider_call',
      origin: 'designator_resolver:AA1-2100-01-01@1',
      seq: 1,
      payload: { id: crypto.randomUUID() },
    };
    const budget = {
      kind: 'provider_call_daily',
      origin: 'provider_budget:aerodatabox:2100-01-01@1',
      seq: 4,
      payload: { day: '2100-01-01' },
    };
    const tracker = {
      kind: 'flight_instance',
      origin: 'flight_tracker:AAL-1-2100-01-01-KJFK@1',
      seq: 9,
      payload: { version: 3 },
    };
    const id = crypto.randomUUID();
    await bucket.put(`dlq/persist/${id}-a.json`, record(resolver));
    await bucket.put(`dlq/persist/${id}-b.json`, record({ ...resolver, replayCount: 3 }));
    await bucket.put(`dlq/persist/${id}-c.json`, 'not json');
    await bucket.put(`dlq/persist/${id}-d.json`, record(budget));
    await bucket.put(`dlq/persist/${id}-e.json`, record(tracker));
    await bucket.put(`dlq/persist/${id}-f.json`, record({ ...tracker, replayCount: 5 }));
    await bucket.put(`dlq/notify/${id}.json`, record({ kind: 'other' }));
    const persist = capturingQueue();

    // Just dead-lettered: left alone.
    const early = await runStep(message('dlq_replay', runId()), {
      persistSink: asQueue(persist),
      bucket,
    });
    expect(early.audits[0]).toMatchObject({ replayed: 0, parked: 0 });
    expect(Number(early.audits[0]?.['young'])).toBeGreaterThanOrEqual(6);

    const later = await runStep(message('dlq_replay', runId()), {
      persistSink: asQueue(persist),
      bucket,
      now: () => Date.now() + 2 * 60 * MINUTE,
    });

    expect(later.audits[0]).toMatchObject({
      replayed: 2,
      kept: 2,
      parked: 2,
      failed: 0,
      done: true,
    });
    expect(persist.sent).toEqual([
      { ...resolver, replayCount: 1 },
      { ...budget, replayCount: 1 },
    ]);
    expect(await bucket.get(`dlq/persist/${id}-a.json`)).toBeNull();
    expect(await bucket.get(`dlq/persist/${id}-b.json`)).toBeNull();
    expect(await bucket.get(`dlq/persist/${id}-d.json`)).toBeNull();
    expect(await bucket.get(`dlq/persist-parked/${id}-b.json`)).not.toBeNull();
    expect(await bucket.get(`dlq/persist-parked/${id}-c.json`)).not.toBeNull();
    // The tracker re-sends its own copy on its doubling spacing: its archives stay as the record,
    // never replayed and never parked, however often the row dead-lettered.
    expect(await bucket.get(`dlq/persist/${id}-e.json`)).not.toBeNull();
    expect(await bucket.get(`dlq/persist/${id}-f.json`)).not.toBeNull();
    expect(await bucket.get(`dlq/persist-parked/${id}-f.json`)).toBeNull();
    expect(await bucket.get(`dlq/notify/${id}.json`)).not.toBeNull();

    // The next night: the tracker archives are still kept, nothing is sent again.
    const again = await runStep(message('dlq_replay', runId()), {
      persistSink: asQueue(persist),
      bucket,
      now: () => Date.now() + 26 * 60 * MINUTE,
    });
    expect(again.audits[0]).toMatchObject({ replayed: 0, kept: 2, parked: 0 });
    expect(persist.sent).toHaveLength(2);
  });

  it('keeps the archive when the send fails, so the next night tries again', async () => {
    const bucket = env.PRIVATE_BUCKET;
    const key = `dlq/persist/${crypto.randomUUID()}.json`;
    await bucket.put(
      key,
      JSON.stringify({
        body: { kind: 'provider_call', origin: 'designator_resolver:AA2-2100-01-01@1', seq: 1 },
      }),
    );
    const failing = { send: () => Promise.reject(new Error('queue down')) };

    const result = await runStep(message('dlq_replay', runId()), {
      persistSink: failing,
      bucket,
      now: () => Date.now() + 2 * 60 * MINUTE,
    });

    expect(Number(result.audits[0]?.['failed'])).toBeGreaterThanOrEqual(1);
    expect(await bucket.get(key)).not.toBeNull();
  });
});

describe('housekeeping step 8: session_tombstones', () => {
  it('writes the missing KV tombstone of every unexpired deleted session, and only once', async () => {
    const subject = crypto.randomUUID();
    const live = `session:${'A'.repeat(21)}${crypto.randomUUID().replaceAll('-', '').slice(0, 22)}`;
    const expired = `session:${'B'.repeat(21)}${crypto.randomUUID().replaceAll('-', '').slice(0, 22)}`;
    await db().execute(sql`
      insert into deleted_subjects (subject_id, reason, provider_subject_hash, expires_at)
      values (${subject}::uuid, 'user_request', ${live}, now() + interval '31 days'),
             (${subject}::uuid, 'user_request', ${expired}, now() - interval '1 minute')
    `);

    // One page covers every session row the parallel files' deletions left (the step is global).
    const first = await runStep(message('session_tombstones', runId()), { pageSize: 5_000 });

    expect(await env.CACHE.get(sessionTombstoneKey(live))).toBe('1');
    expect(await env.CACHE.get(sessionTombstoneKey(expired))).toBeNull();
    expect(Number(first.audits[0]?.['written'])).toBeGreaterThanOrEqual(1);
    expect(first.audits[0]?.['done']).toBe(true);

    const second = await runStep(message('session_tombstones', runId()), { pageSize: 5_000 });
    expect(Number(second.audits[0]?.['present'])).toBeGreaterThanOrEqual(1);
  });
});

describe('housekeeping step 9: kek_rewrap', () => {
  function kek(): string {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  }

  it('re-wraps every DEK under an older KEK to the current one, ciphertexts unchanged', async () => {
    const v1 = testEnv.TOKEN_KEK_V1 ?? '';
    const v2 = kek();
    const user = await insertUser();
    const before = new Envelope(db(), createWorkersSecretKeyProvider({ TOKEN_KEK_V1: v1 }));
    const sealed = await before.encrypt(user, 'accounts', 'refresh_token', user, 'secret value');
    const version = async () =>
      count(sql`select kek_version::int as n from user_keys where user_id = ${user}::uuid`);
    expect(await version()).toBe(1);

    // Scoped to this user: the step is global, and every other file's Worker holds only V1.
    const rotated = envWith({ TOKEN_KEK_V2: v2 });
    const result = await runStep(
      message('kek_rewrap', runId()),
      { kekScope: eq(userKeys.userId, user) },
      rotated,
    );

    expect(await version()).toBe(2);
    expect(result.audits[0]).toMatchObject({
      current_version: 2,
      rewrapped: 1,
      failed: 0,
      done: true,
    });
    const after = new Envelope(
      db(),
      createWorkersSecretKeyProvider({ TOKEN_KEK_V1: v1, TOKEN_KEK_V2: v2 }),
    );
    const plain = await after.decrypt(user, 'accounts', 'refresh_token', user, sealed);
    expect(new TextDecoder().decode(plain)).toBe('secret value');
  });

  async function wrappedRow(user: string) {
    const [row] = await db().execute<{ version: number; wrapped: string }>(sql`
      select kek_version as version, encode(wrapped_dek, 'hex') as wrapped
      from user_keys where user_id = ${user}::uuid
    `);
    return row;
  }

  it('proves the new wrap before writing it: a wrap that does not prove leaves the row untouched', async () => {
    const v1 = testEnv.TOKEN_KEK_V1 ?? '';
    const user = await insertUser();
    await new Envelope(db(), createWorkersSecretKeyProvider({ TOKEN_KEK_V1: v1 })).dekFor(user);
    const before = await wrappedRow(user);
    const real = createWorkersSecretKeyProvider({ TOKEN_KEK_V1: v1 });
    // A target KEK that can wrap but not unwrap: the proof (unwrap with the target) fails.
    const wrapOnly = await crypto.subtle.importKey(
      'raw',
      crypto.getRandomValues(new Uint8Array(32)),
      { name: 'AES-KW' },
      false,
      ['wrapKey'],
    );
    const keys: KeyProvider = {
      currentVersion: 2,
      getKek: (version) => (version === 2 ? Promise.resolve(wrapOnly) : real.getKek(version)),
    };

    await expect(new Envelope(db(), keys).rotateKek(user, 2)).rejects.toThrow();

    expect(await wrappedRow(user)).toEqual(before);
  });

  it('loses to a concurrent rotation: the conditional UPDATE writes nothing over a newer wrap', async () => {
    const v1 = testEnv.TOKEN_KEK_V1 ?? '';
    const v2 = kek();
    const v3 = kek();
    const user = await insertUser();
    const sealed = await new Envelope(
      db(),
      createWorkersSecretKeyProvider({ TOKEN_KEK_V1: v1 }),
    ).encrypt(user, 'accounts', 'refresh_token', user, 'kept secret');
    const racer = new Envelope(
      db(),
      createWorkersSecretKeyProvider({ TOKEN_KEK_V1: v1, TOKEN_KEK_V2: v2 }),
    );
    const base = createWorkersSecretKeyProvider({ TOKEN_KEK_V1: v1, TOKEN_KEK_V3: v3 });
    let raced = false;
    // The racer (a redelivered message, a second run) moves the row to V2 after this rotation
    // read it at V1 and before it writes.
    const keys: KeyProvider = {
      currentVersion: 3,
      getKek: async (version) => {
        if (version === 3 && !raced) {
          raced = true;
          expect(await racer.rotateKek(user, 2)).toBe('rotated');
        }
        return base.getKek(version);
      },
    };

    expect(await new Envelope(db(), keys).rotateKek(user, 3)).toBe('superseded');

    expect((await wrappedRow(user))?.version).toBe(2);
    const plain = await racer.decrypt(user, 'accounts', 'refresh_token', user, sealed);
    expect(new TextDecoder().decode(plain)).toBe('kept secret');
    // Replayed once the race is over: the row is simply rotated from V2 to V3.
    const both = createWorkersSecretKeyProvider({
      TOKEN_KEK_V1: v1,
      TOKEN_KEK_V2: v2,
      TOKEN_KEK_V3: v3,
    });
    expect(await new Envelope(db(), both).rotateKek(user, 3)).toBe('rotated');
    expect(await new Envelope(db(), both).rotateKek(user, 3)).toBe('current');
  });

  it('fails loudly on a row under a KEK the Worker no longer holds, and leaves it for a person', async () => {
    const user = await insertUser();
    const junk = crypto.getRandomValues(new Uint8Array(40));
    await db().execute(sql`
      insert into user_keys (user_id, wrapped_dek, kek_version)
      values (${user}::uuid, ${`\\x${[...junk].map((b) => b.toString(16).padStart(2, '0')).join('')}`}::bytea, 7)
    `);
    const before = await wrappedRow(user);
    await expect(
      new Envelope(db(), createWorkersSecretKeyProvider(readKekSecrets(testEnv))).rotateKek(
        user,
        1,
      ),
    ).rejects.toBeInstanceOf(UnknownKeyVersionError);

    const result = await runStep(message('kek_rewrap', runId()), {
      kekScope: eq(userKeys.userId, user),
    });

    expect(result.audits[0]).toMatchObject({ rewrapped: 0, superseded: 0, failed: 1, done: true });
    expect(result.acked).toHaveLength(1);
    expect(await wrappedRow(user)).toEqual(before);
  });

  it('is a no-op for a row already under the current KEK', async () => {
    const user = await insertUser();
    await new Envelope(db(), createWorkersSecretKeyProvider(readKekSecrets(testEnv))).dekFor(user);

    const result = await runStep(message('kek_rewrap', runId()), {
      kekScope: eq(userKeys.userId, user),
    });

    expect(result.audits[0]).toMatchObject({
      current_version: 1,
      rewrapped: 0,
      failed: 0,
      done: true,
    });
  });
});

describe('the Analytics Engine rollup (ae_rollup)', () => {
  const ACCOUNT = 'fedcba9876543210fedcba9876543210';

  function sqlApi(calls: string) {
    const statements: string[] = [];
    const fetchFake = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/analytics_engine/sql`,
      );
      const statement = typeof init?.body === 'string' ? init.body : '';
      statements.push(statement);
      const data = statement.includes("index1 = 'aerodatabox'")
        ? [
            {
              operation: 'flight_status',
              result: 'ok',
              calls,
              cost_units: 2 * Number(calls),
              cost_usd_micros: 500 * Number(calls),
            },
            { operation: 'budget_daily', result: 'ok', calls: '99' },
            { operation: 'flight_status', result: 'weird', calls: '1' },
          ]
        : [];
      return Promise.resolve(Response.json({ meta: [], data, rows: data.length }));
    }) as typeof fetch;
    return { fetch: fetchFake, statements };
  }

  it('replaces the per-operation rows of a day from SUM(_sample_interval) and leaves the ProviderBudget row alone', async () => {
    const day = `2001-0${String(1 + Math.floor(Math.random() * 9))}-${String(
      10 + Math.floor(Math.random() * 18),
    )}`;
    await db().execute(sql`
      insert into provider_call_daily (day, provider, operation, result, calls, cost_units)
      values (${day}::date, 'aerodatabox', 'budget_daily', 'ok', 7, 14)
      on conflict (day, provider, operation, result) do update set calls = 7, cost_units = 14
    `);
    const environment = envWith({ CF_ACCOUNT_ID: ACCOUNT, CF_API_TOKEN: 'test-token' });
    const first = sqlApi('10');

    const result = await runStep(
      message(AE_ROLLUP_STEP, runId(), { day }),
      { fetch: first.fetch },
      environment,
    );

    expect(first.statements.length).toBeGreaterThanOrEqual(2);
    const adb = first.statements.find((statement) => statement.includes("index1 = 'aerodatabox'"));
    expect(adb).toContain('SUM(_sample_interval) AS calls');
    expect(adb).toContain('FROM planeahead_provider_calls_local');
    expect(adb).toContain("blob5 = 'test'");
    expect(adb).toContain(`toDateTime('${day} 00:00:00')`);
    // The ledger holds nothing for a day in 2001, and the rollup records that count (0) on its
    // own row; the ProviderBudget's row never carries one (ruling AB3).
    expect(result.audits[0]).toMatchObject({
      day,
      rows: 1,
      providers: { aerodatabox: { rows: 1, calls: 10, skipped: 2, ledger_calls: 0 } },
    });
    const rows = () =>
      db().execute<{
        operation: string;
        result: string;
        calls: number;
        cost_units: string;
        ledger_calls: number | null;
      }>(sql`
        select operation, result, calls, cost_units::text as cost_units, ledger_calls
        from provider_call_daily
        where day = ${day}::date and provider = 'aerodatabox' order by operation
      `);
    expect(await rows()).toEqual([
      { operation: 'budget_daily', result: 'ok', calls: 7, cost_units: '14', ledger_calls: null },
      { operation: 'flight_status', result: 'ok', calls: 10, cost_units: '20', ledger_calls: 0 },
    ]);

    // A second run replaces, never adds (at-least-once delivery and the nightly two-day pass).
    const again = sqlApi('12');
    await runStep(message(AE_ROLLUP_STEP, runId(), { day }), { fetch: again.fetch }, environment);
    expect((await rows())[1]).toEqual({
      operation: 'flight_status',
      result: 'ok',
      calls: 12,
      cost_units: '24',
      ledger_calls: 0,
    });
  });

  it('records a skipped run, never a retry, without the Cloudflare API token', async () => {
    const run = runId();
    const result = await runStep(message(AE_ROLLUP_STEP, run, { day: '2001-01-01' }));

    expect(result.acked).toHaveLength(1);
    expect(result.audits[0]).toMatchObject({
      day: '2001-01-01',
      skipped: 'cloudflare_api_not_configured',
      done: true,
    });
  });
});

describe('the housekeeping consumer', () => {
  it('acknowledges a message it cannot read and writes nothing', async () => {
    const run = runId();
    const result = await runStep({ kind: 'nonsense', runId: run, step: 'nope' });

    expect(result.acked).toHaveLength(1);
    expect(result.audits).toEqual([]);
  });
});
