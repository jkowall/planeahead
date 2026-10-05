/**
 * Cron dispatch.
 *
 * `controller.cron` carries the five-field expression exactly as it appears in `triggers.crons`,
 * so the two constants below are the routing key and must stay in step with wrangler.jsonc.
 * `scheduled()` never throws: a throw marks the invocation as failed and, unlike a queue message,
 * there is no retry to earn by it.
 *
 * The handlers take a `CronContext` rather than loose arguments so that increment 7's reconcile,
 * which has 30 seconds of CPU and must fan out to a queue, has `ctx.waitUntil` in hand without a
 * signature change rippling through every caller.
 *
 * The seam is async for the same reason, and it is async NOW while every handler is one log line.
 * Reconcile has to page `flight_instances` and enqueue, both of which are awaited work, and a
 * `void` seam offers two bad ways to express that: change all four signatures later, or reach for
 * `ctx.waitUntil` on work that should be awaited and lose the cron's error reporting with it. A
 * promise a handler starts is also simply abandoned when a `void` `scheduled()` returns.
 * `ExportedHandler<Env>` accepts `void | Promise<void>` for `scheduled`, so the default export is
 * unaffected. `runCron` awaits inside its try, so a rejected handler is logged, not unhandled.
 *
 * Increment 12 (ruling W1): no cron does work inline. Each handler pages or plans within its CPU
 * budget and enqueues one message per unit of work:
 *
 *   `RECONCILE_CRON` (every 15 minutes, 30 s of CPU on Paid, a 25 s wall budget): pages overdue
 *   active `flight_instances` onto the `reconcile` queue (src/cron/reconcile.ts).
 *   `DAILY_CRON` (03:00 UTC, 15 minutes of CPU): two planners, each run even when the other
 *   throws: housekeeping (one message per step, src/cron/housekeeping.ts) and the Analytics Engine
 *   rollup (one message per day, src/cron/ae-rollup.ts), both on the `housekeeping` queue. The
 *   spec gives both the same expression, and a Worker routes a cron by expression, so they share
 *   one handler rather than two triggers.
 *   `PUSH_SOAK_CRON` (every five minutes, increment 16, ruling C9): the transport soak's tick, in
 *   staging's `triggers` only; production keeps the two above. Inside a soak an operator started
 *   on `/admin/push/soak` it plans one injection, and once an hour the canary, onto the
 *   `housekeeping` queue (src/push/soak.ts); otherwise it reads one KV value and logs.
 */

import type { Env } from '../env';
import { type Logger, createLogger, errorFields } from '../observability/log';
import { pushSoakCron } from '../push/soak';
import { aeRollupCron } from './ae-rollup';
import { housekeepingCron } from './housekeeping';
import { reconcileCron } from './reconcile';

export const RECONCILE_CRON = '*/15 * * * *';
export const HOUSEKEEPING_CRON = '0 3 * * *';
/** The daily expression, housekeeping and the Analytics Engine rollup together. */
export const DAILY_CRON = HOUSEKEEPING_CRON;
/** The transport soak's tick (staging only). */
export const PUSH_SOAK_CRON = '*/5 * * * *';

export interface CronContext {
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly log: Logger;
  /** `controller.scheduledTime`; absent when a test drives a handler directly. */
  readonly scheduledTime?: number | undefined;
  /** The scheduled time as ISO-8601, the run id every message of the invocation carries. */
  readonly runId?: string | undefined;
}

/** What a cron handler looks like. Sync handlers stay legal; awaited work is now expressible. */
export type CronHandler = (context: CronContext) => Promise<void> | void;

/** Expression to handler. A table rather than a switch so a test can supply its own. */
export type CronHandlers = Readonly<Record<string, CronHandler>>;

/**
 * Runs every handler even when one throws, then rethrows the first failure (so `runCron` logs it):
 * a failed housekeeping plan must not cost the night its rollup, or the other way round.
 */
export function allOf(...handlers: readonly CronHandler[]): CronHandler {
  return async (context) => {
    const failures: unknown[] = [];
    for (const handler of handlers) {
      try {
        await handler(context);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
    }
  };
}

export const dailyCron: CronHandler = allOf(housekeepingCron, aeRollupCron);

export const CRON_HANDLERS: CronHandlers = {
  [RECONCILE_CRON]: reconcileCron,
  [DAILY_CRON]: dailyCron,
  [PUSH_SOAK_CRON]: pushSoakCron,
};

/** Routes one cron expression. Exported so a test can drive it without a ScheduledController. */
export async function runCron(
  cron: string,
  context: CronContext,
  handlers: CronHandlers = CRON_HANDLERS,
): Promise<void> {
  const handler = handlers[cron];
  if (handler === undefined) {
    context.log.error('cron_unrouted', {});
    return;
  }
  try {
    // Awaited, not called and dropped: a rejected handler has to reach the catch below, because
    // a cron invocation has no retry to earn and an unhandled rejection reports nothing useful.
    await handler(context);
  } catch (error) {
    context.log.error('cron_failed', errorFields(error));
  }
}

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const log = createLogger({ cron: controller.cron, scheduled_time: controller.scheduledTime });
  await runCron(controller.cron, {
    env,
    ctx,
    log,
    scheduledTime: controller.scheduledTime,
    runId: new Date(controller.scheduledTime).toISOString(),
  });
}
