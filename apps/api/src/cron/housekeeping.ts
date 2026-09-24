/**
 * Housekeeping cron, daily at 03:00 UTC (`DAILY_CRON` in src/cron/index.ts; the expression cannot
 * be written in a block comment without closing it).
 *
 * It plans and nothing else (ruling W1): one message per step on the `housekeeping` queue, in the
 * order of `HOUSEKEEPING_STEPS`, all sharing a run id (the cron's scheduled time), and the
 * consumer does the work one message at a time within its own budget (src/queues/housekeeping.ts,
 * where each step is described). A cron at an interval of an hour or more has 15 minutes of CPU on
 * the Paid plan, `DAILY_CRON_CPU_SECONDS`; this handler uses a few milliseconds of it (one
 * `sendBatch` of nine messages), so the budget is documented, not approached.
 */

import { HOUSEKEEPING_STEPS, type HousekeepingMessageV1 } from '../queues/housekeeping';
import type { CronHandler } from './index';

/** CPU budget of a cron whose interval is an hour or more, on the Paid plan, in seconds. */
export const DAILY_CRON_CPU_SECONDS = 15 * 60;

export interface PlanDeps {
  readonly sink?: Pick<Queue, 'sendBatch'> | undefined;
  readonly now?: (() => number) | undefined;
  /** The run id; the cron's scheduled time by default. */
  readonly runId?: string | undefined;
}

export interface PlanResult {
  readonly runId: string;
  readonly sent: number;
}

/** Sends one message per housekeeping step. */
export async function planHousekeeping(
  context: Parameters<CronHandler>[0],
  deps: PlanDeps = {},
): Promise<PlanResult> {
  const runId = deps.runId ?? context.runId ?? new Date((deps.now ?? Date.now)()).toISOString();
  const sink = deps.sink ?? context.env.HOUSEKEEPING_QUEUE;
  await sink.sendBatch(
    HOUSEKEEPING_STEPS.map((step) => ({
      body: {
        kind: 'housekeeping',
        step,
        runId,
        page: 0,
        cursor: null,
      } satisfies HousekeepingMessageV1,
    })),
  );
  context.log.info('cron_housekeeping_planned', {
    run_id: runId,
    steps: HOUSEKEEPING_STEPS.length,
    cpu_budget_seconds: DAILY_CRON_CPU_SECONDS,
  });
  return { runId, sent: HOUSEKEEPING_STEPS.length };
}

export const housekeepingCron: CronHandler = async (context) => {
  await planHousekeeping(context);
};
