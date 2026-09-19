# Increment 3: `@planeahead/db` schema, migrations, seeds

Status: spec (2026-09-19). Builder: Fable 5.1. Reviewers: two Opus 5 lenses (data model correctness, Drizzle/Postgres pitfalls) plus orchestrator read.

## Goal

The full Postgres 18 schema for the entire feature list (61 tables in 8 domains, plan section 6, detailed in `docs/research/phase0-dossier.md` section 5), expressed in Drizzle pg-core with generated SQL migrations, seed loaders for reference data, the `withDb` helper that enforces the Workers driver rules, and the first complete `docs/schema-review.md`. Postgres 18 is required (native `uuidv7()`); the migration runner refuses PG17 with a clear message.

Acceptance: `pnpm --filter @planeahead/db db:generate` produces no diff (schema and migrations in sync); `pnpm --filter @planeahead/db db:migrate` applies cleanly to a fresh PG18 Neon branch and to the CI `postgres:18` container; `db:check` (drizzle-kit check) clean; a test runs migrations then inserts one row per domain through Drizzle and reads it back; `SHOW server_version_num` assertion fails clearly on PG17; `docs/schema-review.md` lists every table with purpose, writer, readers, PII class, encryption, retention, GDPR path and rows at 1k/10k/100k.

## Conventions (irreversible, ADR 0003 and 0006 already cover keys and ids)

- Every PK `uuid` with `.default(sql\`uuidv7()\`)`; app code always supplies ids from `@planeahead/shared` `uuidv7()`; the default is a fallback.
- `timestamptz` for every instant (`timestamp({ withTimezone: true, mode: 'string' })`), `created_at` default `now()`, `updated_at` maintained by a `set_updated_at()` trigger created in migration 0000 and attached to every table that has the column.
- Enumerations are `text` with a `check()` constraint listing allowed values; no `pgEnum`.
- `deleted_at timestamptz` only on sync entities: `flight_subscriptions`, `trips`, `trip_members`, `user_preferences`, `notification_preferences`.
- Denormalised `user_id` on every user-owned row; no RLS.
- Secret columns: `<name>_enc bytea` + `<name>_key_version smallint`; never a plaintext secret column.
- Presented tokens: `token_hash bytea` (SHA-256) unique + `token_prefix text` (first 8 chars for lookup); never the token.
- Tables that must survive account deletion have NO foreign key to `users`: `audit_log`, `revenuecat_events`, `subscriptions`, `notification_deliveries`, `deleted_subjects`, `provider_calls`, `provider_call_daily`.
- Append-only tables get a BRIN index on `created_at`: `flight_events`, `provider_calls`, `airport_wx_observations`, `notification_deliveries`, `audit_log`.
- `flight_instances.flight_key` is a stored generated column: `operating_carrier_icao || '-' || flight_number || '-' || scheduled_departure_date || '-' || origin_icao || CASE WHEN leg_seq > 1 THEN '-L' || leg_seq ELSE '' END`, unique. The expression is frozen (drizzle-kit drops and recreates generated columns on change).
- Naming: snake_case tables and columns, singular column names, plural table names; indexes named `<table>_<cols>_idx`, unique `<table>_<cols>_key`.

## Domains and tables (column detail in the dossier section 5; this list is normative for existence)

Identity: users, sessions, accounts, verifications, rate_limits, user_keys, devices, user_preferences, user_consents, user_sync_changes, idempotency_keys, deleted_subjects.
Reference: airports, airport_profiles, airlines, regional_operators, aircraft_types, aircraft, currency_rates.
Flight core: flight_instances, flight_instance_merges, flight_designators, flight_events, flight_tracks.
Trips and subscriptions: trips, trip_members, flight_subscriptions, logbook_entries, user_stats_yearly, usage_counters.
Providers and models: provider_calls, provider_call_daily, provider_budget_config, provider_alert_registrations, provider_webhook_events, delay_predictions, delay_outcomes, airport_wx_observations, airport_nas_events, airport_delay_snapshots, airport_delay_hourly, bts_carrier_flight_monthly, bts_route_monthly, bts_airport_hourly, bts_import_runs.
Notifications: notification_preferences, push_tokens, live_activities, notifications, notification_deliveries.
Import, calendar, sharing: email_accounts, email_messages_processed, email_extractions, inbound_addresses, inbound_messages, imports, import_rows, calendar_connections, calendar_events, ics_feed_tokens, share_links, share_link_views, meet_me_sessions.
Billing, API, GDPR: entitlements, revenuecat_events, subscriptions, api_tokens, audit_log, data_export_jobs, account_deletion_requests.

Better Auth tables (`users`, `sessions`, `accounts`, `verifications`, `rate_limits`) must match the Better Auth 1.7.x Drizzle adapter's expected column names for the core schema plus the anonymous and magic-link plugins (verify against the Better Auth docs at build time and record the mapping in schema-review.md); extra columns are ours.

## Package layout

```
packages/db/
  package.json          @planeahead/db; deps drizzle-orm 0.45.x, postgres (postgres.js) latest 3.x; devDeps drizzle-kit 0.31.x, tsx
  drizzle.config.ts     dialect postgresql, schema ./src/schema/index.ts, out ./migrations, casing snake_case
  src/schema/<domain>.ts  one file per domain above, plus columns.ts (shared column helpers: id, timestamps, softDelete, encrypted(name))
  src/schema/index.ts
  src/client.ts         withDb(env, ctx, fn): creates a postgres.js client from env.DB (Hyperdrive) or DATABASE_URL, max 5 connections, prepare false, runs fn, closes via ctx.waitUntil(client.end()) when ctx exists else awaits end; exports the Drizzle db type
  src/migrate.ts        programmatic migrator for CI and tests; asserts server_version_num >= 180000 first
  src/seed/             airports (OurAirports CSV + mwgg/Airports tz), airlines (OPTD + a hand list of check-in URL templates), regional_operators (from @planeahead/shared seed), aircraft_types (Doc 8643 community CSV); each loader is idempotent (upsert on natural key) and reads from files under seed/data/ downloaded by scripts/fetch-seed-data.mjs (data files are committed once fetched, with LICENSE notes)
  migrations/           generated SQL + meta
  test/                 migrate-and-roundtrip.test.ts, generated-column.test.ts, version-guard.test.ts (uses a Neon branch URL from TEST_DATABASE_URL; skipped with a loud warning when unset)
```

## Docs
- `docs/schema-review.md` per the outline in the plan section 6.
- `docs/adr/0002-neon-not-d1.md`, `docs/adr/0007-do-postgres-free.md` (the rule that DOs never open Postgres; the persist queue is the only writer of flight_instances and flight_events).

## Constraints
- Drizzle API surface limited to what is identical in 1.0 rc: core query builder with explicit joins, `check`, `index`/`uniqueIndex` with `.using` and `.where`, `sql` defaults, `generatedAlwaysAs(sql)`, `$onUpdate` for typing only. No relational query builder v0, no `.enableRLS()`, no declarative partitioning.
- No em dashes. ESM. The Neon connection string for tests comes from `TEST_DATABASE_URL` in `.env.test` (gitignored); the orchestrator supplies the dev branch URL.
