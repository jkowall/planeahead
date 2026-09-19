# PlaneAhead Phase 0 Plan: Foundations

Date: 2026-09-19. Product name: **PlaneAhead**, domain `planeahead.app` (already on Cloudflare). Working directory `/Users/jkowall/Taxiway` is empty and not a git repo; the first action after approval copies the research files out of the scratchpad, renames the directory to `/Users/jkowall/PlaneAhead`, and re-points this session with the directory tool. This plan was produced from a 13-agent research workflow (8 researchers with live web verification, a synthesis draft, a 3-lens red team with 55 critiques, and a revision). The full 11.5k-word dossier and the raw research JSON are preserved and get copied into `docs/research/` in increment 1:

- Dossier: `/private/tmp/claude-501/-Users-jkowall-Taxiway/11e6225d-6445-4fca-887a-efe5e378146f/scratchpad/final-plan.md`
- Raw research and critiques: same directory, `research-full.json`, `critiques.json`
- Durable copy: `/Users/jkowall/.claude/projects/-Users-jkowall-Taxiway/11e6225d-6445-4fca-887a-efe5e378146f/subagents/workflows/wf_9350e0d3-45b/journal.jsonl`

## 1. Context

Phase 0 fixes the five things that are expensive to change once data exists: the flight identity model, the full Postgres schema, the provider abstraction with cost attribution, the FlightTracker Durable Object lifecycle, and the rule that a flight's first billable provider call is serialised through exactly one object. Everything cheap to add later ships as a compiling shell or a documented design.

**Runnable at the end of Phase 0:** `pnpm dev` starts `wrangler dev` (API Worker, FlightTracker and DesignatorResolver DOs, queues, KV, R2 emulated) against local Postgres 18. An Expo development build signs in (Apple, Google, magic link, or anonymous), adds a flight by number and date, and sees it in a list backed by a FlightTracker DO that fetched it once from AeroDataBox, logged the call with a cost unit into Postgres and Analytics Engine, and scheduled its next refresh alarm. A second user adding the same flight causes zero extra provider calls. CI is green including a FlightTracker lifecycle integration test whose provider call counts are imported from the same cadence function that generates the table in `docs/architecture.md`.

**Scope correction versus the research dossier.** The dossier pulled push delivery, GDPR jobs, alert registration, tracker merge logic, sharded budget objects and an APNs smoke test into Phase 0. Your brief puts push and boards in Phase 1 and hardening in Phase 7. I am keeping Phase 0 to foundations plus the minimum vertical slice that proves the shared-flight invariant. The schema and interfaces still cover the whole feature list. Deferred items are listed in section 12 with their target phase.

## 2. Where I push back on the brief

1. **2-minute AeroAPI polling from boarding through landing is not viable.** AeroAPI Standard is capped at 5 result sets per second, Premium starts at a $1,000 monthly minimum ([pricing](https://www.flightaware.com/commercial/aeroapi/)). Section 7 derives cadence from detection-latency SLOs instead.
2. **AeroAPI cannot refresh flights more than 2 days out.** `/flights/{ident}` accepts a window of 10 days past to 2 days future ([OpenAPI spec](https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml)). Beyond that you pay `/schedules` at $0.020 per set, 4x a status poll. All pre-48h refreshes go to AeroDataBox.
3. **AeroAPI push alerts do not cover gate changes.** Events are filed, departure, arrival, cancelled, diverted, out, off, on, in, hold_start, hold_end; departure and arrival alerts bundle ETA changes ([spec mirror](https://wal.sh/research/ads-b/aeroapi-reference.html)). Alerts cover OOOI and ETA creep; gates need polling or AeroDataBox's webhook Flight Alert API. Each alert delivery bills $0.020, the same as 4 status polls, so "alerts only" is not a spend stop.
4. **Two of the three named ADS-B feeds forbid commercial use.** adsb.fi ([README](https://github.com/adsbfi/opendata/blob/main/README.md)) and airplanes.live ([API docs](https://airplanes.live/api-docs/)) are non-commercial only. adsb.lol is ODbL with no non-commercial clause ([docs](https://www.adsb.lol/docs/open-data/api/)). Positions must be batched through one PositionPoller DO per provider, never per-flight alarms.
5. **Expo Push Service cannot start or update Live Activities.** A direct APNs adapter is mandatory when push lands in Phase 1.
6. **Cloudflare Email Service sending is still Beta with an undisclosed quota** ([limits](https://developers.cloudflare.com/email-service/platform/limits/)). Magic links use Resend by default behind a `MailSender` interface.
7. **Durable Objects never touch Postgres directly.** Every DO write goes through an outbox to a `persist` queue consumer. This sidesteps an open Hyperdrive-inside-DO issue in the vitest plugin ([workers-sdk#10275](https://github.com/cloudflare/workers-sdk/issues/10275)) and makes alarm retries safe.
8. **Gmail sync has a program-management critical path, not an engineering one.** `gmail.readonly` is a restricted scope; verification "can potentially take several weeks" plus a CASA assessment, and unverified apps are capped at 100 users ([Google](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [cap](https://support.google.com/cloud/answer/7454865)). Microsoft has the analogous publisher-verification gate. Both start in Phase 0 as owner tasks or Phase 3 slips by months.

## 3. Decisions (each with the why and reversibility)

| Decision | Choice | Why | Reversibility |
|---|---|---|---|
| Mobile framework | React Native + Expo SDK 57 (`expo@^57.0.23`), upgrade to 58 in its first stable week | Live Activity, WidgetKit, Glance, Wear and watch complications are Swift/Kotlin in every framework; Flutter's `live_activities` and `home_widget` still require hand-written native code, Compose Multiplatform 1.11 has no ActivityKit story. Expo ships `expo-widgets` stable since SDK 56 with Live Activities, Dynamic Island regions and push-to-start tokens ([changelog](https://expo.dev/changelog/sdk-56), [docs](https://docs.expo.dev/versions/latest/sdk/widgets/)); SDK 58 beta adds Android widgets. TypeScript end to end; CNG means `/ios` and `/android` are never committed | Low |
| Database | Neon Postgres 18 via Hyperdrive, Drizzle. D1 rejected | D1's 10 GB cap ([limits](https://developers.cloudflare.com/d1/platform/limits/)) is exceeded by `flight_events`, `provider_calls` and BTS aggregates within a year at 100k flights/month; SQLite dialect lock-in means a full schema rewrite to migrate; export blocks the DB. Hyperdrive is included on Workers Paid ([pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)). Neon PG18 gives native `uuidv7()` | Medium |
| Auth | Better Auth 1.7.5 pinned, Drizzle adapter, plugins `anonymous`, `magicLink`, Google idToken, Expo client with SecureStore; plus one custom `POST /api/auth/apple/native` | First-party Hono, Drizzle and Expo integrations; `anonymous.onLinkAccount` gives the local-only to real-account upgrade ([Expo integration](https://better-auth.com/docs/integrations/expo)). Better Auth's Apple idToken path never captures the refresh token Apple's revoke endpoint needs for account deletion, so the custom route does nonce-checked code exchange and encrypts the refresh token. Clerk and Supabase Auth are hosted user stores that conflict with Neon as source of truth and automated GDPR deletion; Lucia is deprecated; Auth.js has no Expo support | Medium |
| Email sending | `MailSender` interface, Resend default, Cloudflare Email Service second adapter | Resend is 3,000/month free ([pricing](https://resend.com/pricing)); Cloudflare sending is Beta | High |
| ORM | drizzle-orm 0.45.2 + drizzle-kit 0.31.10, restricted to APIs unchanged in the 1.0 rc | 1.0 is at rc with relation, RLS and migration-folder changes. Workers driver rule: new client per request or queue batch, closed via `ctx.waitUntil`, enforced by an ESLint rule banning module-scope `drizzle(` | High |
| Monorepo | pnpm 12 workspaces (isolated linker) + Turborepo 2.11, Node 24 LTS, TypeScript ~6.0.3 | Expo SDK 54+ supports isolated pnpm and auto-configures Metro for monorepos ([docs](https://docs.expo.dev/guides/monorepos/)); Corepack is gone from Node 25+ so pnpm is pinned via `packageManager`; TS 7 breaks Expo 57's expectations and typescript-eslint | High |
| Lint and test | ESLint 9 flat + Prettier 3; Vitest ~4.1 + `@cloudflare/vitest-plugin` 1.1.x for api/shared/db; Jest 29 via jest-expo for mobile | Vitest 5 breaks the Workers pool ([workers-sdk#15618](https://github.com/cloudflare/workers-sdk/issues/15618)); the plugin was renamed from vitest-pool-workers; storage isolation is per test file, which shapes DO tests | High |
| Typed client | Hono RPC `hc<AppType>` + `@hono/zod-validator`, Zod 4 | Boring, no codegen, types flow through project references ([Hono RPC](https://hono.dev/docs/guides/rpc)) | High |
| Offline store | expo-sqlite + drizzle-orm `useLiveQuery`, server-authoritative pull sync with an xid8 cursor, client outbox with idempotency keys | WatermelonDB has no documented New Architecture support since 0.27.1 and RN 0.82+ is New Architecture only; PowerSync is bidirectional machinery we do not need | Medium |
| Maps | `@maplibre/maplibre-react-native` 11.4 + OpenFreeMap, Protomaps PMTiles on R2 as owned fallback | Zero tile cost; Phase 0 only pins the dependency | High |
| Push (Phase 1) | expo-notifications for permissions and display; raw APNs and FCM tokens server-side; Workers `PushSender` with `apns-direct` and `fcm-v1` adapters | Live Activities require raw APNs; Workers to APNs HTTP/2 works in production but not in local workerd on macOS ([workerd#4841](https://github.com/cloudflare/workerd/issues/4841)), so Phase 1 needs a staging smoke job | High |
| Analytics | First-party events to Workers Analytics Engine via `POST /v1/events`, install-scoped random id never joined to users | Zero third-party SDKs; meets Apple's "not linked" standard; 10M points/month included ([pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)); 3-month retention means a nightly rollup to Postgres | High |
| Errors | Sentry on mobile and Workers, PII off, `beforeSend` scrubbing tested | Standard | High |
| Deploy system | GitHub Actions + `cloudflare/wrangler-action`, not Workers Builds | Migrations must run against Neon before deploy and be gated per environment; Workers Builds cannot express that ordering with env-scoped secrets | High |

## 4. Repository layout (Phase 0)

```
planeahead/
  .github/workflows/{ci,deploy-staging,deploy-production,mobile-preview,mobile-release}.yml
  .github/{CODEOWNERS,renovate.json}
  .node-version  package.json (packageManager pnpm@12)  pnpm-workspace.yaml (catalog pins)
  turbo.json  tsconfig.base.json  tsconfig.json  eslint.config.js
  docs/
    architecture.md  cost-estimate.md  schema-review.md  security/threat-model.md  open-decisions.md
    research/  (dossier + research JSON from this planning session)
    adr/0001-expo 0002-neon-not-d1 0003-flight-key 0004-hono-rpc 0005-identifiers 0006-uuidv7 0007-do-postgres-free 0008-expo-widgets
  apps/
    api/
      wrangler.jsonc  vitest.config.ts  .dev.vars.example
      src/index.ts                       Hono app, AppType export, DO class exports
      src/middleware/{request-id,auth,scope,rate-limit,idempotency,sentry}.ts
      src/routes/{health,auth,apple-native,flights,search,devices,me,events,webhooks,admin}.ts
      src/do/flight-tracker.ts           state machine, alarm, outbox, per-flight budget
      src/do/designator-resolver.ts      serialises the first provider call per marketing designator
      src/do/{airport-state,user-inbox,provider-budget}.ts   schema + constructor shells
      src/do/migrations/<class>/NNN.sql  PRAGMA user_version runner per class
      src/providers/{aerodatabox.adapter,aeroapi.mock,cost-log,budget,token-bucket}.ts + fixtures/
      src/mail/{sender,resend,cloudflare-email}.ts
      src/crypto/{envelope,key-provider}.ts
      src/queues/persist.ts              DO outbox -> Postgres + Analytics Engine
      src/cron/{reconcile,housekeeping,ae-rollup}.ts
      test/unit/**  test/workers/**
    mobile/
      app.config.ts  eas.json  metro.config.js  jest.config.js
      src/app/(auth)/sign-in.tsx  src/app/(app)/{index,flight/[id],settings}.tsx
      src/lib/{api-client,auth-client,sync,analytics,db/schema,db/migrations}.ts
      widgets/                           expo-widgets: placeholder widget + Live Activity layout
      targets/watch/ targets/watch-widget/   @bacons/apple-targets shells (watchOS only)
      modules/android-surfaces/          Kotlin: empty Glance widget + ongoing-notification stub
      wear/ + plugins/withWearApp.ts     Compose for Wear OS + Tiles shell
  packages/
    shared/   zod contracts, FlightStatus, provider interfaces, flight-key normaliser, cadence fn + SLO table,
              uuidv7(), LiveActivityContentState, SyncEnvelope, versioned RPC schemas, SECRET_PATTERNS
    db/       drizzle schema (full feature list), drizzle.config.ts, migrations/, seed/, withDb helper
```

`packages/db` is separate from `packages/shared` so the mobile bundle never depends on drizzle-orm/pg.

## 5. Backend architecture (Phase 0 subset)

**Routes:** `GET /health`; `ALL /api/auth/*` (Better Auth); `POST /api/auth/apple/native`; `GET /v1/me`, `PATCH /v1/me/preferences`, `POST /v1/me/delete` (synchronous cascade in Phase 0); `POST /v1/devices`; `GET /v1/flights/search?number=&date=`; `POST /v1/flights` (Idempotency-Key required, per-user caps); `GET /v1/flights`, `GET /v1/flights/:id`, `DELETE /v1/flights/:id`, `POST /v1/flights/:id/refresh` (coalesced inside the DO, 10 per flight per day); `GET /v1/sync?since=`; `POST /v1/events`; `POST /v1/webhooks/{aeroapi,aerodatabox,revenuecat}` (verify and enqueue only); `GET /admin/*` behind Cloudflare Access (provider calls per flight key, DO schema versions).

**Durable Objects** (SQLite-backed, declared with the `exports` field, each with a `PRAGMA user_version` migration runner in the constructor under `blockConcurrencyWhile`):

- **FlightTracker**, name = `flight_key` (`AAL-100-2026-09-19-KJFK`). Tables: `flight`, `subscribers`, `events`, `positions` (ring, empty in Phase 0), `budget`, `user_refresh`, `outbox`, `notif_dedupe`, `alert_registrations` (unused until Phase 1). RPC: `subscribe`, `unsubscribe`, `getState`, `forceRefresh(reason)`, `getCostLedger`; payloads are versioned zod schemas tolerant of unknown fields (gradual rollout safety).
  - **Alarm handler, idempotent under at-least-once retries** (up to 6, [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)): in one `transactionSync` before any I/O, read `alarmInfo.retryCount`; if this is a retry and `attempt_started_at` is newer than the tier interval, skip provider I/O; else record the attempt, debit the per-flight budget, append the outbox intent, `setAlarm(nextTierSlot)`. Then fetch; every provider error is caught and logged as an error record with zero cost; only storage errors throw. Guarantees at most one provider call per tier slot.
  - **Outbox:** state changes push rows to the `persist` queue; the consumer writes `flight_instances`, `flight_events`, `provider_calls` idempotently and Analytics Engine points in chunks of at most 200 (cap 250). KV snapshot `flight:snapshot:{key}` debounced to one write per 2 s; KV 429 never fails the alarm.
  - **Finish:** `in` observed, or hard lifetime `min(scheduled_in + 6h, actual_off + 2 x block)`. Flush, archive events to R2, phase `finished`, `setAlarm(+22h)`; that alarm verifies the outbox is empty then `deleteAll()` (which also clears the alarm at compat dates ≥ 2026-02-24). `subscribe()` on a finished DO returns `archived`.
- **DesignatorResolver**, name = `${marketingIata}${number}-${dateLocal}`. Makes the single AeroDataBox call for an unresolved designator, canonicalises the key with the provider-independent normaliser, caches 24 h, then `deleteAll()`. This closes the search stampede the red team found: the invariant "one provider call regardless of subscribers" is now structural at the first call too, not just inside FlightTracker.
- **AirportState**, **UserInbox**, **ProviderBudget**: schema, migration runner and constructor only. ProviderBudget in Phase 0 is one object per provider per UTC day holding a counter with a hard daily kill switch (stop polling, one reconciliation poll per flight at scheduled arrival). The lease protocol and 8-way sharding from the dossier move to Phase 1 when real AeroAPI traffic starts.

DOs cannot be enumerated in production, so `flight_instances.flight_key` in Postgres is the registry; the `reconcile` cron (`*/15`) re-arms trackers whose alarm died after 6 failed retries.

**Bindings (`wrangler.jsonc`, redeclared per env):** `compatibility_date "2026-09-01"`, `nodejs_compat`; DO bindings for the five classes; one `hyperdrive` DB (caching disabled, Neon direct endpoint; one config only because Hyperdrive opens up to ~100 origin connections and Neon 0.25 CU allows 104); KV `CACHE`, `PUBLIC`, `CONFIG`; R2 `planeahead-public`, `planeahead-private`; queues `persist`, `notify`, `provider-events`, `imports` with DLQs; Analytics Engine `PROVIDER_CALLS`, `API_METRICS`, `PRODUCT_EVENTS`; `ratelimits` `PUBLIC_RL` 120/10s, `USER_RL` 600/60s, `EVENTS_RL` 60/60s; crons `*/15` reconcile, `0 3` housekeeping + AE rollup; secrets `AERODATABOX_API_KEY`, `AEROAPI_API_KEY`, `BETTER_AUTH_SECRET`, `TOKEN_KEK_V1`, `APPLE_SIWA_P8`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, webhook secrets.

**Environments:** `local` (wrangler dev with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` pointed at a per-developer Neon branch such as `dev-jkowall`; no local Postgres, no Docker; local test runs use the same branch, CI uses a `postgres:18` service container), `staging` (Neon branch, scale-to-zero on, auto-deploy from main), `production` (tag-gated with required reviewer, Neon primary at 0.5 CU always-on). Custom domains from day one.

## 6. Data model

**Conventions:** UUIDv7 PKs generated in `packages/shared` with PG18 `uuidv7()` as DB default; `timestamptz` for every instant and exactly one origin-local `date` in the flight key; `text + check` enumerations (not `pgEnum`); `created_at` with BRIN on append-only tables, `updated_at` by trigger; `deleted_at` tombstones only on sync entities; denormalised `user_id` on user-owned rows, no RLS in Phase 0 (Hyperdrive pooling); `_enc bytea + key_version` for secrets; `token_hash + token_prefix` for presented tokens; financial, audit and delivery tables have no FK to `users` so GDPR hard delete cannot cascade into them.

**61 tables in 8 domains (all created in Phase 0):**

- **Identity:** `users`, `sessions`, `accounts` (with `refresh_token_enc`), `verifications`, `rate_limits`, `user_keys` (wrapped DEK, KEK version), `devices`, `user_preferences`, `user_consents`, `user_sync_changes` (xid8 watermark), `idempotency_keys`, `deleted_subjects`.
- **Reference:** `airports` (surrogate id, ICAO unique, IATA partial unique, IANA `tz`), `airport_profiles`, `airlines`, `regional_operators` (marketing carrier + number range to operating ICAO), `aircraft_types`, `aircraft` (registration and hex with validity ranges), `currency_rates`.
- **Flight core:** `flight_instances` (natural key = operating carrier ICAO + flight number + origin-local date + origin ICAO, `leg_seq` for same-day reuse, generated `flight_key` unique, OOOI columns, gates, baggage, `aeroapi_fa_flight_id`, `tracking_state`, `next_refresh_at`, `subscriber_count`, `superseded_by_id`, `events_r2_key`, `timeline_summary`), `flight_instance_merges`, `flight_designators` (marketing to operating), `flight_events` (append-only), `flight_tracks`.
- **Trips and subscriptions:** `trips`, `trip_members`, `flight_subscriptions` (per-user prefs, encrypted PNR, notification overrides, partial unique on active), `logbook_entries`, `user_stats_yearly`, `usage_counters`.
- **Providers and models:** `provider_calls`, `provider_call_daily`, `provider_budget_config`, `provider_alert_registrations`, `provider_webhook_events`, `delay_predictions`, `delay_outcomes`, `airport_wx_observations`, `airport_nas_events`, `airport_delay_snapshots`, `airport_delay_hourly`, `bts_carrier_flight_monthly`, `bts_route_monthly`, `bts_airport_hourly`, `bts_import_runs`.
- **Notifications:** `notification_preferences`, `push_tokens`, `live_activities`, `notifications`, `notification_deliveries`.
- **Import, calendar, sharing:** `email_accounts`, `email_messages_processed` (ids only, never bodies), `email_extractions`, `inbound_addresses`, `inbound_messages`, `imports`, `import_rows`, `calendar_connections`, `calendar_events`, `ics_feed_tokens`, `share_links`, `share_link_views`, `meet_me_sessions`.
- **Billing, API, GDPR:** `entitlements` (random `rc_app_user_id`, not `users.id`), `revenuecat_events`, `subscriptions`, `api_tokens`, `audit_log`, `data_export_jobs`, `account_deletion_requests`.

**Storage tiers:** positions live only in FlightTracker SQLite (a ≤200-point track sample persists at finish); weather, boards, NAS status and flight snapshots live in KV with TTLs (`wx:metar:{ICAO}` 600 s, `board:{ICAO}:{dir}:{hour}` 300 s, `flight:snapshot:{key}` 180 s, `search:number:{XX1234}:{date}` 900 s); R2 holds event archives, track samples, exports, imports, share images with prefix lifecycle rules.

**Irreversible decisions to confirm at approval:** (1) UUIDv7 PKs; (2) timestamptz everywhere plus one origin-local date; (3) the natural key above, normalised provider-independently, with ICAO airport codes because AeroAPI and aviationweather.gov are ICAO-keyed; (4) tombstones only on sync entities, hard delete for GDPR; (5) no RLS; (6) text + check; (7) no partitioning, BRIN plus retention crons plus R2 archives; (8) one envelope-encryption format for all secret columns.

**`docs/schema-review.md` outline:** principles; storage tier matrix with forbidden placements; per-domain ER diagrams; table catalog (purpose, writer, readers, PII class, encryption, retention, GDPR path, rows at 1k/10k/100k); invariants and natural keys; write-path ownership (the persist consumer is the only Postgres writer of `flight_instances` and `flight_events`); top-20 query catalog with serving index; DO schemas and migration runner; KV and R2 catalogs; connection budget; migration policy (expand/contract, `drizzle-kit check`, DO additive-only for one release); review checklist.

## 7. Provider layer

Interfaces in `packages/shared/providers.ts`: `FlightDataProvider` (`id`, `capabilities {alerts, alertFields, boards, maxDaysAhead, inboundLink}`, `getFlight`, `getBoard?`, `registerAlert?`, `deleteAlert?`, `parseWebhook?`), `AircraftPositionProvider` (`getPositions` batched by hex or callsign, `maxIdsPerRequest`), a normalised `FlightStatus` (OOOI times as scheduled/estimated/actual, gates, terminals, baggage, aircraft, codeshares, `providerRefs`, `fieldQuality`), and `ProviderCallContext` (`trigger`, `flightKey`, `requestId`, `budget`, `log`, injectable `now`). Every call returns `ProviderResult<T> = { data, call: ProviderCallRecord }`, so a call without a cost record is a type error.

- **AeroDataBox adapter (real):** `GET /flights/{number}/{dateLocal}` (Tier 2, 2 units) with a ±1 day retry on miss, `withFlightPlan` never set (doubles billing), FIDS boards (Tier 2), airport lookup (Tier 1). Webhook parsing for the credit-based Flight Alert API is implemented behind a flag with field-coverage instrumentation, because whether ADB alerts carry gate and time revisions is unverified ([ADB alerts](https://aerodatabox.com/flight-alert-api-2026/)). Plans: Starter $19/40k units, Growth $99/400k, Scale $499/4M; no paid overage, calls are rejected at quota ([pricing](https://aerodatabox.com/pricing/)).
- **AeroAPI adapter (mocked):** full interface from fixtures (scheduled, delayed with gate change, cancelled, diverted, bundled departure/arrival with ETA change, OOOI). Two rules unit-tested now so Phase 1 inherits them: the first fetch brackets `start`/`end` around scheduled_out ±1 day; every later poll uses `ident_type=fa_flight_id` so one poll is exactly one result set. Price table: `/flights/{ident}` $0.005, `/position` $0.010, `/schedules` $0.020, alert delivery $0.020.
- **Cost logging:** `CostLogger.record()` appends to the DO outbox or writes directly from a Worker; the persist consumer produces a `provider_calls` row and one Analytics Engine point (`index1 = provider`; blobs operation, flight_key, trigger, result, environment; doubles latency_ms, cost_units, est_cost_usd_micros, http_status). Nightly rollup to `provider_call_daily`. "Queries per provider per day" is a first-class metric on the admin page.
- **Budget guard:** poll-equivalents (PE) at list price: AeroAPI status 1, alert delivery 4, schedules 4, position 2; ADB status 0.1. Per-flight expected PE comes from the cadence function (120 for cadence A2), soft cap 2x, hard cap 4x, derived not hand-set. User refreshes have a separate sub-budget and never debit the scheduled cadence. Routing rule: zero AeroAPI calls before T-48h. Per-user caps in `usage_counters`: 5 active subscriptions free, 20 new instances per day, 10 tracker creations per IP per day for anonymous accounts.

## 8. Refresh cadence and query budget

Cadence is derived from detection-latency SLOs per event type (schedule change ≤ 24 h beyond 48 h, ≤ 60 min inside 48 h, ≤ 15 min inside 6 h; gate ≤ 15 min inside 6 h; OOOI ≤ 2 min with alerts). Assumptions: 3 h block, boarding at D-40, stop at arrival + 2 h. Pre-48h source is AeroDataBox at daily cadence inside 14 days, every 2 days beyond.

| Inside 48 h (AeroAPI) | Literal brief | A1 polls only | A2 polls + alerts (Phase 0 constant) | B ADB webhooks + AeroAPI OOOI alerts (Phase 1 target, unverified) |
|---|---|---|---|---|
| 48 h to 6 h | hourly 42 | hourly 42 | hourly 42 | 1 fetch at T-48h |
| 6 h to boarding | 10-min 14 | 15-min 21 | 15-min 21 | 1 at T-3h |
| Boarding to landing | 2-min 110 | 15-min 15 | 30-min 7 | 1 at sched_off + 15 |
| Post-landing | 10-min 12 | 5 | 2 | 2 |
| Polls / alert deliveries | 181 / 0 | 83 / 0 | 72 / ~12 | 5 / 8 + ~15 ADB items |
| AeroAPI list cost per flight | $0.905 | $0.415 | **$0.60** | **$0.185** |

Pre-48h on AeroDataBox adds 4 to 42 units per flight ($0.001 to $0.015 at Growth); the constraint there is quota, not price. The literal brief would also require `/schedules` at $0.020 for every pre-48h poll, giving $1.15 to $3.77 per flight at 14 to 30 day lead times. Rate check: A2 crosses Standard's 5 sets/s at roughly 45k flights/month with a 4x departure-bank peak factor (assumed), forcing Premium.

## 9. Cost model (monthly, cadence A2 unless stated)

Assumptions: subscribers per flight 1.2 / 1.5 / 2.5; MAU 600 / 7,500 / 125,000; Neon 0.5 / 0.5 / 2 CU always-on; AeroAPI volume discount bands read as marginal per the pricing page (confirm with FlightAware sales before 10k).

| Line | 1k flights | 10k flights | 100k flights |
|---|---|---|---|
| AeroAPI (A2, after bands) | $600 | $3,380 | $11,800 (Premium) |
| AeroDataBox (Growth, Scale at 100k) | $99 | $99 | $499 |
| Workers + DO + Queues/KV/R2 + Logs | $6 | $9 | $177 |
| Neon | $45 | $60 | $176 to $345 |
| Sentry / EAS / RevenueCat / Email | $45 | $68 | $862 |
| **Total** | **~$795 ($0.80/flight)** | **~$3,620 ($0.36/flight)** | **~$13,680 ($0.14/flight)** |
| Total with cadence B | ~$380 | ~$1,830 | ~$8,500 |

Provider cost is 75 to 86% of spend at every scale; Cloudflare infrastructure is under $10 at 10k. At 1.5% Pro conversion the product is margin-negative at 100k on A2, which is why free-tier caps and cadence B matter more than any infra optimisation. Positions are excluded: community feed $0, AeroAPI `/position` at 60 s foreground-only would add ~$0.10 per flight list.

## 10. Security and privacy foundations

**Implemented in Phase 0:** envelope encryption (per-user 256-bit DEK wrapped with AES-KW by a versioned KEK from a Workers Secret behind a `KeyProvider`; AES-256-GCM with AAD `table:column:row_id`); `api_tokens` (`pa_<kind>_<base64url32>`, SHA-256 lookup, scopes, expiry, revocation) and `audit_log`, which are what share links and MCP tokens become later; Hono middleware chain `requestId → cors → ipLimiter → auth → principalLimiter → requireScope → idempotency`; the ratelimit binding is per-colo and permissive, so exact quotas live in `usage_counters`; Apple native route with nonce required; Google ID-token verification with `aud`, `iss`, `exp`, `nonce`; Sentry PII off on both sides with a test that the error middleware never attaches bodies or headers; admin routes behind Cloudflare Access with `aud` validation; CI bundle grep of `expo export` output for `SECRET_PATTERNS` and provider hostnames, gitleaks, pnpm `minimumReleaseAge` 3 days.

**Honest note on deletion:** per-user DEKs make KEK rotation cheap but are not crypto-shredding, because the wrapped DEK sits inside Neon's PITR window. Effective deletion latency equals the production history retention, which I recommend setting to 1 day and disclosing.

**Documented only (`docs/security/threat-model.md`):** share-link threats (token guessing, cache poisoning, OG image enumeration, revoked-link caching, scraping) and MCP threats (token theft, confused deputy under the 2026-07-28 MCP auth spec, prompt injection in tool output, write actions needing two-step confirm, rate abuse) with the Phase 5 and 6 mitigations; App Attest and Play Integrity deferred with columns reserved; KEK rotation runbook.

## 11. Mobile app in Phase 0

Expo SDK 57 with Expo Router, CNG, `app.config.ts` reading `APP_VARIANT` to produce `app.planeahead.mobile`, `app.planeahead.mobile.dev` and `app.planeahead.mobile.preview` identifiers (immutable after first store upload), App Group, `aps-environment`, `NSSupportsLiveActivities`, `ios.enableSceneSupport`, aggregated `privacyManifests`. EAS profiles development, preview, production.

**Screens:** sign-in (Apple native, Google, magic link, anonymous), next-flight home with empty state, add-flight sheet, tracked-flight list, flight detail with timeline, settings (units, time format, theme, account, delete account). Dark mode via theme tokens. State: TanStack Query 5, zustand 5.

**Offline store:** expo-sqlite with change listeners, Drizzle schema mirroring sync entities, `useLiveQuery` on the list, `GET /v1/sync` applied in one exclusive transaction, outbox drained with `Idempotency-Key`.

**Native shells (compile in nightly CI, no behaviour):** expo-widgets placeholder widget plus a Live Activity layout with Dynamic Island regions and token listeners posting to `/v1/devices`; apple-targets watch and watch-widget (watchOS is outside expo-widgets scope); Kotlin `android-surfaces` module with an empty Glance widget; Wear OS Compose + Tiles module via a config plugin. Coexistence of the expo-widgets extension with an apple-targets watch target in one prebuild is an explicit acceptance test; if it fails, watch shells move to Phase 2 and ADR 0008 records it.

## 12. Deferred from the dossier to later phases

| Item | Phase | Reason |
|---|---|---|
| `PushSender` with APNs and FCM adapters, staging APNs smoke job, UserInbox delivery | 1 | Your brief puts basic push in Phase 1 |
| AeroAPI alert registration, alert-silence fallback to A1, `max_weekly` handling | 1 | Needs a real AeroAPI Standard account |
| Tracker merge path (`adoptSubscribers`, `superseded_by_id`) | 1 | Only triggers once AeroAPI returns `fa_flight_id`; columns exist now |
| ProviderBudget lease protocol and 8-way sharding | 1 | Phase 0 has a per-provider daily kill switch; sharding matters above ~10k flights |
| Airport boards route, AirportState behaviour | 1 | Adapter method exists in Phase 0 |
| PositionPoller DO, ADS-B adapters, aircraft hex table | 2 | Interfaces and design only |
| Queued GDPR export and deletion jobs | 5 to 7 | Phase 0 has synchronous delete and the detached-FK schema |
| ADB Flight Alert webhooks as primary change source (cadence B) | 1 decision, 2 build | Field coverage must be measured first |

## 13. CI/CD

`ci.yml` on PR and main: `typecheck`, `lint`, `test-node`, `test-workers` (Postgres 18 service container with a `server_version_num >= 180000` assertion), `test-mobile`, `db-migrations` (PR-only Neon branch via `neondatabase/create-branch-action`, `drizzle-kit check`, migrate, drift guard), `wrangler-dry-run`, `secrets-scan`, `toolchain-guard` (no Vitest 5, no TS 7, one wrangler version), nightly `native-smoke` (`expo prebuild --clean`, `xcodebuild`, `gradle assembleDebug`). `deploy-staging.yml` on push to main: migrate then `wrangler deploy --env staging` then smoke `/health`. `deploy-production.yml` on tag `v*` with required reviewer; full `wrangler deploy` if `exports` changed (DO lifecycle changes cannot go through versions), else `versions upload` and `versions deploy`. EAS: `eas update --auto` on PRs, preview builds on label, production build with `--auto-submit` on tags. EAS free tier's 45-minute timeout will be exceeded by MapLibre plus Swift targets; Starter ($19) is the floor.

## 14. Tests

**Unit (Vitest):** AeroDataBox adapter against recorded fixtures with undici `MockAgent` (field mapping, codeshares, ±1 day retry, 429/5xx as zero-cost error records); mocked AeroAPI adapter (bracketed first fetch, fa_flight_id thereafter, "never issues an unbounded ident query"); flight-key normaliser (IATA to ICAO, regional operators, leading zeros, origin-local date, midnight slip, `BA1512` and `AA100` resolve to one key); cadence function (SLO table to per-window counts, A1/A2/B totals, hard lifetime); cost logger (PE conversion, AE point shape, ≤200 per chunk); budget guard (derived caps, kill switch, refresh sub-budget); envelope crypto (AAD mismatch, IV uniqueness); Apple native route rejects a login without nonce; Sentry scrubbing; RPC schemas tolerate unknown fields.

**Integration (`@cloudflare/vitest-plugin`; unique DO name per test, alarms drained in `afterEach` via `runDurableObjectAlarm`, no `test.concurrent` in DO files):** `flight-tracker.lifecycle.test.ts` walks daily → hourly → 15-min → 30-min → post-landing → finished → `deleteAll` with a stubbed provider and injected clock, asserting call counts equal the imported A2 constants, two subscribers cause one call per refresh, a repeated alarm at the same clock is a no-op, a throwing provider yields one error record per slot across simulated retries, and hard lifetime terminates a flight that never reports `in`; `designator-resolver.test.ts` (50 concurrent searches → 1 provider call); `do-migrations.test.ts` (upgrade from every prior `user_version`); `routes.test.ts` via `SELF.fetch` (scopes, 429, idempotency replay, per-user caps, 500 refresh calls in 60 s → 1 call, two concurrent sync writers lose nothing); `queues/persist.test.ts` with `createMessageBatch`; `reconcile.test.ts`.

**Mobile (Jest):** sign-in renders providers; add-flight sheet validates against the shared schema; list renders from `useLiveQuery`.

## 15. Increments (one PR each, in order)

1. **Repo skeleton.** Copy research files out of the scratchpad, rename the directory to `/Users/jkowall/PlaneAhead`, `git init`, `gh repo create jkowall/planeahead --private`; pnpm workspaces, Turbo, TS base, ESLint with the no-module-scope-drizzle rule, `.node-version`, Renovate, CODEOWNERS, ADR template, `docs/research/` populated from the dossier, CI typecheck/lint/toolchain-guard. Accept: CI green.
2. **`packages/shared` contracts.** Zod schemas, `FlightStatus`, provider interfaces, uuidv7, flight-key normaliser with regional operator seed, cadence function with SLO table. Accept: unit tests pass; a script generates the cadence table for `docs/architecture.md` from the function.
3. **`packages/db` schema.** 61 tables, triggers, seeds (OurAirports + mwgg tz, OPTD carriers, aircraft types), `withDb`, `drizzle-kit check`, Postgres 18 pinned; first draft of `docs/schema-review.md`. Accept: migrations apply on fresh PG18 and fail clearly on PG17; drift guard clean.
4. **API Worker bootstrap.** Hono, `wrangler.jsonc` with all bindings and DO class shells, Hyperdrive to local Postgres, `/health`, Sentry, request-id, ratelimit and idempotency middleware, staging deploy workflow. Accept: `GET /health` on staging returns the migration hash.
5. **Auth.** Better Auth per-request factory (anonymous, magic link via Resend, Google idToken), custom Apple native route, envelope crypto, devices route, anonymous-to-account merge re-keying rows. Accept: workers tests sign in anonymously, upgrade via magic link, re-key rows; Apple login without nonce rejected; refresh token stored encrypted.
6. **Provider layer.** AeroDataBox adapter, mocked AeroAPI adapter with fixtures, cost logger, per-flight budget guard, token bucket, per-provider daily kill-switch DO; ADB lookahead measured with a real call and recorded as `capabilities.maxDaysAhead`. Accept: adapter tests pass; every call yields a `ProviderCallRecord`.
7. **FlightTracker and DesignatorResolver DOs.** Migration runner, state machine, idempotent alarm with attempt records, outbox → persist queue → Postgres + Analytics Engine, KV snapshot debounce, finish and `deleteAll`, hard lifetime. Accept: lifecycle test walks all tiers with A2 constants and survives simulated retries with one call per slot; resolver stampede test yields one call.
8. **Flight routes and sync.** Search, subscribe with caps and idempotency, list, detail, delete, coalesced refresh, xid8 sync feed with flight-state join, synchronous account delete. Accept: route tests pass including 429, 500 refreshes → 1 call, two-writer sync test, deletion leaves no user-owned rows while audit rows survive.
9. **Mobile scaffold.** Expo Router, auth and API clients, expo-sqlite + Drizzle + sync + outbox, sign-in, settings, Sentry, install-id analytics, EAS profiles, privacy manifests. Accept: dev build signs in on iPhone 17 Pro simulator and the Pixel AVD; settings persist across an offline restart.
10. **Next-flight home, add flight, detail.** `useLiveQuery` list, add sheet, detail with timeline. Accept: adding a flight on device produces one provider call in staging; adding the same flight from a second account produces none.
11. **Native surface shells and nightly smoke.** expo-widgets widget and Live Activity with token listeners, apple-targets watch shells, android-surfaces, wear plugin, `native-smoke` job. Accept: nightly builds of both platforms succeed with the expo-widgets extension and the watch target in the same iOS archive.
12. **Docs, admin, crons, production deploy.** `docs/architecture.md`, `cost-estimate.md`, final `schema-review.md`, `threat-model.md`, `open-decisions.md`; Access-protected admin page (provider calls per flight key and per day, DO schema versions); reconcile, housekeeping and AE rollup crons; production deploy exercised on both the full and gradual paths. Accept: lifecycle test imports the constants from the module that generated the docs table; a tagged deploy reaches production.

## 16. Verification (end to end)

1. `pnpm i && pnpm turbo run typecheck lint test` green locally on Node 24 with Postgres 18.
2. `pnpm dev`, then `curl localhost:8787/health` shows the migration hash; `POST /v1/flights` twice from two anonymous sessions for the same designator, then the admin page and `provider_calls` show exactly one AeroDataBox call for that flight key with `cost_units = 2`.
3. `eas build --profile development` for iOS and Android; on the iPhone 17 Pro simulator and the Pixel AVD: sign in, add tomorrow's AA100, see scheduled times within 5 s, kill the network, relaunch, list still renders.
4. Trigger `runDurableObjectAlarm` in the lifecycle test and compare the recorded call count with the number printed in `docs/architecture.md`.
5. Merge to main deploys staging; `/health` on the staging domain; a `v0.0.1` tag reaches production after approval.
6. Nightly `native-smoke` passes with both iOS targets present in the archive.

## 17. Local machine findings

Present: Node 24.21, npm 11, git 2.54, gh 2.101 authenticated as `jkowall`, Xcode 27 with iPhone 17 simulators, Android SDK with JDK 21 and a Pixel 10 Pro Fold AVD, an existing wrangler OAuth config (last refreshed 2026-09-10, so a Cloudflare login exists; the token is unvalidated). Missing: pnpm (install via `packageManager` + `npm i -g pnpm@12`), wrangler and eas-cli (workspace dev dependencies), Docker and psql. Decision: no local Postgres; `wrangler dev` and local tests use a per-developer Neon branch, so the Neon project must exist before increment 3 (Free plan is enough for branches until staging and production need Launch). No `docker-compose.yml` in the repo.

## 18. What I need from you

- **Domain: resolved.** `planeahead.app` on Cloudflare. Package scope `@planeahead/*`; API at `api.planeahead.app` and `api-staging.planeahead.app`; share pages and MCP get their own hostnames in Phases 5 and 6. Still needed: the legal entity name for the Apple and Google developer accounts.
- **GitHub repo: resolved.** `jkowall/planeahead`, private, created with `gh` in increment 1. Environment approval gates need GitHub Pro on a private repo; until then the production gate is a tag plus manual dispatch.
- **Cloudflare:** same account as the existing wrangler login. **You upgrade it to Workers Paid ($5/month) before increment 4**; increments 1 to 3 need no Cloudflare resources. Zero Trust team name for Access.
- **Neon project** on Launch, PG18, us-east-1, `main` and `staging` branches, API key for PR branches.
- **AeroDataBox: no key today.** Increment 6 ships against synthetic fixtures shaped from the published OpenAPI spec, with the lookahead measurement marked pending. The runnable milestone in section 13 needs a real key, so sign up for the direct Starter plan ($19, fixture recording) before increment 10 and Growth ($99) before staging carries real users. Starter cannot survive one busy month at 1k flights.
- **FlightAware AeroAPI: no key today, and none needed in Phase 0** (adapter is mocked). Personal key for fixture recording at your convenience; Standard at Phase 1. Ask sales about the account-level weekly alert cap and whether error responses bill.
- **Apple Developer Program** (organisation, D-U-N-S), Team ID, Sign in with Apple key, Services ID; one physical iOS 17.2+ device for the Phase 1 token tests.
- **Google Cloud project** with OAuth consent screen and web, iOS and Android client IDs; **start restricted-scope verification prerequisites and get a written CASA lab quote now**; Firebase service account for FCM in Phase 1.
- **Microsoft Entra** multi-tenant app registration and Partner Center enrolment (start now for Phase 3).
- **Expo account** (Starter), **Sentry** org, **Resend** account with verified domain. RevenueCat and Google Play Console can wait for Phase 5 and the first internal Android track.

## 19. Open decisions (recommendation first; pick at approval or later)

1. **Cadence.** A2 as the Phase 0 constant (72 polls + ~12 alerts, $0.60 list), A1 as fallback, B instrumented. The literal brief costs $0.93 to $3.77 per flight and hits Standard's rate limit at ~600 concurrently airborne flights.
2. **Change source for gates and times.** Evaluate AeroDataBox webhooks (about 80x cheaper per event than an AeroAPI delivery) as primary with AeroAPI alerts for OOOI; decide on measured field coverage at end of Phase 1.
3. **Position source.** adsb.lol batched via PositionPoller plus an operated feeder (~$150 one-off); paid positions (AeroAPI $0.010 per set, foreground-only) decided before 10k flights/month. Confirm ODbL share-alike is acceptable for persisted tracks.
4. **Free-tier limits.** 5 active subscriptions, 2 concurrently live-tracked, 20 new instances per day, no Live Activities. Looser limits raise break-even conversion above 3% on A2.
5. **Local-only mode semantics.** Lazily created server-side anonymous user; truly offline means no push and no shared tracker.
6. **iOS surfaces path.** expo-widgets for widget, Live Activity and Dynamic Island (Expo UI components only, iOS only); apple-targets only for watchOS. Hand-written SwiftUI buys unrestricted layouts at the cost of owning ActivityKit plumbing.
7. **Google native sign-in module.** Paid Universal Sign In if EAS covers it, else the legacy-SDK module, else expo-auth-session PKCE.
8. **Session policy.** 30-day sliding sessions with a 5-minute cookie cache.
9. **Account deletion timing.** Immediate hard delete; schema supports a 7 to 14 day grace window.
10. **Retention.** 90 days for `flight_events` rows (timeline archived to R2 for 365 days), `provider_calls` (durable in `provider_call_daily`), `notifications`; 7 days for exports.
11. **Neon region and CU floor.** us-east-1, 0.5 CU always-on in production, `locationHint: 'enam'` on FlightTracker and UserInbox creation. Tell me if you want a different region or an OTel export target (Honeycomb or Grafana) for Workers traces.
12. **LLM vendor for email extraction (Phase 3).** Needs a zero-data-retention agreement; Anthropic covered models retain 30 days even under ZDR, which conflicts with "no raw bodies retained" unless disclosed.
13. **Deletion latency versus true crypto-shredding.** Set production PITR retention to 1 day and disclose; moving DEK wrapping outside the PITR domain is a Phase 2 item if the privacy policy needs a stronger claim.
14. **Separate hostnames** for share pages and the MCP endpoint versus paths on the API Worker. Recommend separate hostnames.
15. **Expo SDK 58 timing.** Upgrade in its first stable week (Android widgets, scene lifecycle default).

**Unverified items carried into the plan and flagged in code comments:** AeroAPI weekly alert cap default and non-retry of failed deliveries (support page returned 403); average alerts per flight (12); ADB alert field coverage and lookahead per plan; AeroAPI discount band semantics above $32k; whether FlightAware bills error responses; 4x departure-bank peak factor; APNs `liveactivity` header requirements; Wear OS Gradle config-plugin pattern; CASA lab prices.

## 20. Decisions taken at plan review (2026-09-19)

| Question | Answer | Effect on the plan |
|---|---|---|
| Product name and domain | **PlaneAhead**, `planeahead.app`, already on Cloudflare | Directory renamed to `/Users/jkowall/PlaneAhead` first; repo, package scope, identifiers, R2 buckets and token prefix use `planeahead` / `pa_` |
| Model split | Mixed by risk | Section 21 as written: Fable orchestrates, builds increments 2, 3, 5, 7 and reads every diff; Opus 5 builds the rest; Sonnet 5 for mechanical stages |
| Phase 0 scope | Lean foundations | 12 increments in section 15; section 12 items stay deferred |
| Repository | `jkowall/planeahead`, private | Created with `gh` in increment 1; production approval gate is tag plus manual dispatch until GitHub Pro |
| Cloudflare | Same account as the wrangler login, not yet Workers Paid | Owner upgrades before increment 4; increments 1 to 3 need no Cloudflare resources |
| Local database | Neon dev branch only | No Docker, no Homebrew Postgres, no `docker-compose.yml`; Neon project needed before increment 3; CI keeps the `postgres:18` container |
| Cadence | A2 (72 polls + ~12 alerts, $0.60 list) | Lifecycle test constant and cost docs as written |
| Provider keys | None yet | Increment 6 uses synthetic fixtures; AeroDataBox Starter key needed before increment 10 for the runnable milestone; AeroAPI not needed in Phase 0 |
| iOS surfaces | expo-widgets | apple-targets only for watch shells; coexistence test in increment 11 |
| Free tier | 5 active subscriptions, 2 live, 20 new instances per day | Enforced in `usage_counters` from increment 8 |
| Local-only mode | Lazy server-side anonymous user | Created on first add-flight or push registration; merge on sign-in re-keys rows and re-subscribes DOs |
| Telemetry | Cloudflare-native only | Workers Logs 10% sampling in production, 100% staging, Analytics Engine; OTLP export deferred |
| Neon region | us-east-1 (default kept) | Change at approval if you want otherwise; region is fixed per Neon project |

Open decisions still unanswered from section 19: 2 (gate and time change source), 3 (position source), 7 (Google native sign-in module), 8 (session policy), 9 (account deletion timing), 10 (retention), 12 (LLM vendor for extraction), 13 (deletion latency versus crypto-shredding), 14 (separate hostnames), 15 (SDK 58 timing). None block Phase 0; I proceed on the recommendations and record each in `docs/open-decisions.md`.

## 21. Model allocation for the build

Verified Anthropic API pricing per MTok in/out (cached 2026-06-24): Fable 5.1 $10/$50 (cache reads $0.25), Opus 5 $5/$25, Sonnet 5 $2/$10, Haiku 4.5 $1/$5 with a 200K context. Fable is 2x Opus and 5x Sonnet per token. The planning workflow consumed 1.7M subagent tokens on Fable; implementation will be several multiples of that.

**Recommendation: not all-Fable.** Allocate by what a mistake costs to unwind, not by task size.

| Role | Model | Effort | Why |
|---|---|---|---|
| Orchestrator (this session): per-increment specs, irreversible decisions, final read of every diff before a PR | Fable 5.1 | high to xhigh | Long-horizon judgment; one model keeps the plan coherent across 12 increments |
| Design-critical builds: increment 2 (flight-key normaliser, cadence function), 3 (schema), 5 (auth, envelope crypto), 7 (FlightTracker alarm idempotency, outbox, DesignatorResolver) | Fable 5.1 builds; two Opus 5 reviewers with distinct lenses (correctness, security) | xhigh | Retry semantics, key collisions and crypto AAD are the places a wrong default is expensive; review diversity from a second model family catches what a same-model reviewer shares blind spots on |
| Well-specified builds: increments 1, 4, 6, 8, 9, 10, 11, 12 (routes, adapters, Expo screens, native shells, CI, docs) | Opus 5 builds; one Opus reviewer plus my read | xhigh | Opus 5 is the coding default; the spec is tight enough that review catches drift |
| Mechanical stages: fixture recording, seed importers, ESLint and Renovate config, ADR boilerplate, docs table generation, lint-fix loops, test scaffolding from a written table | Sonnet 5 | medium | 5x cheaper than Fable and the output is checkable by tests |
| Log triage, diff summaries, formatting passes | Haiku 4.5 | low | Rarely needed; 200K context limits it to small inputs |

**Mechanics.** One Workflow script per increment with per-agent `model` and `effort`: spec (me) → build in a worktree → run tests → review panel → fix → my final read. Escalation rule: an increment whose Opus build fails review twice on the same issue moves to Fable for the fix; an increment that turns out mechanical moves down to Sonnet next time. Tokens per increment per model are logged in `docs/build-log.md` from the workflow results so the split is re-tuned after increments 1 to 4. Cost is judged per completed increment, not per request, because a cheaper model that needs a second round is not cheaper.

**Expected effect:** roughly half the token spend of all-Fable, with Fable still on every irreversible decision and every diff, and faster wall-clock from parallel Opus builders. The risk is review load on the orchestrator, which the escalation rule bounds.

**Product-side model (Phase 3, for the record):** email itinerary extraction on Sonnet 5 with structured outputs (`output_config.format`, strict schema) and the Batch API for history backfills at 50% off; Haiku 4.5 if evals show parity. Fable 5.1 is not eligible for zero data retention, which rules it out for extraction regardless of cost.
