/**
 * The Analytics Engine rollup of provider calls into `provider_call_daily` (increment 12, the
 * `0 3 * * *` cron; ruling W3).
 *
 * The persist consumer writes one `PROVIDER_CALLS` point per stored call (`providerCallPoint`:
 * index1 the provider, blob1 the operation, blob4 the result, blob5 the environment, double2 the
 * cost units, double3 the estimated USD micros). Analytics Engine keeps three months and SAMPLES
 * per index value, and the provider is a two-value index in practice, the worst case: every sum
 * is weighted by `_sample_interval`, never a row count. For one provider and one UTC day the rollup
 * asks the SQL API for the calls, units and micros per `(operation, result)` and upserts one
 * `provider_call_daily` row each, REPLACING the counters on the unique index, so a re-run (the
 * nightly pass rolls up the last two days, and a redelivered message rolls up again) converges on
 * the same row instead of adding to it.
 *
 * The ProviderBudget object's own daily rows live in the same table under `budget_daily` and
 * `budget_daily:{shard}` (increment 7, ruling L10): no Analytics Engine operation carries that
 * name, a returned one that did would be skipped, and every per-operation sum (here and on the
 * admin page) excludes them with `BUDGET_DAILY_OPERATION_PATTERN`; the admin page shows them as the
 * object's own daily total. `provider_calls` stays the exact 90-day ledger; this is the durable
 * series past it (housekeeping step 3 purges a day of `provider_calls` only once its rollup rows
 * exist AND are plausible against the ledger: `isPlausibleRollup`, ruling AA13).
 *
 * A sum the SQL API answers that is not a number (null, a missing key, `'n/a'`) is never read as
 * 0: `rollupRows` throws `RollupSumError`, the message is retried and then dead-lettered with the
 * ops alert, and no row is written for that day. A zero row would have told step 3 that nothing
 * was called, and step 3 would have deleted the only exact copy of the day's calls.
 */

import { sql } from 'drizzle-orm';
import { CALL_RESULTS, PROVIDERS, type Db } from '@planeahead/db';
import type { EnvironmentName } from '@planeahead/shared';
import {
  analyticsSql,
  sqlLiteral,
  strictNumeric,
  type CloudflareApiAccess,
} from './cloudflare-api';

/** `LIKE` pattern of the ProviderBudget object's own rows, excluded from per-operation sums. */
export const BUDGET_DAILY_OPERATION_PATTERN = 'budget_daily%';

/**
 * How far a day's rolled-up calls may sit from the ledger's `count(*)` and still count as the
 * same day (ruling AA13). Analytics Engine sums are sampled estimates (`_sample_interval`), so an
 * exact match is not expected; a rollup outside this band is a wrong answer, not sampling noise.
 */
export const ROLLUP_PLAUSIBILITY_TOLERANCE = 0.2;

/**
 * Whether a day's non-budget rollup (`rolledUpCalls`, the sum of `provider_call_daily.calls`)
 * vouches for the `ledgerCalls` rows `provider_calls` holds for the same (day, provider): more than
 * zero, and within `ROLLUP_PLAUSIBILITY_TOLERANCE` of the ledger. Housekeeping step 3 deletes a
 * day's ledger only when this holds.
 */
export function isPlausibleRollup(rolledUpCalls: number, ledgerCalls: number): boolean {
  if (!(rolledUpCalls > 0) || !(ledgerCalls > 0)) {
    return false;
  }
  return Math.abs(rolledUpCalls - ledgerCalls) <= ROLLUP_PLAUSIBILITY_TOLERANCE * ledgerCalls;
}

/** A sum the SQL API answered that is not a number: the message fails loudly, writing nothing. */
export class RollupSumError extends Error {
  override readonly name = 'RollupSumError';

  constructor(
    readonly operation: string,
    readonly field: string,
  ) {
    super(`the Analytics Engine SQL API answered a non-numeric ${field} for ${operation}`);
  }
}

/** How many past UTC days each nightly run rolls up (late points land in the second pass). */
export const ROLLUP_DAYS_BACK = 2;

/** The `PROVIDER_CALLS` dataset of each environment, as wrangler.jsonc declares it. */
export function providerCallsDataset(environment: EnvironmentName): string {
  switch (environment) {
    case 'production':
      return 'planeahead_provider_calls';
    case 'staging':
      return 'planeahead_provider_calls_staging';
    case 'local':
    case 'test':
      return 'planeahead_provider_calls_local';
  }
}

/** The UTC days a run at `nowMs` rolls up, most recent first: yesterday, the day before. */
export function rollupDays(nowMs: number, back: number = ROLLUP_DAYS_BACK): string[] {
  const today = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  return Array.from({ length: back }, (_, i) =>
    new Date(today - (i + 1) * 86_400_000).toISOString().slice(0, 10),
  );
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The SQL for one provider and one UTC day, grouped by operation and result. */
export function rollupStatement(
  dataset: string,
  provider: string,
  day: string,
  environment: string,
): string {
  return [
    'SELECT blob1 AS operation, blob4 AS result,',
    '  SUM(_sample_interval) AS calls,',
    '  SUM(_sample_interval * double2) AS cost_units,',
    '  SUM(_sample_interval * double3) AS cost_usd_micros',
    `FROM ${dataset}`,
    `WHERE index1 = ${sqlLiteral(provider)}`,
    `  AND blob5 = ${sqlLiteral(environment)}`,
    `  AND timestamp >= toDateTime(${sqlLiteral(`${day} 00:00:00`)})`,
    `  AND timestamp < toDateTime(${sqlLiteral(`${nextDay(day)} 00:00:00`)})`,
    'GROUP BY operation, result',
    'FORMAT JSON',
  ].join('\n');
}

/** The admin page's "today so far": calls and micros per provider since UTC midnight. */
export function todayStatement(dataset: string, day: string, environment: string): string {
  return [
    'SELECT index1 AS provider,',
    '  SUM(_sample_interval) AS calls,',
    '  SUM(_sample_interval * double2) AS cost_units,',
    '  SUM(_sample_interval * double3) AS cost_usd_micros',
    `FROM ${dataset}`,
    `WHERE blob5 = ${sqlLiteral(environment)}`,
    `  AND timestamp >= toDateTime(${sqlLiteral(`${day} 00:00:00`)})`,
    'GROUP BY provider',
    'ORDER BY provider',
    'FORMAT JSON',
  ].join('\n');
}

export interface RollupRow {
  readonly operation: string;
  readonly result: string;
  readonly calls: number;
  readonly costUnits: number;
  readonly costUsdMicros: number;
}

const RESULTS: ReadonlySet<string> = new Set(CALL_RESULTS);
const OPERATION_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

function sumOf(entry: Record<string, unknown>, operation: string, field: string): number {
  const value = strictNumeric(entry[field]);
  if (value === null || value < 0) {
    throw new RollupSumError(operation, field);
  }
  return Math.round(value);
}

/**
 * Turns SQL API rows into rows the table accepts; a row whose operation or result the table cannot
 * hold (or the ProviderBudget's own `budget_daily`) is counted as skipped. A row it can hold whose
 * sums are not numbers throws `RollupSumError` (never a 0 row).
 */
export function rollupRows(data: readonly Record<string, unknown>[]): {
  rows: RollupRow[];
  skipped: number;
} {
  const rows: RollupRow[] = [];
  let skipped = 0;
  for (const entry of data) {
    const operation = typeof entry['operation'] === 'string' ? entry['operation'] : '';
    const result = typeof entry['result'] === 'string' ? entry['result'] : '';
    if (
      !OPERATION_SHAPE.test(operation) ||
      operation.startsWith('budget_daily') ||
      !RESULTS.has(result)
    ) {
      skipped += 1;
      continue;
    }
    rows.push({
      operation,
      result,
      calls: sumOf(entry, operation, 'calls'),
      costUnits: sumOf(entry, operation, 'cost_units'),
      costUsdMicros: sumOf(entry, operation, 'cost_usd_micros'),
    });
  }
  return { rows, skipped };
}

export interface ProviderDayRollup {
  readonly provider: string;
  readonly rows: number;
  readonly calls: number;
  readonly skipped: number;
}

/**
 * Rolls up one provider for one day: one SQL API call, one upsert per (operation, result). Every
 * row is parsed before the first upsert, so a `RollupSumError` writes nothing for the day.
 */
export async function rollupProviderDay(
  db: Db,
  access: CloudflareApiAccess,
  input: { provider: string; day: string; environment: EnvironmentName },
): Promise<ProviderDayRollup> {
  const statement = rollupStatement(
    providerCallsDataset(input.environment),
    input.provider,
    input.day,
    input.environment,
  );
  const { rows, skipped } = rollupRows(await analyticsSql(access, statement));
  for (const row of rows) {
    await db.execute(sql`
      insert into provider_call_daily
        (day, provider, operation, result, calls, cost_units, cost_usd_micros)
      values (${input.day}::date, ${input.provider}, ${row.operation}, ${row.result},
              ${row.calls}, ${row.costUnits}, ${row.costUsdMicros})
      on conflict (day, provider, operation, result) do update
        set calls = excluded.calls,
            cost_units = excluded.cost_units,
            cost_usd_micros = excluded.cost_usd_micros
    `);
  }
  return {
    provider: input.provider,
    rows: rows.length,
    calls: rows.reduce((sum, row) => sum + row.calls, 0),
    skipped,
  };
}

/** Every provider id the ledger knows, in the table's order. */
export const ROLLUP_PROVIDERS: readonly string[] = PROVIDERS;
