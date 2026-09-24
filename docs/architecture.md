# Architecture

Phase 0 architecture of PlaneAhead as built at the end of increment 12 (2026-09-23): what runs
where, the request paths, the Durable Object lifecycle, the outbox and persist path, the sync feed
and its watermark, the crons and housekeeping, and the environments. The last section, the refresh
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
 | queue(): persist, notify, provider-events, imports, reconcile, housekeeping, DLQs |
 | scheduled(): */15 reconcile, 03:00 housekeeping + Analytics Engine rollup         |
 +----+-------------+-------------+--------------+--------------+-------------------+
      | RPC         | Hyperdrive  | KV           | R2           | Analytics Engine
      v             v             v              v              v
  Durable Objects   Neon PG 18    CACHE PUBLIC   PUBLIC_BUCKET  PROVIDER_CALLS
  FlightTracker     (direct       CONFIG         PRIVATE_BUCKET API_METRICS
  DesignatorResolver endpoint,                                  PRODUCT_EVENTS
  ProviderBudget    no caching)
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
  - **AirportState** and **UserInbox** are schema shells for Phase 1.
- **Postgres** (Neon, PostgreSQL 18, us-east-1) is the source of truth for users, subscriptions,
  the flight registry, the sync feed and the ledgers, reached ONLY from the Worker through the
  Hyperdrive binding `DB` (one postgres.js client per request or queue batch, ADR 0009). Durable
  Objects never open Postgres (ADR 0007): their writes travel through the persist queue.
- **KV**: `CACHE` (search answers 15 min, flight snapshots, used identity tokens, the ProviderBudget
  read copy, and since increment 12 the tombstones of deleted accounts' sessions), `PUBLIC`,
  `CONFIG` (the kill switch). Never a source of truth, never a cap.
- **R2**: `PRIVATE_BUCKET` holds finished trackers' timelines (`events/{key}@{epochMs}.json`) and
  dead-lettered messages (`dlq/{queue}/{messageId}.json`, `dlq/persist-parked/`);
  `PUBLIC_BUCKET` is reserved for share images (Phase 5).
- **Queues**: `persist` (tracker, resolver and budget outboxes into Postgres, plus the merge
  job), `reconcile`, `housekeeping` (increment 12), and `notify`, `provider-events`, `imports`
  (consumers are stubs until their phases); every queue has a dead letter queue whose consumer
  archives each message to R2 and raises an ops alert.
- **Analytics Engine**: `PROVIDER_CALLS` (one point per stored provider call, index = provider),
  `PRODUCT_EVENTS` (increment 12, one point per accepted app event, index = the analytics id),
  `API_METRICS` (reserved). Every sum weights rows by `_sample_interval`; Postgres stays the ledger.
- **Rate limit bindings**: `PUBLIC_RL` (120 per 10 s per IP), `USER_RL` (600 per 60 s per user),
  `EVENTS_RL` (60 per 60 s per IP on `/v1/events`). Abuse brakes only; every quota is a
  `usage_counters` row.
- **Outside the Worker**: Cloudflare Access in front of `/admin`; Sentry (errors, scrubbed);
  Workers Logs (JSON lines, 10% sampled in production); GitHub Actions (CI, the staging and
  production deploys, the nightly native smoke, the mobile preview).

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

| Path                                                                  | Who calls it                            | Auth                                                                          | What it touches                                                                                                                           |
| --------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                         | deploy smoke, monitors                  | none                                                                          | build constants only (migration hash, Durable Object schema versions), no I/O                                                             |
| `/api/auth/*`                                                         | Better Auth Expo client                 | Better Auth (anonymous, magic link, native Apple and Google, session refresh) | `users`, `sessions`, `accounts`, `verifications`, `rate_limits`; the anonymous merge                                                      |
| `GET /auth/magic-link`, `POST /api/auth/magic-link/consume`           | a browser from the email                | the token                                                                     | a non-consuming landing page; the consume route verifies server side                                                                      |
| `GET /.well-known/*`                                                  | Apple's and Google's crawlers           | none                                                                          | the association files from vars                                                                                                           |
| `GET /v1/me`, `PATCH /v1/me/preferences`, `POST /v1/me/delete`        | the app                                 | session                                                                       | Postgres; the deletion unsubscribes trackers, revokes at Apple, deletes in one transaction, writes KV session tombstones                  |
| `POST /v1/devices`                                                    | the app                                 | session                                                                       | `devices`, `push_tokens`                                                                                                                  |
| `GET /v1/flights/search`                                              | the app                                 | session (anonymous accepted)                                                  | KV, `flight_designators`, then the DesignatorResolver (one provider call per designator and date) and caps                                |
| `POST /v1/flights`, `GET /v1/flights[/:id]`, `DELETE /v1/flights/:id` | the app                                 | session, `Idempotency-Key` on the POST                                        | caps in `usage_counters`, the tracker's `subscribe` or `unsubscribe` under an 8 s deadline, then one transaction with the sync change row |
| `POST /v1/flights/:id/refresh`                                        | the app                                 | session                                                                       | the per-user refresh budget, then the tracker's coalesced `forceRefresh`                                                                  |
| `GET /v1/sync`                                                        | the app                                 | session                                                                       | the two change tables below the watermark (section 6)                                                                                     |
| `POST /v1/events`                                                     | the app's analytics client              | none (install-scoped analytics id)                                            | `EVENTS_RL`, one `PRODUCT_EVENTS` point per accepted event, 202                                                                           |
| `POST /v1/webhooks/{aerodatabox,aeroapi}/{token}`                     | the providers                           | 256-bit path token                                                            | enqueue on `provider-events` only                                                                                                         |
| `GET /admin`                                                          | the operator, through Cloudflare Access | `Cf-Access-Jwt-Assertion` validated                                           | read-only Postgres, the Analytics Engine SQL API, the Queues API                                                                          |
| `GET /account/delete`                                                 | Google Play's listing, anyone           | none                                                                          | a static page                                                                                                                             |

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
- **Subscribers.** `subscribe` and `unsubscribe` are idempotent on the subscription id; Postgres is
  the record and the list only follows it. The nightly housekeeping reconciliation (section 7) lists
  every active tracker's subscribers and makes the list follow Postgres.
- **Finish and deletion.** The flight finishes after the cadence's post-arrival tail poll, at the
  hard cap, or at `MAX_LIFETIME` (`min(scheduledIn + 6 h, actualOff + 2 x block)`); the object
  deletes itself 22 hours later, and never while an outbox row is unconfirmed.
- Measured (increment 7): 74 provider calls per A2 lifecycle, 1,200 rows written per flight
  including the schema DDL (budget 1,600), largest outbox message 1,635 bytes.

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
send, so for those the R2 archive is the only copy: the nightly housekeeping replays every
`dlq/persist/` archive older than an hour onto the persist queue and deletes it once sent (ADR 0011;
increment 12). A message replayed three times and dead-lettered again is parked under
`dlq/persist-parked/` with an error log instead of looping.

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
re-snapshots. After a point-in-time restore the runbook bumps `sync_epoch`, which answers 410 to
every cursor from the lost timeline.

## 7. Crons and the housekeeping queue

No cron does work inline (ruling W1): each pages or plans within its CPU budget and enqueues one
message per unit of work.

| Cron                                    | CPU budget                         | What it enqueues                                                                                             |
| --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| every 15 minutes (reconcile)            | 30 s on Paid (a 25 s wall budget)  | one `reconcile` message per active tracker whose refresh is 20 min overdue                                   |
| 03:00 UTC daily (housekeeping + rollup) | 15 min on Paid (uses milliseconds) | one `housekeeping` message per step, then one `ae_rollup` message per UTC day (yesterday and the day before) |

The housekeeping consumer (`max_batch_size` 1, `max_concurrency` 1, so the steps run in the order
sent on one connection) runs each message within a 30 s wall budget and enqueues a continuation of
the step when more is left. Every step is idempotent and re-entrant, and every message writes one
`audit_log` row (`housekeeping.{step}`) with its counts. The steps, in order: expired
`idempotency_keys`; the sync purge (section 6); `provider_calls` over 90 days for days the rollup
holds; retention (notifications 90 d, export jobs 7 d, expired `deleted_subjects`, idle
`rate_limits`, expired `verifications`, `flight_events` 90 d, expired sessions, day-window counters
30 d, sync tombstones 30 d); the `usage_counters` repair against `flight_subscriptions`; the tracker
subscriber reconciliation (and the deletion of anonymous users a merge marked `deleting`); the
`dlq/persist/` replay; the KV session tombstones; and the KEK re-wrap. The rollup queries the
Analytics Engine SQL API per provider per day with `SUM(_sample_interval)` and replaces the
per-operation `provider_call_daily` rows.

## 8. Observability

JSON log lines with the request id on every line (`src/observability/log.ts`); Sentry for
exceptions and ops alerts (dead letters, kill switch, stuck outboxes, lifetime rejections), with
bodies, headers, queries and webhook tokens scrubbed; Analytics Engine for provider calls and
product events; and the admin page (`/admin`, behind Cloudflare Access): provider calls per flight
key and per provider per day, the Durable Object schema versions, the sync watermark lag, the queue
depths, the sync horizon and epoch, and the last housekeeping runs.

## Refresh cadence

<!-- cadence:start -->
<!-- prettier-ignore-start -->

_Generated from `packages/shared/src/cadence.ts` by `pnpm --filter @planeahead/shared gen:cadence-table`. Do not edit between the markers; `packages/shared/test/cadence-table.test.ts` fails when this block drifts from the code._

Assumptions: block 180 min, boarding at T-40 min, tail stops at in+120 min, on-time flight, one creation fetch at the lead time. Slot rule: start-anchored windows yield `ceil(duration / interval)` polls, so a trailing partial slot always earns a poll and no window ends with a gap longer than its interval; the pre-48 h AeroDataBox window counts back from T-48 h (weekly: T-9 d, T-16 d, T-23 d, ...) and yields `floor(duration / interval)`; the instant on a boundary belongs to the later window; fixed-slot windows list their slots. A flight that passes its planned arrival without `in` keeps polling until `in` or `MAX_LIFETIME`: interval windows continue their grid, fixed-slot windows poll every `lateIntervalMinutes` from the planned arrival. Prices are list prices from `cost.ts` (AeroAPI status $0.005, alert delivery $0.020; AeroDataBox 2 units per status call at $0.00025 per unit on Growth).

### Windows inside 48 h (AeroAPI)

| Window                             | Literal brief                        | A1 polls only                                              | A2 polls + alerts                    | B ADB webhooks + AeroAPI OOOI alerts |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| Hourly window                      | 1 h interval, T-48h to T-3h: 45      | 1 h interval, T-48h to T-6h: 42                            | 1 h interval, T-48h to T-6h: 42      | fixed slots T-48h: 1                 |
| Pre-boarding window                | 10 min interval, T-3h to T-40min: 14 | 15 min interval, T-6h to T-40min: 22                       | 15 min interval, T-6h to T-40min: 22 | fixed slots T-3h: 1                  |
| In flight                          | 2 min interval, T-40min to in: 110   | 15 min interval, T-40min to in: 15                         | 30 min interval, T-40min to in: 8    | fixed slots out+15min: 1             |
| Post-arrival tail                  | 10 min interval, in to in+120min: 12 | fixed slots in, in+15min, in+30min, in+45min, in+120min: 5 | 1 h interval, in to in+120min: 2     | fixed slots in+15min, in+120min: 2   |
| AeroAPI polls inside 48 h          | 181                                  | 84                                                         | 74                                   | 5                                    |
| AeroAPI alert deliveries (assumed) | 0                                    | 0                                                          | 12                                   | 8                                    |
| AeroDataBox alert items (assumed)  | 0                                    | 0                                                          | 0                                    | 15                                   |
| Poll-equivalents inside 48 h       | 181                                  | 84                                                         | 122                                  | 37.75                                |
| List cost inside 48 h              | $0.905                               | $0.42                                                      | $0.61                                | $0.18875                             |

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
| A2      | 3 h to arrival | T-40min to T-10min    | 30 min          | 15 min             | plan section 8: OOOI and ETA arrive by alert; in-flight gate changes are accepted at 30-minute latency            |
| A2      | Post-arrival   | in to in+60min        | 1 h             | 15 min             | plan section 8: alerts carry in; the tail only refreshes baggage claim                                            |
| B       | > 7 d          | T-30d to T-23d        | 7 d             | 2 d                | AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution                  |
| B       | 7 d to 48 h    | T-9d to T-48h         | 7 d             | 1 d                | AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution                  |
| B       | 48 h to 6 h    | T-48h to T-3h         | 45 h            | 1 h                | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |
| B       | 6 h to 3 h     | T-48h to T-3h         | 45 h            | 15 min             | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |
| B       | 3 h to arrival | T-3h to out+15min     | 195 min         | 15 min             | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |
| B       | Post-arrival   | out+15min to in+15min | 3 h             | 15 min             | webhooks and alerts are assumed to carry the SLO (unverified, Phase 1 decision)                                   |

Gap across the landing instant, from the last poll before `in` to the first at or after it: literal 2 min (out+178min to in); A1 10 min (out+170min to in); A2 10 min (out+170min to in); B 3 h (out+15min to in+15min).

<!-- prettier-ignore-end -->
<!-- cadence:end -->
