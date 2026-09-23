/**
 * ProviderBudget schema, migration 1 (increment 6). Append only: a later change is 002.
 *
 * Five small tables, every one of them bounded by a day's traffic because the object itself is
 * one UTC day (`${provider}:${utcDate}`) and ends with `deleteAll()`:
 *
 *   - `config`: one row. The cap, the per-second limit and the kill switch, plus the bookkeeping
 *     the alarm needs (when it is armed for, whether the day has been finalised).
 *   - `ledger`: units, poll-equivalents and calls spent, one row per trigger.
 *   - `denials`: refusals by reason, for the snapshot and the daily counters.
 *   - `bucket`: one row. The token bucket's stored state, refilled on every read.
 *   - `outbox`: rows for the `persist` queue (the kill-switch alert, the final daily counters),
 *     kept after sending until `deleteAll()`.
 *
 * No foreign keys, so the delete order does not matter. `CHECK (id = 1)` keeps the two
 * singleton tables single.
 *
 * `config.created_at_ms` is the object's LIFETIME epoch: it goes into every outbox message's
 * origin, so a day's object that is ever recreated after `deleteAll()` can never repeat an
 * `(origin, seq)` idempotency key. It was added during increment 6's review, before this schema
 * was applied anywhere, so it lives in 001 rather than in a 002.
 */

export const PROVIDER_BUDGET_MIGRATION_001: readonly string[] = [
  `CREATE TABLE config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL,
    utc_date TEXT NOT NULL,
    daily_unit_cap INTEGER NOT NULL CHECK (daily_unit_cap >= 0),
    per_second_limit REAL NOT NULL CHECK (per_second_limit > 0),
    kill_switch INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch IN (0, 1)),
    kill_reason TEXT,
    kill_at_ms INTEGER,
    finalised INTEGER NOT NULL DEFAULT 0 CHECK (finalised IN (0, 1)),
    alarm_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE ledger (
    trigger TEXT PRIMARY KEY,
    units REAL NOT NULL DEFAULT 0 CHECK (units >= 0),
    pe REAL NOT NULL DEFAULT 0 CHECK (pe >= 0),
    calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
    released_units REAL NOT NULL DEFAULT 0 CHECK (released_units >= 0)
  )`,
  `CREATE TABLE denials (
    reason TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
  )`,
  `CREATE TABLE bucket (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    tokens REAL NOT NULL CHECK (tokens >= 0),
    updated_at_ms INTEGER NOT NULL,
    blocked_until_ms INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE outbox (
    seq INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    sent_at_ms INTEGER
  )`,
  'CREATE INDEX outbox_unsent ON outbox (seq) WHERE sent_at_ms IS NULL',
];
