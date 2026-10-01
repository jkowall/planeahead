/**
 * ProviderBudget schema, migration 2 (increment 18, ruling B5). Append only: a later change is 003.
 *
 * `board_airports`: the distinct airports whose boards were refreshed in each UTC hour of the
 * day, one row per (hour, airport), written by the reservation that refreshed it. The global cap
 * on distinct airports per hour (`ADB_BOARD_AIRPORTS_PER_HOUR`) counts these rows; a second
 * refresh of an airport already counted in that hour adds nothing. At most 24 x the cap rows a
 * day, gone with the day's `deleteAll()`.
 *
 * The boards share itself needs no table: the `ledger` already keeps units per trigger, and the
 * share is the sum of the `board` and `route_search` rows.
 */

export const PROVIDER_BUDGET_MIGRATION_002: readonly string[] = [
  `CREATE TABLE board_airports (
    hour_utc INTEGER NOT NULL CHECK (hour_utc BETWEEN 0 AND 23),
    airport_icao TEXT NOT NULL,
    first_at_ms INTEGER NOT NULL,
    PRIMARY KEY (hour_utc, airport_icao)
  )`,
];
