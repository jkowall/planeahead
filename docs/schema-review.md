# Schema review: `@planeahead/db`

Status: first complete draft, increment 3 (2026-09-20). Increment 12 finalises it. Reviewers sign
off in section 17.

This document is the reference for the Postgres 18 schema in `packages/db/src/schema`, the
migrations in `packages/db/migrations`, and the rules every later increment must keep. Where it
disagrees with the code, the code is wrong and the document wins until a reviewer changes the
document.

## 1. Purpose and sign-off

The schema is the most expensive artefact in the system to change once data exists. This review
exists so that every table was argued for before the first production row: what it holds, who
writes it, who reads it, what personal data it carries, how it is encrypted, when it is purged,
and what happens to it when the user asks to be deleted.

Sign-off (increment 3): data model correctness lens, Drizzle and Postgres pitfalls lens,
orchestrator read. See section 17 for the checklist each reviewer walks.

## 2. Principles

1. **One id format.** Every primary key is a `uuid` with the PG18 `uuidv7()` default;
   application code supplies ids from `@planeahead/shared` (ADR 0006). Two documented
   exceptions: `user_sync_changes.seq` is a `bigint` identity because the sync cursor needs a
   total order inside one transaction, and `idempotency_keys` has the natural composite key
   `(user_id, key)`.
2. **Every instant is `timestamptz`; exactly one origin-local `date` lives in the flight key.**
   `created_at` defaults to `now()`; `updated_at` is maintained by the `set_updated_at()` trigger
   on all 45 mutable tables (custom migration 0001), never by application code, so raw SQL and
   queue consumers keep it honest, and every trigger skips a no-op UPDATE so a replayed
   identical write does not move it. Drizzle reads every instant as an ISO-8601 UTC string
   (`2026-09-19T22:30:00Z`, microseconds preserved) that satisfies `IsoInstantSchema` in
   shared: the `instant()` column type (`src/schema/columns.ts`) normalises the
   session-time-zone text Postgres renders (`2026-09-19 22:30:00+00`, which is not ISO-8601 and
   fails the contract) on every read, and refuses a write without a zone designator. Raw SQL
   reads (`sql<string>`, `db.execute`) get Postgres text; pass it through the exported
   `toIsoInstant()`. The four Better Auth tables with timestamps use Drizzle's `mode: 'date'`
   (section 13). `test/migrate-and-roundtrip.test.ts` asserts one instant per domain against
   the shared schema.
3. **Enumerations are `text` plus a `check()` constraint.** No `pgEnum`. 137 check constraints
   in migration 0000, including a format check on every column that stores an ICAO, IATA,
   Mode S hex or flight-number code (a lower-case or padded value can never fork a lookup or a
   KV key; the contracts test finds any such column without one). The value lists that mirror
   `@planeahead/shared` (flight status, provider ids, call triggers and results, sync entities,
   alert events) are asserted identical by `test/schema-contracts.test.ts`.
4. **Tombstones only on sync entities.** `deleted_at` exists on exactly `flight_subscriptions`,
   `trips`, `trip_members`, `user_preferences`, `notification_preferences` and
   `logbook_entries`, which is the `SYNC_ENTITIES` list in shared. Everything else is hard
   deleted. The column name is reserved for that tombstone (the mobile client replays deletes
   from it); `deleted_subjects` records `subject_deleted_at`, so the contracts test is a pure
   structural check with no allowlist.
5. **Denormalised `user_id` on every user-owned row; no row-level security.** Hyperdrive pools in
   transaction mode, so a per-request `SET ROLE` or session variable would not stick. Ownership
   is enforced in the API layer and every user-owned table cascades from `users`.
6. **Secrets and tokens never sit in plaintext.** Secrets are `<name>_enc bytea` (AES-256-GCM,
   AAD `table:column:row_id`) plus `<name>_key_version smallint`. Presented tokens are a
   SHA-256 `token_hash bytea` plus an 8-character `token_prefix`. The Better Auth exceptions are
   listed in section 12; the test `stores secrets and tokens as bytea` enforces the rule for
   every other table.
7. **Tables that must survive account deletion have no foreign key to `users`:** `audit_log`,
   `revenuecat_events`, `subscriptions`, `notification_deliveries`, `deleted_subjects`,
   `provider_calls`, `provider_call_daily`. They are keyed by a pseudonymous `subject_id` or by
   RevenueCat's random app user id. Better Auth's `rate_limits` and `verifications` also have
   no FK but are not survivors by design: `key` and `identifier` can hold an email address or
   an IP, so the deletion job purges them by subject and the housekeeping cron by age
   (section 5).
8. **Append-only tables get a BRIN index on `created_at`:** `flight_events`,
   `provider_calls`, `airport_wx_observations`, `notification_deliveries`, `audit_log`. Insert
   order correlates with `created_at` (UUIDv7 ids, single writer), which is what makes BRIN
   cheap and effective there.
9. **No Postgres array columns anywhere.** `jsonb` or a junction table instead. This is what
   makes `fetch_types: false` safe in the driver (ADR 0009); the contracts test asserts it from
   the migration snapshot.
10. **Names are explicit.** Tables and columns are written in snake_case at every call site (no
    reliance on Drizzle's `casing` option, which moves in 1.0). Indexes are
    `<table>_<cols>_idx`, unique indexes `<table>_<cols>_key`, checks `<table>_<what>_check`.
    Every identifier stays within Postgres's 63-byte limit; eleven Drizzle-generated foreign key
    and index names did not and were replaced with explicit names (a test guards the limit).
11. **`pgTable` extras use the array form** and the Drizzle surface is restricted to what the
    1.0 release candidate keeps: core query builder, `check`, `index`/`uniqueIndex` with
    `.using` and `.where`, `sql` defaults, `generatedAlwaysAs(sql)`, explicit `foreignKey`.

## 3. Storage tier matrix

| Data                                   | Postgres                                             | Durable Object SQLite     | KV                                                         | R2                                         | Forbidden                                                        |
| -------------------------------------- | ---------------------------------------------------- | ------------------------- | ---------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| Users, sessions, accounts, preferences | source of truth                                      | UserInbox mirrors devices | never                                                      | never                                      | KV (no auth in KV), R2                                           |
| Flight registry (`flight_instances`)   | source of truth after flush                          | FlightTracker `flight`    | `flight:snapshot:{key}` 180 s                              | never                                      | KV as source of truth                                            |
| Flight events                          | 90 days, then purged                                 | FlightTracker `events`    | never                                                      | `events/{YYYY}/{MM}/{key}.jsonl.gz` 365 d  | Postgres forever (retention cron is mandatory)                   |
| Aircraft positions                     | never                                                | `positions` ring, 2,000   | never                                                      | `tracks/{YYYY}/{MM}/{key}.jsonl.gz` 365 d  | Postgres (only the `flight_tracks` pointer and a preview)        |
| Weather, boards, NAS status            | `airport_wx_observations` 90 d, `airport_nas_events` | AirportState              | `wx:metar:{ICAO}` 600 s, `board:{ICAO}:{dir}:{hour}` 300 s | never                                      | Postgres as the hot read path                                    |
| Provider call ledger                   | `provider_calls` 90 d, `provider_call_daily` durable | `budget` counters         | `budget:day:{date}:{provider}` 172,800 s                   | never                                      | KV as the billing record                                         |
| Idempotency keys, rate limits, quotas  | source of truth (24 h, `usage_counters`)             | never                     | never                                                      | never                                      | KV (eventually consistent) for anything that enforces a cap      |
| Push tokens, Live Activity tokens      | source of truth                                      | UserInbox mirrors         | never                                                      | never                                      | KV, R2                                                           |
| Email bodies                           | never                                                | never                     | never                                                      | never                                      | Everywhere: only provider message ids and structured extractions |
| Imports, exports, share images         | metadata rows                                        | never                     | `share:page:{sha256(token)[0:32]}` 60 s                    | `imports/`, `exports/` 7 to 30 d, `share/` | Postgres for file bodies                                         |
| BTS aggregates                         | monthly tables                                       | never                     | never                                                      | `bts/raw/` kept                            | DO storage                                                       |

## 4. Domain diagrams

Foreign keys only; `->` reads "references". Every user-owned table also carries `user_id`.

```
Identity
  users <- sessions, accounts, user_keys(1:1), devices, user_preferences(1:1), user_consents,
           user_sync_changes, idempotency_keys(PK user_id,key)
  users.home_airport_id -> airports (set null)
  deleted_subjects, rate_limits, verifications: standalone

Reference
  airports <- airport_profiles(1:1)
  airlines, regional_operators, aircraft_types, aircraft, currency_rates: standalone

Flight core
  airports (id, icao) <- flight_instances (origin_airport_id, origin_icao) and
                         (destination_airport_id, destination_icao), composite, restrict
  flight_instances <- flight_designators, flight_events, flight_tracks(1:1),
                      flight_instance_merges.survivor/merged (cascade)
  flight_instances.superseded_by_id, inbound_flight_instance_id: soft self references, no FK

Trips and subscriptions
  users <- trips <- trip_members (also -> users)
  users, flight_instances(restrict), trips(set null) <- flight_subscriptions
  users, flight_instances(set null) <- logbook_entries
  users <- user_stats_yearly
  usage_counters: standalone (subject is a user id or a hash)

Providers and models
  flight_instances <- provider_alert_registrations, delay_predictions, delay_outcomes(1:1)
  bts_import_runs <- bts_carrier_flight_monthly, bts_route_monthly, bts_airport_hourly
  provider_calls, provider_call_daily, provider_budget_config, provider_webhook_events,
  airport_wx_observations, airport_nas_events, airport_delay_snapshots, airport_delay_hourly:
  standalone (flight_instance_id where present is a soft reference)

Notifications
  users <- notification_preferences(1:1), push_tokens(-> devices), notifications
  users, devices, flight_subscriptions, flight_instances <- live_activities
  notification_deliveries: standalone (notification_id and subject_id are soft references)

Import, calendar, sharing
  users <- email_accounts <- email_messages_processed <- email_extractions(set null)
  users <- inbound_addresses <- inbound_messages
  users <- imports <- import_rows (-> flight_subscriptions set null)
  users <- calendar_connections <- calendar_events (-> flight_subscriptions cascade)
  users <- ics_feed_tokens, share_links(-> flight_instances | trips) <- share_link_views
  users, flight_instances <- meet_me_sessions

Billing, API, GDPR
  users <- entitlements, api_tokens, data_export_jobs
  revenuecat_events, subscriptions, audit_log, account_deletion_requests: standalone
```

## 5. Table catalog

Columns: PII class 0 none, 1 pseudonymous identifiers only, 2 personal data (names, email,
IP, user agent, itinerary), 3 contains an encrypted secret. Enc: which columns are encrypted or
hashed. GDPR: what happens on account deletion (`cascade` = FK cascade from `users`;
`by subject` = deleted or anonymised by the deletion job using the subject id; `kept` = survives
by design, pseudonymous). Rows: order of magnitude twelve months in, after retention, at 1k /
10k / 100k monthly active users, assuming one tracked flight per user per month, 40 events and
130 provider calls per flight, 90-day retention on the ledgers.

### Identity

| Table               | Purpose                                                                                  | Writer                                     | Readers                          | PII | Enc                                                                                           | Retention                                                                               | GDPR                                                                   | Rows 1k / 10k / 100k |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------- | --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------- |
| `users`             | Better Auth user plus status, plan cache, home airport                                   | Better Auth, API                           | API, auth, jobs                  | 2   | none (email in plaintext, unique on `lower(email)`)                                           | until deletion                                                                          | hard delete                                                            | 1k / 10k / 100k      |
| `sessions`          | Better Auth sessions                                                                     | Better Auth                                | auth                             | 2   | `token` plaintext (Better Auth-owned)                                                         | expired rows purged at 30 d                                                             | cascade                                                                | 3k / 30k / 300k      |
| `accounts`          | Better Auth OAuth and credential accounts                                                | Better Auth, Apple route                   | auth, deletion job               | 3   | `refresh_token_enc`; Better Auth's own token columns plaintext                                | until deletion                                                                          | cascade                                                                | 1.5k / 15k / 150k    |
| `verifications`     | Magic link and OAuth state (`storeToken: 'hashed'`)                                      | Better Auth                                | auth                             | 2   | magic-link tokens hashed by the plugin; `identifier` may be an email                          | expired rows purged by the increment 12 cron over `verifications_expires_at_idx`        | by subject (rows whose `identifier` is the user's email)               | hundreds / 1k / 10k  |
| `rate_limits`       | Better Auth database rate limiting                                                       | Better Auth                                | auth                             | 2   | none: `key` is an IP or an email in plaintext                                                 | rows idle over 24 h purged by the increment 12 cron over `rate_limits_last_request_idx` | by subject (rows whose `key` embeds the user's email; IP rows age out) | 1k / 10k / 100k      |
| `user_keys`         | Wrapped per-user DEK and KEK version                                                     | crypto module                              | crypto module                    | 3   | `wrapped_dek` is AES-KW ciphertext                                                            | until deletion                                                                          | cascade                                                                | 1k / 10k / 100k      |
| `devices`           | Installs, platform, OS, attestation reserved                                             | `POST /v1/devices`                         | push, analytics                  | 1   | none                                                                                          | until deletion                                                                          | cascade                                                                | 1.5k / 15k / 150k    |
| `user_preferences`  | Units, time format, settings blob (sync entity)                                          | API                                        | API, sync                        | 1   | none                                                                                          | tombstoned, purged at 30 d                                                              | cascade                                                                | 1k / 10k / 100k      |
| `user_consents`     | Terms, privacy, marketing, email import consents                                         | API                                        | export, compliance               | 1   | none                                                                                          | until deletion                                                                          | cascade                                                                | 3k / 30k / 300k      |
| `user_sync_changes` | Change feed with `xid8` watermark for `GET /v1/sync`                                     | API (same tx as the row)                   | sync                             | 1   | none                                                                                          | 30 d                                                                                    | cascade                                                                | 20k / 200k / 2M      |
| `idempotency_keys`  | Replay store for mutating routes                                                         | idempotency middleware                     | idempotency middleware           | 1   | request hash                                                                                  | 24 h                                                                                    | cascade                                                                | hundreds / 5k / 50k  |
| `deleted_subjects`  | Pseudonymous record that a subject was deleted                                           | deletion route                             | auth middleware, webhooks, audit | 1   | Apple, Google and session subjects HMAC-SHA-256 under a Workers secret; RevenueCat id SHA-256 | `expires_at`: 400 d (provider subject), 31 d (session); purged by the increment 12 cron | kept (that is its job)                                                 | tens / hundreds / 1k |
| `sync_epoch`        | Database timeline every sync cursor names (one row, seeded 1; increment 8)               | restore runbook only                       | sync route                       | 0   | none                                                                                          | forever                                                                                 | n/a                                                                    | 1                    |
| `sync_horizon`      | Purge horizon H of both change tables (one row, null until the first purge; increment 8) | increment 12 purge (same tx as the delete) | sync route                       | 0   | none                                                                                          | forever                                                                                 | n/a                                                                    | 1                    |

### Reference

| Table                | Purpose                                                  | Writer               | Readers             | PII | Enc  | Retention | GDPR | Rows (all tiers) |
| -------------------- | -------------------------------------------------------- | -------------------- | ------------------- | --- | ---- | --------- | ---- | ---------------- |
| `airports`           | OurAirports subset with ICAO, IATA, coordinates, IANA tz | seed loader          | everything          | 0   | none | refreshed | n/a  | 6,341            |
| `airport_profiles`   | Curated terminal and transit notes                       | admin                | API                 | 0   | none | curated   | n/a  | tens             |
| `airlines`           | VRS spine plus OPTD alliance and validity                | seed loader          | API, key normaliser | 0   | none | refreshed | n/a  | 5,904            |
| `regional_operators` | Marketing block to operating carrier hint                | seed loader, BTS job | DesignatorResolver  | 0   | none | refreshed | n/a  | 23 hints         |
| `aircraft_types`     | ICAO designators with wake category                      | seed loader          | API, display        | 0   | none | refreshed | n/a  | 2,855            |
| `aircraft`           | Registration and hex with validity ranges                | future loader        | API                 | 0   | none | refreshed | n/a  | 0 in Phase 0     |
| `currency_rates`     | Daily FX pairs                                           | cron                 | API                 | 0   | none | 2 years   | n/a  | tens of k        |

### Flight core

| Table                    | Purpose                                                                             | Writer                                        | Readers                        | PII | Enc  | Retention                            | GDPR | Rows 1k / 10k / 100k |
| ------------------------ | ----------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------ | --- | ---- | ------------------------------------ | ---- | -------------------- |
| `flight_instances`       | Registry of every tracked flight; generated unique `flight_key`                     | persist consumer only                         | API, reconcile cron, sync join | 0   | none | finished rows kept 13 months         | n/a  | 12k / 120k / 1.2M    |
| `flight_instance_merges` | Audit of merged instances                                                           | persist consumer                              | admin                          | 0   | none | kept                                 | n/a  | tens / hundreds / 5k |
| `flight_designators`     | Marketing designator to instance                                                    | API (search), persist                         | search route                   | 0   | none | follows the instance                 | n/a  | 20k / 200k / 2M      |
| `flight_events`          | Append-only timeline per instance                                                   | persist consumer only                         | detail route, admin            | 0   | none | 90 d, then R2 and `timeline_summary` | n/a  | 120k / 1.2M / 12M    |
| `flight_sync_changes`    | Flight half of the sync feed: the snapshot each applied upsert stored (increment 8) | persist consumer only (same tx as the upsert) | sync route                     | 0   | none | 30 d                                 | n/a  | 120k / 1.2M / 12M    |
| `flight_tracks`          | Pointer to the archived track sample plus preview                                   | persist consumer                              | detail route                   | 0   | none | follows the instance                 | n/a  | 12k / 120k / 1.2M    |

### Trips and subscriptions

| Table                  | Purpose                                                 | Writer                   | Readers           | PII | Enc                                                                               | Retention                    | GDPR                          | Rows 1k / 10k / 100k |
| ---------------------- | ------------------------------------------------------- | ------------------------ | ----------------- | --- | --------------------------------------------------------------------------------- | ---------------------------- | ----------------------------- | -------------------- |
| `trips`                | Named groups of flights (sync entity)                   | API                      | API, sync         | 2   | none                                                                              | tombstoned, purged at 30 d   | cascade                       | 3k / 30k / 300k      |
| `trip_members`         | Shared trip membership and role (sync entity)           | API                      | API, sync         | 1   | none                                                                              | tombstoned, purged at 30 d   | cascade (both FKs)            | 4k / 40k / 400k      |
| `flight_subscriptions` | A user's flight with PNR, seat, overrides (sync entity) | API, import jobs         | API, sync, notify | 3   | `confirmation_code_enc`                                                           | tombstoned, purged at 30 d   | cascade                       | 12k / 120k / 1.2M    |
| `logbook_entries`      | Flown flights for stats (sync entity)                   | housekeeping, API        | stats, sync       | 2   | none                                                                              | tombstoned, purged at 30 d   | cascade                       | 12k / 120k / 1.2M    |
| `user_stats_yearly`    | Year-in-review aggregates                               | housekeeping             | API               | 1   | none                                                                              | until deletion               | cascade                       | 1k / 10k / 100k      |
| `usage_counters`       | Exact quotas per user, hashed email, salted-HMAC IP     | caps (`src/lib/caps.ts`) | caps              | 1   | email subjects SHA-256; IP subjects HMAC under a daily salt from a Workers secret | daily windows purged at 30 d | by subject (`scope = 'user'`) | 10k / 100k / 1M      |

### Providers and models

| Table                          | Purpose                                                                                    | Writer                                | Readers                      | PII | Enc  | Retention          | GDPR | Rows 1k / 10k / 100k   |
| ------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------- | ---------------------------- | --- | ---- | ------------------ | ---- | ---------------------- |
| `provider_calls`               | One row per provider call including LLM                                                    | persist consumer                      | admin, rollup                | 0   | none | 90 d               | kept | 400k / 4M / 40M        |
| `provider_call_daily`          | Durable daily series; `budget_daily*` rows are the ProviderBudget's own totals (section 6) | housekeeping rollup, persist consumer | admin, cost model            | 0   | none | kept               | kept | hundreds / 1k / 5k     |
| `provider_budget_config`       | Caps and kill switch per provider                                                          | admin                                 | ProviderBudget DO            | 0   | none | kept               | n/a  | 11                     |
| `provider_alert_registrations` | AeroAPI and ADB alert ids per flight                                                       | FlightTracker via persist             | reconcile, admin             | 0   | none | follows the flight | n/a  | 1k / 10k / 100k active |
| `provider_webhook_events`      | Raw webhook envelopes                                                                      | webhook routes                        | provider-events queue        | 0   | none | 30 d               | n/a  | 12k / 120k / 1.2M      |
| `delay_predictions`            | Model output per flight                                                                    | prediction job                        | API                          | 0   | none | 13 months          | n/a  | 24k / 240k / 2.4M      |
| `delay_outcomes`               | Ground truth per finished flight                                                           | housekeeping                          | model training               | 0   | none | kept               | n/a  | 12k / 120k / 1.2M      |
| `airport_wx_observations`      | METAR and TAF                                                                              | weather cron                          | API, model                   | 0   | none | 90 d               | n/a  | 500k at every tier     |
| `airport_nas_events`           | FAA ground stops and delay programs                                                        | NAS cron                              | API                          | 0   | none | 13 months          | n/a  | 20k at every tier      |
| `airport_delay_snapshots`      | Board-derived delay index                                                                  | airport sweep                         | hourly rollup                | 0   | none | 30 d               | n/a  | 300k at every tier     |
| `airport_delay_hourly`         | Hourly delay aggregates                                                                    | housekeeping                          | API, model                   | 0   | none | 13 months          | n/a  | 2M at every tier       |
| `bts_carrier_flight_monthly`   | BTS marketing and operating carrier per flight number                                      | BTS import                            | regional operator job, model | 0   | none | kept               | n/a  | 6M at every tier       |
| `bts_route_monthly`            | BTS route aggregates                                                                       | BTS import                            | model                        | 0   | none | kept               | n/a  | 1M at every tier       |
| `bts_airport_hourly`           | BTS airport hour-of-day aggregates                                                         | BTS import                            | model                        | 0   | none | kept               | n/a  | 500k at every tier     |
| `bts_import_runs`              | One row per month import with source hash                                                  | BTS import                            | admin                        | 0   | none | kept               | n/a  | 100                    |

### Notifications

| Table                      | Purpose                                          | Writer             | Readers      | PII | Enc                   | Retention                       | GDPR    | Rows 1k / 10k / 100k  |
| -------------------------- | ------------------------------------------------ | ------------------ | ------------ | --- | --------------------- | ------------------------------- | ------- | --------------------- |
| `notification_preferences` | Channels, quiet hours, per-event toggles (sync)  | API                | notify, sync | 1   | none                  | tombstoned, purged at 30 d      | cascade | 1k / 10k / 100k       |
| `push_tokens`              | APNs and FCM device tokens                       | `POST /v1/devices` | notify       | 1   | none (routing handle) | invalidated rows purged at 30 d | cascade | 1.5k / 15k / 150k     |
| `live_activities`          | ActivityKit activity per subscription per device | API                | notify       | 1   | none (routing handle) | ended rows purged at 7 d        | cascade | 500 / 5k / 50k active |
| `notifications`            | In-app inbox rows with dedupe key                | notify consumer    | API          | 2   | none                  | 90 d                            | cascade | 60k / 600k / 6M       |
| `notification_deliveries`  | Per-channel delivery evidence                    | notify consumer    | admin, abuse | 1   | none                  | 90 d                            | kept    | 60k / 600k / 6M       |

### Import, calendar, sharing

| Table                      | Purpose                                             | Writer              | Readers             | PII | Enc                                     | Retention                | GDPR    | Rows 1k / 10k / 100k |
| -------------------------- | --------------------------------------------------- | ------------------- | ------------------- | --- | --------------------------------------- | ------------------------ | ------- | -------------------- |
| `email_accounts`           | Connected mailboxes                                 | OAuth routes        | mailbox scan        | 3   | `access_token_enc`, `refresh_token_enc` | until revoked            | cascade | 200 / 2k / 20k       |
| `email_messages_processed` | Provider message ids only; never bodies             | mailbox scan        | mailbox scan        | 1   | none                                    | 13 months                | cascade | 50k / 500k / 5M      |
| `email_extractions`        | Structured extraction result and status             | extraction job      | API                 | 2   | none (itinerary data)                   | 90 d after applied       | cascade | 2k / 20k / 200k      |
| `inbound_addresses`        | Per-user forwarding address                         | API                 | inbound mail Worker | 1   | none (local part is the routing key)    | until revoked            | cascade | 1k / 10k / 100k      |
| `inbound_messages`         | Envelope of a forwarded message; body never stored  | inbound mail Worker | extraction job      | 2   | none                                    | 30 d                     | cascade | 2k / 20k / 200k      |
| `imports`                  | File import jobs                                    | API                 | imports queue       | 1   | none                                    | 30 d                     | cascade | 200 / 2k / 20k       |
| `import_rows`              | Parsed rows per import                              | imports queue       | API                 | 2   | none                                    | with the import          | cascade | 5k / 50k / 500k      |
| `calendar_connections`     | Connected calendars                                 | OAuth routes        | calendar job        | 3   | `access_token_enc`, `refresh_token_enc` | until revoked            | cascade | 200 / 2k / 20k       |
| `calendar_events`          | Events we wrote, for idempotent updates             | calendar job        | calendar job        | 1   | content hash                            | with the subscription    | cascade | 5k / 50k / 500k      |
| `ics_feed_tokens`          | Secret ICS feed URLs                                | API                 | ICS route           | 1   | `token_hash`                            | until revoked            | cascade | 300 / 3k / 30k       |
| `share_links`              | Public share links for a flight or trip             | API                 | share page          | 1   | `token_hash`                            | until revoked or expired | cascade | 1k / 10k / 100k      |
| `share_link_views`         | Abuse evidence for share pages                      | share page          | abuse review        | 1   | IP and UA hashed                        | 30 d                     | cascade | 10k / 100k / 1M      |
| `meet_me_sessions`         | Live-tracking sessions shared with a guest by token | API                 | guest page          | 1   | `token_hash`                            | until expired            | cascade | 300 / 3k / 30k       |

### Billing, API, GDPR

| Table                       | Purpose                                               | Writer             | Readers           | PII | Enc          | Retention      | GDPR    | Rows 1k / 10k / 100k |
| --------------------------- | ----------------------------------------------------- | ------------------ | ----------------- | --- | ------------ | -------------- | ------- | -------------------- |
| `entitlements`              | RevenueCat entitlement cache; random `rc_app_user_id` | RevenueCat webhook | API               | 1   | none         | until deletion | cascade | 1k / 10k / 100k      |
| `revenuecat_events`         | Raw webhook events                                    | webhook route      | billing job       | 1   | none         | kept           | kept    | 5k / 50k / 500k      |
| `subscriptions`             | Store subscription ledger                             | billing job        | finance           | 1   | none         | kept           | kept    | 300 / 3k / 30k       |
| `api_tokens`                | `pa_<kind>_` tokens with scopes                       | API                | auth middleware   | 1   | `token_hash` | until revoked  | cascade | 100 / 1k / 10k       |
| `audit_log`                 | Append-only, pseudonymous                             | every write path   | admin, compliance | 1   | IP hashed    | 2 years        | kept    | 50k / 500k / 5M      |
| `data_export_jobs`          | GDPR export jobs                                      | API, export queue  | API               | 1   | none         | 30 d           | cascade | tens / hundreds / 5k |
| `account_deletion_requests` | PII-free deletion request and step outcomes           | API, deletion job  | admin             | 1   | none         | kept           | kept    | tens / hundreds / 5k |

## 6. Invariants and natural keys

| Invariant                                                                                            | Enforced by                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One instance per operating carrier, number, origin-local date, origin ICAO and leg                   | `flight_instances.flight_key` STORED generated column, unique index `flight_instances_flight_key_key`                                                                                                                            |
| The flight key expression is frozen (drizzle-kit 0.31 would drop the column and lose the index)      | `FLIGHT_KEY_EXPRESSION` constant, `test/generated-column.test.ts`, `db:generate` no-diff test                                                                                                                                    |
| Flight number is normalised (no leading zeros, optional suffix); carrier is three upper-case letters | check constraints mirroring `FLIGHT_NUMBER_RE` and `ICAO_CARRIER_RE` in shared on `flight_instances`, `flight_designators`, `logbook_entries`, `bts_carrier_flight_monthly`                                                      |
| The generated key is exactly what shared parses                                                      | `test/generated-column.test.ts` asserts `FLIGHT_KEY_RE` and `FlightKeySchema` on edge-case tuples                                                                                                                                |
| A flight's airport code, airport row and zone describe one airport                                   | composite FKs `flight_instances_origin_airport_fk` and `_destination_airport_fk` on `airports (id, icao)`; `flight_instances_origin_tz_check`, `_destination_consistency_check`; writers use `resolveAirportEndpoint()`          |
| Every stored ICAO, IATA, Mode S hex and flight-number code is upper-case and well formed             | format checks on all 37 code columns; `test/schema-contracts.test.ts` fails on a code column without one                                                                                                                         |
| One notification per user per dedupe key (a fan-out reaches every subscriber once)                   | unique `(user_id, dedupe_key)`; a global key would let the first subscriber's row block the rest                                                                                                                                 |
| An alert registration's event set is a subset of shared `ALERT_EVENTS`                               | `provider_alert_registrations_events_check` (jsonb containment); the constraint list is exactly the shared list (increment 6 dropped `hold_start` and `hold_end` and regenerated migration 0000), asserted by the contracts test |
| A superseded instance always carries a reason and vice versa                                         | `flight_instances_superseded_consistency_check`                                                                                                                                                                                  |
| One live subscription per user per instance                                                          | partial unique `(user_id, flight_instance_id) where deleted_at is null`                                                                                                                                                          |
| A subscribed instance cannot be deleted from under the user                                          | `flight_subscriptions.flight_instance_id` ON DELETE RESTRICT                                                                                                                                                                     |
| One event per instance and sequence number (replays are no-ops)                                      | unique `(flight_instance_id, seq)`                                                                                                                                                                                               |
| One designator per marketing carrier, number, date, origin                                           | `flight_designators_designator_key`                                                                                                                                                                                              |
| Email is unique case-insensitively                                                                   | unique index on `lower(email)`                                                                                                                                                                                                   |
| Session token, API token hash, share token hash, ICS token hash, meet-me token hash are unique       | unique indexes                                                                                                                                                                                                                   |
| Every airport has a timezone; the seed fails rather than guesses                                     | `airports.tz NOT NULL`, `MissingTimezoneError` in the loader                                                                                                                                                                     |
| Real ICAO codes are four characters; ident-derived pseudo codes are marked                           | `airports_icao_format_check` keyed on `icao_source`                                                                                                                                                                              |
| Sync entity set equals `SYNC_ENTITIES` in shared                                                     | `user_sync_changes_entity_check`, contracts test                                                                                                                                                                                 |
| Regional operator blocks do not overlap on the same key                                              | unique `(marketing_iata, number_from, number_to)`; overlap is a loader-time check to add with the BTS job                                                                                                                        |

Natural keys used for idempotent upserts by the seed loaders: `airports.icao`, `airlines.icao`,
`aircraft_types.icao`, `regional_operators (marketing_iata, number_from, number_to)`.

- `flight_instances.version` is the monotonic snapshot version the FlightTracker sets; the persist
  consumer applies an upsert only when the incoming version is greater than the stored one, so
  at-least-once and out-of-order queue delivery can never move a row backwards (increment 7).
- `flight_instances.operator_source` records how the operating carrier in the key was decided
  (`provider`, `callsign`, `hint`, `marketing`); AeroDataBox never returns an operator, so the key
  carries the best-known operator at creation and the Phase 1 merge path reconciles (ADR 0010).
- `flight_instances.do_lifetime_epoch_ms` (migration 0002, increment 7) names the FlightTracker
  LIFETIME the row was last written from: the object's `created_at_ms`, the `@{epochMs}` every
  outbox origin carries. The persist consumer ignores instance and event rows from an older
  lifetime and refuses a newer lifetime for a row whose tracking state is terminal (`finished`,
  `archived`, `superseded`) with the `flight_lifetime_rejected` ops alert: a finished flight
  never gets a second lifetime, and the R2 events archive is keyed per lifetime
  (`events/{flight_key}@{epochMs}.json`, never overwritten). Null on rows written before the
  column existed. Migration 0002 also recreates the `flight_instances_set_updated_at` trigger
  with the new column in its WHEN clause (section 12).
- `provider_call_daily` rows with operation `budget_daily` (unsharded) or `budget_daily:{n}`
  (one per ProviderBudget shard, `n` 0 to 7) are the budget object's OWN daily totals for the
  day and provider, written by the persist consumer with replace semantics from the object's
  final snapshot; they are not a provider operation. The increment 12 roll-up of
  `provider_calls` fills the per-operation rows next to them and MUST exclude every operation
  starting with `budget_daily` from per-operation sums, and must never sum the shard rows into
  one (at-least-once delivery would count a redelivery twice; the per-shard rows are exact).
- `flight_instances (origin_airport_id, origin_icao, origin_tz)` references
  `airports (id, icao, tz)`, so a resolved origin cannot disagree with the airport row on code or
  zone; the zone is what decides the origin-local date inside the frozen key.

### Sync feed and caps (increment 8)

| Invariant                                                                                         | Enforced by                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A change row is written in the same transaction as the entity write it records, on one connection | `appendUserChange` inside every route's `db.transaction()`, inside `mergeUsers` (moves, tombstones, singleton winners and losers, ruling O2) and inside the persist consumer's upsert transaction (its `live_tracked` decisions, ruling O3); the upsert and its `flight_sync_changes` insert share `db.transaction()`; `test/workers/sync.test.ts`, `flights.subscribe.test.ts` (compensation path leaves no change row), `merge.sync.test.ts`, `live-tracked.test.ts` |
| A change row is never updated or upserted (its `xid` DEFAULT would not fire on `DO UPDATE`)       | insert-only writers; no update path exists in `src/`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A replayed or stale `flight_instances` delivery adds no `flight_sync_changes` row                 | the insert runs only when the monotonic upsert's `RETURNING` answered; `sync.test.ts` replays one version and delivers an older one                                                                                                                                                                                                                                                                                                                                    |
| One `(xid, seq)` pair names at most one row across the two change tables                          | both tables draw `seq` from `user_sync_changes_seq_seq` (`flight_sync_changes.seq` defaults to it, migration 0003), because the persist consumer writes both in one transaction; ADR 0012 item 3                                                                                                                                                                                                                                                                       |
| The feed never serves a row at or above the watermark                                             | `xid < pg_snapshot_xmin(pg_current_snapshot())` in both page queries; `sync.late-commit.test.ts`                                                                                                                                                                                                                                                                                                                                                                       |
| The page predicate is carried by the index                                                        | `user_sync_changes_user_id_xid_seq_idx` (Index Cond includes the ROW comparison, EXPLAIN in `sync.test.ts`); `flight_sync_changes_flight_instance_id_xid_seq_idx`                                                                                                                                                                                                                                                                                                      |
| A cap take is one statement and the counter row is the serialization point                        | `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < cap RETURNING` in `src/lib/caps.ts`; `caps.concurrency.test.ts` (20 concurrent subscribes, exactly 5 succeed)                                                                                                                                                                                                                                                                                                      |
| A counter never goes below zero                                                                   | `usage_counters_count_check`; releases update `where count > 0`                                                                                                                                                                                                                                                                                                                                                                                                        |
| Only the increment 8 counter names, and `refresh:{flightKey}`, are stored                         | `usage_counters_counter_check` (migration 0003)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| A subscription that took a `live_tracked` slot releases exactly that slot                         | `flight_subscriptions.live_tracked` (migration 0003): set at subscribe (flight already live) or by the persist consumer at window entry; cleared, with its slot, by the unsubscribe, by the consumer when the flight is over, and by the merge for a tombstoned loser                                                                                                                                                                                                  |
| A cursor from another principal or database timeline is never served                              | the cursor's `hash8` (SHA-256 of the user id) and `epoch` (`sync_epoch`, migration 0003) are checked before the page; 410 `resync_required`; `sync.test.ts`                                                                                                                                                                                                                                                                                                            |
| A cursor below the purge horizon is never served as complete                                      | `sync_horizon` (one row, migration 0003) written by the purge in the transaction that deletes `xid < H` from both tables, read by the route after the page; `sync.late-commit.test.ts` (the seq/xid inversion)                                                                                                                                                                                                                                                         |
| A `deleted_subjects` hash is keyed and namespaced                                                 | `deleted_subjects_provider_subject_hash_check` (`apple:`, `google:` or `session:` plus 43 base64url characters)                                                                                                                                                                                                                                                                                                                                                        |
| A subscribe never removes a tracker subscriber that another request recorded                      | after a lost deadline the only unsubscribe is for a caller whose `users` row no longer exists (monotonic: no request can record a subscriber after the deletion); the in-request compensation runs under the idempotency in-flight lease; `flights.subscribe.test.ts` (the timed-out call and its retry parked on one in-flight fetch; a late landing after a deletion, and after a retry)                                                                             |

- **Two change tables, one watermark (ADR 0012).** `user_sync_changes` (a user's entities) and
  `flight_sync_changes` (a flight's snapshot, written once per applied upsert however many users
  follow the flight) share one predicate,
  `xid < pg_snapshot_xmin(pg_current_snapshot()) and (xid, seq) > ($1::xid8, $2::bigint)`,
  ordered by `(xid, seq)`. The watermark rule is the whole
  safety argument: everything below `xmin` is committed or dead, so a transaction that took its
  xid early and committed late is replayed on a later pull instead of skipped. A page is 200 rows,
  server-enforced; the cursor is `base64url("<xid8>:<seq>:<epoch>:<hash8>")` (ruling O12),
  position strings only, and a drained page answers `(watermark, 0)`. The two tables share one
  `seq` sequence because the persist consumer writes both in one transaction (its `live_tracked`
  decisions, ruling O3).
- **`deleted_at` is not the delete mechanism** (facts sheet, PLAN CONFLICT low). The feed's delete
  is a change row with `op = 'delete'` carrying the tombstoned row. `deleted_at` stays on the sync
  entities for the partial unique index on `flight_subscriptions (user_id, flight_instance_id)`
  (`where deleted_at is null`), for last-writer-wins on the client, and so a re-subscribe RESTORES the
  tombstoned row (same id) rather than inserting a second one.
- **The watermark is cluster-global.** One long writing transaction anywhere freezes every user's
  feed; the guards are `statement_timeout` and `idle_in_transaction_session_timeout` on the app
  role (section 12) and the watermark-lag metric on the admin page (increment 12).
- **Retention and 410 (ruling O9).** Both change tables keep 30 days. The increment 12 purge picks
  ONE horizon H below the watermark and, in ONE transaction, deletes `where xid < H` from BOTH
  tables and writes H to `sync_horizon.horizon_xid`; `GET /v1/sync` answers 410
  `resync_required` exactly when a cursor's xid is below H (and to a cursor from another principal
  or `sync_epoch`, or beyond `pg_snapshot_xmax`). A purge in `seq` order is NOT an exact horizon
  (an earlier version of this section said it was): a row's xid is fixed at its transaction's
  first write and its seq at the change-row insert, so seq order and xid order disagree across
  concurrent transactions, and "the oldest retained row" would both miss a skipped row and move
  forward when an account deletion removes the globally oldest rows.
- **Restore runbook (ruling O12).** After ANY point-in-time restore or branch reset of an
  environment's database, before traffic returns:
  `UPDATE sync_epoch SET epoch = epoch + 1, bumped_at = now() WHERE id = 1`. A restored cluster
  reuses the xids the lost timeline had issued, so without the bump a cursor from that timeline is
  judged fresh once the new timeline passes it and every new-timeline row at or below it is
  skipped; with it, every such cursor answers 410 and its device re-snapshots.
- **Hyperdrive query caching stays disabled on `DB`** (ADR 0012 item 7): a correctness
  requirement of the no-cursor snapshot page, checked by the increment 12 first-deploy runbook.
- **Caps are counters, reconciled nightly.** `active_subscriptions` (window at the epoch) goes up
  at subscribe and down at unsubscribe. `live_tracked` (window at the epoch, ruling O3) is taken
  where a flight actually ENTERS its live window: at subscribe for a flight already inside it,
  otherwise by the persist consumer on the first instance row that puts the flight inside it
  (scheduled departure within 48 h, or departed), for each live subscription not yet flagged, in
  the upsert's transaction; a take the cap refuses leaves `live_tracked = false` (the shared
  tracker still tracks the flight; in Phase 0 the flag only records, from Phase 1 it gates
  notifications and the Live Activity) and appends the row's upsert to the feed so the client can
  show it. It is released where the flight is OVER (arrived, cancelled, or a terminal tracking
  state: the consumer clears the flags and decrements, never below zero, idempotent through the
  flag) and at unsubscribe. `instances_created`, `tracker_creations` and `refresh:{flightKey}`
  (window the UTC day) only go up; the refresh sub-budget is charged per call, coalesced or not.
  The merge sums the two users' counters and then gives a tombstoned loser's slots back. A crash
  between a take and its compensating release, or a subscribe that commits just after the
  consumer's window-entry pass, leaves drift, which the increment 12 housekeeping reconciliation
  repairs against `flight_subscriptions` (not built in increment 8).
- **The anonymous-to-account merge (ruling O2).** `mergeUsers` writes, under the account, an
  upsert for every subscription it moves, a delete for every conflict loser it tombstones and an
  upsert or delete for every singleton (`user_preferences`, `notification_preferences`) winner or
  loser, in its own transaction; the anonymous user's feed gets nothing (its sessions die in that
  transaction and its cursor, bound to it, answers 410 under the new session). The persist
  queue's `merge` consumer re-points the FlightTracker subscriber lists with the trackers'
  existing `subscribe` and `unsubscribe` RPCs.
- **The tracker's subscriber list follows Postgres (ruling O13, settled by the re-reviews).**
  `flight_subscriptions` is the record; a tracker's list is only ever repaired toward it, and the
  two errors are not symmetric. A STRAY subscriber (no live row) costs little in Phase 0: the
  shared tracker polls the flight for its other subscribers regardless, and every list the user
  sees is Postgres'. A WRONG unsubscribe loses a real subscription until the user subscribes again,
  which the app (already subscribed) never prompts. The safety net for every stray is the increment
  12 tracker-subscriber reconciliation, a housekeeping pass that lists each active tracker's
  subscribers and unsubscribes every id with no live `flight_subscriptions` row. So
  `POST /v1/flights` compensates inside the request whose tracker call answered `subscribed` and
  whose transaction then failed, where the idempotency in-flight lease still blocks a same-key
  retry, so nothing can race it. After a LOST DEADLINE the route answers 504, and whether a live
  row exists when the late call lands decides nothing: the tracker's `subscribe` joins a provider
  fetch in flight, so the timed-out call and the outbox's retry (same key, same id) park on the
  same fetch and resume back to back (`subscribed`, then `already`), and such a check would run
  before the retry's transaction commits, see no row, and remove the subscriber the retry answered
  201 for. The one check it makes is monotonic: when the late call lands `subscribed` and the
  caller's `users` row no longer exists, the subscriber is removed. A deleted user never comes
  back, and every retry after the deletion answers 401 or fails 23503 at its insert, so no request
  can have recorded it; a merge keeps the anonymous row (marked `deleting`) until increment 12
  housekeeping, long after any `waitUntil` has run. While the row exists nothing is undone, and a
  deletion that commits after the check leaves a stray for the reconciliation. Every answer that
  says "already subscribed" re-sends the idempotent `subscribe` for the live row, so a retry
  repairs drift in the other direction.

## 7. Write-path ownership

| Table group                                                                                                                      | Only writer                                                                                   | Everyone else                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `flight_instances`, `flight_events`, `flight_tracks`, `flight_instance_merges`, `provider_calls`, `provider_alert_registrations` | persist queue consumer (ADR 0007)                                                             | read only; the search route upserts `flight_designators` and the registry row's key columns on first sight                               |
| Better Auth tables                                                                                                               | Better Auth through the Drizzle adapter, plus the Apple native route for `refresh_token_enc`  | read only; the deletion job deletes `rate_limits` rows whose key embeds the user's email and `verifications` rows whose identifier is it |
| Sync entities                                                                                                                    | API request handlers and `mergeUsers`, in the same transaction as the `user_sync_changes` row | read only; the persist consumer sets `flight_subscriptions.live_tracked` with its change row                                             |
| Reference tables                                                                                                                 | seed loaders and the BTS import                                                               | read only                                                                                                                                |
| `usage_counters`, `idempotency_keys`, `rate_limits`                                                                              | middleware                                                                                    | read only                                                                                                                                |
| `audit_log`                                                                                                                      | every write path appends; nothing updates or deletes before the retention cron                | append only                                                                                                                              |
| `notification_deliveries`                                                                                                        | notify consumer                                                                               | append only                                                                                                                              |

Durable Objects never write Postgres (ADR 0007).

Two rules the flight writers must keep:

- **One airport lookup.** `origin_icao`, `origin_airport_id` and `origin_tz` (and the
  destination pair) come from a single `resolveAirportEndpoint()` call
  (`originColumns()` / `destinationColumns()` in `@planeahead/db`), never from separate
  provider fields. The composite foreign keys reject a code that does not belong to the airport
  row, and `flight_instances_origin_tz_check` rejects a known airport without its zone, so a
  mismatch cannot be frozen into the key or the FlightTracker name.
- **Replays are silent.** The persist queue is at-least-once. Every `set_updated_at` trigger
  skips a no-op UPDATE, so a byte-identical replayed upsert leaves `updated_at` alone and the
  sync join (query 11) sees no phantom change; `test/trigger.test.ts` replays one upsert six
  times to prove it. The consumer does not need a guard of its own for this, but it must not
  write differing values on a replay (a fresh `now()` in the SET list would defeat the clause).

Increment 8 adds three writers to the table above, each in its entity's transaction:
`user_sync_changes` (the routes, with the entity), `flight_sync_changes` (the persist consumer,
with the upsert), and the `flight_instances` registry row's five key columns (the subscribe and
search routes, `insert ... on conflict (flight_key) do nothing`, because a subscription needs the
row before the persist consumer's first write lands; every tracked column stays the consumer's).
`deleted_subjects` and the deletion `audit_log` row are written by `POST /v1/me/delete`. The two
one-row tables of the sync contract have one writer each and no route writes them: `sync_horizon`
the increment 12 purge (in the purge's transaction), `sync_epoch` the restore runbook.

### Account deletion (`POST /v1/me/delete`, increment 8)

Better Auth's `deleteUser` stays disabled. The order: read (subscriptions, the Apple refresh token
decrypted while its DEK exists, provider subjects, session tokens), no transaction held; unsubscribe
every FlightTracker (idempotent, failures logged); Apple `/auth/revoke` best effort (TN3194), the
outcome to `audit_log`; then ONE short transaction of ordered DELETE statements, leaf to root
(`DELETION_ORDER` in `apps/api/src/lib/account-deletion.ts`), never a single multi-CTE statement,
followed by the `deleted_subjects` rows, the `audit_log` row, and `delete from users`. Every table
with a foreign key to `users` is emptied explicitly; the `ON DELETE CASCADE` keys are a safety net,
not the mechanism. `test/workers/me.delete.test.ts` compares this list with every foreign key the
catalog reports and asserts no row names the user afterwards.

After the commit (ruling O14), every subscription the `flight_subscriptions` statement deleted
(`RETURNING id, flight_instance_id`) that the step 2 read did not list is unsubscribed from its
tracker, best effort: another device's subscribe still authenticates until the sessions die in
step 4, so it can commit between the read and the delete, and would otherwise leave the deleted
user's id in a tracker for the flight's lifetime (`me.delete.test.ts` races one).

The transaction's FIRST statement is `select 1 from users where id = $1 for update` (re-review).
A subscribe's INSERT holds FOR KEY SHARE on the user row (its foreign-key check) until it commits,
and FOR UPDATE conflicts with it, so the lock waits for every subscribe that has already inserted,
and the `flight_subscriptions` DELETE that follows, a fresh READ COMMITTED snapshot, returns that
row for the post-commit unsubscribe; a subscribe that inserts after the lock waits at its
foreign-key check until step 4 commits, then fails 23503, and the route's own compensation
unsubscribes it. Without the lock the same wait happened at `delete from users`, the LAST
statement, which then cascaded the freshly committed row past the RETURNING: the audit row said
`late_subscriptions: 0` and the tracker kept the deleted user (`me.delete.test.ts` holds a
subscribe open until the lock is seen waiting on it). A lock that finds no row means a concurrent
deletion finished first; the transaction does nothing and the route answers 401 `account_deleted`,
as for a replay.

That lock order IS inverted against every writer that locks one of the user's rows and then
appends a change row (final re-review): `DELETE /v1/flights/:id` (the row FOR UPDATE, then the
tombstone and its `user_sync_changes` row), the subscribe restore path (the tombstone FOR UPDATE,
then its change row), `PATCH /v1/me/preferences` on an existing row, the persist consumer's
`live_tracked` pass and `mergeUsers`. The change row's foreign-key check needs FOR KEY SHARE on the
user row, which the deletion holds FOR UPDATE, while the deletion's DELETE waits for the row the
writer holds. Postgres would break the deadlock after `deadlock_timeout` (1 s) by aborting, with
40P01, the waiter whose timeout runs out first, and in natural timing that is the writer (the
deletion runs some twenty leaf deletes before it reaches the writer's table, so the writer's
foreign-key wait starts first; the final re-review's 108 unforced trials aborted the writer in all
17 natural deadlocks). The deletion is therefore made the side that always loses: right after the
lock it runs `set local lock_timeout = '300ms'` (a user-settable parameter, unlike
`deadlock_timeout`), a statement that meets a held row gives up with 55P03 before the writer's timer
fires, the writer commits, and the transaction is retried: up to three attempts on 55P03, 40P01 or
40001, after a short jittered pause (`scheduler.wait`). The writers take no root-first lock. The
transaction is fast and idempotent (an aborted attempt leaves nothing behind), and the retry's
`delete ... returning` names the row the surviving writer committed, so the post-commit unsubscribe
still sees it; the audit row and the deletion report count the retries (`transaction_retries`).
The trade-off is a writer that holds a leaf row for longer than about three lock timeouts, which
fails the deletion (500, the client retries). `me.delete.test.ts` holds a `DELETE /v1/flights/:id`
inside its row lock until the deletion waits on it, and asserts one retry, no row and no subscriber
left.

Once `trips` get writers, step 4 must also append change rows for OTHER users' entities it
changes: a delete for every `trip_members` row of the user's trips (the members' feeds), and an
upsert for every other user's `flight_subscriptions` row whose `trip_id` the trip delete sets to
null (`ON DELETE SET NULL`). Phase 0 has no trip, so no such row exists today.

| Table                                   | How the user's rows go                                      | Note                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `import_rows`                           | explicit statement (`user_id`)                              | before `imports`                                                                                                                          |
| `imports`                               | explicit statement                                          |                                                                                                                                           |
| `email_extractions`                     | explicit statement                                          |                                                                                                                                           |
| `email_messages_processed`              | explicit statement                                          | before `email_accounts`                                                                                                                   |
| `email_accounts`                        | explicit statement                                          |                                                                                                                                           |
| `inbound_messages`                      | explicit statement                                          | before `inbound_addresses`                                                                                                                |
| `inbound_addresses`                     | explicit statement                                          |                                                                                                                                           |
| `calendar_events`                       | explicit statement                                          | before `calendar_connections`                                                                                                             |
| `calendar_connections`                  | explicit statement                                          |                                                                                                                                           |
| `ics_feed_tokens`                       | explicit statement                                          |                                                                                                                                           |
| `share_link_views`                      | cascade from `share_links`                                  | no user column                                                                                                                            |
| `share_links`                           | explicit statement                                          |                                                                                                                                           |
| `meet_me_sessions`                      | explicit statement                                          |                                                                                                                                           |
| `live_activities`                       | explicit statement                                          | before `devices`                                                                                                                          |
| `push_tokens`                           | explicit statement                                          | before `devices`                                                                                                                          |
| `notifications`                         | explicit statement                                          |                                                                                                                                           |
| `notification_preferences`              | explicit statement                                          |                                                                                                                                           |
| `logbook_entries`                       | explicit statement                                          |                                                                                                                                           |
| `user_stats_yearly`                     | explicit statement                                          |                                                                                                                                           |
| `flight_subscriptions`                  | explicit statement                                          | tombstones included; the instance side is RESTRICT and untouched                                                                          |
| `trip_members`                          | explicit statement                                          | the user as a member, and every member of the user's own trips                                                                            |
| `trips`                                 | explicit statement                                          |                                                                                                                                           |
| `entitlements`                          | explicit statement                                          |                                                                                                                                           |
| `api_tokens`                            | explicit statement                                          |                                                                                                                                           |
| `data_export_jobs`                      | explicit statement                                          |                                                                                                                                           |
| `idempotency_keys`                      | explicit statement                                          |                                                                                                                                           |
| `user_sync_changes`                     | explicit statement (`user_id`)                              | ruling K8                                                                                                                                 |
| `user_consents`                         | explicit statement                                          |                                                                                                                                           |
| `user_preferences`                      | explicit statement                                          |                                                                                                                                           |
| `devices`                               | explicit statement                                          |                                                                                                                                           |
| `user_keys`                             | explicit statement                                          | the DEK: every ciphertext of the user is unreadable from here                                                                             |
| `accounts`                              | explicit statement                                          |                                                                                                                                           |
| `sessions`                              | explicit statement                                          | revokes every session                                                                                                                     |
| `usage_counters`                        | explicit statement (`scope = 'user' and subject = user id`) | no FK                                                                                                                                     |
| `usage_counters` (magic link)           | explicit statement (`scope = 'email'`, subject prefix)      | no FK; the ceiling and owner counters start with the SHA-256 of the canonical mailbox, an unkeyed hash reversible by dictionary           |
| `verifications`                         | explicit statement (identifier or value names the email)    | no FK; not for an anonymous user                                                                                                          |
| `rate_limits`                           | explicit statement (key embeds the email)                   | no FK; IP rows age out                                                                                                                    |
| `users`                                 | explicit statement, last                                    | locked `FOR UPDATE` first: a subscribe that inserted is waited for (its row RETURNED); `lock_timeout` 300 ms then retries the transaction |
| `audit_log`                             | survives                                                    | pseudonymous `subject_id`; the deletion appends its own row                                                                               |
| `notification_deliveries`               | survives                                                    | pseudonymous `subject_id`                                                                                                                 |
| `revenuecat_events`                     | survives                                                    | keyed by RevenueCat's random app user id                                                                                                  |
| `subscriptions`                         | survives                                                    | finance ledger, pseudonymous                                                                                                              |
| `provider_calls`, `provider_call_daily` | survive                                                     | no user linkage                                                                                                                           |
| `deleted_subjects`                      | survives                                                    | written by the deletion; HMAC-SHA-256 subjects; purged at `expires_at`                                                                    |
| `account_deletion_requests`             | not written in Phase 0                                      | the synchronous path needs no request row; written once deletion becomes a queued job (Phases 5 to 7)                                     |

The disclosure that follows: deleted immediately from the live database; encrypted change history
(Neon's history window, set to 1 day explicitly) retained up to 24 hours.

## 8. Top-20 query catalog

| #   | Query                                                                     | Serving index                                                                                                   |
| --- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Find the instance for a flight key                                        | `flight_instances_flight_key_key`                                                                               |
| 2   | Search by marketing designator and date                                   | `flight_designators_designator_key`, `flight_designators_iata_lookup_idx`                                       |
| 3   | Reconcile: active trackers whose refresh is overdue                       | `flight_instances_tracking_state_next_refresh_at_idx` (partial)                                                 |
| 4   | Departures board by origin and date                                       | `flight_instances_origin_airport_date_idx`                                                                      |
| 5   | Arrivals board by destination and date                                    | `flight_instances_destination_airport_date_idx`                                                                 |
| 6   | Airborne instance for a Mode S hex                                        | `flight_instances_icao_hex_idx` (partial)                                                                       |
| 7   | Instance for an AeroAPI `fa_flight_id`                                    | `flight_instances_aeroapi_fa_flight_id_idx` (partial)                                                           |
| 8   | A user's live subscriptions                                               | `flight_subscriptions_user_id_flight_instance_id_key` (partial), `flight_subscriptions_user_id_updated_at_idx`  |
| 9   | Subscribers of an instance (fan-out for notify)                           | `flight_subscriptions_flight_instance_id_idx` (partial)                                                         |
| 10  | Sync feed: changes for a user after a cursor                              | `user_sync_changes_user_id_xid_seq_idx`                                                                         |
| 11  | Sync join: instances updated after a timestamp for a user's subscriptions | 8 plus `flight_instances_pkey`; `updated_at` filter on the joined rows (moves only on a real change, section 7) |
| 12  | Event timeline for an instance                                            | `flight_events_flight_instance_id_seq_key`                                                                      |
| 13  | Provider calls for an instance (admin)                                    | `provider_calls_flight_instance_id_created_at_idx`                                                              |
| 14  | Provider calls per provider per day (admin, rollup)                       | `provider_calls_provider_created_at_idx`, `provider_call_daily_day_provider_operation_result_key`               |
| 15  | Session lookup by token                                                   | `sessions_token_key`                                                                                            |
| 16  | User by email (sign-in, magic link)                                       | `users_email_key`                                                                                               |
| 17  | API token by hash                                                         | `api_tokens_token_hash_key`                                                                                     |
| 18  | Share link by hash                                                        | `share_links_token_hash_key`                                                                                    |
| 19  | Inbox for a user, newest first                                            | `notifications_user_id_created_at_idx`                                                                          |
| 20  | Latest METAR for an airport                                               | `airport_wx_observations_icao_kind_observed_at_key`                                                             |

Retention purges (`flight_events`, `provider_calls`, `airport_wx_observations`,
`notification_deliveries`, `audit_log`) scan by `created_at` through the BRIN indexes;
`sessions` purges by `sessions_expires_at_idx`, `verifications` by
`verifications_expires_at_idx`, `rate_limits` by `rate_limits_last_request_idx`.

## 9. Durable Object schemas, outbox and migration runner

Owned by increment 7; summarised here so the boundary is visible. Each class runs the
migrations-table runner (`_sql_schema_migrations`; `PRAGMA user_version` is not available in
Durable Object SQLite) in its constructor under `blockConcurrencyWhile`. FlightTracker tables
(migration 001): `flight`, `subscribers`, `events`, `positions`, `budget`, `attempts`,
`user_refresh`, `outbox`, `notif_dedupe`, `alert_registrations`, `kv_debounce`. DesignatorResolver
tables: `resolution`, `outbox` (001), `flush_state` and `resolution.tracker` (002). The outbox is
the only path from an object to Postgres: rows are sent to the `persist` queue and the consumer
upserts `flight_instances` (monotonic on `version` within a lifetime, lifetime-aware on
`do_lifetime_epoch_ms`), `flight_events` (`on conflict (flight_instance_id, seq) do nothing`)
and `provider_calls` (`on conflict (id) do nothing`), and writes `provider_call_daily` from the
ProviderBudget's daily row. Outbox rows are deleted only on confirmation (the tracker) or once
sent (the resolver); neither object ever `deleteAll()`s an unsent or unconfirmed row (ADR 0011).
DO schema changes are additive only for one release, because a new Worker version can call an
old object during gradual rollout.

## 10. KV and R2 catalogs

KV (all TTLs in seconds): `wx:metar:{ICAO}` 600, `wx:taf:{ICAO}` 1800, `nas:airport:{IATA}` 120,
`airport:delay:{ICAO}` 300, `board:{ICAO}:{dep|arr}:{YYYYMMDDHH}` 300,
`search:number:{XX1234}:{YYYY-MM-DD}` 900, `flight:snapshot:{flight_key}` 180,
`ref:airport:{ICAO}` 86400, `budget:day:{date}:{provider}` 172800,
`share:page:{sha256(token)[0:32]}` 60, `cfg:flags`. Never auth, entitlements, idempotency or
rate limits.

R2: public `airlines/logos/{ICAO}.svg`, `share/cards/{YYYY}/{MM}/{id}.png` (30 d),
`og/{random_id}.png` (7 d); private `exports/{user_id}/{job_id}.zip` (7 d),
`imports/{user_id}/{import_id}/...` (30 d), `tracks/{YYYY}/{MM}/{flight_key}.jsonl.gz` (365 d),
`events/{flight_key}@{epochMs}.json` (a finished FlightTracker's timeline, one object per tracker
lifetime, written with `onlyIf: { etagDoesNotMatch: '*' }` so it is never overwritten; increment
7 replaced the planned `events/{YYYY}/{MM}/{flight_key}.jsonl.gz`), `dlq/{queue}/{messageId}.json`
(a dead letter message's raw body), `bts/raw/...` (kept).

## 11. Connection budget

Sources: `docs/increments/03-db-schema.facts.md` section 5.

- Neon reserves 7 connections for its own use. Usable application connections: **97 at 0.25 CU**
  (limit 104) and **202 at 0.5 CU** (limit 209).
- Hyperdrive opens roughly **100 origin connections per configuration** on Workers Paid; the
  limit is soft and may be exceeded. Configurable per configuration with
  `--origin-connection-limit` (floor 5); the default when unset is undocumented.
- Consequence: at 0.25 CU the soft Hyperdrive ceiling exceeds what Neon will accept. Production
  runs at **0.5 CU** and every environment sets `origin_connection_limit` explicitly in
  increment 4 (80 for dev and staging), so Neon never sees more than it can serve.
- Per Worker invocation, at most six connections may wait for response headers at once, which
  is why `withDb` uses `max: 5`.
- The API Worker and the queue consumers are the only holders of Hyperdrive connections (ADR
  0007). Migrations, drizzle-kit, seeds and tests use their own `DATABASE_URL` client, at most
  one connection each, against the direct endpoint.

## 12. Migration policy

- **Tooling.** `pnpm --filter @planeahead/db db:generate` (drizzle-kit 0.31.10) writes SQL and
  a snapshot; `db:check` verifies the snapshots; `db:migrate` runs `src/migrate.ts`. Acceptance
  for every increment: `db:generate` emits nothing and `db:check` is clean, both asserted by
  `test/generated-column.test.ts`.
- **Expand and contract.** Add the column or table, deploy code that writes both, backfill,
  switch reads, drop the old shape in a later migration. Never rename a column in place.
- **Migration path.** Migrations run only over `DATABASE_URL` against the Neon **direct**
  endpoint. `migrateDatabase()` refuses any host containing `-pooler`, refuses non-Postgres
  URLs, asserts `server_version_num >= 180000` before touching the schema, and holds a session
  advisory lock (`MIGRATION_LOCK_KEY`) so two deploy jobs cannot interleave. Never through the
  Hyperdrive binding: transaction-mode pooling and the 60 s statement cap are wrong for DDL.
- **`statement_timeout`.** Hyperdrive pools in transaction mode and resets connections on
  return, so a per-request `SET statement_timeout` does not stick and Neon's pooler would reject
  it anyway. The timeout is set once per environment with
  `ALTER ROLE <role> SET statement_timeout = '10s'` as an environment setup step (verify on the
  dev branch: `SELECT context FROM pg_settings WHERE name = 'statement_timeout'` must be `user`,
  then reconnect and `SHOW statement_timeout`), never per request and never inside a migration.
- **`idle_in_transaction_session_timeout`** (increment 8, ADR 0012). The sync watermark is
  cluster-global, so one session idle inside a writing transaction freezes `GET /v1/sync` for every
  user. Set once per environment, next to `statement_timeout`, with
  `ALTER ROLE <role> SET idle_in_transaction_session_timeout = '30s'`, and watch the watermark
  lag on the admin page.
- **Session `TimeZone`.** Set the same way, once per environment:
  `ALTER ROLE <role> SET TimeZone = 'UTC'`. Drizzle reads are normalised whatever the zone
  (principle 2) and writes must carry a zone designator, but raw SQL text and console output
  should render `+00` everywhere. CI sets `TZ=UTC` on the `postgres:18` service container, the
  embedded harness passes `-c timezone=UTC`, and `test/globalSetup.ts` refuses any target whose
  session offset is not zero with a message naming this rule, so a drifted Neon branch fails
  with a diagnosis rather than a string mismatch.
- **Check constraints (spike D6, drizzle-kit 0.31.10).** Changing a `check()` expression emits
  `ALTER TABLE ... DROP CONSTRAINT "<name>"` followed by
  `ALTER TABLE ... ADD CONSTRAINT "<name>" CHECK (...)` in a new migration. It is not a silent
  no-op, so no `db:check-constraints` drift script is needed. Adding an enumeration value is
  therefore a normal migration; the ADD CONSTRAINT validates existing rows, so remove values
  only after the data is migrated.
- **Generated columns.** `flight_instances.flight_key` is frozen. drizzle-kit 0.31 drops and
  recreates a changed generated column and does not recreate the indexes Postgres cascades
  away (drizzle-orm issue 4929). If the expression ever has to change, write the migration by
  hand: add the new column, backfill, create the unique index, swap. The expression uses
  `extract`/`lpad` rather than `date::text` because Postgres rejects the text cast of a date
  as not immutable in a generated column (verified on PG 18.4).
- **Custom migrations.** `drizzle-kit generate --custom --name <name>` creates the empty file
  and journal entry; the SQL goes in by hand with `--> statement-breakpoint` between statements
  and never inside a dollar-quoted body or a comment (the migrator splits on the literal
  marker). `scripts/gen-updated-at-migration.mjs` writes 0001 from the snapshot (regenerated in
  increment 3 before it was applied anywhere); a later increment that adds a table with
  `updated_at` writes a new custom migration with that one trigger. Every trigger carries a
  no-op WHEN clause. A table with a STORED generated column cannot use
  `OLD.* IS DISTINCT FROM NEW.*` (Postgres restriction), so the generator emits an explicit
  disjunction over its non-generated columns from the snapshot; adding a column to such a
  table (today only `flight_instances`) means a new custom migration that drops and recreates
  its trigger, and `test/trigger.test.ts` fails if the clause misses a column.
  `set_updated_at()` pins `search_path = pg_catalog, public`.
- **Identifiers.** Every constraint and index name stays within 63 bytes; name foreign keys
  explicitly when Drizzle's generated name would exceed it (the contracts test fails otherwise).
- **DO schemas** are additive only for one release (section 9).

## 13. Driver and Better Auth ownership notes

**Driver (ADR 0009).** postgres.js everywhere: `withDb` on Workers with
`{ max: 5, fetch_types: false, prepare: true }` and no `end()` (Hyperdrive reclaims the
connection at the end of the invocation); `createNodeDb` for CI, scripts and tests with an
explicit `close()`. No module-scope client (`planeahead/no-module-scope-drizzle` covers
`packages/db/src` as well as `apps/api/src`). Verified on PG 18.4 through postgres.js: `bytea`
round-trips as a `Buffer`, `bigint({ mode: 'number' })` returns a number, `timestamptz` with
`mode: 'date'` round-trips a `Date` exactly, and the `instant()` column type returns
`2026-09-19T22:30:00Z` whatever the session zone (Drizzle's postgres-js driver installs a
transparent parser for timestamptz, so the raw text is `2026-09-19 22:30:00+00` under UTC and
`2026-09-19 18:30:00-04` under America/New_York; both normalise to the same ISO string). The
session zone is pinned to UTC per environment anyway (section 12).

**Better Auth 1.7.5 ownership.** Export keys are exactly `users`, `sessions`, `accounts`,
`verifications`, `rateLimits` (SQL `rate_limits`); the adapter addresses tables by export key
and columns by TS property name, so TS stays camelCase and SQL snake_case without the `fields`
mapping. Every PlaneAhead extra on those tables is nullable or defaulted because
`validateSchema` throws `SchemaMismatchError` otherwise (`test/better-auth-shape.test.ts` reads
`information_schema` to prove it). Timestamps on those tables are `mode: 'date'`: the spike
showed `mode: 'string'` rejects a JavaScript `Date` on INSERT and Better Auth writes `Date`
objects. `sessions.token` is plaintext unique text because Better Auth looks it up by equality
and has no hashed mode; `accounts.access_token`, `refresh_token` and `id_token` are Better
Auth-owned plaintext columns (increment 5 decides `account.encryptOAuthTokens`); PlaneAhead's
Apple refresh token lives only in `accounts.refresh_token_enc`. Magic-link tokens are hashed by
the plugin into `verifications`. `rate_limits.last_request` is `bigint` mode number.
`rate_limits.key` and `verifications.identifier` hold personal data (an IP or an email, PII
class 2) and neither table has a foreign key: the deletion job purges both by subject and the
housekeeping cron by `last_request` and `expires_at` (section 5).
`users.email` is unique on `lower(email)`; if increment 5 finds `validateSchema` insists on a
plain unique constraint, replace the expression index and keep lower-casing in the auth config.

## 14. Seed data

Committed under `packages/db/seed/data` with `MANIFEST.json` (upstream URL, SHA-256, bytes,
`Content-Length` seen, fetched_at, licence, row counts) and `LICENSES.md`.
`scripts/fetch-seed-data.mjs` requests the identity encoding (Node's fetch otherwise
decompresses gzip and makes `Content-Length` the compressed size) and fails on any byte-count
mismatch. Each loader upserts on its natural key, checks every other unique column across the
source rows before writing (`SeedCollisionError` names both rows) and loads inside one
transaction, so a refresh lands completely or not at all. Loaded on 2026-09-20 in 665 ms:

| Loader               | Source                                           | Read  | Written | Notes                                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------ | ----- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `airports`           | OurAirports filtered, mwgg tz, curated overrides | 6,346 | 6,341   | 5,602 tz from mwgg, 739 from curated overrides, 5 rejected by the country check and skipped with a warning; 829 rows are ident-derived pseudo codes, 426 of them not four characters                                                            |
| `airlines`           | VRS spine, OPTD alliances                        | 5,964 | 5,904   | 60 rows without an ICAO skipped; 92 carry an alliance; one OPTD alliance value (`2018-01-02`) discarded                                                                                                                                         |
| `aircraft_types`     | VRS model-type, ColtJD45 J patch                 | 2,855 | 2,855   | 11,084 VRS rows deduped; 2 fake `-` designators dropped at fetch time; J patched on 1 designator (A388; ColtJD45 lists it twice, does not list the An-225 and has the An-124 as H, verified against the upstream file by SHA-256 on 2026-09-20) |
| `regional_operators` | `@planeahead/shared` hint seed                   | 23    | 23      | confidence `hint`; the seed's own confidence kept in `source_confidence`                                                                                                                                                                        |

## 15. ADR links

- [0002 Neon Postgres 18 through Hyperdrive, not D1](adr/0002-neon-not-d1.md)
- [0003 Flight identity: the canonical flight key](adr/0003-flight-key.md)
- [0006 UUIDv7 primary keys](adr/0006-uuidv7.md)
- [0007 Durable Objects never open Postgres](adr/0007-do-postgres-free.md)
- [0009 postgres.js as the single Postgres driver](adr/0009-postgres-js-driver.md)

## 16. Open decisions for the orchestrator

1. **Table count.** The spec says 61 tables; its normative list names 70 and all 70 are built.
   Confirm the list is the contract and retire the number.
2. **Airports without a four-character code.** Of the 829 seeded airports whose code is an
   ident-derived pseudo code, 426 are not four characters (`03N` Utirik, `19P` Port Protection,
   `4A2` Atmautluak) and **181 of those carry scheduled service**. They exist for display and
   search and cannot be a flight origin or destination (`flight_instances_origin_icao_check` is
   `^[A-Z0-9]{4}$`), so the flight-creation route must refuse such an origin with a clear error
   rather than surface SQLSTATE 23514. The other 403 are four characters (`05AK`) and pass the
   check on shape although the facts sheet says an ident-derived code will not resolve at
   AeroAPI: the check is on shape, not provenance. `test/seed.test.ts` pins all three counts
   and demonstrates both outcomes. Recommended: assign synthetic `ZZxx` codes (shared
   `SYNTHETIC_ICAO_RE`, 1,296 combinations) at seed time from a committed, append-only
   allocation file, add `synthetic` to `ICAO_SOURCES` and mark the row; a `ZZxx` code already
   passes the origin check, so this is a seed-data change, not a schema change. Not done in
   this increment because the spec and ruling D8 fix `icao_source` to `icao_code | ident` and
   the allocation must be stable forever (it is frozen into flight keys).
3. **Five airports rejected by the timezone country check** (Concordia Station AQ, Ulleung KR,
   Mahbes EH, a misplaced Venezuelan duplicate, Woody Island XP) are skipped by the loader. Any
   of them can be promoted by hand into `airports.tz-overrides.json` with a stated source.
4. **`users.email` uniqueness** is an expression index on `lower(email)` rather than a plain
   unique constraint; increment 5 confirms Better Auth's `validateSchema` accepts it.
5. **`logbook_entries` is a sync entity** (it carries `deleted_at`) because shared's
   `SYNC_ENTITIES` lists it; the spec's list of five omitted it.
6. **`airlines` uses a surrogate uuid key** with `icao` unique, matching the airports pattern
   and the "every PK uuid" convention; the dossier sketched an ICAO primary key.
7. **BTS licensing** is presumptively public domain; confirm before committing derived aggregates
   in the BTS increment.

## 17. Review checklist

- [ ] Every table in the normative list exists with the documented purpose, writer and readers.
- [ ] Every user-owned table cascades from `users`; every survivor table has no FK to `users`.
- [ ] Every secret is `_enc bytea` plus key version; every presented token is hashed; the Better
      Auth exceptions are the only plaintext tokens.
- [ ] Every enumeration is `text` plus `check`; lists that mirror shared are asserted identical.
- [ ] `flight_key` is generated, unique by index, and the expression is unchanged.
- [ ] `db:generate` emits nothing; `db:check` is clean; no identifier exceeds 63 bytes.
- [ ] Every instant read through Drizzle satisfies `IsoInstantSchema` (roundtrip test); every
      code column has a format check (contracts test).
- [ ] `flight_instances` writers derive the airport triple from `resolveAirportEndpoint()`.
- [ ] Migrations run only over the direct endpoint, refuse PG17 and `-pooler` hosts.
- [ ] Seed loaders are idempotent and the manifest matches the committed files.
- [ ] Connection budget arithmetic matches the current Neon and Hyperdrive limits.
- [ ] Retention crons exist for every table with a retention shorter than "kept" (increment 12).
