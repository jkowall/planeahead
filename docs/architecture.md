# Architecture

Phase 0 architecture of PlaneAhead as built at the end of increment 12 (2026-09-23), with the
push transport of increment 14 (2026-09-30, section 9): what runs where, the request paths, the
Durable Object lifecycle, the outbox and persist path, the sync feed and its watermark, the crons
and housekeeping, the push path, and the environments. The last section, the refresh
cadence, is generated from `packages/shared/src/cadence.ts` and checked against the code by a test;
everything above it is prose kept honest by the tests it names. Decisions and their alternatives
are in `docs/adr/`; the data model is `docs/schema-review.md`; threats are
`docs/security/threat-model.md`; money is `docs/cost-estimate.md`; what is still open is
`docs/open-decisions.md`; the owner's setup is `docs/runbooks/first-deploy.md`.

## 1. Components

```
 iOS / Android app (Expo SDK 57)                      providers
   expo-sqlite store + outbox                          AeroDataBox (primary, polls, search)
   Better Auth Expo client                             AeroAPI (mocked in Phase 0)
        |  https (cookie session, X-Install-Id)              ^            |  webhooks
        v                                                    |            v  (path token)
 +------------------------ API Worker (planeahead-api-<env>) ------------------------+
 | Hono app: request-id, sentry, cors, rate-limit, idempotency, auth  (src/app.ts)   |
 | /health  /api/auth/*  /auth/magic-link  /.well-known/*  /v1/*  /admin  /account   |
 | queue(): persist, notify, push, provider-events, imports, reconcile,              |
 |          housekeeping, DLQs                                                       |
 | scheduled(): */15 reconcile, 03:00 housekeeping + Analytics Engine rollup         |
 +----+-------------+-------------+--------------+--------------+----------+--------+
      | RPC         | Hyperdrive  | KV           | R2           | AE       | fetch (push)
      v             v             v              v              v          v
  Durable Objects   Neon PG 18    CACHE PUBLIC   PUBLIC_BUCKET  PROVIDER_  APNs (HTTP/2)
  FlightTracker     (direct       CONFIG         PRIVATE_BUCKET CALLS,     FCM HTTP v1
  DesignatorResolver endpoint,                                  API_,      Google OAuth
  ProviderBudget    no caching)                                 PRODUCT_
  PushAuth (increment 14)                                       METRICS/EVENTS
  AirportState, UserInbox (shells)
```

- **The API Worker** is one Worker per environment (`apps/api`), Hono with a chained `AppType`
  the mobile client is typed from (ADR 0004). It owns every entry point: HTTP, the queue
  consumers and the crons. The middleware chain has exactly one definition, `createApp()` in
  `src/app.ts`, in the order request-id, Sentry, CORS, the per-IP limiter (`PUBLIC_RL`),
  idempotency (the global slot for non-`/v1` paths), auth (Better Auth session into `c.var.user`);
  under `/v1` the per-principal limiter (`USER_RL`) and the `/v1` idempotency instance follow.
- **Durable Objects**, SQLite-backed, declared with `exports` (so plain deploys only, never
  gradual ones), each with a `_sql_schema_migrations` runner under `blockConcurrencyWhile`:
  - **FlightTracker**, one per flight key (`AAL-100-2026-09-19-KJFK`, ADR 0003): polls the
    provider on the cadence, holds the subscriber list, the per-flight budget, the event log and
    the outbox (section 4). Its RPCs: `seed`, `subscribe`, `unsubscribe`, `getState`,
    `forceRefresh`, `getCostLedger`, `ingestProviderEvent`, `confirmPersisted`, `health`, and
    (increment 12) `listSubscribers`.
  - **DesignatorResolver**, one per marketing designator and origin-local date: makes the single
    provider call for an unresolved search, canonicalises the key, seeds the tracker, caches the
    answer for 24 h in its storage and 15 min in KV.
  - **ProviderBudget**, one per provider per UTC day: the provider-wide unit cap, the per-second
    token bucket and the kill switch (persisted in `CONFIG` KV).
  - **PushAuth** (increment 14), one per push credential (`apns:sandbox`, `apns:production`,
    `fcm`): mints the shared APNs provider token and exchanges the FCM access token (section 9).
  - **AirportState** (increment 18), one per airport, named by its ICAO code: the only caller
    of AeroDataBox FIDS. It caches the airport's 12-hour board buckets (one `direction=Both` call
    each, rows gzip-compressed in chunks of at most 1 MB), coalesces concurrent misses, serves
    R3's freshness ladder with stale-while-revalidate, checks coverage once a day, copies each
    bucket to KV `board:v2:{ICAO}:{bucketStartLocal}`, and purges a bucket 48 hours after it ends.
  - **UserInbox** is a schema shell for Phase 1.
- **Postgres** (Neon, PostgreSQL 18, us-east-1) is the source of truth for users, subscriptions,
  the flight registry, the sync feed and the ledgers, reached ONLY from the Worker through the
  Hyperdrive binding `DB` (one postgres.js client per request or queue batch, ADR 0009). Durable
  Objects never open Postgres (ADR 0007): their writes travel through the persist queue.
- **KV**: `CACHE` (search answers 15 min, flight snapshots, used identity tokens, the ProviderBudget
  read copy, since increment 12 the tombstones of deleted accounts' sessions, and since increment
  18 the board buckets `board:v2:{ICAO}:{bucketStartLocal}` until their purge, coverage
  `adb:coverage:{ICAO}` a day and airport references `ref:airport:{code}` a day), `PUBLIC`,
  `CONFIG` (the kill switch). Never a source of truth, never a cap.
- **R2**: `PRIVATE_BUCKET` holds finished trackers' timelines (`events/{key}@{epochMs}.json`) and
  dead-lettered messages (`dlq/{queue}/{messageId}.json`, `dlq/persist-parked/`);
  `PUBLIC_BUCKET` is reserved for share images (Phase 5).
- **Queues**: `persist` (tracker, resolver and budget outboxes into Postgres, plus the merge
  job, from increment 14 the push outcomes, and from increment 15 the forward of `notify_intent`
  rows to `notify`), `reconcile`, `housekeeping` (increment 12), `push` (increment 14: the push
  transport's consumer, section 9), `notify` (increment 15: intents into `notifications` rows and
  push jobs, section 10), and `provider-events`, `imports` (consumers are stubs until their
  phases); every queue has a dead letter queue whose consumer archives each message to R2 and
  raises an ops alert.
- **Analytics Engine**: `PROVIDER_CALLS` (one point per stored provider call, index = provider),
  `PRODUCT_EVENTS` (increment 12, one point per accepted app event, index = the analytics id),
  `API_METRICS` (reserved). Every sum weights rows by `_sample_interval`; Postgres stays the ledger.
- **Rate limit bindings**: `PUBLIC_RL` (120 per 10 s per IP), `USER_RL` (600 per 60 s per user),
  `EVENTS_RL` (300 per 60 s per IP on `/v1/events`), `BOARD_RL` (30 per 60 s, taken by user and
  by IP on the board and route-search routes, increment 18). Abuse brakes only; every quota is a
  `usage_counters` row.
- **Outside the Worker**: Cloudflare Access in front of `/admin`; Sentry (errors, scrubbed);
  Workers Logs (JSON lines, 10% sampled in production); GitHub Actions (CI, the staging and
  production deploys, the weekly native smoke, the mobile preview); from increment 14 APNs
  (`api.push.apple.com`, `api.sandbox.push.apple.com`), FCM HTTP v1 (`fcm.googleapis.com`) and
  Google's OAuth token endpoint, reached only from the `push` consumer and `PushAuth`.

## 2. Environments

| Environment | Worker                      | Host                         | Database                               | Deploy                                                                       |
| ----------- | --------------------------- | ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| local       | `wrangler dev`              | `localhost:8787`             | a developer's Neon branch              | none                                                                         |
| test        | the Vitest Workers pool     | `api.planeahead.test`        | embedded PostgreSQL 18 or CI's service | none                                                                         |
| staging     | `planeahead-api-staging`    | `api-staging.planeahead.app` | Neon `staging` branch, 0.25 CU         | every push to `main` touching the API: migrate, deploy, smoke                |
| production  | `planeahead-api-production` | `api.planeahead.app`         | Neon `main`, 0.5 CU always on          | a `v*` tag verifies; a typed manual run on the tag migrates, deploys, smokes |

Each environment has its own Durable Object namespaces, queues (suffixed `-local`, `-staging`,
none in production: a queue accepts one consumer Worker), KV namespaces, R2 buckets, Analytics
Engine datasets, rate-limit namespace ids (1001+ staging, 2001+ production, 3001+ local) and
secrets; `exports` is the only inherited key that matters, everything else is repeated per
environment in `wrangler.jsonc`. Secrets are set out of band (`wrangler secret put`), never by the
deploy. Both deploys smoke `/health` with `scripts/health-smoke.mjs`, which requires the deployed
Worker to report THIS commit's migration hash and Durable Object schema versions. The mobile
variants map onto the hosts one to one: the development build to staging, production and preview
to production (ADR 0005).

## 3. Request paths

| Path                                                                  | Who calls it                            | Auth                                                                                         | What it touches                                                                                                                                                                |
| --------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`                                                         | deploy smoke, monitors                  | none                                                                                         | build constants only (migration hash, Durable Object schema versions), no I/O                                                                                                  |
| `/api/auth/*`                                                         | Better Auth Expo client                 | Better Auth (anonymous, magic link, native Apple and Google, session refresh)                | `users`, `sessions`, `accounts`, `verifications`, `rate_limits`; the anonymous merge                                                                                           |
| `GET /auth/magic-link`, `POST /api/auth/magic-link/consume`           | a browser from the email                | the token                                                                                    | a non-consuming landing page; the consume route verifies server side                                                                                                           |
| `GET /.well-known/*`                                                  | Apple's and Google's crawlers           | none                                                                                         | the association files from vars                                                                                                                                                |
| `GET /v1/me`, `PATCH /v1/me/preferences`, `POST /v1/me/delete`        | the app                                 | session                                                                                      | Postgres; the deletion unsubscribes trackers, revokes at Apple, deletes in one transaction, writes KV session tombstones                                                       |
| `POST /v1/devices`                                                    | the app                                 | session                                                                                      | `devices`, `push_tokens` (increment 14: `appId`, permission, `registered_at`, rotation of the device's other rows of the kind)                                                 |
| `POST /v1/devices/current/invalidate`                                 | the app, before sign-out (increment 16) | session                                                                                      | `push_tokens`: every live row of every kind on the caller's device row for the installation (increment 14)                                                                     |
| `GET /v1/flights/search`                                              | the app                                 | session (anonymous accepted), always read from the session row                               | KV, `flight_designators`, then the DesignatorResolver (one provider call per designator and date) and caps                                                                     |
| `GET /v1/airports/{code}/board`                                       | the app (increment 18)                  | session; anonymous only for airports of its live subscriptions; `BOARD_RL` by user and by IP | the airport resolved in Postgres through KV, then the bucket cache (KV, else `AirportState`, the only FIDS caller); codeshares grouped, filtered after the cache, ETag and 304 |
| `GET /v1/airports/{origin}/flights/to/{destination}`                  | the app (increment 18)                  | session (anonymous accepted), always read from the session row; `BOARD_RL` by user and by IP | the origin's two buckets of the date, departures to the destination; `route_searches` caps (per user, and per salted IP when anonymous); ETag and 304                          |
| `POST /v1/flights`, `GET /v1/flights[/:id]`, `DELETE /v1/flights/:id` | the app                                 | session, `Idempotency-Key` on the POST                                                       | caps in `usage_counters`, the tracker's `subscribe` or `unsubscribe` under an 8 s deadline, then one transaction with the sync change row                                      |
| `POST /v1/flights/:id/refresh`                                        | the app                                 | session                                                                                      | the per-user refresh budget, then the tracker's coalesced `forceRefresh`                                                                                                       |
| `GET /v1/sync`                                                        | the app                                 | session                                                                                      | the two change tables below the watermark (section 6)                                                                                                                          |
| `POST /v1/events`                                                     | the app's analytics client              | none (install-scoped analytics id)                                                           | `EVENTS_RL`, one `PRODUCT_EVENTS` point per accepted event, 202                                                                                                                |
| `POST /v1/webhooks/{aerodatabox,aeroapi}/{token}`                     | the providers                           | 256-bit path token                                                                           | enqueue on `provider-events` only                                                                                                                                              |
| `POST /v1/webhooks/{apple,revenuecat}`                                | reserved (Apple, RevenueCat)            | none yet                                                                                     | nothing: 501 until the Phase 1 handlers land                                                                                                                                   |
| `GET /admin`                                                          | the operator, through Cloudflare Access | `Cf-Access-Jwt-Assertion` validated                                                          | read-only Postgres, the Analytics Engine SQL API, the Queues API, the `PushAuth` objects' status                                                                               |
| `GET`, `POST /admin/accounts/delete`                                  | the operator, through Cloudflare Access | the Access assertion; the POST also same-origin and the user id typed twice                  | a write action: `deleteAccount`, exactly as `POST /v1/me/delete`, with an audit row naming the operator                                                                        |
| `GET`, `POST /admin/push/test`, `GET /admin/push/test/result`         | the operator, through Cloudflare Access | the Access assertion; the POST also same-origin; production: allow-listed ids                | the other write action (increment 14): one test job on the `push` queue, an audit row, then the delivery row the persist consumer writes                                       |
| `GET /account/delete`                                                 | Google Play's listing, anyone           | none                                                                                         | a static page                                                                                                                                                                  |

Every non-2xx JSON answer under `/v1` is the envelope `{ error, message, requestId, ... }`
(`API_ERROR_CODES` in shared); a 401 `account_deleted` tells the app to wipe its store. The global
error handler maps SQLSTATE 23503 on a user foreign key, for a principal whose `users` row is gone
(an account deleted while the request was in flight), to that 401 as well.

## 4. The FlightTracker lifecycle

```
 search (resolver) --seed--> SCHEDULED/EXPECTED ---alarm per cadence slot---> ... ---+
      |                         |   ^                                                  |
      |  flight already over    |   | forceRefresh (user refresh, reconcile)           |
      |  (cadence has nothing   |   | ingestProviderEvent (webhook hint)               |
      v   left): no tracker     v   |                                                  v
   answer from the status    alarm(): 1. transactionSync before any I/O: attempt row,   in observed
                             per-flight debit, outbox intent, setAlarm(next)             (after the tail
                             2. fetch behind #inflight (30 s timeout)                     poll), hard cap,
                             3. apply: snapshot, events, version++, outbox rows           or MAX_LIFETIME
                             4. flush outbox to the persist queue (byte-chunked)               |
                             5. debounced KV snapshot                                          v
                                                                                        FINISHED:
    platform retries (6, from 2 s) are decided by the COMMITTED schedule:              flush, R2 archive
    a slot already advanced is skipped, a still-due slot is polled; retryCount >= 5    events/{key}@{epoch},
    re-arms 30 s out; an abandoned alarm is re-armed by the reconcile cron             final KV snapshot,
                                                                                       alarm +22 h
                                                                                            |
                                              +22 h alarm: every outbox row confirmed? ------+
                                              no: re-arm hourly (alert after the sixth);     |
                                              yes: deleteAll() (storage and alarm gone)      v
                                                                                          ABSENT
                                   a later touch of an absent object arms a 60 s cleanup alarm
```

- **Creation.** Only the DesignatorResolver creates a tracker (`seed` with the status it already
  fetched, so the first alarm never repeats the call). A search for a flight that is already over
  answers from the status and creates nothing: a finished flight never gets a second lifetime
  (ruling L9; the persist consumer refuses a newer lifetime for a terminal instance).
- **Polling.** The alarm is idempotent per cadence slot (ADR 0011): one `transactionSync` holds the
  attempt row, the per-flight budget debit, the outbox intent and the next `setAlarm`, all
  committed together before the fetch. Refreshes from outside the cadence coalesce on the in-flight
  handle and on a 60 s freshness window. Cost is bounded twice: the per-flight soft cap (2x the A2
  baseline, stretches the cadence) and hard cap (4x, stops polling), and the provider-wide daily cap
  and per-second bucket in ProviderBudget.
- **Notification policy** (increment 15, section 10). Every stored snapshot is classified against
  the previous one and the `policy_state` column; an intent becomes a `notify_intent` outbox row
  in the same transaction. A delay reaching the line or a suspected cancellation or diversion
  moves the next alarm to at most 5 minutes out for its re-read. A suspected cancellation or
  diversion is evidence, not state (review ruling Q11): the tracker stores the suspicion in its
  policy state, keeps its snapshot, phase and times (the version moves with the schedule), and
  holds the finish only while fast re-reads are left; then it finishes unconfirmed, without a
  push. A cancellation supersedes an open diversion suspicion, and after a provider read the
  policy's re-read is never at the read's own instant (review ruling Q19).
- **Subscribers.** `subscribe` and `unsubscribe` are idempotent on the subscription id; Postgres is
  the record and the list only follows it. The nightly housekeeping reconciliation (section 7) lists
  every active tracker's subscribers and makes the list follow Postgres.
- **Finish and deletion.** The flight finishes after the cadence's post-arrival tail poll, at the
  hard cap, or at `MAX_LIFETIME` (`min(scheduledIn + 6 h, actualOff + 2 x block)`); the object
  deletes itself 22 hours later, and never while an outbox row is unconfirmed.
- Measured (increment 7, re-run in increments 12 and 15 and its review round): 74 provider calls
  per A2 lifecycle, 1,204 rows written per flight including the schema DDL (budget 1,600; 1,203
  before increment 15's migration 003), 16.3 per alarm on average, largest outbox message 1,635
  bytes. Source: the line `[lifecycle] polls=74 alarms=74 rows_written_lifetime=1204 ...
per_alarm_avg=16.3 ... max_message_bytes=1635` that `test/workers/flight-tracker.lifecycle.test.ts`
  prints.

## 5. The outbox and the persist path

Durable Objects never write Postgres (ADR 0007). Every state change a tracker makes appends outbox
rows in the SAME storage transaction as the change (instance row first, then its events and
provider-call records), and after the commit sends unsent rows to the `persist` queue in
byte-chunked batches (100 messages, 240 KB, a 120 KB single-message cap). A row is deleted only
when the persist consumer CONFIRMS it (`confirmPersisted`, per tracker lifetime); an unconfirmed
row is re-sent by the next flush after a 10 s grace.

The persist consumer (`src/queues/persist.ts`) acknowledges per message and writes idempotently:
the `flight_instances` upsert is monotonic on `version` within a lifetime and records the
`flight_sync_changes` row and the `live_tracked` bookkeeping in the same transaction;
`flight_events` and `provider_calls` insert on conflict do nothing (the Analytics Engine point is
written only when the provider-call row was new); ProviderBudget's daily counters replace a
`provider_call_daily` row per object (`budget_daily`, never summed with the per-operation rows).

The dead-letter protocol. A persist message that fails five times goes to the dead letter queue,
whose consumer archives the raw body to `dlq/persist/{messageId}.json`, raises one ops alert, and
REPORTS the dead-lettering to the tracker lifetime that sent it (`confirmPersisted` with
`deadLettered`): the tracker keeps the row and re-sends it on a spacing that doubles from an hour
to a day, so a transient Postgres outage heals on the first re-send after recovery and a poison row
settles at one dead-letter event a day. The DesignatorResolver deletes its provider-call rows on
send, and the ProviderBudget object its whole storage at the end of its day, so for those two the
R2 archive is the only copy: the nightly housekeeping replays their `dlq/persist/` archives older
than an hour onto the persist queue and deletes each once sent (ADR 0011; increment 12). A message
replayed three times and dead-lettered again is parked under `dlq/persist-parked/` with an error
log instead of looping. A FlightTracker's archive is never replayed: the tracker re-sends its own
copy, so a replay would only multiply a poison row's dead-letterings; the archive stays as the
record.

Every search's provider-call record carries the flight key it resolved (increment 12: the resolver
appends its records after resolution), and a failed resolution's records carry none, so
`provider_calls` attributes spend per flight without joining by request id.

## 6. The sync feed and its watermark

`GET /v1/sync` serves two append-only change tables (ADR 0012): `user_sync_changes` (the caller's
entities, written in each entity's transaction) and `flight_sync_changes` (the snapshots of the
caller's subscribed flights, written by the persist consumer with its upsert), sharing one `seq`
sequence. The cursor is `(xid8, seq)` plus the database epoch and a hash of the user, opaque to the
client. The watermark is `pg_snapshot_xmin(pg_current_snapshot())`: a page returns only rows whose
`xid` is BELOW it, so a transaction that took its xid early and commits late (the late-commit
hazard) is never skipped, it is waited for. The watermark is cluster-global, so one long writing
transaction freezes every feed: `statement_timeout` and `idle_in_transaction_session_timeout` on
the app role bound it, and the admin page shows the lag (now minus the oldest in-progress
transaction holding an xid). The route reads the primary only and refuses a read-only connection;
Hyperdrive query caching stays disabled.

The feed carries `FlightStatus` snapshots, never `flight_events` rows: the app builds a flight's
timeline from the snapshot on its subscription row (scheduled, estimated and actual out, off, on
and in, gates, terminals, baggage; increment 10, ruling T4), and `flight_events` stay server-side
(90 days in Postgres, the finished tracker's R2 timeline for a year);
`flight_instances.timeline_summary` exists and nothing writes it in Phase 0.

Retention: 30 days, purged nightly BY XID below one horizon H (the smallest xid younger than the
window across both tables, never above the watermark, never lower than before), both tables and
`sync_horizon` in one transaction; a cursor below H answers 410 `resync_required` and the app
re-snapshots. The purge is paged so no statement nears the app role's 10 s `statement_timeout`:
each housekeeping message reads the oldest 10,001 rows in xid order (a btree on `xid`, migration
0005), moves the horizon to at most 10,000 rows further (or to the first young row, which ends
it), deletes below it and records it in one transaction, and sends a continuation; every
intermediate horizon is exact, so the 410 stays exact between steps. After a point-in-time restore the runbook bumps `sync_epoch`, which answers 410 to
every cursor from the lost timeline.

## 7. Crons and the housekeeping queue

No cron does work inline (ruling W1): each pages or plans within its CPU budget and enqueues one
message per unit of work.

| Cron                                    | CPU budget                         | What it enqueues                                                                                             |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| every 15 minutes (reconcile)            | 30 s on Paid (a 25 s wall budget)  | one `reconcile` message per active tracker whose refresh is 20 min overdue                                   |
| 03:00 UTC daily (housekeeping + rollup) | 15 min on Paid (uses milliseconds) | one `housekeeping` message per step, then one `ae_rollup` message per UTC day (yesterday and the day before) |

The housekeeping consumer (`max_batch_size` 1, `max_concurrency` 1, so one message at a time on
one connection) runs each message within a 30 s wall budget and enqueues a continuation of the
step when more is left. Every step is idempotent and re-entrant, and every message writes one
`audit_log` row (`housekeeping.{step}`) with its counts. The steps are independent and
order-insensitive: Queues delivers in best-effort order and retries and continuations reorder
messages, so the list below documents them in the order the cron sends them and nothing depends on
it (nothing chains). The steps: expired `idempotency_keys`; the paged sync purge (section 6); whole
days of `provider_calls` over 90 days whose rollup is plausible (above zero and within 20 percent of
the day's `count(*)`, the other days kept and counted); retention (notifications 90 d, export jobs 7 d, expired `deleted_subjects`, idle
`rate_limits`, expired `verifications`, `flight_events` 90 d, expired sessions, day-window counters
30 d, sync tombstones 30 d); the `usage_counters` repair against `flight_subscriptions`; the tracker
subscriber reconciliation (and the deletion of anonymous users a merge marked `deleting`); the
`dlq/persist/` replay of the resolver's and the budget object's archives; the KV session
tombstones; and the KEK re-wrap (each new wrap proven before it is written, the UPDATE conditional
on the version read). The rollup queries the Analytics Engine SQL API per provider per day with
`SUM(_sample_interval)` and replaces the per-operation `provider_call_daily` rows, recording beside
the sums the day's `count(*)` of `provider_calls` as it found it (`ledger_calls`), the fixed figure
the ledger purge judges the rollup against ninety days later, so a purge that deleted part of a
day and was retried cannot find the day implausible by its own shrunken count; a sum that is not
a number fails the message (retried, then dead-lettered with the ops alert), never a 0 row.

## 8. Observability

JSON log lines with the request id on every line (`src/observability/log.ts`); Sentry for
exceptions and ops alerts (dead letters, kill switch, stuck outboxes, lifetime rejections, a push
platform without usable credentials in production), with
bodies, headers, queries and webhook tokens scrubbed; Analytics Engine for provider calls and
product events; and the admin page (`/admin`, behind Cloudflare Access): provider calls per flight
key and per provider per day, the Durable Object schema versions, the sync watermark lag (marked
partial when the role lacks `pg_read_all_stats`), the queue depths, the sync horizon and epoch, and
the last housekeeping runs, and (increment 14) the push transport: its configuration, the
`PushAuth` objects' last mints and failures, and every push attempt's outcome by reason over the
last 24 hours. Its write actions are the operator account deletion (`/admin/accounts/delete`) for
a request that reached the support inbox, the test push (`/admin/push/test`, section 9) and,
from increment 15, the event injector (`/admin/push/inject`, section 10).

## 9. The push path (increment 14)

```
 notify (increment 15)          push queue                         APNs  /3/device/{token}
 or /admin/push/test  --job-->  (max_batch_size 5,  --6 in flight-->  (HTTP/2, ES256 bearer)
 PushJobV1: <= 50 targets        batch wait 0)                      FCM   messages:send
                                    |      ^                           (Bearer access token)
                  outcome message   |      | retryable targets, each with its own delay
                  (push_outcome)    v      | (same job id, attempt + 1)
                              persist consumer                    PushAuth objects
                              notification_deliveries upsert      apns:sandbox, apns:production,
                              dead-token invalidation             fcm: mint, cache, expire
```

- **Transport.** `PushTransport` (`src/push/transport.ts`) has two implementations behind an
  injected `fetch`, APNs and FCM HTTP v1, and maps every answer to `sent` (with the `apns-id` or the
  FCM message name), `retry` (with a delay), `invalid_token` or `failed`. The request builders
  (`src/push/payload.ts`) carry the payload contract: app data in a top-level APNs `body`
  dictionary beside `aps`, flat string FCM `data` with no `body` key that repeats `tag` and
  `channelId`, `thread-id` the flight key, `apns-collapse-id` and the Android tag
  `{kind}:{flightKey}` (64 bytes at most), `interruption-level` time-sensitive only when the job
  says so, `apns-expiration` and the FCM `ttl` at the job's `expiresAt`, every payload under 4,096
  bytes. workerd has no HTTP/2 client, so every test injects `fetch`; APNs over Workers' `fetch`
  is proven by the staging send (the admin page's test push). The Container relay, the designed
  fallback, is described in the interface's comment and not built.
- **Credentials.** `PushAuth` (one object per credential) mints the APNs ES256 provider token with
  WebCrypto from the `.p8` and serves it for 30 minutes, never minting within 20 minutes of the
  last mint, with `minted_at_ms` and the token in its SQLite storage so a restart keeps the rule;
  it exchanges the FCM service account's RS256 assertion for an access token and serves it until
  five minutes before it expires. Isolates cache what they were given until its window ends. APNs
  `ExpiredProviderToken` and FCM 401 expire the refused token (never within the floor), and a
  failed FCM exchange is not repeated within a minute of its start. The
  secrets (`APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `FCM_SERVICE_ACCOUNT_JSON`) are required
  in production and optional in staging and locally; a platform without them is held.
- **The `push` consumer** (`src/queues/push.ts`) first reads token liveness, once per batch and
  before any send (review ruling R1, which amended the increment's "no Postgres": no Postgres
  connection is in use while the sends wait, and `persist` stays the only writer): one statement
  for the `push_tokens` rows of every target the batch could send, and a target is sent only when
  its row is live and still its subject's, else it is `failed` `token_inactive` unsent; since
  increment 15 the same statement drops a target whose notification a newer one superseded
  (`failed` `superseded`, section 10); a failed read sends nothing and re-enqueues after 60 s. It
  sends each job's targets with at most six
  requests in flight (Workers' limit on connections waiting for headers), a 10-second timeout and
  every body read or cancelled, then acknowledges the job and re-enqueues only its retryable
  targets, grouped by delay in one `sendBatch` per job: FCM never sooner than 10 s, FCM 429
  honours `Retry-After` or backs off exponentially from 60 s with jitter, APNs 429 60 s, APNs 5xx
  15 minutes; a target past `expiresAt`, or whose retry would land after it, is dropped
  (`expired`), and an unconfigured platform's targets are held (`not_configured`) every five
  minutes until then, which in production raises the `push_not_configured` ops alert. The
  outcomes go to `persist` as one `push_outcome` message per job.
- **Deliveries and dead tokens** (`src/queues/push-outcomes.ts`, in the persist consumer): one
  `notification_deliveries` row per notification and token (unique key; a test push keys by its
  job id and is marked `is_test`), following the newest attempt, `sent` never undone, every
  attempt's outcome and reason kept in `attempt_log`; a redelivered outcome writes nothing. A
  token is invalidated only by APNs 410 `Unregistered` or `ExpiredToken` when it was registered
  at or before Apple's timestamp, `BadDeviceToken` and `DeviceTokenNotForTopic`, FCM
  `UNREGISTERED`, `SENDER_ID_MISMATCH`, and `INVALID_ARGUMENT` with an `FcmError` detail, and for
  APNs only when the answer was about the row's own app id and environment. `last_used_at` is each
  token's last accepted send, never written on an invalidated row.
- **Registration.** `push_tokens` carries the `app_id` (the APNs topic; an old client's
  registration is the production app's), `registered_at` (written on every registration, the 410
  guard's comparison) and the permission state. A registration locks its device row, then
  invalidates the device's other live rows of the same kind, so concurrent registrations leave one
  live row; `POST /v1/devices/current/invalidate` invalidates every kind of the caller's
  installation before sign-out, and nothing from a batch whose liveness read starts after that
  commits reaches the phone (a batch already past its read can finish its sends, within seconds
  usually and about seven minutes at worst, and a push the provider had already accepted can
  still arrive until its `expiresAt`).
- **Visibility.** The admin page's push section and "Send a test push" (section 8); the test push
  is the plan's staging smoke, sent through the real queue, consumer, `PushAuth` and transport to a
  registered, live token (in production only one of a user id in `PUSH_INJECT_ALLOWED_USER_IDS`).
  Its result page shows Apple's `apns-unique-id` for a sandbox send (the key to the Push
  Notifications Console's delivery log) and stops reloading once the job's window has passed
  without an outcome.

## 10. Notifications end to end (increment 15)

```
 FlightTracker: every stored snapshot     persist consumer            notify consumer
 (alarm, refresh, reconcile, alert   -->  forwards the intent   -->  subscribers less the muted,
 merge, re-seed) -> evaluatePolicy        to NOTIFY_QUEUE, then      push off and toggled off:
 -> one notify_intent outbox row per      confirms the outbox row    one notifications row each;
 intent, in the state transaction,        (only after the send)      live-tracked at producedAt:
 guarded by notif_dedupe                                             push jobs (<= 50 targets),
        ^                                                            no token pushed twice -->
        |                                                            push queue (section 9)
        | injectPolicyEvent: test intents, confirmed by construction, nothing stored
 /admin/push/inject (Access, same origin, an audit_log row naming the operator)
```

- **The policy** (`packages/shared/src/notification-policy.ts`, pure and provider-neutral) turns a
  pair of snapshots and the tracker's `PolicyState` into intents. A departure delay is measured
  only from an actual or estimated out (unknown is not zero: no delay rule runs on it), and only
  until out is observed. One reaching 15 minutes is held for a settle re-read at most 5 minutes
  later and pushed with the re-read's value only if it still stands (after two failed settle
  re-reads 5 minutes apart, the next cadence slot re-reads); then a move of 15 minutes or more, a
  correction under 15 (its title states the new value), and at most one delay intent per 15
  minutes, compared with 60 s of tolerance. The arrival delay, clamped at 0, moves up to its
  15-minute band at once and leaves band b only below 15b minus 5 minutes
  (`ARRIVAL_CORRECTION_MARGIN_MINUTES`); an arrival intent goes out only on a band the last
  departure intent did not imply. Origin gate changes count from T-6 h to out, destination gates
  from off to in, gates compared without case or whitespace; a flap reverting inside one
  evaluation drops both halves, a return within 10 minutes of a pushed change is a correction,
  and a first assignment is pushed only to users who opted in. A cancellation or a diversion is
  evidence, not state: the suspicion names the provider that raised it, and only that provider's
  conclusive answer decides, re-read by designator on the window's own provider (past the
  cadence's last slot, the last window's). `cancelled` confirms; a positively operating answer
  clears; `unknown`, `statusUncertain` (AeroDataBox's `CanceledUncertain` and `Unknown`), not
  found, an error or another provider's answer keeps the suspicion. Up to 3 fast re-reads 5
  minutes apart, then one at the sooner of the next cadence slot or 60 minutes, within a budget
  of 6 fast re-reads per flight; alert merges never confirm. An un-cancellation or un-diversion
  after a pushed one is confirmed the same way and pushed as a correction (the un-cancellation is
  unreachable while a confirmed cancellation finishes the tracker). An intent is time-sensitive
  within the hour before the departure's best estimate and before out; its `expiresAt` is the
  departure or arrival estimate, scheduled out plus 24 hours (cancellation) or the arrival plus 6
  hours (diversion), never less than 15 minutes after it was produced.
- **In the tracker.** `flight.policy_state` (SQLite migration 003, `SCHEMA_VERSION` 3) rides on
  the existing `UPDATE flight`, so the policy costs an on-time flight no row (1,204 rows a
  lifetime, section 4). The dedupe key `{flightKey}:{kind}:{dedupeValue}:v{version}` names the
  change sequence, so a retried alarm reproduces it and writes nothing, while a later return to a
  value pushed before gets a new one; every instance row the tracker sends has its own version. A
  snapshot showing only a suspected cancellation or diversion is not adopted: the tracker keeps
  its stored snapshot, phase and times (the version moves with the schedule), writes a
  `cancel_suspect` or `diversion_suspect` event and the policy state, and the alarm is the
  sooner of the cadence slot and the re-read. So the
  app never shows an unconfirmed cancellation, and the live-tracking slots stay as they were. The
  suspicion holds the finish only while fast re-reads are left, even past the cadence's last
  slot; then the flight finishes with the cadence's reason, without a push, and logs
  `cancel_unconfirmed` or `diversion_unconfirmed`. The hard cap and a key drift still end it.
- **Persist** forwards each `NotifyIntentV1` to `NOTIFY_QUEUE` and confirms its outbox row only
  after the send, so a finished tracker still deletes only with an empty outbox (ADR 0011). An
  instance row that ends the live window (`arrived`, `cancelled` or terminal) clears
  `live_tracked`, and the same UPDATE stamps `flight_subscriptions.live_tracked_released_at` with
  the releasing row's own Durable Object instant (`finishedAt`, else `lastRefreshedAt`, from the
  same clock as the intent's `producedAt`), never persist's wall clock; whatever takes a slot
  (persist's entering pass, the subscribe route) sets it back to null. The column is Postgres
  migration 0009 (ten migrations, `DB_SCHEMA_VERSION` 10; 0008 added `notifications.is_test`).
- **The `notify` consumer** (`src/queues/notify.ts`, `src/notify/`; batch 10, wait 1 s,
  concurrency 5) reads the flight's live subscriptions with their preferences, in runs of 500,
  and drops the muted, the users with push off and those whose toggle for the kind is off (a test
  intent on production also every user outside `PUSH_INJECT_ALLOWED_USER_IDS`). Each user left
  gets one `notifications` row, unique per user and dedupe key (a redelivery inserts none and
  reads back the first rows; `is_test` for an injection; `data` keeps the intent's fields and its
  `producedAt`). Only subscriptions live-tracked when the change happened are pushed: flagged
  `live_tracked`, or released at or after the intent's `producedAt`, so the alarm that confirms a
  cancellation and finishes the flight in the same flush still reaches its devices; a
  subscription the cap refused is never stamped, so the free tier's cap holds
  (`docs/open-decisions.md` section 8). A token that already has a `notification_deliveries` row
  for its recipient's notification is skipped (logged `already_delivered`): the finished
  tracker's +22 h re-send of an intent whose confirmation was lost pushes nothing again, while a
  redelivery after a failed `sendBatch` (no delivery row yet) still sends. The rest get one
  target per live `apns` or `fcm` token whose permission is not `denied` or
  `undetermined`, `subjectId` the token's user, in jobs of at most 50 targets per time format,
  each naming its kind's Android channel (`flight_changes`, or `flight_delays` for delays) and
  the collapse id `{kind}:{flightKey}`. The text is plain and self-contained, airport-local
  times in the user's 12 or 24 hour clock, the designator as the app writes it (`AA100`). The
  jobs go out in as few `sendBatch` calls as 100 messages and 256 KB allow, and the intent is
  acknowledged after the last.
- **`notify`'s retries** are bounded by the intent's relevance (review ruling Q2): once persist
  has confirmed the forward, the notify message is the only copy, so the queue's `max_retries` is
  100 in every environment and a failure retries after `min(120, 2^attempts)` seconds (delivery
  follows a recovery within two minutes; about 3.17 hours of runway). When the next attempt would
  land past the intent's `expiresAt`, notify acknowledges and logs `notify_intent_expired`
  instead; at attempt 6 it raises the `notify_intent_failing` ops alert once while the retries
  continue. The dead-letter alert stays for poison; `dlq/notify/` is archived, never replayed (a
  nightly replay would arrive 1 to 27 hours late).
- **Superseded pushes** (review ruling Q16). The push consumer's one liveness read (section 9)
  also answers which targets' notifications a newer row for the same user, kind and flight has
  superseded; such a target is not requested (`failed`, reason `superseded`), so a first push
  retried after an APNs 5xx cannot land after its correction. Newer is ordered by the intent's
  `producedAt` from `data`, then `created_at` and the id, so an older intent that waited out an
  outage in notify's retries never supersedes a newer one. A test row never supersedes a real
  one, and the admin page's test push names no notification.
- **Preferences.** `notification_preferences` holds `push_enabled` and the per-kind `events`
  toggles (delay, gate change, first gate assignment off by default, cancellation, diversion),
  read and written through `GET` and `PATCH /v1/me/preferences` (a nested `notifications` object
  beside the display preferences); a tombstoned preferences row reads as the defaults there, as
  in notify (review ruling Q18); muting is the subscription's own flag.
- **The event injector** (`/admin/push/inject`, src/routes/admin-inject.ts) reads a tracker's
  snapshot (`getState`), applies one event to a copy (an origin or destination gate, a departure
  delay of N minutes, a cancellation, a diversion), and calls `injectPolicyEvent` with a fresh
  UUIDv7 injection id: the tracker classifies the copy with the same policy, confirmed by
  construction, writes test intents keyed `{flightKey}:{kind}:{dedupeValue}:test:{injectionId}`
  through the same outbox, and stores neither the copy nor the policy state, so the next real poll
  finds no change back. The answer lists each intent and whether it was written, with a button
  replaying the same id (which writes nothing). On production only a flight a live subscriber in
  `PUSH_INJECT_ALLOWED_USER_IDS` follows is accepted. The tracker ignores an injection, answered
  409, while its policy state holds a suspected cancellation or diversion (an injection is
  confirmed by construction and would decide it) or its stored snapshot is cancelled (review
  ruling Q5). The `audit_log` row naming the operator is written `pending` before the tracker
  call and settled after it as `written`, `ignored`, `timeout` or `error` (Q6).

## Refresh cadence

Since increment 15 (ruling N8) A2's 15-minute band is anchored on the departure, not on boarding:
it runs until actual out (else actual off, review ruling Q7), or until
`max(scheduled out, estimated out)` while neither is observed, and the 30-minute band starts there. An on-time flight keeps its 74 polls (24 and 6 around the
anchor instead of 22 and 8 around boarding); a ground delay of D minutes keeps the 15-minute polls
running and costs about D/30 more polls than the boarding-anchored A2 would (`groundDelayPolls`,
tested on the shared constants), and the landing gap widens from 10 to 30 minutes (R4's D3
trade-off). The tracker feeds the cadence the estimated and actual out of its stored snapshot.
A1, B and the literal brief keep the boarding anchor.

<!-- cadence:start -->
<!-- prettier-ignore-start -->

_Generated from `packages/shared/src/cadence.ts` by `pnpm --filter @planeahead/shared gen:cadence-table`. Do not edit between the markers; `packages/shared/test/cadence-table.test.ts` fails when this block drifts from the code._

Assumptions: block 180 min, boarding at T-40 min, tail stops at in+120 min, on-time flight, one creation fetch at the lead time. Slot rule: start-anchored windows yield `ceil(duration / interval)` polls, so a trailing partial slot always earns a poll and no window ends with a gap longer than its interval; the pre-48 h AeroDataBox window counts back from T-48 h (weekly: T-9 d, T-16 d, T-23 d, ...) and yields `floor(duration / interval)`; the instant on a boundary belongs to the later window; fixed-slot windows list their slots. A flight that passes its planned arrival without `in` keeps polling until `in` or `MAX_LIFETIME`: interval windows continue their grid, fixed-slot windows poll every `lateIntervalMinutes` from the planned arrival. Prices are list prices from `cost.ts` (AeroAPI status $0.005, alert delivery $0.020; AeroDataBox 2 units per status call at $0.00025 per unit on Growth).

### Windows inside 48 h (AeroAPI)

| Window                             | Literal brief                        | A1 polls only                                              | A2 polls + alerts                | B ADB webhooks + AeroAPI OOOI alerts |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------------------- | -------------------------------- | ------------------------------------ |
| Hourly window                      | 1 h interval, T-48h to T-3h: 45      | 1 h interval, T-48h to T-6h: 42                            | 1 h interval, T-48h to T-6h: 42  | fixed slots T-48h: 1                 |
| Pre-boarding window                | 10 min interval, T-3h to T-40min: 14 | 15 min interval, T-6h to T-40min: 22                       | 15 min interval, T-6h to out: 24 | fixed slots T-3h: 1                  |
| In flight                          | 2 min interval, T-40min to in: 110   | 15 min interval, T-40min to in: 15                         | 30 min interval, out to in: 6    | fixed slots out+15min: 1             |
| Post-arrival tail                  | 10 min interval, in to in+120min: 12 | fixed slots in, in+15min, in+30min, in+45min, in+120min: 5 | 1 h interval, in to in+120min: 2 | fixed slots in+15min, in+120min: 2   |
| AeroAPI polls inside 48 h          | 181                                  | 84                                                         | 74                               | 5                                    |
| AeroAPI alert deliveries (assumed) | 0                                    | 0                                                          | 12                               | 8                                    |
| AeroDataBox alert items (assumed)  | 0                                    | 0                                                          | 0                                | 15                                   |
| Poll-equivalents inside 48 h       | 181                                  | 84                                                         | 122                              | 37.75                                |
| List cost inside 48 h              | $0.905                               | $0.42                                                      | $0.61                            | $0.18875                             |

### Pre-48 h AeroDataBox calls and per-flight totals by lead time

Before T-48 h every cadence polls AeroDataBox weekly from creation to T-48h, end-anchored on T-48h (increment 6: AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution). AeroDataBox status calls are the same for every cadence: the creation fetch plus every weekly slot after it, so 1 / 2 / 4 calls at 3 / 14 / 30 days (the plan's daily-inside-14-days and every-2-days-beyond grids gave 1 / 12 / 20). The poll at exactly T-48 h opens the AeroAPI window, but the router serves that one slot from AeroDataBox in every mode: at T-48 h the flight sits on AeroAPI's exclusive 2-day horizon, so no window AeroAPI accepts contains it (increment 6 review); in `live` mode a flight therefore makes one more AeroDataBox call and one fewer AeroAPI poll than these columns show. The per-cadence columns add the inside-48 h figures (and, for B, the assumed AeroDataBox alert items).

| Lead time | ADB status calls | ADB units | ADB cost (Growth) | literal list cost (PE) | A1 list cost (PE) | A2 list cost (PE) | B list cost (PE) |
| --------- | ---------------- | --------- | ----------------- | ---------------------- | ----------------- | ----------------- | ---------------- |
| 3 days    | 1                | 2         | $0.0005           | $0.9055 (181.1)        | $0.4205 (84.1)    | $0.6105 (122.1)   | $0.18925 (37.85) |
| 14 days   | 2                | 4         | $0.001            | $0.906 (181.2)         | $0.421 (84.2)     | $0.611 (122.2)    | $0.18975 (37.95) |
| 30 days   | 4                | 8         | $0.002            | $0.907 (181.4)         | $0.422 (84.4)     | $0.612 (122.4)    | $0.19075 (38.15) |

### Constants exported by `@planeahead/shared`

| Constant                 | Value                                         | Meaning                                                                 |
| ------------------------ | --------------------------------------------- | ----------------------------------------------------------------------- |
| `A2_EXPECTED_POLLS`      | 74                                            | AeroAPI status polls per flight inside 48 h                             |
| `A2_EXPECTED_ALERTS`     | 12                                            | assumed alert deliveries (`ASSUMED_ALERTS_PER_FLIGHT` = 12, unverified) |
| `A2_EXPECTED_PE`         | 122                                           | expected poll-equivalents per flight, budget baseline                   |
| `A2_SOFT_CAP_PE`         | 244                                           | 2x: metric and stretch cadence one tier                                 |
| `A2_HARD_CAP_PE`         | 488                                           | 4x: delete alerts, stop polling, one reconciliation poll                |
| `A1_EXPECTED_POLLS`      | 84                                            | fallback cadence when alerts are silent                                 |
| `LITERAL_EXPECTED_POLLS` | 181                                           | the brief as written, for comparison                                    |
| `B_EXPECTED_POLLS`       | 5                                             | Phase 1 target, unverified                                              |
| `MAX_LIFETIME`           | min(scheduledIn + 6 h, actualOff + 2 x block) | hard stop for a flight that never reports in                            |

### Detection-latency SLOs the cadence is derived from

| Event                          | > 7 d | 7 d to 48 h | 48 h to 6 h | 6 h to 3 h | 3 h to arrival             | Post-arrival |
| ------------------------------ | ----- | ----------- | ----------- | ---------- | -------------------------- | ------------ |
| Schedule change / cancellation | 2 d   | 1 d         | 1 h         | 15 min     | 15 min                     | n/a          |
| Gate change                    | n/a   | n/a         | 1 h         | 15 min     | 15 min                     | n/a          |
| ETA / delay change             | n/a   | n/a         | 1 h         | 15 min     | 15 min (2 min with alerts) | 15 min       |
| OOOI                           | n/a   | n/a         | n/a         | n/a        | 15 min (2 min with alerts) | 15 min       |

### Where a cadence polls slower than the SLO

Measured from the simulated poll sequence (one creation fetch 30 days out, then every slot `refreshIntervalFor` schedules, with the tail stop closing the last gap): each SLO window is charged the widest gap between consecutive polls that lies inside it or crosses one of its edges. A gap that crosses a window boundary counts against both windows; a gap that ends on the boundary counts against the earlier window only. A row appears when the widest gap exceeds the strictest poll SLO of the window.

| Cadence | SLO window     | Widest gap span       | Widest poll gap | Strictest poll SLO | Why it is accepted                                                                                                |
| ------- | -------------- | --------------------- | --------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| literal | > 7 d          | T-30d to T-23d        | 7 d             | 2 d                | AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution                  |
| literal | 7 d to 48 h    | T-9d to T-48h         | 7 d             | 1 d                | AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution                  |
| literal | 6 h to 3 h     | T-6h to T-5h          | 1 h             | 15 min             | the brief as written, kept for comparison only                                                                    |
| A1      | > 7 d          | T-30d to T-23d        | 7 d             | 2 d                | AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution                  |
| A1      | 7 d to 48 h    | T-9d to T-48h         | 7 d             | 1 d                | AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution                  |
| A1      | Post-arrival   | in+45min to in+120min | 75 min          | 15 min             | plan section 8: the fallback tail is five fixed polls, 15-minute cover for the first 45 minutes then a final poll |
| A2      | > 7 d          | T-30d to T-23d        | 7 d             | 2 d                | AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution                  |
| A2      | 7 d to 48 h    | T-9d to T-48h         | 7 d             | 1 d                | AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution                  |
| A2      | 3 h to arrival | out to out+30min      | 30 min          | 15 min             | plan section 8: OOOI and ETA arrive by alert; in-flight gate changes are accepted at 30-minute latency            |
| A2      | Post-arrival   | in to in+60min        | 1 h             | 15 min             | plan section 8: alerts carry in; the tail only refreshes baggage claim                                            |
| B       | > 7 d          | T-30d to T-23d        | 7 d             | 2 d                | AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution                  |
| B       | 7 d to 48 h    | T-9d to T-48h         | 7 d             | 1 d                | AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution                  |
| B       | 48 h to 6 h    | T-48h to T-3h         | 45 h            | 1 h                | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |
| B       | 6 h to 3 h     | T-48h to T-3h         | 45 h            | 15 min             | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |
| B       | 3 h to arrival | T-3h to out+15min     | 195 min         | 15 min             | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |
| B       | Post-arrival   | out+15min to in+15min | 3 h             | 15 min             | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |

Gap across the landing instant, from the last poll before `in` to the first at or after it: literal 2 min (out+178min to in); A1 10 min (out+170min to in); A2 30 min (out+150min to in); B 3 h (out+15min to in+15min).

<!-- prettier-ignore-end -->
<!-- cadence:end -->
