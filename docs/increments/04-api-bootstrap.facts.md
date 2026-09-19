# Increment 4 facts (verified 2026-09-19)

Every fact below was checked against a primary source on 2026-09-19. Facts marked **(unverified)** could not be confirmed from a primary source. **SPEC CONFLICT** marks a contradiction with `/Users/jkowall/PlaneAhead/docs/increments/04-api-bootstrap.md` or `/Users/jkowall/PlaneAhead/docs/plans/phase0-plan.md`.

## Durable Objects

- **SPEC CONFLICT (hard).** `PRAGMA user_version` is not supported by DO SQLite storage: "You must use an alternative approach to track your schema version." Breaks spec line 33, plan line 68, plan line 95, and `migrate-runner.test.ts`. (https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- Root cause: workerd's SQLite authorizer allowlists pragmas by name in `ALLOWED_PRAGMAS`; `user_version` is absent, so both reads and writes fail. `ctx.storage.sql.exec` is not the trusted regulator. (https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/util/sqlite.c%2B%2B)
- Documented replacement: a `_sql_schema_migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))` table written by the DO in its constructor under `ctx.blockConcurrencyWhile()`. Version probe becomes `SELECT MAX(id)`. (same URL)
- `blockConcurrencyWhile()` in the constructor is the documented migration pattern; a throwing callback terminates and resets the object, and a 30 second timeout applies. (https://developers.cloudflare.com/durable-objects/api/state/)
- `ctx.storage.transactionSync(cb)` is SQLite-only, rolls back on throw, and "The callback must complete synchronously". (https://developers.cloudflare.com/durable-objects/api/storage-api/)
- The `exports` field is real and documented as preferred over `migrations` for new Workers; the two are mutually exclusive. Storage enum is exactly `["sqlite", "legacy-kv"]`. (https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- `exports` does **not** create the env binding. `durable_objects.bindings` is still required alongside it. Verified from wrangler 4.135.0 `cli.js` (`getDurableObjectExports`, `validateDurableObjectBinding2`).
- `exports` is an **inheritable** key; `durable_objects.bindings`, `kv_namespaces`, `r2_buckets`, `queues`, `hyperdrive`, `analytics_engine_datasets`, `ratelimits` and `vars` are not and must be redeclared per environment. (https://developers.cloudflare.com/workers/wrangler/configuration/)
- Local dev support for `exports` in `wrangler dev` and the Vitest pool exists in wrangler 4.135.0 source but is **(unverified)** against any Cloudflare doc.
- Alarms: at-least-once, retried on uncaught exception "using exponential backoff, starting at 2 second delays for up to 6 retries". `alarmInfo` is optional, so null-guard `alarmInfo?.retryCount`. (https://developers.cloudflare.com/durable-objects/api/alarms/)
- `deleteAll()` clears a pending alarm from compatibility date 2026-02-24 onward, so the spec's 2026-09-01 date gets this for free. (https://developers.cloudflare.com/durable-objects/api/storage-api/)
- Limits: 10 GB per object, 2 MB max row, **100 KB max SQL statement length** (not mentioned in spec or plan, and directly relevant to a migration runner). (https://developers.cloudflare.com/durable-objects/platform/limits/)
- **SPEC CONFLICT (soft, plan line 104).** "DOs cannot be enumerated in production" is too strong: there is no runtime API, but the control-plane REST API lists object IDs. The Postgres registry conclusion still holds; reword to "cannot be enumerated by name from the Worker runtime". (https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/)
- `locationHint` is an option on `get()` / `getByName()`, not `idFromName`, and only the first `get()` for an object respects it. Plan line 267's `'enam'` is valid. (https://developers.cloudflare.com/durable-objects/reference/data-location/)
- RPC serialized limit is 32 MiB, not 1 MB. (https://developers.cloudflare.com/workers/runtime-apis/rpc/)
- **(unverified)** Whether `setAlarm` may be called inside `transactionSync`, and whether the alarm write is covered by rollback. Two signatures are documented (void on the alarms page, Promise on the storage-API page). Plan section 5 puts it inside the transaction.

## Vitest plugin

- **SPEC CONFLICT (line 27).** `defineWorkersConfig` and `defineWorkersProject` were removed. The only supported shape is `cloudflareTest()` as a plugin inside `defineConfig` from `vitest/config`. (https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/)
- **SPEC CONFLICT (line 27).** `isolatedStorage` and `singleWorker` were removed; storage isolation is now per test file and automatic. (same URL)
- **SPEC CONFLICT (lines 8, 37; plan line 210).** `SELF` and `env` from `cloudflare:test` are both `@deprecated` in 1.1.13. Use `import { exports, env } from "cloudflare:workers"` and `exports.default.fetch()`. Still functional, so this is lint-level. (packages/vitest-plugin/types/cloudflare-test.d.ts, https://github.com/cloudflare/workers-sdk)
- **SPEC CONFLICT (line 8, real breakage).** `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` is read only by the `wrangler dev` command. The Vitest plugin ignores it. Under `pnpm test` the connection string must come from `localConnectionString` or a `miniflare.hyperdrives` override. (wrangler `src/dev.ts` `applyHyperdriveEnvVars`; first-party fixture at `fixtures/vitest-plugin-examples/hyperdrive`)
- **PLAN CONFLICT (line 25).** workers-sdk#10275 is closed, closed by the reporter, who found the timeout was `vi.useFakeTimers()` interfering with postgres-js, not a runtime defect. The DO-to-outbox rule stands on alarm-retry and connection-count grounds; the citation should go. (https://github.com/cloudflare/workers-sdk/issues/10275)
- Vitest 5 breaks the pool; workers-sdk#15618 is open. Peer range is `^4.1.0` for vitest, `@vitest/runner` and `@vitest/snapshot`. (https://github.com/cloudflare/workers-sdk/issues/15618)
- `fetchMock` is no longer exported from `cloudflare:test`. Not needed in increment 4, but blocks plan section 14's provider adapter mocks later.
- Helpers present in 1.1.13: `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject`, `listDurableObjectIds`, `createMessageBatch`, `getQueueResult`, `reset`. Do not pin below 1.1.2, which fixed a stack overflow in tests that repeatedly reconstruct the same DO.
- Known issues that bite here: fake timers do not reach the KV, R2 or cache simulators; dynamic `import()` does not work inside DO event handlers or `export default` handlers, so `src/do/migrate.ts` must be statically imported. (https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/)
- **(unverified)** Whether a DO alarm left scheduled in a test fires on its own wall-clock. Keep the `afterEach` drain regardless.

## Hono, Zod, Sentry

- `hono` latest is 4.13.8 (2026-09-15); `@hono/zod-validator` 0.9.1 peers `hono >=4.11.2` and `zod ^3.25.0 || ^4.0.0`. (https://registry.npmjs.org/hono, https://registry.npmjs.org/@hono/zod-validator/latest)
- `@hono/zod-validator` branches internally on `zod/v3` vs `zod/v4`; use the plain `zod` import. `z.looseObject()` is the primitive for plan section 5's unknown-field tolerance. (https://zod.dev/api?id=objects)
- RPC: export the type of the **chained** app (`const routes = app.route(...).route(...); export type AppType = typeof routes`). Separate `app.route()` statements lose route types. (https://hono.dev/docs/guides/rpc)
- Middleware resolves strictly in registration order, so `app.use()` for request-id, sentry, rate-limit, idempotency, auth must precede route registration. Type `c.var` with the per-app `Variables` generic, not `ContextVariableMap` (the docs warn the global map types vars as present on routes where the middleware never ran). (https://raw.githubusercontent.com/honojs/website/main/docs/api/context.md)
- **SPEC CONFLICT (line 31).** Sentry now ships `@sentry/hono`. Both guides say install `@sentry/hono` and `@sentry/cloudflare` and use `sentry(app, options)` from `@sentry/hono/cloudflare` as the first middleware, on top of `withSentry` on the default export. (https://docs.sentry.io/platforms/javascript/guides/cloudflare/frameworks/hono/)
- **SPEC CONFLICT (soft, line 31).** `sendDefaultPii` already defaults to `false` and is deprecated in favor of `dataCollection`. Keep it for auditability with a comment. (https://docs.sentry.io/platforms/javascript/guides/cloudflare/configuration/options/)
- `beforeSend(event, hint)` must mutate and return `event`; scope changes inside it are no-ops. This constrains the header and body scrubber. (same URL)
- Do not use `@hono/sentry` (toucan-js, last published 2025-06-09).
- **(unverified)** Whether `@sentry/cloudflare` exports `instrumentDurableObjectWithSentry`. Do not write DO instrumentation into increment 4.

## Bindings, limits, config

- `ratelimits` uses a top-level array with required `name`, `namespace_id`, `simple { limit, period }`; `period` is hard-enumerated to 10 or 60. All three spec limiters are valid. Requires wrangler >= 4.36.0. (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- **Risk, not yet a conflict.** Bindings sharing a `namespace_id` share counters across Workers on one account. Staging and production must get distinct integers, or staging load burns production budget. (same URL)
- Rate limits are per-colo and "intentionally designed to not be used as an accurate accounting system". Do not assert a global rate in tests.
- Analytics Engine cap is **250** data points per Worker invocation, so the spec's 200-point chunk is correct; the "25" in the research brief appears nowhere. 20 blobs / 20 doubles / 1 index, 16 KB blobs, 96 byte index, 3 month retention. `writeDataPoint()` is not async and must not be awaited or wrapped in `waitUntil`. (https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- **SPEC CONFLICT (line 24, wording).** `triggers.crons` needs five-field expressions: `"*/15 * * * *"` and `"0 3 * * *"`, not `*/15` and `0 3`. (https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- **PLAN RISK.** A Cron Trigger with an interval under 1 hour gets 30 seconds of CPU on Paid, not 15 minutes. The `*/15` reconcile must page and fan out to a queue. (https://developers.cloudflare.com/workers/platform/limits/)
- Queues caps: 128 KB message, `max_batch_size` <= 100, `max_batch_timeout` <= 60, `max_retries` <= 100, `max_concurrency` <= 250. A thrown handler retries the whole batch, so ack per message. (https://developers.cloudflare.com/queues/platform/limits/)
- Hyperdrive binding accepts only `binding`, `id` (required) and `localConnectionString`. Limits: ~100 origin connections on Paid, 60 second max query duration. (https://developers.cloudflare.com/hyperdrive/configuration/local-development/)
- **SPEC NOTE (line 16).** `nodejs_compat` and `nodejs_compat_v2` are on by default from compatibility date 2026-08-04, so the explicit flag at 2026-09-01 is a harmless no-op that hides the v2 semantics. (https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
- `--env staging` deploys a **separate Worker** named `planeahead-api-staging`, with its own DO namespaces and secrets. (https://developers.cloudflare.com/workers/wrangler/environments/)
- **(unverified)** Whether rate limiting bindings are enforced in the Workers test pool. The `routes.test.ts` 429 assertion may be vacuous; check early.
- **(unverified)** Whether the 250-point AE cap applies to `queue()` and `alarm()` invocations, since the docs say "per Worker invocation (client HTTP request)".

## Deploy mechanics

- **PLAN CONFLICT (line 204).** Docs gate `versions upload` on the **presence** of `exports`, not on a change to it: "Gradual deployments are not supported with `exports`." PlaneAhead carries five DO classes permanently, so the plan's `else` branch is unreachable. (https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- wrangler 4.135.0 source disagrees with that sentence: it forwards `exports` on upload and only throws for a pending legacy `migrations` array. **(unverified)** end to end without a real account.
- `wrangler deploy --dry-run` needs no auth in 4.135.0 (`accountId` is `undefined` when dry-running), so the CI gate works credential-free. But it only parses config, bundles and prints bindings. It does **not** verify that KV ids, the Hyperdrive id, R2 buckets or queues exist. Spec line 10 overstates it. (workers-sdk `merge-config-args.ts`, `deploy.ts` @ wrangler@4.135.0)
- Queues must exist before deploy or wrangler errors `Queue "<name>" does not exist`. Deploy also calls account-scoped Queues APIs, so the token needs **Account > Queues > Edit**, which the "Edit Cloudflare Workers" template does not include. (workers-sdk `triggers/queue-consumers.ts`; https://developers.cloudflare.com/fundamentals/api/reference/template/)
- Custom domains: `{"pattern": "api.planeahead.app", "custom_domain": true}`. Cloudflare creates DNS and certificates automatically; needs Zone > Workers Routes > Write, not DNS edit. Blocked by any pre-existing CNAME on the hostname. (https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- `wrangler-action` is at v4.0.0 (2026-05-12) and defaults to wrangler "4"; set `wranglerVersion: 4.135.0`. Its `secrets` input runs `wrangler secret bulk`, rewriting secrets and creating a new version on every run. Leave it empty and set secrets out of band. (https://raw.githubusercontent.com/cloudflare/wrangler-action/main/src/wranglerAction.ts)
- `.dev.vars.<env>` fully replaces `.dev.vars`, it does not merge. (https://developers.cloudflare.com/workers/development-testing/environment-variables/)
- Workers Logs: 7 day retention on Paid, 20M events included, then $0.60/M. Production at 0.1 sampling stays inside the allotment to roughly 100M requests/month. (https://developers.cloudflare.com/workers/platform/pricing/#workers-logs)
- **(unverified)** Whether a Hyperdrive binding needs any deploy-time permission. Confirm on the first staging deploy with a minimally scoped token.

## Decisions the orchestrator must take

1. **Replace `PRAGMA user_version` with a `_sql_schema_migrations` table.** Recommend the hand-rolled ~20 line version over `durable-utils` or `@cloudflare/actors`; trade-off is writing and testing the runner yourself instead of importing a maintained one, against a closed dependency budget.
2. **Keep both `exports` and `durable_objects.bindings`, declare `exports` once at the top level.** Recommend inheriting `exports` rather than repeating it per environment; trade-off is slightly less explicit env blocks against two copies of a one-way-door declaration that can drift.
3. **Use plain `wrangler deploy --env <env>` for staging and production and delete the plan's conditional.** Recommend this for all of Phase 0; trade-off is losing gradual rollout, which `exports` forbids anyway.
4. **Soften spec line 10's dry-run claim and treat the first staging deploy as the real binding check.** Recommend keeping the dry run as the CI gate; trade-off is that wrong resource ids surface minutes later rather than in CI.
5. **Give the Vitest config its own `miniflare.hyperdrives` override reading `process.env`.** Recommend this now; trade-off is duplicating the connection string in two places versus a Hyperdrive binding that is silently unconfigured under `pnpm test`.
6. **Switch route tests to `exports.default.fetch()` and `env` from `cloudflare:workers`.** Recommend doing it while the test file is 30 lines; trade-off is diverging from the plan's written `SELF.fetch` wording.
7. **Add `@sentry/hono` and use `sentry()` middleware plus `withSentry`.** Recommend it for Hono route and span context; trade-off is one extra dependency against the spec's closed budget.
8. **Assign distinct `ratelimits` `namespace_id` values per environment, and expand crons to five fields.** Recommend both unconditionally; no trade-off, these are silent bugs otherwise.
9. **Add Account > Queues > Edit to the deploy token and create all queues plus DLQs before first deploy.** Recommend adding it to the owner prerequisite list on spec line 4; trade-off is a broader token than the Cloudflare template.
10. **Spike `exports` under `wrangler dev` and the Vitest pool before writing any DO logic.** Recommend a 10 minute check first; trade-off is a small delay against discovering a local-dev gap at the end of the increment.
11. **Decide what `/health`'s `doSchemaVersions` reports.** Recommend the compiled-in `static SCHEMA_VERSION`; trade-off is reporting intent rather than applied state, against instantiating five DOs on every health check.

## Pins

| Package | Version |
| --- | --- |
| wrangler | 4.135.0 (exact) |
| @cloudflare/vitest-plugin | 1.1.13 (exact) |
| vitest | 4.1.11 (exact, V4 dist-tag) |
| @vitest/runner | 4.1.11 (exact) |
| @vitest/snapshot | 4.1.11 (exact) |
| hono | ^4.13.8 |
| @hono/zod-validator | ^0.9.1 |
| zod | ^4.6.5 |
| @sentry/cloudflare | 10.75.0 (exact) |
| @sentry/hono | 10.75.0 (exact, must match) |
| cloudflare/wrangler-action | v4.0.0, `wranglerVersion: 4.135.0` |
| miniflare / workerd | not direct deps; arrive as 5.20260918.0-alpha / 1.20260918.1 |

CI `toolchain-guard` should assert the pair rather than a frozen constant: compare `require('@cloudflare/vitest-plugin/package.json').dependencies.wrangler` against `require('wrangler/package.json').version`, and assert the resolved vitest major is 4. `hono@4.13.8` is four days old, so confirm pnpm 12's default `minimumReleaseAge` does not block the install.

## Appendix: open questions per research topic

### durable-objects (25 facts, 0 unverified)

- Plan section 5 puts `setAlarm(nextTierSlot)` inside the `transactionSync` block in the FlightTracker alarm handler. `transactionSync`'s callback must complete synchronously, but the storage-API form of `setAlarm(scheduledTime, options)` is documented as returning a Promise (the alarms page documents a void-returning `setAlarm(scheduledTimeMs)`). I could not verify from docs whether calling setAlarm inside transactionSync is legal, whether the alarm write is covered by the transaction's rollback, or which of the two documented signatures is authoritative. Decide this before increment 7: either move setAlarm outside the transaction and make the handler tolerant of a rearm that never happened (the reconcile cron already covers that), or prove the behavior with a spike test.
- Does `wrangler dev` and `@cloudflare/vitest-plugin` actually honour the `exports` map end to end, including creating SQLite-backed local storage for a class declared only there? The code path exists in wrangler 4.135.0, but no Cloudflare doc states local-dev support, and the Vitest known-issues page discusses only `ctx.exports` inference, not the config field. Needs a 10-minute spike.
- What does `/health`'s `doSchemaVersions` report for a DO class that has never been instantiated? Reading a per-class version requires touching an object, which creates it. The spec should say whether /health reports the compiled-in `static SCHEMA_VERSION` (cheap, no object creation) or the applied version from a live object (accurate, but instantiates five DOs on every health check and will be rate-limit relevant once the smoke step runs on every deploy).
- Does the plan intend `locationHint: 'enam'` to be passed at every `get()`/`getByName()` call site for FlightTracker and UserInbox, or only on a designated creation path? Since only the first get() for a given object respects the hint and there is no separate create call, the hint must be on the call site that first touches the object, which in practice means all of them.
- The 100 KB maximum SQL statement length is not mentioned anywhere in the plan or the increment 4 spec. Confirm whether any per-class migration step in the eventual FlightTracker schema (nine tables) approaches it, and whether the runner should split multi-statement migration files rather than passing one large string to `sql.exec`.

### vitest-plugin (25 facts, 2 unverified)

- Do Durable Object alarms scheduled during a test fire on their own when wall-clock time reaches them, or only via runDurableObjectAlarm? Neither the current test-apis page nor the known-issues page answers this, and the plugin source contains no alarm suppression. An older docs snippet warns about rogue alarms firing later. Resolve by writing a throwaway test that schedules an alarm 200 ms out and asserts whether the handler runs, before committing to the afterEach drain as the only guard.
- Does the increment 4 test suite need a live Postgres at all? If the DO tests never touch Hyperdrive (per ADR 0007) and /health does not query the DB, the Hyperdrive binding may only need a syntactically valid connection string that is never dialled, which would remove the Postgres 18 service container from the test-workers CI job. Worth deciding before writing vitest.config.ts.
- Which mechanism replaces fetchMock for mocking outbound fetch inside the Workers pool? It was removed in v1 and plan section 14 assumes undici MockAgent, which is Node-side only. This does not block increment 4 but blocks the provider adapter tests in a later increment.
- Should apps/api adopt experimental.newConfig with cloudflare.config.ts instead of wrangler.jsonc? It is new in plugin 1.1.0, is explicitly experimental and may change without a major bump, and does not yet support wrangler environments or type generation. Since the spec depends on env.staging and env.production blocks, the answer is almost certainly no for Phase 0, but it should be recorded as a rejected option in ADR 0004 so it is not relitigated.
- Does pnpm 12 with the isolated linker auto-install the @vitest/runner and @vitest/snapshot peers, or must they be explicit devDependencies of apps/api? The plugin source carries a comment about pnpm resolving a separate Vitest copy and inject key inference collapsing to never, which suggests the isolated linker has caused real problems here. Verify on first install.

### hono-rpc-zod4 (22 facts, 2 unverified)

- hono 4.13.8 was published 2026-09-15, four days ago. pnpm-workspace.yaml has a `minimumReleaseAgeExclude` list but no explicit `minimumReleaseAge`, which implies a pnpm 12 default is in force. If that default is 7 days, `pnpm add hono@4.13.8` will be blocked in increment 4 and will need either an exclude entry or a drop to 4.13.7. Confirm pnpm 12's default minimumReleaseAge before the install step.
- Does @sentry/cloudflare 10.75.0 export `instrumentDurableObjectWithSentry`, and what is its exact signature? The Cloudflare APIs docs page does not list it. This blocks nothing in increment 4 (DO classes are shells) but must be settled before increment 7 wires FlightTracker.
- Should `sentry()` from @sentry/hono/cloudflare sit before or after the request-id middleware? The Sentry docs say "as early as possible... before any route", but the spec wants the request id on every Sentry event. Likely answer is request-id first, then sentry, with the request id attached via a tag inside beforeSend or a setTag in the request-id middleware, but the interaction with `withSentry`'s isolation scope is not documented on the pages I read.
- Does `app.all()` on the Better Auth mount degrade AppType? An `all` route contributes every HTTP method to the RPC type surface. If that measurably slows tsserver, consider narrowing to `app.on(['GET','POST','OPTIONS'], ...)` despite the docs, or excluding the auth sub-app from the chained `routes` used for AppType since the mobile client uses better-auth's own client, not hc, for those paths.
- Sentry's `dataCollection` option replaces `sendDefaultPii` in the next major. Its exact shape (boolean vs object) was not on the Cloudflare options page I fetched, so the ADR cannot yet state the migration target precisely.
- packages/shared will export Zod schemas consumed by both apps/api (Workers) and apps/mobile (Hermes). Confirm zod 4.6.5's ESM build and the `zod/v4/core` subpath resolve cleanly under Metro with pnpm's isolated linker before increment 9; nothing in the Hono or Zod docs covers that combination.

### bindings-and-limits (42 facts, 0 unverified)

- The Analytics Engine 250-point cap is documented as "per Worker invocation (client HTTP request)". No Cloudflare page states whether the same cap applies to a queue() consumer invocation, a scheduled() invocation or a Durable Object alarm(). The persist consumer writes AE points from a queue invocation, so this is directly load-bearing. The 200-point chunk is safe either way, but if a batch ever needs more than 250 points the behavior is unknown.
- The allowed range for wrangler hyperdrive create --origin-connection-limit is not documented on the commands page, the configuration pages, or the limits page. The limits page gives an approximate ceiling (~100 on Paid) but no minimum and no explicit validation range. Determine empirically when creating the config, or leave the flag unset and accept the default.
- Whether the rate limiting binding is emulated in local wrangler dev and under @cloudflare/vitest-plugin is not documented on the rate-limit page. The spec's routes.test.ts asserts a 429, so confirm early whether env.PUBLIC_RL.limit() actually enforces in the Workers test pool or always returns success true, otherwise that test is vacuous.
- The default Queues message retention period is stated as configurable up to 14 days (24 hours on Free), but the default value for a Paid-plan queue is not given. Relevant to how long a DLQ can sit unprocessed before the persist outbox loses messages.
- The compatibility-dates docs page does not explicitly document what happens when compatibility_date is newer than the deployed runtime. The behavior (wrangler warning plus fallback locally, ERR_FUTURE_COMPATIBILITY_DATE from workerd) comes from cloudflare/workers-sdk issues, not from primary documentation. Not blocking, since 2026-09-01 is safely in the past relative to workerd 1.20260918.1.
- The public wrangler configuration docs page does not list ratelimits in either the inheritable or non-inheritable key lists. Its non-inheritance is confirmed only from the JSON Schema shipped inside wrangler 4.135.0. If a future wrangler changes this, the config would silently lose rate limiting in named environments, so the deploy dry-run should assert the bindings are present per environment.

### deploy-mechanics (28 facts, 2 unverified)

- Does `wrangler versions upload` actually fail when `exports` is present? The docs say it fails fast; the wrangler 4.135.0 source forwards `exports` with SkipDeploy:true and only throws for a pending legacy `migrations` array. This needs one empirical run against the real Cloudflare account, and the answer decides whether deploy-production.yml can ever use the versions path.
- Is there any documented list of non-DO configuration changes that cannot go through `versions upload` (bindings added or removed, cron triggers, routes, compatibility_date, observability, placement, tail consumers, limits)? I found none on the versions-and-deployments, gradual-deployments or deployment-management pages. Treat 'bindings changes are blocked from versions' as unverified until Cloudflare documents it.
- Does deploying a Hyperdrive binding require any account permission beyond Workers Scripts Edit? No docs page states it, and no Hyperdrive API call appears in the wrangler deploy path, but the Queues counterexample shows the general 'no separate permissions on bound resources' rule is not reliable. Confirm on the first staging deploy with a minimally scoped token.
- What DNS record type does Cloudflare create for a Workers custom domain, and does it conflict with an existing A or AAAA record as well as a CNAME? Docs only state that a CNAME on the hostname blocks creation.
- Does the Analytics Engine binding or the rate limit binding require any deploy-time API call or permission? Neither appears in the wrangler deploy triggers path, but I did not exhaustively audit every binding provisioning branch in provision-bindings.ts.
- Should staging and production use separate API tokens? Both Workers live in one Cloudflare account, so account-scoped tokens cannot separate them. Cloudflare shipped granular per-Worker permissions on 2026-09-15 (https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/), which may allow a staging-only deploy token. I did not verify whether that mechanism is usable from an API token in a GitHub Actions context.

