# @planeahead/db

Postgres 18 schema (Drizzle pg-core), migrations, seed loaders and the database clients. The
design, the per-table catalog and the rules every change must keep are in
[docs/schema-review.md](../../docs/schema-review.md).

## Entry points

| Import                   | Runs on          | Exports                                                                                     |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------------- |
| `@planeahead/db`         | Workers and Node | `schema` (all 70 tables), `withDb(env, fn)`, `createNodeDb(url)`, `Db`, `DB_SCHEMA_VERSION` |
| `@planeahead/db/schema`  | Workers and Node | the tables and enumeration lists only                                                       |
| `@planeahead/db/migrate` | Node only        | `migrateDatabase(url)`, `migrationHash()`, `readJournal()`, the URL and version guards      |
| `@planeahead/db/seed`    | Node only        | `seedAll(db)` and the four loaders                                                          |

`withDb` opens a postgres.js client on the Hyperdrive binding per request or queue batch with
`{ max: 5, fetch_types: false, prepare: true }` and never calls `end()`. `createNodeDb` is the
same client for a plain URL with an explicit `close()`. Nothing creates a client at module scope.

## Commands

```sh
pnpm --filter @planeahead/db test          # embedded PostgreSQL 18.4, no Docker; or TEST_DATABASE_URL
pnpm --filter @planeahead/db db:generate   # drizzle-kit generate: must emit nothing on a clean tree
pnpm --filter @planeahead/db db:check      # drizzle-kit check
pnpm --filter @planeahead/db db:migrate    # DATABASE_URL, Neon direct endpoint only, refuses PG17
pnpm --filter @planeahead/db db:seed       # idempotent reference data load
pnpm --filter @planeahead/db seed:fetch    # refresh seed/data from upstream (see scripts/)
```

Adding a table: write it in `src/schema/<domain>.ts` with explicit snake_case names and the
array-form extras, export it from `src/schema/index.ts`, run `db:generate`, and if it has
`updated_at` add a custom migration with one `CREATE TRIGGER ... EXECUTE FUNCTION
set_updated_at()` (see `migrations/0001_add_set_updated_at.sql`). Never edit a migration that
has been applied anywhere.

## Test harness

`test/globalSetup.ts` starts one embedded PostgreSQL 18.4 cluster per run (initdb about 0.5 s
warm, 3 s cold on an M-series Mac) unless `TEST_DATABASE_URL` is set, which is how CI uses its
`postgres:18` service container. Every test file creates, migrates and drops its own database
through `test/helpers.ts`, so files run in parallel and each one re-proves the migrations.

## Seed data

`seed/data` holds derived, filtered upstream files (each under 3 MB), `MANIFEST.json` with the
upstream URL, SHA-256, byte count, `Content-Length` seen, fetch time, licence and row counts,
and `LICENSES.md`. `scripts/fetch-seed-data.mjs` refreshes them and writes geo-tz candidates for
airports without an mwgg timezone to `airports.tz-review.json`;
`scripts/curate-tz-overrides.mjs` promotes candidates that pass the IANA country check into
`airports.tz-overrides.json` and lists the rest in `airports.tz-rejected.json`. The airports
loader fails on any airport that still has no timezone unless it is on the rejected list, which
it skips with a warning.
