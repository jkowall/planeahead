# Increment 4: API Worker bootstrap

Status: spec (2026-09-19). Builder: Opus 5. Reviewer: Opus 5 (Workers best practices lens) plus orchestrator read.
Prerequisite from the owner: Cloudflare account upgraded to Workers Paid before the staging deploy step; everything up to `wrangler dev` works without it.

## Goal

`apps/api` becomes a real Cloudflare Worker: Hono 4.13 app with typed routes and an exported `AppType`, `wrangler.jsonc` declaring every binding the plan lists (DO classes as compiling shells, queues, KV, R2, Analytics Engine, ratelimits, crons, one Hyperdrive), the middleware chain (request id, Sentry, rate limit, idempotency, auth placeholder), `GET /health` returning the migration hash and DO schema versions, Vitest running under `@cloudflare/vitest-plugin` with `SELF.fetch` route tests, and the `deploy-staging.yml` workflow. Local dev: `pnpm dev` runs `wrangler dev` with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` pointed at the developer's Neon branch from `.dev.vars`.

Acceptance: `pnpm --filter @planeahead/api test` green under the Workers pool including a test that `GET /health` returns `{ ok, environment, migrationHash, doSchemaVersions }`; `wrangler deploy --dry-run --env staging` succeeds; a manual `wrangler dev` answers `/health`; after the Workers Paid upgrade, the staging deploy workflow deploys to `api-staging.planeahead.app` and the smoke step gets 200.

## Files

```
apps/api/
  wrangler.jsonc          name planeahead-api; main src/index.ts; compatibility_date 2026-09-01; compatibility_flags [nodejs_compat];
                          exports: FlightTracker, DesignatorResolver, AirportState, UserInbox, ProviderBudget (storage sqlite);
                          durable_objects.bindings FLIGHT_TRACKER, DESIGNATOR_RESOLVER, AIRPORT_STATE, USER_INBOX, PROVIDER_BUDGET;
                          hyperdrive [{ binding DB, id <placeholder>, localConnectionString via env }];
                          kv_namespaces CACHE, PUBLIC, CONFIG; r2_buckets PUBLIC_BUCKET planeahead-public, PRIVATE_BUCKET planeahead-private;
                          queues producers/consumers persist, notify, provider-events, imports (+ DLQs, batch sizes per plan);
                          analytics_engine_datasets PROVIDER_CALLS, API_METRICS, PRODUCT_EVENTS;
                          ratelimits PUBLIC_RL 120/10s, USER_RL 600/60s, EVENTS_RL 60/60s;
                          triggers.crons */15 and 0 3; observability enabled with head_sampling_rate 1 (staging) 0.1 (production);
                          vars ENVIRONMENT, API_PUBLIC_URL; env.staging and env.production blocks redeclaring bindings with their own ids and routes
                          (api-staging.planeahead.app, api.planeahead.app). Use the `exports` DO declaration form, not the legacy migrations array, per the plan.
  vitest.config.ts        defineWorkersConfig / cloudflareTest with wrangler configPath and isolated storage
  .dev.vars.example       CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB, ENVIRONMENT=local, SENTRY_DSN=
  src/index.ts            Hono app; routes mounted; export type AppType; export DO classes; export default { fetch, queue, scheduled }
  src/env.ts              typed Env from worker-configuration.d.ts (wrangler types)
  src/middleware/request-id.ts, sentry.ts (@sentry/cloudflare withSentry, sendDefaultPii false, beforeSend scrubs headers and bodies), rate-limit.ts (ipLimiter using PUBLIC_RL on unauthenticated routes; principalLimiter placeholder keyed by user id), idempotency.ts (reads Idempotency-Key, stores response in idempotency_keys via withDb; skips when no DB), auth.ts (placeholder that sets c.var.user = null; Better Auth arrives in increment 5)
  src/routes/health.ts    GET /health: ok, environment, migrationHash (read from packages/db migrations meta journal at build time via a generated constant), doSchemaVersions (from each DO class's static SCHEMA_VERSION)
  src/do/*.ts             five classes extending DurableObject with a static SCHEMA_VERSION = 0, a constructor running the migration runner (src/do/migrate.ts: PRAGMA user_version, per-class SQL array, executed under blockConcurrencyWhile in transactionSync), and a `ping()` RPC; no business logic yet
  src/queues/*.ts         consumers that ack and log; persist consumer skeleton with the AE chunking helper (<=200 points per invocation) but no DB writes yet
  src/cron/*.ts           handlers logging their name
  src/observability/log.ts  structured JSON logger with request id
  test/workers/health.test.ts, do-ping.test.ts (each DO class answers ping and reports schema version 0; unique DO name per test), migrate-runner.test.ts (fresh DO gets user_version 0; upgrade path from a fake v0 to v1 in a test-only class)
.github/workflows/deploy-staging.yml   on push main: pnpm install, run packages/db migrate against NEON_STAGING_DIRECT_URL (skips with a warning if secret unset), cloudflare/wrangler-action deploy --env staging, curl /health
docs/adr/0004-hono-rpc.md
```

## Constraints
- New deps only: hono, @hono/zod-validator, wrangler (exact 4.135.0, matching the vitest plugin bundle), @cloudflare/vitest-plugin ~1.1.13, @cloudflare/workers-types, @sentry/cloudflare, plus `@planeahead/shared` and `@planeahead/db` workspace links. `postgres` is only imported inside `withDb` from packages/db.
- Never open a Postgres connection from a DO class (ADR 0007). ESLint rule from increment 1 must stay green.
- No provider calls, no auth, no flight routes yet.
- Vitest stays 4.1.x; Vitest 5 breaks the Workers pool.
- No em dashes. ESM.
