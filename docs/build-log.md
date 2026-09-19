# Build log

One row per increment. Tokens and wall-clock are filled in by the orchestrator after the
increment is reviewed.

| Increment        | Model                        | Tokens                                                                                                                  | Wall-clock                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Repo skeleton | Opus 5 build, Fable 5.1 read | build agent: not recorded (workflow failed at the session usage limit before its review stage; agent transcript 557 KB) | ~1 h build, 40 min close-out | pnpm 12 + Turborepo 2.11 workspace, strict TS 6.0, ESLint 9 flat + Prettier 3, Vitest 4.1 in shared/db/api, local `planeahead/no-module-scope-drizzle` rule with a RuleTester unit test, Renovate, CODEOWNERS, ADR template, CI (typecheck, lint, test, toolchain guard). No Cloudflare or Expo dependency. Orchestrator close-out: regenerated the lockfile (the builder's install was interrupted and left a truncated file), `prettier --write` on 5 files the builder never formatted, `.gitignore` exceptions for `.env.example` and `.dev.vars.example`, ADR index wording for 0007. Verified: `pnpm install --frozen-lockfile`, `turbo run typecheck lint test --force` (11/11), `prettier --check`, toolchain guard. |

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
