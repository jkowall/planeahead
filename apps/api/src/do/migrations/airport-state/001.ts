/**
 * AirportState schema, migration 1 (increment 18, rulings B3 and B6). Append only: a later
 * change is 002.
 *
 *   - `airport`: one row. The ICAO code the object serves and its lifetime epoch
 *     (`created_at_ms`), which goes into every outbox origin so `(origin, seq)` stays unique if
 *     the object is ever recreated after `deleteAll()`.
 *   - `buckets`: one row per cached bucket (12 airport-local hours): when it was fetched, its
 *     fresh, stale and purge limits, the coverage it was fetched under, and how its rows are
 *     stored.
 *   - `bucket_chunks`: the bucket's normalised rows as ONE gzip stream (`CompressionStream`),
 *     split into chunks of at most `BOARD_CHUNK_BYTES` (1 MB), so no board, however large, meets
 *     the 2 MB row limit of Durable Object SQLite (R3 F37; the real size is unmeasured, R3 U4).
 *     Deleted with their bucket in one transaction; no foreign key, so the order is free.
 *   - `coverage`: one row. The free health check's answer and when it expires (ruling B6).
 *   - `outbox`: provider call records for the `persist` queue (ADR 0007: never Postgres).
 */

export const AIRPORT_STATE_MIGRATION_001: readonly string[] = [
  `CREATE TABLE airport (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    airport_icao TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  )`,
  `CREATE TABLE buckets (
    bucket_start_local TEXT PRIMARY KEY,
    tz TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    fetched_at_ms INTEGER NOT NULL,
    fresh_until_ms INTEGER NOT NULL,
    stale_until_ms INTEGER NOT NULL,
    purge_at_ms INTEGER NOT NULL,
    coverage TEXT NOT NULL,
    row_count INTEGER NOT NULL CHECK (row_count >= 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count >= 0),
    gzip_bytes INTEGER NOT NULL CHECK (gzip_bytes >= 0)
  )`,
  'CREATE INDEX buckets_purge_at ON buckets (purge_at_ms)',
  `CREATE TABLE bucket_chunks (
    bucket_start_local TEXT NOT NULL,
    idx INTEGER NOT NULL CHECK (idx >= 0),
    data BLOB NOT NULL,
    PRIMARY KEY (bucket_start_local, idx)
  )`,
  `CREATE TABLE coverage (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    coverage TEXT NOT NULL,
    schedules TEXT,
    live TEXT,
    adsb TEXT,
    checked_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL
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
