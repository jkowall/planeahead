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
   records a flight's snapshot. `xid` is `xid8 not null default pg_current_xact_id()`; `seq` is a
   `bigint` drawn from ONE sequence for both tables (`user_sync_changes`' identity sequence, which
   `flight_sync_changes.seq` defaults to; item 3 says why). Rows are only ever INSERTED, always
   inside the same `db.transaction()` as the write they record: the route's subscription,
   tombstone or preference write, the anonymous-to-account merge's moves and tombstones (ruling
   O2), and the persist consumer's `live_tracked` decisions (ruling O3) for the first table; the
   persist consumer's monotonic `flight_instances` upsert for the second, and only when that upsert
   changed the row (`RETURNING`), so a replayed or stale queue delivery adds nothing. A column
   `DEFAULT` never fires on the `DO UPDATE` branch of `ON CONFLICT`, which is why neither table is
   ever upserted.
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
   `(xid, seq)`. The persist consumer writes BOTH tables in one transaction (the upsert's
   snapshot row, and the `user_sync_changes` rows of the `live_tracked` decisions it takes where a
   flight enters or leaves its live window, ruling O3), so one xid can carry rows in both; the two
   tables therefore draw `seq` from one sequence, a pair names at most one row across them, and
   the merged order is total. A cursor cut at a row of one table resumes exactly after it in the
   other.
4. **The cursor.** Opaque on the wire: base64url of `"<xid8>:<seq>:<epoch>:<hash8>"` (ruling
   O12). The position halves are decimal STRINGS that never pass through a JavaScript number
   (postgres.js has no xid8 parser, and an xid8 does not fit a double); every query selects them
   `::text` and comparisons use BigInt. `epoch` is the value of the one-row `sync_epoch` table
   (migration 0003, seeded 1) when the cursor was issued, and `hash8` binds it to its principal:
   the first 8 bytes of SHA-256 over the user id, hex, no secret (forging another user's binding
   still only pages the session user's rows). A page cut at `SYNC_PAGE_SIZE` (200,
   server-enforced, the 201st row sets `hasMore`) answers its last row's position; a drained page
   answers `(watermark, 0)`, which the next pull turns into `(xid, seq) > (watermark, 0)`, i.e.
   including the watermark transaction's own rows (`seq` starts at 1). No cursor means an empty
   client: the answer is the current state of every entity the caller owns, read after the
   watermark, with cursor `(watermark, 0)`; a change committed between the two reads is served
   again by the next pull, which the client applies idempotently. That snapshot is ONE page, not
   keyset-paged: the Phase 0 caps keep it far under 200 rows (at most 100 subscriptions on any
   plan and two preference rows), and the route logs `sync_snapshot_over_page_size` if that ever
   stops holding. It becomes keyset-paged, in this envelope, in the increment that gives `trips`
   and `logbook_entries` writers, since those can outgrow a page.
   `SyncEnvelopeV1` was redefined IN PLACE by increment 8 (the entity enum keeps `trip_members`):
   no client had shipped against the earlier draft, so the "a breaking change gets a V2 envelope"
   rule starts with this definition.
5. **Flights.** A page carries `flights`, keyed by flight key, sent once however many rows name
   the flight: the latest snapshot below the watermark of every instance whose change rows are in
   the page (for the caller's live subscriptions only) and of every subscription the page
   upserts. The mobile store denormalises the snapshot onto its subscription rows because
   `useLiveQuery` watches only a query's root table.
6. **The 410 contract.** A cursor answers 410 `resync_required`, and the client resets its store
   and pulls without a cursor (on ANY 410, a sign-in included; the increment 9 spec says so), in
   exactly four cases:
   - it was issued to another principal (`hash8` differs from the session user's): a device that
     upgraded from an anonymous user to an existing account holds the anonymous user's cursor, and
     the account's older rows sit below it, so it re-snapshots and receives them;
   - it was issued on another database timeline (`epoch` differs from `sync_epoch`): a
     point-in-time restore (a Neon branch restore) makes the cluster REUSE xids the lost timeline
     issued, so an xid check alone judges such a cursor fresh as soon as the new timeline catches
     up and skips every new-timeline row at or below it; the restore runbook
     (docs/schema-review.md section 6) bumps the epoch after any restore;
   - it names an xid the cluster has not assigned (`> pg_snapshot_xmax`, a replaced database);
   - its xid is below the purge horizon H. Rows are kept `SYNC_RETENTION_DAYS` (30). The
     nightly purge (built in increment 12, `src/lib/sync-purge.ts`: H is the smallest xid younger
     than the window across both tables, capped at `pg_snapshot_xmin`, never lowered) picks ONE H
     below the watermark, deletes `where xid < H` from BOTH change
     tables and records H in the one-row `sync_horizon` table (migration 0003, null until the first
     purge), all in one transaction; the route answers 410 exactly when `cursor.xid < H`, reading H
     AFTER the page so a purge that committed before the page's statement is always seen. That is
     exact by construction. A purge in `seq` order is NOT an exact horizon, and neither is "the
     oldest retained row": a row's xid is fixed at its transaction's FIRST write and its seq at the
     change-row insert, so a transaction that wrote early and inserted its change row late holds
     the lower xid and the higher seq, and a seq-ordered purge (or a horizon read off the
     lowest-seq row) removes a row a legitimate cursor has not seen without a 410
     (`sync.late-commit.test.ts` reproduces the inversion). A horizon is also untouched by an
     account deletion, which removes one user's rows and so could move an "oldest row" forward.
7. **The operational guards.** The watermark is CLUSTER-GLOBAL: one long writing transaction
   anywhere freezes the feed for every user until it ends. `statement_timeout` and
   `idle_in_transaction_session_timeout` are set on the app role per environment
   (docs/schema-review.md section 12), and the admin page (increment 12) shows the watermark lag
   (`now()` minus the start of the oldest transaction holding an xid). The route reads the
   PRIMARY: whether a Neon read replica's `xmin` can trail the primary's is undocumented, and a
   watermark that moved backwards would skip rows. The Hyperdrive binding points at the primary
   endpoint, and every pull reads `transaction_read_only` in the statement that reads the
   watermark and refuses to serve from a read-only connection. Hyperdrive query caching stays
   DISABLED on `DB`, a correctness requirement of the no-cursor snapshot page (not only a
   performance choice, which is all ADR 0009 records): the snapshot is plain SELECTs answered
   with a cursor at a fresh watermark, and a cached result (60 s `max_age` by default) older than
   that watermark would be served with a cursor past its own changes, which would then never
   replay. The increment 12 first-deploy runbook checks it next to the primary endpoint.

## Consequences

- Easier: correctness does not depend on clocks, on commit order, or on the persist queue's
  delivery order; the late-commit hazard has a real two-connection test
  (`test/workers/sync.late-commit.test.ts`), and pagination under concurrent inserts is tested to
  neither skip nor repeat.
- Harder: one idle-in-transaction session anywhere in the cluster stalls every client's feed (the
  guards above are what bound it); two change tables instead of per-subscriber fan-out; the
  envelope is versioned (`rpcVersion`) because the mobile store is built on it.
- Committed to: never upserting or updating a change row; writing every change row in its
  entity's transaction; one `seq` sequence for both change tables; the primary endpoint for this
  route with Hyperdrive query caching off; purging by xid below one recorded horizon H, both
  tables in one transaction; bumping `sync_epoch` after every restore.
- Recorded, not built: per-plan limits. The caps in `FREE_TIER_LIMITS` are the free plan's; the
  paid plan's (Phase 1) change the numbers a cap take is checked against, not the counters, and
  arrive with RevenueCat entitlements (docs/plans/phase0-plan.md).
- Reversibility: medium. The cursor is opaque, so its encoding can change behind a 410 (as it
  did once already, when the binding and the epoch were added before any client shipped); the
  two tables and the watermark rule are what the mobile store's apply logic assumes.

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
