# Increment 3: `@planeahead/db` schema, migrations, seeds

Status: complete (2026-09-20) on branch `inc3-db-schema`, stacked PR opened for CI. Outcome, spikes and deviations are in `docs/build-log.md`; the normative table list below has 70 entries (the plan's 61 was a miscount). Builder: Fable 5.1. Reviewers: two Opus 5 lenses (data model correctness, Drizzle/Postgres pitfalls) plus orchestrator read. Branch: `inc3-db-schema`, based on `inc2-shared-contracts` (needs `uuidv7()` and the regional-operator hint JSON from `@planeahead/shared`).

Read `docs/increments/03-db-schema.facts.md` before writing any code. Every fact there was verified against a primary source on 2026-09-19 and several of them overrode the first version of this spec; the rules below already incorporate them.

## Goal

The full Postgres 18 schema for the entire feature list (61 tables in 8 domains, plan section 6, detailed in `docs/research/phase0-dossier.md` section 5), expressed in Drizzle pg-core with generated SQL migrations, seed loaders for reference data, the `withDb` helper that enforces the Workers driver rules, a real Postgres 18 test harness that needs no Docker and no Homebrew, and the first complete `docs/schema-review.md`. Postgres 18 is required (native `uuidv7()`); the migration runner refuses PG17 with a clear message.

Acceptance: `pnpm --filter @planeahead/db db:generate` produces no diff (schema and migrations in sync); `pnpm --filter @planeahead/db test` starts an embedded Postgres 18.4, applies every migration, inserts one row per domain through Drizzle and reads it back, and passes on a Mac with no external database; the same tests pass in CI against the `postgres:18` service container via `TEST_DATABASE_URL`; `db:check` (drizzle-kit check) clean; the `SHOW server_version_num` guard fails clearly on PG17 (unit-tested with a stubbed client); the unique index on `flight_instances.flight_key` exists after migration; `docs/schema-review.md` lists every table with purpose, writer, readers, PII class, encryption, retention, GDPR path and rows at 1k/10k/100k.

## Conventions (irreversible; ADR 0003 and 0006 already cover keys and ids)

- Every PK `uuid` with `.default(sql\`uuidv7()\`)`; app code always supplies ids from `@planeahead/shared` `uuidv7()`; the default is a fallback.
- `timestamptz` for every instant: `timestamp('col', { withTimezone: true, mode: 'string' })`, `created_at` default `now()`, `updated_at` maintained by a `set_updated_at()` trigger created in a custom migration (`drizzle-kit generate --custom --name add_set_updated_at`, one `--> statement-breakpoint` between the function and each `CREATE TRIGGER`, never inside the dollar-quoted body) and attached to every table that has the column. Exception: the five Better Auth tables use `mode: 'date'` because Better Auth writes JavaScript `Date` objects and the `mode: 'string'` write path is unverified.
- Enumerations are `text` with a `check()` constraint listing allowed values; no `pgEnum`. Before writing the 61 tables, run a five-minute spike: change a check expression in a scratch table and confirm what SQL `drizzle-kit generate` emits (drop and add, or nothing). Record the answer in the migration policy section of schema-review.md; if it is a silent no-op, add a `pnpm db:check-constraints` script that compares `pg_constraint` definitions with the schema.
- `deleted_at timestamptz` only on sync entities: `flight_subscriptions`, `trips`, `trip_members`, `user_preferences`, `notification_preferences`.
- Denormalised `user_id` on every user-owned row; no RLS.
- Secret columns: `<name>_enc bytea` + `<name>_key_version smallint`; never a plaintext secret column that we write. Better Auth's own `accounts.access_token`, `accounts.refresh_token` and `accounts.id_token` columns exist because Better Auth insists on them; they are Better Auth-owned, documented as such, and increment 5 decides `account.encryptOAuthTokens`. Our Apple refresh token lives only in `accounts.refresh_token_enc`.
- Presented tokens: `token_hash bytea` (SHA-256) unique + `token_prefix text` (first 8 chars for lookup); never the token. Exception: `sessions.token` is Better Auth-owned plaintext text, unique, because Better Auth looks it up by equality and offers no hashed mode for sessions. Magic-link tokens are hashed by the plugin (`storeToken: 'hashed'`) into `verifications`.
- Tables that must survive account deletion have NO foreign key to `users`: `audit_log`, `revenuecat_events`, `subscriptions`, `notification_deliveries`, `deleted_subjects`, `provider_calls`, `provider_call_daily`.
- Append-only tables get a BRIN index on `created_at`: `flight_events`, `provider_calls`, `airport_wx_observations`, `notification_deliveries`, `audit_log`.
- `flight_instances.flight_key` is a stored generated column: `operating_carrier_icao || '-' || flight_number || '-' || scheduled_departure_date || '-' || origin_icao || CASE WHEN leg_seq > 1 THEN '-L' || leg_seq ELSE '' END`. Uniqueness is a `uniqueIndex()`, not a unique constraint (Drizzle documents that generated columns cannot sit in constraints). Spike this first against embedded PG18: generated column, unique index, `db:generate` twice with no diff. The expression is frozen: drizzle-kit 0.31 drops and recreates a changed generated column and does not recreate dependent indexes (drizzle-orm issue 4929), so `generated-column.test.ts` asserts the index exists after migration.
- No Postgres array column types anywhere; use `jsonb` or a junction table. This is what lets `withDb` set `fetch_types: false`.
- Naming: snake_case tables and columns written out explicitly in every column definition (do not rely on the `casing` option, which moves in Drizzle 1.0); TS property names camelCase; plural table names; indexes named `<table>_<cols>_idx`, unique `<table>_<cols>_key`.
- `pgTable` third argument uses the array form `(t) => [ ... ]` everywhere; the object form is deprecated since 0.36.

## Better Auth tables (exact requirements from the 1.7.5 source)

- Export keys must be exactly `users`, `sessions`, `accounts`, `verifications`, `rateLimits` (the adapter is configured with `usePlural: true` and a five-key schema object in increment 5). SQL table for `rateLimits` is `rate_limits`.
- Required columns (TS names, SQL snake_case): `users`: id, name, email (unique), emailVerified (default false), image, createdAt, updatedAt, plus the anonymous plugin's isAnonymous (boolean, nullable, default false). `sessions`: id, expiresAt, token (unique text), createdAt, updatedAt, ipAddress, userAgent, userId (FK to users, cascade). `accounts`: id, accountId, providerId, userId (FK cascade), accessToken, refreshToken, idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt; no `issuer` column (1.7.5 dropped it). `verifications`: id, identifier, value, expiresAt, createdAt, updatedAt. `rate_limits`: id, key (unique), count, lastRequest (`bigint({ mode: 'number' })`; the round-trip test asserts `typeof === 'number'` through postgres.js).
- Every extra column we add to these five tables must be nullable or carry a DB default, because Better Auth's runtime `validateSchema` throws `SchemaMismatchError` for a NOT NULL column it does not write. Our extras: `users.is_anonymous` is the plugin's; `users.locale`, `users.deleted_at`-style columns are ours and nullable; `accounts.refresh_token_enc`, `accounts.refresh_token_key_version` nullable.
- Timestamps on these five tables: `mode: 'date'` (see conventions).

## Domains and tables (column detail in the dossier section 5; this list is normative for existence)

Identity: users, sessions, accounts, verifications, rate_limits, user_keys, devices, user_preferences, user_consents, user_sync_changes, idempotency_keys, deleted_subjects.
Reference: airports, airport_profiles, airlines, regional_operators, aircraft_types, aircraft, currency_rates.
Flight core: flight_instances, flight_instance_merges, flight_designators, flight_events, flight_tracks.
Trips and subscriptions: trips, trip_members, flight_subscriptions, logbook_entries, user_stats_yearly, usage_counters.
Providers and models: provider_calls, provider_call_daily, provider_budget_config, provider_alert_registrations, provider_webhook_events, delay_predictions, delay_outcomes, airport_wx_observations, airport_nas_events, airport_delay_snapshots, airport_delay_hourly, bts_carrier_flight_monthly, bts_route_monthly, bts_airport_hourly, bts_import_runs.
Notifications: notification_preferences, push_tokens, live_activities, notifications, notification_deliveries.
Import, calendar, sharing: email_accounts, email_messages_processed, email_extractions, inbound_addresses, inbound_messages, imports, import_rows, calendar_connections, calendar_events, ics_feed_tokens, share_links, share_link_views, meet_me_sessions.
Billing, API, GDPR: entitlements, revenuecat_events, subscriptions, api_tokens, audit_log, data_export_jobs, account_deletion_requests.

Reference-table specifics: `airports.icao` is `COALESCE(icao_code, ident)` from OurAirports with an `icao_source` column (`icao_code` or `ident`) because ident-derived pseudo-ICAO codes will not resolve against AeroAPI; `airports.type` check lists the values observed in the live file (balloonport, closed, heliport, large_airport, medium_airport, seaplane_base, small_airport); `airports.tz` is NOT NULL and the loader fails on a missing tz. `aircraft_types.wake_turbulence` check allows `L`, `M`, `H`, `J`, `L/M`, `M/H` stored as-is. `regional_operators` carries `confidence` (`hint` | `observed`), `observation_count`, `valid_from`, `valid_to`, `source`.

## Package layout

```
packages/db/
  package.json          @planeahead/db; deps drizzle-orm 0.45.2, postgres ^3.4.9; devDeps drizzle-kit 0.31.10, tsx, embedded-postgres 18.4.0-beta.17 (exact), geo-tz (fetch script only)
  drizzle.config.ts     dialect postgresql, schema ./src/schema/index.ts, out ./migrations
  src/schema/<domain>.ts  one file per domain above, plus columns.ts (shared column helpers: id, timestamps, softDelete, encrypted(name), tokenHash())
  src/schema/index.ts
  src/client.ts         withDb(env, fn) for Workers: postgres(env.DB.connectionString, { max: 5, fetch_types: false, prepare: true }), drizzle(client, { schema }), runs fn, does NOT call end() (Hyperdrive cleans up per invocation); createNodeDb(url) for CI, scripts and tests: same options plus an explicit await client.end() in a close() helper. Exports the Db type. No module-scope client (the ESLint rule from increment 1 applies to apps/api; add packages/db/src to its file list).
  src/migrate.ts        programmatic migrator for CI, deploy and tests; takes a URL string only (never a binding); refuses hosts containing "-pooler"; asserts server_version_num >= 180000 before migrating; exports migrationHash() (sha256 of the journal) for /health
  src/seed/             loaders: airports (OurAirports filtered + mwgg tz + curated overrides), airlines (VRS standing-data airlines.csv spine, OPTD alliances and validity left-joined on ICAO, alliance names normalised), aircraft_types (VRS model-type CSVs deduped on ICAO preferring IsActive, fake "-" designators dropped, J patched from ColtJD45), regional_operators (from @planeahead/shared regional-operators.seed.json, confidence 'hint'); each loader idempotent (upsert on natural key)
  seed/data/            COMMITTED derived files, each under 3 MB: airports.filtered.csv (scheduled_service = yes OR type in large_airport, medium_airport), airports.tz-overrides.json (curated, see below), airlines.csv, optd_airlines.subset.csv, aircraft-types.csv, plus MANIFEST.json (upstream URL, upstream SHA-256, upstream byte count, Content-Length seen, fetched_at, license, row counts) and LICENSES.md
  scripts/fetch-seed-data.mjs   downloads upstream files to a temp dir, fails if bytes received != Content-Length (two downloads in research came back silently truncated), records SHA-256, applies the filters, writes seed/data/*, and for airports with no mwgg tz computes a candidate with geo-tz into a REVIEW file that a human or the orchestrator promotes into airports.tz-overrides.json (geo-tz data is ODbL; the committed overrides are curated data, not a build-time derivation)
  migrations/           generated SQL + meta
  test/                 globalSetup.ts (embedded-postgres: mkdtemp data dir, free port, initialise/start/createDatabase each wrapped in a 60 s Promise.race; sets TEST_DATABASE_URL; skipped when TEST_DATABASE_URL is already set, which is how CI uses the service container), globalTeardown.ts (stop with timeout, rm dir), migrate-and-roundtrip.test.ts (one insert + select per domain, bytea round trip, bigint mode number, generated flight_key value), generated-column.test.ts (unique index exists after migrate), version-guard.test.ts (stubbed client returning 170000 is refused), trigger.test.ts (updated_at changes on UPDATE), better-auth-shape.test.ts (every extra column on the five tables is nullable or defaulted; queried from information_schema)
```

pnpm: add `@embedded-postgres/darwin-arm64` and `@embedded-postgres/linux-x64` to `onlyBuiltDependencies` in `pnpm-workspace.yaml` (they need their postinstall to recreate symlinks). CI `test` job: add a `postgres:18` service with the documented `pg_isready` health check and set `TEST_DATABASE_URL`; keep `server_version_num` assertion as the guard against the tag moving to 19.

## Docs

- `docs/schema-review.md` per the outline in the plan section 6, plus: the Better Auth ownership notes above; the connection budget with the corrected arithmetic (Neon reserves 7 connections: 0.25 CU gives 97 usable, 0.5 CU 202; Hyperdrive's ~100 is a soft ceiling; production at 0.5 CU; `origin_connection_limit` set explicitly per environment in increment 4, 80 for dev and staging); the `statement_timeout` rule (Hyperdrive pools in transaction mode, so per-request `SET` does not stick; the timeout is set with `ALTER ROLE ... SET statement_timeout` as an environment setup step, verified on the dev branch, never inside a migration); migrations only ever run over `DATABASE_URL` against the Neon direct endpoint, never through Hyperdrive; the check-constraint change behaviour found in the spike; the driver choice (postgres.js kept over node-postgres: single dependency shared with tests, tagged-template SQL, Cloudflare lists it as supported; revisit only if Hyperdrive caching shows a measurable gap).
- `docs/adr/0002-neon-not-d1.md`, `docs/adr/0007-do-postgres-free.md` (the rule that DOs never open Postgres; the persist queue is the only writer of flight_instances and flight_events; justify it on alarm at-least-once retries and Hyperdrive connection counts, and do NOT cite workers-sdk#10275, which was closed as a test-side fake-timers problem), and a short `docs/adr/0009-postgres-js-driver.md`.

## Constraints

- Drizzle API surface limited to what is identical in 1.0 rc: core query builder with explicit joins, `check`, `index`/`uniqueIndex` with `.using` and `.where`, `sql` defaults, `generatedAlwaysAs(sql)`, `$onUpdate` for typing only, array-form table extras. No relational query builder, no `.enableRLS()`, no declarative partitioning, no reliance on the `casing` option.
- New dependencies only as listed above. `geo-tz` is used by the fetch script only and must not appear in any runtime import.
- No em dashes. ESM. `TEST_DATABASE_URL` in `.env.test` (gitignored) is optional and only for pointing the suite at a Neon branch; the default is the embedded server.
- Strike from the earlier draft: the "icao-aircraft-types npm package" (does not exist), OpenSky as a seed source (license unverified, 403 to fetches), and OPTD as the airline spine (wrong ICAO for Republic Airways).

## Owner tasks surfaced by the research (not blocking the build)

- Create the Neon project with Postgres 18 selected explicitly (the default major for new projects is unverified), region us-east-1, Launch plan; `main` and `staging` branches; API key for PR branches.
- Decide whether BTS-derived regional operator ranges (monthly refresh, needs the BTS import pipeline) replace the hint table; deferred to the BTS increment.
- Confirm BTS terms of use before committing derived aggregates (presumptively public domain as a US DOT work, unverified).
