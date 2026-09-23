# Increment 8: flight routes, sync feed, caps, account deletion

Status: complete (2026-09-23) on branch `inc8-flight-routes`, stacked PR opened for CI. Outcome, rulings and deviations are in `docs/build-log.md` and ADR 0012; where the text below disagrees with the review rulings recorded there (the cursor bound to the user hash and a database epoch, an exact 410 horizon from a stored purge horizon rather than the oldest retained row, `live_tracked` charged where a flight enters its window, the anonymous merge writing change rows and re-pointing tracker subscriber lists, the cookie cache disabled under `/v1`, no unsubscribe after a lost refresh deadline except when the account is gone, migration 0003, 404 `flight_not_found` with `triedDates`), the build log wins. Builder: Opus 5. Reviewers: two Opus 5 lenses (concurrency and data correctness, API contract) plus orchestrator read. Branch `inc8-flight-routes` based on `inc7-flight-tracker`.

Read `docs/increments/08-flight-routes-and-sync.facts.md` first. It settles the sync cursor safety rule, the idempotency semantics, the cap enforcement point, why the refresh coalescer must be the Durable Object, and the deletion ordering Hyperdrive requires.

## Goal

The user-facing flight API and the offline contract: search, subscribe (with caps and idempotency), list, detail, delete, coalesced refresh; the server-authoritative pull sync feed with an xid8 cursor and a safe watermark; the per-user caps in `usage_counters`; synchronous account deletion that survives a failed Apple revoke; and the reserved webhook stubs. `AppType` stays complete for the mobile client.

Acceptance (Workers tests through `exports.default.fetch()` against the embedded Postgres 18 harness and the real FlightTracker with a stubbed provider): search resolves a designator and date through the DesignatorResolver and returns the canonical key; subscribing twice with the same `Idempotency-Key` replays the first response with `Idempotent-Replayed: true`, a reused key with a different payload returns 422, and a concurrent duplicate returns 409; the 6th active subscription on a free account returns 403 `cap_exceeded` and the counter row is the serialization point (a test fires 20 concurrent subscribes and exactly 5 succeed); 500 refresh calls in 60 seconds produce one provider call; a refresh whose Durable Object does not answer in 8 seconds returns 504 with the last known state; the sync feed replays a change committed by a long-running transaction that started before but committed after a newer change (the late-commit hazard), never skips a row, and pages at 200 with `hasMore`; deleting the account leaves no user-owned rows, keeps `audit_log`, `notification_deliveries`, `revenuecat_events`, `subscriptions` and `provider_calls`, unsubscribes every FlightTracker, and completes even when the stubbed Apple revoke endpoint returns 500; the rate limit test cannot pass vacuously (per the increment 4 spike, it either exercises the binding or a fake binding injected in tests).

## Routes (`/v1`, all validators wrapped in a shared helper that supplies a hook returning the PlaneAhead error envelope; query values may be `string | string[]`)

- `GET /v1/flights/search?number=&date=`: KV `search:number:{designator}:{date}` (900 s) in front of the DesignatorResolver; returns `{ flightKey, status }` or 404 `not_found`; anonymous accounts are limited to 10 tracker creations per day per salted IP.
- `POST /v1/flights` body `{ flightKey | (number, date), subscription prefs }`, `Idempotency-Key` required: caps (5 active subscriptions free, 2 concurrently live-tracked, 20 new instances per day), then `FLIGHT_TRACKER.getByName(flightKey, { locationHint })` `subscribe`, then the `flight_subscriptions` row and its `user_sync_changes` row in one `sql.begin()` on one connection.
- `GET /v1/flights`, `GET /v1/flights/:id` (KV `flight:snapshot:{key}` read-through written with `executionCtx.waitUntil`), `DELETE /v1/flights/:id` (tombstone plus change row, DO `unsubscribe`).
- `POST /v1/flights/:id/refresh`: no `Idempotency-Key`; user sub-budget 10 per flight per day in `usage_counters`; the FlightTracker's in-flight promise is the only coalescer (the Cache API cannot store a POST and KV is eventually consistent); the route races the RPC against an 8 s timer and answers 504 with the last known state when the timer wins (the DO keeps working).
- `GET /v1/sync?cursor=`: see below.
- `POST /v1/me/delete`: see below. Accepts an anonymous session (Apple requires guest accounts to be deletable).
- Stubs returning 501 with a JSON body naming the increment: `POST /v1/webhooks/apple` (Sign in with Apple server-to-server notifications, reserved now because the URL is registered per App ID), `POST /v1/webhooks/revenuecat`.
- The Better Auth mount is registered with a discarded return value so it stays out of `AppType`; export `hcWithType` for the mobile client.

## Idempotency

`idempotency_keys` keyed by `(user_id, key)` (for anonymous callers the scope is the client-owned `X-Install-Id` header, per increment 4; a keyed request with neither is 400 `idempotency_scope_missing`) with `request_hash` (SHA-256 over method, canonical path and key-sorted canonical JSON of the validated body), `response_status smallint` (migration 0002 adds it), `response_json`, 24 h TTL purged by the housekeeping cron. Reserve with `INSERT ... ON CONFLICT DO NOTHING RETURNING`: a returned row means this caller executes; no row means read the existing row and answer replay (same hash, response stored, `Idempotent-Replayed: true`), 409 (same hash, still in flight) or 422 (different hash). Terminal 4xx responses are persisted too, because the mobile outbox replays blindly. The burst limiter runs before idempotency so a 429 never consumes a key.

## Caps

Every free-tier cap is enforced in Postgres, never with the rate limit binding (per-colo, eventually consistent, documented as not an accounting system). One statement decides:

```sql
insert into usage_counters (user_id, metric, window_start, count)
values ($1, $2, $3, 1)
on conflict (user_id, metric, window_start)
do update set count = usage_counters.count + 1, updated_at = now()
where usage_counters.count < $4
returning usage_counters.count;
```

Zero rows means the cap was hit. For the non-monotonic caps (active subscriptions, live-tracked) the counter row is the serialization point and is decremented on unsubscribe; a nightly reconciliation (added to the housekeeping cron in increment 12) repairs drift against `flight_subscriptions`. Anonymous per-IP caps key on `HMAC(daily salt, CF-Connecting-IP)`, never a raw IP. `PUBLIC_RL`, `USER_RL` and `EVENTS_RL` remain burst dampers only.

## Sync feed

- Two change tables share one watermark: `user_sync_changes (user_id, xid xid8 not null default pg_current_xact_id(), seq bigint generated always as identity, entity, op 'upsert' | 'delete', entity_id, row jsonb, created_at)` and `flight_sync_changes (flight_instance_id, xid, seq, snapshot jsonb, created_at)` written by the persist consumer. Rows are only ever inserted (a `DEFAULT` never fires on `DO UPDATE`), always in the same `sql.begin()` as the entity write, on one connection (Hyperdrive may give a single invocation several).
- Cursor: opaque `base64url("<xid8>:<seq>")`, strings only (postgres.js has no xid8 parser; never `Number()` it). Predicate: `xid < pg_snapshot_xmin(pg_current_snapshot()) and (xid, seq) > ($1::xid8, $2::bigint)` ordered by `(xid, seq)`, page size 200 server-enforced with `hasMore`; a full drain returns `(watermark, 0)`. The watermark rule is the entire safety argument: everything below `xmin` is committed-and-visible or dead, so a transaction that took its xid early and committed late is replayed on the next call instead of skipped. Confirm with `EXPLAIN` that the row-value comparison drives the `(user_id, xid, seq)` index; fall back to the expanded `OR` form if not. The route is pinned to the Neon primary endpoint.
- Envelope: `{ serverTime, cursor, hasMore, changes: [{ entity, op, id, updatedAt, row }], flights: [FlightStatus] }` with flights as a sibling array keyed by `flight_key` (sent once for two users on the same flight; the mobile store denormalises the snapshot onto its subscription rows because `useLiveQuery` only watches the query's root table). Entities in the enum now: `flight_subscriptions`, `user_preferences`, `notification_preferences`, `trips`, `logbook_entries` (the last two empty in Phase 0 so the wire format does not change later). Retention 30 days; a cursor older than that returns 410 `resync_required` and the client resets its store.
- Operational guards: `statement_timeout` and `idle_in_transaction_session_timeout` on the app role (environment setup, documented in schema-review), and a watermark-lag metric (`now() - oldest in-progress xid start`) on the admin page, because one long writing transaction anywhere freezes the feed for everyone.

## Account deletion (`POST /v1/me/delete`)

Own route; Better Auth's `deleteUser` stays disabled (its `freshAge` gate cannot be met by passwordless users and it is not transactional). Order: (1) read the active subscriptions and the encrypted Apple refresh token, close the connection; (2) `unsubscribe` on every FlightTracker (idempotent); (3) Apple `/auth/revoke` best-effort in a try/catch, outcome written to `audit_log`, never fatal (Apple TN3194: deletion must complete without a usable token; the endpoint returns 200 whether or not anything was revoked); (4) one short transaction of ordered leaf-to-root `DELETE` statements (never a single multi-CTE statement: sibling CTEs share a snapshot and run in unpredictable order) plus a `deleted_subjects` row with `HMAC`-hashed subjects and a retention of 400 days, then `delete from users`; (5) the response tells the client to wipe its store, and any other device receives 401 `account_deleted` on its next call. The builder enumerates every `users`-referencing foreign key and states per table whether the row dies by cascade or by an explicit statement; `user_sync_changes` is deleted explicitly by `user_id`. RevenueCat `deleteCustomer` ships as a typed, flagged-off stub. The privacy disclosure that follows is "deleted immediately from the live database; encrypted change history retained up to 24 hours" (Neon history window set explicitly to 1 day).

## Migration 0002

`idempotency_keys.response_status smallint`, `flight_sync_changes` (with `(flight_instance_id, xid, seq)` index), `user_sync_changes` gains `xid xid8 not null default pg_current_xact_id()` if increment 3 did not already give it one, `(user_id, xid, seq)` index, `deleted_subjects.expires_at`. No changes to existing columns.

## Files

```
apps/api/src/routes/{flights.ts, sync.ts, me.ts (delete), webhooks.ts (stubs)}
apps/api/src/lib/{validate.ts (zValidator helper with the envelope hook), idempotency.ts (real), caps.ts, sync-cursor.ts, deadline.ts}
apps/api/src/auth/apple-revoke.ts
apps/api/test/workers/{flights.search.test.ts, flights.subscribe.test.ts, flights.refresh.test.ts, sync.test.ts, sync.late-commit.test.ts, caps.concurrency.test.ts, me.delete.test.ts, idempotency.test.ts}
packages/db/migrations/0002_*.sql, schema updates, docs/schema-review.md sections 6 and 7 (change tables, watermark rule, deletion order)
packages/shared/src/sync.ts (envelope per this spec, rpcVersion), test updates
docs/adr/0012-sync-cursor.md
```

## Constraints

- No new runtime dependencies. No `count(*)` guards inside inserts for caps. No KV or Cache API deduplication of POSTs. No `withExclusiveTransactionAsync` assumptions in the envelope design.
- Every DO call passes `locationHint` and is awaited with the route's own deadline.
- No em dashes. ESM.

## Owner tasks surfaced

- Google Play requires a public web account-deletion URL in the Data safety form before the first internal Android track (a static page plus an inbox; pulled into increment 12).
- Register the Sign in with Apple server-to-server notification URL per App ID once the hostname is fixed.
