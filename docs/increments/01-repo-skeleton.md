# Increment 1: repo skeleton

Status: built and verified locally (2026-09-19); first push opens CI. Builder: Opus 5 (build agent; the review stage of its workflow never ran because the session hit its usage limit). Reviewer: orchestrator read only (see docs/build-log.md).

## Goal

A pnpm 12 + Turborepo monorepo at `/Users/jkowall/PlaneAhead` with strict TypeScript, ESLint 9 flat config + Prettier 3, Vitest 4.1 wired for `packages/shared`, `packages/db` and `apps/api`, Jest via jest-expo reserved for `apps/mobile` (placeholder only), Renovate, CODEOWNERS, an ADR template, and a GitHub Actions CI baseline (typecheck, lint, test, toolchain guard). No application code yet; every package exports one trivially testable symbol so the pipeline is proven end to end.

Acceptance: `pnpm install --frozen-lockfile && pnpm turbo run typecheck lint test` is green locally; the same jobs are green in GitHub Actions on the first push; `pnpm ls wrangler --depth Infinity` shows exactly one version (or none yet, since wrangler arrives in increment 4).

## Files

```
.node-version                     24
.npmrc                            (empty or engine-strict=true)
package.json                      name planeahead, private, packageManager pnpm@12.x (exact), engines node >=24 <25, scripts: dev/typecheck/lint/test/format via turbo
pnpm-workspace.yaml               packages: apps/*, packages/*; catalog with every shared pin (see Pins)
turbo.json                        tasks typecheck (dependsOn ^typecheck), lint, test (dependsOn ^build? no: shared has no build step in Phase 0; use tsc -b via typecheck), format:check
tsconfig.base.json                strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax, isolatedModules, moduleResolution bundler, module esnext, target es2022, skipLibCheck, composite for references
tsconfig.json                     solution file: references to packages/shared, packages/db, apps/api (apps/mobile excluded until increment 9)
eslint.config.js                  flat config; typescript-eslint type-checked for packages/* and apps/api; a custom rule `planeahead/no-module-scope-drizzle` (stub that flags `drizzle(` calls at module scope in apps/api/src/**); ignores for apps/mobile until increment 9
.prettierrc                       singleQuote true, semi false? No: keep defaults except printWidth 100 and singleQuote true
.prettierignore, .gitignore       node_modules, .turbo, dist, .wrangler, .expo, ios, android (CNG), .env*, .dev.vars
.editorconfig
.github/CODEOWNERS                * @jkowall; apps/api/wrangler.jsonc @jkowall; packages/db/migrations/ @jkowall
.github/renovate.json             extends config:recommended, group:monorepos; packageRules: typescript allowedVersions <7; vitest allowedVersions <5; group wrangler + @cloudflare/vitest-plugin + @cloudflare/workers-types; expo major = manual (dependencyDashboardApproval)
.github/workflows/ci.yml          see CI
docs/adr/README.md                MADR-style template + index
docs/adr/0000-template.md
docs/build-log.md                 table: increment, model, tokens, wall-clock, notes (first row for increment 1 filled by the orchestrator)
packages/shared/                  @planeahead/shared: package.json (type module, exports ./src/index.ts via "exports" with types), tsconfig.json (extends base, composite), src/index.ts exporting `export const PLANEAHEAD = 'planeahead' as const` and a `flightKeyPlaceholder()` function, vitest.config.ts, test/index.test.ts
packages/db/                      @planeahead/db: same shape; src/index.ts exports a `DB_SCHEMA_VERSION = 0` constant; depends on nothing yet (drizzle arrives in increment 3)
apps/api/                         @planeahead/api: package.json, tsconfig.json, src/index.ts exporting a `health()` function returning { ok: true, name: 'planeahead' } (no Hono yet; increment 4), vitest.config.ts (plain node environment; the Cloudflare plugin arrives in increment 4), test/index.test.ts importing from @planeahead/shared to prove workspace linking
apps/mobile/                      only a README.md placeholder explaining it is created by `create-expo-app` in increment 9 (keeps the workspace glob valid)
README.md                         one paragraph, links to docs/plans/phase0-plan.md
```

## Pins (resolve with `npm view <pkg> version` at build time; record the exact numbers in docs/build-log.md)

- pnpm 12.x latest (exact in packageManager), Node 24 LTS
- turbo ^2.11
- typescript ~6.0.x (NOT 7.x: Expo SDK 57 expects ~6.0.3 and typescript-eslint lacks TS 7 support)
- vitest ~4.1.x (NOT 5.x: @cloudflare/vitest-plugin peers on ^4.1)
- eslint ^9, typescript-eslint latest 8.x compatible with TS 6.0, prettier ^3, eslint-config-prettier
- @types/node ^24
- Do not add wrangler, hono, drizzle, expo, better-auth yet; they arrive in their own increments. Put their intended versions in the catalog as comments only if pnpm-workspace.yaml supports comments (it is YAML, so yes).

## CI (`.github/workflows/ci.yml`)

Triggers: pull_request, push to main. Concurrency group per ref, cancel-in-progress. Jobs:
- `setup` is not a job; each job repeats: actions/checkout@v5, pnpm/action-setup@v4 (version from packageManager), actions/setup-node@v6 with node-version-file .node-version and cache pnpm, `pnpm install --frozen-lockfile`.
- `typecheck`: `pnpm turbo run typecheck`
- `lint`: `pnpm turbo run lint` and `pnpm prettier --check .`
- `test`: `pnpm turbo run test`
- `toolchain-guard`: a small node script `scripts/toolchain-guard.mjs` that fails if the lockfile resolves typescript >=7, vitest >=5, more than one wrangler version, or if `.node-version` is not 24.
Use `pnpm/action-setup@v4` with no explicit version so it reads packageManager. If any action major does not exist on the marketplace at build time, fall back one major and note it in docs/build-log.md.

## Conventions

- ESM everywhere (`"type": "module"`).
- Workspace packages reference each other by `workspace:*`.
- Tests live in `test/` next to `src/`, named `*.test.ts`.
- No em dashes in any prose or comments.
- Commit as a single initial commit on main; later increments are branches + PRs.

## Out of scope

Hono, wrangler, Drizzle, Expo, Better Auth, any Cloudflare resource, GitHub repo creation (the orchestrator does that after review).
