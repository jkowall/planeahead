# Increment 18: boards and route search

Status: built (2026-10-01) in three parts; review pending. Builder: Opus 5.5. Reviewers: two Opus 5.5 lenses (provider,
budget, cache and licence posture; routes, caps and the mobile screens) plus the orchestrator's
read; two skeptics on every serious finding. Branch `inc18-boards-route-search`, stacked on
`inc15-notification-policy` (for the migration sequence only; nothing here depends on push).

Departures (the reasons are in [18-verification.md](18-verification.md)): B10's schema half (the
two triggers, `airport_icao`) moved into part 1, because the trigger vocabulary needs its check
constraint and drift test, and its migration was renumbered 0010 after increment 15's 0009;
`route_searches` came with the routes in part 2 as a second migration, 0011. The answers carry a
`partial` flag the spec did not name, and a range wholly out of the lookahead is 422. On the
phone, tapping a row asks to confirm before it adds, the add sheet opens a board in place of
itself (a screen pushed from a sheet would open behind it), the add path now sends the row's
`origin`, and the board shows the route's default window only (no time or airline filter yet).
The provider probe (B13) reads billing from the dashboard's unit counter, which it asks for at
each checkpoint, because the direct API has no endpoint for it.

Read first: `docs/plans/phase1-plan.md` (section 3 rows Boards and Route search; section 4 Boards
and Providers; section 5; section 6; section 7; section 8 row 18; section 9 item 6; section 10
item 3), `docs/research/phase1/R3-boards-and-route-search.md` (all of it: facts F1 to F20 and F36
to F37, conflicts C4 to C6 and C10 to C13, design items D1 to D14, the cost section, U1 to U9),
`apps/api/src/providers/aerodatabox.adapter.ts` (`getBoard`, `checkCoverage`, `#attempt`,
`boardRow`), `packages/shared/src/providers.ts` and `flight-status.ts` (`BoardWindow`, `BoardRow`,
`PROVIDER_CALL_TRIGGERS` and the append-only rule at the top of the file),
`apps/api/src/providers/budget.ts`, `apps/api/src/do/provider-budget.ts` and
`apps/api/src/providers/token-bucket.ts`, `apps/api/src/providers/config.ts`,
`apps/api/src/providers/http.ts` and `cost-log.ts`, `packages/shared/src/provider-call-point.ts`,
`apps/api/src/do/airport-state.ts` (the empty shell) and `designator-resolver.ts` (the `#inflight`
pattern), `apps/api/src/lib/caps.ts`, `packages/shared/src/limits.ts`,
`apps/api/src/middleware/rate-limit.ts`, `apps/api/wrangler.jsonc`,
`packages/db/src/schema/reference.ts` and `packages/db/src/queries/airports.ts`,
`apps/api/src/routes/flights.ts` (the existing designator search and subscribe),
`apps/mobile/src/app/(app)/` (home, add, flight detail), `apps/mobile/src/lib/api-client.ts`,
`apps/mobile/src/lib/flights.ts`, `docs/schema-review.md` lines 94 and 681 (the Phase 0 board keys
this increment replaces), ADR 0007 and ADR 0010.

## Goal

Departure and arrival boards for any covered airport, and a search for the flights between two
airports on a date, served from a per-airport cache that AeroDataBox FIDS fills at most once per
bucket per freshness window, whatever the number of viewers, inside a share of the daily
AeroDataBox budget that can never starve the flight trackers. No AeroAPI anywhere in this path.

## Rulings

- **B1. One fetch shape (R3 D2).** A new adapter method replaces `getBoard` (it has no callers;
  remove it and the AeroAPI mock's version, since boards are AeroDataBox only, plan section 3):
  one call for an airport and a window, `direction=Both`, `withLeg=true`, `withCodeshared=true`,
  `withCancelled=true`, `withCargo=false`, `withPrivate=false`, no `withLocation`, returning both
  arrays mapped to board rows that carry both legs' scheduled and best times, terminals and gates,
  the status, the operator resolved as `boardRow` does today, `codeshareStatus`, the aircraft
  model, and every skipped item counted on the call record (today they vanish silently). The
  `BoardRow` contract gains what the rows need; the doc comment's claim that FIDS selects by
  scheduled time is replaced with R3 F9's wording (unverified, U1).
- **B2. Buckets (R3 D3).** 12-hour buckets aligned to airport-local 00:00 to 11:59 and 12:00 to
  23:59, one FIDS call each. The Worker resolves the airport (IATA or ICAO, from the `airports`
  table through a KV entry `ref:airport:{ICAO}` kept a day) and passes its ICAO code and IANA
  zone to the object, because Durable Objects never open Postgres (ADR 0007). An unknown code is
  a 404 and never reaches the object, so objects exist only for real airports.
- **B3. AirportState is the only caller of FIDS (R3 D4).** One object per ICAO code. It coalesces
  concurrent misses per bucket with an in-flight map (the resolver's pattern plus the tracker's
  staleness guard, `INFLIGHT_STALE_MS`), stores each bucket's normalised rows compressed (gzip
  through `CompressionStream`) in its SQLite storage split into chunks of at most 1 MB, so no size
  of board can hit the 2 MB value limit (R3 F37; the real size is unmeasured, U4), and writes KV
  `board:v2:{ICAO}:{bucketStartLocal}` with `fetchedAt`, `freshUntil` and `staleUntil`. Workers
  read KV first (`cacheTtl` 30 s) and call the object only on a miss or past `freshUntil`. The
  object's alarm purges buckets 48 hours after they end and never refreshes one ended more than
  24 hours ago (R3 D5, Terms 5.5). `docs/schema-review.md` and `docs/architecture.md` replace the
  Phase 0 `board:{ICAO}:{dir}:{hour}` keys with these.
- **B4. The freshness ladder (R3 D5, normative).** The six rows of R3 D5 exactly, as constants in
  `packages/shared` with a test per row, serving stale data between `freshUntil` and `staleUntil`
  while one refresh runs.
- **B5. The boards share of the budget (plan section 4).** `ProviderBudget.reserve` gains a sub-cap
  for the triggers `board` and `route_search` together: 35 percent of the day's AeroDataBox cap.
  A board reserve beyond it is denied with a new reason. The decision reports the share spent, and
  AirportState doubles every freshness and stale time at 70 percent, quadruples them at 90, and
  serves stale only at 100 (never an empty board while a stale copy exists). The same reserve
  enforces a global cap on distinct airports refreshed per UTC hour (60 by default), keyed by the
  airport the request names, so no traffic pattern sweeps airports the way Terms 8.2 forbids
  (R3 F17). Both limits are constants beside the plan table in `config.ts`, settable later with
  the rest of the budget (increment 17). Tracker polls never see these limits.
- **B6. Coverage (R3 D6).** Once per airport per day the object calls the free coverage endpoint
  (the existing `checkCoverage`) and keeps the answer in KV `adb:coverage:{ICAO}`. Neither
  schedules nor live coverage: a 404 `board_not_covered` and no FIDS call. Schedules only: the
  board says so, and the screen shows a badge.
- **B7. Rows, filters and codeshares (R3 D7, D8, D13).** Codeshares are grouped server-side (same
  scheduled UTC time, same opposite airport, same registration or callsign; the `IsOperator` row
  first, the others in `codeshares[]`). Filters apply after the cache and never enter a cache key:
  the time range (at most 12 hours per request) and an airline (operating or marketing). Rows are
  UI-shaped, never provider JSON; every response carries the bucket's `fetchedAt` ("as of"),
  whether it is stale, and an ETag that `If-None-Match` answers with 304.
- **B8. Routes.** `GET /v1/airports/{code}/board?direction=departures|arrivals&from=&to=&airline=`
  and `GET /v1/airports/{origin}/flights/to/{destination}?date=YYYY-MM-DD` (the route search: the
  origin's two buckets of that origin-local date, departures whose arrival leg is the
  destination, grouped as in B7; the plan's `GET /v1/flights/search` is taken by the designator
  search, which keeps its contract). Both need a session (anonymous accounts included) and live in
  the typed client (`AppType`). The route search's date follows the designator search's lookahead
  bound and answers the same 422 beyond it. Adding a flight from either list uses the existing
  `POST /v1/flights` with the row's designator and origin-local date. City codes (NYC, LON) are out
  of scope: the `airports` table has no metro grouping.
- **B9. Access and caps (plan section 3, R3 D11).** A new rate-limit binding `BOARD_RL` (30 per 60
  seconds) is taken twice per board or route-search request, keyed by the user and by the client
  IP, in every environment (wrangler.jsonc, runbook step 2 if it lists bindings). Anonymous users
  may open only the boards of airports on their live subscriptions (origin or destination, one
  indexed Postgres query per anonymous request); signed-in users may open any covered airport.
  The route search stays open to anonymous users, because every new install starts anonymous and
  finding a flight by route is the onboarding path, but it takes a daily cap through
  `usage_counters`: `route_searches`, 30 per user per UTC day, and for an anonymous account also
  30 per salted IP per day, the way `tracker_creations` works (`flight-search.ts`). Boards stay
  out of share pages, public tokens and MCP until AeroDataBox answers the End Use question (plan
  section 10 item 3); say so in the route's header.
- **B10. Attribution and counters.** A Postgres migration (the next number after increment 15's,
  generated by drizzle-kit, hash regenerated) adds `board` and `route_search` to the
  `provider_calls` trigger check and an `airport_icao` column, which `providerCallRow` fills from
  the call record, and adds `route_searches` to the `usage_counters` counter check (dropped and
  re-added as migration 0003 did); the
  Analytics Engine point gains the airport as a new last blob. The shared trigger list and its db
  mirror grow together, with the parity test. On the append-only rule's "one release after":
  every deploy is a whole `wrangler deploy` (deploy-staging.yml, deploy-production.yml), so no
  older consumer runs beside the new producer except in a deploy's switchover seconds, where a
  refused record is an accepted accounting loss; record this reasoning in the file's header and
  in the verification doc.
- **B11. The admin page.** A boards section: the share spent today against its cap, distinct
  airports refreshed this hour against theirs, the airports with a bucket refreshed in the last
  hour (the "airports kept live" of plan section 4), and board and route-search calls by result.
- **B12. Mobile.** A board screen (`(app)/airport/[code].tsx`) with departures and arrivals, the
  "as of" time, the stale state, the schedule-only badge, pull to refresh, and tap to add; opened
  from the flight detail's origin and destination, and, for signed-in users, from an airport
  field on the add sheet. A route-search screen beside the add sheet:
  origin, destination and date, results with tap to add, open to anonymous users within B9's
  caps. Server data only, fetched with TanStack
  Query through the typed client (the first real use of `useQuery`), never written to the local
  SQLite store, since the cache terms require minimising copies (R3 F13). Offline, both screens
  say so instead of showing an empty list.
- **B13. The provider test calls (plan section 8 row 18).** No AeroDataBox key exists, so the
  about-40-unit probe of R3 U1 to U7 (`direction=Both` billing, `withLeg` and `withLocation`
  surcharges, 204 and 400 billing, the window bound's inclusivity, a date 180 days out, and a hub
  bucket's payload size and latency at KATL, EGLL and KJFK) is written as a script beside
  `scripts/record-adb-fixtures.mjs`, dry-run tested, and listed for the owner to run on the day
  the Growth key arrives. Every design choice that depends on its answers either works either way
  (B3's chunking) or is named as unverified in the verification doc.

## Acceptance

- Coalescing: N concurrent board requests for one cold bucket make one FIDS call, in the Workers
  pool with a stubbed provider; a second request inside `freshUntil` makes none; a request past
  it and before `staleUntil` gets the stale copy while one refresh runs.
- The ladder's six rows and the three degrade steps (70, 90, 100 percent), and that tracker
  reserves are unaffected by a spent boards share.
- The distinct-airports-per-hour cap, `BOARD_RL` by user and by IP, the anonymous airport limit,
  and the route-search caps (per user, and per salted IP for anonymous accounts).
- A synthetic hub-sized bucket (thousands of rows) stores, chunks, reads back and purges; B1's
  mapping on synthetic fixtures of both directions with legs and codeshares, and the grouping.
- The route search's filtering, date bound and grouping; add-from-board through the existing
  subscribe path.
- The migration, the trigger parity test, and `airport_icao` on a recorded board call.
- Mobile: both screens render from mocked responses in light and dark, the offline state, tap to
  add, and the anonymous gating of free-form airport boards.
- The full check and both wrangler dry runs are green. The exit test (boards for KATL, EGLL and
  KJFK from cache on staging) and B13's probe are unverified until staging and the Growth key
  exist; the verification doc gives the exact steps.

## Out of scope

AeroAPI boards or `/schedules`, pre-warming (R3 D14 allows at most tracked airports; none here),
connections and city codes, share pages and MCP, weather and the airport delay index (Phase 2),
and the real provider calls (B13).
