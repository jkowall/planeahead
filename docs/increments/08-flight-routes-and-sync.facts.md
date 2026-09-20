# Increment 8 facts (verified 2026-09-20)

Sources are primary unless noted. Every unconfirmed item is tagged **(unverified)**. Contradictions with `docs/plans/phase0-plan.md` or `docs/research/phase0-dossier.md` are tagged **PLAN CONFLICT**.

## 1. xid8 sync cursor

- `pg_current_xact_id()` returns `xid8`, assigns an xid if none exists, and returns the top-level id inside a subtransaction (https://www.postgresql.org/docs/18/functions-info.html).
- `pg_snapshot_xmin()` is the "lowest transaction ID still active"; every xid below it is committed-and-visible or aborted-and-dead. This single sentence is the whole safety argument for the watermark (https://www.postgresql.org/docs/18/functions-info.html).
- An xid is assigned at first write, not at transaction start, and "the order in which transactions perform their first database write might be different from the order in which the transactions started" (https://www.postgresql.org/docs/18/transaction-id.html). This is the late-commit hazard that kills a `max(seq)` or `updated_at` cursor.
- `xid8` is 64-bit, never reused in the cluster lifetime, and has btree and hash opclasses, so `<`, `ORDER BY` and index scans work (https://www.postgresql.org/docs/18/datatype-oid.html, https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/include/catalog/pg_opclass.dat).
- A volatile function is legal as a column `DEFAULT` (the docs' own example is `CURRENT_TIMESTAMP`) but illegal in a `GENERATED` column, which requires immutability (https://www.postgresql.org/docs/18/sql-createtable.html).
- A `DEFAULT` fires only on insert, so it is not applied on the `DO UPDATE` branch of `ON CONFLICT`. Never update or upsert the change log (https://www.postgresql.org/docs/18/sql-insert.html).
- `now()` / `CURRENT_TIMESTAMP` return transaction start time, so an `updated_at` cursor silently loses rows (https://www.postgresql.org/docs/18/functions-datetime.html).
- **PLAN CONFLICT (medium).** The dossier section 5 specifies the flight-state half of the feed as `flight_instances.updated_at > since_ts`. That reintroduces exactly the hazard the xid8 cursor exists to remove. Use a second `flight_sync_changes` outbox keyed by `flight_instance_id`, sharing one watermark computed once in the outer CTE.
- **PLAN CONFLICT (low).** Plan section 6's "deleted_at tombstones only on sync entities" is not the delete mechanism; `op = 'delete'` in the change log is. Keep `deleted_at` for the partial unique index and LWW, and say so in `schema-review.md`.
- Row-value comparison `(xid, seq) > ($1::xid8, $2::bigint)` is valid (https://www.postgresql.org/docs/18/functions-comparisons.html), but **(unverified)** whether it drives a multicolumn index scan. Confirm with `EXPLAIN` on a Neon PG18 branch; fall back to the expanded `OR` form.
- Hyperdrive pools in transaction mode and "a single Worker invocation may obtain multiple connections", so the entity write and its change row must share one `sql.begin()` (https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/).
- postgres.js has no parser for the `xid8` OID, so it round-trips as a decimal string. Never `Number()` it (https://github.com/porsager/postgres/blob/master/src/types.js).
- Drizzle 0.45.2 has no `xid8` type and no row-constructor helper; `customType` in 0.45.2 has only `dataType`/`toDriver`/`fromDriver`, not the `codec` field the website documents (https://raw.githubusercontent.com/drizzle-team/drizzle-orm/0.45.2/drizzle-orm/src/pg-core/columns/custom.ts). Write the schema against source, not the site.
- The watermark is cluster-global: one long writing transaction anywhere freezes the feed for every user. Mitigate with `statement_timeout`, `idle_in_transaction_session_timeout`, and a lag metric.
- **(unverified)** Whether a Neon read replica's `xmin` can lag the primary. Pin the sync route to the primary endpoint permanently and assert it.

## 2. Routes, idempotency, caps, coalescing

- Un-hooked `zValidator` answers `c.json(result, 400)` with the raw Zod safeParse object, not the PlaneAhead envelope. Supply a hook on every validator; the hook receives `{ data, ...result, target }` and its return type flows into the RPC surface (https://raw.githubusercontent.com/honojs/middleware/%40hono/zod-validator%400.9.1/packages/zod-validator/src/index.ts).
- `query` values are typed `string | string[]`; Zod query schemas must handle arrays (https://raw.githubusercontent.com/honojs/hono/main/src/types.ts).
- `app.route()` returns a new Hono type and never retypes the receiver, so registering the Better Auth mount with a discarded return keeps it out of `AppType`. This closes the open question at `docs/increments/04-api-bootstrap.facts.md` line 132 (https://raw.githubusercontent.com/honojs/hono/main/src/hono-base.ts).
- Export a pre-compiled `hcWithType` so the mobile app does not instantiate the server type graph (https://raw.githubusercontent.com/honojs/website/main/docs/guides/rpc.md).
- The Cloudflare rate limit binding is per-colo, "permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting system" (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). **PLAN CONFLICT (design intent):** none of the free-tier caps may be enforced with it. Burst protection only; all caps go in `usage_counters`.
- **(unverified)** whether the binding enforces under `@cloudflare/vitest-plugin`. Write the 429 test so a vacuous pass is impossible (https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/).
- `ON CONFLICT DO UPDATE` is atomic under high concurrency, and a row locked but not updated because the `WHERE` failed is not returned by `RETURNING`. Zero rows means cap hit (https://www.postgresql.org/docs/18/sql-insert.html).
- Under Read Committed a blocked `UPDATE` re-evaluates its `WHERE` against the updated row, which makes the counter-row increment race-safe with no explicit locking. A `select count(*) < 5` guard inside an `INSERT` is provably unsafe, because an insert creates no row to lock (https://www.postgresql.org/docs/18/transaction-iso.html).
- Stripe saves status **and** body, prunes keys after 24 h, and marks replays with `Idempotent-Replayed: true` (https://docs.stripe.com/api/idempotent_requests). The plan's `idempotency_keys` table needs a `response_status smallint` column added.
- **PLAN CONFLICT (task framing).** The brief says 409 for a key reused with a different payload. The IETF draft says 422 for payload mismatch and reserves 409 for the in-flight retry (https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header).
- **PLAN CONFLICT (coalescing).** Neither micro-cache option works. `cache.put` throws on non-GET and the Cache API is per-colo (https://developers.cloudflare.com/workers/runtime-apis/cache/); KV is eventually consistent up to 60 s and caches negative lookups (https://developers.cloudflare.com/kv/concepts/how-kv-works/). The DO in-flight promise is the only correct coalescer.
- "Awaiting async operations like `fetch()` opens the input gate, allowing interleaving", so coalescing needs an explicit `#inflight` promise assigned before the first await (https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/). In-memory state is lost on eviction, so the daily refresh budget must live in DO SQLite.
- There is no platform timeout on a DO RPC while the caller stays connected (https://developers.cloudflare.com/durable-objects/platform/limits/). The route must race the RPC against its own timer.
- `locationHint` is honoured only on the first `getByName` for an object and location never changes afterwards, so pass it on every call (https://developers.cloudflare.com/durable-objects/reference/data-location/).

## 3. Account deletion

- Apple 5.1.1(v) requires in-app deletion; guest accounts must also be deletable; deletion need not be immediate if the duration is disclosed; reauthentication steps are permitted (https://developer.apple.com/app-store/review/guidelines/, https://developer.apple.com/support/offering-account-deletion-in-your-app/). The guest rule means `POST /v1/me/delete` must accept an anonymous session.
- TN3194: "If you don't have the user's refresh token... you must still fulfill the user's account deletion request." Revoke is best-effort, logged, never fatal (https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple).
- `/auth/revoke` returns 200 with no body whether it revoked or the token was already invalid, so retries are safe and 200 proves nothing (https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens). **(unverified)** the 400-level error enumeration; do not branch on it.
- Better Auth 1.7.5 `freshAge: 0` is global and also disables `freshSessionMiddleware`, which guards account linking (https://github.com/better-auth/better-auth/blob/v1.7.5/packages/better-auth/src/api/routes/session.ts). `sendDeleteAccountVerification` needs a deliverable email, which anonymous users lack (https://github.com/better-auth/better-auth/blob/v1.7.5/packages/better-auth/src/api/routes/update-user.ts).
- `internalAdapter.deleteUser` touches only session, account and user, and is **not** wrapped in a transaction (https://github.com/better-auth/better-auth/blob/v1.7.5/packages/better-auth/src/db/internal-adapter.ts). Everything else in the 61-table schema is ours.
- **PLAN CONFLICT (medium).** Cloudflare: "it is not recommended to wrap multiple database operations with a single transaction... Doing so will affect the performance and scaling of Hyperdrive" (https://developers.cloudflare.com/hyperdrive/configuration/how-hyperdrive-works/). The brief's "DO RPC unsubscribe per subscription inside the delete transaction" must be reordered: read, close, unsubscribe, revoke, then one short transaction of ordered DELETEs.
- Sibling `WITH` sub-statements share one snapshot and run in unpredictable order, so a single multi-CTE cascade is unsafe (https://www.postgresql.org/docs/18/queries-with.html). Use ordered separate DELETEs.
- Default FK action is NO ACTION and is deferrable; RESTRICT is not. Enumerate every `users`-referencing FK per table. PostgreSQL does not index FK columns automatically (https://www.postgresql.org/docs/18/ddl-constraints.html).
- Neon history window defaults to 1 day on paid plans, so effective erasure latency equals that window (https://neon.com/docs/introduction/history-window). Plan open decision 13 is already the default; set it explicitly anyway.
- Google Play requires both an in-app path and a public web deletion URL, plus disclosure of retained categories (https://support.google.com/googleplay/android-developer/answer/13327111). **(unverified)** any Play completion SLA. GDPR Art. 17(3)(b)(e) covers the surviving audit and billing tables (https://gdpr-info.eu/art-17-gdpr/).
- RevenueCat: `DELETE /v1/subscribers/{id}` is sufficient but not mandated, and deletion does not cancel the store subscription (https://www.revenuecat.com/docs/dashboard-and-metrics/customer-profile). Phase 0 ships a flagged-off stub.
- **(unverified)** whether a DO RPC counts against the 10,000 subrequest limit. Immaterial at 100 subscriptions.

## 4. Mobile offline store (informs the envelope)

- `useLiveQuery` re-runs only when the change event's `tableName` equals the query's **root** table; no join awareness, no debounce (https://raw.githubusercontent.com/drizzle-team/drizzle-orm/main/drizzle-orm/src/expo-sqlite/query.ts). **PLAN CONFLICT (medium)** with plan section 11's joined list: denormalise the flight snapshot onto the local `flight_subscriptions` row. A VIEW does not help, since the update hook reports base table names.
- Every changed row fires its own event, so an N-row page triggers N full re-queries (https://www.sqlite.org/c3ref/update_hook.html). Drizzle's Expo session is fully synchronous and blocks the JS thread (https://registry.npmjs.org/drizzle-orm/0.45.2). Together these cap the page size.
- `sqlite3_update_hook` skips `WITHOUT ROWID` tables, `ON CONFLICT REPLACE` deletes, and the truncate optimization. Ban all three in the offline store.
- **PLAN CONFLICT (medium).** `withExclusiveTransactionAsync` opens a second connection and issues a plain deferred `BEGIN` (https://raw.githubusercontent.com/expo/expo/sdk-57/packages/expo-sqlite/src/SQLiteDatabase.ts). Use `db.transaction(cb, { behavior: 'immediate' })`; in WAL, IMMEDIATE equals EXCLUSIVE (https://www.sqlite.org/lang_transaction.html).
- `expo-sqlite/kv-store` is a separate database file, so the cursor cannot be written atomically with the page (https://raw.githubusercontent.com/expo/expo/sdk-57/packages/expo-sqlite/src/Storage.ts). Cursor goes in a `sync_state` table in the app database.
- The claimed 2 GB expo-sqlite limit does not exist **(unverified as stated, and most likely wrong)**; the real constraint is `SQLITE_MAX_VARIABLE_NUMBER` 32766 (https://www.sqlite.org/limits.html).
- **PLAN CONFLICT (low, docs only).** The Drizzle Expo guide installs `drizzle-orm@rc expo-sqlite@next`, which breaks the pinned toolchain (https://orm.drizzle.team/docs/connect-expo-sqlite).

## Decisions the orchestrator must take

1. **Idempotency mismatch status: 422 (IETF) or 400 + `idempotency_error` (Stripe parity).** Recommend 422 with 409 reserved for in-flight retry; trade-off is losing Stripe parity for teams that already know Stripe's shape.
2. **Persist 4xx idempotency results.** Recommend yes, unlike Stripe, because the mobile outbox replays blindly; trade-off is that a client bug can permanently cache its own validation error under that key.
3. **Flight-state feed mechanism.** Recommend a second `flight_sync_changes` table sharing one watermark; trade-off is a second table versus per-subscriber fan-out that is unbounded on popular flights.
4. **Refresh route deadline.** Recommend 8 s then 504 with last-known state, DO keeps working; trade-off is a client-visible failure where 202 plus sync follow-up would be smoother but needs mobile work in increment 9.
5. **Own `POST /v1/me/delete` rather than Better Auth `/delete-user`.** Recommend own route with `freshAge` left at default; trade-off is writing the cascade ourselves instead of inheriting three statements that are not transactional anyway.
6. **Deletion ordering.** Recommend read, unsubscribe DOs, Apple revoke, then one short Postgres transaction; trade-off is a crash window between the DO unsubscribes and the commit, which is benign because unsubscribe must be idempotent.
7. **Cap enforcement point.** Recommend `usage_counters` row as the serialization point with a nightly reconciliation job added to the cron list; trade-off is counter drift requiring repair versus a provably unsafe `count(*)` guard.
8. **Anonymous per-IP cap key.** Recommend `HMAC(daily salt, CF-Connecting-IP)`; trade-off is losing the ability to debug an abusive IP directly.
9. **Sync page size and envelope.** Recommend 200 rows, server-enforced with `hasMore`, flights as a sibling array keyed by `flight_key`; trade-off is more round trips on first sync against a blocked JS thread and 200 live-query re-runs.
10. **Phase 0 entity set.** Recommend shipping `trips` and `logbook_entries` in the enum with empty tables; trade-off is one unused migration now versus a breaking envelope version in Phase 2.
11. **`user_sync_changes` FK to users.** Recommend no FK, explicit delete by `user_id`, matching the GDPR posture; trade-off is that a missed delete leaves orphans with no constraint to catch it.
12. **Reserve `POST /v1/webhooks/apple` now.** Recommend reserving the route in increment 8, handler in Phase 1; trade-off is dead code until then, against a developer-portal change later.

## Pins

| Item | Value | Source |
|---|---|---|
| PostgreSQL | 18 (Neon default for new projects) | https://neon.com/blog/postgres-18 |
| drizzle-orm | 0.45.2 (schema written against source, not the website) | https://registry.npmjs.org/drizzle-orm/0.45.2 |
| drizzle-kit | 0.31.10 (`driver: 'expo'` bundles `migrations.js`) | https://registry.npmjs.org/drizzle-kit/0.31.10 |
| @hono/zod-validator | 0.9.1, hook required on every validator | https://raw.githubusercontent.com/honojs/middleware/%40hono/zod-validator%400.9.1/packages/zod-validator/src/index.ts |
| expo-sqlite | 57.0.3 (SDK 57), `enableChangeListener: true`, WAL in `onInit` | https://registry.npmjs.org/expo-sqlite |
| Sync page size | 200 rows, server-enforced, `hasMore` loop | derived from sync-exec + update-hook fan-out |
| Sync cursor wire format | `base64url("<xid8>:<seq>")`, opaque, strings only | https://www.postgresql.org/docs/18/functions-info.html |
| Cursor predicate | `xid < pg_snapshot_xmin(pg_current_snapshot()) AND (xid, seq) > ($1::xid8, $2::bigint)` | same |
| Truncated-page cursor | `(last.xid, last.seq)`; full drain returns `(hw, 0)` | seq identity starts at 1 |
| Idempotency TTL | 24 h, `(user_id, key)` PK, add `response_status smallint` | https://docs.stripe.com/api/idempotent_requests |
| Replay header | `Idempotent-Replayed: true` | same |
| Rate limit periods | `simple.period` must be 10 or 60; burst only | https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ |
| DO coalesce | `#inflight` promise + 60 s freshness, budget in DO SQLite | https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/ |
| Refresh route deadline | 8 s, race the RPC, DO continues | https://developers.cloudflare.com/durable-objects/platform/limits/ |
| Hyperdrive | primary endpoint, caching disabled, max statement 60 s, ~100 connections | https://developers.cloudflare.com/hyperdrive/platform/limits/ |
| Neon history window | 1 day, set explicitly | https://neon.com/docs/introduction/history-window |
| Better Auth | 1.7.5, `deleteUser.enabled` false, `freshAge` default | https://github.com/better-auth/better-auth/blob/v1.7.5/packages/better-auth/src/db/internal-adapter.ts |

## Appendix: open questions per research topic

### xid8-sync-cursor (32 facts, 0 unverified)

- Does a row-value comparison (xid, seq) > ($1::xid8, $2::bigint) actually drive an index scan on (user_id, xid, seq) in PostgreSQL 18? Neither functions-comparisons.html nor indexes-multicolumn.html documents it. Confirm with EXPLAIN (ANALYZE, BUFFERS) on a Neon PG18 branch in increment 8, and fall back to the expanded OR form if not.
- Does a long-running READ-ONLY transaction hold back pg_snapshot_xmin? The docs say xids are assigned on first write and that xip_list holds only top-level xids, which implies no, but the conclusion is never stated and I did not test it. This decides whether a stray idle-in-transaction psql session freezes the feed for every user.
- Can a Neon read replica's pg_current_snapshot() xmin lag the primary's, and by how much? Not documented by Neon. If yes, the watermark can move backwards across requests, so the sync route must be pinned to the primary endpoint permanently and that must be asserted, not merely configured.
- Does Neon's autovacuum, logical replication, or its own control-plane background work hold long-lived writing transactions that would pin the watermark on a scale-to-zero staging branch? Measure the watermark lag metric on staging for a week before production.
- What is the exact OID of xid8, and does postgres.js need an explicit ::xid8 cast for the bound cursor parameter or does server-side inference from the column type suffice? I verified only that xid8 is absent from postgres.js's parser map, not the OID value or the inference behaviour. Use the explicit cast until measured.
- Retention horizon for user_sync_changes and flight_sync_changes, and the client behaviour when a cursor predates the purge. Recommend 30 days plus a 410 with a resync token, but the mobile side of that contract is not in the plan and needs a decision before increment 9.
- Does user_sync_changes have an FK to users with ON DELETE CASCADE, or is deletion explicit by user_id? Plan section 6 groups it under Identity (implying an FK) while also saying user-owned rows carry a denormalised user_id. The synchronous account delete in increment 8 needs this settled.

### hono-routes-idempotency-caps (50 facts, 4 unverified)

- Which idempotency status code does PlaneAhead adopt for a key reused with a different payload: 422 (IETF draft) or 400 with code idempotency_error (Stripe parity)? The mobile outbox branches on this, so it must be fixed in the increment 8 spec, not left to the implementer.
- Does the idempotency middleware persist 4xx validation failures? Hono runs zValidator after middleware, so the reservation exists before the body is validated. Stripe does not save results for requests that fail parameter validation, but the mobile outbox replays blindly. Recommend persisting all terminal responses and making that explicit.
- Does the rate limit binding enforce under @cloudflare/vitest-plugin? If not, the increment 8 acceptance criterion 'route tests pass including 429' must be met against the Postgres usage_counters path rather than the binding, or via a fake binding injected in tests.
- Should the FlightTracker locationHint be derived from the origin airport region, and where does that mapping live? It is only honoured on the first getByName for a given object and can never be changed afterwards, so getting it wrong is permanent for the life of that flight key.
- What is the refresh route's client-facing deadline? There is no platform timeout on a DO RPC, so the number (suggested 8 s) and the behaviour on timeout (504 with the last known state, versus 202 plus a sync-feed follow-up) need a decision.
- How do the 5-active and 2-live subscription counters get repaired after drift? The counter row is the serialization point and the subscriptions table is the truth; a nightly reconciliation job is not currently in the plan's cron list (only reconcile, housekeeping, ae-rollup).
- Is the anonymous per-IP cap keyed on a salted hash of CF-Connecting-IP with a daily rotating salt? Storing raw IPs in usage_counters would put PII class 2 data in a table with no retention story.
- Does POST /v1/flights/:id/refresh accept an Idempotency-Key? It is a POST that mutates a budget counter, but its effect is already coalesced and rate-capped. Recommend no key required, and no idempotency_keys row, to keep the 24 h table small.

### account-deletion (43 facts, 4 unverified)

- What happens to a second signed-in device after deletion? The cascade destroys user_sync_changes, so GET /v1/sync cannot report the deletion as a change feed event. The device will get a 401 on its next call. Increment 8 must specify that a 401 with a distinguishable code causes the client to wipe the expo-sqlite store and the outbox, and increment 9 must implement it, or the other device keeps showing a deleted user's flights indefinitely.
- Which surviving table is authoritative for blocking re-linking, and for how long is deleted_subjects itself retained? A row that lives forever is its own retention liability. Propose a TTL tied to the longest legitimate need (late RevenueCat webhooks, Apple consent-revoked notifications) and purge it in the housekeeping cron.
- Exactly which value is hashed into deleted_subjects.subject_id, and is a plain digest safe for it? High-entropy inputs such as the Apple sub and the random rc_app_user_id are fine; anything derived from an email address needs HMAC under a secret held outside the database.
- Does a Durable Object RPC call count against the Workers 10,000 subrequest limit? Neither the Workers nor the Durable Objects limits page says. Immaterial at the current caps of 5 free and 100 Pro active subscriptions, but it constrains any future raise.
- Should the account_deletion_requests table be written on the synchronous path in Phase 0, or only once deletion becomes a queued job in Phases 5 to 7? It exists in the 61-table schema but has no writer in the synchronous design.
- Does PlaneAhead need the Apple server-to-server notification endpoint registered before the first TestFlight build? The URL is a per-primary-App-ID setting in Certificates, Identifiers and Profiles, so decide the hostname now even if the handler is a Phase 1 stub.
- What is Apple's actual error-code enumeration for /auth/revoke? Still unverified after two attempts; the ErrorResponse documentation page did not yield extractable content. Do not write code that branches on it until someone observes the responses against a real Apple developer account.
- Is there a cadence for TN3194's 'validate the refresh token up to once per day' expectation, and does Phase 0 need it? A refresh token stored at sign-in and never exercised until deletion may be stale precisely when it matters. Likely a Phase 1 cron, but the increment 8 spec should record the dependency.

### mobile-sync-store (32 facts, 3 unverified)

- Can an onDatabaseChange event re-enter JS synchronously from inside a *Sync call? If yes, a synchronous Drizzle transaction could be interrupted by a live-query read and the whole 'one exclusive transaction' argument weakens. Increment 9 should assert zero listener invocations before a synchronous transaction returns.
- What is the measured wall-clock cost on the Pixel AVD of applying a 200-row page synchronously, and the cost of the resulting 200 live-query re-runs? If the re-runs dominate, the coalescing wrapper becomes mandatory rather than recommended, and 200 may need to drop to 100.
- Does the plan's 'read-only flight snapshot join' survive as a separate local flight_instances table, or should the snapshot columns live only on flight_subscriptions? A separate table is cleaner for the detail screen but needs its own live query; the denormalized form is cheaper for the list. Increment 8's envelope shape depends on which one increment 9 picks.
- Does increment 8's sync feed emit one change row per entity per transaction, or can one transaction produce several rows for the same entity id? The client apply is idempotent either way, but the 200-row page budget assumes roughly one row per changed entity.
- The outbox drain and the sync apply both write to the same connection. Confirm the drain is suspended while a page is applying, or that both run on the same synchronous queue, otherwise a concurrent drain hits the write lock. This was not testable from the docs.
- AsyncStorage v3 changed to an instance-based API and the live docs no longer publish a limits page, so the 6 MB Android figure is sourced from the v1.23.2 docs tree. If anything in the app still needs AsyncStorage (a third-party SDK, for instance), the current v3 Android backend and its limits need re-checking.
- Is drizzle-kit 0.31.10's `driver: 'durable-sqlite'` bundle output usable for the increment 7 DO migration runner, which the plan currently describes as a hand-written PRAGMA user_version runner? Out of scope here but the same generator serves both.

