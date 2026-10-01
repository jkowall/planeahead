# Increment 18 verification: boards and route search

Branch `inc18-boards-route-search` (stacked on increment 15 for the migration sequence),
2026-10-01, built in three parts: part 1 (61e865f) the airport board cache (B1 to B6, and B10's
schema half), part 2 (ec2eadf) the routes, caps and admin page (B7 to B11), part 3 the mobile
screens (B12), the provider probe (B13) and these docs. This file records what ran on the build
machine with its result, how each acceptance item is proven, what the build found that the spec
did not have, where it departs from the spec and why, the owner's steps for the probe and the
staging boards, and what stays unverified until staging and the AeroDataBox Growth key exist. The
spec is [18-boards-route-search.md](18-boards-route-search.md); the research behind it is
`docs/research/phase1/R3-boards-and-route-search.md` (R3).

The machine: macOS 27.0, Node 24.21.0, pnpm 12.5.1, wrangler 4.135.0. No Cloudflare account and
no AeroDataBox key: every FIDS and coverage call in this increment went to a stubbed provider or
an injected `fetch`, and the probe of B13 ran only as its dry run and against a stubbed gateway.

## What ran here

| Part | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | Shared and db | `pnpm exec vitest run` (packages/shared, packages/db) | passed: shared 29 files, 740 tests; db 11 files, 196 tests |
| 1 | API unit | `pnpm exec vitest run <files>` (apps/api) | passed: aerodatabox.adapter 68, aeroapi.mock 59, cost-log 5, unit budget 19, router 7 |
| 1 | Workers pool | `pnpm exec vitest run <files>` (apps/api) | passed: airport-state 15, airport-ref 2, provider-budget 24, persist 11, do-ping 9, health 7, migrate-runner 10, spikes 7 (1 skipped), designator-resolver 11, flight-tracker.retries 7 |
| 1 | The rest | typecheck, lint, prettier, `gen-migration-hash.mjs --check`, toolchain guard, both wrangler dry runs | clean |
| 2 | API unit | `pnpm exec vitest run <files>` (apps/api) | passed: board-view 13, app-type 9, cost-log 5 |
| 2 | Workers pool | `pnpm exec vitest run <files>` (apps/api) | passed: boards.routes 9, boards.access 6, admin-boards 3, airport-state 15, provider-budget 24, persist 11, admin-access 9, flights.subscribe 23, migrate-runner 10, health 7 |
| 2 | Shared and db | `pnpm exec vitest run` | passed: shared 29 files, 797 tests; db 12 files, 203 tests |
| 2 | The rest | typecheck, lint, prettier, migration hash (`22e7422865b8`, 12 migrations), toolchain guard, both wrangler dry runs (with `env.BOARD_RL (30 requests/60s)`) | clean |
| 3 | Mobile typecheck and lint | `pnpm run typecheck`, `pnpm run lint` (apps/mobile) | clean |
| 3 | Mobile suite | `pnpm exec jest --ci` (apps/mobile) | passed: 38 suites, 696 tests, 16 snapshots in 7 s; new: airport-board 23, route-search 13, boards 22; detail 26 (2 new); add-flight 69; house-style 2 new (this file and the probe script are scanned) |
| 3 | Snapshots | `pnpm exec jest __tests__/add-flight.test.tsx __tests__/detail.test.tsx -u` | 4 updated after reading the diffs: additions only (the add sheet's "Find it another way" section, the detail's "Airport boards" section), in light and dark |
| 3 | Tools | `pnpm exec vitest run --dir tools` (root) | passed: 7 files, 70 tests; probe-adb-boards 10 (new) |
| 3 | Probe dry run | `node scripts/probe-adb-boards.mjs --dry-run --date 2026-10-02` | 24 calls, 42 units expected (38 if 204 and 400 are free, 62 if `direction=Both` bills both directions); no network call |
| 3 | Root lint, formatting, guards | `pnpm run lint:root` (eslint over scripts and tools), `pnpm exec prettier --check <changed files>`, `node scripts/mobile-migrations-guard.mjs --base origin/main`, `node scripts/toolchain-guard.mjs` | clean; the mobile guard: 4 migrations, 10 committed files unchanged (no mobile SQLite migration) |

Part 3 changed nothing in apps/api, packages/shared or packages/db, so their suites and the
wrangler dry runs were not rerun for it; the counts above for parts 1 and 2 are those parts' own
runs.

## Acceptance, item by item

| Acceptance item | Where it is proven | Result |
| --- | --- | --- |
| Coalescing: N concurrent requests for a cold bucket, one FIDS call; none inside `freshUntil`; stale with one refresh between `freshUntil` and `staleUntil` | `apps/api/test/workers/airport-state.test.ts`, "coalescing and the read path"; `boards.routes.test.ts`, "fills a cold bucket with one FIDS call, then serves KV with none" | passed, in the Workers pool with a stubbed provider |
| The ladder's six rows; the 70, 90 and 100 percent steps; trackers untouched by a spent share | `packages/shared/test/boards.test.ts` (one test per row, the degrade steps, the purge never degraded); `airport-state.test.ts`, "the boards share degrades the ladder"; `provider-budget.test.ts`, "refuses board calls past 35 percent of the cap, reports the share, and never touches trackers" | passed |
| The distinct-airports-per-hour cap, `BOARD_RL` by user and by IP, the anonymous airport limit, the route-search caps | `provider-budget.test.ts` (60 airports per UTC hour, keyed by the named airport); `boards.access.test.ts` (`BOARD_RL` 30 per 60 s taken by user and by IP on both routes; anonymous accounts open only their live subscriptions' airports; 30 searches per user per day, and 30 per salted IP for anonymous accounts) | passed |
| A hub-sized bucket stores, chunks, reads back and purges; B1's mapping; the grouping | `airport-state.test.ts`, "a hub-sized bucket" (a synthetic 4,000-row bucket, over 1 MB of gzip, in at least 2 chunks, purged with its KV copy); `aerodatabox.adapter.test.ts` (both directions with legs and codeshares, skipped items counted); `board-view.test.ts` (grouping, filters, ETag) | passed |
| The route search's filtering, date bound and grouping; add-from-board through the existing subscribe path | `boards.routes.test.ts` (both buckets of the date, the destination filter, 422 past the lookahead charging nothing, 404 and 400); "adding a flight from a board" posts the row's `add`; on the phone, `apps/mobile/__tests__/airport-board.test.tsx` and `route-search.test.tsx` send `POST /v1/flights` with the row's designator, date and origin through the real outbox | passed |
| The migration, the trigger parity test, `airport_icao` on a recorded board call | `packages/db/test/schema-contracts.test.ts`, `route-searches-migration.test.ts`; `packages/shared/test/provider-call-point.test.ts`; `airport-state.test.ts`, "sends each call record with the airport"; `persist.test.ts`; `cost-log.test.ts` | passed |
| Mobile: both screens in light and dark from mocked answers, offline, tap to add, the anonymous gating | `airport-board.test.tsx` (23: both directions, as of, stale, partial, schedules only, pull to refresh, light and dark snapshots and tokens, offline three ways, tap to add with its confirmation and a refusal, the row that cannot be added, 403 `board_requires_account`, 429, 404, 503, 504, and the add sheet's airport field for signed-in users only); `route-search.test.tsx` (13: validation, results in light and dark, 403 `cap_exceeded`, 429, 404, 422, offline, tap to add, an anonymous search, re-asking only after a failure); `boards.test.ts` (22); `detail.test.tsx` (the two board buttons) | passed |
| The full check and both wrangler dry runs | parts 1 and 2 (above) | passed; the exit test and B13's probe are unverified (below) |

## Measurements

- **The probe's plan (B13):** 24 calls (3 free coverage checks and 21 FIDS calls at 2 units),
  42 units expected; 38 if a 204 and a 400 bill nothing, 62 if `direction=Both` bills both
  directions (it is the production shape, so U4's 9 hub calls would double too). Within R3's
  "about 40".
- **A hub bucket's storage (part 1, synthetic):** a 4,000-row bucket gzips to more than 1 MB and
  is stored in at least 2 chunks of at most 1 MB, under the 2 MB value limit whatever the real
  size (R3 F37). The real size and latency of KATL, EGLL and KJFK buckets are U4, unmeasured.
- **The phone's suites:** the 696 mobile tests run in 7 s; the three new suites take under 2 s
  each. Nothing about the screens was measured on a device.

## Findings the spec did not have

- **No API endpoint reads the unit counter.** AeroDataBox's direct API has
  `GET /subscriptions/balance`, but that is the webhook credit balance, separate from the API
  quota; nothing reports the units a call spent. So U2, U3 and U6 are read from the dashboard: the
  probe stops at each checkpoint and asks for the counter (Enter skips), and it records every
  response header that looks like a quota counter in case the gateway sends one. How soon the
  dashboard counter moves after a call is unknown; the prompt says to wait for it.
- **A screen pushed from the add sheet would open beneath it.** In react-native-screens' native
  stack, pushed screens live in the navigation controller underneath any presented modal, so a
  board pushed from the sheet would land behind the sheet. The sheet therefore replaces itself
  with the board (`router.replace`), and the route search is itself a sheet over the sheet, so
  closing it returns there. This follows the library's model; no device has shown it.
- **The app's add path never sent an origin.** `addFlight` took a designator and a date;
  `POST /v1/flights` already accepted `origin`, which picks the leg when one flight number flies
  several legs a day. A board row knows its leg, so `AddFlightRequest` gained `origin` and the
  board and the route search send the row's `add` whole.
- **A long delay leaves the board.** The window keeps rows by the home leg's scheduled time (the
  bucket basis, part 2), and the default window starts an hour before now, so a departure
  scheduled more than an hour ago that has not left yet (a long delay) is not on the board. The
  route search, which reads whole dates, still finds it.
- **The phone's HTTP cache may hold a board.** The routes answer `Cache-Control: private,
  no-cache` with an ETag, which lets a private cache store the answer and revalidate it. React
  Native's iOS networking uses an `NSURLSession` default configuration, whose shared URL cache has
  a disk store; whether board answers land there is unverified, and if they do, the phone keeps a
  copy outside the query cache's memory, against B12's intent (R3 F13: as few copies as
  possible). The fix would be `no-store` on the two routes (the app never sends `If-None-Match`,
  so it loses nothing) or a request-side cache policy.
- **Starter's 5 calls a second (part 2).** A user opening several cold boards within a second can
  get 503 `board_unavailable` on Starter (Growth allows 10 a second). The tests raise the limit
  with `openBoardBudget`.
- **Daylight saving (part 1).** On a change day a bucket is 11 or 13 real hours; a 13-hour window
  may be refused on Starter's 12-hour page (unverified; Growth's page is 24 hours).
- **The migration hash (part 2)** changed after Prettier reformatted the journal and snapshot
  drizzle-kit generated; the committed hash is the formatted files'.

## Departures from the spec, and clarifications

- **B10's schema half moved into part 1.** The `board` and `route_search` triggers,
  `provider_calls.airport_icao` (with an ICAO format check) and `providerCallRow` filling it came
  with the cache, not the routes: the trigger vocabulary needs its check constraint and the
  parity test the moment AirportState records a call. The migration was generated as
  `0009_board_calls`, then regenerated by the orchestrator as `0010_board_calls` (identical
  statements) after increment 15's `0009_live_tracked_released_at` was merged in (merge d7c474c,
  regeneration 562724c).
- **Two migrations, not one.** B10 named one migration; the `route_searches` counter kind came
  with the caps in part 2 as `0011_route_searches` (`DB_SCHEMA_VERSION` 12, hash `22e7422865b8`).
- **On the append-only rule (B10).** Every deploy is a whole `wrangler deploy`, so no older
  consumer runs beside the new producer except in a deploy's switchover seconds, where a refused
  call record is an accepted accounting loss; the reasoning is in the trigger list's header.
- **`partial` and 422 (part 2).** The answers carry `partial: true` when part of the range could
  not be read (a field the spec did not name), and a range whose every bucket is out of range is
  422 `date_out_of_range`, the designator search's answer.
- **Route-search charging (part 2).** The order is `BOARD_RL`, `requireFreshSession()` (it takes
  caps), then validation; the caps are taken after the airports resolve and given back when
  nothing could be shown (404, 422, 503, 504); a 304 counts as a search.
- **Counterpart airports by code (part 2).** Rows name the other airport by ICAO and IATA code
  only; names are not resolved, and the registration is never sent.
- **Tap to add confirms first (part 3).** The spec says "tap to add"; a tap asks `Add AA100?` with
  the date and route, then adds. An add takes one of the free plan's five tracked flights and a
  board lists hundreds of rows, so a mis-tap would cost a slot the user has to find and remove.
- **The board shows the default window only (part 3).** The route takes `from`, `to` and
  `airline`; the screen asks for none of them and shows the route's default window (an hour ago, for
  12 hours) with a departures and arrivals switch. The filters are a later screen's.
- **Where the screens open (part 3).** The board is a pushed screen, opened from the detail (the
  origin's departures, the destination's arrivals) and, for signed-in users, from the add sheet's
  airport field, which replaces the sheet with it. The field is hidden, not disabled, for an
  anonymous account and while the session is still being read. The route search is a sheet over
  the add sheet, for everyone.
- **What the screens refetch (part 3).** Neither query retries on its own; every refusal is final
  for the moment and a 503 asks for 30 s. The board refetches on focus once its data is 30 s old
  (the app default; the route's KV `cacheTtl` is 30 s too). The route search is never refetched on
  focus or reconnect, and the same search pressed again is asked only when its answer failed or
  is older than 5 minutes, because each answered search takes one of the day's 30.
- **Offline with a board on screen (part 3).** A board or result already loaded stays on screen
  offline with a notice that it is the last answer loaded (from the query cache, in memory);
  with nothing loaded, the screen says it is offline instead of showing an empty list, and the
  query runs when the phone is back online.
- **The probe (part 3).** Beyond the spec's list it checks the free coverage of the three hubs,
  measures a 24-hour window at each hub as well as both 12-hour buckets (R3 U4 asks for both),
  and settles U7's inclusivity from a departure scheduled at exactly 12:00 and not revised later.
  Its findings default to the OS temp directory, `--pause-ms` spaces the calls (300 ms), and
  `--no-prompt` skips the counter readings.

## The owner's steps

### The probe, on the day the Growth key arrives (B13; R3 O3)

Run from the repository root on your own machine, never in CI. It spends about 42 units of the
400,000.

1. `node scripts/probe-adb-boards.mjs --dry-run --date <today in New York>` prints every call,
   its units and the checkpoints, with no network call.
2. Open the AeroDataBox dashboard on the page that shows the API units used this period.
3. Run the probe:

   ```sh
   AERODATABOX_API_KEY=<the Growth key> node scripts/probe-adb-boards.mjs --date <the same date> --out docs/increments/18-probe-findings.json
   ```

   At each prompt (`before`, then after each billing call), wait until the dashboard's counter
   has moved, then type it; Enter skips one.
4. `pnpm exec prettier --write docs/increments/18-probe-findings.json`; the script also prints
   the answers. Copy each into [Unverified](#unverified) below, item by item, and commit both.
5. Act on the answers: U2 at 4 units for `direction=Both` doubles every board fetch's cost (it is
   still one fetch, inside the share; revisit the share in `config.ts` with R3 O4); U1 selecting
   by revised time means the board's scheduled-time window can miss a flight revised into it
   (widen the window by an hour, or filter by the best time); U5 refused means the board
   lookahead must drop below the plan's `maxDaysAhead`; U4 over 2 MB of gzip needs nothing (the
   chunks are 1 MB) but is worth knowing for KV; U7 needs nothing either way (the buckets end at
   11:59 and 23:59).

### The three boards from cache on staging (the exit test)

Before: staging runs this branch (runbook step 10) with `AERODATABOX_API_KEY` and
`ADB_PLAN=growth` set (step 6), Access protects `/admin` (step 14), and a development build points
at staging, signed in with a real account (a guest opens only its own flights' airports).

1. Add sheet, **Airport board**: `KATL`, **Open the board**. Departures show with an "As of" time
   within a minute or two of now, and no "Schedules only" badge.
2. **Arrivals**: the same "As of" time (one `direction=Both` fetch fills both directions).
3. Back, then open KATL again within 5 minutes (the current bucket's freshness): the same "As of"
   time, served from the cache.
4. The same for `EGLL` and `KJFK`; then **Search by route** from JFK to LHR today: results, and
   no new call (the route search reads the KJFK buckets the board filled).
5. `/admin`, boards section: the airports refreshed in the last hour are KATL, EGLL and KJFK;
   board calls today by result show one `ok` per bucket fetched (the default window usually
   spans two buckets), and none for steps 2 to 4.
6. On the staging branch:

   ```sql
   select airport_icao, trigger, result, count(*)
   from provider_calls
   where operation = 'fids' and trigger in ('board', 'route_search')
     and created_at > now() - interval '1 hour'
   group by 1, 2, 3
   order by 1;
   ```

   At most two `ok` calls per airport (one per bucket), however many views. The free coverage
   checks are the `health` operation, once per airport per day.
7. Record the times, the counts and anything unexpected under [Unverified](#unverified).

## Unverified

- **The exit test: boards for KATL, EGLL and KJFK from cache on staging.** There is no staging
  and no key; the steps above prove it. Until then coalescing and the cache are proven only in the
  Workers pool against a stubbed provider.
- **B13's probe.** Written, dry-run tested and run once against a stubbed gateway in
  `tools/providers/probe-adb-boards.test.js`; never against AeroDataBox. Its answers settle U1 to
  U7 below.
- **R3 U1, selection by scheduled or revised time.** The board keeps rows by scheduled time; if
  FIDS selects by revised time, a flight revised into a bucket from outside it is missing from
  that bucket. Probe: `u1-revised-window`, `u1-scheduled-window`.
- **R3 U2, `direction=Both` at 2 units.** The boards share and the cost estimate assume one Tier 2
  call; at 4 units every board fetch costs double. Probe: `u2-both` against `u2-departure`.
- **R3 U3, no surcharge for `withLeg` or `withLocation`.** `withLeg` is in the production shape;
  `withLocation` is never sent by the app (only by the probe, once). Probe: `u3-withleg`,
  `u3-withlocation`.
- **R3 U4, a hub bucket's size and latency.** Chunking makes any size storable (B3); the cold-miss
  latency against the 8 s deadline per bucket read is unknown. Probe: the nine `u4-*` calls.
- **R3 U5, a date 180 days out.** The routes follow the plan's `maxDaysAhead` (365 on Growth);
  whether FIDS answers that far is unknown. Probe: `u5-180-days`.
- **R3 U6, whether a 204 or a 400 bills units.** The adapter records a 204 as billed
  `not_found`, the cautious reading. Probe: `u6-empty`, `u6-too-wide`.
- **R3 U7, the page-size bound.** The buckets end at 11:59 and 23:59, so either answer works.
  Probe: `u7-exact-page`, `u7-to-1159`, `u7-to-1200`.
- **R3 U8, the live layer's latency.** How soon a gate change or a revised time reaches FIDS:
  a week of staging observation against airline and airport sites, not part of the probe.
- **R3 U9 and AeroDataBox's written End Use answer (R3 O2, plan section 10 item 3).** Not asked
  from here and not received. Boards and route results stay out of share pages, public API
  tokens and MCP (the routes' header says so), and the in-app boards need the written answer
  before they reach real users.
- **The screens on a device.** Everything above ran in Jest; no simulator or phone showed the
  board or the route search. Unverified there: the sheet replacing itself with the board, the
  route search as a sheet over a sheet on iOS and Android, VoiceOver and TalkBack reading a row's
  label and hint, long rows at large text sizes, and pull to refresh on both platforms.
- **The phone's HTTP cache** (see the findings): whether React Native's iOS or Android stack
  writes `private, no-cache` board answers to disk.
- **A 13-hour bucket on Starter** (a daylight saving change day); irrelevant on Growth.
- **The admin page's boards section** under a real Access session, and the Analytics Engine
  point's `airport_icao` (blob6) in a real dataset.
