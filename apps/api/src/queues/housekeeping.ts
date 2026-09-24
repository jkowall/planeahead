/**
 * `housekeeping` queue consumer (increment 12, rulings W1 to W3).
 *
 * The `0 3 * * *` cron never does the work: it plans, one message per step (and one per day for
 * the Analytics Engine rollup), and this consumer runs each message within a wall budget. A step
 * that has more to do than one message's budget enqueues a continuation of itself (the same step,
 * the next page, a cursor), so no message holds a connection or a statement for long, and the
 * queue's retries and dead letter queue cover every page on its own. The consumer is declared with
 * `max_batch_size: 1` and `max_concurrency: 1` in every environment (wrangler.jsonc): the steps run
 * one at a time on one Neon connection. NOT in any guaranteed order: Queues delivery is best-effort
 * ordered, and retries and continuations reorder messages. The steps are independent and
 * order-insensitive (none reads what another writes the same night: step 3 reads rollups at least
 * 90 days old, and anything step 6 leaves for step 5 is repaired the next night), so the order of
 * ruling W2, which the cron keeps when it sends them, only documents them; nothing chains
 * (ruling AA17). A step that ever needs another's result must enqueue it from its own last
 * message instead of relying on the send order.
 *
 * Every step is idempotent and re-entrant (a redelivered message, or a continuation of a page that
 * already ran, finds nothing left to do and says so), and every message writes ONE `audit_log`
 * row, action `housekeeping.{step}`, actor `system`, with the step's counts, the page, the run id
 * (the cron's scheduled time) and whether the step is done. The steps, as the ruling lists them:
 *
 *   1. `idempotency_keys`: rows whose `expires_at` passed (a stored response 24 h after it was
 *      written, or a dead in-flight lease).
 *   2. `sync_purge`: the change tables below one xid horizon H, recorded in `sync_horizon`, in one
 *      transaction per step, paged at `SYNC_PURGE_ROWS_PER_STEP` rows so no statement nears the
 *      role's 10 s `statement_timeout` (src/lib/sync-purge.ts; ADR 0012 item 6; ruling AA15).
 *   3. `provider_calls`: whole UTC days older than 90 days, per provider, only when the day's
 *      per-operation `provider_call_daily` rows (the rollup) sum to more than 0 and lie within
 *      20 percent of the day's `count(*)` (ruling AA13), so no call leaves the exact ledger before
 *      a plausible durable series holds it; the other days are kept and counted.
 *   4. `retention`: `notifications` over 90 days, `data_export_jobs` over 7, expired
 *      `deleted_subjects`, `rate_limits` rows idle past the longest limiter window, expired
 *      `verifications`; and the Phase 0 tables the schema review gives a retention that have a
 *      writer (`flight_events` over 90 days, expired `sessions`, day-window `usage_counters` over
 *      30 days, sync-entity tombstones over 30 days).
 *   5. `usage_counters`: the active-subscription and live-tracked counters repaired against
 *      `flight_subscriptions`, the drift logged per user (src/lib/counter-reconcile.ts).
 *   6. `tracker_subscribers`: each active tracker's list made to follow Postgres through the new
 *      `listSubscribers` RPC, then the merged anonymous users deleted
 *      (src/lib/subscriber-reconcile.ts).
 *   7. `dlq_replay`: `dlq/persist/` archives older than an hour of the senders that keep no other
 *      copy (the DesignatorResolver, the ProviderBudget) replayed onto the persist queue and
 *      deleted once sent; a FlightTracker's archive stays as the record, because the tracker
 *      re-sends its own copy (src/lib/dlq-replay.ts; ADR 0011; ruling AA16).
 *   8. `session_tombstones`: a KV tombstone for every unexpired session hash in `deleted_subjects`
 *      that lacks one (src/lib/session-tombstone.ts; the cookie cache re-enabled for GETs).
 *   9. `kek_rewrap`: every `user_keys` row wrapped under a KEK older than the current one is
 *      re-wrapped under it (`Envelope.rotateKek`: the new wrap proven by unwrapping it before it
 *      is written, the UPDATE conditional on the version read; ciphertexts never change), the job
 *      the KEK rotation runbook relies on (docs/security/threat-model.md section 8). A no-op while
 *      one KEK is configured.
 *
 * And `ae_rollup` (ruling W3): one UTC day of `PROVIDER_CALLS` per message, per provider, into
 * `provider_call_daily` (src/lib/provider-rollup.ts). Without `CF_ACCOUNT_ID` and `CF_API_TOKEN`
 * the message is acknowledged with a `skipped` audit row, never retried.
 */

import { and, gt, like, ne, sql, type SQL } from 'drizzle-orm';
import { auditLog, deletedSubjects, openDb, userKeys, type Db } from '@planeahead/db';
import { IsoDateSchema, type FlightKey } from '@planeahead/shared';
import * as z from 'zod';
import { RATE_LIMIT_RULES } from '../auth/create-auth';
import { Envelope } from '../crypto/envelope';
import { createWorkersSecretKeyProvider, readKekSecrets } from '../crypto/key-provider';
import { environmentName } from '../env';
import { WallBudget, deleteInBatches } from '../lib/batched-delete';
import { EPOCH_WINDOW } from '../lib/caps';
import { cloudflareApiAccess } from '../lib/cloudflare-api';
import { reconcileUsageCounters } from '../lib/counter-reconcile';
import { replayDeadLetteredPersist } from '../lib/dlq-replay';
import {
  BUDGET_DAILY_OPERATION_PATTERN,
  ROLLUP_PROVIDERS,
  isPlausibleRollup,
  rollupProviderDay,
} from '../lib/provider-rollup';
import {
  lookupSessionTombstone,
  tombstoneTtlSeconds,
  sessionTombstoneKey,
} from '../lib/session-tombstone';
import { reconcileTrackerSubscribers } from '../lib/subscriber-reconcile';
import {
  SYNC_PURGE_ROWS_PER_STEP,
  SYNC_PURGE_TABLES,
  purgeSyncChanges,
  type SyncPurgeTables,
} from '../lib/sync-purge';
import { TRACKER_LOCATION_HINT, type SubscriberListingTracker } from '../lib/trackers';
import { errorFields, type Logger } from '../observability/log';
import { consumeBatch } from './consume';
import type { QueueContext } from './index';

/** The nightly steps, in the order the cron sends them (ruling W2; an order, not a dependency). */
export const HOUSEKEEPING_STEPS = [
  'idempotency_keys',
  'sync_purge',
  'provider_calls',
  'retention',
  'usage_counters',
  'tracker_subscribers',
  'dlq_replay',
  'session_tombstones',
  'kek_rewrap',
] as const;
export type HousekeepingStep = (typeof HOUSEKEEPING_STEPS)[number];

/** The Analytics Engine rollup's step name; one message per UTC day. */
export const AE_ROLLUP_STEP = 'ae_rollup' as const;

export const HousekeepingMessageV1 = z.looseObject({
  kind: z.literal('housekeeping'),
  step: z.enum([...HOUSEKEEPING_STEPS, AE_ROLLUP_STEP]),
  /** The cron's scheduled time, ISO-8601: every message and audit row of one night shares it. */
  runId: z.string().min(1).max(64),
  page: z.int().nonnegative().default(0),
  /** Where a continuation resumes (a step-specific cursor); null for a step's first page. */
  cursor: z.string().max(2_048).nullable().default(null),
  /** The UTC day an `ae_rollup` message rolls up. */
  day: IsoDateSchema.optional(),
});
export type HousekeepingMessageV1 = z.input<typeof HousekeepingMessageV1>;

/** One message's work, in wall-clock milliseconds (a queue invocation allows 15 minutes). */
export const HOUSEKEEPING_WALL_BUDGET_MS = 30_000;

/** Retention windows (docs/schema-review.md section 5; plan section 19 item 10). */
export const RETENTION = Object.freeze({
  providerCallsDays: 90,
  notificationsDays: 90,
  dataExportJobsDays: 7,
  flightEventsDays: 90,
  usageCounterWindowsDays: 30,
  tombstonesDays: 30,
});

/**
 * A Better Auth `rate_limits` row counts requests inside ONE window; once its last request is
 * older than the longest window any rule uses, the next request starts a fresh count and the row
 * is dead weight. Better Auth's own defaults are 10 s (60 s for its special rules); ours are in
 * `RATE_LIMIT_RULES`.
 */
export const RATE_LIMIT_MAX_WINDOW_MS =
  Math.max(60, ...Object.values(RATE_LIMIT_RULES).map((rule) => rule.window)) * 1_000;

/** The sync entities whose tombstones are purged (docs/schema-review.md, "tombstoned, 30 d"). */
const TOMBSTONED_TABLES = [
  'flight_subscriptions',
  'trips',
  'trip_members',
  'user_preferences',
  'notification_preferences',
  'logbook_entries',
] as const;

export interface HousekeepingDeps {
  readonly db?: Db | undefined;
  readonly now?: (() => number) | undefined;
  /** Where continuations go; the default is `HOUSEKEEPING_QUEUE`. */
  readonly sink?: Pick<Queue, 'send'> | undefined;
  /** Where the DLQ replay sends; the default is `PERSIST_QUEUE`. */
  readonly persistSink?: Pick<Queue, 'send'> | undefined;
  readonly bucket?: Pick<R2Bucket, 'list' | 'get' | 'put' | 'delete'> | undefined;
  readonly kv?: Pick<KVNamespace, 'get' | 'put'> | undefined;
  readonly trackerFor?: ((flightKey: FlightKey) => SubscriberListingTracker) | undefined;
  /** Test seam: restricts step 6 to the suite's own instances. */
  readonly instanceScope?: SQL | undefined;
  /** Test seam: step 2 against the suite's own copies of the change tables and the horizon. */
  readonly syncTables?: SyncPurgeTables | undefined;
  /** Test seam: step 2's rows per step (`SYNC_PURGE_ROWS_PER_STEP` by default). */
  readonly syncPurgeRowsPerStep?: number | undefined;
  /** Test seam: restricts step 9 to the suite's own `user_keys` rows. */
  readonly kekScope?: SQL | undefined;
  /** The Cloudflare API's fetch (the suite answers the SQL API with it). */
  readonly fetch?: typeof fetch | undefined;
  readonly wallBudgetMs?: number | undefined;
  readonly pageSize?: number | undefined;
  readonly deleteBatch?: number | undefined;
}

/** What one message did: its counts, and where a continuation starts (null when done). */
export interface StepOutcome {
  readonly counts: Readonly<Record<string, unknown>>;
  readonly next: string | null;
}

interface StepContext {
  readonly env: QueueContext['env'];
  readonly db: Db;
  readonly log: Logger;
  readonly now: () => number;
  readonly budget: WallBudget;
  readonly deps: HousekeepingDeps;
  readonly message: z.output<typeof HousekeepingMessageV1>;
  /** The cursor, `''` read as "from the start" (a continuation cut before its first unit). */
  readonly cursor: string | null;
}

function olderThanDays(column: SQL, days: number): SQL {
  return sql`${column} < now() - make_interval(days => ${days})`;
}

async function stepIdempotencyKeys(ctx: StepContext): Promise<StepOutcome> {
  const result = await deleteInBatches(
    ctx.db,
    'idempotency_keys',
    sql`expires_at < now()`,
    ctx.budget,
    ctx.deps.deleteBatch,
  );
  return { counts: { deleted: result.deleted }, next: result.done ? null : 'more' };
}

async function stepSyncPurge(ctx: StepContext): Promise<StepOutcome> {
  const rowsPerStep = ctx.deps.syncPurgeRowsPerStep ?? SYNC_PURGE_ROWS_PER_STEP;
  const result = await purgeSyncChanges(ctx.db, ctx.deps.syncTables ?? SYNC_PURGE_TABLES, {
    rowsPerStep,
  });
  return {
    counts: {
      horizon: result.horizon,
      previous_horizon: result.previousHorizon,
      user_changes_deleted: result.userChangesDeleted,
      flight_changes_deleted: result.flightChangesDeleted,
      xmin: result.xmin,
      rows_per_step: rowsPerStep,
    },
    // The continuation recomputes from the recorded horizon; the cursor only names it for the log.
    next: result.done ? null : (result.horizon ?? ''),
  };
}

/** A (UTC day, provider) pair of `provider_calls`, as step 3 walks them. */
interface LedgerDay {
  readonly day: string;
  readonly provider: string;
  readonly ledger: number;
  readonly rolledUp: number | null;
}

/**
 * Step 3's cursor: `approved:{day}|{provider}` resumes the deletion of a pair already judged
 * plausible (its `count(*)` has shrunk since, so it is not judged again), `after:{day}|{provider}`
 * resumes with the pairs after it.
 */
function parseLedgerCursor(
  cursor: string | null,
): { readonly mode: 'approved' | 'after'; readonly day: string; readonly provider: string } | null {
  const match =
    cursor === null ? null : /^(approved|after):(\d{4}-\d{2}-\d{2})\|([a-z0-9_]+)$/.exec(cursor);
  const mode = match?.[1];
  const day = match?.[2];
  const provider = match?.[3];
  if ((mode !== 'approved' && mode !== 'after') || day === undefined || provider === undefined) {
    return null;
  }
  return { mode, day, provider };
}

async function deleteLedgerDay(ctx: StepContext, pair: { day: string; provider: string }) {
  return deleteInBatches(
    ctx.db,
    'provider_calls',
    sql`provider = ${pair.provider}
      and created_at >= (${pair.day}::date)::timestamp at time zone 'UTC'
      and created_at < (${pair.day}::date + 1)::timestamp at time zone 'UTC'`,
    ctx.budget,
    ctx.deps.deleteBatch,
  );
}

/**
 * Step 3 (ruling AA13, amending spec 12's one precondition): `provider_calls` is the only exact
 * copy of the provider ledger, so a whole UTC day older than `RETENTION.providerCallsDays` is
 * deleted per provider only when that day's non-budget `provider_call_daily` rows exist, sum to
 * more than 0 and lie within `ROLLUP_PLAUSIBILITY_TOLERANCE` of the day's `count(*)`
 * (`isPlausibleRollup`; Analytics Engine sums are sampled estimates). Any other day is kept and
 * counted (`days_without_rollup`: no row; `days_without_plausible_rollup`: a zero or out-of-band
 * row, each logged with both figures). Whole days only, so a day is never judged after part of it
 * went; a pair judged plausible carries its approval in the continuation's cursor.
 */
async function stepProviderCalls(ctx: StepContext): Promise<StepOutcome> {
  const resume = parseLedgerCursor(ctx.cursor);
  const counts = {
    deleted: 0,
    days_purged: 0,
    days_without_rollup: 0,
    days_without_plausible_rollup: 0,
  };
  if (resume?.mode === 'approved') {
    const result = await deleteLedgerDay(ctx, resume);
    counts.deleted += result.deleted;
    if (!result.done) {
      return { counts, next: `approved:${resume.day}|${resume.provider}` };
    }
    counts.days_purged += 1;
  }
  const after =
    resume === null
      ? sql`true`
      : sql`(l.day, l.provider) > (${resume.day}::date, ${resume.provider}::text)`;
  const pairs = await ctx.db.execute<{
    day: string;
    provider: string;
    ledger: number;
    rolled_up: string | null;
  }>(sql`
    with ledger as (
      select (created_at at time zone 'UTC')::date as day, provider, count(*)::int as ledger
      from provider_calls
      where created_at <
        ((now() at time zone 'UTC')::date - ${RETENTION.providerCallsDays}::int)::timestamp
          at time zone 'UTC'
      group by 1, 2
    )
    select l.day::text as day, l.provider, l.ledger,
      (select sum(d.calls)::text from provider_call_daily d
       where d.day = l.day and d.provider = l.provider
         and d.operation not like ${BUDGET_DAILY_OPERATION_PATTERN}) as rolled_up
    from ledger l
    where ${after}
    order by l.day, l.provider
  `);
  const days: LedgerDay[] = pairs.map((row) => ({
    day: row.day,
    provider: row.provider,
    ledger: row.ledger,
    rolledUp: row.rolled_up === null ? null : Number(row.rolled_up),
  }));
  for (const [index, pair] of days.entries()) {
    if (pair.rolledUp === null) {
      counts.days_without_rollup += 1;
    } else if (!isPlausibleRollup(pair.rolledUp, pair.ledger)) {
      counts.days_without_plausible_rollup += 1;
      ctx.log.warn('provider_calls_rollup_implausible', {
        day: pair.day,
        provider: pair.provider,
        rolled_up_calls: pair.rolledUp,
        ledger_calls: pair.ledger,
      });
    } else {
      const result = await deleteLedgerDay(ctx, pair);
      counts.deleted += result.deleted;
      if (!result.done) {
        return { counts, next: `approved:${pair.day}|${pair.provider}` };
      }
      counts.days_purged += 1;
    }
    if (ctx.budget.spent && index + 1 < days.length) {
      return { counts, next: `after:${pair.day}|${pair.provider}` };
    }
  }
  return { counts, next: null };
}

interface RetentionPurge {
  readonly name: string;
  readonly table: string;
  readonly where: SQL;
}

function retentionPurges(nowMs: number): RetentionPurge[] {
  return [
    {
      name: 'notifications',
      table: 'notifications',
      where: olderThanDays(sql`created_at`, RETENTION.notificationsDays),
    },
    {
      name: 'data_export_jobs',
      table: 'data_export_jobs',
      where: olderThanDays(sql`requested_at`, RETENTION.dataExportJobsDays),
    },
    { name: 'deleted_subjects', table: 'deleted_subjects', where: sql`expires_at <= now()` },
    {
      name: 'rate_limits',
      table: 'rate_limits',
      where: sql`last_request < ${nowMs - RATE_LIMIT_MAX_WINDOW_MS}`,
    },
    { name: 'verifications', table: 'verifications', where: sql`expires_at < now()` },
    {
      name: 'flight_events',
      table: 'flight_events',
      where: olderThanDays(sql`created_at`, RETENTION.flightEventsDays),
    },
    { name: 'sessions', table: 'sessions', where: sql`expires_at < now()` },
    {
      name: 'usage_counter_windows',
      table: 'usage_counters',
      where: sql`window_start <> ${EPOCH_WINDOW}::timestamptz
        and ${olderThanDays(sql`window_start`, RETENTION.usageCounterWindowsDays)}`,
    },
    ...TOMBSTONED_TABLES.map((table) => ({
      name: `${table}_tombstones`,
      table,
      where: olderThanDays(sql`deleted_at`, RETENTION.tombstonesDays),
    })),
  ];
}

async function stepRetention(ctx: StepContext): Promise<StepOutcome> {
  const purges = retentionPurges(ctx.now());
  const start = ctx.cursor === null ? 0 : Math.max(0, Number.parseInt(ctx.cursor, 10) || 0);
  const counts: Record<string, number> = {};
  for (let index = start; index < purges.length; index += 1) {
    const purge = purges[index];
    if (purge === undefined) {
      break;
    }
    const result = await deleteInBatches(
      ctx.db,
      purge.table,
      purge.where,
      ctx.budget,
      ctx.deps.deleteBatch,
    );
    counts[purge.name] = result.deleted;
    if (!result.done || (ctx.budget.spent && index + 1 < purges.length)) {
      // Resume at this purge (unfinished) or the next one (the budget ran out between them).
      return { counts, next: String(result.done ? index + 1 : index) };
    }
  }
  return { counts, next: null };
}

async function stepUsageCounters(ctx: StepContext): Promise<StepOutcome> {
  const result = await reconcileUsageCounters(ctx.db, ctx.log);
  return {
    counts: {
      repaired: result.repaired,
      created: result.created,
      orphans_deleted: result.orphansDeleted,
      drift: result.drift.slice(0, 50),
    },
    next: null,
  };
}

async function stepTrackerSubscribers(ctx: StepContext): Promise<StepOutcome> {
  const env = ctx.env;
  const result = await reconcileTrackerSubscribers(
    {
      db: ctx.db,
      trackerFor:
        ctx.deps.trackerFor ??
        ((flightKey) =>
          env.FLIGHT_TRACKER.getByName(flightKey, { locationHint: TRACKER_LOCATION_HINT })),
      log: ctx.log,
      now: ctx.now,
      budget: ctx.budget,
      pageSize: ctx.deps.pageSize,
      instanceScope: ctx.deps.instanceScope,
    },
    ctx.cursor,
  );
  return {
    counts: {
      instances: result.counts.instances,
      kept: result.counts.kept,
      unsubscribed: result.counts.unsubscribed,
      repointed: result.counts.repointed,
      resubscribed: result.counts.resubscribed,
      young: result.counts.young,
      skipped_trackers: result.counts.skippedTrackers,
      failed_calls: result.counts.failedCalls,
      anonymous_strays_unsubscribed: result.counts.anonymousStraysUnsubscribed,
      anonymous_users_deleted: result.counts.anonymousUsersDeleted,
      ...(result.anonymousUserIds.length === 0
        ? {}
        : { anonymous_user_ids: result.anonymousUserIds }),
    },
    next: result.next,
  };
}

async function stepDlqReplay(ctx: StepContext): Promise<StepOutcome> {
  const result = await replayDeadLetteredPersist(
    {
      bucket: ctx.deps.bucket ?? ctx.env.PRIVATE_BUCKET,
      sink: ctx.deps.persistSink ?? ctx.env.PERSIST_QUEUE,
      log: ctx.log,
      now: ctx.now,
      budget: ctx.budget,
      pageSize: ctx.deps.pageSize,
    },
    ctx.cursor,
  );
  return { counts: { ...result.counts }, next: result.next };
}

/** Rows of `deleted_subjects` per page of step 8. */
export const TOMBSTONE_PAGE = 200;

async function stepSessionTombstones(ctx: StepContext): Promise<StepOutcome> {
  const kv = ctx.deps.kv ?? ctx.env.CACHE;
  const pageSize = ctx.deps.pageSize ?? TOMBSTONE_PAGE;
  const conditions = [
    like(deletedSubjects.providerSubjectHash, 'session:%'),
    sql`${deletedSubjects.expiresAt} > now()`,
  ];
  if (ctx.cursor !== null && ctx.cursor !== '') {
    conditions.push(sql`${deletedSubjects.id} > ${ctx.cursor}::uuid`);
  }
  const rows = await ctx.db
    .select({
      id: deletedSubjects.id,
      hash: deletedSubjects.providerSubjectHash,
      expiresAt: deletedSubjects.expiresAt,
    })
    .from(deletedSubjects)
    .where(and(...conditions))
    .orderBy(deletedSubjects.id)
    .limit(pageSize);
  let present = 0;
  let written = 0;
  let failed = 0;
  let lastId: string | null = null;
  for (const row of rows) {
    if (ctx.budget.spent) {
      break;
    }
    lastId = row.id;
    const hash = row.hash ?? '';
    const found = await lookupSessionTombstone(kv, hash, ctx.log);
    if (found === 'present') {
      present += 1;
      continue;
    }
    try {
      await kv.put(sessionTombstoneKey(hash), '1', {
        expirationTtl: tombstoneTtlSeconds(Date.parse(row.expiresAt), ctx.now()),
      });
      written += 1;
    } catch (error) {
      failed += 1;
      ctx.log.warn('session_tombstone_write_failed', errorFields(error));
    }
  }
  const processed = present + written + failed;
  const more = processed < rows.length || rows.length === pageSize;
  return {
    counts: { checked: processed, present, written, failed },
    next: more ? (lastId ?? ctx.cursor ?? '') : null,
  };
}

/** `user_keys` rows per page of step 9. */
export const KEK_REWRAP_PAGE = 100;

async function stepKekRewrap(ctx: StepContext): Promise<StepOutcome> {
  let keys;
  try {
    keys = createWorkersSecretKeyProvider(readKekSecrets(ctx.env));
  } catch (error) {
    ctx.log.error('kek_rewrap_not_configured', errorFields(error));
    return { counts: { skipped: 'kek_not_configured' }, next: null };
  }
  const current = keys.currentVersion;
  const pageSize = ctx.deps.pageSize ?? KEK_REWRAP_PAGE;
  const conditions: SQL[] = [ne(userKeys.kekVersion, current)];
  if (ctx.cursor !== null) {
    conditions.push(gt(userKeys.userId, ctx.cursor));
  }
  if (ctx.deps.kekScope !== undefined) {
    conditions.push(ctx.deps.kekScope);
  }
  const rows = await ctx.db
    .select({ userId: userKeys.userId })
    .from(userKeys)
    .where(and(...conditions))
    .orderBy(userKeys.userId)
    .limit(pageSize);
  const envelope = new Envelope(ctx.db, keys);
  let rewrapped = 0;
  let superseded = 0;
  let failed = 0;
  let processed = 0;
  let lastId: string | null = null;
  for (const row of rows) {
    if (ctx.budget.spent) {
      break;
    }
    lastId = row.userId;
    processed += 1;
    try {
      // Proven before written, and conditional on the version read (ruling AA1): a redelivery or
      // a concurrent run finds `current` or `superseded`, never overwrites a newer wrap.
      const outcome = await envelope.rotateKek(row.userId, current);
      if (outcome === 'rotated') {
        rewrapped += 1;
      } else if (outcome === 'superseded') {
        superseded += 1;
      }
    } catch (error) {
      // A row under a KEK this Worker no longer holds, or a wrap that did not prove: loud, the
      // row untouched, and left for a person.
      failed += 1;
      ctx.log.error('kek_rewrap_failed', { user_id: row.userId, ...errorFields(error) });
    }
  }
  const more = processed < rows.length || rows.length === pageSize;
  return {
    counts: { current_version: current, rewrapped, superseded, failed },
    next: more ? (lastId ?? ctx.cursor ?? '') : null,
  };
}

async function stepAeRollup(ctx: StepContext): Promise<StepOutcome> {
  const day = ctx.message.day;
  if (day === undefined) {
    return { counts: { skipped: 'no_day' }, next: null };
  }
  const access = cloudflareApiAccess(
    ctx.env.CF_ACCOUNT_ID,
    ctx.env.CF_API_TOKEN,
    ctx.deps.fetch ?? fetch,
  );
  if (access === null) {
    return { counts: { day, skipped: 'cloudflare_api_not_configured' }, next: null };
  }
  const environment = environmentName(ctx.env);
  const providers: Record<string, { rows: number; calls: number; skipped: number }> = {};
  let rows = 0;
  for (const provider of ROLLUP_PROVIDERS) {
    const rolled = await rollupProviderDay(ctx.db, access, { provider, day, environment });
    rows += rolled.rows;
    if (rolled.rows > 0 || rolled.skipped > 0) {
      providers[provider] = { rows: rolled.rows, calls: rolled.calls, skipped: rolled.skipped };
    }
  }
  return { counts: { day, rows, providers }, next: null };
}

const STEPS: Readonly<
  Record<z.output<typeof HousekeepingMessageV1>['step'], (ctx: StepContext) => Promise<StepOutcome>>
> = {
  idempotency_keys: stepIdempotencyKeys,
  sync_purge: stepSyncPurge,
  provider_calls: stepProviderCalls,
  retention: stepRetention,
  usage_counters: stepUsageCounters,
  tracker_subscribers: stepTrackerSubscribers,
  dlq_replay: stepDlqReplay,
  session_tombstones: stepSessionTombstones,
  kek_rewrap: stepKekRewrap,
  ae_rollup: stepAeRollup,
};

/** The audit action of a step. */
export function housekeepingAction(step: string): string {
  return `housekeeping.${step}`;
}

/** Runs one message: the step, its audit row, and its continuation. Throws to be retried. */
export async function runHousekeepingMessage(
  body: unknown,
  { env, log }: Pick<QueueContext, 'env' | 'log'>,
  db: Db,
  deps: HousekeepingDeps = {},
): Promise<StepOutcome | null> {
  const parsed = HousekeepingMessageV1.safeParse(body);
  if (!parsed.success) {
    log.error('housekeeping_message_invalid', { issue: parsed.error.issues[0]?.message });
    return null;
  }
  const message = parsed.data;
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = new WallBudget(now, deps.wallBudgetMs ?? HOUSEKEEPING_WALL_BUDGET_MS);
  const stepLog = log.child({ housekeeping_step: message.step, run_id: message.runId });
  const outcome = await STEPS[message.step]({
    env,
    db,
    log: stepLog,
    now,
    budget,
    deps,
    message,
    cursor: message.cursor === '' ? null : message.cursor,
  });
  await db.insert(auditLog).values({
    actorType: 'system',
    action: housekeepingAction(message.step),
    targetType: 'housekeeping',
    requestId: `housekeeping:${message.runId}`,
    details: {
      run_id: message.runId,
      step: message.step,
      page: message.page,
      done: outcome.next === null,
      elapsed_ms: now() - started,
      ...outcome.counts,
    },
  });
  if (outcome.next !== null) {
    await (deps.sink ?? env.HOUSEKEEPING_QUEUE).send({
      kind: 'housekeeping',
      step: message.step,
      runId: message.runId,
      page: message.page + 1,
      cursor: outcome.next,
      ...(message.day === undefined ? {} : { day: message.day }),
    } satisfies HousekeepingMessageV1);
  }
  stepLog.info('housekeeping_step_done', {
    page: message.page,
    done: outcome.next === null,
    elapsed_ms: now() - started,
  });
  return outcome;
}

export async function handleHousekeepingBatch(
  batch: MessageBatch<unknown>,
  context: QueueContext,
  deps: HousekeepingDeps = {},
): Promise<void> {
  let db: Db | null = deps.db ?? null;
  const outcome = await consumeBatch(
    batch,
    async (message) => {
      db ??= openDb(context.env);
      await runHousekeepingMessage(message.body, context, db, deps);
    },
    context.log,
  );
  context.log.info('housekeeping_batch_done', {
    queue: batch.queue,
    size: batch.messages.length,
    ...outcome,
  });
}
