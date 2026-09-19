## 1. Context

**Why Phase 0.** Every later phase (live tracking, notifications, email sync, sharing, MCP) depends on five things that are expensive to change once data exists: the flight identity model, the Postgres schema, the provider abstraction with cost attribution, the FlightTracker Durable Object lifecycle, and the rule that a flight's first billable provider call is serialised through exactly one object. Phase 0 fixes those, proves the Cloudflare topology end to end with tests that exercise alarms, retries and end-of-life, and leaves everything cheap to add later (Live Activity UI, positions, email parsing) as compiling shells or documented designs.

**"Runnable" at the end of Phase 0 means:** `pnpm dev` starts `wrangler dev` (API Worker with FlightTracker, DesignatorResolver, AirportState, UserInbox and ProviderBudget DOs, Queues, KV, R2 emulated) against a local Postgres 18, and an Expo development build signs in (Apple, Google, magic link, or anonymous), adds a flight by number and date, and sees it in a list backed by a FlightTracker DO that has fetched it once from AeroDataBox, emitted the call record through the `persist` queue into Postgres and Analytics Engine with a cost unit, and scheduled its next refresh alarm. CI is green on typecheck, lint, unit tests, and the FlightTracker lifecycle integration test, whose provider call count is imported from the same cadence function that generates the table in `docs/architecture.md`.

**Explicitly deferred:** live positions and map rendering (interfaces and PositionPoller design only); real AeroAPI traffic (mocked adapter, real fixtures recorded with a Personal key); push delivery beyond one APNs sandbox smoke test; Live Activity, widget and Wear UI (compiling shells only); email sync, imports, calendar, sharing, logbook, delay risk; RevenueCat paywall (tables and webhook only); MCP endpoint (token primitive only); web app beyond the Expo Router static shell.

**Where I push back on the brief:**

- **The literal 2-minute AeroAPI polling from boarding through landing is not viable.** AeroAPI Standard is capped at 5 result sets per second and Premium starts at a $1,000 monthly minimum ([flightaware.com/commercial/aeroapi](https://www.flightaware.com/commercial/aeroapi/)). Section 7 replaces the cadence with one derived from detection-latency SLOs per event type.
- **AeroAPI cannot serve refreshes more than 2 days ahead** (`/flights/{ident}` start and end must be within 10 days past and 2 days future per the [OpenAPI spec](https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml)). Pre-48h refreshes go to AeroDataBox.
- **AeroAPI push alerts do not cover gate changes.** Events are filed, departure, arrival, cancelled, diverted, out, off, on, in, hold_start, hold_end; departure and arrival are bundled with estimated-time changes ([spec mirror](https://wal.sh/research/ads-b/aeroapi-reference.html); FlightAware's support article returned 403 at review time, so the max_weekly default of 1,000 per week on Standard is unverified from the reviewer's citation). Alerts therefore cover ETA creep and OOOI, not gates; gates need polling or AeroDataBox's webhook Flight Alert API (section 6).
- **Positions must not be per-FlightTracker alarms.** One PositionPoller DO per provider with batched queries; adsb.fi and airplanes.live are non-commercial only.
- **Expo Push Service cannot start or update Live Activities**, so a direct APNs adapter is mandatory from Phase 0.
- **Cloudflare Email Service is Beta with an undisclosed daily quota**; magic links need Resend as the default sender.
- **Add `packages/db`** alongside `packages/shared` so the mobile bundle never depends on drizzle or pg.
- **Durable Objects never touch Postgres directly.** Every DO write to Postgres goes through an outbox and a queue consumer (section 4). This is the single biggest structural change from the draft and it removes an unresolved vitest-plugin issue from the critical path.

## 2. Decisions and recommendations

**Mobile framework: React Native + Expo SDK 57 (`expo@^57.0.23`), upgrade to 58 in its first stable week.**
Why: Live Activity, Dynamic Island, WidgetKit, Glance, Wear tile and watch complication are Swift or Kotlin in every candidate framework, but Expo now ships the iOS half natively: expo-widgets is stable since SDK 56 ("the library is now stable", [expo.dev/changelog/sdk-56](https://expo.dev/changelog/sdk-56)) with Live Activities, Dynamic Island regions, per-activity push tokens and push-to-start tokens (iOS 17.2+) ([docs.expo.dev/versions/latest/sdk/widgets](https://docs.expo.dev/versions/latest/sdk/widgets/)), and SDK 58 beta adds Android widgets on a dedicated Hermes runtime ([expo.dev/changelog/sdk-58-beta](https://expo.dev/changelog/sdk-58-beta)). Flutter's `live_activities` and `home_widget` require hand-written Swift and Kotlin ([pub.dev/packages/live_activities](https://pub.dev/packages/live_activities)); Compose Multiplatform 1.11 has no WidgetKit or ActivityKit story. Expo keeps TypeScript end to end, has CNG so `/ios` and `/android` are never committed, and yields web via Expo Router. Legacy architecture was removed in SDK 55. `57.0.23` is the patch that adds `ios.enableSceneSupport`, required for iOS 27 SDK builds and default in SDK 58 ([expo.dev/changelog/sdk-57](https://expo.dev/changelog/sdk-57)).
Rejected: Flutter (same native workload, Dart breaks shared zod contracts), KMP (Swift Export alpha), bare RN (loses CNG, EAS, config plugins).
Reversibility: low.

**Database: Neon Postgres 18 via Hyperdrive, not D1.**
Why: D1 has a 10 GB per-database cap ([developers.cloudflare.com/d1/platform/limits](https://developers.cloudflare.com/d1/platform/limits/)) that `flight_events`, `provider_calls` and BTS aggregates exceed within a year at 100k flights/month; the SQLite dialect means every schema file and dialect-dependent query is rewritten on migration; `wrangler d1 export` blocks the database. The read-replication argument in the draft is dropped (status not asserted). Migration risk if started on D1: full schema rewrite plus a blocking export window or dual-write period. Hyperdrive is included on Workers Paid ([developers.cloudflare.com/hyperdrive/platform/pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)). Neon Launch is $0.106/CU-hour and $0.35/GB-month with up to 7 days history retention ([neon.com/pricing](https://neon.com/pricing)).
Connection budget: Hyperdrive opens up to ~100 origin connections per configuration and may open additional pools per region ([developers.cloudflare.com/hyperdrive/platform/limits](https://developers.cloudflare.com/hyperdrive/platform/limits/)); Neon 0.25 CU has 104 `max_connections` with 7 reserved, 0.5 CU has 209 ([neon.com/docs/connect/connection-pooling](https://neon.com/docs/connect/connection-pooling)). Therefore: one Hyperdrive configuration (caching disabled on the resource, `wrangler hyperdrive create --caching-disabled`) pointed at the Neon direct (non-pooler) endpoint, reference data cached in KV instead of a second configuration, and production compute minimum 0.5 CU with scale-to-zero disabled for p50 latency (a latency choice, not a forced consequence; staging keeps scale-to-zero).
Postgres 18 is pinned in local docker, the CI service container and Neon, with a `SHOW server_version_num >= 180000` assertion in test `globalSetup`, because `uuidv7()` does not exist in PG17 ([postgresql.org/docs/17/functions-uuid](https://www.postgresql.org/docs/17/functions-uuid.html), [postgresql.org/docs/18/functions-uuid](https://www.postgresql.org/docs/18/functions-uuid.html)). UUIDv7 is also generated application-side in `packages/shared` for every row (offline and DO-born rows need it anyway), so the DB default is a safety net, not a dependency.
Reversibility: medium.

**Auth library: Better Auth 1.7.5, pinned, plus one custom native Apple route.**
Why: first-party Hono integration, Drizzle adapter, Expo client with SecureStore, and the plugins the product needs: `anonymous` with `onLinkAccount`, `magicLink`, Apple and Google `idToken` sign-in ([better-auth.com/docs/integrations/expo](https://better-auth.com/docs/integrations/expo)). The Apple `idToken` path signs the user in directly with no code exchange and nonce optional ([better-auth.com/docs/authentication/apple](https://better-auth.com/docs/authentication/apple)), so it never captures the refresh token Apple's revoke endpoint requires ([developer.apple.com/documentation/signinwithapplerestapi/revoke_tokens](https://developer.apple.com/documentation/signinwithapplerestapi/revoke_tokens)). Phase 0 adds `POST /api/auth/apple/native` taking `{identityToken, authorizationCode, rawNonce}`: verify with jose against Apple JWKS with nonce required (SHA-256 of rawNonce), exchange the code at `appleid.apple.com/auth/token` with the ES256 client secret and `client_id` = bundle id, envelope-encrypt the refresh token into `accounts.refresh_token_enc`, then create the Better Auth session. A unit test rejects a login without a nonce. Better Auth instances are built per request via a factory that receives the per-request db client (see ORM).
Rejected: Clerk, Supabase Auth, Auth.js, Lucia, hand-rolled (same reasons as the draft).
Risk: rapid releases; pin exact, run the Miniflare suite on every bump; verify SecureStore key format (issue [#5426](https://github.com/better-auth/better-auth/issues/5426)).
Reversibility: medium.

**Email sending: `MailSender` interface, Resend default, Cloudflare Email Service second adapter.**
Why: Cloudflare Email Sending is Beta with an undisclosed starting quota ([developers.cloudflare.com/email-service/platform/limits](https://developers.cloudflare.com/email-service/platform/limits/)); Resend is 3,000/month free at 100/day, $20/month for 50k ([resend.com/pricing](https://resend.com/pricing)). Magic-link sends are additionally limited per `lower(email)` (3/hour, 10/day) in `usage_counters`, always returning 200, with an alert at 80% of the sender's daily cap.
Reversibility: high.

**ORM and migrations: drizzle-orm 0.45.2 + drizzle-kit 0.31.10, restricted API surface, Workers driver rules enforced.**
Why: 1.0 is at rc with changes to relations, RLS syntax and migration folder format. Use only APIs identical in v1. Migrations run from CI with a direct Neon URL. Workers rules: a new client per request or per queue batch, closed with `ctx.waitUntil(client.end())`, never held across invocations ([developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/)); a `withDb(env, ctx, fn)` helper in `packages/db` and an ESLint rule banning module-scope `drizzle(` in `apps/api`. `flight_key`'s generation expression is frozen in ADR 0003 because drizzle-kit emits generated-column changes as drop and recreate. `updated_at` is set by a `set_updated_at()` trigger in the first migration; `$onUpdate` is kept for type inference only.
Reversibility: high for the version, low for schema decisions in section 5.

**Monorepo tooling: pnpm 12 workspaces (isolated linker) + Turborepo 2.11, Node 24 LTS, TypeScript ~6.0.3.**
Why: Expo SDK 54+ supports isolated pnpm installs ([docs.expo.dev/guides/monorepos](https://docs.expo.dev/guides/monorepos/)); Corepack no longer ships with Node 25+, so pin pnpm via `packageManager`. TypeScript is pinned to the version SDK 57 expects (~6.0.3); the `app.config.ts` bug [#47627](https://github.com/expo/expo/issues/47627) is closed and is no longer the reason. The catalog pins `wrangler` to the version bundled by `@cloudflare/vitest-plugin` (4.135.0 for 1.1.13 per npm metadata, [registry.npmjs.org/@cloudflare/vitest-plugin/latest](https://registry.npmjs.org/@cloudflare/vitest-plugin/latest)) and a CI check asserts `pnpm ls wrangler` shows one version; Renovate groups both.
Reversibility: high.

**Lint and test tooling: ESLint 9 flat + Prettier 3; Vitest ~4.1 + @cloudflare/vitest-plugin 1.1.x for api/shared/db; Jest 29 via jest-expo 57 + RNTL for mobile.**
Why: Vitest 5 breaks the Workers pool ([workers-sdk#15618](https://github.com/cloudflare/workers-sdk/issues/15618)). Storage isolation in the plugin is per test file, not per test ([known issues](https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)), which shapes the DO test design in section 12.
Reversibility: high.

**Typed API client: Hono RPC `hc<AppType>` with `@hono/zod-validator`, declarations emitted via project references; Zod 4 everywhere.** ([hono.dev/docs/guides/rpc](https://hono.dev/docs/guides/rpc)). Reversibility: high.

**Offline store: expo-sqlite + drizzle-orm `useLiveQuery`, server-authoritative pull sync plus a client outbox with idempotency keys.**
Why: WatermelonDB has no documented New Architecture support since 0.27.1 (2023, [watermelondb.dev/docs/CHANGELOG](https://watermelondb.dev/docs/CHANGELOG)) and RN 0.82+ is New Architecture only; treat as unsupported. PowerSync is bidirectional sync machinery for a model where the server is truth. expo-sqlite has change listeners and a Drizzle driver ([orm.drizzle.team/docs/sqlite/connect-expo-sqlite](https://orm.drizzle.team/docs/sqlite/connect-expo-sqlite)). Sync feed design is in section 5 (xid8 watermark, flight state via subscription join).
Reversibility: medium.

**Maps and tiles: @maplibre/maplibre-react-native 11.4.0 + OpenFreeMap, Protomaps PMTiles on R2 as owned fallback.** ([openfreemap.org](https://openfreemap.org/), [docs.protomaps.com/deploy/cloudflare](https://docs.protomaps.com/deploy/cloudflare)). Phase 0 pins the dependency only. Reversibility: high.

**Push strategy: expo-notifications for permissions and display; raw APNs and FCM tokens stored server-side; Workers `PushSender` with `apns-direct` (ES256 via WebCrypto, `redirect: 'manual'`), `fcm-v1` (service-account JWT, secret `FCM_SERVICE_ACCOUNT_JSON`), optional `expo-push`; Live Activities always `apns-direct` with topic `<bundleId>.push-type.liveactivity` and `apns-push-type: liveactivity` (Apple header requirements unverified from memory).**
Why: Expo Push Service cannot drive Live Activities. Workers-to-APNs HTTP/2 works in production per an open user report ([workerd#4841](https://github.com/cloudflare/workerd/issues/4841)) but not in local workerd on macOS, so Phase 0 adds a manually dispatched staging smoke job that sends one alert push and one liveactivity push to `api.sandbox.push.apple.com` with a real device token and asserts 200 or a 400 with a reason, proving the path from Cloudflare's edge before Phase 1 depends on it.
Reversibility: high.

**Analytics: first-party events to Workers Analytics Engine, no third-party analytics SDK.**
Why: `POST /v1/events` is unauthenticated, rate-limited by the binding, keyed by an install-scoped random id that is never joined to `users`, with no request id or IP written to `PRODUCT_EVENTS`; this meets Apple's "stripped of direct identifiers before collection" standard for "not linked" ([developer.apple.com/app-store/app-privacy-details](https://developer.apple.com/app-store/app-privacy-details/)). It does not remove privacy-manifest obligations, which come from required-reason API use in Expo, React Native and Sentry packages and are aggregated via `expo.ios.privacyManifests` ([docs.expo.dev/guides/apple-privacy](https://docs.expo.dev/guides/apple-privacy/)). Sentry crash and performance data are declared under Diagnostics, collected, not linked. Analytics Engine is 10M points/month included ([pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/)); 3-month retention means a nightly rollup into Postgres.
Reversibility: high.

**Error tracking: Sentry on mobile and Workers, PII off.** ([sentry.io/pricing](https://sentry.io/pricing/)). Reversibility: high.

## 3. Repository layout

```
taxiway/
  .github/
    CODEOWNERS                     # two reviewers required for apps/api/wrangler.jsonc `exports` and packages/db/migrations
    renovate.json                  # group:monorepos, TS <7, vitest <5, wrangler+vitest-plugin grouped, expo majors manual
    workflows/ci.yml               # typecheck, lint, unit, workers, mobile, db-migrations, wrangler dry-run, secrets-scan
    workflows/deploy-staging.yml   # push main: migrate Neon staging -> wrangler deploy --env staging
    workflows/deploy-production.yml# tag v*: gate -> migrate -> full deploy if `exports` changed, else versions upload+deploy
    workflows/apns-smoke.yml       # manual: real sandbox APNs alert + liveactivity push from staging
    workflows/mobile-preview.yml   # label build:preview -> eas build preview; eas update --auto on PRs
    workflows/mobile-release.yml   # tag v*: eas build production --auto-submit
  .node-version                    # 24
  package.json                     # "packageManager": "pnpm@12.4.2"
  pnpm-workspace.yaml              # catalog: typescript ~6.0.3, vitest ~4.1, wrangler (= plugin-bundled), hono, zod 4, drizzle-*
  turbo.json                       # typecheck, lint, test, build, db:check
  tsconfig.base.json               # strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax
  tsconfig.json                    # solution file with references
  eslint.config.js                 # expo block for apps/mobile; type-checked ts-eslint elsewhere; no-module-scope-drizzle rule
  docker-compose.yml               # postgres:18 for local dev
  docs/
    architecture.md                # topology, DO lifecycle, outbox->queue->Postgres, cadence table generated from packages/shared
    cost-estimate.md               # section 8 with assumptions, positions scenarios
    schema-review.md               # section 5 outline
    security/threat-model.md       # section 9
    open-decisions.md              # section 16
    adr/0001-expo.md 0002-neon-not-d1.md 0003-flight-key.md 0004-hono-rpc.md 0005-identifiers.md 0006-uuidv7.md
        0007-do-postgres-free.md 0008-expo-widgets.md
  apps/
    api/
      wrangler.jsonc               # bindings per env (section 4)
      vitest.config.ts             # cloudflareTest({ wrangler: { configPath } })
      .dev.vars.example
      src/index.ts                 # Hono app, export type AppType, DO class exports
      src/middleware/{request-id,auth,scope,rate-limit,attestation,sentry}.ts
      src/routes/{health,auth,apple-native,flights,search,devices,me,events,admin,webhooks}.ts
      src/do/flight-tracker.ts     # state machine, alarm, outbox, budget lease, merge path
      src/do/designator-resolver.ts# serialises the first provider call per marketing designator
      src/do/airport-state.ts      # shell: METAR/TAF/NAS tables
      src/do/user-inbox.ts         # shell: prefs, pending, sent tables
      src/do/provider-budget.ts    # 8 shards per provider per UTC day, lease protocol
      src/do/migrations/<class>/NNN.sql   # PRAGMA user_version runner, per class
      src/do/migrate.ts            # runner under blockConcurrencyWhile + transactionSync
      src/providers/{aerodatabox.adapter.ts,aerodatabox.fixtures/,aeroapi.mock.ts,aeroapi.fixtures/,cost-log.ts,budget.ts,token-bucket.ts}
      src/push/{sender.ts,apns.ts,fcm.ts}
      src/mail/{sender.ts,resend.ts,cloudflare-email.ts}
      src/crypto/{envelope.ts,key-provider.ts}
      src/queues/{persist,notify,provider-events,imports}.ts   # persist: DO outbox -> Postgres + Analytics Engine (chunked <=200 points)
      src/cron/{reconcile,housekeeping,ae-rollup}.ts            # reconcile re-arms stuck trackers every 15 min
      test/unit/**                 # adapters, flight-key, cost logger, cadence, budget, envelope crypto, scrubbing
      test/workers/**              # FlightTracker lifecycle, resolver stampede, budget ladder, routes, queues
    api-admin/                     # separate Worker behind Cloudflare Access; service bindings to api
      wrangler.jsonc src/index.ts
    mobile/
      app.config.ts                # APP_VARIANT -> bundle id suffixes, App Group, entitlements, privacyManifests aggregate
      eas.json                     # development / preview / production + submit profiles
      metro.config.js babel.config.js jest.config.js tsconfig.json
      src/app/(auth)/sign-in.tsx
      src/app/(app)/index.tsx      # next-flight home (empty state) + add flight sheet
      src/app/(app)/settings.tsx
      src/lib/{api-client.ts,auth-client.ts,sync.ts,analytics.ts,db/schema.ts,db/migrations.ts}
      src/features/{flights,auth,settings}/
      widgets/                     # expo-widgets: placeholder home widget + Live Activity layout + Dynamic Island regions
      targets/watch/ targets/watch-widget/   # @bacons/apple-targets: empty SwiftUI watch app + complication (watchOS only)
      modules/android-surfaces/    # local Expo Module (Kotlin): Glance widget + ongoing notification stubs
      wear/                        # Compose for Wear OS + Tiles module
      plugins/withWearApp.ts       # config plugin wiring the wear module into settings.gradle
  packages/
    shared/                        # @taxiway/shared: zod contracts, DTOs, FlightStatus, provider interfaces, flight-key
                                   # normaliser (OPTD IATA->ICAO + regional operator map), cadence fn + SLO table,
                                   # uuidv7(), LiveActivityContentState, SyncEnvelope, RPC schemas (versioned), SECRET_PATTERNS
    db/                            # @taxiway/db: drizzle schema (full feature list), drizzle.config.ts, migrations/,
                                   # seed/ (airports, airlines, aircraft types), withDb helper, columns.ts
```

## 4. Backend architecture for Phase 0

**Hono routes (`apps/api`):**

| Route | Purpose |
|---|---|
| `GET /health` | liveness, env, migration hash |
| `ALL /api/auth/*` | Better Auth (anonymous, magic link, Google idToken, session) |
| `POST /api/auth/apple/native` | custom Apple route: nonce required, code exchange, refresh token encrypted, session created |
| `GET /v1/me`, `PATCH /v1/me/preferences` | profile, units, time prefs |
| `POST /v1/devices` | register install, platform, `ios_version`, push token kind |
| `GET /v1/flights/search?number=&date=` | Postgres `flight_designators` → KV → `DESIGNATOR_RESOLVER.getByName(designator-date).resolve()` (single provider call) |
| `POST /v1/flights` | subscribe; `Idempotency-Key` required; enforces per-user caps from `usage_counters`; `FLIGHT_TRACKER.getByName(key).subscribe()` |
| `GET /v1/flights`, `GET /v1/flights/:id` | list with snapshot (KV `flight:snapshot:*`, fallback DO `getState()`), detail with timeline |
| `DELETE /v1/flights/:id` | tombstone + DO `unsubscribe` (alerts deleted when last subscriber leaves) |
| `POST /v1/flights/:id/refresh` | user refresh; honoured inside the DO only if last fetch is older than half the tier interval; 10/flight/day; separate sub-budget |
| `GET /v1/sync?since=` | user-owned rows via xid8 watermark cursor + flight state via subscription join |
| `POST /v1/events` | unauthenticated, install-id keyed, binding rate-limited → Analytics Engine |
| `POST /v1/webhooks/aeroapi`, `POST /v1/webhooks/aerodatabox` | shared-secret verified, enqueue to `provider-events` (Phase 0: mock and fixture payloads) |
| `POST /v1/webhooks/revenuecat` | HMAC verify, insert `revenuecat_events` on conflict do nothing |
| `POST /v1/me/export`, `POST /v1/me/delete` | GDPR jobs (queued) |
| `GET /s/:token` | share page shell, identical 404 for everything in Phase 0 |

**Durable Object classes (SQLite-backed, declared with `exports`, each with a `PRAGMA user_version` migration runner executed in the constructor under `blockConcurrencyWhile` inside `transactionSync`; `do_schema_version` emitted by `getState()`):**

- **FlightTracker**, name = `flight_key` (`AAL-100-2026-09-19-KJFK`). Tables: `flight` (phase, snapshot_json, cadence tier, next_refresh_at, `attempt_started_at`, provider ids as TEXT, fa_flight_id, registration, icao_hex, tz, `max_lifetime_at`, do_schema_version), `subscribers(subscription_id PK, user_id, muted, overrides_json, added_at, removed_at)`, `events(seq PK, id UNIQUE, occurred_at, type, field, old_json, new_json, source, provider_call_id, flushed)`, `positions` ring (max 2,000 rows; empty in Phase 0), `budget(window, provider, calls, cost_units, lease_remaining)`, `user_refresh(day, count)`, `outbox(seq, kind, payload_json, attempts, sent_at)`, `notif_dedupe(dedupe_key PK)`, `alert_registrations(provider, alert_id, max_weekly, deliveries, expected_by)`.
  - **Alarm handler (idempotent under retries):** in one `transactionSync` before any I/O: read `alarmInfo.retryCount`; if `retryCount > 0` and `attempt_started_at` is newer than the tier interval, skip provider I/O; otherwise record `attempt_started_at`, debit the local lease, append the outbox intent, and `setAlarm(nextTierSlot)`. Then the provider fetch runs fire-and-record: every provider error (429, 5xx, timeout) is caught, logged as a `ProviderCallRecord` with `result=error` and zero PE if the provider returns an error status (whether FlightAware bills error responses is unverified; owner asks FlightAware), and a bounded backoff alarm is set. Only storage errors may throw. Retries are at-least-once with up to 6 attempts ([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)), so this design guarantees at most one provider call per tier slot.
  - **Outbox flush:** on every state change the DO sends outbox rows to the `persist` queue (Queue bindings are usable from DOs) and marks `sent_at`; the queue consumer writes `flight_instances`, `flight_events`, `provider_calls` idempotently by event id and writes Analytics Engine points in chunks of at most 200 per invocation (cap is 250, [limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)). KV snapshot publishes are debounced to one per 2 s and a KV 429 never fails the alarm (KV allows 1 write/s/key, [write-key-value-pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)).
  - **Terminal conditions:** `in` observed or `max_lifetime_at = min(scheduled_in + 6 h, actual_off + 2 × block)` reached. At arrival+2h (or max lifetime): flush, write final snapshot and the full event list to R2 `events/{YYYY}/{MM}/{flight_key}.jsonl.gz`, set phase=`finished`, `setAlarm(+22 h)`. The finished-phase alarm verifies the outbox is empty and the registry row is finished, then `deleteAll()`, which also deletes the alarm at compatibility dates ≥ 2026-02-24 ([storage API](https://developers.cloudflare.com/durable-objects/api/storage-api/)). `subscribe()` on a finished DO returns `archived`.
  - **Merge path:** if the first AeroAPI fetch returns a `fa_flight_id` already on another `flight_instances` row, or an operator that changes the canonical key, the tracker migrates subscribers to the canonical DO via `adoptSubscribers()`, writes `superseded_by_id` and a `flight_instance_merges` row through the outbox, deletes its alerts, and finishes.
  - RPC: `subscribe`, `unsubscribe`, `adoptSubscribers`, `getState`, `applyProviderEvent`, `forceRefresh(reason)`, `getCostLedger`. RPC payloads are versioned zod schemas in `packages/shared` tolerant of unknown fields, because a new Worker version can call an old DO during gradual rollout ([gradual deployments with DOs](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)).
- **DesignatorResolver**, name = `${marketingIata}${number}-${dateLocal}`. Performs the single AeroDataBox call for an unresolved designator, canonicalises the key with the provider-independent normaliser, returns `{flightKey, instance, designators[]}`; the Worker upserts `flight_designators` and `flight_instances` (unique constraints make concurrent upserts idempotent). Caches the answer in its own storage for 24 h and `deleteAll()`s after. AirportState will serialise boards the same way before Phase 2.
- **AirportState**, name = ICAO. Tables `meta`, `delay_index` (48h ring), `active_flights`, `budget`. Schema and constructor only.
- **UserInbox**, name = user id. Tables `devices`, `prefs`, `subscription_overrides`, `pending`, `sent` (7-day ring), `live_activities`. `enqueue()` with dedupe; no delivery.
- **ProviderBudget**, name = `${provider}:${utcDate}:${hash(flight_key) % 8}` (8 shards per provider per day). `counters(bucket PK, count, cost_units)`; `reserveLease(n)` returns granted PE or deny. FlightTrackers take an 8 PE lease, decrement locally, re-reserve when exhausted; worst-case overshoot = active trackers × 8 PE (≈10k in-window trackers at 100k flights/month → 80k PE, $400), stated in `docs/architecture.md`. Each shard rolls its counters into KV `budget:day:{date}:{provider}` every minute; the ladder reads the KV sum. Reserve calls have a 250 ms timeout that fails open and emits a metric.

DOs cannot be enumerated in production, so `flight_instances.flight_key` in Postgres is the registry, and the `reconcile` cron (`*/15`) scans `flight_instances where tracking_state in (active tiers) and next_refresh_at < now() - interval '30 min'` and calls `forceRefresh('reconcile')`, which re-arms trackers whose alarm was dropped after 6 failed retries.

**Queues:** `persist` (batch 100, retries 5, DLQ), `notify` (batch 50, retries 5, DLQ), `provider-events` (batch 20, retries 10, DLQ), `imports` (batch 5, retries 3, DLQ). $0.40/M operations after 1M ([queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)).

**KV:** `CACHE`, `PUBLIC`, `CONFIG`. Never for auth, entitlements, idempotency or rate limits.

**R2:** `taxiway-public` and `taxiway-private` with prefix lifecycle rules (section 5).

**Cron:** `*/15 * * * *` reconcile + airport sweep stub; `0 3 * * *` housekeeping, retention purges, Analytics Engine to Postgres rollup; `0 4 * * 0` BTS import stub.

**wrangler.jsonc bindings (redeclared per env):** `compatibility_date "2026-09-01"`, `compatibility_flags ["nodejs_compat"]` (default at this date, stated explicitly); `exports` for the five DO classes with `storage: "sqlite"`; `durable_objects.bindings` FLIGHT_TRACKER, DESIGNATOR_RESOLVER, AIRPORT_STATE, USER_INBOX, PROVIDER_BUDGET; one `hyperdrive` binding DB; `kv_namespaces` CACHE, PUBLIC, CONFIG; `r2_buckets` PUBLIC_BUCKET, PRIVATE_BUCKET; `queues` producers and consumers above; `analytics_engine_datasets` PROVIDER_CALLS, API_METRICS, PRODUCT_EVENTS; `ratelimits` PUBLIC_RL (120/10s), USER_RL (600/60s), TOKEN_RL (60/60s), SHARE_RL (30/60s), EVENTS_RL (60/60s); `observability` with `head_sampling_rate` 1 staging, 0.1 production; `vars` ENVIRONMENT, API_PUBLIC_URL, SENTRY_DSN, ACCESS_TEAM_DOMAIN, ACCESS_POLICY_AUD; secrets AERODATABOX_API_KEY, AERODATABOX_WEBHOOK_SECRET, AEROAPI_API_KEY, AEROAPI_WEBHOOK_SECRET, BETTER_AUTH_SECRET, TOKEN_KEK_V1, APPLE_SIWA_P8, GOOGLE_CLIENT_SECRET, RESEND_API_KEY, REVENUECAT_WEBHOOK_SECRET, APNS_P8, FCM_SERVICE_ACCOUNT_JSON.

**Environments:** `local` (wrangler dev + docker `postgres:18` via `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB`), `staging` (Neon branch `staging`, scale-to-zero on), `production` (tag-gated, Neon primary, 0.5 CU always-on). Custom domains from day one. GitHub Actions is the deploy system.

## 5. Data model

**Conventions:** `uuid` PK generated by the shared `uuidv7()` with DB default `uuidv7()` as fallback; `timestamptz` for every instant; `text + check` enumerations; `created_at` (BRIN on append tables, since insertion order correlates with it, unlike `occurred_at` arriving in interleaved batches), `updated_at` via trigger; `deleted_at` only on sync entities; denormalised `user_id` on user-owned rows; `_enc bytea` + `key_version` for secrets; `token_hash` + `token_prefix` for presented tokens; financial and audit tables have no FK to `users`.

**Postgres tables (61, grouped by domain):**

- **Identity and auth:** `users` (email null, `is_anonymous`, `status`, `home_airport_id`, `plan` cache, `deletion_requested_at`; unique on `lower(email)`), `sessions` (Better Auth; `ip_address`, `user_agent` are PII class 2, exported, expired within the 30-day window; index `(user_id)`), `accounts` (`provider_id`+`account_id` unique; `refresh_token_enc`), `verifications`, `rate_limits`, `user_keys` (`wrapped_dek`, `kek_version`), `devices` (`install_id`, platform, `os_version`, `attestation`; unique `(user_id, install_id)`), `user_preferences`, `user_consents`, `user_sync_changes` (`seq` identity, `xid xid8 default pg_current_xact_id()`, entity, op; index `(user_id, xid, seq)`), `idempotency_keys` (`user_id`, `key`, `request_hash`, `response_json`, `expires_at`; PK `(user_id, key)`; 24 h purge), `deleted_subjects` (`subject_id`, `deleted_at`, `rc_app_user_id_hash`; no PII).
- **Reference:** `airports` (surrogate `id`, `icao` unique not null where available, `iata` partial unique, `tz` not null, lat/lon), `airport_profiles`, `airlines` (ICAO PK, IATA non-unique index, check-in URL templates), `regional_operators` (marketing carrier + number range → operating ICAO; seed from OPTD, owned in shared), `aircraft_types`, `aircraft` (surrogate PK, `registration`, `icao_hex`, `valid_from`, `valid_to`; unique `(registration, valid_from)` and `(icao_hex, valid_from)`), `currency_rates`.
- **Flight core:** `flight_instances` (`operating_carrier_icao`, `flight_number` digits, `scheduled_departure_date` origin-local, `origin_airport_id`, `origin_icao`, `leg_seq smallint default 1`; generated `flight_key` = carrier-number-date-originICAO with `-L{leg_seq}` suffix only when >1, unique; OOOI columns; gates, terminals, baggage; `registration`, `icao_hex`, `inbound_flight_instance_id`; `aeroapi_fa_flight_id` (index); `tracking_state`, `refresh_cadence`, `next_refresh_at`, `provider_call_count`, `provider_cost_units`, `subscriber_count`; `superseded_by_id uuid null`, `supersede_reason` check; `events_r2_key`, `timeline_summary jsonb`; partial index `(tracking_state, next_refresh_at)`; indexes `(origin_airport_id, scheduled_departure_date)`, destination equivalent, `(icao_hex) where tracking_state='airborne'`), `flight_instance_merges` (audit), `flight_designators` (marketing carrier + number + date + origin → instance; unique), `flight_events` (append-only; unique `(flight_instance_id, seq)`; BRIN `created_at`), `flight_tracks`.
- **Trips, subscriptions, logbook:** `trips`, `trip_members`, `flight_subscriptions` (client id; `flight_instance_id` FK restrict; `confirmation_code_enc`; `notification_overrides` jsonb; partial unique `(user_id, flight_instance_id) where deleted_at is null`; index `(flight_instance_id) where deleted_at is null`), `logbook_entries`, `user_stats_yearly`, `usage_counters` (per-user active subscriptions, instances created per day, magic links per email, refreshes; per-IP anonymous creations).
- **Providers and models:** `provider_calls` (provider check includes `llm`; `tokens_in`, `tokens_out`; index `(flight_instance_id, created_at)`; BRIN), `provider_call_daily` (durable series), `provider_budget_config`, `provider_alert_registrations` (`max_weekly`, `deliveries`, `expected_by`), `provider_webhook_events` (unique provider+external_id), `delay_predictions`, `delay_outcomes`, `airport_wx_observations` (icao, observed_at, kind metar|taf, raw, parsed; BRIN; 90 d), `airport_nas_events`, `airport_delay_snapshots`, `airport_delay_hourly`, `bts_carrier_flight_monthly`, `bts_route_monthly`, `bts_airport_hourly`, `bts_import_runs`.
- **Notifications:** `notification_preferences`, `push_tokens` (`device_id` FK; kind check; unique kind+token; `invalidated_at`), `live_activities` (`activity_id`, `push_token`, `push_token_updated_at`, `stale_at`, `ended_at`, `content_state_hash`), `notifications` (`dedupe_key` unique; index `(user_id, created_at desc)`), `notification_deliveries` (no FK to users).
- **Email, imports, calendar, sharing:** `email_accounts`, `email_messages_processed` (unique `(email_account_id, provider_message_id)`; no bodies), `email_extractions`, `inbound_addresses`, `inbound_messages`, `imports`, `import_rows`, `calendar_connections`, `calendar_events`, `ics_feed_tokens`, `share_links` (`token_hash` unique; index `(user_id) where revoked_at is null`), `share_link_views`, `meet_me_sessions`.
- **Billing, API, GDPR:** `entitlements` (`rc_app_user_id` random, not `users.id`), `revenuecat_events` (no FK), `subscriptions` (no FK), `api_tokens`, `audit_log` (pseudonymous `subject_id`, no FK), `data_export_jobs`, `account_deletion_requests`.

**Sync feed:** `GET /v1/sync?since=<xid8>:<seq>` returns user-owned rows with `xid < pg_snapshot_xmin(pg_current_snapshot())` and `xid > since`, which excludes in-flight transactions and closes the lost-update window that a bare identity sequence has; plus flight state as a join on the caller's active `flight_subscriptions` where `flight_instances.updated_at > since_ts` (single writer via the persist consumer), or the KV snapshot with ETag. Conflict policy: server wins for flight state; last-writer-wins by `updated_at` for `notification_overrides` and `trips`. A route test runs two writers concurrently and asserts no row is skipped.

**DO SQLite schemas:** section 4; provider ids as TEXT; versioned migrations per class.

**KV key design:** `wx:metar:{ICAO}` 600 s, `wx:taf:{ICAO}` 1800 s, `nas:airport:{IATA}` 120 s, `airport:delay:{ICAO}` 300 s, `board:{ICAO}:{dep|arr}:{YYYYMMDDHH}` 300 s, `search:number:{XX1234}:{YYYY-MM-DD}` 900 s (read-through cache only; misses go to DesignatorResolver), `flight:snapshot:{flight_key}` 180 s (debounced), `ref:airport:{ICAO}` 86400 s, `budget:day:{date}:{provider}` 172800 s, `share:page:{sha256(token)[0:32]}` 60 s (KV minimum TTL), `cfg:flags`.

**R2 layout:** public `airlines/logos/{ICAO}.svg`, `share/cards/{YYYY}/{MM}/{id}.png` (30 d), `og/{random_id}.png` (7 d); private `exports/{user_id}/{job_id}.zip` (7 d), `imports/{user_id}/{import_id}/…` (30 d), `tracks/{YYYY}/{MM}/{flight_key}.jsonl.gz` (365 d), `events/{YYYY}/{MM}/{flight_key}.jsonl.gz` (365 d, extendable), `bts/raw/…` (keep).

**Durability statement:** DO storage is authoritative only until flush; the persist queue is the durable path. A deleted or corrupted FlightTracker loses unflushed events and the positions ring; SQLite PITR bookmarks are not used in Phase 0.

**Irreversible schema decisions:**

1. **UUIDv7 primary keys**, generated in `packages/shared`, PG18 default as fallback.
2. **timestamptz everywhere; one origin-local `date` in the flight key.**
3. **Flight natural key = operating carrier ICAO + flight number + origin-local scheduled date + origin ICAO (+ leg_seq when >1)**, normalised provider-independently (OPTD IATA→ICAO plus `regional_operators`), with an explicit merge path when a later provider fetch reveals a collision. ICAO airport codes because AeroAPI idents and aviationweather.gov are ICAO-keyed and OurAirports has airports without IATA codes ([ourairports.com/data](https://ourairports.com/data/)); synthetic `ZZ{id}` when ICAO is absent. Same-day number reuse is unverified but cheap to guard with `leg_seq`.
4. **Tombstones only on sync entities; hard delete for GDPR, with financial, audit and delivery tables detached from `users`.**
5. **Denormalised `user_id`, no RLS in Phase 0.**
6. **`text + check` rather than `pgEnum`.**
7. **No partitioning; BRIN plus retention crons plus R2 archives.** `flight_events` rows purge at 90 days, but the timeline survives in R2 and `timeline_summary`; `provider_calls` at 90 days is safe because `provider_call_daily` is the durable series.
8. **One envelope-encryption format** for every secret column.

**Schema review document outline (`docs/schema-review.md`):** purpose and sign-off; principles; storage tier matrix with forbidden placements; per-domain ER diagrams; table catalog (purpose, writer, readers, PII class, encryption, retention, GDPR path, rows at 1k/10k/100k); invariants and natural keys; write-path ownership matrix (persist consumer is the only Postgres writer of `flight_instances` and `flight_events`); top-20 query catalog with serving index; DO schemas, outbox and migration runner; KV and R2 catalogs; connection budget; migration policy (expand/contract, `drizzle-kit check`, DO additive-only for one release); ADR links; review checklist.

## 6. Provider layer

**Interfaces (`packages/shared/providers.ts`):**

```ts
export type FlightKey = `${string}-${string}-${string}-${string}`; // AAL-100-2026-09-19-KJFK

export interface FlightLookup {
  carrier: { icao?: string; iata?: string };
  flightNumber: string;            // digits, no leading zeros
  dateLocal: string;               // YYYY-MM-DD at origin
  originIcao?: string;
  providerRef?: { provider: ProviderId; id: string };   // fa_flight_id after first fetch
  window?: { start: string; end: string };             // bracketed first fetch
}

export interface FlightStatus {
  key: FlightKey;
  operatingCarrierIcao: string;
  flightNumber: string;
  legSeq: number;
  codeshares: Array<{ carrierIcao?: string; carrierIata?: string; flightNumber: string }>;
  origin: AirportRef; destination: AirportRef; actualDestination?: AirportRef;
  status: 'scheduled'|'boarding'|'departed'|'en_route'|'landed'|'arrived'|'cancelled'|'diverted'|'unknown';
  times: { scheduledOut?: string; estimatedOut?: string; actualOut?: string;
           scheduledOff?: string; estimatedOff?: string; actualOff?: string;
           scheduledOn?: string; estimatedOn?: string; actualOn?: string;
           scheduledIn?: string; estimatedIn?: string; actualIn?: string };
  departureDelaySec?: number; arrivalDelaySec?: number;
  originTerminal?: string; originGate?: string; destinationTerminal?: string; destinationGate?: string;
  baggageClaim?: string;
  aircraftTypeIcao?: string; registration?: string; icaoHex?: string;
  routeDistanceKm?: number; progressPercent?: number;
  inboundRef?: { providerId: string; provider: ProviderId };
  providerRefs: Partial<Record<ProviderId, string>>;
  fetchedAt: string; source: ProviderId;
  fieldQuality: Partial<Record<keyof FlightStatus['times'] | 'gate' | 'baggage', 'live'|'schedule'|'estimated'>>;
}

export interface FlightDataProvider {
  readonly id: ProviderId;
  readonly capabilities: { alerts: boolean; alertFields: Array<'status'|'times'|'gate'|'unknown'>; boards: boolean; maxDaysAhead: number; inboundLink: boolean };
  getFlight(lookup: FlightLookup, ctx: ProviderCallContext): Promise<ProviderResult<FlightStatus[]>>;
  getBoard?(airportIcao: string, dir: 'dep'|'arr', window: { from: string; to: string }, ctx: ProviderCallContext): Promise<ProviderResult<BoardRow[]>>;
  registerAlert?(key: FlightKey, opts: { events: AlertEvent[]; maxWeekly: number }, ctx: ProviderCallContext): Promise<ProviderResult<{ alertId: string }>>;
  deleteAlert?(alertId: string, ctx: ProviderCallContext): Promise<ProviderResult<void>>;
  parseWebhook?(raw: Request): Promise<ProviderEvent[]>;
}

export interface AircraftPositionProvider {
  readonly id: ProviderId;
  readonly maxIdsPerRequest: number;   // measured, not assumed
  getPositions(query: { icaoHexes?: string[]; callsigns?: string[] }, ctx: ProviderCallContext): Promise<ProviderResult<AircraftPosition[]>>;
}

export interface ProviderCallContext {
  trigger: 'alarm'|'provider_alert'|'adb_alert'|'user_search'|'user_refresh'|'reconcile'|'backfill'|'cron'|'import'|'manual';
  flightKey?: FlightKey; airportIcao?: string; requestId: string;
  budget: BudgetGuard; log: CostLogger; now: () => Date;
}

export interface ProviderResult<T> { data: T; call: ProviderCallRecord; }
```

**AeroDataBox adapter (real, Phase 0 scope):** `GET /flights/{number}/{dateLocal}` (TIER 2, 2 units, verified at [api.market openapi](https://api.market/store/aedbx/aerodatabox/openapi.yaml)), with a dateLocal ±1 retry on miss (midnight slip), `withFlightPlan` never set (doubles billing), no date-range lookups (TIER 3); `GET /airports/icao/{icao}` (TIER 1); FIDS board (TIER 2, 12 h window). `registerAlert`, `deleteAlert` and `parseWebhook` for the credit-based Flight Alert API: 1 credit per flight item per notification, 1 credit = 1 unit, subscription creation free with `?useCredits=true`, retries optional and billed ([aerodatabox.com/flight-alert-api-2026](https://aerodatabox.com/flight-alert-api-2026/)); field coverage (gate, revised times) is not stated on the page and is **unverified**, so the adapter instruments `alertFields` coverage per payload from day one. Lookahead per plan ("determined by ... your pricing plan") is verified with a real call in increment 6 and recorded as `capabilities.maxDaysAhead`. Plans: Starter $19 / 40,000 units / 5 req/s, Growth $99 / 400,000 / 10 req/s, Scale $499 / 4,000,000 / 20 req/s; overage "via ADS-B feeding (other options soon)", so treat quota exhaustion as call rejection ([aerodatabox.com/pricing](https://aerodatabox.com/pricing/)). Staging and production start on Growth; Starter is for CI fixture recording only.

**Mocked AeroAPI adapter (Phase 0 scope):** full interface including `registerAlert` with explicit `max_weekly` (20 per alert), `deleteAlert` and `parseWebhook`, from fixtures covering scheduled, delayed with gate change, cancellation, diversion, bundled departure/arrival with ETA changes, and OOOI. Adapter rules, unit-tested: the first fetch brackets `start`/`end` around scheduled_out ±1 day; every subsequent poll uses `ident_type=fa_flight_id` so one record equals one set (a set is 15 records, `max_pages` default 1; unbounded ident queries on shuttles overflow page 1) ([aeroapi pricing](https://www.flightaware.com/commercial/aeroapi/)). Price table: `/flights/{ident}` $0.005, `/position` $0.010, `/schedules` $0.020, alert delivery $0.020, alert configuration $0.000.

**Cost logging:** `CostLogger.record()` appends to the DO outbox (inside a DO) or writes directly (Worker), which the persist consumer turns into a `provider_calls` row and one Analytics Engine point (`index1 = provider`, blobs `[operation, flight_key, trigger, result, environment]`, doubles `[latency_ms, cost_units, est_cost_usd_micros, response_bytes, http_status]`), chunked ≤200 points per invocation, plus a structured log line. Two extra metrics: `alerts_delivered` vs `alerts_expected` per flight, and ADB `alert_field_coverage`. Nightly rollup into `provider_call_daily`.

**Budget guard:** poll-equivalents (PE) at list price: AeroAPI status 1 ($0.005), alert delivery 4, `/schedules` 4, position 2; ADB status or search 0.1, ADB alert 0.05; ADS-B 0 but counted. Expected per-flight PE comes from the cadence function (section 7): 120 PE for cadence A2; soft cap 2× (240), hard cap 4× (480), both derived not hand-set. Soft-cap action: metric, stretch cadence one tier. Hard-cap action: `deleteAlert` for all registrations, stop polling, one reconciliation poll at scheduled arrival. Per-flight-per-day inside 48h: expected 102, soft 200, hard 400. Routing rule: zero AeroAPI calls before T-48h. User refreshes: separate sub-budget, 10 per flight per day, never debit the scheduled cadence. ADB monthly quota guard in ProviderBudget with the same 70/90/100% ladder; degrade = stretch pre-48h cadence to every 2 days, then rely on the AeroAPI bracketed fetch at T-48h. Global daily cap per provider = 1.5 × (monthly budget / 30) via the lease protocol; ladder actions: 70% alert on-call; 90% degrade to ADB and stretch in-flight polls to 30 min; **100% = delete alert registrations for flights with no subscribers in the next 6 h, stop polling, keep one reconciliation poll per flight at scheduled arrival.** "Alerts-only" is not a spend stop because deliveries bill $0.020 and are initiated by FlightAware; `DELETE /alerts` is free and per-alert `max_weekly` is the external backstop. Alert registration only while a tracker has at least one non-muted subscriber; deleted when the last leaves. Alert silence detection: zero deliveries by scheduled_off + 15 min flips the flight to poll-only cadence (FlightAware does not retry failed deliveries per the reviewer's citation, unverified here). Per-user caps in `usage_counters` enforced in Phase 0: 5 active subscriptions free, 100 Pro; 20 new `flight_instances` per user per day; 10 FlightTracker creations per IP per day on anonymous accounts. Token bucket at 4 sets/s on Standard.

**Positions (design only):** one `PositionPoller` DO per provider, batch size measured empirically at startup (adsb.lol's rate limit is "dynamic" and an API key via feeding is expected in future, [adsb.lol/docs/open-data/api](https://www.adsb.lol/docs/open-data/api/)); adsb.fi ([README](https://github.com/adsbfi/opendata/blob/main/README.md)) and airplanes.live ([api-docs](https://airplanes.live/api-docs/)) are non-commercial only, dev adapters only. Paid fallbacks priced in section 8.

## 7. Refresh cadence and query budget

**Detection-latency SLOs (the cadence is derived from these, and the lifecycle test imports the resulting constants):**

| Event | > 7 d | 7 d to 48 h | 48 h to 6 h | 6 h to 3 h | 3 h to landing | Post-landing |
|---|---|---|---|---|---|---|
| Schedule change / cancellation | ≤ 48 h | ≤ 24 h | ≤ 60 min | ≤ 15 min | ≤ 15 min | n/a |
| Gate change | n/a | n/a | ≤ 60 min | ≤ 15 min | ≤ 15 min | n/a |
| ETA / delay change | n/a | n/a | ≤ 60 min | ≤ 15 min | ≤ 15 min (≤ 2 min with alerts) | ≤ 15 min |
| OOOI | n/a | n/a | n/a | n/a | ≤ 2 min (alerts), ≤ 15 min (polls) | ≤ 15 min |

Assumptions: 3 h block, boarding at D-40, landing at D+170, stop at arrival +2 h, hard lifetime scheduled_in + 6 h. Pre-48h source is AeroDataBox: daily inside 14 days, every 2 days beyond.

**Per-window breakdown (inside 48 h, AeroAPI):**

| Window | Literal mandate | A1: polls only | A2: polls + AeroAPI alerts (Phase 0 default) | B: ADB webhooks + AeroAPI OOOI alerts (Phase 1 target, unverified fields) |
|---|---|---|---|---|
| 48 h to 6 h | hourly 42 (of 45 hourly to 3 h) | hourly 42 | hourly 42 | 1 bracketed fetch at T-48h |
| 6 h to boarding (320 min) | 10-min from 3 h: 14 | 15-min 21 | 15-min 21 | 1 at T-3h |
| Boarding to landing (210 min) | 2-min 110 | 15-min 15 | 30-min 7 | 1 at sched_off + 15 |
| Post-landing | 10-min 12 | 15-min 4 + 1 final | 2 | 1 at sched_in + 15, 1 final |
| Polls | 181 | 83 | 72 | 5 |
| Alert deliveries | 0 | 0 | 12 assumed (filed, departure and arrival bundled with ETA changes, out, off, on, in; unverified average) | 8 AeroAPI (OOOI, cancelled, diverted) + ~15 ADB items |
| AeroAPI list cost | $0.905 | $0.415 | $0.36 + $0.24 = **$0.60** | $0.025 + $0.16 = **$0.185** |

**Per lead time (ADB pull units + AeroAPI list cost):**

| Lead time | Literal, hourly 7d-48h via `/schedules` | Literal, daily 7d-48h | A1 | A2 | B |
|---|---|---|---|---|---|
| 3 days | 205 polls, $1.39 | 182, $0.93 | 4 ADB units + $0.415 | 4 units + $0.60 | 4 units + ~15 alert units + $0.185 |
| 14 days | 308 polls, $3.45 | 193, $1.15 | 26 units + $0.415 | 26 units + $0.60 | 41 units + $0.185 |
| 30 days | 324 polls, $3.77 | 209, $1.47 | 42 units + $0.415 | 42 units + $0.60 | 57 units + $0.185 |

ADB units at Growth are $0.00025 each, so pre-48h costs $0.001 to $0.015 per flight; the constraint is quota (no overage), not price. Literal columns priced at $0.020 per pre-48h poll because `/flights/{ident}` cannot see beyond 2 days.

**Targets in `docs/architecture.md`:** A2 is the Phase 0 constant: 72 AeroAPI polls + ≤ 12 alert deliveries = 120 PE expected, 240 soft, 480 hard. A1 (83 polls) is the automatic fallback when alerts are silent. B is instrumented, not promised, until ADB alert field coverage is measured. Rebuttal to the reviewer's "AeroAPI-only ~80 polls" schedule: it matches A1; A2 keeps the 30-minute in-flight interval because departure and arrival alerts are bundled with ETA changes, so in-flight polls only need to catch gate changes at the destination.

**Rate check (polls only; alert deliveries are outbound from FlightAware and do not consume result sets/second):** A2 at 30k flights/month = 2.16M polls / 2.592M s = 0.83/s average; with a peak factor of 4 for departure banks (assumed; back with BTS distribution in Phase 1) that is 3.3/s. Standard's 5/s is crossed at about 45k flights/month (1.25/s average, 5.0 peak), so Premium ($1,000 minimum, 100/s) is required around 45k flights/month on A2, 40k on A1, and never for rate on B.

## 8. Cost model

Assumptions: cadence A2 unless stated; subscribers per flight 1.2 / 1.5 / 2.5; MAU 600 / 7,500 / 125,000; Neon 0.5 / 0.5 / 2 CU always-on; 3% Pro conversion at $4.99; AeroAPI discount bands read as marginal (30% $1k-2k, 51% $2k-4k, 65% $4k-8k, 76% $8k-16k, 83% $16k-32k, ~89% $32k-64k assumed, 94% above $64k per [aeroapi pricing](https://www.flightaware.com/commercial/aeroapi/); confirm with sales before 10k).

| Line (monthly) | 1k flights | 10k flights | 100k flights |
|---|---|---|---|
| AeroAPI, cadence A2 ($0.60 list, after bands) | $600 | $3,380 | $11,800 (Premium) |
| AeroAPI, cadence B ($0.185 list) for comparison | $185 | $1,595 | $6,425 |
| AeroDataBox (Growth from day one; 30 units/flight ≈ 75% of quota at 1k and 10k; Scale ≈ 75% at 100k; B adds ~15 units/flight and exceeds Scale at 100k → custom) | $99 | $99 | $499 (A2) / ~$700 (B, custom) |
| Workers Paid | $5 | $6 | $76 |
| Durable Objects (requests, duration, rows) | $0 | $1 | $74 |
| Queues / KV / R2 (persist queue adds ~100 ops per flight) | $1 | $2 | $25 |
| Analytics Engine (not billed today) | $0 | ($3) | ($55) |
| Workers Logs (10% sampling) | $0 | $0 | $2 |
| Neon (0.5 CU always-on ≈ $39 + storage) | $45 | $60 | $345 (Scale) or $176 (Launch) |
| Sentry | $26 | $26 | $80 |
| EAS (Starter $19 + $0.005/MAU over 3,000; Production $199 + overage over 50,000, [expo.dev/pricing](https://expo.dev/pricing)) | $19 | $42 | $574 (Production) or $629 (Starter) or $19 without EAS Update |
| RevenueCat | $0 | $0 | $187 |
| Email | $0 | $0 | $21 |
| **Total, A2** | **~$795 ($0.80/flight)** | **~$3,620 ($0.36/flight)** | **~$13,680 ($0.14/flight)** |
| **Total, B** | **~$380** | **~$1,830** | **~$8,500** |

**Positions (added to `cost-estimate.md`, not in the totals):** community feed $0 plus one ADS-B feeder (~$150 hardware, one-off) to secure adsb.lol access; AeroAPI `/position` at $0.010 per set, sampled at 60 s only while a subscriber has the app foregrounded (assume 10 min per flight) = $0.10/flight list → $100 / $1,000 / $10,000 before bands, versus $3.60/flight at continuous 30 s; FR24 API is credit-priced ([fr24api.flightradar24.com](https://fr24api.flightradar24.com/subscriptions-and-credits), figures unverified).

Dominant line: AeroAPI at 75 to 86% of spend. Cloudflare infrastructure is under $10 at 10k and about $180 at 100k.

**Levers, ranked:** (1) ADB webhooks as the change source for gate and time revisions with AeroAPI for OOOI (A2 → B, $0.60 → $0.185 list) once field coverage is verified; (2) never poll AeroAPI before T-48h; (3) alert-bundled ETA changes allow 30-minute in-flight polls; (4) 2 targeted post-arrival polls; (5) fa_flight_id polls guarantee one set per poll; (6) batched PositionPoller and foreground-only paid positions; (7) log sampling; (8) EAS Update optional; (9) free-tier caps (5 active subscriptions, 2 concurrently live-tracked), because provider cost is per flight and at 1.5% conversion the product is margin-negative at 100k on A2.

Unverified: alerts per flight (12); ADB alert field coverage and lookahead per plan; discount band semantics and the $32k-64k band; FlightAware billing of error responses; peak-to-average factor.

## 9. Security and privacy foundations in Phase 0

**Implemented in Phase 0:**

- **Envelope encryption module:** per-user 256-bit DEK wrapped with AES-KW by a versioned KEK (`TOKEN_KEK_V1`, imported once per isolate as a non-extractable CryptoKey) behind a `KeyProvider`; AES-256-GCM, random 96-bit IV, AAD = `table:column:row_id`. Per-user DEKs make KEK rotation a re-wrap of `user_keys` and make every secret column of a user depend on one row. **This is not crypto-shredding:** the wrapped DEK sits in the same Neon database that PITR covers (Launch up to 7 days, Scale up to 30, [neon.com/pricing](https://neon.com/pricing)) and the KEK survives deletion, so a branch from before the delete recovers it. Phase 0 states the truth: effective deletion latency equals the Neon history-retention window, which is set to the minimum operationally acceptable on production (recommendation: 1 day) and disclosed in the privacy policy. Moving DEK wrapping outside the PITR domain is an open decision (section 16). Secrets Store is deferred because Phase 0 has a single Worker consumer and no account-level sharing need; the trade-off is that a Workers Secret is readable by anyone who can deploy the Worker (the CI token), which Secrets Store's scoping would fix later ([secrets-store integration](https://developers.cloudflare.com/secrets-store/integrations/workers/)).
- **`api_tokens` and `audit_log` primitives** (`twy_<kind>_<base64url(32)>`, SHA-256 lookup, scopes, expiry, revocation; audit rows keyed by pseudonymous `subject_id`).
- **Hono middleware chain:** `requestId` → `cors` → `ipLimiter` (unauthenticated routes) → `auth` → `principalLimiter` → `requireScope` → `idempotency` (on mutating routes) → handler. The ratelimit binding is per-colo and permissive ([rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)); free-tier quotas, per-user caps and per-email magic-link limits live in Postgres `usage_counters`. One WAF rule (300 req/10 s per IP) as backstop.
- **Sign in with Apple via the custom native route** (nonce required, code exchange, refresh token encrypted, server-to-server notification endpoint registered); Google ID-token verification via jose with `aud`, `iss`, `exp`, `nonce`.
- **Better Auth rate limiting** in database storage with `cf-connecting-ip`, plus per-destination-email limits.
- **GDPR export and deletion** as queued jobs (revoke Apple/Google, RevenueCat DELETE customer stub, DO unsubscribe, UserInbox `deleteAll`, R2 prefix delete, cascade delete of user-owned rows, `deleted_subjects` row, PII-free `account_deletion_requests`), public web deletion-request page; `sessions.ip_address/user_agent` included in export.
- **Sentry PII off** on both sides with `beforeSend` scrubbing and a unit test that the error middleware never attaches bodies or headers.
- **`apps/api-admin` behind Cloudflare Access** with `aud` validation enforced.
- **CI enforcement of "no provider credentials in the app":** `expo export` bundle grep for `SECRET_PATTERNS`, provider hostnames and `FCM_`/`APNS_` markers; gitleaks; pnpm `minimumReleaseAge` 3 days, `trustPolicy: no-downgrade`, `onlyBuiltDependencies` allowlist; scoped per-environment Cloudflare API tokens.
- **Public route headers** and identical 404s on `/s/*`.
- **Privacy labels drafted:** Usage Data collected, not linked (install id only); Diagnostics (Crash, Performance) collected, not linked; `expo.ios.privacyManifests` aggregated from Expo, React Native and Sentry ([Sentry Expo privacy manifest](https://docs.sentry.io/platforms/react-native/guides/expo/data-management/apple-privacy-manifest/)).

**Threat model (`docs/security/threat-model.md`), top threats with mitigations:**

*Share links:* (1) token guessing: 256-bit random tokens, hash-only storage, SHARE_RL, identical 404s; (2) cache poisoning via KV key: key is `sha256(token)`, TTL ≤ 60 s, purge on revoke; (3) OG image enumeration: images named by a second random id, 7-day lifecycle; (4) revoked-link caching: revocation writes a KV tombstone before deleting the row, CDN `Cache-Control: private`; (5) scraping of a live page: `toSharedFlightView` allowlist (no PNR, no subscriber identity), `noindex`, `share_link_views` for abuse evidence.

*MCP endpoint (per the [2026-07-28 spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)):* (1) token theft: per-user revocable `twy_mcp_` tokens with expiry, `last_used_at`, separate hostname; (2) confused deputy: OAuth 2.1 resource server with RFC 9728 metadata and audience binding, or PAT with the endpoint as `aud`; (3) prompt injection in tool output: provider-derived strings sanitised and typed, no free-text passthrough; (4) write actions: read-only default scope, two-step `propose_flight`/`confirm_flight`; (5) rate abuse: TOKEN_RL plus per-token daily quota in `usage_counters`.

Also documented: email-sync no-body invariant, LLM zero-data-retention vendor selection, App Attest and Play Integrity rollout (columns reserved), KEK rotation and incident runbooks.

**CASA timeline warning.** `gmail.readonly` and `gmail.metadata` are restricted scopes; metadata cannot return bodies. Google says restricted-scope verification "can potentially take several weeks" ([restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)); unverified apps are limited to 100 new users ([support.google.com/cloud/answer/7454865](https://support.google.com/cloud/answer/7454865)); AL1/AL2 tiers and annual revalidation are in [support.google.com/cloud/answer/13465431](https://support.google.com/cloud/answer/13465431). Lab quotes seen publicly range roughly $500 to $4,500 (unverified, third-party marketing); obtaining a written lab quote is an owner task. Realistic critical path is 2 to 3 months from a testable Phase 3 build. Microsoft has the analogous gate: unverified multi-tenant apps registered after November 2020 are blocked from user consent under risk-based step-up consent, and publisher verification needs a verified Partner Center account ([publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)). Both start in Phase 0 as owner tasks.

## 10. Mobile app in Phase 0

**Expo scaffold:** `expo@^57.0.23`, TypeScript, Expo Router, CNG, `app.config.ts` reading `APP_VARIANT` to produce `<tld>.<domain>.mobile`, `.dev` and `.preview` identifiers (immutable after first upload), App Group, `aps-environment`, `NSSupportsLiveActivities`, `NSSupportsLiveActivitiesFrequentUpdates`, `UIBackgroundModes: remote-notification`, `ios.enableSceneSupport`, aggregated `privacyManifests`. `eas.json` with development, preview and production profiles; EAS environments carry `EXPO_PUBLIC_API_URL` only.

**Native surface shells (compile in CI, no behaviour):**
- **iOS widget, Live Activity and Dynamic Island via expo-widgets** (`enablePushNotifications: true`): a placeholder home widget, a Live Activity layout built from `@expo/ui/swift-ui` components with compact, minimal and expanded Dynamic Island regions, and the `LiveActivityContentState` derived from the shared zod schema; per-activity token listener and push-to-start listener (iOS 17.2+) wired to `POST /v1/devices`. Constraints accepted: layouts are Expo UI components only, iOS only. The archived `expo-live-activity` and a hand-written ActivityKit module are removed.
- **watchOS via @bacons/apple-targets 5.0.0** for `targets/watch` and `targets/watch-widget` only (watchOS is outside expo-widgets scope). **Coexistence of the expo-widgets extension with an apple-targets watch target in one prebuild is an increment 13 acceptance test in Phase 0**, not a Phase 1 spike; if it fails, the watch shells move to a Phase 2 config plugin and the decision is recorded in ADR 0008.
- **Android:** `modules/android-surfaces` Kotlin module with an empty Glance widget and ongoing-notification stub (expo-widgets Android is SDK 58 beta; re-evaluate at the 58 upgrade); `wear/` Compose for Wear OS + Tiles module wired by `plugins/withWearApp.ts` (Gradle-include pattern is community practice, unverified against Expo docs).

**Screens in scope:** sign-in (Apple via the native route, Google, magic link, anonymous), empty next-flight home with add-flight sheet and tracked-flight list with status, settings (units, time format, theme, account, delete account). Dark mode via theme tokens.

**Offline store bootstrap:** expo-sqlite with `enableChangeListener`, Drizzle schema mirroring sync entities (`flight_subscriptions`, `flight_instances` projection, `trips`, `user_preferences`), migration runner, `useLiveQuery` on the list, `GET /v1/sync` applied in one exclusive transaction with the xid8 cursor, `outbox` drained by a TanStack mutation carrying `Idempotency-Key`.

**State:** TanStack Query 5, zustand 5, Better Auth Expo client with SecureStore, Sentry, `analytics.ts` batching install-id-keyed events, MapLibre and expo-notifications installed but unused.

**Not built:** map, positions, Live Activity behaviour, widget data, push handling, email sync, imports, calendar, sharing, logbook, stats, delay risk, airport profiles, web beyond static Expo Router output.

## 11. CI/CD and environments

**`ci.yml`** (PR and main; concurrency cancel-in-progress): shared setup (`actions/checkout@v5`, `pnpm/action-setup@v4`, `actions/setup-node@v6`, `pnpm install --frozen-lockfile`); jobs `typecheck`, `lint`, `test-node`, `test-workers` (with a `postgres:18` service container and the `server_version_num` assertion), `test-mobile`, `db-migrations` (PR only: `neondatabase/create-branch-action@v6` off `staging` with 1-day expiry → `drizzle-kit check` → migrate → drift guard), `wrangler-dry-run`, `secrets-scan`, `toolchain-guard` (no Vitest 5, no TS 7, one wrangler version), `native-smoke` (nightly: `expo prebuild --clean` plus `xcodebuild` and `gradle assembleDebug`, asserting expo-widgets extension and apple-targets watch target both present).

**`deploy-staging.yml`** on push to main: migrate with `NEON_STAGING_DIRECT_URL` → `cloudflare/wrangler-action@v4` `deploy --env staging` → smoke `GET /health`. **`deploy-production.yml`** on tag `v*` with required reviewer: same sequence, then a path check: if `apps/api/wrangler.jsonc` `exports` changed in the diff, run a full `wrangler deploy` (DO lifecycle changes cannot go through versions, [gradual deployments with DOs](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)); otherwise `versions upload` then `versions deploy` for gradual rollout, relying on the RPC compatibility contract test. **`apns-smoke.yml`** manual dispatch against staging.

**EAS:** `mobile-preview.yml` on label; `eas update --auto` on PRs; `mobile-release.yml` on tag with `--auto-submit`. Free tier's 45-minute timeout will be exceeded by MapLibre plus Swift targets; Starter ($19, 2-hour timeout) is the floor ([expo.dev/pricing](https://expo.dev/pricing)).

**Secrets:** GitHub Environments `staging` and `production` hold scoped `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, Neon direct URLs, provider keys; repo-level `NEON_API_KEY`, `EXPO_TOKEN`, `SENTRY_AUTH_TOKEN`. Worker runtime secrets via `wrangler secret put --env`.

**Deploy flow:** PR → CI green → merge → staging auto-deploy → tag → production approval → deploy; mobile follows the same tags.

## 12. Tests

**Unit (Vitest, node):** AeroDataBox adapter against recorded fixtures with undici `MockAgent` (field mapping, codeshare resolution, parameter allowlist, dateLocal ±1 retry, webhook parsing, field-coverage instrumentation, 429 and 5xx as zero-PE error records); mocked AeroAPI adapter (fixture shapes, bundled alert parsing, price table, `max_weekly` set on register, "never issues an unbounded ident query", fa_flight_id after first fetch); flight-key normaliser (IATA→ICAO, regional operator map, leading zeros, origin-local date, midnight slip immutability, leg_seq, "BA1512 and AA100 normalise to one key"); cadence function (SLO table → per-window counts, A1/A2/B totals, alert-silence fallback, max lifetime); cost logger (PE conversion, AE point shape, ≤200 points per chunk); budget guard (derived soft/hard caps, daily ladder, 100% action issues deletes, user-refresh sub-budget, ADB quota ladder); envelope crypto (AAD mismatch, IV uniqueness); Apple native route (nonce required); `toSharedFlightView` allowlist; zod contract round-trips; RPC schema tolerance of unknown fields; Sentry scrubbing.

**Integration (Vitest + @cloudflare/vitest-plugin; per-file storage isolation, so every test uses a unique DO name, drains alarms in `afterEach` via `runDurableObjectAlarm` until false, and DO test files never use `test.concurrent`):** `flight-tracker.lifecycle.test.ts` walks daily → hourly → 15-min → 30-min → post-landing → finished → deleteAll with a stubbed provider and injected clock, asserting provider call counts equal the imported A2 constants, two subscribers produce one call per refresh, the alarm run twice at the same clock is a no-op, a throwing provider yields one error record and one call per tier slot across simulated retries, max lifetime terminates a flight that never reports `in`, and `adoptSubscribers` merges an operator-changed tracker without a second provider stream; `designator-resolver.test.ts` (50 concurrent `SELF.fetch` searches for one unresolved designator → exactly 1 provider call); `provider-budget.test.ts` (lease protocol, shard sums, 1,000 trackers each spending 1 PE below threshold trip the ladder, day rollover); `user-inbox.test.ts`; `do-migrations.test.ts` (upgrade from every prior `user_version`); `routes.test.ts` via `SELF.fetch` (scope enforcement, 429, identical 404s, idempotency replay, per-user caps, 500 refresh calls in 60 s → 1 provider call, two concurrent sync writers lose nothing); `queues/persist.test.ts` and `queues/notify.test.ts` with `createMessageBatch`; `reconcile.test.ts` (stuck tracker re-armed); Hyperdrive path exercised only from Worker and queue-consumer context against the Postgres 18 service container with migrations applied in `globalSetup`; APNs adapter against a fake HTTP/2 endpoint.

**Mobile (Jest):** sign-in renders providers, add-flight sheet validates against the shared schema, list renders from `useLiveQuery`.

**"Green" means:** all jobs pass on Node 24 and Postgres 18; toolchain guard clean; `drizzle-kit check` clean; drift guard clean; wrangler dry-run clean; bundle grep clean; lifecycle call counts equal the cadence-function constants that generate the table in `docs/architecture.md`.

## 13. Deliverables checklist for end of Phase 0

- Monorepo with pnpm 12, Turborepo, TS 6.0.x, ESLint, Prettier, Renovate, CODEOWNERS, ADRs 0001 to 0008.
- `wrangler dev` runs the API with five DO classes, four queues, three KV namespaces, two R2 buckets, crons, ratelimit bindings and one Hyperdrive to local Postgres 18.
- Full Drizzle schema (61 tables) migrated on local, staging and production Neon; seeds for airports (OurAirports + mwgg tz), airlines and regional operators (OPTD), aircraft types.
- Better Auth with anonymous, magic link (Resend), Google, plus the custom Apple native route capturing an encrypted refresh token; anonymous-to-account merge re-keys rows and re-subscribes DOs.
- Expo dev client on iOS and Android: sign in, add a flight, list backed by FlightTracker via KV snapshot, settings, delete account.
- DesignatorResolver serialises the first provider call; AeroDataBox adapter fetches once per FlightTracker refresh regardless of subscriber count; `provider_calls` row and Analytics Engine point written through the persist queue with `cost_units`; `provider_call_daily` rolled up nightly.
- Mocked AeroAPI adapter with fixtures, webhook routes for both providers, budget lease protocol with kill switch, per-user caps, reconcile cron, DO migration runner.
- PushSender with tested APNs adapter and one real sandbox smoke from staging; MailSender with two adapters; envelope crypto; `api_tokens`, `audit_log`, `idempotency_keys`; rate limiting; Access-protected admin Worker showing provider calls per flight key and DO schema version skew.
- Native shells compile nightly: expo-widgets widget and Live Activity, apple-targets watch and watch-widget coexisting, android-surfaces module, wear module.
- CI green, staging deployed from main, production deploy path exercised once with a tag (both full and gradual branches).
- `docs/architecture.md` (cadence table generated from the shared function, SLOs, overshoot bound, per-file isolation note, durability statement), `docs/cost-estimate.md` (with positions scenarios), `docs/schema-review.md`, `docs/security/threat-model.md`, `docs/open-decisions.md`.

**Runnable milestone definition:** on a clean machine with the documented accounts, `pnpm i && pnpm dev` plus `eas build --profile development` produces an app in which a user signs in, adds AA100 for tomorrow, sees it within 5 seconds with scheduled times and gates where AeroDataBox has them, and the admin Worker shows one provider call attributed to that flight key with its cost, and a second user adding the same flight produces zero additional provider calls.

## 14. Increments

1. **Repo skeleton**: pnpm workspaces, Turbo, TS base, ESLint (incl. no-module-scope-drizzle), CI typecheck, lint, toolchain guard. Accept: `pnpm turbo run typecheck lint` green in CI with one wrangler version.
2. **`packages/shared` contracts**: zod schemas, `FlightStatus`, provider interfaces, uuidv7, provider-independent flight-key normaliser with regional operator map, cadence function with SLO table and per-window breakdown. Accept: normaliser and cadence tests pass; the table in `docs/architecture.md` is generated by a script from the function.
3. **`packages/db` schema and migrations**: 61 tables, triggers, seeds, `withDb`, `drizzle-kit check`, Neon PR-branch job, Postgres 18 pinned everywhere. Accept: migrations apply on a fresh PG18 and fail with a clear message on PG17; drift guard clean.
4. **API Worker bootstrap**: Hono, wrangler.jsonc with all bindings, one Hyperdrive to the Neon direct endpoint, health, Sentry, request-id, idempotency middleware, staging deploy. Accept: `GET /health` on staging returns the migration hash.
5. **Auth**: Better Auth per-request factory with anonymous, magic link (Resend + Cloudflare adapters, per-email limits), Google idToken, custom Apple native route with nonce and code exchange, envelope-encrypted tokens. Accept: workers tests sign in anonymously, upgrade via magic link, re-key rows; Apple login without nonce is rejected and a refresh token row is encrypted.
6. **Provider layer**: AeroDataBox adapter (pull + webhook), mocked AeroAPI adapter (bracketed first fetch, fa_flight_id polls, max_weekly), cost logger with chunking, budget guard with derived caps and kill switch, token bucket; ADB lookahead measured and recorded. Accept: adapter unit tests pass; every call yields a `ProviderCallRecord`; "never issues an unbounded ident query" passes.
7. **FlightTracker and DesignatorResolver DOs**: migration runner, state machine, idempotent alarm with attempt records, outbox → persist queue, KV debounce, lease protocol, merge path, finish and deleteAll sequence, max lifetime. Accept: lifecycle test walks all tiers with the A2 constants, survives simulated retries with one call per slot, finishes and deletes; resolver stampede test yields one call.
8. **Flight routes and sync**: search, subscribe with per-user caps and idempotency, list, detail, delete, coalesced refresh inside the DO, xid8 sync feed with flight-state join. Accept: route tests pass including 429, 500 refreshes → 1 call, and the two-writer sync test.
9. **Remaining DOs, queues, crons, admin**: AirportState, UserInbox, sharded ProviderBudget with KV rollup, persist/notify/provider-events consumers with DLQs, reconcile and rollup crons, Access-protected admin. Accept: ladder trips under 1,000 sub-threshold trackers; stuck tracker re-armed by reconcile; admin rejects wrong `aud`.
10. **Push and GDPR primitives**: PushSender with APNs and FCM adapters, staging APNs smoke workflow, `api_tokens`, `audit_log`, export and deletion jobs, deletion page, `deleted_subjects`. Accept: deletion leaves no user-owned rows, financial and audit rows survive, and the APNs smoke returns 200 from staging.
11. **Mobile scaffold**: Expo Router, auth client, api client, expo-sqlite + Drizzle + sync with outbox idempotency, sign-in and settings, Sentry, install-id analytics, EAS profiles, privacy manifests. Accept: dev build signs in and settings persist across restart offline.
12. **Next-flight home and add flight**: `useLiveQuery` list, add sheet, detail with timeline. Accept: adding a flight on device produces one provider call in staging; adding the same flight from a second account produces none.
13. **Native surface shells and nightly smoke**: expo-widgets widget and Live Activity with token listeners, apple-targets watch and watch-widget, android-surfaces, wear plugin. Accept: nightly EAS builds of both platforms succeed with the expo-widgets extension and the watch target present in the same iOS archive; Live Activity token listener fires on a physical device.
14. **Docs, cost estimate, production deploy**: architecture note, cost estimate with positions, schema review, threat model, open decisions; production deploy exercised on both the full and gradual paths. Accept: lifecycle test imports the constants from the same module that generated the docs table.

## 15. What I need from you

- **Domain and legal entity name** (reverse-DNS identifiers, Cloudflare zone, Email Routing, Access).
- **GitHub org and plan** (Team or Pro for Environments on a private repo).
- **Cloudflare account** on Workers Paid, Zero Trust team name, per-environment API tokens, nameservers moved.
- **Neon project** on Launch, PG18, likely AWS us-east-1, `main` and `staging` branches, production history retention set to the agreed minimum, API key for PR branches.
- **AeroDataBox**: direct Growth plan for staging and production (quota is rejection-based, no paid overage) plus a Starter or RapidAPI key for fixture recording; latest non-deprecated plan version so the credit-based Flight Alert API is available.
- **FlightAware AeroAPI**: Personal key for fixtures now; Standard at Phase 1; **ask sales to raise the account-level weekly alert cap above the default (reported 1,000 per week on Standard, unverified) before Phase 1**, and confirm whether error responses are billed.
- **Apple Developer Program** (organization, D-U-N-S), Team ID, Sign in with Apple key, APNs key, Services ID, email-relay sender domain; one physical iOS 17.2+ device enrolled for the APNs smoke and token listener test.
- **Google Cloud project** with OAuth consent screen, web, iOS and Android client IDs, brand verification started, **a written CASA lab quote**; Firebase project service account for FCM v1.
- **Microsoft Entra** multi-tenant app registration and Partner Center enrolment.
- **Google Play Console** organization account.
- **Expo account** (Starter), **Sentry** org with two projects, **Resend** account with verified domain, **RevenueCat** project with webhook secret.
- Decisions on open items 1, 2, 4, 5, 9 and 23 before increment 6.

## 16. Open decisions for the product owner

1. **Cadence.** Recommend A2 as the Phase 0 constant (72 polls + alerts, $0.60 list) with A1 as the alert-silence fallback and B instrumented. Choosing the literal mandate costs $0.93 to $3.77 per flight and hits Standard's 5/s at about 600 concurrently airborne flights.
2. **Change source for gates and times.** Recommend evaluating AeroDataBox webhooks (1 unit per item, ~80× cheaper than an AeroAPI delivery) as primary with AeroAPI alerts for OOOI; decide on measured field coverage at the end of Phase 1. Staying AeroAPI-only keeps $0.60 per flight.
3. **Position source path.** Recommend adsb.lol batched via PositionPoller plus an operated feeder, with paid positions (AeroAPI $0.010 per set, foreground-only) decided before 10k flights/month; or accept "no live dot" on the free tier. Also decide whether ODbL share-alike exposure permits persisting tracks.
4. **AeroDataBox channel and plan.** Recommend direct Growth from day one; Starter cannot survive one busy month at 1k flights (30k of 40k units).
5. **Free-tier limits.** Recommend 5 active subscriptions, 2 concurrently live-tracked, 20 new instances per day, alerts-only after cap, no Live Activities. Looser limits raise the break-even conversion above 3% on A2.
6. **Local-only mode semantics.** Recommend a lazily created server-side anonymous user; a truly offline mode means no push and no shared FlightTracker.
7. **Magic-link sender.** Recommend Resend default.
8. **Google native sign-in module.** Recommend the paid Universal Sign In if EAS covers it, else the legacy-SDK module, else expo-auth-session PKCE.
9. **Drizzle version.** Recommend 0.45.2 with the restricted API.
10. **iOS surfaces path.** Recommend expo-widgets (stable since SDK 56, push and push-to-start tokens, Dynamic Island regions; constraints: Expo UI components only, iOS only) for widget, Live Activity and Dynamic Island, with apple-targets only for watchOS. Choosing hand-written SwiftUI via apple-targets buys unrestricted layouts at the cost of owning ActivityKit token plumbing and a second toolchain.
11. **Expo SDK 58 timing.** Recommend upgrade in its first stable week; it brings Android widgets in expo-widgets and scene lifecycle by default.
12. **Analytics identity.** Recommend install-scoped id only, never joined to users ("not linked"). Per-user cohorts force "linked" disclosure.
13. **Session policy.** Recommend 30-day sliding sessions with a 5-minute cookie cache.
14. **Account deletion timing.** Recommend immediate hard delete; a 7 to 14 day grace window is supported by the schema.
15. **PNR storage.** Recommend encrypted storage for check-in deep links.
16. **Retention windows.** Recommend 90 days for `flight_events` rows (timeline archived to R2 for 365 days or indefinitely), `provider_calls` (durable in `provider_call_daily`), `notifications`; 30 for airport snapshots and import rows; 7 for exports. Indefinite R2 event archives cost about $0.015/GB-month.
17. **EAS Update.** Recommend keep for Phase 0 to 2; at 125k MAU it is $574 on Production versus $19 without.
18. **Neon region, CU floor and DO location hints.** Recommend us-east-1, 0.5 CU always-on in production, `locationHint: 'enam'` on FlightTracker and UserInbox creation.
19. **LLM vendor for email extraction.** Non-covered Anthropic model or OpenAI under ZDR; Anthropic Covered Models retain 30 days even under ZDR, which conflicts with "no raw bodies retained" unless disclosed.
20. **CASA budget and owner.** Obtain a written lab quote; assign owners for Google brand verification, privacy policy, demo video and Microsoft Partner Center.
21. **SQLCipher for the on-device DB.** Recommend yes at Phase 3.
22. **Separate hostnames** for share pages and MCP versus paths on the API Worker; recommend separate hostnames.
23. **Deletion latency versus true crypto-shredding.** Recommend Phase 0 sets production history retention to 1 day and discloses it; moving DEK wrapping outside the PITR domain (a `UserKeys` DO or a separate minimal-retention Neon project) is a Phase 2 item if the privacy policy needs a stronger claim. Note DO SQLite also has point-in-time bookmarks, so "outside PITR" requires the separate project.
24. **AeroAPI alert event set.** Recommend registering departure, arrival (bundled), out, off, on, in, cancelled, diverted and dropping `filed` and holds; instrument deliveries per flight and trim further if the average runs above 12.

## 17. Sources

**Mobile framework and Expo:** https://expo.dev/changelog/sdk-57, https://expo.dev/changelog/sdk-56, https://expo.dev/changelog/sdk-55, https://expo.dev/changelog/sdk-58-beta, https://expo.dev/pricing, https://docs.expo.dev/versions/latest/sdk/widgets/, https://expo.dev/blog/home-screen-widgets-and-live-activities-in-expo, https://github.com/EvanBacon/expo-apple-targets, https://github.com/software-mansion-labs/expo-live-activity (archived 2026-06-01, deprecated in favour of expo-widgets), https://github.com/ragmha/gym/pull/62, https://pub.dev/packages/live_activities, https://pub.dev/packages/home_widget, https://blog.jetbrains.com/kotlin/2026/05/compose-multiplatform-1-11-0/, https://docs.expo.dev/guides/monorepos/, https://github.com/expo/expo/issues/47627, https://docs.expo.dev/tutorial/eas/multiple-app-variants/, https://docs.expo.dev/build/building-on-ci/, https://docs.expo.dev/guides/apple-privacy/.

**Offline store, maps, state, push:** https://docs.expo.dev/versions/latest/sdk/sqlite/, https://orm.drizzle.team/docs/sqlite/connect-expo-sqlite, https://github.com/Nozbe/WatermelonDB/issues/1769, https://watermelondb.dev/docs/CHANGELOG, https://registry.npmjs.org/@nozbe/watermelondb/latest, https://dev.to/surajb/react-native-082-ushering-in-a-new-era-3aic, https://www.powersync.com/pricing, https://registry.npmjs.org/@maplibre/maplibre-react-native/latest, https://openfreemap.org/, https://docs.protomaps.com/deploy/cloudflare, https://docs.expo.dev/versions/latest/sdk/notifications/, https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications, https://github.com/cloudflare/workerd/issues/4841, https://github.com/wodsmith/thewodapp/pull/710, https://github.com/FiveSheepCo/cloudflare-apns2.

**Cloudflare platform:** https://developers.cloudflare.com/durable-objects/platform/pricing/, https://developers.cloudflare.com/durable-objects/platform/limits/, https://developers.cloudflare.com/durable-objects/api/alarms/, https://developers.cloudflare.com/durable-objects/api/storage-api/, https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/, https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/, https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/, https://developers.cloudflare.com/workers/wrangler/configuration/, https://developers.cloudflare.com/workers/runtime-apis/nodejs/, https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/, https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/, https://github.com/cloudflare/workers-sdk/issues/15618, https://github.com/cloudflare/workers-sdk/issues/10275, https://registry.npmjs.org/@cloudflare/vitest-plugin/latest, https://developers.cloudflare.com/hyperdrive/platform/pricing/, https://developers.cloudflare.com/hyperdrive/platform/limits/, https://developers.cloudflare.com/hyperdrive/configuration/query-caching/, https://developers.cloudflare.com/hyperdrive/configuration/connect-to-postgres/, https://developers.cloudflare.com/hyperdrive/configuration/local-development/, https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/, https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/, https://developers.cloudflare.com/d1/platform/limits/, https://developers.cloudflare.com/queues/platform/pricing/, https://developers.cloudflare.com/kv/platform/pricing/, https://developers.cloudflare.com/kv/api/write-key-value-pairs/, https://developers.cloudflare.com/r2/pricing/, https://developers.cloudflare.com/analytics/analytics-engine/pricing/, https://developers.cloudflare.com/analytics/analytics-engine/limits/, https://developers.cloudflare.com/analytics/analytics-engine/sql-api/, https://developers.cloudflare.com/workers/platform/pricing/, https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/, https://developers.cloudflare.com/email-service/platform/limits/, https://developers.cloudflare.com/email-service/platform/pricing/, https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/, https://developers.cloudflare.com/workers/configuration/cloudflare-access/, https://developers.cloudflare.com/secrets-store/integrations/workers/, https://github.com/cloudflare/wrangler-action, https://github.com/cloudflare/wrangler-action/issues/402.

**Database and ORM:** https://neon.com/pricing, https://neon.com/docs/guides/cloudflare-hyperdrive, https://neon.com/docs/connect/connection-pooling, https://neon.com/docs/guides/scale-to-zero-guide, https://neon.com/docs/postgresql/postgres-version-policy, https://neon.com/docs/changelog/2026-05-01, https://www.postgresql.org/docs/18/functions-uuid.html, https://www.postgresql.org/docs/17/functions-uuid.html, https://registry.npmjs.org/-/package/drizzle-orm/dist-tags, https://orm.drizzle.team/docs/v0-v1-changes, https://orm.drizzle.team/docs/generated-columns, https://orm.drizzle.team/docs/rls, https://github.com/drizzle-team/drizzle-orm/issues/6235, https://raw.githubusercontent.com/neondatabase/create-branch-action/main/README.md.

**Auth, email, billing:** https://better-auth.com/changelog, https://better-auth.com/docs/integrations/hono, https://better-auth.com/docs/integrations/expo, https://better-auth.com/docs/plugins/anonymous, https://better-auth.com/docs/authentication/apple, https://better-auth.com/docs/concepts/rate-limit, https://github.com/better-auth/better-auth/pull/8870, https://github.com/better-auth/better-auth/issues/5426, https://developer.apple.com/documentation/signinwithapplerestapi/revoke_tokens, https://developer.apple.com/support/offering-account-deletion-in-your-app/, https://developers.google.com/identity/gsi/web/guides/verify-google-id-token, https://resend.com/pricing, https://postmarkapp.com/pricing, https://www.revenuecat.com/pricing, https://www.revenuecat.com/docs/integrations/webhooks, https://www.revenuecat.com/docs/customers/user-ids, https://clerk.com/pricing, https://supabase.com/pricing.

**Flight data providers:** https://www.flightaware.com/commercial/aeroapi/, https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml, https://wal.sh/research/ads-b/aeroapi-reference.html, https://discussions.flightaware.com/t/when-is-inbound-fa-flight-id-populated/96100, https://support.flightaware.com/hc/en-us/articles/33381502369175-How-Do-I-Create-A-Post-Alert-In-AeroAPI (403 at review time), https://support.flightaware.com/hc/en-us/articles/32809242173591-Troubleshooting-Common-AeroAPI-Errors, https://aerodatabox.com/pricing/, https://aerodatabox.com/flight-alert-api-2026/, https://aerodatabox.com/data-coverage/, https://api.market/store/aedbx/aerodatabox/openapi.yaml, https://github.com/adsbfi/opendata/blob/main/README.md, https://www.adsb.lol/docs/open-data/api/, https://api.adsb.lol/docs, https://airplanes.live/api-docs/, https://opensky-network.org/about/terms-of-use, https://fr24api.flightradar24.com/subscriptions-and-credits, https://aviationweather.gov/data/api/, https://www.weather.gov/documentation/services-web-api, https://open-meteo.com/en/pricing, https://nasstatus.faa.gov/api/airport-status-information, https://www.eurocontrol.int/service/network-manager-business-business-b2b-web-services, https://www.transtats.bts.gov/Fields.asp?gnoyr_VQ=FGJ, https://ourairports.com/data/, https://github.com/mwgg/Airports, https://www.mictronics.de/aircraft-database/export.php.

**Security and privacy:** https://developers.cloudflare.com/workers/runtime-apis/web-crypto/, https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization, https://developer.apple.com/app-store/app-privacy-details/, https://support.google.com/googleplay/android-developer/answer/13327111, https://docs.sentry.io/platforms/react-native/data-management/sensitive-data/, https://docs.sentry.io/platforms/react-native/guides/expo/data-management/apple-privacy-manifest/, https://docs.sentry.io/platforms/javascript/guides/cloudflare/, https://developers.google.com/workspace/gmail/api/auth/scopes, https://support.google.com/cloud/answer/13465431, https://support.google.com/cloud/answer/7454865, https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification, https://developers.google.com/workspace/workspace-api-user-data-developer-policy, https://www.leviathansecurity.com/programs/google-casa-cloud-application-security-assessment, https://deepstrike.io/blog/google-casa-security-assessment-2025, https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview, https://platform.claude.com/docs/en/manage-claude/api-and-data-retention, https://developers.openai.com/api/docs/guides/your-data, https://pnpm.io/settings/dependency-resolution, https://docs.renovatebot.com/configuration-options/.

**Toolchain and CI:** https://nodejs.org/en/about/previous-releases, https://socket.dev/blog/node-js-tsc-votes-to-stop-distributing-corepack, https://pnpm.io/blog/releases/12.0, https://vitest.dev/blog/vitest-5.html, https://www.infoq.com/news/2026/08/typescript-7-released/, https://hono.dev/docs/guides/rpc, https://github.com/orgs/honojs/discussions/3444, https://biomejs.dev/blog/, https://docs.expo.dev/develop/unit-testing/, https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments, https://developer.android.com/studio/build/configure-app-module, https://developer.apple.com/help/app-store-connect/reference/app-information/, https://sentry.io/pricing/, https://adr.github.io/madr/.

**Unverified (from memory or third-party), flagged inline:** AeroAPI account max_weekly default (1,000 Standard) and non-retry of failed deliveries (support page 403); average alerts per flight (12); ADB alert field coverage and lookahead per plan; AeroAPI discount band semantics and the $32k-64k band; FlightAware billing of error responses; peak-to-average factor (4); APNs liveactivity topic and header requirements; Wear OS Gradle-module config-plugin pattern; adsb.lol multi-hex batch size; same-day flight-number reuse; CASA lab price ranges; FR24 API pricing; BTS TranStats licence text; Zero Trust Free seat count; Better Auth `sessions` PII columns.

## Red-team disposition

**Cost-and-provider lens**

- **Blocker, alerts do not cover gates (section 7/8/16):** Fixed. Cadence is now derived from a per-event detection-latency SLO table; A2 (72 polls + 12 alerts, $0.60) replaces $0.31; cost tables, rate check and open decision 1 recomputed. Partial rebuttal: departure and arrival alerts are bundled with estimated-time changes per the spec mirror, so ETA creep is alert-covered and in-flight polls stay at 30 minutes; gates are not covered, hence 15-minute polls from 6 h to boarding.
- **Major, ADB Flight Alert API not evaluated:** Fixed. Verified at aerodatabox.com/flight-alert-api-2026 (1 credit per flight item, subscriptions free); `registerAlert`/`parseWebhook` added to the real adapter, `adb_alert` trigger, field-coverage instrumentation, cadence B priced, open decision 2 added. Field coverage remains unverified and is stated so.
- **Major, ADB quota with no overage:** Fixed. Units-per-flight added to section 7, ADB quota ladder in ProviderBudget, Growth from day one, Scale utilisation checked (75% at 100k on A2, exceeded on B).
- **Major, ProviderBudget threshold-only counting and false sharding:** Fixed. Lease protocol (8 PE), 8 shards per provider per day, per-minute KV rollup, stated worst-case overshoot, and the 1,000-tracker sub-threshold test.
- **Major, "alerts-only" is not a spend stop:** Fixed. 100% action deletes registrations, per-alert `max_weekly` = 20 stored in `provider_alert_registrations`, budget test asserts DELETE calls.
- **Major, max_weekly default silently stops alerts:** Fixed. Owner task added, `alerts_delivered` vs `alerts_expected` metric, alert-silence fallback to A1. Cap figure marked unverified because the support page was inaccessible.
- **Major, search stampede outside any DO:** Fixed. DesignatorResolver DO with the 50-concurrent-search test; AirportState to serialise boards before Phase 2.
- **Major, provider-dependent canonical key:** Fixed. Provider-independent normaliser with `regional_operators`, `superseded_by_id` and `flight_instance_merges`, `adoptSubscribers` RPC, two lifecycle tests.
- **Major, unbounded ident polls exceed one set:** Fixed. Bracketed first fetch, fa_flight_id thereafter, unit test, documented invariant.
- **Major, user refresh starves the cadence budget:** Fixed. Separate sub-budget inside the DO, half-interval rule, 10/day, route test.
- **Major, no per-user tracker cap:** Fixed. `usage_counters` caps enforced in Phase 0; alert registration only with a non-muted subscriber.
- Minors (underivable 131, rate check counting alerts, unpriced positions, cap margins, ADB lookahead, no hard lifetime): all fixed as described in sections 6, 7 and 8.

**Cloudflare-and-data lens**

- **Blocker, PG17 containers vs `uuidv7()`:** Fixed. Postgres 18 pinned in docker, CI and Neon with a version assertion; application-side UUIDv7 removes the hard dependency.
- **Major, deleteAlarm then expecting a +24h wake-up:** Fixed. Finished phase sets a +22 h alarm; `deleteAll()` clears the alarm at this compatibility date.
- **Major, alarm retries replay provider calls and go dark:** Fixed. Attempt record and next alarm in `transactionSync` before I/O, `retryCount` gate, errors caught, reconcile cron with test.
- **Major, per-file storage isolation:** Fixed. Unique DO names per test, `afterEach` alarm drain, no concurrent DO tests, documented.
- **Major, Hyperdrive inside DOs under vitest (#10275):** Fixed by design. DOs are Postgres-free; outbox → persist queue → consumer (ADR 0007).
- **Major, two Hyperdrive configs vs Neon 0.25 CU connections:** Fixed. One config on the direct endpoint, KV for reference data, 0.5 CU floor, caching set on the resource.
- **Major, lost-update sync cursor:** Fixed with an xid8 watermark (`pg_snapshot_xmin`) rather than routing writes through UserInbox, because DOs are now Postgres-free; concurrency test added.
- **Major, 90-day retention breaks timeline and ML:** Fixed. R2 event archive at finish, `events_r2_key`, `timeline_summary`, `provider_call_daily` stated as the durable series.
- **Major, missing tables:** Fixed. `idempotency_keys`, supersession columns and merge audit, `airport_wx_observations`, `airport_nas_events`, `provider='llm'`, unique on processed messages, `push_tokens.device_id`, `meet_me_sessions`, `share_link_views`, `trip_members`, `currency_rates`, `deleted_subjects`; 61 tables.
- **Major, IATA-keyed airports and aircraft uniqueness:** Fixed. Surrogate airport id with ICAO in the flight key, aircraft validity ranges, `leg_seq`.
- **Major, cascade deletes financial and audit rows:** Fixed. FKs removed on `audit_log`, `revenuecat_events`, `subscriptions`, `notification_deliveries`; random `rc_app_user_id`; `deleted_subjects`.
- **Major, no DO schema migration story:** Fixed. `PRAGMA user_version` runner under `blockConcurrencyWhile`, versioned SQL per class, upgrade tests, `do_schema_version` in `getState()`, CODEOWNERS on `exports`.
- **Major, ProviderBudget singleton wording:** Fixed by real sharding (see above); the 250 ms fail-open timeout is adopted.
- Minors (KV 1 write/s, AE 250-point cap, driver rules and per-request Better Auth, gradual rollout with `exports`, BRIN column and trigger, D1 replication argument, wrangler version skew, Hyperdrive caching location): all fixed.

**Mobile-native-and-security lens**

- **Blocker, stale expo-widgets premise:** Fixed. expo-widgets is the default for widget, Live Activity and Dynamic Island (verified stable in SDK 56 with token listeners); `modules/activitykit` deleted; apple-targets kept only for watchOS; coexistence is an increment 13 acceptance test; expo-live-activity marked archived; open decision 10 rewritten. Residual position: Android keeps the Kotlin Glance shell until SDK 58 is stable.
- **Major, crypto-shredding claim false under PITR:** Fixed. Claim withdrawn; deletion latency tied to Neon retention (recommend 1 day); moving keys outside PITR is open decision 23.
- **Major, Better Auth Apple idToken path captures no refresh token:** Fixed. Custom `POST /api/auth/apple/native` with nonce required and code exchange; test added.
- **Major, CASA figures miscited:** Fixed. Rewritten with the correct Google citations and lab quotes marked unverified; written quote is an owner task.
- **Major, sync feed has no path for shared flight state:** Fixed. Subscription join on `flight_instances.updated_at` or KV snapshot with ETag; conflict policy stated; route test added.
- **Major, privacy-label reasoning wrong:** Fixed. `/v1/events` unauthenticated with install id, Diagnostics declared, privacy manifests aggregated.
- **Major, EAS 100k cost omits base fee:** Fixed. $574 Production, $629 Starter.
- Minors (Secrets Store reason, APNs production path untested, Live Activity token columns, per-email magic-link limit, WatermelonDB wording, Expo pin 57.0.23, Neon idle wording, threat-model content, FCM secret, sessions PII): all fixed.