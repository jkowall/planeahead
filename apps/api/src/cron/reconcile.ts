/**
 * Reconcile cron, every fifteen minutes. The expression itself is `RECONCILE_CRON` in
 * `src/cron/index.ts`; it cannot be written in a block comment without closing it.
 *
 * Durable Objects cannot be enumerated by name from the Worker runtime, so
 * `flight_instances.flight_key` in Postgres is the registry. This cron finds trackers whose alarm
 * died (six failed retries exhaust the alarm's own backoff, and workerd then clears the alarm)
 * and hands their keys to the `reconcile` queue, whose consumer re-arms them.
 *
 * The constraint that shapes it: a Cron Trigger with an interval under one hour gets 30 SECONDS
 * of CPU on the Paid plan, not the 15 minutes a longer interval gets. So the handler pages
 * `flight_instances` in 500-row pages inside a 25 second wall budget, sends the keys in batches
 * of 100, and never re-arms anything inline. Candidates: an ACTIVE tracking state (`pending`,
 * `tracking`, `airborne`, `landed`; the schema has no `active` value, the spec's word for the
 * set) and a `next_refresh_at` more than twenty minutes in the past, OR a NULL `next_refresh_at`
 * with an `updated_at` more than twenty minutes old (ruling L12): the tracker never persists a
 * NULL for a phase that is not finished, so a NULL on an active row is itself a sign the tracker
 * died between its last step 1 and its finish, and the consumer's refresh finishes it.
 */

import { and, asc, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { ACTIVE_TRACKING_STATES, flightInstances, openDb, type Db } from '@planeahead/db';
import { RPC_SCHEMA_VERSION, type FlightKey, type ReconcileMessageV1 } from '@planeahead/shared';
import type { CronHandler } from './index';

/** CPU budget for a sub-hourly cron on the Paid plan, in seconds. */
export const SUB_HOURLY_CRON_CPU_SECONDS = 30;
/** The wall budget the handler keeps to, under the 30 s CPU limit. */
export const RECONCILE_WALL_BUDGET_MS = 25_000;
/** A refresh this overdue means the alarm is gone (six retries from 2 s never reach this). */
export const RECONCILE_OVERDUE_MS = 20 * 60_000;
export const RECONCILE_PAGE_SIZE = 500;
/** Queues: at most 100 messages per `sendBatch`. */
const SEND_BATCH_MAX = 100;

export interface ReconcileCronDeps {
  readonly db?: Db | undefined;
  readonly now?: (() => number) | undefined;
  readonly sink?: Pick<Queue, 'sendBatch'> | undefined;
}

export interface ReconcileCronResult {
  readonly candidates: number;
  readonly sent: number;
  readonly pages: number;
  /** True when the wall budget ended the scan before the last page. */
  readonly truncated: boolean;
}

/** One page of overdue keys after `afterId`, ordered by id (keyset paging). */
export async function overduePage(
  db: Db,
  now: number,
  afterId: string | null,
): Promise<{ id: string; flightKey: string; nextRefreshAt: string | null }[]> {
  const cutoff = new Date(now - RECONCILE_OVERDUE_MS).toISOString();
  const active = inArray(flightInstances.trackingState, [...ACTIVE_TRACKING_STATES]);
  const overdue = or(
    lt(flightInstances.nextRefreshAt, cutoff),
    and(isNull(flightInstances.nextRefreshAt), lt(flightInstances.updatedAt, cutoff)),
  );
  const where =
    afterId === null ? and(active, overdue) : and(active, overdue, gt(flightInstances.id, afterId));
  return db
    .select({
      id: flightInstances.id,
      flightKey: flightInstances.flightKey,
      nextRefreshAt: flightInstances.nextRefreshAt,
    })
    .from(flightInstances)
    .where(where)
    .orderBy(asc(flightInstances.id))
    .limit(RECONCILE_PAGE_SIZE);
}

export async function runReconcileCron(
  context: Parameters<CronHandler>[0],
  deps: ReconcileCronDeps = {},
): Promise<ReconcileCronResult> {
  const { env, log } = context;
  const now = deps.now ?? Date.now;
  const started = now();
  const db = deps.db ?? openDb(env);
  const sink = deps.sink ?? env.RECONCILE_QUEUE;
  let candidates = 0;
  let sent = 0;
  let pages = 0;
  let truncated = false;
  let afterId: string | null = null;
  for (;;) {
    if (now() - started > RECONCILE_WALL_BUDGET_MS) {
      truncated = true;
      break;
    }
    const page = await overduePage(db, started, afterId);
    pages += 1;
    if (page.length === 0) {
      break;
    }
    candidates += page.length;
    for (let i = 0; i < page.length; i += SEND_BATCH_MAX) {
      const slice = page.slice(i, i + SEND_BATCH_MAX);
      await sink.sendBatch(
        slice.map((row) => ({
          body: {
            outboxVersion: RPC_SCHEMA_VERSION,
            kind: 'reconcile_flight',
            flightKey: row.flightKey as FlightKey,
            nextRefreshAt: row.nextRefreshAt,
          } satisfies ReconcileMessageV1,
        })),
      );
      sent += slice.length;
    }
    afterId = page[page.length - 1]?.id ?? null;
    if (page.length < RECONCILE_PAGE_SIZE) {
      break;
    }
  }
  const result: ReconcileCronResult = { candidates, sent, pages, truncated };
  log.info('cron_reconcile', {
    ...result,
    elapsed_ms: now() - started,
    cpu_budget_seconds: SUB_HOURLY_CRON_CPU_SECONDS,
  });
  return result;
}

export const reconcileCron: CronHandler = async (context) => {
  await runReconcileCron(context);
};
