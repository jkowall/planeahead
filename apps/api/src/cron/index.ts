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

/** Routes one cron expression. Exported so a test can drive it without a ScheduledController. */
export function runCron(cron: string, context: CronContext): void {
  try {
    switch (cron) {
      case RECONCILE_CRON:
        reconcileCron(context);
        return;
      case HOUSEKEEPING_CRON:
        housekeepingCron(context);
        return;
      default:
        context.log.error('cron_unrouted', {});
        return;
    }
  } catch (error) {
    context.log.error('cron_failed', errorFields(error));
  }
}

export function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
  const log = createLogger({ cron: controller.cron, scheduled_time: controller.scheduledTime });
  runCron(controller.cron, { env, ctx, log });
}
