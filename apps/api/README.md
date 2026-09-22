# @planeahead/api

The PlaneAhead API: one Cloudflare Worker that serves the HTTP surface, owns five Durable Object
classes, consumes four queues and runs two cron triggers. The design is in
[docs/plans/phase0-plan.md](../../docs/plans/phase0-plan.md) section 5; the framework decision and
the Durable Object migration runner are in [ADR 0004](../../docs/adr/0004-hono-rpc.md).

Increment 4 is the bootstrap: the middleware chain, `GET /health`, the Durable Object shells and
the queue and cron skeletons. Increment 5 adds authentication (Better Auth 1.7.5: anonymous,
magic link, native Apple, native Google, the Expo transport), the envelope-encryption module,
`POST /v1/devices`, `GET /v1/me` and `PATCH /v1/me/preferences`. Provider calls and the flight
routes arrive in increments 6 to 8, and every path they will own answers `501` with the increment
that owns it. The auth design is in [docs/increments/05-auth.md](../../docs/increments/05-auth.md)
and its threat model in [docs/security/threat-model.md](../../docs/security/threat-model.md).

## Commands

```sh
pnpm --filter @planeahead/api test              # Vitest in the Workers pool, embedded Postgres 18
pnpm --filter @planeahead/api run typecheck
pnpm --filter @planeahead/api run dev           # wrangler dev on http://localhost:8787
pnpm --filter @planeahead/api run cf-typegen    # regenerate worker-configuration.d.ts
pnpm --filter @planeahead/api exec wrangler deploy --dry-run --env staging
```

`dev`, `test` and `typecheck` all run `scripts/gen-migration-hash.mjs` first, which rewrites
`src/generated/migration-hash.ts` from `packages/db/migrations/meta/_journal.json`. That file is
committed; CI runs the script with `--check` and fails if it is stale.

## Local development

Copy `.dev.vars.example` to `.dev.vars` and point
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` at your own Neon branch. There is no local
Postgres and no Docker in this project.

Two things about `.dev.vars` are easy to get wrong:

- `.dev.vars.<environment>` **replaces** `.dev.vars` entirely when you pass `--env <environment>`.
  It does not merge, so a `.dev.vars.staging` has to repeat every line it needs.
- `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` is read by the `wrangler dev` command only.
  The Vitest plugin ignores it. Under `pnpm test`, `test/globalSetup.ts` starts an embedded
  PostgreSQL 18 cluster (or uses `TEST_DATABASE_URL`, which CI points at a `postgres:18` service
  container), migrates a database and hands its URL to the pool through `miniflare.hyperdrives`;
  the `localConnectionString` in `wrangler.jsonc` is a placeholder the suite never dials.
- Secrets under test come from `.dev.vars.test`, which is committed on purpose: every value in it
  is a generated dummy (a throwaway P-256 key, a KEK that wraps nothing outside the suite). Never
  copy a real value into it. Every secret the Worker reads must be listed in `.dev.vars.example`
  and given a dummy in `.dev.vars.test`; `test/workers/secrets-in-logs.test.ts` enforces both.
- `wrangler dev --env staging` **requires** that variable. `localConnectionString` is declared
  only on the top-level Hyperdrive binding, and the environment blocks do not inherit it, so
  without the variable wrangler refuses to start with "you should use a local Postgres connection
  string to emulate Hyperdrive functionality". The top-level (local) config needs no variable
  because it carries a `localConnectionString` of its own.

## Layout

```
src/index.ts              the routes as ONE chain, the five DO exports, the default export
src/app.ts                createApp(): the error handlers and the middleware chain, one definition
src/env.ts                Env (from worker-configuration.d.ts) plus the Variables for c.var
src/middleware/           request-id, sentry, cors, rate-limit, idempotency, auth  (in that order)
                          plus magic-link-cap (per-address caps ahead of Better Auth)
src/auth/                 create-auth.ts (the per-request Better Auth instance), plugin.ts (the
                          native Apple and Google endpoints), merge.ts (anonymous upgrade), runtime.ts
src/crypto/               envelope.ts, key-provider.ts, hash.ts
src/mail/                 sender.ts (MailSender, the magic-link message), resend.ts, noop.ts,
                          cloudflare-email.ts (implementation only, never wired)
src/routes/               health.ts, auth.ts (/api/auth), v1.ts (/v1: devices.ts, me.ts, the stub)
src/do/                   migrate.ts (the SQLite schema runner), base.ts, the five classes
src/queues/               index.ts dispatch, consume.ts (per-message ack), analytics.ts, consumers
src/cron/                 index.ts dispatch, reconcile.ts, housekeeping.ts
src/observability/log.ts  structured JSON logging with the request id
test/workers/             everything that drives the Worker, inside workerd
test/unit/                pure WebCrypto and jose tests, ALSO inside workerd (that is the point:
                          they settle facts about the runtime, not about Node)
test/globalSetup.ts       embedded Postgres, the fake Apple/Google/Resend server, .dev.vars.test
```

## Rules that are not obvious from the code

**`AppType` is the type of the chained app.** Hono accumulates RPC types through the return value
of `.route()`. Add a route to the chain in `src/index.ts`; a separate `app.route(...)` statement
compiles, runs correctly and silently empties the type the mobile client is built from.

**Middleware order is the contract, and it has exactly one definition.** request-id first so
everything after it can correlate, Sentry second so events carry the id, CORS third so a preflight
is answered before anything can reject it, then the rate limit brake, then idempotency (it reads
the body), then auth. `registerChain()` in `src/app.ts` is the only place `use()` is called on the
root app, and every test that needs the chain calls `createApp()` rather than assembling its own.
A test that builds the chain by hand does not test this Worker, it tests one that does not exist:
increment 4's first review found a 500 on every keyed `POST` that three middleware test files had
been reproducing in the opposite order, and staying green about.

What follows from idempotency running BEFORE auth: nothing in a slot ahead of auth may assume
`c.var.user` has been assigned. It is `undefined` there, not `null`, so every reader uses
`c.var.user ?? null` (`storeFor`, `scopeFor`, `principalLimiter`, `requireUser`).

**A keyed anonymous request needs `X-Install-Id`.** Idempotency runs ahead of auth, so in the
global chain it never sees a user and needs something the CLIENT owns to scope a key by. The app
sends its install id (the value `POST /v1/devices` registers in increment 5) on every request; a
mutating request that carries `Idempotency-Key` without it, or with a malformed one, is answered
400 `idempotency_scope_missing` rather than run unprotected. The client IP was rejected as the
scope: it changes when a phone moves from WiFi to LTE mid-retry, which is the retry the key exists
to make safe, and behind a carrier NAT two phones share one. In the global slot the store is the
in-memory map; the Postgres store and the per-user scope in `idempotency.ts` are for the `/v1`
mount behind auth in increment 8 and are never taken before then.

`app.onError` and `app.notFound` are registered **before** the Sentry middleware: `withSentry`
wraps whatever `app.errorHandler` is at the moment it runs, and a later `app.onError()` replaces
the wrapper and stops the reporting. `handleError` keeps Hono's `HTTPException` branch, without
which every 401, 403 and 413 a middleware signals by throwing becomes an opaque 500.

**Durable Objects are declared through `exports` in `wrangler.jsonc`, and that is a one-way door.**
`exports` and a `migrations` array are mutually exclusive; this repository has no `migrations`
array and never will. `exports` is inheritable, so it is declared once at the top level, but it
does **not** create the binding: `durable_objects.bindings` is not inheritable and is repeated in
every environment block, as is every other non-inheritable key.

**No `PRAGMA user_version`.** It is not available in Durable Object SQLite storage. Schema
versions live in `_sql_schema_migrations`, written by `src/do/migrate.ts` in the constructor under
`blockConcurrencyWhile`. Migrations are append only: one array entry per migration, one statement
per `sql.exec` (100 KB per statement), the id row inserted inside the same `transactionSync`.
Foreign keys are enforced by default here, unlike a bare `sqlite3` CLI.

**A Durable Object never opens Postgres** (ADR 0007). Objects write their own SQLite storage and
append to an outbox; the `persist` queue consumer is the only writer of flight state.

**A thrown queue handler retries the whole batch.** Every consumer acknowledges per message inside
its own try/catch through `consumeBatch`, and `queue()` never throws.

**`writeDataPoint` is synchronous and throws on an oversized point.** Use `AnalyticsBudget`, one
per invocation, which caps at 200 points against the documented 250 and wraps every write. It
counts a missing binding as `skipped`, not `failed`: one is a wrangler.jsonc mistake and the other
is a payload bug, and they want opposite responses.

**Sentry needs `beforeSend` AND `beforeSendTransaction`.** The client routes error events to the
first and transaction events to the second, and the request data rides on both. Request bodies are
not scrubbed but not captured: `sendDefaultPii: false` does not stop `httpServerIntegration`, so
`sentryOptions` replaces it with `maxRequestBodySize: 'none'`. Span attributes
(`contexts.trace.data` and `spans[].data`) are a second copy of the request that `event.request`
does not cover, and the scrubber clears the body, header and query attributes there too.

**Better Auth is built per request and fails closed.** `createAuth(env, deps)` in
`src/auth/create-auth.ts` runs once per request (the ESLint rule that bans module-scope
`drizzle()` bans module-scope `betterAuth()` too). It sets `rateLimit.enabled: true`, asserts a
32-character `BETTER_AUTH_SECRET` and reads the client IP from `cf-connecting-ip`, because all
three of Better Auth's defaults key on `NODE_ENV=production`, which Workers never set. Two
module-scope memos are documented exceptions to the no-module-scope rule: the imported KEK
(`src/crypto/key-provider.ts`) and the remote JWKS resolvers (`src/auth/jwks.ts`); both hold
objects that do no I/O at construction and carry no request state.

**Native sign-in bodies say `identityToken`, never `idToken`.** The Expo client strips the stored
session cookie from any request whose body has an `idToken` key, and the anonymous-to-account
merge needs that cookie to find the account being upgraded.

**No raw control characters in source.** A literal NUL makes git classify the blob as binary, and
a binary blob has no diff, no line-level review comment and no three-way merge.
`planeahead/no-literal-control-characters` fails the lint on the byte; `.gitattributes` is the
second line of defence. Write the escape (`'\u0000'`), which compiles to the same string.

**Rate limit `namespace_id` values are account-wide counters.** Staging, production and local each
get their own block of ids in `wrangler.jsonc`, or staging load spends production's allowance.

## Deployment

`--env staging` and `--env production` deploy **separate Workers** (`planeahead-api-staging`,
`planeahead-api-production`) with their own Durable Object namespaces, queues and secrets.

Plain `wrangler deploy` only. Gradual deployments are not supported for a Worker that declares
`exports`, so there is no `versions upload` path for this Worker, now or later.

`wrangler deploy --dry-run` needs no credentials and is the CI gate, but it only parses the
config and bundles. It does not verify that the KV, R2, queue or Hyperdrive ids exist. The first
real staging deploy is that check, and the queues plus their dead letter queues have to be created
with `wrangler queues create` beforehand, because deploy fails on a missing queue rather than
creating one. Secrets are set out of band with `wrangler secret put --env staging`; the deploy
workflow passes an empty `secrets` input on purpose.
