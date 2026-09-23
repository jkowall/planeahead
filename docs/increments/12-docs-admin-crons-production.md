# Increment 12: docs, admin page, crons, production deploy

Status: spec (2026-09-20). Builder: Opus 5. Reviewers: Opus 5 (operations correctness) plus orchestrator read. Branch `inc12-ops` based on `inc11-native-shells`.

Read `docs/increments/04-api-bootstrap.facts.md` (deploy mechanics), `06-07-providers-and-trackers.facts.md` sections 4 and 5 (queues, Analytics Engine, Durable Object cost), and `08-flight-routes-and-sync.facts.md` sections 1 and 3 (sync retention, deletion disclosure) first.

## Goal

Everything Phase 0 promised in prose becomes a document, a cron or a deploy path: `docs/architecture.md` completed (the cadence tables are already generated), `docs/cost-estimate.md`, the final `docs/schema-review.md`, `docs/security/threat-model.md`, `docs/open-decisions.md`; the Access-protected admin page; the reconcile, housekeeping and Analytics Engine rollup crons; the production deploy workflow exercised end to end.

Acceptance: the FlightTracker lifecycle test imports its constants from the same module that generated the docs table (already true; a test asserts the doc block matches); `wrangler deploy --dry-run --env production` passes in CI; a `v0.0.1` tag runs `deploy-production.yml`, which waits for a manual approval (environment gate or manual dispatch until GitHub Pro), migrates against `NEON_PRODUCTION_DIRECT_URL`, deploys with plain `wrangler deploy --env production` (gradual deployments are unsupported with `exports`), and smokes `/health` on `api.planeahead.app`; the admin page at `/admin` behind Cloudflare Access (JWT `aud` validated) shows provider calls per flight key and per provider per day (from `provider_call_daily` and the Analytics Engine SQL API with `SUM(_sample_interval)`), DO schema versions, the sync watermark lag and the queue depths; the crons are tested with `scheduled` invocations and have documented CPU budgets.

## Crons

- `*/15 * * * *` reconcile (30 s CPU on Paid for sub-hourly crons): page `flight_instances` where `tracking_state` is active and `next_refresh_at < now() - 20 min`, fan out to the `reconcile` queue; the consumer re-arms trackers whose alarm was abandoned (`getAlarm()` null and phase not finished; an alarm in progress also reports null, so the phase column is checked first).
- `0 3 * * *` housekeeping: purge `idempotency_keys` older than 24 h, `user_sync_changes` and `flight_sync_changes` older than 30 days (one horizon H below the watermark for both tables, `delete ... where xid < H` from both and H written to `sync_horizon` in the same transaction; never by `seq`, ADR 0012 item 6), `provider_calls` rows older than 90 days (after the daily rollup exists), `notifications` older than 90 days, `data_export_jobs` older than 7 days, expired `deleted_subjects` (400 days), `rate_limits` rows older than the window, expired `verifications`; reconcile the `usage_counters` active-subscription and live-tracked counters against `flight_subscriptions` (increment 8 charges and releases `live_tracked` where a flight enters and leaves its window, so this is a repair, not the path); reconcile the tracker subscriber lists (for each active `flight_instances` row list its tracker's subscriber ids through a new `listSubscribers` RPC added to the FlightTracker in this increment, since the existing `getState`, `health` and `unsubscribe` responses carry only `subscriberCount`, and unsubscribe ids with no live `flight_subscriptions` row: the safety net increment 8's subscribe route relies on after a lost deadline and the increment 8 merge relies on for the anonymous row it marks `deleting`); replay `dlq/persist/` objects older than an hour onto the persist queue and delete each on success (the closer for dead-lettered DesignatorResolver cost records recorded in ADR 0011); write a KV tombstone per deleted session hash so the `/v1` auth middleware can re-enable Better Auth's cookie cache (increment 8 disabled it for every `/v1` request as the Phase 0 answer to `account_deleted`); map SQLSTATE 23503 on a `*_user_id_fkey` constraint to 401 `account_deleted` in the global error handler after re-reading `users` (a request authenticated just before a deletion commits currently answers 500 at the idempotency lease insert, increment 8's final re-review nit); write one `audit_log` row per purge with counts; the DesignatorResolver appends its `user_search` provider-call record after resolution with the resolved flight key (today the record carries `flight_key` NULL because it is written before the key is known, so the admin page's per-flight view joins search calls by request id; increment 10's open question); each step is its own queue message so a 30 s cron never does the work inline.
- `0 3 * * *` Analytics Engine rollup: query the SQL API per provider per day into `provider_call_daily` (Postgres is the ledger; Analytics Engine retains 3 months and samples per index value).

## Admin

`GET /admin/*` behind Cloudflare Access: validate the `Cf-Access-Jwt-Assertion` against the team's certs with the configured `aud`; server-rendered HTML (no client framework) with the tables above; read-only in Phase 0; `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` as vars.

## Deploy

- `deploy-production.yml`: on tag `v*`; `wrangler-action@v4` with `wranglerVersion 4.135.0` and empty `secrets`; plain deploy only (the plan's `versions upload` branch is removed for good); the required-reviewer environment gate needs GitHub Pro on a private repo, so until then a `workflow_dispatch` with a typed confirmation input guards it; the deploy token needs Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit, Account Queues Edit, Hyperdrive Edit, Account Settings Read, and Zone Workers Routes Write for `planeahead.app`.
- Owner prerequisites documented in `docs/runbooks/first-deploy.md`: create the queues and dead-letter queues, KV namespaces, R2 buckets and the Hyperdrive config (`--caching-disabled`, a correctness requirement of the sync feed's no-cursor snapshot page that the runbook checks stays off, ADR 0012 item 7; `--origin-connection-limit 80` for staging; production against the 0.5 CU Neon primary) per environment, paste the ids into `wrangler.jsonc`, set the secrets with `wrangler secret put`, run `ALTER ROLE ... SET TimeZone = 'UTC'`, `SET statement_timeout` and `SET idle_in_transaction_session_timeout` on each Neon branch, bump `sync_epoch` after any point-in-time restore (docs/schema-review.md section 6), set the Neon history window to 1 day explicitly, register the Apple email sources and universal-link files.
- A static account-deletion web page (Google Play requirement) served by the API Worker at `/account/delete` with instructions and the support inbox, plus the `/.well-known` files from increment 9.

## Documents

- `docs/architecture.md`: components, request paths, the DO lifecycle diagram (text), the outbox and persist path, the sync feed and watermark rule, the environments; keeps the generated cadence block.
- `docs/cost-estimate.md`: the plan's section 9 recomputed with the increment 2 constants (A2 74 polls, 122 PE, $0.61 list; AeroDataBox weekly pre-48h) and the Durable Object cost from the facts (about $0.001 per flight, rows written dominant, the 400,000 GB-s rounding cliff), AeroAPI's $100 Standard minimum, AeroDataBox Growth as the plan floor.
- `docs/security/threat-model.md` completed: auth (both encryption schemes, the proxy route block, the non-atomic refresh-token write), share links and MCP (documented only), webhook path tokens, KEK rotation runbook, the deletion disclosure.
- `docs/open-decisions.md`: every plan section 19 item with its current answer and the new ones the facts sheets raised (Durable Object jurisdiction, Live Activity 8-hour limit, ADB alert coordinator, rate-limit customStorage, Play organisation account, Sentry `dataCollection` migration).

## Files

```
apps/api/src/cron/{reconcile.ts, housekeeping.ts, ae-rollup.ts} (real), src/queues/{reconcile.ts, housekeeping.ts}
apps/api/src/routes/{admin.ts, account-delete-page.ts}, src/middleware/access.ts
apps/api/test/workers/{crons.test.ts, admin-access.test.ts}
.github/workflows/deploy-production.yml
docs/{architecture.md, cost-estimate.md, schema-review.md (final), security/threat-model.md, open-decisions.md, runbooks/first-deploy.md}
```

## Constraints

- No cron does work inline beyond paging and enqueueing. No gradual deployments. No em dashes.
