/**
 * DesignatorResolver schema, migration 1 (increment 7). Append only: a later change is 002.
 *
 * Two tables, both bounded by one designator on one date (the object lives 24 hours and ends
 * with `deleteAll()` from its expiry alarm):
 *
 *   - `resolution`: one row, the stored answer (a flight key and the status it was created
 *     from, or a `not_found`), with its expiry. `created_at_ms` is the object's lifetime epoch
 *     and goes into every outbox origin, so `(origin, seq)` never repeats across lifetimes.
 *   - `outbox`: the provider call records this object made, for the `persist` queue. Kept
 *     after sending until `deleteAll()`, like the ProviderBudget's: the persist consumer
 *     confirms seqs only to FlightTracker lifetimes.
 *
 * No foreign keys, so the delete order does not matter.
 */

export const DESIGNATOR_RESOLVER_MIGRATION_001: readonly string[] = [
  `CREATE TABLE resolution (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    designator TEXT NOT NULL,
    date_local TEXT NOT NULL,
    outcome TEXT NOT NULL,
    flight_key TEXT,
    status TEXT,
    created_flight INTEGER NOT NULL DEFAULT 0 CHECK (created_flight IN (0, 1)),
    kv_written INTEGER NOT NULL DEFAULT 0 CHECK (kv_written IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    resolved_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE outbox (
    seq INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    sent_at_ms INTEGER
  )`,
];
