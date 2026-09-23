/**
 * Reconcile cron, every fifteen minutes. The expression itself is `RECONCILE_CRON` in
 * `src/cron/index.ts`; it cannot be written in a block comment without closing it.
 *
 * Durable Objects cannot be enumerated by name from the Worker runtime, so
 * `flight_instances.flight_key` in Postgres is the registry. This cron finds trackers whose alarm
 * died (six failed retries exhaust the alarm's own backoff) and re-arms them.
 *
 * The constraint that shapes it: a Cron Trigger with an interval under one hour gets 30 SECONDS
 * of CPU on the Paid plan, not the 15 minutes a longer interval gets. This handler therefore
 * pages through the candidates and fans out to a queue; it must never do the re-arming inline.
 *
 * Increment 7 makes it real: page `flight_instances` where `tracking_state = 'active'` and
 * `next_refresh_at < now - 20 min`, enqueue onto a `reconcile` queue, and let the consumer call
 * `getState` and `forceRefresh('reconcile')` when `getAlarm()` is null and the phase is not
 * finished. The phase column is checked before `getAlarm()`, because an alarm handler that is
 * currently running also reports null.
 */

import type { CronHandler } from './index';

/** CPU budget for a sub-hourly cron on the Paid plan, in seconds. */
export const SUB_HOURLY_CRON_CPU_SECONDS = 30;

/**
 * Typed as `CronHandler` rather than as a plain `void` function so increment 7 can make the body
 * async without touching the dispatcher or its callers. The body is synchronous today.
 */
export const reconcileCron: CronHandler = ({ log }) => {
  log.info('cron_reconcile', {
    implemented: false,
    increment: '07-flight-tracker',
    cpu_budget_seconds: SUB_HOURLY_CRON_CPU_SECONDS,
  });
};
