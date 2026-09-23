# @planeahead/api

The PlaneAhead API: one Cloudflare Worker that serves the HTTP surface, owns five Durable Object
classes, consumes four queues and runs two cron triggers. The design is in
[docs/plans/phase0-plan.md](../../docs/plans/phase0-plan.md) section 5; the framework decision and
the Durable Object migration runner are in [ADR 0004](../../docs/adr/0004-hono-rpc.md).

Increment 4 is the bootstrap: the middleware chain, `GET /health`, the Durable Object shells and
the queue and cron skeletons. Increment 5 adds authentication (Better Auth 1.7.5: anonymous,
magic link, native Apple, native Google, the Expo transport), the envelope-encryption module,
`POST /v1/devices`, `GET /v1/me` and `PATCH /v1/me/preferences`. Increment 6 adds the provider
layer (`src/providers`: the AeroDataBox adapter, the fixture-backed AeroAPI adapter, the router,
the cost logger, the budget guards and token bucket), the ProviderBudget Durable Object and the
two webhook receivers under `/v1/webhooks`; its design is in
[docs/increments/06-provider-layer.md](../../docs/increments/06-provider-layer.md) and
[ADR 0010](../../docs/adr/0010-provider-identity.md). Increment 7 adds the FlightTracker and the
DesignatorResolver. Increment 8 adds the user-facing flight routes (`/v1/flights`: search,
subscribe, list, detail, unsubscribe, refresh), the pull sync feed (`GET /v1/sync`, ADR 0012), the
free-tier caps in `usage_counters`, the `/v1` idempotency instance, synchronous account deletion
(`POST /v1/me/delete`) and the reserved Apple and RevenueCat webhook stubs; its design is in
[docs/increments/08-flight-routes-and-sync.md](../../docs/increments/08-flight-routes-and-sync.md).
The auth design is in [docs/increments/05-auth.md](../../docs/increments/05-auth.md) and its
threat model in [docs/security/threat-model.md](../../docs/security/threat-model.md).

## Commands

```sh
pnpm --filter @planeahead/api test              # Vitest in the Workers pool, embedded Postgres 18
pnpm --filter @planeahead/api run typecheck
pnpm --filter @planeahead/api run dev           # wrangler dev on http://localhost:8787
pnpm --filter @planeahead/api run cf-typegen    # regenerate worker-configuration.d.ts
pnpm --filter @planeahead/api exec wrangler deploy --dry-run --env staging
node scripts/vitest-exit-guard.mjs              # proves a failing test fails the run (see Rules)
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
                          plus magic-link-cap (the gate ahead of Better Auth's magic-link request:
                          body validation, per-address and per-requester caps, `{ email }` only)
src/auth/                 create-auth.ts (the per-request Better Auth instance), plugin.ts (the
                          native Apple and Google endpoints), merge.ts (anonymous upgrade),
                          magic-link-requester.ts (binds a link to the anonymous user who asked),
                          used-tokens.ts (identity-token replay markers in KV), paths.ts, runtime.ts
src/crypto/               envelope.ts, key-provider.ts, hash.ts
src/mail/                 sender.ts (MailSender, the magic-link message), resend.ts, noop.ts,
                          cloudflare-email.ts (implementation only, never wired)
src/routes/               health.ts, auth.ts (/api/auth: the gate, the verify wrapper, the browser
                          consume route), magic-link-landing.ts (/auth/magic-link, the emailed
                          non-consuming page), v1.ts (/v1: devices.ts, flights.ts, me.ts, sync.ts,
                          webhooks.ts, the stub)
src/lib/                  increment 8: validate.ts (the one validator), caps.ts, deadline.ts,
                          sync-cursor.ts, sync-rows.ts, trackers.ts, flight-search.ts,
                          flight-registry.ts, flight-snapshots.ts, account-deletion.ts, hmac.ts
src/client.ts             hcWithType, the typed RPC client the mobile app builds from AppType
src/providers/            aerodatabox.adapter.ts, aeroapi.mock.ts, router.ts, cost-log.ts,
                          budget.ts, token-bucket.ts, config.ts (plans and settings), http.ts;
                          specs/ (the vendored OpenAPI snapshots), fixtures/ (test data only)
src/validation/           nul.ts (U+0000 is refused at every JSON boundary; Postgres would 500)
src/do/                   migrate.ts (the SQLite schema runner), base.ts, the five classes,
                          migrations/<class>/NNN.ts (ProviderBudget has the first)
src/queues/               index.ts dispatch, consume.ts (per-message ack), analytics.ts, consumers
                          (persist.ts also routes the anonymous merge's `merge` message to merge.ts)
src/cron/                 index.ts dispatch, reconcile.ts, housekeeping.ts
src/observability/log.ts  structured JSON logging with the request id
test/workers/             everything that drives the Worker, inside workerd
test/unit/                pure WebCrypto and jose tests, ALSO inside workerd (that is the point:
                          they settle facts about the runtime, not about Node)
test/consumer/            the typed client as the mobile app sees it (`types: []`), checked by
                          the `typecheck` script against the declaration `tsc -b` emits
test/globalSetup.ts       embedded Postgres, the fake Apple/Google/Resend server, .dev.vars.test
```

## Rules that are not obvious from the code

**`AppType` is the type of the chained app.** Hono accumulates RPC types through the return value
of `.route()`. Add a route to the chain in `src/index.ts`; a separate `app.route(...)` statement
compiles, runs correctly and silently leaves that route out of the type the mobile client is built
from. The Better Auth mount is exactly such a statement, on purpose (increment 8): its catch-all
has no business in `AppType`. `test/unit/app-type.test.ts` asserts both halves.

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
in-memory map. Since increment 8 the global slot leaves `/v1` alone: `/v1` has its own instance
behind auth and the burst limiter, which scopes a key by the user id (else the install id), keeps a
user's keys in Postgres, and leaves the reservation to `idempotencyGate()`, which a route places
after its validator so the hash covers the validated body (IETF semantics: replay with
`Idempotent-Replayed: true`, 409 `in_flight`, 422 `idempotency_payload_mismatch`). The one path the middleware
skips is the Better Auth mount (`/api/auth/*`): its endpoints carry their own replay semantics, a
stored 200 replayed for `/sign-in/magic-link` would answer ahead of the per-address cap and never
count, and reading the body there would consume it ahead of the handler that has to parse it.

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

**Vitest's exit code is real only because the harness unhooks embedded-postgres.** The package
registers `async-exit-hook` at import, and that library's first registration hooks `beforeExit`
with exit code 0: `process.exit(0)` overrode the `exitCode = 1` Vitest sets on a failure, so this
suite and `packages/db`'s reported failures and exited 0 (locally and in CI, whose service
container skips the embedded cluster but not the import). `packages/db/test/embedded.ts` removes
the `beforeExit` and `exit` handlers right after the import, and `scripts/vitest-exit-guard.mjs`
runs `test/exit-guard/deliberate-failure.guard.ts` through `vitest.exit-guard.config.ts` (the
ordinary configuration with only that file included) in both packages and asserts a non-zero exit;
CI runs it after the test jobs. When a green `turbo run test` looks suspicious, run the guard, and
read the `Tests` summary line rather than trusting the task's status alone.

**No test calls a real provider.** Every adapter takes an injected `fetch`; the router passes the
Worker's, the tests pass a stub that serves fixtures shaped from the vendored specs. Every call
returns its `ProviderCallRecord`, and each record is logged exactly once: the caller logs
`result.call`, the adapter logs the attempts it does not return (the AeroDataBox day-either-side
retry). `scripts/record-adb-fixtures.mjs` is the only thing that ever reaches AeroDataBox, by
hand, with a key.

**Webhooks authenticate by path token.** Neither provider signs deliveries, so each receiver has a
256-bit `WEBHOOK_TOKEN_*` per environment in its URL, compared in constant time; a wrong token is
the ordinary 404. Generate one with `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` (43
base64url characters): any other shape disables the receiver and, for AeroAPI, stops the router
building a `target_url` at all. The token is never logged by our code and the Sentry scrubber
redacts it from every string in an event, but Cloudflare's own request logs keep URLs (ADR 0010
records the residual risk). The receivers are exempt from the per-IP limiter by design
([threat model](../../docs/security/threat-model.md) section 3.1).

**AeroAPI alerts need the account endpoint, and the adapter sets it.** FlightAware refuses
`POST /alerts` with a 400 until `PUT /alerts/endpoint` has set an account-wide delivery URL. There
is no manual owner step: the first `registerAlert` in an isolate PUTs this environment's webhook
URL (`${API_PUBLIC_URL}/v1/webhooks/aeroapi/${WEBHOOK_TOKEN_AEROAPI}`, idempotent, free) and every
alert also carries that URL as its own `target_url`. Never `DELETE /alerts/endpoint`: the next
registration would put it back, and until then every alert creation fails. Whether staging and
production get separate AeroAPI keys (they share the account endpoint on one key) is an open
owner decision recorded in ADR 0010.

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

### Deploy checklist

Every secret the Worker reads is declared in `wrangler.jsonc` under `env.staging.secrets.required`
and `env.production.secrets.required` (the list `WORKER_SECRET_NAMES` in `src/env.ts`;
`test/workers/secrets-in-logs.test.ts` keeps the two equal), and wrangler refuses a first deploy
while one is unset. Before the first deploy of an environment, set each with
`wrangler secret put <NAME> --env <environment>`. Two came with increment 8 and fail loudly when
missing:

- `DELETED_SUBJECT_HMAC_KEY` (`openssl rand -base64 32`): without it `POST /v1/me/delete`, the
  path Apple requires, answers 500 before touching anything, and a deleted account's other device
  is told `unauthenticated` instead of `account_deleted`.
- `IP_SALT_SECRET` (`openssl rand -base64 32`): without it every anonymous search or subscribe by
  number answers 500 (the per-IP tracker-creation cap cannot key its counter).

## Owner tasks (increment 8)

- Set `DELETED_SUBJECT_HMAC_KEY` and `IP_SALT_SECRET` with `wrangler secret put` in staging and in
  production (the deploy checklist above).
- Set `idle_in_transaction_session_timeout` on the app role in every environment, next to
  `statement_timeout`: `ALTER ROLE <role> SET idle_in_transaction_session_timeout = '30s'`. The
  sync watermark is cluster-global, so one session idle inside a writing transaction freezes
  `GET /v1/sync` for every user (docs/schema-review.md section 12, ADR 0012 item 7).
- Keep Hyperdrive query caching disabled on the `DB` binding (ADR 0012 item 7), and after any
  point-in-time restore of an environment's database bump `sync_epoch` before traffic returns
  (the restore runbook in docs/schema-review.md section 6).
