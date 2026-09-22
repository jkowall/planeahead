import type { ProviderCallRecord } from './flight-status';

/**
 * The Analytics Engine point one `ProviderCallRecord` becomes (increment 6 fixes the shape;
 * the persist consumer in increment 7 and the Worker-side cost logger both write it). One
 * index, five blobs and four doubles, far inside the per-point limits (1 index of at most 96
 * bytes, 20 blobs, 20 doubles, 16,000 cumulative blob bytes; facts sheet section 4).
 *
 * `index1` is the provider, a two-value dimension in practice, which is the worst case for
 * Analytics Engine's per-index sampling: every cost query over this dataset must weight rows by
 * `SUM(_sample_interval)`, never count them. Postgres `provider_calls` stays the ledger;
 * Analytics Engine keeps three months and answers dashboards.
 *
 * The column order is the contract. Queries address blobs and doubles by position (`blob1`,
 * `double3`), so a field is only ever appended, never inserted or reordered.
 */

/** `blob1` to `blob5`, in order. */
export const PROVIDER_CALL_POINT_BLOBS = [
  'operation',
  'flight_key',
  'trigger',
  'result',
  'environment',
] as const;

/** `double1` to `double4`, in order. */
export const PROVIDER_CALL_POINT_DOUBLES = [
  'latency_ms',
  'cost_units',
  'est_cost_usd_micros',
  'http_status',
] as const;

export interface ProviderCallPoint {
  indexes: [string];
  blobs: string[];
  doubles: number[];
}

/**
 * The point for one call. An absent flight key is an empty blob and an absent HTTP status (a
 * call that never reached the provider) is `0`, so every point has the same arity.
 */
export function providerCallPoint(
  record: ProviderCallRecord,
  environment: string,
): ProviderCallPoint {
  return {
    indexes: [record.provider],
    blobs: [record.operation, record.flightKey ?? '', record.trigger, record.result, environment],
    doubles: [record.latencyMs, record.costUnits, record.estCostUsdMicros, record.httpStatus ?? 0],
  };
}
