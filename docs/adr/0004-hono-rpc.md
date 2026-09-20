# 0004. Hono with an exported RPC type as the API framework

- Status: Accepted
- Date: 2026-09-20
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none

## Context

`apps/api` is a single Cloudflare Worker that serves the mobile client, receives provider
webhooks, consumes four queues and runs two cron triggers. `apps/mobile` is the only first-party
consumer of the HTTP surface and it is written in the same repository, in TypeScript, against the
same Zod contracts in `@planeahead/shared`. The routes are small in number (section 5 of the Phase
0 plan lists about fifteen) and the payloads are already typed, so the value of a framework here
is routing, middleware ordering and end-to-end types, not code generation or a plugin ecosystem.

Four facts constrain the choice, all verified on 2026-09-19 and recorded in
`docs/increments/04-api-bootstrap.facts.md`:

1. Hono's RPC types accumulate through the **return value** of `.route()`. Assigning the chained
   expression to `routes` and exporting `typeof routes` carries every route; two separate
   `app.route()` statements throw the earlier route types away and `hc<AppType>()` ends up with an
   empty surface. `.route()` returns the same instance at run time, so this is purely a typing
   discipline.
2. Middleware resolves strictly in registration order, and per-app `Variables` is the supported
   way to type `c.var`. Hono's own documentation warns that the global `ContextVariableMap` types
   variables as present on routes where the middleware never ran, which is exactly the bug an
   auth placeholder invites.
3. Sentry now ships `@sentry/hono`. Both Sentry guides say to install `@sentry/hono` and
   `@sentry/cloudflare` and use `sentry()` from `@sentry/hono/cloudflare` as middleware on top of
   `withSentry` on the default export; `@hono/sentry` (toucan-js) was last published 2025-06-09.
   The two packages share an internal core and must be pinned to the same version.
4. A Worker that declares Durable Object classes through the `exports` field cannot use gradual
   deployments. PlaneAhead carries five classes permanently, so the framework choice has to be
   one that is comfortable with plain `wrangler deploy` and no traffic splitting.

## Decision

We will use Hono 4.13 with one chained app whose type is exported as `AppType`, a per-app
`Variables` generic for `c.var`, and the middleware chain registered in the order request-id,
Sentry, CORS, rate-limit, idempotency, auth, then routes. `apps/mobile` will type its client with
`hc<AppType>()` against that export rather than against a generated schema.

## Consequences

- Easier: a route's response type reaches the mobile client through the type system with no build
  step, no OpenAPI document and no code generation. Adding `@hono/zod-validator` later gives
  request validation from the same `@planeahead/shared` schemas the client already imports.
- Easier: the middleware chain is one readable list, and the auth placeholder that sets
  `c.var.user = null` in increment 4 is replaced in increment 5 by editing one function rather
  than every call site.
- The chain lives in `createApp()` in `src/app.ts`, not inline in `src/index.ts`, and that is a
  correctness decision rather than a tidiness one. Registration order is a runtime contract: a
  middleware that reads `c.var.user` behaves differently depending on whether auth has run, and
  idempotency is pinned ahead of auth because it reads the body. A test that assembles its own
  chain in a different order tests a Worker that does not exist and stays green while the deployed
  one fails, which is exactly what happened in increment 4's first review. One definition, called
  by `src/index.ts` and by every test that needs the chain, is what makes that impossible.
  `src/index.ts` still owns the ROUTES, because only the chained `.route()` expression carries the
  RPC types.
- Follows from idempotency running before auth: `c.var.user` is `undefined`, not `null`, in every
  slot ahead of the auth middleware. Readers there use `c.var.user ?? null`. The `Variables`
  generic types the value as `AuthenticatedUser | null` and cannot express "not set yet", so this
  is a convention the tests enforce rather than a type the compiler checks.
- Harder: `AppType` is only correct if every route stays in the single chained expression in
  `src/index.ts`. That is a convention a reviewer has to enforce; nothing fails loudly when it is
  broken, the mobile client simply loses types. The comment at the top of `src/index.ts` says so.
- Harder: replacing Hono's default `onError` means reimplementing its `HTTPException` branch.
  Without it every 401, 403 and 413 that `hono/body-limit`, `hono/bearer-auth` or Better Auth
  signals by throwing collapses into an opaque 500. `handleError` in `src/app.ts` keeps the branch
  and answers 500 only for what is genuinely unhandled.
- Harder: a large `AppType` is a real cost to `tsserver`. Two of the mounts (`/api/auth` and
  `/v1`) use `app.all()` today, which contributes every HTTP method to the type surface. If the
  editor slows measurably once increments 5 to 8 fill them in, the fix is to narrow those mounts
  to an explicit method list or to exclude the Better Auth sub-app from the chained expression,
  since the mobile client uses better-auth's own client for those paths rather than `hc`.
- Commits us to Hono's middleware model for rate limiting, idempotency and auth, and to
  `@sentry/hono` plus `@sentry/cloudflare` moving together. Reversibility: medium. Replacing Hono
  would mean rewriting the middleware chain and the mobile client's transport, roughly a day, but
  the route handlers themselves are thin.

## Alternatives considered

| Option                                                                  | Why not                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A hand-rolled router on `fetch`                                         | Fifteen routes is enough to want parametrised paths, a middleware chain and parametrised Sentry transaction names. Writing that is a day, and the end-to-end types would have to be hand maintained.                                                                                                           |
| itty-router                                                             | Smaller, but no typed client story and no first-party Sentry integration; we would rebuild `hc` ourselves.                                                                                                                                                                                                     |
| tRPC                                                                    | Better types than `hc`, but it is not an HTTP API: the provider webhooks and the Apple and Google native auth callbacks are plain HTTP from third parties, so we would run two servers.                                                                                                                        |
| OpenAPI first (`@hono/zod-openapi` or an external spec plus generation) | The only client is in this repository. A generated client adds a build step and a second source of truth for the same Zod schemas. Worth revisiting if a third party ever consumes the API.                                                                                                                    |
| `experimental.newConfig` with `cloudflare.config.ts`                    | New in @cloudflare/vitest-plugin 1.1.0 and explicitly experimental, so it may change without a major version bump. It does not support wrangler environments or `wrangler types`, and this Worker depends on `env.staging` and `env.production`. Rejected for Phase 0; recorded here so it is not relitigated. |
| `@hono/sentry`                                                          | toucan-js based, last published 2025-06-09, and Sentry's own Hono guide now points at `@sentry/hono`.                                                                                                                                                                                                          |
| Gradual deployments for the API Worker                                  | Not available: Cloudflare documents gradual deployments as unsupported for a Worker that declares `exports`, and the five Durable Object classes are permanent. Staging and production both use plain `wrangler deploy`.                                                                                       |

## Testing note: `SELF` is deprecated

`@cloudflare/vitest-plugin` 1.1.13 marks both `SELF` and `env` from `cloudflare:test` as
`@deprecated`, pointing at `import { exports, env } from "cloudflare:workers"` and
`exports.default.fetch()`. The Workers tests in `apps/api/test/workers` use the new form. They
still import `runInDurableObject`, `runDurableObjectAlarm`, `listDurableObjectIds`,
`createMessageBatch` and `getQueueResult` from `cloudflare:test`, which are not deprecated. The
pool's own helpers are the only remaining reason to import that module.

`defineWorkersConfig` and `defineWorkersProject` were removed in the same major, as were the
`isolatedStorage` and `singleWorker` options; storage isolation is now per test file and
automatic, which is why every Durable Object test uses a unique object name.

## The Durable Object migration runner

A related decision, recorded here rather than in its own ADR because it is a consequence of the
same increment. `PRAGMA user_version` is not available in Durable Object SQLite storage: workerd's
SQLite authorizer allowlists pragmas by name and `user_version` is not on the list. Cloudflare's
documented replacement is an ordinary table written by the object in its constructor under
`blockConcurrencyWhile`, which is what `src/do/migrate.ts` does with `_sql_schema_migrations
(id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`.

We wrote the roughly forty line runner by hand rather than taking `durable-utils` or
`@cloudflare/actors`. The trade-off is owning and testing the rollback semantics ourselves against
a closed dependency budget and two more packages in the supply chain. The rollback behaviour is
the part that had to be tested either way, and `test/workers/migrate-runner.test.ts` tests it
against real Durable Object storage.

## References

- Hono RPC, chained `.route()`: https://hono.dev/docs/guides/rpc
- Hono context and `Variables` versus `ContextVariableMap`: https://hono.dev/docs/api/context
- Sentry for Hono on Cloudflare: https://docs.sentry.io/platforms/javascript/guides/cloudflare/frameworks/hono/
- Sentry options, `sendDefaultPii` and `beforeSend`: https://docs.sentry.io/platforms/javascript/guides/cloudflare/configuration/options/
- Durable Object migrations and the `exports` field: https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
- Rules of Durable Objects (no `PRAGMA user_version`): https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Vitest 3 to Vitest 4 plugin migration: https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-from-vitest-3-to-vitest-4/
- `docs/increments/04-api-bootstrap.facts.md`, every fact above with its verification date.
