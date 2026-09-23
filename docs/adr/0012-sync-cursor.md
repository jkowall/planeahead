# 0012. The sync cursor: an xid8 watermark over two append-only change tables

- Status: Accepted
- Date: 2026-09-23
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none

## Context

`GET /v1/sync` is the mobile app's only way to learn what changed on the server: its offline
store applies pages of changes and keeps the cursor the last page answered. A pull feed is only
correct if a client that pulls repeatedly sees every committed change exactly once in some
order, and no change is ever lost between two pulls. Four facts decide how the cursor can work
(`docs/increments/08-flight-routes-and-sync.facts.md` section 1):

1. A transaction's id is assigned at its FIRST WRITE, not at its start or its commit, and "the
   order in which transactions perform their first database write might be different from the
   order in which the transactions started"
   ([transaction-id.html](https://www.postgresql.org/docs/18/transaction-id.html)). A transaction
   that wrote first can commit last. This is the late-commit hazard: a cursor that remembers the
   highest position it has served (a `max(seq)`, a `max(updated_at)`) moves past a row that was
   still uncommitted when the page was cut, and never sees it.
2. `now()` and `CURRENT_TIMESTAMP` are the transaction's START time
   ([functions-datetime.html](https://www.postgresql.org/docs/18/functions-datetime.html)), so an
   `updated_at` cursor has the same hole, widened by the transaction's duration.
3. `pg_snapshot_xmin(pg_current_snapshot())` is the lowest transaction id still active; every xid
   below it is committed-and-visible or aborted-and-dead
   ([functions-info.html](https://www.postgresql.org/docs/18/functions-info.html)). `xid8` is 64
   bits, never wraps in a cluster's life, and has a btree opclass.
4. Hyperdrive pools in transaction mode and "a single Worker invocation may obtain multiple
   connections" ([connection-pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)),
   so an entity write and the record of it must be ONE transaction on one connection.

The plan's dossier (section 5) specified the flight half of the feed as
`flight_instances.updated_at > since_ts`: fact 2 rules that out (facts sheet, PLAN CONFLICT).

## Decision

We will serve the feed from two append-only change tables that share one watermark, and page
them by the pair `(xid, seq)` strictly below `pg_snapshot_xmin(pg_current_snapshot())`.

1. **The tables.** `user_sync_changes (user_id, xid, seq, entity, op, entity_id, row, created_at)`
   (increment 3, `row` added by migration 0003) records the caller's own entities;
   `flight_sync_changes (flight_instance_id, xid, seq, snapshot, created_at)` (migration 0003)
   records a flight's snapshot. `xid` is `xid8 not null default pg_current_xact_id()`, `seq` a
   `bigint` identity. Rows are only ever INSERTED, always inside the same `db.transaction()` as the
   write they record: the route's subscription, tombstone or preference write for the first
   table; the persist consumer's monotonic `flight_instances` upsert for the second, and only when
   that upsert changed the row (`RETURNING`), so a replayed or stale queue delivery adds nothing.
   A column `DEFAULT` never fires on the `DO UPDATE` branch of `ON CONFLICT`, which is why neither
   table is ever upserted.
2. **The predicate.**
   `xid < pg_snapshot_xmin(pg_current_snapshot()) and (xid, seq) > ($1::xid8, $2::bigint)`,
   ordered by `(xid, seq)`. The first half is the whole safety argument:
   a transaction that took its xid early and is still open holds the watermark at or below its
   own xid, so every row after it (by xid) is held back too, including rows that committed before
   it; when it commits, the next pull serves its rows and the ones it held back, in order. The row
   comparison is an index qualification on `user_sync_changes (user_id, xid, seq)`: EXPLAIN on
   PostgreSQL 18.4 shows an Index Scan whose Index Cond is
   `((user_id = $1) AND (xid < $W) AND (ROW(xid, seq) > ROW($x, $s)))` and no Filter
   (`test/workers/sync.test.ts`), so the row-value
   form ships and the expanded `OR` fallback was not needed. `flight_sync_changes` has the
   matching `(flight_instance_id, xid, seq)` index.
3. **One order across two tables.** The page reads each table with `LIMIT 201` and merges by
   `(xid, seq)`. No transaction writes both tables (routes write only user rows, the persist
   consumer only flight rows), so a pair names at most one row across them and the merged order is
   total. A later writer that needs both in one transaction must share one sequence between the
   tables first.
4. **The cursor.** Opaque on the wire: base64url of `"<xid8>:<seq>"`, both halves decimal
   STRINGS that never pass through a JavaScript number (postgres.js has no xid8 parser, and an
   xid8 does not fit a double); every query selects them `::text` and comparisons use BigInt. A
   page cut at `SYNC_PAGE_SIZE` (200, server-enforced, the 201st row sets `hasMore`) answers its
   last row's position; a drained page answers `(watermark, 0)`, which the next pull turns into
   `(xid, seq) > (watermark, 0)`, i.e. including the watermark transaction's own rows (`seq`
   starts at 1). No cursor means an empty client: the answer is the current state of every entity
   the caller owns, read after the watermark, with cursor `(watermark, 0)`; a change committed
   between the two reads is served again by the next pull, which the client applies idempotently.
5. **Flights.** A page carries `flights`, keyed by flight key, sent once however many rows name
   the flight: the latest snapshot below the watermark of every instance whose change rows are in
   the page (for the caller's live subscriptions only) and of every subscription the page
   upserts. The mobile store denormalises the snapshot onto its subscription rows because
   `useLiveQuery` watches only a query's root table.
6. **The 410 contract.** A cursor answers 410 `resync_required`, and the client resets its store
   and pulls without a cursor, when it names an xid the cluster has not assigned
   (`> pg_snapshot_xmax`, a restored or replaced database), or when it predates the oldest row the
   change tables still hold. Rows are kept `SYNC_RETENTION_DAYS` (30); the housekeeping cron
   (increment 12) purges older ones and must purge in `seq` order so "the oldest retained row" is
   an exact horizon. A cursor from before the first change row a fresh cluster ever wrote is judged
   stale once; the cost is one snapshot pull.
7. **The operational guards.** The watermark is CLUSTER-GLOBAL: one long writing transaction
   anywhere freezes the feed for every user until it ends. `statement_timeout` and
   `idle_in_transaction_session_timeout` are set on the app role per environment
   (docs/schema-review.md section 12), and the admin page (increment 12) shows the watermark lag
   (`now()` minus the start of the oldest transaction holding an xid). The route reads the
   PRIMARY: whether a Neon read replica's `xmin` can trail the primary's is undocumented, and a
   watermark that moved backwards would skip rows. The Hyperdrive binding points at the primary
   endpoint, and every pull reads `transaction_read_only` in the statement that reads the
   watermark and refuses to serve from a read-only connection.

## Consequences

- Easier: correctness does not depend on clocks, on commit order, or on the persist queue's
  delivery order; the late-commit hazard has a real two-connection test
  (`test/workers/sync.late-commit.test.ts`), and pagination under concurrent inserts is tested to
  neither skip nor repeat.
- Harder: one idle-in-transaction session anywhere in the cluster stalls every client's feed (the
  guards above are what bound it); two change tables instead of per-subscriber fan-out; the
  envelope is versioned (`rpcVersion`) because the mobile store is built on it.
- Committed to: never upserting or updating a change row; writing every change row in its
  entity's transaction; the primary endpoint for this route; purging in `seq` order.
- Reversibility: medium. The cursor is opaque, so its encoding can change behind a 410; the two
  tables and the watermark rule are what the mobile store's apply logic assumes.

## Alternatives considered

| Option                                           | Why not                                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `max(seq)` cursor over one identity column       | The late-commit hazard: a row that took its `seq` early and committed late is skipped for good.                             |
| `updated_at > since` (the dossier's flight half) | `now()` is the transaction start; the same hole, wider.                                                                     |
| Per-subscriber fan-out of flight changes         | A popular flight writes one row per subscriber per change, unbounded; the shared `flight_sync_changes` row is written once. |
| Logical replication or `pg_logical_emit_message` | Not available through Hyperdrive to a Worker; far more machinery than two tables and a watermark.                           |
| Commit timestamps (`track_commit_timestamp`)     | Off by default on Neon, and a timestamp cursor still needs a watermark for transactions in flight.                          |

## References

- https://www.postgresql.org/docs/18/functions-info.html
- https://www.postgresql.org/docs/18/transaction-id.html
- https://www.postgresql.org/docs/18/functions-datetime.html
- https://www.postgresql.org/docs/18/sql-insert.html
- https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/
- `docs/increments/08-flight-routes-and-sync.facts.md` section 1
