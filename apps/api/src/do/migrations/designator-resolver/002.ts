/**
 * DesignatorResolver schema, migration 2 (increment 7, review fix round). Append only.
 *
 *   - `resolution.tracker`: what stands behind a resolved flight key: `seeded`, `adopted`, or
 *     `none` when the fetched status was terminal and the cadence had nothing left to schedule,
 *     so no tracker was created (ruling L9: a finished flight never gets a second lifetime).
 *   - `flush_state`: one row, the number of expiry alarms that found provider call records still
 *     unsent. The expiry alarm never `deleteAll()`s an unsent row (ruling L2): it re-arms hourly
 *     and raises the ops alert once after the sixth failed attempt. A separate table because a
 *     failed search (not cached) has records to send but no `resolution` row.
 */

export const DESIGNATOR_RESOLVER_MIGRATION_002: readonly string[] = [
  `ALTER TABLE resolution ADD COLUMN tracker TEXT`,
  `CREATE TABLE flush_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    attempts INTEGER NOT NULL DEFAULT 0
  )`,
];
