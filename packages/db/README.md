# @planeahead/db

Postgres 18 schema (Drizzle pg-core), migrations, seed loaders and the database clients. The
design, the per-table catalog and the rules every change must keep are in
[docs/schema-review.md](../../docs/schema-review.md).

## Entry points

| Import                   | Runs on          | Exports                                                                                                                                                                      |
| ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@planeahead/db`         | Workers and Node | `schema` (all 70 tables), `withDb(env, fn)`, `createNodeDb(url)`, `Db`, `DB_SCHEMA_VERSION`, `resolveAirportEndpoint`, `originColumns`, `destinationColumns`, `toIsoInstant` |
| `@planeahead/db/schema`  | Workers and Node | the tables and enumeration lists only                                                                                                                                        |
| `@planeahead/db/migrate` | Node only        | `migrateDatabase(url)`, `migrationHash()`, `readJournal()`, the URL and version guards                                                                                       |
| `@planeahead/db/seed`    | Node only        | `seedAll(db)` and the four loaders                                                                                                                                           |

`withDb` opens a postgres.js client on the Hyperdrive binding per request or queue batch with
`{ max: 5, fetch_types: false, prepare: true }` and never calls `end()`. `createNodeDb` is the
same client for a plain URL with an explicit `close()`. Nothing creates a client at module scope
(`planeahead/no-module-scope-drizzle` bans both `drizzle()` and `postgres()` there).

## Instants

Every `timestamptz` column outside the Better Auth tables is an `instant()` column: Drizzle
reads it as an ISO-8601 UTC string (`2026-09-19T22:30:00Z`, microseconds preserved) that
satisfies `IsoInstantSchema` in `@planeahead/shared`, whatever the session time zone, and a
write must carry a zone designator (`Z` or an offset) or it is refused before it reaches
Postgres. Raw SQL reads (`sql<string>`, `db.execute`) hand back Postgres's own text
(`2026-09-19 22:30:00+00`); pass it through `toIsoInstant()`.

## Flight airports

`flight_instances.origin_icao`, `origin_airport_id` and `origin_tz` (and the destination pair)
describe one airport. Fill them from a single lookup, `resolveAirportEndpoint(db, icao)` plus
`originColumns()` / `destinationColumns()`; a composite foreign key on `airports (id, icao)`
rejects a code that does not belong to the row, and a known airport without its zone is refused.

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
`updated_at` add a custom migration with one `CREATE TRIGGER ... WHEN (OLD.* IS DISTINCT FROM
NEW.*) EXECUTE FUNCTION set_updated_at()` (see `migrations/0001_add_set_updated_at.sql`).
Adding a column to `flight_instances` (the one table with a generated column) also means a new
custom migration that drops and recreates its trigger, because its WHEN clause names every
column; `test/trigger.test.ts` notices if you forget. Never edit a migration that has been
applied anywhere. Code columns (`*_icao`, `*_iata`, `icao_hex`, `flight_number`) need a
`formatCheck`; the contracts test lists any without one.

## Test harness

`test/globalSetup.ts` starts one embedded PostgreSQL 18.4 cluster per run (initdb about 0.5 s
warm, 3 s cold on an M-series Mac) unless `TEST_DATABASE_URL` is set in the shell (how CI uses
its `postgres:18` service container) or in `packages/db/.env.test` (gitignored; a developer
pointing the suite at a Neon branch). The harness logs which source won and refuses any server
whose session time zone is not at UTC offset zero, naming the fix. Every test file creates,
migrates and drops its own database through `test/helpers.ts`, so files run in parallel and
each one re-proves the migrations.

## Seed data

`seed/data` holds derived, filtered upstream files (each under 3 MB), `MANIFEST.json` with the
upstream URL, SHA-256, byte count, `Content-Length` seen, fetch time, licence and row counts,
and `LICENSES.md`. `scripts/fetch-seed-data.mjs` refreshes them and writes geo-tz candidates for
airports without an mwgg timezone to `airports.tz-review.json`;
`scripts/curate-tz-overrides.mjs` promotes candidates that pass the IANA country check into
`airports.tz-overrides.json` and lists the rest in `airports.tz-rejected.json`. The airports
loader fails on any airport that still has no timezone unless it is on the rejected list, which
it skips with a warning. Every loader checks its unique columns across the source rows before
writing and loads inside one transaction, so a refresh lands completely or not at all.
