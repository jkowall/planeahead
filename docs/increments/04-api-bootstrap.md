# Increment 4: API Worker bootstrap

Status: spec (2026-09-19, revised the same day against `04-api-bootstrap.facts.md`). Builder: Opus 5. Reviewer: Opus 5 (Workers best practices lens) plus orchestrator read. Branch `inc4-api-bootstrap` based on `inc3-db-schema`.

Read `docs/increments/04-api-bootstrap.facts.md` first. Every fact there was verified against a primary source on 2026-09-19 and several overrode the first version of this spec; the rules below already incorporate them.

Prerequisites from the owner (needed for the staging deploy step only; everything up to `wrangler dev` and the tests works without them): Cloudflare account upgraded to Workers Paid; an API token with Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit, Account Queues Edit, Hyperdrive Edit, Account Settings Read, and Zone Workers Routes Write for `planeahead.app`; the four queues and their dead-letter queues created (`wrangler queues create`) before the first deploy, because deploy fails on a missing queue.

## Goal

`apps/api` becomes a real Cloudflare Worker: Hono 4.13 app with typed routes and an exported `AppType`, `wrangler.jsonc` declaring every binding the plan lists (DO classes as compiling shells, queues, KV, R2, Analytics Engine, ratelimits, crons, one Hyperdrive), the middleware chain (request id, Sentry, rate limit, idempotency, auth placeholder), `GET /health` returning the migration hash and DO schema versions, Vitest running under `@cloudflare/vitest-plugin` with route tests, and the `deploy-staging.yml` workflow. Local dev: `pnpm dev` runs `wrangler dev` with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` from `.dev.vars` pointed at the developer's Neon branch.

Acceptance: `pnpm --filter @planeahead/api test` green under the Workers pool with no database (see Tests), including `GET /health` returning `{ ok, environment, migrationHash, doSchemaVersions }`; `wrangler deploy --dry-run --env staging` succeeds in CI without credentials (it validates config and bundles; it does not verify that resource ids exist, the first staging deploy is that check); a manual `wrangler dev` answers `/health`; after the Workers Paid upgrade and token, the staging deploy workflow deploys `planeahead-api-staging` to `api-staging.planeahead.app` and the smoke step gets 200.

## Spikes before writing DO code (30 minutes total, results recorded in docs/build-log.md)

1. `exports` under `wrangler dev` and the Vitest pool: a one-class Worker declared only through `exports` plus `durable_objects.bindings` gets SQLite storage locally and in a test. Local-dev support exists in wrangler 4.135.0 source but is undocumented.
2. Whether a DO alarm scheduled in a test fires on its own wall clock or only via `runDurableObjectAlarm`. Keep the `afterEach` drain either way.
3. Whether `env.PUBLIC_RL.limit()` enforces in the test pool. If it always returns `success: true`, the 429 route test must inject a stub limiter instead of asserting on the binding.

## Files

```
apps/api/
  wrangler.jsonc          name planeahead-api; main src/index.ts; compatibility_date 2026-09-01; compatibility_flags [nodejs_compat] (a no-op at this date, kept explicit with a comment);
                          exports: [{ name, class_name, storage: "sqlite" }] for FlightTracker, DesignatorResolver, AirportState, UserInbox, ProviderBudget, declared ONCE at top level (inheritable); no migrations array (mutually exclusive with exports);
                          durable_objects.bindings FLIGHT_TRACKER, DESIGNATOR_RESOLVER, AIRPORT_STATE, USER_INBOX, PROVIDER_BUDGET, redeclared in every env block (not inheritable);
                          hyperdrive [{ binding DB, id <placeholder>, localConnectionString "postgres://localhost:5432/unused" }] (the local string is overridden by CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB under wrangler dev only);
                          kv_namespaces CACHE, PUBLIC, CONFIG; r2_buckets PUBLIC_BUCKET planeahead-public, PRIVATE_BUCKET planeahead-private;
                          queues producers/consumers persist, notify, provider-events, imports with dead_letter_queue per queue, max_batch_size 100 for persist, max_retries 5, max_concurrency left default;
                          analytics_engine_datasets PROVIDER_CALLS, API_METRICS, PRODUCT_EVENTS;
                          ratelimits PUBLIC_RL 120/10s, USER_RL 600/60s, EVENTS_RL 60/60s, with DISTINCT namespace_id integers per environment (1001-1003 staging, 2001-2003 production, 3001-3003 local) because namespace ids share counters account-wide;
                          triggers.crons ["*/15 * * * *", "0 3 * * *"] (five fields); observability enabled with head_sampling_rate 1 (staging) 0.1 (production);
                          vars ENVIRONMENT, API_PUBLIC_URL; routes [{ pattern: api-staging.planeahead.app, custom_domain: true }] in env.staging and api.planeahead.app in env.production;
                          env.staging and env.production redeclare every non-inheritable key (bindings, kv, r2, queues, hyperdrive, analytics_engine_datasets, ratelimits, vars, routes).
  vitest.config.ts        import { defineConfig } from 'vitest/config'; import { cloudflareTest } from '@cloudflare/vitest-plugin'; plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })]. No isolatedStorage or singleWorker (removed; isolation is per file and automatic). No miniflare.hyperdrives override: increment 4 tests never dial Postgres.
  .dev.vars.example       CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB, ENVIRONMENT=local, SENTRY_DSN=
  src/index.ts            Hono app built as ONE chain (const routes = app.route(...).route(...); export type AppType = typeof routes) so the RPC type is complete; export the DO classes; export default withSentry(env => options, { fetch, queue, scheduled })
  src/env.ts              typed Env from worker-configuration.d.ts (wrangler types); a Variables type for c.var (requestId, user); never ContextVariableMap
  src/middleware/request-id.ts (first), sentry.ts (second: sentry() from @sentry/hono/cloudflare, tags the request id; sendDefaultPii: false kept explicit with a comment that it is the default and deprecated in favour of dataCollection; beforeSend mutates and returns the event after stripping headers and bodies), rate-limit.ts (ipLimiter using PUBLIC_RL on unauthenticated routes; principalLimiter placeholder keyed by user id; limiter injectable for tests), idempotency.ts (reads Idempotency-Key; stores the response in idempotency_keys via withDb only when env.DB is bound and ENVIRONMENT is not test; otherwise an in-memory map), auth.ts (placeholder setting c.var.user = null; Better Auth arrives in increment 5)
  src/routes/health.ts    GET /health: ok, environment, migrationHash (a constant generated at build time from packages/db migrations/meta/_journal.json by a small script, so no DB round trip), doSchemaVersions (each DO class's compiled-in static SCHEMA_VERSION; never instantiates an object)
  src/do/migrate.ts       runSqlMigrations(ctx, migrations: string[][]): creates _sql_schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now'))) if missing, reads SELECT MAX(id), applies each pending migration inside ctx.storage.transactionSync as one statement per sql.exec call (each statement under the 100 KB limit), inserts the id row in the same transaction. PRAGMA user_version is NOT available in DO SQLite; never use it. Statically imported by every DO class (dynamic import() does not work inside DO handlers).
  src/do/*.ts             five classes extending DurableObject from cloudflare:workers with static SCHEMA_VERSION = 0, a constructor that calls ctx.blockConcurrencyWhile(() => runSqlMigrations(...)) with an empty migration list, and a ping() RPC returning { schemaVersion, applied }; no business logic
  src/queues/*.ts         consumers that ack per message (a thrown handler retries the whole batch) and log; persist consumer skeleton with the Analytics Engine chunking helper (<= 200 points per invocation against the documented 250 cap; writeDataPoint is synchronous and never awaited) but no DB writes yet
  src/cron/*.ts           handlers logging their name; a comment on reconcile that sub-hourly crons get 30 s CPU, so it must page and fan out to a queue (increment 12)
  src/observability/log.ts  structured JSON logger with request id
  test/workers/health.test.ts, do-ping.test.ts (each DO class answers ping and reports version 0; unique DO name per test; alarms drained in afterEach), migrate-runner.test.ts (fresh object gets MAX(id) null; a test-only class with two migrations applies both once, and a re-construction applies nothing; a failing statement rolls back the migration and leaves the id row absent), rate-limit.test.ts (per spike 3), idempotency.test.ts (replay returns the stored response). Tests import { exports, env } from 'cloudflare:workers' and call exports.default.fetch(); SELF and env from cloudflare:test are deprecated and not used.
scripts/gen-migration-hash.mjs      writes apps/api/src/generated/migration-hash.ts from packages/db/migrations/meta/_journal.json (run by the api typecheck/test/dev scripts; committed output)
.github/workflows/deploy-staging.yml   on push main: pnpm install, run packages/db migrate against NEON_STAGING_DIRECT_URL (skips with a warning if unset), cloudflare/wrangler-action@v4 with wranglerVersion 4.135.0 and command "deploy --env staging", secrets input EMPTY (secrets are set out of band with wrangler secret put), then curl https://api-staging.planeahead.app/health. Plain deploy only: gradual deployments (versions upload/deploy) are not supported for Workers that declare exports, so the plan's conditional path is removed for good and production (increment 12) also uses plain deploy.
docs/adr/0004-hono-rpc.md          include the rejected option experimental.newConfig / cloudflare.config.ts (no env support, experimental) and the deprecation of SELF
scripts/toolchain-guard.mjs        extend: assert @cloudflare/vitest-plugin's declared wrangler dependency version equals the installed wrangler version, and that vitest major is 4
```

## Constraints

- New deps only: hono ^4.13.8, @hono/zod-validator ^0.9.1, zod (catalog, already present), wrangler 4.135.0 exact, @cloudflare/vitest-plugin 1.1.13 exact, @cloudflare/workers-types, @sentry/cloudflare 10.75.0 exact, @sentry/hono 10.75.0 exact (must match), plus @planeahead/shared and @planeahead/db workspace links. If pnpm's isolated linker does not auto-install @vitest/runner and @vitest/snapshot 4.1.11 as peers, add them explicitly. `postgres` is only imported inside `withDb` from packages/db.
- Never open a Postgres connection from a DO class (ADR 0007). The ESLint rule from increment 1 must stay green.
- No provider calls, no auth, no flight routes yet.
- Vitest stays 4.1.x; Vitest 5 breaks the Workers pool (workers-sdk#15618, open). Do not cite workers-sdk#10275 anywhere; it was closed as a test-side fake-timers problem.
- Increment 4 tests need no database and no service container; the CI `test-workers` job runs without Postgres. Postgres in CI is only for packages/db (increment 3) and the auth and route tests that arrive in increments 5 and 8.
- `.dev.vars.<env>` replaces `.dev.vars` entirely, it does not merge; document in the README.
- No em dashes. ESM.

## Design notes carried to later increments (record in docs/open-decisions.md in increment 12)

- setAlarm inside transactionSync is unverified (two documented signatures). Increment 7 spikes it first; if it is not covered by the transaction, the alarm handler records the attempt in the transaction, sets the alarm after commit, and tolerates a missed re-arm because the reconcile cron re-arms.
- The Analytics Engine 250-point cap is documented per client HTTP request; whether it applies to queue and alarm invocations is unverified. The 200-point chunk plus a per-invocation counter stays.
- fetchMock is gone from cloudflare:test; provider adapter tests in increment 6 use Node-side unit tests with undici MockAgent, and Workers-pool tests inject a fetch function.
- locationHint applies on get()/getByName(), only on the first touch; every call site that may create a FlightTracker or UserInbox passes it.
