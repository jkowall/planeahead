# 0002. Neon Postgres 18 through Hyperdrive, not Cloudflare D1

- Status: Accepted
- Date: 2026-09-20 (decision taken in the Phase 0 plan on 2026-09-19, lifted into an ADR by increment 3)
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none

## Context

The API runs on Cloudflare Workers and needs a relational store for 70 tables: user identity,
subscriptions, a registry of every tracked flight, an append-only event timeline, provider call
ledgers and monthly BTS aggregates. Cloudflare's own database, D1, is SQLite with a 10 GB cap per
database ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). At the plan's
100k flights per month, `flight_events` (roughly 40 rows per flight), `provider_calls` (roughly
130 per flight) and the BTS tables pass 10 GB inside a year even with 90-day purges, and the
SQLite dialect would lock the schema into a rewrite when that day comes. D1 export also blocks
the database while it runs.

Postgres 18 ships a native `uuidv7()` (ADR 0006 depends on it), `xid8` for the sync watermark,
STORED generated columns for the flight key (ADR 0003), BRIN indexes for append-only tables and
partial indexes for the tombstone pattern. Hyperdrive is included on Workers Paid at no extra
charge ([Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/))
and gives a Worker a pooled, regionally cached path to any Postgres.

Neon offers Postgres 18 at project creation, branching (a schema-only branch per pull request,
`dev-<name>` branches per developer, `staging`), scale to zero for non-production branches and
point-in-time restore. It is one of the providers Cloudflare documents for Hyperdrive
([Neon and Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/)).

## Decision

We will use Neon Postgres 18 (selected explicitly at project creation, region us-east-1, direct
endpoint, never the `-pooler` endpoint) behind one Hyperdrive configuration per environment, with
Drizzle ORM for the schema and migrations, and we will not use D1 for application data.

## Consequences

- Easier: a real Postgres feature set (generated columns, `xid8`, BRIN, partial and expression
  indexes, advisory locks, triggers), a size ceiling measured in terabytes, PR-per-branch
  environments and PITR.
- Harder: every Worker request that touches the database crosses to Neon through Hyperdrive, so
  latency and the connection budget need managing (`docs/schema-review.md`, "Connection budget");
  migrations must run over `DATABASE_URL` against the direct endpoint, never through Hyperdrive
  (`packages/db/src/migrate.ts` refuses `-pooler` hosts and PG17); Neon's scale-to-zero on
  non-production branches adds a cold start to the first query.
- Commits us to Postgres semantics in the schema and to Neon's PG18 lifecycle. Reversibility:
  medium. Moving to another managed Postgres is a dump and restore plus a Hyperdrive origin
  change; moving to D1 would be a schema rewrite.

## Alternatives considered

| Option                        | Why not                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare D1                 | 10 GB cap, SQLite dialect, blocking export, no generated columns or BRIN; the schema would have to be rewritten to leave. |
| Supabase Postgres             | Bundles an auth and storage layer that conflicts with Better Auth and R2 as sources of truth; no schema-only branching.   |
| Self-managed Postgres on a VM | Operational burden (backups, upgrades, HA) for a two-person project; no branching.                                        |
| Neon serverless HTTP driver   | Bypasses Hyperdrive and its pooling; per-request HTTP overhead; not the documented Workers path.                          |

## References

- Phase 0 plan section 3, `docs/plans/phase0-plan.md`.
- Increment 3 facts, `docs/increments/03-db-schema.facts.md` section 5 (Neon and Hyperdrive limits).
- D1 limits: https://developers.cloudflare.com/d1/platform/limits/
- Hyperdrive pricing: https://developers.cloudflare.com/hyperdrive/platform/pricing/
- Neon Postgres version support: https://neon.com/docs/postgresql/postgres-version-support
- Neon and Hyperdrive: https://neon.com/blog/hyperdrive-neon-faq
