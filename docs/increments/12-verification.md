# Increment 12 verification: docs, admin, crons, production deploy

Branch `inc12-ops` (based on `main` with increments 2 to 11), 2026-09-23 to 2026-09-24. This file
records what ran on the build machine, with its result, the exact commands the owner runs, what
stays unverified until a Cloudflare account, a Neon project and the provider and Apple credentials
exist, and the owner's tasks. The design is in [the spec](12-docs-admin-crons-production.md), the
system in [docs/architecture.md](../architecture.md) and the owner's setup in
[docs/runbooks/first-deploy.md](../runbooks/first-deploy.md); this file is the evidence for the tree
as it stands after the review round.

Commits: "Increment 12: docs, admin, crons, production deploy" (the build, `d54e361`) and
"Increment 12: apply review findings" (the review round, rulings AA1 to AA18, below). The numbers
in the first table are from the review round's final run.

The machine: macOS 27.0, Node 24.21.0, pnpm 12.5.1 (isolated linker), wrangler 4.135.0, embedded
PostgreSQL 18.4 for every database test. No Docker, no Cloudflare account, no Neon project, no
provider keys, no Apple or Google credentials, no deployed environment: everything deploy-shaped is
proven by `wrangler deploy --dry-run` for staging and production, by the Workers pool with embedded
Postgres (the Analytics Engine SQL API, the Access certs and the Queues API answered by injected
fetches, the providers by the Node fake-provider server), and by workflow files that parse with
unique job keys.

## What ran here

| Check | Command | Result |
| --- | --- | --- |
| Full check | `pnpm turbo run typecheck lint test --force && pnpm prettier --check . && node scripts/toolchain-guard.mjs && node scripts/vitest-exit-guard.mjs && node scripts/mobile-migrations-guard.mjs --base origin/main` | passed: 14 turbo tasks in 1 min 52 s; 2,194 tests passed (tools 48, shared 589, db 180, api 774 with 1 skipped in 70 files, mobile 603); Prettier clean; toolchain guard ok; exit guard ok; migrations guard ok (the 4 mobile migrations unchanged) |
| Wrangler dry runs | `cd apps/api && pnpm exec wrangler deploy --dry-run --env staging && pnpm exec wrangler deploy --dry-run --env production` | both exit 0; the binding tables list `HOUSEKEEPING_QUEUE` (`planeahead-housekeeping-staging`, `planeahead-housekeeping`) and `EVENTS_RL (300 requests/60s)` |
| Drizzle | `cd packages/db && pnpm exec drizzle-kit check && pnpm exec drizzle-kit generate` | "Everything's fine"; generate: "No schema changes, nothing to migrate" after migration 0005 |
| Migration hash | `node scripts/gen-migration-hash.mjs --check` | up to date: 6 migrations, `7b8d9a905606...`, `DB_SCHEMA_VERSION` 6 |
| Workflow files | every file in `.github/workflows` parsed with `yaml` 2.9.1 (`uniqueKeys: true`) and its job keys listed | all parse; no duplicate job key (`deploy-production.yml`: `verify`, `deploy`; `deploy-staging.yml`: `deploy`) |
| Durable Object rows | `pnpm exec vitest run test/workers/flight-tracker.lifecycle.test.ts --reporter=verbose` in `apps/api` | `[lifecycle] polls=74 alarms=74 rows_written_lifetime=1203 rows_read_lifetime=3917 per_alarm_avg=16.3 max_batch_messages=7 max_message_bytes=1635`, the figures docs/architecture.md and docs/cost-estimate.md now cite |
| BRIN for `xid8` | `select opcname from pg_opclass ... where amname = 'brin'` on the embedded PostgreSQL 18.4 | no BRIN operator class exists for `xid8` (only for the timestamp types among the relevant ones), hence the btree on `xid` in migration 0005 |

## The review round

The review panel's findings and the orchestrator's rulings AA1 to AA18, as applied. Every
behavioural fix carries its regression test.

- **AA1, the KEK re-wrap.** `Envelope.rotateKek` unwraps the freshly wrapped DEK under the target
  KEK and compares it byte for byte with the DEK it read before writing anything (any failure
  throws and leaves the row untouched), and its UPDATE is conditional on `kek_version` still being
  the version it read, answering `rotated`, `current`, `superseded` or `absent`. The nightly step
  counts `rewrapped`, `superseded` and `failed`. Tests (`crons.test.ts`, step 9): the round trip
  (ciphertext decrypts under the new KEK), a target KEK that cannot unwrap (row untouched), the
  conditional UPDATE losing to a concurrent rotation (`superseded`, the racer's wrap stands and
  decrypts), and a row under a KEK the Worker no longer holds (`UnknownKeyVersionError`, `failed:
  1`, the message acknowledged, the row untouched).
- **AA2, the wider retention step.** Kept as built: one count per purged table in the audit row,
  every delete in batches under the 30 s wall budget with a continuation. docs/schema-review.md's
  retention table names each table with its step.
- **AA3, session tombstones.** Kept as built; the residuals are in the threat model section 1.5
  and in docs/open-decisions.md.
- **AA4, `EVENTS_RL`.** 300 batches per 60 s per client IP in all three environments; the NAT
  residual is a paragraph of the threat model section 3.2. Tests (`events.test.ts`): wrangler.jsonc
  declares 300 per 60 s three times; a limiter with the configured limit refuses the 301st batch
  from one IP with 429 `EVENTS_RL`, keyed `events:ip:{ip}` only, and lets another IP in (the live
  binding cannot be driven past 300 from one address because `PUBLIC_RL` refuses at 120 first).
- **AA5, the Neon role.** The runbook grants `pg_read_all_stats`; the admin page's watermark query
  reads `pg_has_role(current_user, 'pg_read_all_stats', 'member')` and says "partial: the role
  lacks pg_read_all_stats" when false. Tests (`admin-access.test.ts`): the notice with and without
  the role, and its absence on the suite's superuser.
- **AA6, the production gate.** Unchanged in the workflow; docs/open-decisions.md states the exact
  condition to relax and the test case to update with it.
- **AA7.** This file.
- **AA8, the runbook.** Step 0 buys AeroDataBox Growth; step 6 makes `ADB_PLAN=growth` a required
  item in both environments (unset means Starter's 1,333 units a day) and points the SIWA secrets
  at step 12; step 9 names the test case the GitHub Pro change must update; step 12 has the two
  Apple items (Sign in with Apple primary App ID with `.preview` and `.dev` grouped under it, and
  the SIWA key under Keys with that primary); a new step 16 creates and tests the support inbox,
  and the Play item (now step 17) depends on it.
- **AA9, operator deletion.** `GET /admin/accounts/delete` (lookup: status, creation date, guest or
  not) and `POST /admin/accounts/delete` behind the same Access check, same origin only (`Origin`
  must equal `API_PUBLIC_URL`'s origin), the user id typed a second time, running the same
  `deleteAccount` as `POST /v1/me/delete` with an operator actor whose one audit row is actor
  `admin` with the Access email and subject; only that page's CSP allows `form-action 'self'`.
  Tests (`admin-access.test.ts`): a wrong confirmation, another origin, no origin and no Access
  assertion all change nothing; the confirmed POST removes the user, unsubscribes the tracker,
  writes the session's `deleted_subjects` hash and KV tombstone and one audit row naming the
  operator, and the device still holding the cookie gets 401 `account_deleted`; a repeat answers
  404; a lookup that is not a user id is 400 and escaped.
- **AA10, staging.** `deploy-staging.yml` fails (exit 1) when `NEON_STAGING_DIRECT_URL` is unset.
  Test (`tools/workflows/deploy-production.test.js`): the staging case asserts the `exit 1` and
  the absence of the old warning and `exit 0`.
- **AA11, the search path.** `GET /v1/flights/search` bypasses the cookie cache
  (`ROW_READ_GET_PATHS`) and reads the session row like a write; the auth middleware comment, the
  threat model and open-decisions say "read-only paths". Test (`session-tombstone.test.ts`): a
  revoked session (row deleted, no tombstone) presenting the cache cookie still reads `/v1/me` from
  the cache (the documented residual) and gets 401 `unauthenticated` on the search, with no counter
  written.
- **AA12, documents.** open-decisions section 4 "Schema (increment 3)" with schema-review section
  16 items 1, 2 and 7; `DO_FILES` exported from `scripts/health-smoke.mjs` and a tools test that
  its keys equal `DO_SCHEMA_VERSIONS`' (health.ts added to the tools task's turbo inputs); 1,203
  rows and 16.3 per alarm in both documents, citing the lifecycle line; the duration row says 3.8
  to 9.7 GB-s and that the 100k scenario is under the cliff only at the 400 ms end; the v1.ts
  comment names the two reserved 501 webhooks and the architecture path table has their row.
- **AA13, the rollup and the purge gate.** `rollupRows` never coerces: a sum that fails the numeric
  parse (null, missing, `'25.0x'`, negative) throws `RollupSumError`, so the message is retried and
  then dead-lettered with the ops alert and no row is written. Step 3 deletes a whole UTC day of a
  provider's `provider_calls` only when the day's non-budget rollup sums to more than 0 and lies
  within 20 percent of the day's `count(*)`; other days are kept and counted
  (`days_without_rollup`, `days_without_plausible_rollup`, each implausible day logged with both
  figures). A day judged plausible carries its approval in the continuation's cursor
  (`approved:{day}|{provider}`), because its `count(*)` shrinks as it is deleted. Tests
  (`crons.test.ts`): null, missing and non-numeric sums through the consumer (retried, no audit,
  no row, the 25 ledger rows kept by the purge), a zero and an implausibly low rollup (kept), a
  sampled rollup inside the band deleted across a continuation that is not re-judged, the pure
  plausibility band and the pure parser.
- **AA14, the tombstone check.** Runs for every session resolved through the cacheable read,
  whatever the cache cookie is called; `presentsCookieCache` is gone. Tests
  (`session-tombstone.test.ts`): the chunked `session_data.0` cookie and a token-only cookie both
  get 401 `account_deleted` once tombstoned, and the chunked cookie alone is answered 200 without a
  tombstone (so the check is what refuses it).
- **AA15, the sync purge at scale.** Migration 0005 (`DB_SCHEMA_VERSION` 6, hash regenerated): a
  BRIN on `created_at` and a BTREE on `xid` on both change tables (deviation below). The purge is
  paged: each message reads the oldest `SYNC_PURGE_ROWS_PER_STEP + 1` (10,001) rows of both tables
  in xid order, picks H_i (the first young row's xid, which ends the purge; else the (N+1)-th xid;
  else one above the last), capped at `pg_snapshot_xmin` and never below the recorded horizon,
  deletes `xid < H_i` from both tables and records H_i in one transaction, then sends a
  continuation. Tests (`crons.test.ts`): a purge at two rows per step runs four steps (102, 104,
  111, 120), ends on the one-pass horizon of an identical copy purged unpaged, deletes at most two
  rows per step, and after EVERY step answers each cursor from 95 to 155 exactly as the route's
  rule does (410 below the recorded horizon, all rows after it otherwise); one transaction's rows
  are never split; the pure step rules.
- **AA16, the DLQ replay.** Only `designator_resolver:` and `provider_budget:` archives are
  replayed; every other archive, a FlightTracker's above all, is kept as the record (`kept`), and
  ADR 0011, the architecture and the threat model say so. Tests (`crons.test.ts`): resolver and
  budget archives replayed and deleted, two tracker archives (one with a `replayCount`) kept and
  never parked, still kept and never sent the next night, a poison and an unreadable archive
  parked.
- **AA17, ordering.** The housekeeping module, the three wrangler.jsonc consumer comments, the
  architecture and the README say the steps are independent and order-insensitive and that the
  ruling's order only documents them.

## Deviations

- **A btree, not BRIN, on `xid` (AA15).** PostgreSQL 18 has no BRIN operator class for `xid8`
  (checked on the embedded 18.4, above), so `CREATE INDEX ... USING brin (xid)` cannot be written.
  The btree also serves the purge better: the walk is an ordered index range read that stops after
  10,001 rows, where a BRIN would still read whole block ranges. The BRIN on `created_at` is as
  ruled. Recorded in docs/open-decisions.md (section 6) and docs/schema-review.md principle 8.
- **Whole days in step 3 (AA13).** The ruling judges a (day, provider) against its `count(*)`; a
  purge by row age ("older than 90 days" cut at 03:00) would leave a partial boundary day whose
  shrunken count fails the band the next night and is then kept for good. So a day is purged only
  when all of it is older than 90 days (days before `today - 90`), in full.
- **The commit trailer.** The review round's commit carries `Co-Authored-By: Claude Opus 5.5 (1M
  context)`, not the fix rules' `Claude Fable 5.1`: the session's attribution rule names the model
  that did the work (the same call increment 11's review round made; reported to the
  orchestrator).

## Accepted as built (ruling AA7)

- The Opus commit trailer on the build commit.
- The W4 mapping matches both Postgres's `*_user_id_fkey` and Drizzle's `*_user_id_users_id_fk`
  constraint names (`USER_FOREIGN_KEY` in src/app.ts), tested through the idempotency lease insert.
- `POST /v1/events` keys its batch by `analyticsId`, validates the envelope whole and each event on
  its own, and answers 202 `{ accepted, dropped }`.
- `src/routes/not-implemented.ts` is deleted (the `/v1/events` stub was its last route).
- The Analytics Engine rollup runs as `ae_rollup` messages on the housekeeping queue, with
  `CF_ACCOUNT_ID` a var and `CF_API_TOKEN` an optional secret (`OPTIONAL_SECRET_NAMES`).
- The DesignatorResolver stamps the resolved flight key on every attempt record of a search.
- The `HousekeepingDeps` test seams (tables, scopes, sinks, clock, budget, batch sizes, and in the
  review round `syncPurgeRowsPerStep`).
- `APPLE_BUNDLE_IDS` (a list) beside the existing `APPLE_BUNDLE_ID`, with the identity token's own
  `aud` as the `client_id` of the code exchange.
- The turbo inputs of the api and tools tasks.
- `/admin` and `/account` mounted outside `AppType` (browsers fetch them, no `hc` client does).

## Commands for the owner

Everything runs from the repository root unless it says otherwise; the runbook
(docs/runbooks/first-deploy.md) is the ordered list with every command, these are the checks that
prove this increment once the accounts exist.

1. **The dry runs against the real ids**, after runbook steps 2 to 8:
   `cd apps/api && pnpm exec wrangler deploy --dry-run --env staging && pnpm exec wrangler deploy --dry-run --env production`.
2. **The Neon role** on each branch, as `planeahead_app`:
   `SHOW statement_timeout; SELECT pg_has_role(current_user, 'pg_read_all_stats', 'member');`
   (expected `10s` and `t`).
3. **The first staging deploy** (runbook step 10), then the smoke by hand:
   `node scripts/health-smoke.mjs https://api-staging.planeahead.app staging`.
4. **The first nightly run** (03:00 UTC the next morning), on the staging admin page or with
   `psql "$NEON_STAGING_DIRECT_URL" -c "select action, details->>'done' as done, details from audit_log where action like 'housekeeping.%' order by created_at desc limit 30;"`:
   every step present with `done: true` (after its continuations), `housekeeping.ae_rollup`
   with rows (or `skipped: cloudflare_api_not_configured` without the token), and
   `housekeeping.provider_calls` with `days_without_plausible_rollup: 0` once real traffic has
   rolled up.
5. **The operator deletion** on staging with a throwaway anonymous account: open
   `https://api-staging.planeahead.app/admin/accounts/delete` through Access, look the user id up,
   type it again, delete; then
   `psql "$NEON_STAGING_DIRECT_URL" -c "select actor_type, details->>'operator_email' from audit_log where action = 'account.deleted' order by created_at desc limit 1;"`
   (expected `admin` and your Access email).
6. **The production deploy** (runbook step 17): push the tag, then run **Deploy production** by
   hand on it with `deploy <tag>` typed into `confirm`.

## Unverified

- **Every deploy**: no Cloudflare account, so neither workflow has run; the dry runs, the workflow
  shape tests and the YAML parse are the proof.
- **The Analytics Engine SQL API's real answer shape** (how it encodes 64-bit sums, and whether an
  empty day is `[]`): the rollup refuses anything that is not a number, so a surprise shows up as a
  dead-lettered `ae_rollup` message and an ops alert, never as a purged ledger.
- **The plausibility band against real sampling**: 20 percent is the ruling's number; a busy day
  whose sampling error exceeds it is kept, not lost, and shows in `days_without_plausible_rollup`.
- **Cloudflare Access** (the real certs endpoint and a real assertion), **the Queues API's metrics
  endpoint** and **Better Auth's chunked cache cookie from a real browser**: covered by injected
  fetches and by renaming the cookie in the suite.
- **Apple's acceptance of the grouped App IDs** with one SIWA key for `.preview` and `.dev` (no
  Apple team here).
- **The paged purge's timings at scale**: the plan (an index range read of 10,001 rows and a
  delete of at most that many per step) is argued, not measured on a production-sized table.
- **Hyperdrive's own deploy permission** and the first deploy's queue and binding creation
  (runbook steps 1 and 10).

## Owner tasks

The runbook is the checklist; the ones this increment's review round added or changed:

- AeroDataBox Growth and `ADB_PLAN=growth` in both environments (runbook steps 0 and 6).
- `GRANT pg_read_all_stats TO planeahead_app` on each branch (step 7).
- `NEON_STAGING_DIRECT_URL` before the first push to `main` that touches the API: the staging
  deploy now fails without it (step 9).
- Sign in with Apple: the primary App ID with `.preview` and `.dev` grouped under it, BEFORE any
  user signs in, and the SIWA key configured with that primary (step 12).
- The support inbox and its test message before the Play listing (step 16), and the deletion
  procedure through the admin page for every request that reaches it.
- Once on GitHub Pro: the gate change and its test case together (step 9; docs/open-decisions.md).
