/**
 * Analytics Engine rollup cron, daily at 03:00 UTC with housekeeping (`DAILY_CRON` in
 * src/cron/index.ts; ruling W3).
 *
 * Plans one `ae_rollup` message per UTC day to roll up (`ROLLUP_DAYS_BACK`: yesterday, and the
 * day before for points that landed late), on the `housekeeping` queue; the consumer asks the
 * Analytics Engine SQL API for each provider's calls that day with `SUM(_sample_interval)` and
 * replaces the matching `provider_call_daily` rows (src/lib/provider-rollup.ts). The ProviderBudget
 * object's own `budget_daily` rows are never touched or summed by it. Same CPU budget as
 * housekeeping (15 minutes, a daily cron); the handler sends two messages.
 */

import { AE_ROLLUP_STEP, type HousekeepingMessageV1 } from '../queues/housekeeping';
import { rollupDays } from '../lib/provider-rollup';
import type { CronHandler } from './index';
import { DAILY_CRON_CPU_SECONDS, type PlanDeps, type PlanResult } from './housekeeping';

export async function planAeRollup(
  context: Parameters<CronHandler>[0],
  deps: PlanDeps = {},
): Promise<PlanResult & { readonly days: readonly string[] }> {
  const nowMs = (deps.now ?? Date.now)();
  const runId = deps.runId ?? context.runId ?? new Date(nowMs).toISOString();
  const sink = deps.sink ?? context.env.HOUSEKEEPING_QUEUE;
  const days = rollupDays(context.scheduledTime ?? nowMs);
  await sink.sendBatch(
    days.map((day) => ({
      body: {
        kind: 'housekeeping',
        step: AE_ROLLUP_STEP,
        runId,
        page: 0,
        cursor: null,
        day,
      } satisfies HousekeepingMessageV1,
    })),
  );
  context.log.info('cron_ae_rollup_planned', {
    run_id: runId,
    days,
    cpu_budget_seconds: DAILY_CRON_CPU_SECONDS,
  });
  return { runId, sent: days.length, days };
}

export const aeRollupCron: CronHandler = async (context) => {
  await planAeRollup(context);
};
