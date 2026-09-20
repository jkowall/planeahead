/**
 * `0 3 * * *` housekeeping cron, daily at 03:00 UTC.
 *
 * Owns the work that has to happen once a day and nowhere else: expiring `idempotency_keys` and
 * magic-link rows, the Analytics Engine rollup into Postgres (Analytics Engine keeps three
 * months, the product needs longer), and the retention sweeps the threat model asks for.
 *
 * Unlike reconcile, this one runs at an hourly-or-longer interval, so it gets the full CPU budget
 * rather than 30 seconds. It may still do its work inline.
 */

import type { CronHandler } from './index';

/** Typed as `CronHandler` so increment 12's real sweeps can await without a signature change. */
export const housekeepingCron: CronHandler = ({ log }) => {
  log.info('cron_housekeeping', { implemented: false, increment: '12-hardening' });
};
