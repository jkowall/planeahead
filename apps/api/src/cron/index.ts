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
 */

import type { Env } from '../env';
import { type Logger, createLogger, errorFields } from '../observability/log';
import { housekeepingCron } from './housekeeping';
import { reconcileCron } from './reconcile';

export const RECONCILE_CRON = '*/15 * * * *';
export const HOUSEKEEPING_CRON = '0 3 * * *';

export interface CronContext {
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly log: Logger;
}

/** What a cron handler looks like. Sync handlers stay legal; awaited work is now expressible. */
export type CronHandler = (context: CronContext) => Promise<void> | void;

/** Expression to handler. A table rather than a switch so a test can supply its own. */
export type CronHandlers = Readonly<Record<string, CronHandler>>;

export const CRON_HANDLERS: CronHandlers = {
  [RECONCILE_CRON]: reconcileCron,
  [HOUSEKEEPING_CRON]: housekeepingCron,
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
  await runCron(controller.cron, { env, ctx, log });
}
