# 0009. postgres.js as the single Postgres driver

- Status: Accepted
- Date: 2026-09-20
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none

## Context

Four code paths talk to Postgres: the API Worker through Hyperdrive, `src/migrate.ts` and
drizzle-kit over `DATABASE_URL`, the seed scripts, and the Vitest suite against embedded
Postgres or the CI service container. Drizzle supports both node-postgres (`pg`) and postgres.js
(`postgres`). Cloudflare names node-postgres as the recommended Hyperdrive driver with "the best
compatibility with Hyperdrive's caching" and lists postgres.js as also supported, with a
documented option set for it
([postgres.js on Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)).
Query caching is disabled on every PlaneAhead Hyperdrive configuration in Phase 0 (plan
section 5), so the caching difference has no effect yet.

## Decision

We will use postgres.js (`postgres` ^3.4.9) everywhere, created per request or queue batch by
`withDb` with `{ max: 5, fetch_types: false, prepare: true }` on the Hyperdrive path and by
`createNodeDb` (same options plus an explicit `close()`) on the URL path.

Why these options: `max: 5` stays under the six simultaneous outbound requests a Worker
invocation may have waiting; `fetch_types: false` skips a type-lookup round trip and is safe
because the schema uses no Postgres array types (a test asserts this from the migration
snapshot); `prepare: true` keeps Hyperdrive's prepared-statement cache working, and the older
`prepare: false` advice is PgBouncer folklore that Cloudflare's current example contradicts.

## Consequences

- Easier: one dependency and one connection-option set across Workers, CI, scripts and tests;
  tagged-template SQL for tests and the seed loaders; a `Buffer` for every `bytea` column and a
  string for `bigint` that Drizzle's `mode: 'number'` parses (both verified by the increment 3
  spike).
- Harder: if Hyperdrive caching is ever enabled and shows a measurable gap against node-postgres,
  the driver swap touches `withDb`, `createNodeDb`, `migrate.ts` and the test helpers. Drizzle's
  query builder is driver-neutral, so the schema and queries do not change.
- Commits us to postgres.js's raw text for `timestamptz` (Drizzle's postgres-js driver installs
  a transparent parser for it), which renders in the session time zone and is not ISO-8601.
  `@planeahead/db` normalises it in the `instant()` column type and pins the session zone to
  UTC per environment (schema-review section 12). Reversibility: high.

## Alternatives considered

| Option                     | Why not                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| node-postgres (`pg`)       | Recommended by Cloudflare for caching, but caching is off in Phase 0; a second dependency shape for tests. |
| `@neondatabase/serverless` | HTTP or WebSocket to Neon directly, bypassing Hyperdrive pooling; not the documented Workers path.         |
| `drizzle-orm/neon-http`    | Same as above, and its `bytea` handling was only fixed in the 1.0 rc line.                                 |

## References

- Cloudflare, postgres.js with Hyperdrive: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/
- Workers platform limits (six simultaneous outbound connections): https://developers.cloudflare.com/workers/platform/limits/
- Hyperdrive connection lifecycle (no `end()` needed): https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/
- Increment 3 facts, `docs/increments/03-db-schema.facts.md` section 2.
