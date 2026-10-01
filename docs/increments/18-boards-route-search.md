# Increment 18: boards and route search

Status: built (2026-10-01) in three parts and reviewed; the review round's rulings (R0 to R15)
were applied the same day in five parts: S1 (the routes and access), S2a (the budget and
storage), S3 (the mobile app), S2b (coverage and the board view) and S4 (the probe and these
documents). What ran, the departures, the review round and what stays unverified are in
`docs/increments/18-verification.md` (the rulings' changes in its Review round section).
Builder: Opus 5.5. Reviewers: two Opus 5.5 lenses (provider, budget, cache and licence posture;
routes, caps and the mobile screens) plus the orchestrator's read; two skeptics on review B's
M1, one on each of MA1 to MA4, and one second skeptic across those four (a departure from two
on every serious finding). Branch `inc18-boards-route-search`, stacked on
`inc15-notification-policy` (for the migration sequence only; nothing here depends on push).

Review round. Neither lens found a blocker, and one major survived the skeptics: the board took
any date of the plan's lookahead with no per-user quota, so one account could drain the boards
share in about 39 minutes (MA2; ruling R3 bounds the board at 72 hours ahead and makes per-user
caps a condition of turning boards on in production). The skeptics on review B's M1 (the phone's
HTTP disk cache kept board answers) found its broader form, every `/v1` answer stored past
sign-out and account deletion, which ruling R1 closes with a `/v1`-wide `no-store`. The rest,
minor or nits, became R2 (a token floor for trackers), R4 (a 7-day purge cap), R5 (coverage by
the spec's statuses), R6 (empty answers stored), R7 (the probe bills the production call), R8
(`BOARDS_ENABLED`, off in production), R9 to R14 (the routes and screens) and R15. Every finding
was accepted; the rulings below that the round changed say "Amended by the review round".

Departures (the reasons are in [18-verification.md](18-verification.md)): B10's schema half (the
two triggers, `airport_icao`) moved into part 1, because the trigger vocabulary needs its check
constraint and drift test, and its migration was renumbered 0010 after increment 15's 0009;
`route_searches` came with the routes in part 2 as a second migration, 0011. The answers carry a
`partial` flag the spec did not name, and a range wholly out of the lookahead is 422. On the
phone, tapping a row asks to confirm before it adds, the add sheet opens a board in place of
itself (a screen pushed from a sheet would open behind it), the add path now sends the row's
`origin`, and the board shows the route's default window only (no time or airline filter yet).
The provider probe (B13) reads billing from the dashboard's unit counter, which it asks for at
each checkpoint, because the direct API has no endpoint for it. The review round's own
departures: ruling R1's `no-store` default reaches the Phase 0 routes too (every `/v1` answer);
production's `BOARDS_ENABLED` is `"false"` rather than absent (R8 as the orchestrator amended
it); ruling R14 keeps an earlier flight only with live data behind its status; and one second
skeptic read MA1 to MA4 together.

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

  Amended by the review round (ruling R4): a bucket is purged at the sooner of 48 hours after it
  ends and 7 days after its fetch (`BOARD_PURGE_AFTER_FETCH_MS`), its rows, chunks and KV copy
  together: the route search reaches the plan's lookahead, and a copy fetched months ahead was
  kept until its date, against Terms 5.5's duty to minimise. Of R3 D5's fresh and stale times
  only the far row's feel it, for a bucket starting more than 108 hours after its fetch:
  quadrupled (B5), its stale time stops at 168 hours instead of 192. The other rows' times are
  unchanged.
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

  Amended by the review round (ruling R2): that holds for the share and the hourly cap, not for
  the rate. Board and tracker calls share ProviderBudget's per-second token bucket, and a refused
  tracker poll loses its slot, so a board or route-search call, its free coverage check included,
  takes a token only while the bucket keeps `boardTokenFloor` more (half the burst, rounded down:
  Starter 1, Growth 2, Scale 5); otherwise it is refused as `board_rate_floor`, with the wait
  until it would pass, and AirportState waits that long. The free coverage check is no refresh:
  it skips the share and the hourly cap (ruling R5), so checks alone never fill the cap.
- **B6. Coverage (R3 D6).** Once per airport per day the object calls the free coverage endpoint
  (the existing `checkCoverage`) and keeps the answer. Neither schedules nor live coverage: a 404
  `board_not_covered` and no FIDS call. Schedules only: the board says so, and the screen shows
  a badge.

  Amended by the review round (rulings R5 and R15): the answer stays in the object's own storage
  (the build also copied it to KV, where nothing read it; the copy is gone), and it follows the
  spec's feed statuses: OK, OKPartial and Degraded mean provided, Down provided but down, Unknown
  or a value outside the enum indeterminate, Unavailable not provided. Live updates provided:
  `live`, for a day; down or indeterminate: `unknown`, for an hour, the board fetched anyway.
  Live updates not provided: the schedules decide the same way (`schedules_only` for a day,
  `unknown` for an hour), and `not_covered` (the 404 with no FIDS call) only when neither feed is
  provided, for a day. The check takes no slot of the hourly airport cap, and one the budget
  refuses stores nothing.
- **B7. Rows, filters and codeshares (R3 D7, D8, D13).** Codeshares are grouped server-side (same
  scheduled UTC time, same opposite airport, same registration or callsign; the `IsOperator` row
  first, the others in `codeshares[]`). Filters apply after the cache and never enter a cache key:
  the time range (at most 12 hours per request) and an airline (operating or marketing). Rows are
  UI-shaped, never provider JSON; every response carries the bucket's `fetchedAt` ("as of"),
  whether it is stale, and an ETag that `If-None-Match` answers with 304.

  Amended by the review round: a row repeating an earlier one's direction, designator and
  scheduled minute (one flight returned by two buckets) is dropped before grouping, and a
  codeshare row with neither key joins the only `IsOperator` row of its direction, minute and
  counterpart, or stays alone (ruling R12: days ahead the aircraft is rarely known). A flight is
  in the time range by its scheduled or its best time, and one scheduled earlier stays while
  live data says it has not yet departed or arrived (ruling R14). `partial` marks only a bucket
  that could not be read, never one out of range (ruling R10). Every answer, the 304 included,
  says `Cache-Control: no-store`, the default of every `/v1` answer (ruling R1), so no board
  stays in the phone's HTTP cache.
- **B8. Routes.** `GET /v1/airports/{code}/board?direction=departures|arrivals&from=&to=&airline=`
  and `GET /v1/airports/{origin}/flights/to/{destination}?date=YYYY-MM-DD` (the route search: the
  origin's two buckets of that origin-local date, departures whose arrival leg is the
  destination, grouped as in B7; the plan's `GET /v1/flights/search` is taken by the designator
  search, which keeps its contract). Both need a session (anonymous accounts included) and live in
  the typed client (`AppType`). The route search's date follows the designator search's lookahead
  bound and answers the same 422 beyond it. Adding a flight from either list uses the existing
  `POST /v1/flights` with the row's designator and origin-local date. City codes (NYC, LON) are out
  of scope: the `airports` table has no metro grouping.

  Amended by the review round: both routes answer 404 `boards_disabled` unless `BOARDS_ENABLED`
  is `"true"` (locally and on staging; production says `"false"` until AeroDataBox's written End
  Use answer and the per-user caps of B9, rulings R8 and R3), before the session is read; the
  session must be a session principal, never an API token (ruling R15). A board window may end at
  most 72 hours ahead (a 422 `date_out_of_range` with `maxHoursAhead`, ruling R3): later dates are
  the route search's, which is capped. The route search keeps only the departures of the
  searched origin-local date (ruling R12).
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

  Amended by the review round: `BOARD_RL` is keyed by the user only, and a second binding,
  `BOARD_IP_RL` (300 per 60 seconds, like `EVENTS_RL`), by the client's address reduced to its
  /64 (`normaliseClientIp`), so one NAT or IPv6 subnet of real installs is not starved by
  another's 30 (ruling R11); every 403 `cap_exceeded` names its `scope` (`user` or `ip`), and the
  app tells an anonymous account held by its network's cap to sign in. Required before boards
  are on in production, and not built in this increment (ruling R3): a per-user daily budget
  charged on real FIDS reservations (a salted principal carried in the bucket request through to
  `ProviderBudget.reserve`, enforced in the same transaction as the share), a per-salted-IP
  counterpart, and distinct airports per user per hour counted only on FIDS reservations
  (`docs/open-decisions.md` section 9).
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

  Amended by the review round: the board renders its rows as a list that mounts only what is on
  screen, so a 700-row hub board stays fast (ruling R13); a second leg of the same flight number
  can be added from a board (ruling R9); the route search asks again only after an error or once
  its answer is 5 minutes old, and nothing on it invites a pull, since each search counts
  (ruling R10); an anonymous account held by its network's search cap is asked to sign in
  (ruling R11); and while boards are off, both screens say they are not available yet instead of
  showing an error (ruling R8).
- **B13. The provider test calls (plan section 8 row 18).** No AeroDataBox key exists, so the
  about-40-unit probe of R3 U1 to U7 (`direction=Both` billing, `withLeg` and `withLocation`
  surcharges, 204 and 400 billing, the window bound's inclusivity, a date 180 days out, and a hub
  bucket's payload size and latency at KATL, EGLL and KJFK) is written as a script beside
  `scripts/record-adb-fixtures.mjs`, dry-run tested, and listed for the owner to run on the day
  the Growth key arrives. Every design choice that depends on its answers either works either way
  (B3's chunking) or is named as unverified in the verification doc.

  Amended by the review round (rulings R7 and R12): the probe also bills one call in the
  adapter's exact production query between two counter readings, and the whole run with a last
  reading, so `ADB_UNITS.fids` is set to what AeroDataBox charges; it counts the codeshare rows
  days ahead that carry a callsign or a registration; it never follows a redirect; and its
  findings keep booleans and counts only, no flight number, time or path. About 44 units.

## Acceptance

- Coalescing: N concurrent board requests for one cold bucket make one FIDS call, in the Workers
  pool with a stubbed provider; a second request inside `freshUntil` makes none; a request past
  it and before `staleUntil` gets the stale copy while one refresh runs.
- The ladder's six rows and the three degrade steps (70, 90, 100 percent), and that tracker
  reserves are unaffected by a spent boards share.
- The distinct-airports-per-hour cap, `BOARD_RL` by user and by IP (amended: `BOARD_IP_RL` by
  the /64, ruling R11), the anonymous airport limit, and the route-search caps (per user, and per
  salted IP for anonymous accounts).
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
