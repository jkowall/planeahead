/**
 * FlightTracker schema, migration 1 (increment 7). Append only: a later change is 002.
 *
 * Eleven tables, every one bounded by one flight's life (the object ends with `deleteAll()`):
 *
 *   - `flight`: one row. The snapshot is ONE JSON column plus the handful of indexed scalars
 *     the alarm reads without parsing it (the OOOI instants the cadence needs, the next refresh,
 *     the version). Well under the 100-column ceiling on purpose: the wide `flight_instances`
 *     row lives in Postgres, written by the persist consumer from the outbox.
 *   - `subscribers`, `events` (the timeline, archived to R2 at finish; `seq` IS the outbox seq
 *     of the row that carried the event, so a Postgres replay conflicts on the same number),
 *     `positions` (an empty ring in Phase 0), `budget` (poll-equivalents spent by trigger, caps
 *     from shared), `attempts` (one row per alarm slot: the idempotency record, and the rows
 *     read and written that alarm cost), `user_refresh` (per user per day), `outbox` (rows to
 *     the `persist` queue: deleted only when the consumer confirms them), `notif_dedupe`,
 *     `alert_registrations` (unused until Phase 1), `kv_debounce` (one row).
 *
 * Foreign keys are enforced by workerd's SQLite build (increment 7 spike 4), so every child
 * table references `flight(id)` and a partial delete removes children first. The finish path
 * is `deleteAll()`, never called inside a transaction, which needs no ordering.
 *
 * No secondary indexes on the alarm-written tables: rows written are the budgeted cost (ruling
 * J5) and every index is another row per write. `outbox` is scanned by `seq` (its rowid) for
 * unsent rows; the table holds at most a few hundred rows between confirmations. Its seqs come
 * from `flight.outbox_next_seq`, never from the rowid: SQLite reuses a rowid once the rows above
 * it are deleted, and a confirmed outbox row is exactly that.
 */

export const FLIGHT_TRACKER_MIGRATION_001: readonly string[] = [
  `CREATE TABLE flight (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    key TEXT NOT NULL,
    cadence TEXT NOT NULL,
    phase TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    outbox_next_seq INTEGER NOT NULL DEFAULT 1,
    snapshot TEXT NOT NULL,
    search_designator TEXT,
    scheduled_out_ms INTEGER,
    scheduled_in_ms INTEGER,
    estimated_in_ms INTEGER,
    actual_off_ms INTEGER,
    actual_on_ms INTEGER,
    actual_in_ms INTEGER,
    next_refresh_at_ms INTEGER,
    attempt_slot_ms INTEGER,
    operator_source TEXT,
    polling_stopped INTEGER NOT NULL DEFAULT 0 CHECK (polling_stopped IN (0, 1)),
    stop_reason TEXT,
    reconcile_poll_done INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_poll_done IN (0, 1)),
    provider_call_count INTEGER NOT NULL DEFAULT 0,
    provider_cost_units REAL NOT NULL DEFAULT 0,
    last_refreshed_at_ms INTEGER,
    finished_at_ms INTEGER,
    finish_reason TEXT,
    finish_alarm_attempts INTEGER NOT NULL DEFAULT 0,
    events_r2_key TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE subscribers (
    subscription_id TEXT PRIMARY KEY,
    flight_id INTEGER NOT NULL REFERENCES flight(id),
    user_id TEXT NOT NULL,
    muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
    overrides TEXT,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE events (
    seq INTEGER PRIMARY KEY,
    flight_id INTEGER NOT NULL REFERENCES flight(id),
    occurred_at_ms INTEGER NOT NULL,
    type TEXT NOT NULL,
    field TEXT,
    old_value TEXT,
    new_value TEXT,
    source TEXT NOT NULL,
    provider_call_id TEXT
  )`,
  `CREATE TABLE positions (
    seq INTEGER PRIMARY KEY,
    flight_id INTEGER NOT NULL REFERENCES flight(id),
    seen_at_ms INTEGER NOT NULL,
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    alt_ft REAL,
    gs_kt REAL,
    track_deg REAL,
    source TEXT NOT NULL
  )`,
  `CREATE TABLE budget (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    flight_id INTEGER NOT NULL REFERENCES flight(id),
    scheduled_pe REAL NOT NULL DEFAULT 0 CHECK (scheduled_pe >= 0),
    user_refresh_pe REAL NOT NULL DEFAULT 0 CHECK (user_refresh_pe >= 0),
    calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
    soft_cap_pe REAL NOT NULL,
    hard_cap_pe REAL NOT NULL,
    stretched INTEGER NOT NULL DEFAULT 0 CHECK (stretched IN (0, 1)),
    hard_cap_hit INTEGER NOT NULL DEFAULT 0 CHECK (hard_cap_hit IN (0, 1)),
    by_trigger TEXT NOT NULL DEFAULT '{}'
  )`,
  `CREATE TABLE attempts (
    slot_ms INTEGER PRIMARY KEY,
    flight_id INTEGER NOT NULL REFERENCES flight(id),
    started_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL,
    outcome TEXT NOT NULL,
    rows_read INTEGER NOT NULL DEFAULT 0,
    rows_written INTEGER NOT NULL DEFAULT 0,
    provider_call_id TEXT
  )`,
  `CREATE TABLE user_refresh (
    user_id TEXT NOT NULL,
    day TEXT NOT NULL,
    flight_id INTEGER NOT NULL REFERENCES flight(id),
    count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
    PRIMARY KEY (user_id, day)
  )`,
  `CREATE TABLE outbox (
    seq INTEGER PRIMARY KEY,
    flight_id INTEGER NOT NULL REFERENCES flight(id),
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    sent_at_ms INTEGER
  )`,
  `CREATE TABLE notif_dedupe (
    dedupe_key TEXT PRIMARY KEY,
    flight_id INTEGER NOT NULL REFERENCES flight(id),
    sent_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE alert_registrations (
    id INTEGER PRIMARY KEY,
    flight_id INTEGER NOT NULL REFERENCES flight(id),
    provider TEXT NOT NULL,
    external_alert_id TEXT NOT NULL,
    events TEXT,
    registered_at_ms INTEGER NOT NULL,
    cancelled_at_ms INTEGER
  )`,
  `CREATE TABLE kv_debounce (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    flight_id INTEGER NOT NULL REFERENCES flight(id),
    last_write_at_ms INTEGER NOT NULL DEFAULT 0,
    pending INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1))
  )`,
];
