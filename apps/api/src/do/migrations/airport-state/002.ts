/**
 * AirportState schema, migration 2 (increment 18, close-out: the re-review's M1, ruling R6
 * completed). Append only: a later change is 003.
 *
 * `bucket_failures`: one row per bucket whose last fetch failed the way the provider would answer
 * again (a billed 4xx other than 408, or a 200 that is not a FIDS contract), with the time it may
 * be fetched again (`retry_at_ms`, when a copy fetched then would have turned stale) and the
 * failure's reason. In memory the wait was lost on eviction and on every deploy, so an airport
 * viewed less often than objects are evicted was billed for the same failure on every view.
 * Transient waits (transport, 408, 5xx, push-backs, refusals) stay in memory. A successful fetch
 * deletes the row; the alarm purges it at `purge_at_ms`, the purge a copy fetched at the failure
 * would have had (ruling R4), with the buckets. A new table only: objects at version 1 keep every
 * row they hold.
 */

export const AIRPORT_STATE_MIGRATION_002: readonly string[] = [
  `CREATE TABLE bucket_failures (
    bucket_start_local TEXT PRIMARY KEY,
    retry_at_ms INTEGER NOT NULL,
    purge_at_ms INTEGER NOT NULL,
    reason TEXT NOT NULL
  )`,
];
