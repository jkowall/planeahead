# Build log

One row per increment. Tokens and wall-clock are filled in by the orchestrator after the
increment is reviewed.

| Increment           | Model                                          | Tokens                                                                                                                                                        | Wall-clock                                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Repo skeleton    | Opus 5 build, Fable 5.1 read                   | build agent: not recorded (workflow failed at the session usage limit before its review stage; agent transcript 557 KB)                                       | ~1 h build, ~75 min close-out (of which ~15 min was a GitHub push stalled by the VPN route) | pnpm 12 + Turborepo 2.11 workspace, strict TS 6.0, ESLint 9 flat + Prettier 3, Vitest 4.1 in shared/db/api, local `planeahead/no-module-scope-drizzle` rule with a RuleTester unit test, Renovate, CODEOWNERS, ADR template, CI (typecheck, lint, test, toolchain guard). No Cloudflare or Expo dependency. Orchestrator close-out: regenerated the lockfile (the builder's install was interrupted and left a truncated file), `prettier --write` on 5 files the builder never formatted, `.gitignore` exceptions for `.env.example` and `.dev.vars.example`, ADR index wording for 0007. Verified: `pnpm install --frozen-lockfile`, `turbo run typecheck lint test --force` (11/11), `prettier --check`, toolchain guard.                                                                                                                                                                                                                                          |
| 2. Shared contracts | Fable 5.1 build and fixes, Opus 5 review panel | Fable ~970k output (build 714k incl. two stalled restarts, fix rounds 160k + 94k); Opus ~620k (two reviewers 365k, twelve skeptics 139k, two re-reviews 115k) | ~4.5 h from launch to final commit, of which ~1 h was API and GitHub stalls on the VPN      | `packages/shared`: uuidv7, flight key (ADR 0003), Zod 4 boundary schemas, provider interfaces, cost table, cadence engine with the SLO table and a simulation that derives every constant, RPC and sync envelopes, Live Activity state, secret patterns; `docs/architecture.md` generated from code with a drift test; ADR 0003 and 0006. Review: 15 findings (10 API design, 5 correctness), every blocker and major sent to two Opus skeptics (spec lens refuted 4 as deliberate spec choices, reproduction lens confirmed all real defects), 17 items fixed, re-review found 3 regressions in the fixes (fixed in round 2, re-verified by execution), orchestrator closed the 20-minute pre-boarding hole the honest report exposed. Derived constants: A2 74 polls / 122 PE / $0.61 list (plan wrote 72 / 120 / $0.60 under a round() slot rule), A1 84, literal 181, B 5; AeroDataBox 2 / 24 / 40 units at 3 / 14 / 30 days (plan wrote 4 / 26 / 42). 387 tests. |
| 3. Database schema  | Fable 5.1 build and fix, Opus 5 review panel   | Fable ~900k (build 448k, fix 455k); Opus ~2.1M (two reviewers 577k, fourteen skeptics ~1.3M, re-review 232k); orchestrator close-out on top                   | ~1 h 55 min workflow plus ~50 min close-out                                                 | `packages/db`: 70 tables in 9 schema files (the plan's 61 undercounted the spec's normative list), migration 0000 plus a generated set_updated_at migration with no-op WHEN guards, embedded PostgreSQL 18.4 harness (initdb 3.2 s cold, 0.6 s warm; skipped when TEST_DATABASE_URL is set, which is how CI's postgres:18 service container is used), withDb and createNodeDb, a URL-only migrator with pooler and version guards, seed loaders with a Content-Length and SHA-256 manifest and IANA-checked timezone overrides (739 accepted, 5 rejected and listed), schema-review.md, ADR 0002, 0007, 0009. Review: 19 findings, 7 serious ones sent to two skeptics each (spec lens refuted 4 as deliberate choices, reproduction lens confirmed every physical defect), 22 items fixed, re-review confirmed each by execution and left 4 nits, all applied in the close-out along with two forward-looking columns increments 6 and 7 need. 166 tests.            |

## Deviations and decisions (increment 4 review fixes)

Applied on top of `b824ae4` after the Opus review panel. The spike results ruling E8 asks for are
recorded where they are load-bearing rather than repeated here: spike 3's answer (`PUBLIC_RL`
DOES enforce inside the Workers Vitest pool, 300 calls against the 120-per-10-s binding returned
180 failures) is the docstring of `apps/api/test/workers/rate-limit.test.ts`, and the `exports`
and alarm findings are in `apps/api/vitest.config.ts` and `apps/api/test/workers/do-ping.test.ts`.

- **The middleware chain moved to `apps/api/src/app.ts`.** `createApp()` is now the only place
  `use()` is called on the root app, and every test that needs the chain calls it. The chain's
  registration order is a runtime contract, and three test files had been reproducing it inverted
  (auth registered before the middleware under test), which is why a Worker that answered 500 to
  every mutating request carrying an `Idempotency-Key` shipped with 74 green tests. `src/index.ts`
  still owns the routes, because only the chained `.route()` expression carries the RPC types.
- **`c.var.user ?? null` everywhere ahead of the auth slot.** The `Variables` generic types the
  value as `AuthenticatedUser | null` and cannot express "not set yet", so a strict `=== null`
  test reads `user.id` off `undefined`. Applied to `storeFor`, `scopeFor`, `principalLimiter` and
  `requireUser`; the last one failed OPEN before, which is the dangerous direction for a guard.
- **`handleError` keeps Hono's `HTTPException` branch.** A custom `onError` without it turns every
  401, 403 and 413 signalled by a throw into an opaque 500. Nothing in increment 4 throws one (the
  house convention is to return the response), but increment 5 mounts the first thrower.
- **Sentry: stop capturing rather than scrub.** `sendDefaultPii: false` does not stop request body
  capture, so `sentryOptions` replaces the default `httpServerIntegration` with
  `maxRequestBodySize: 'none'`. `beforeSendTransaction` was added alongside `beforeSend`, which
  only ever sees error events. The end-to-end test added for this then found a leak no hand-built
  event could have: `url.query` and the query half of `url.full` ride out as SEGMENT SPAN
  attributes, which `event.request` does not cover. The scrubber now clears body, header and query
  attributes from `contexts.trace.data` and from every `spans[].data`.
- **Unauthenticated idempotency scopes are per `X-Install-Id`**, the client-owned install id
  increment 5's `POST /v1/devices` registers, not one shared `anonymous` bucket and not the
  client IP. The first fix round scoped by `CF-Connecting-IP`, which closed the cross-caller leak
  only for callers on different addresses and broke the one retry the key exists for: a phone
  moving from WiFi to LTE mid-retry changed scope and created its resource twice. A keyed request
  with neither a user nor an install id is answered 400 `idempotency_scope_missing` rather than
  run without the guarantee it asked for. Ruling E6 stands (idempotency ahead of auth), so the
  Postgres store and the per-user scope stay in the file as the documented path for the `/v1`
  mount behind auth in increment 8 and are stated, in code and in tests, to be unreachable from
  the global slot until then.
- **New ESLint rule `planeahead/no-literal-control-characters`**, with a RuleTester unit test and
  a `.gitattributes` backstop. A raw NUL in a template literal made git classify
  `apps/api/src/middleware/idempotency.ts` as binary (`Bin 0 -> 9233 bytes`), costing the one file
  no diff-based review could read its diff, its line-level comments and its three-way merge.
  Prettier, tsc and the toolchain guard all accepted it. The rule scans raw source text, so a
  control character in a comment or a regex is caught too, and it is enabled for every linted
  file rather than only `apps/api/src`.
- **The cron seam is async now**, while every handler is one log line: `runCron` and `scheduled`
  return `Promise<void>`, handlers are typed `CronHandler`, and the expression table is injectable
  so a rejected handler's path is testable. Increment 7's reconcile has to page and enqueue, and a
  `void` seam offered only two bad ways to express that.
- **`SqlMigrationError` gained `kind` and `foundVersion`.** The version-ahead path used to put the
  object's schema version in `migrationId`, which told an operator that a migration that had
  applied cleanly was the failure. `migrationId` is now always an id this build cannot account
  for.
- **`AnalyticsBudget` counts a missing dataset as `skipped`, not `failed`**, and names it once per
  invocation as `analytics_dataset_missing`. A missing `analytics_engine_datasets` block (a
  non-inheritable key) used to report exactly like a batch of oversized points.
- **`truncateToBytes` cuts on a codepoint boundary.** Slicing bytes and decoding puts U+FFFD at
  the cut, which re-encodes to three bytes, so the clamp could return a value LARGER than the
  platform limit it exists to enforce.
- **turbo.json names the migration journal and the generator** in the `typecheck` and `test`
  inputs. `scripts/**` resolves inside the package (`apps/api/scripts`, which does not exist), so
  a new migration used to cache-hit and replay a stale `up to date` line while the compiled-in
  `MIGRATION_HASH` still reported the previous schema. The `test-workers` CI job now also runs
  `gen-migration-hash.mjs --check`, because it regenerates the file before vitest and would
  otherwise test the value it just wrote.
- **`deploy-staging.yml` got the path filter its header already claimed**, and repeats typecheck,
  lint, the Worker suite and the dry run as steps before the deploy. ci.yml is a separate workflow
  triggered by the same push, so nothing ordered the two and a commit that failed CI still ran
  forward-only migrations against the staging Neon branch. `workflow_run` was rejected: it fires
  on completion regardless of conclusion and resolves the workflow file from the default branch.
  The `@planeahead/db` suite is deliberately not repeated there; it needs ci.yml's service
  container.
- **vitest, `@vitest/runner` and `@vitest/snapshot` are exact `4.1.11`**, matching the facts
  sheet. The tildes floated to any 4.1.x and nothing in the repository enforced the pinned value
  (the toolchain guard's pair assertion covers wrangler, by design).
- **`testTimeout` is 60 s, not 30.** The old comment's "about 10 seconds" understated the cold
  first-request cost by 2x. The number varies by an order of magnitude with the Vite transform
  cache, so the comment now gives the range and the reason rather than one figure.
- **`.dev.vars.example` lists the rest of the secret set** from plan section 5 as commented-out
  placeholders tagged with the increment that turns each one on, so the file is a checklist rather
  than a snapshot of what increment 4 happens to read.
- **`deploy-staging.yml` checks the migration hash first, immediately after install.** The first
  fix round inserted typecheck, test and the dry run between install and the `--check` step, and
  the api `typecheck` and `test` scripts regenerate the constant, so the check compared the file
  they had just written and could never fail. `tools/workflows/migration-hash-check.test.js`
  (run by the root `test:tools` script, which replaces `test:eslint-rules`) asserts in every job
  that checks that the check precedes every regenerating step.
- **`registerChain` returns the order it registered.** `MIDDLEWARE_ORDER` was a hand-maintained
  list compared to a literal copy of itself, and the suite stayed green with cors and rate-limit
  swapped in the code. The slots are now `[name, handler]` pairs the loop registers from, and
  chain.test.ts compares the returned names to the constant.

## Pinned versions (increment 3)

| Package           | Pin                      | Resolved       | Why this pin                                                                                           |
| ----------------- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------ |
| drizzle-orm       | `0.45.2` (exact)         | 0.45.2         | API surface restricted to what 1.0 rc keeps; migration format is version-specific.                     |
| drizzle-kit       | `0.31.10` (exact)        | 0.31.10        | Generates the committed SQL; the generated-column index-drop bug (issue 4929) is guarded by a test.    |
| postgres          | `^3.4.9`                 | 3.4.9          | The single driver on every path (Workers via Hyperdrive, CI, scripts, tests).                          |
| embedded-postgres | `18.4.0-beta.17` (exact) | 18.4.0-beta.17 | Real PostgreSQL 18.4 binaries in the npm tarball; open hang reports, so every call has a 60 s timeout. |
| geo-tz            | `^8.1.9`                 | 8.1.9          | Fetch script only (ODbL boundary data); the reviewed output is committed as curated data.              |

## Deviations (increment 3)

- **70 tables, not 61.** The spec's normative list has 70; the plan's figure was a miscount. The catalog, the vitest comment and the tests say 70.
- **Frozen `flight_key` expression uses `extract`/`lpad`**, not `date::text`: the text cast of a date depends on `DateStyle` and Postgres rejects it as not immutable in a generated column.
- **`instant()` is a custom type** that normalises Postgres's session-zone text to an ISO-8601 UTC string, so `mode: 'string'` values satisfy shared's `IsoInstantSchema`; the session zone is also asserted UTC by the test harness and documented as an `ALTER ROLE ... SET TimeZone = 'UTC'` environment step.
- **Format checks on 37 code columns** (ICAO, IATA, hex, flight number) beyond the three the spec named; `flight_events.type` is deliberately unconstrained (the DO's zod schema owns that vocabulary).
- **Composite airport foreign keys**: `(origin_airport_id, origin_icao, origin_tz)` and `(destination_airport_id, destination_icao)` reference `airports`, so a resolved airport cannot disagree with its row; `airports.icao` accepts OurAirports idents of 3 to 8 characters when `icao_source = 'ident'`, and 181 seeded scheduled-service airports therefore cannot yet be a flight origin (documented deferral: synthetic `ZZxx` codes are an open decision).
- **`deleted_at` also on `logbook_entries`** (a sync entity per shared's `SYNC_ENTITIES`); `deleted_subjects` uses `subject_deleted_at` so the tombstone invariant is a pure structural test.
- **Seed loaders load inside one transaction** and check every secondary unique column across source rows first (`SeedCollisionError` names both rows); the Airports loader skips airports on the explicit rejected list with a warning instead of failing.
- **The ESLint module-scope rule now bans `postgres(...)`** as well as `drizzle(...)`, including aliased and namespace imports, and covers `packages/db/src`.
- **Fetch script requests identity encoding** before comparing bytes with `Content-Length` (Node's fetch otherwise decompresses gzip transparently and the header describes the compressed size).

## Pinned versions (increment 2)

| Package | Pin        | Resolved | Why this pin                                                                                     |
| ------- | ---------- | -------- | ------------------------------------------------------------------------------------------------ |
| zod     | `^4.6.5`   | 4.6.5    | Zod 4: `z.looseObject`, `z.iso.*`, `z.partialRecord`; `@hono/zod-validator` 0.9 supports it.     |
| tsx     | `^4.23.13` | 4.23.13  | Runs `scripts/gen-cadence-table.ts`; needs esbuild's postinstall, allowed through `allowBuilds`. |

## Deviations (increment 2)

- **`allowBuilds` replaces `onlyBuiltDependencies`.** pnpm 12 ignores `onlyBuiltDependencies` (its changelog moved the allow list to `allowBuilds` in pnpm 11); with the old key `pnpm install --offline` fails with `ERR_PNPM_IGNORED_BUILDS` for esbuild. Confirmed empirically by the fixer and the re-reviewer.
- **Slot rule is `ceil`, not `round`.** The plan's per-window counts (42 / 21 / 7 / 2 = 72) came from rounding; the honest SLO measurement showed a 20-minute unpolled hole before boarding on a 15-minute grid, so a trailing partial slot now always earns a poll. A2 = 74 polls, 122 PE, $0.61 list; A1 = 84. The plan's tables in sections 8 and 9 are historical; `docs/architecture.md` is generated from the code.
- **AeroDataBox units 2 / 24 / 40 at 3 / 14 / 30 days**, not 4 / 26 / 42: the poll at exactly T-48 h is the AeroAPI bracketed fetch, not a second AeroDataBox call.
- **A1 post-arrival tail** is five fixed slots (in+0, +15, +30, +45, final +120) rather than an interval; the plan's "15-min 4 + 1 final" wording reads that way and it keeps the 15-minute post-arrival SLO for the first 45 minutes.
- **Cadence B in-flight slot** is at scheduled out + 15, not scheduled off + 15 (no taxi model in shared yet).
- **`FlightStatus` gained** an optional `key`, a provider-local `scheduledDepartureDateLocal`, and `AircraftPosition` gained `callsign`; `providerRefs` and `fieldQuality` are open string records (forward compatibility); enum fields degrade unknown strings to `unknown` but stay required.
- **Every RPC payload carries `rpcVersion`** (defaulted to 1) so a DO can answer in the caller's version.

## Pinned versions (increment 1)

Resolved with `npm view <pkg> version` on 2026-09-19. Every pin lives in the `catalog:` block of
`pnpm-workspace.yaml`; packages reference it with the `catalog:` protocol.

| Package                | Pin                                     | Resolved | Why this pin                                                                                                                                           |
| ---------------------- | --------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| node                   | `>=24 <25`, `.node-version` 24          | 24.21.0  | Node 24 LTS. Corepack is gone from Node 25, so pnpm is pinned through `packageManager`.                                                                |
| pnpm                   | `pnpm@12.5.1` (exact, `packageManager`) | 12.5.1   | The version installed on the build machine. See the deviation note below.                                                                              |
| turbo                  | `^2.11.2`                               | 2.11.2   | Plan section 3.                                                                                                                                        |
| typescript             | `~6.0.3`                                | 6.0.3    | Latest on npm is 7.0.2, held back on purpose: Expo SDK 57 expects 6.0.x and typescript-eslint 8 peers on `>=4.8.4 <6.1.0`.                             |
| vitest                 | `~4.1.11`                               | 4.1.11   | Latest is 5.0.1, held back on purpose: `@cloudflare/vitest-plugin` 1.1.x peers on vitest `^4.1`.                                                       |
| eslint                 | `^9.39.5`                               | 9.39.5   | Latest is 10.11.0. The spec asks for ESLint 9 flat config; typescript-eslint 8.70 supports 8, 9 and 10, so the move to 10 is a later, deliberate step. |
| @eslint/js             | `^9.39.5`                               | 9.39.5   | Kept in lockstep with eslint.                                                                                                                          |
| typescript-eslint      | `^8.70.0`                               | 8.70.0   | Latest 8.x; the only line that supports TypeScript 6.0.                                                                                                |
| eslint-config-prettier | `^10.1.8`                               | 10.1.8   | Latest.                                                                                                                                                |
| globals                | `^17.12.0`                              | 17.12.0  | Node globals for the plain-JS files (ESLint config, plugin, scripts).                                                                                  |
| prettier               | `^3.9.8`                                | 3.9.8    | Latest 3.x.                                                                                                                                            |
| @types/node            | `^24.13.6`                              | 24.13.6  | Matches the Node 24 runtime; latest on npm is 26.6.2, which is a newer runtime than we ship.                                                           |

Recorded in the catalog as comments only, not installed yet: `@cloudflare/vitest-plugin` 1.1.13
and `wrangler` 4.135.0 (increment 4), `hono` 4.13.8 (increment 4), `zod` 4.6.5 (increment 2),
`expo` 57.0.24 (increment 9), `drizzle-orm` 0.45.2 and `drizzle-kit` 0.31.10 (increment 3),
`better-auth` 1.7.5 (increment 5).

## GitHub Actions versions (increment 1)

The spec pins `actions/checkout@v5`, `pnpm/action-setup@v4` and `actions/setup-node@v6`. All three
majors exist on the marketplace today, so no fallback was needed. Newer majors have since shipped
(checkout v7, action-setup v6, setup-node v7); Renovate will propose those bumps as reviewable PRs
rather than the build silently jumping a major.

## Decisions taken where the spec was silent (increment 1)

- **Turborepo task graph.** `lint` and `test` each depend on a root task (`//#lint:root`,
  `//#test:eslint-rules`) so the files that live outside a workspace package (the flat config,
  `scripts/`, `tools/`) are linted and the custom ESLint rule's unit test runs as part of
  `turbo run lint test`. Without this, `tools/` would never be checked by CI.
- **TypeScript emit.** `composite: true` with `emitDeclarationOnly: true` and `outDir: dist`.
  Composite is required for project references, and declaration-only emit keeps `tsc -b`
  incremental without producing JavaScript nobody consumes (packages are consumed as TypeScript
  source through their `exports` map).
- **Package entry points.** `exports` maps `.` to `./src/index.ts` for both the `types` and
  `default` conditions, per the spec. Consumers are Vite, Vitest and wrangler, all of which
  compile TypeScript, so there is no build step in Phase 0.
- **ESLint rule scope.** `planeahead/no-module-scope-drizzle` is enabled only for
  `apps/api/src/**/*.ts`, per the spec. It matches a bare `drizzle(...)` identifier call and a
  `ns.drizzle(...)` member call, and treats any enclosing function, arrow function or class static
  block as "not module scope". A bare block at module scope still counts as module scope.
- **Prettier scope.** `.prettierignore` excludes `docs/plans/`, `docs/research/` and
  `docs/increments/`. Those are orchestrator-owned inputs and reformatting them would be an edit.
- **`.npmrc`.** `engine-strict=true`, so an install on the wrong Node major fails loudly instead of
  producing a lockfile nobody can reproduce.
- **`onlyBuiltDependencies`.** pnpm 10+ blocks lifecycle scripts by default. `esbuild` (a Vite
  dependency) is allowlisted because it needs its postinstall to place the platform binary.

## Deviations (increment 1)

- **Two-document lockfile.** pnpm 12 with a `packageManager` pin writes `pnpm-lock.yaml` as two
  YAML documents: the first records pnpm's own `@pnpm/exe.*` binaries (self-managed package
  manager), the second is the workspace. `scripts/toolchain-guard.mjs` only matches unquoted
  `  name@version:` entries, so the quoted `@pnpm/exe` block in the first document is ignored.
- **Review stage skipped.** The build workflow's Opus review never ran (session limit). The
  orchestrator read every file instead; the fixes above were the only findings. A second-model
  review is not owed for a skeleton with no business logic, and increment 2's reviewers see this
  code again as context.

- **pnpm 12.5.1, not 12.4.2.** npm's `latest` dist-tag for pnpm 12 is 12.4.2; 12.5.1 is `next-12`
  and is what is installed on this machine. `packageManager` must match the binary that runs the
  install, so the pin follows the machine. Change both together, never one alone.
