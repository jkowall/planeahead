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

The review round (two lenses on c5d7b3f, rulings R0 to R15, applied the same day in parts S1,
S2a, S3, S2b and S4) is recorded at the end, under [Review round](#review-round). Where a ruling
changed what a section above says, that section says so; the tables of what ran and of the
acceptance items stay as the build ran them.

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

- **The probe's plan (B13, as the review round left it):** 25 calls (3 free coverage checks and
  22 FIDS calls at 2 units), 44 units expected; 40 if a 204 and a 400 bill nothing, 66 if
  `direction=Both` bills both directions (it is the production shape, so U4's 9 hub calls and
  B7's call would double too). The build's plan was 24 calls and 42 units: ruling R12 added B7's
  call days ahead, and ruling R7 put counter readings around one production call
  (`u4-KATL-am`, already in the plan) and one more at the end.
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
  dashboard counter moves after a call is unknown: each prompt asks for it once it has stopped
  moving, and the dry run prints each reading's running total (the re-review's M4).
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
  route search, which reads whole dates, still finds it. Fixed in the review round (ruling R14):
  a flight is also kept by its best time, and one scheduled before the window stays while live
  data says it has not yet departed or arrived.
- **The phone's HTTP cache may hold a board.** The routes answer `Cache-Control: private,
  no-cache` with an ETag, which lets a private cache store the answer and revalidate it. React
  Native's iOS networking uses an `NSURLSession` default configuration, whose shared URL cache has
  a disk store; whether board answers land there is unverified, and if they do, the phone keeps a
  copy outside the query cache's memory, against B12's intent (R3 F13: as few copies as
  possible). The fix would be `no-store` on the two routes (the app never sends `If-None-Match`,
  so it loses nothing) or a request-side cache policy. The review confirmed the store on both
  platforms and found it broader (every `/v1` GET, the sync feed included); ruling R1 made
  `no-store` the `/v1` default. Two premises here were wrong: the transport is `expo/fetch`, not
  React Native's networking, and its platform stacks do send `If-None-Match` from a stored ETag;
  a request-side policy would not work either (`expo/fetch` drops the `cache` option).
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
  422 `date_out_of_range`, the designator search's answer. Since ruling R10, `partial` marks only
  a bucket that could not be read, never one out of range, which no pull can fill.
- **Route-search charging (part 2).** The order is `BOARD_RL`, `requireFreshSession()` (it takes
  caps), then validation; the caps are taken after the airports resolve and given back when
  nothing could be shown (404, 422, 503, 504); a 304 counts as a search. Since the review round
  both routes first answer 404 `boards_disabled` while boards are off (R8), then require a
  session principal with the user scope (R15), then take `BOARD_RL` by user and `BOARD_IP_RL` by
  the client's /64 (R11); the route search then reads the session row and validates as before.
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
  is older than 5 minutes, because each answered search takes one of the day's 30. Since ruling
  R10 the same gate holds a pull on the route search, and nothing there invites one.
- **Offline with a board on screen (part 3).** A board or result already loaded stays on screen
  offline with a notice that it is the last answer loaded (from the query cache, in memory);
  with nothing loaded, the screen says it is offline instead of showing an empty list, and the
  query runs when the phone is back online.
- **The probe (part 3).** Beyond the spec's list it checks the free coverage of the three hubs,
  measures a 24-hour window at each hub as well as both 12-hour buckets (R3 U4 asks for both),
  and settles U7's inclusivity from a departure scheduled at exactly 12:00 and not revised later.
  Its findings default to the OS temp directory, `--pause-ms` spaces the calls (300 ms), and
  `--no-prompt` skips the counter readings. The review round added the production call's
  readings and B7's call days ahead (R7, R12), and its findings now keep booleans and counts only.

## The owner's steps

### The probe, on the day the Growth key arrives (B13; R3 O3)

Run from the repository root on your own machine, never in CI. It spends about 44 units of the
400,000.

1. `node scripts/probe-adb-boards.mjs --dry-run --date <today in New York>` prints every call,
   its units, and each counter reading with its running total (the units the counter should have
   moved since `before`: as planned, then from 204 and 400 billing nothing to `direction=Both`
   billing twice), with no network call. Keep it beside the run.
2. Open the AeroDataBox dashboard on the page that shows the API units used this period.
3. Run the probe:

   ```sh
   AERODATABOX_API_KEY=<the Growth key> node scripts/probe-adb-boards.mjs --date <the same date> --out docs/increments/18-probe-findings.json
   ```

   At each prompt (`before`, after each billing call of U2, U3 and U6, `after-u5-180-days` after
   the U7 and U5 calls, `before-production` and `after-production` around the production call,
   and `end` after the last call), wait until the dashboard's counter has stopped moving and
   has moved at least the low end of that reading's running total, then type it; Enter skips one.
   `after-u5-180-days` and `before-production` have no call between them, so they should match; a
   difference means the counter was still moving. Skipping either production reading loses the one
   figure step 5 needs first.
4. The file is written indented (`docs/increments/` is outside Prettier) and holds booleans and
   counts only: no flight number, time or path (ruling R7). The script also prints the answers.
   Copy each into [Unverified](#unverified) below, item by item, and commit both.
5. Act on the answers:
   - `bill.productionCallUnits` is what one production call costs when `bill.productionCallSettled`
     is true: it equals what U2 and U3 imply (`bill.impliedByU2AndU3`, the `Both` call plus what
     `withLeg` added) when they were read, and only without them is 2 or 4 enough (so 4 where they
     imply 2, a straggler's 2 units folded in, is not settled). Set `ADB_UNITS.fids`
     (`packages/shared/src/cost.ts`, and its test in `packages/shared/test/cost.test.ts`) to it in
     the change that commits the findings (ruling R7). When it is false, a reading was skipped or a
     lagging counter folded another call's units in (the re-review's M4): leave `ADB_UNITS.fids`
     alone and run the probe again (about 44 units), waiting longer at each prompt. Left at 2 while
     AeroDataBox bills 4, the ledger would count every board fetch at half its cost (review A: the
     35 percent share would really spend 70 percent of the day's units, and the month would run out
     around day 22); set to 4, the share buys half as many fetches, so revisit the share in
     `config.ts` with R3 O4. `bill.runUnits` against the plan's 44 (40 if errors are free, 66 if
     `Both` bills twice) says whether the readings can be trusted.
   - U1: the board keeps a row by its scheduled or its best time from the buckets a request reads
     (ruling R14), so whichever way FIDS selects, only a delayed flight sitting in a bucket the
     request does not read is missed: by schedule, one scheduled in the bucket before the window
     and delayed into it; by revised time, one revised past the last bucket read (a late-evening
     departure revised past midnight, in the route search). Record which, and whether reading one
     more bucket is worth its call.
   - U5 refused means the route search's lookahead must drop below the plan's `maxDaysAhead`
     (the board reaches 72 hours since ruling R3).
   - U4 over 2 MB of gzip needs nothing (the chunks are 1 MB) but is worth knowing for KV.
   - U7: an inclusive `toLocal` needs nothing. An exclusive one puts the 11:59 and 23:59 flights
     in no bucket, since each bucket's window ends at its last minute: then `boardBucketWindow`
     (`packages/shared/src/boards.ts`) must end each window at the next bucket's start (12:00,
     and 00:00 of the next day) instead. The build said "U7 needs nothing either way", which
     ruling R15 corrected.
   - B7: the share of codeshare rows days ahead with neither a callsign nor a registration
     (`codeshares.daysAhead.codeshared.withNeither` of `rows`) is how often ruling R12's keyless
     rule decides the grouping, and `unknownStatus.rows` how many rows are of unknown codeshare
     status (`Unknown`, or a value outside the enum), any of which keeps a keyless codeshare of
     its direction, minute and counterpart alone (the re-review's M5).

### The three boards from cache on staging (the exit test)

Before: staging runs this branch (runbook step 10) with `AERODATABOX_API_KEY` and
`ADB_PLAN=growth` set (step 6), Access protects `/admin` (step 14), and a development build points
at staging, signed in with a real account (a guest opens only its own flights' airports).
`BOARDS_ENABLED` is `"true"` in staging's vars (`apps/api/wrangler.jsonc`); production's says
`"false"`, and there both routes answer 404 `boards_disabled` (ruling R8).

Run steps 1 to 4 before 13:00 New York time (the re-review's N5): the board's default window, an
hour ago for 12 hours, reaches KJFK's morning bucket only until then, and the route search reads
both of the date's buckets, so a later run shows one more call in steps 4 to 6, a `route_search`
call for that bucket.

1. Add sheet, **Airport board**: `KATL`, **Open the board**. Departures show with an "As of" time
   within a minute or two of now, and no "Schedules only" badge.
2. **Arrivals**: the same "As of" time (one `direction=Both` fetch fills both directions).
3. Back, then open KATL again within 5 minutes (the current bucket's freshness): the same "As of"
   time, served from the cache.
4. The same for `EGLL` and `KJFK`; then, within 5 minutes of opening KJFK (as in step 3),
   **Search by route** from JFK to LHR today: results, and no new call (the route search reads the
   KJFK buckets the board filled, still fresh).
5. `/admin`, boards section: the airports refreshed in the last hour are KATL, EGLL and KJFK;
   board calls today by result show one `ok` per bucket fetched (the default window usually
   spans two buckets), and none for steps 2 to 4 (no `route_search` row).
6. On the staging branch:

   ```sql
   select airport_icao, trigger, result, count(*)
   from provider_calls
   where operation = 'fids' and trigger in ('board', 'route_search')
     and created_at > now() - interval '1 hour'
   group by 1, 2, 3
   order by 1;
   ```

   At most two `ok` `board` calls per airport (one per bucket), however many views, and no
   `route_search` call (one at KJFK, for its morning bucket, if steps 1 to 4 ran after 13:00
   New York time). The free coverage checks are the `health` operation, once per airport per day
   (hourly while a feed is down or of unknown status, ruling R5).
7. Record the times, the counts and anything unexpected under [Unverified](#unverified).

### The phone's HTTP cache stays empty (ruling R1)

Every answer the `/v1` chain produces carries `Cache-Control: no-store` since the review round, and
both platform stacks honour it; this check proves it on a device. The header stops new entries only:
entries an earlier build wrote stay on a development device until the app's data is cleared. The
commands are the documented forms, not run here: the Android directory is the one `expo/fetch`'s
OkHttp client uses (as the skeptic read its sources), the iOS file the shared `URLCache`'s.

1. On every development device that ran a build from before ruling R1, clear the app's data
   first (Android: `adb shell pm clear app.planeahead.mobile.dev`; iOS: delete the app and
   install it again), then sign in again.
2. With the development build against staging, open the KATL board, search a route, and let the
   home list sync.
3. Android: `adb shell run-as app.planeahead.mobile.dev ls cache/http-cache` lists the `journal`
   and no entry files (`*.0`, `*.1`), or the directory does not exist.
4. iOS Simulator:

   ```sh
   sqlite3 "$(xcrun simctl get_app_container booted app.planeahead.mobile.dev data)/Library/Caches/app.planeahead.mobile.dev/Cache.db" \
     "select count(*) from cfurl_cache_response where request_key like '%/v1/%'"
   ```

   answers 0 (or the file does not exist).
5. Record the result under [Unverified](#unverified).

## Unverified

- **The exit test: boards for KATL, EGLL and KJFK from cache on staging.** There is no staging
  and no key; the steps above prove it. Until then coalescing and the cache are proven only in the
  Workers pool against a stubbed provider.
- **B13's probe.** Written, dry-run tested and run once against a stubbed gateway in
  `tools/providers/probe-adb-boards.test.js`; never against AeroDataBox. Its answers settle U1 to
  U7, the production call's bill and B7 below.
- **R3 U1, selection by scheduled or revised time.** The board keeps a row by its scheduled or its
  best time (ruling R14), but only from the buckets a request reads, so either answer leaves a
  delayed flight outside them missing (the owner's step 5 says which). Probe:
  `u1-revised-window`, `u1-scheduled-window`.
- **R3 U2, `direction=Both` at 2 units, and the production call's bill (ruling R7).** The boards
  share, the ledger (`ADB_UNITS.fids`) and the cost estimate assume one Tier 2 call; at 4 units
  every board fetch costs double. Probe: `u2-both` against `u2-departure`, and
  `bill.productionCallUnits`, the units of `u4-KATL-am` alone (the adapter's exact query on a
  12-hour bucket) between the readings `before-production` and `after-production`, settled
  (`bill.productionCallSettled`, the re-review's M4) only at what U2 and U3 imply, else at 2 or 4.
- **R3 U3, no surcharge for `withLeg` or `withLocation`.** `withLeg` is in the production shape;
  `withLocation` is never sent by the app (only by the probe, once). Probe: `u3-withleg`,
  `u3-withlocation`.
- **R3 U4, a hub bucket's size and latency.** Chunking makes any size storable (B3); the cold-miss
  latency against the 8 s deadline per bucket read is unknown. Probe: the nine `u4-*` calls.
- **R3 U5, a date 180 days out.** The route search follows the plan's `maxDaysAhead` (365 on
  Growth; the board reaches 72 hours since ruling R3); whether FIDS answers that far is unknown.
  Probe: `u5-180-days`.
- **R3 U6, whether a 204 or a 400 bills units.** The adapter records a 204 as billed
  `not_found`, the cautious reading. Probe: `u6-empty`, `u6-too-wide`.
- **R3 U7, the page-size bound.** The buckets' windows end at 11:59 and 23:59, which is right
  only if `toLocal` is inclusive: if it is exclusive, flights at 11:59 and 23:59 fall in no
  bucket, and each window must end at the next bucket's start instead (ruling R15 corrected the
  build's "either answer works"; the fix is in the owner's step 5). Probe: `u7-exact-page`,
  `u7-to-1159`, `u7-to-1200`.
- **Codeshare keys days ahead (ruling R12).** Days ahead the aircraft is rarely known, so a
  codeshare row without a callsign or a registration joins the only `IsOperator` row of its
  direction, minute and counterpart, or stays alone; how often that happens is unmeasured.
  Probe: `b7-days-ahead` (KATL's 00:00 to 11:59 bucket 3 days out, production query), with the
  same counts for `u4-KATL-am` (the run's date) and `u5-180-days`; each also counts the rows of
  unknown codeshare status (`unknownStatus`, the re-review's M5).
- **R3 U8, the live layer's latency.** How soon a gate change or a revised time reaches FIDS:
  a week of staging observation against airline and airport sites, not part of the probe.
- **R3 U9 and AeroDataBox's written End Use answer (R3 O2, plan section 10 item 3).** Not asked
  from here and not received. Boards and route results stay out of share pages, public API
  tokens and MCP (the routes' header says so), and the in-app boards need the written answer
  before they reach real users: production's `BOARDS_ENABLED` is `"false"` until it arrives AND
  the per-user caps ruling R3 deferred are built (`docs/open-decisions.md` section 9, runbook
  step 20).
- **The screens on a device.** Everything above ran in Jest; no simulator or phone showed the
  board or the route search. Unverified there: the sheet replacing itself with the board, the
  route search as a sheet over a sheet on iOS and Android, VoiceOver and TalkBack reading a row's
  label and hint, long rows at large text sizes, and pull to refresh on both platforms.
- **The phone's HTTP cache** (see the findings): the Workers pool proves the `/v1` chain's answers
  carry `no-store` (ruling R1); that neither platform's disk cache then keeps one is the device
  check above. Entries written before R1 on development devices stay until the app's data is
  cleared.
- **A 13-hour bucket on Starter** (a daylight saving change day); irrelevant on Growth.
- **The admin page's boards section** under a real Access session, and the Analytics Engine
  point's `airport_icao` (blob6) in a real dataset.

## Review round

Two Opus 5.5 lenses read the build at c5d7b3f (`git diff 55ca02a c5d7b3f`) on 2026-10-01, each
with probes in its own checkout. Review A (the provider, the cache and the budget) found MA1 to
MA4, ma1 to ma4 and nits; review B (the routes, the caps and the mobile screens) found M1, m1 to
m7 and nits; neither found a blocker. The orchestrator's full check of the same tree failed in
the API suite (R0). Skeptics then read the serious findings: two on review B's M1 (one through
the code on both platforms, one on severity and remedy), one on each of MA1 to MA4 with its own
probes, and one second skeptic across all four on severity, a recorded departure from "two
skeptics on every serious finding" (below). The orchestrator accepted every finding, as rulings
R0 to R15, applied in five parts: S1 (dd22c94: the routes and access), S2a (f47eabd: the budget
and storage), S3 (4201f31, merged as bd74ca9: the mobile app), S2b (f3a918f: coverage and the
board view) and S4 (this commit: the probe and these documents); increment 15's final state and
`main` were merged in after S1 (3c644bb, 94f1248). Names: MA1 or m4 is a review finding, R1 a
ruling of this round, B5 a ruling of the spec. The research document keeps its prefix on its
items (R3 D5, R3 U7), so "ruling R3" always means this round's.

Both reviews also listed what they found correct. Review A: the adapter's one fetch shape and
its mapping; the daylight saving buckets (New York, London, Santiago, Havana, Beirut and Lord
Howe: 11, 11.5, 12 and 13 hours); coalescing; chunking; the KV write rate; the purge mechanics;
the ladder and its degrade steps; the budget's atomicity and resets; attribution and migration
0010; the "one release after" reasoning; the probe's safety (the key never in a test); the
licence posture. Review B: the order and status codes, the window and filters, the ETag and 304
forms, cap taking and release, migrations 0010 and 0011, the anonymous airport limit's query,
the add-from-board payload (number, the departure leg's origin-local date, the origin's ICAO for
both directions), the admin section, the app's memory-only board data, the offline states, no
retries, the anonymous gating, accessibility and the theme.

### The skeptics

**M1, skeptic 1 (code path): real on both platforms; minor to moderate for boards, and the
`/v1`-wide gap is the serious part.** The app's transport is `expo/fetch` (Expo SDK 57 replaces
the global `fetch` unless `EXPO_PUBLIC_USE_RN_FETCH` is set, and nothing sets it). On Android
its OkHttp client keeps a 10 MB cache at `cacheDir/http-cache` that stores any 200 GET unless
the request or the answer says `no-store` (`private` and `no-cache` do not stop it), evicting by
size only; on iOS it uses `URLSessionConfiguration.default`, a persistent disk cache, with the
protocol's cache policy. `no-store` works on both; a request-side `cache: 'no-store'` would not
(`expo/fetch` drops the option). The build's premise that the app never revalidates was wrong:
both stacks send `If-None-Match` from a stored ETag. Entries already on development devices are
not purged by a header change. Nothing else keeps board data (TanStack Query in memory only,
nothing in SQLite or the key-value store, no bodies in Sentry). Broader: no `/v1` route sent a
`Cache-Control` at all, so designator searches and every `/v1/sync` page were already on disk,
surviving sign-out and account deletion (`forgetAccount` clears SQLite and the query cache, not
the HTTP cache).

**M1, skeptic 2 (severity and remedy): a real mechanism, minor; fix now.** The build had
reported the risk and left it to a device check, and boards reach no real user before the End
Use answer; the copy stays inside the app. Fixing it makes "purged 48 hours after the bucket
ends" true end to end, which a Terms 5.8 self-certification needs. `no-store` loses nothing; the
304 must carry it too (RFC 9110 section 15.4.5); the ETag and the 304 stay (B7's contract).
Client-side alternatives rejected (whatwg-fetch's cache-buster stores under new keys; plugins
per platform). The broader finding is the material one: a `/v1`-wide `no-store` default (on iOS
the cache also stores requests, and the app sets the session's Cookie header by hand, so the
session token may sit outside SecureStore; unverified).

**MA1, skeptic 1 (probes and a simulation): a real mechanism, minor.** One ProviderBudget per
provider per UTC day holds one token bucket for every trigger. A refused tracker poll is not
retried (it waits for its next cadence slot), while AirportState retries a refused board call
after at least a second. With realistic timing (a cold open awaits its coverage check, coverage
is cached for a day, a warm refresh is mostly one call) two board opens at once never refused a
tracker on Growth; three did. A Monte Carlo run of the commit's own `take()` (Growth, peak four
times the mean) gave tracker refusal rates of 0 to 6.1e-5 as built and 0 with a floor of 2, at
the cost of 0.07 to 1.6 percent of board calls; a separate board bucket costs more and adds
state. Clustered alarms already lose 1.9e-3 to 4.4e-3 of tracker slots to each other (before
boards); boards add 5e-5 to 2.5e-3, which the floor only partly helps. The root fix, re-arming a
rate-limited alarm within its slot, touches ADR 0011's step-1 bookkeeping. The floor: per plan
(Growth 2, Scale about 5), folded into `retryAfterMs`, with its own denial reason; the bucket's
burst rationale reasoned only about tracker debits, and every board test sidestepped the bucket
with `perSecondLimit: 1_000`.

**MA2, skeptic 1 (probes): real, major; three corrections.** The board route had no quota and
checked a date only against the 365-day lookahead, and one subscription opened an anonymous
account's origin and destination boards. Probes: one account at one airport, 30 two-bucket
requests a minute, made 60 FIDS calls (120 units) a minute and emptied Growth's share in 38.9
minutes; an anonymous account with one subscription was served 60 far-dated requests; with the
share spent, another account's default board elsewhere got 503 with no FIDS call; one account
filled all 60 airports of the hour in two windows; and, worse than the finding, 60 airports
AeroDataBox does not cover filled the hourly cap at no cost, because the free coverage check
reserved as `board` and took a slot. Corrections: an anonymous account with one subscription
drains 63 percent in about 24 minutes; one-bucket windows double the time; the airport cap needs
no units at all. A bound of now minus 24 hours to now plus 72 costs no client (the app sends no
`from` or `to`) but is not enough (near-term buckets refresh about 21 times an hour per airport;
at 60 airports an hour one account still drains the share in 2.5 to 3 hours). What bounds the
spend is a per-user daily cap charged on real FIDS reservations, paired with a per-salted-IP
cap, and distinct airports per user per hour counted only on FIDS reservations. Not critical
(the spend is capped by design and trackers are untouched), but it should keep boards from real
users.

**MA3, skeptic 1: real (reproduced), medium on Growth.** A bucket 30 days ahead was purged 32.5
days after its fetch, one 364 days ahead 366.5 days after. Growth's terms (checked live,
updated 2026-09-19) allow caching while subscribed but ask to minimise volume and duration (5.5)
and allow 7 days after termination (10.7), with no way today to purge every airport's copies on
demand. Purging early costs no provider call (past `staleUntil` the next view fetches anyway).
The cleanest rule: purge at min(end + 48 h, fetch + 7 days), one change in `boardFreshness`.
Rejected: min(end + 48 h, `staleUntil` + a grace), which deletes current copies minutes after
their last fetch and lets the never-empty rule lapse within minutes in an outage. Only the far
row changes, for a bucket starting more than 108 hours after its fetch (its quadrupled stale
time from 192 to 168 hours).

**MA4, skeptic 1: real, major (not refuted).** In the vendored spec's `FeedServiceStatus` only
Unavailable means not provided: Down is provided but down, Degraded up with degraded
performance, Unknown unknown. Of the 36 status pairs, 16 gave `not_covered` (15 of them a false
404) and 6 gave `schedules_only` with live updates provided or unknown; a busy airport whose
daily re-check met Down twice froze its old bucket, then answered 404; and the adapter parses a
status as any string, so a value outside the enum read as not covered too. `unknown` fetching
anyway is right: a down or degraded feed is provided, and only Unknown or a value outside the
enum can bill a 204. The per-feed mapping and the tests ruling R5 lists are this skeptic's.

**MA1 to MA4, second skeptic (severity across all four): all real; only MA2 major, for the date
axis.** MA1 minor: at 10,000 flights about one lost poll a day at most under the research
document's worst-case board traffic, under 0.01 percent; the smallest fix is a `keep` on `take`.
MA2 major: normal use never triggers it, but a scripted account drains Growth's share in 39
minutes and AeroDataBox would see up to 2,333 FIDS calls a day sweeping future dates (the bulk
download Terms 8.2 forbids; under 8.3 the key can be blocked without warning, which in mock or
AeroDataBox-only mode stops the trackers too). Fix the date axis now (a 72-hour board bound),
and defer the per-user daily cap to before real users, beside the End Use question. MA3 minor:
users see nothing. MA4 minor by impact, fixed now (a persistent Unknown would keep some airports
dark every day). Together: MA2 with MA3 (the date axis), MA4 with review A's ma4 (the same
coverage path), MA1 apart (MA2's bound lowers its exposure).

### By ruling

- **R0 (the orchestrator's full check): the board test helpers use the per-file database
  handle.** Finding: the full check of c5d7b3f failed 20 API tests in 9 files (admin-access 1,
  admin-push 2, boards.routes 7, flights.subscribe 2, me.delete 1, notify 2, persist 1,
  push-consumer 2, sync 2) on `sorry, too many clients already` (8 times): seven of the failures
  were inserts into `airports` from the new `test/workers/helpers/boards.ts`, which opened a
  client per call through `withDb(testEnv, ...)` instead of the per-file `db()` that
  `helpers/routes.ts` provides for exactly this reason; the rest were files starved at the same
  moment. Changed, part S1: `insertBoardAirport` and `airport-ref.test.ts`'s `insertAirport`
  write through the per-file `db()`. Proven: the full check of 94f1248 passed 1,109 API tests (1
  skipped) in 90 files with no "too many clients", so no further change was needed and the
  cluster's `max_connections` was not raised; the check of f3a918f passed 1,145 (below). CI's
  test-workers job (a postgres:18 service at the default limit) runs on the branch's push, not
  here.
- **R1 (review B's M1 and the skeptics' broader finding): a `/v1`-wide `Cache-Control:
  no-store`.** Finding: the board routes' `private, no-cache` let the phone store every board
  and route-search answer on disk, and no other `/v1` route said anything, so the sync feed and
  the designator search were stored too, past sign-out and account deletion (the skeptics,
  above). Changed, part S1: `src/middleware/no-store.ts` (`noStoreByDefault`), first in the `/v1`
  chain (`routes/v1.ts`), adds `no-store` after the route and the error handler have run to every
  answer of that chain that names no `Cache-Control` of its own, so the `/v1` limiter's 429
  (`USER_RL`), a 401, a 404 and a 500 raised there carry it; an answer given before the chain
  runs, the per-IP limiter's 429 (`PUBLIC_RL`) or an error the root chain's middleware raises,
  carries none and holds no user data (the re-review's N3); the board routes' 200 and 304 send
  `no-store` themselves (were `private, no-cache`) and keep the ETag and the 304 (B7's contract).
  Proven: `boards.routes.test.ts` (the board's 200, 304 and changed tag; the route search's 200
  and an `If-None-Match` 304), `sync.test.ts` (200 and 401), `flights.search.test.ts` (200),
  `chain.test.ts` (through the deployed Worker: a `/v1` 401 and 404 carry it, `/health` does not,
  a route's own value is kept). Not purged by the header: entries the earlier builds wrote on
  development devices, until the app's data is cleared; the device check in the owner's steps
  confirms the caches stay empty. A departure: it changes Phase 0 routes (below).
- **R2 (MA1, minor after its skeptics): board calls leave the trackers a floor of tokens.**
  Finding: board calls took the per-second tokens tracker polls need, and a refused poll loses
  its slot; B5 and `boards-budget.ts` claimed trackers never meet board limits, true for the
  share and the airport cap, not the rate. Changed, part S2a: `take` (`token-bucket.ts`) gains
  `keep` (a take passes only with `cost + keep` in the bucket; a refusal's `retryAfterMs` folds
  the floor in; `keep` is capped at `burst - cost`; `floored` marks a refusal only the floor
  caused); `boardTokenFloor` (`boards-budget.ts`) is half the burst rounded down (Starter 1,
  Growth 2, Scale 5); `ProviderBudget.reserve` applies it to `board` and `route_search` calls,
  the free coverage check included; a floor-only refusal is the new denial reason
  `board_rate_floor` (shared `providers.ts`), its call record reads `rate_limited`, and
  AirportState waits for the refill, at least a second. The burst rationale in `token-bucket.ts`,
  the `boards-budget.ts` header and spec B5 are corrected. Proven at the real per-second limits:
  review A's probe on Growth (two cold opens, then tracker alarms: 3 board calls allowed, 3
  refused `board_rate_floor` with a 200 ms wait, 2 tracker reservations allowed, a board call
  passing again at +600 ms, refusals spending no units), the same on Starter and Scale, six more
  `take` tests, and an AirportState test (three buckets at once on Growth: the third is floored
  with a `rate_limited` record costing 0, a tracker is still allowed, and the bucket refetches at
  +1 s, not +60 s). Recorded for increment 17, not this round: trackers already lose about 2 to
  4 slots in 1,000 to each other when alarms cluster; the root fix (re-arm a rate-limited alarm
  within its slot) touches ADR 0011's step-1 bookkeeping (`docs/open-decisions.md` section 9).
- **R3 (MA2): the board window is near-term; per-user limits gate production.** Changed, part
  S1: a board window ending more than 72 hours ahead answers 422 `date_out_of_range` with
  `maxHoursAhead: 72`, checked before the airport lookup and replacing the board's
  plan-lookahead check (exactly 72 hours is allowed; buckets that ended more than 24 hours ago
  were already refused); later dates are the route search's, which is capped. Part S2b (R5): the
  free coverage check takes no airport slot, which closes the free hourly squat. Proven: +72 h
  answers 200; +72 h and a minute, `from` alone past 72 hours and `from` at +72 h answer 422
  with no FIDS call; 70 coverage checks take no slot. Deferred, and REQUIRED before
  `BOARDS_ENABLED` is on in production (R8): a per-user daily budget charged on real FIDS
  reservations (a salted principal carried in the bucket request through to
  `ProviderBudget.reserve`, enforced in the same transaction as the share), a per-salted-IP
  counterpart, and distinct airports per user per hour counted only on FIDS reservations
  (`docs/open-decisions.md` section 9; runbook step 20). Review B's m7 (no durable per-account
  cap on boards) is the same control. With the bound one airport yields at most about 34
  refreshes an hour; what stays open until the caps exist is one account rotating 60 airports,
  which drains the share in about 2 hours (the second skeptic).
- **R4 (MA3): a bucket is purged at min(end + 48 hours, fetch + 7 days).** Changed, part S2a:
  `BOARD_PURGE_AFTER_FETCH_MS` (7 days, shared) and one change in `boardFreshness`; the stored
  purge, the alarm and the KV copy's expiry follow it. The comments (shared `boards.ts`,
  `airport-state.ts`), spec B3 and R3 D5 are amended (part S4). The ladder's freshness rows are
  unchanged; only the far row feels it, for a bucket starting more than 108 hours after its
  fetch, whose quadrupled stale time stops at 168 hours instead of 192. Proven: shared
  `boards.test.ts` (buckets 30 and 365 days ahead purge at fetch + 7 days; the 108-hour boundary
  a minute either side; a sweep in which purge minus fetch never exceeds 7 days and stale never
  passes the purge; the far row stale 168 hours at share 0.95 and 96 at 0.7); `airport-state`
  (a bucket 30 days ahead alarms at fetch + 7 days with its KV copy expiring about 7 days out;
  at fetch + 7 days the alarm removes the rows, the chunks and the KV copy, and the next view
  costs exactly one FIDS call; a refetch at +3 days moves the purge to +10 days).
- **R5 (MA4 with review A's ma4): coverage follows the spec's statuses.** Changed, part S2b:
  `FEED_STATES` (OK, OKPartial and Degraded provided; Down provided but down; Unknown and any
  value outside the enum indeterminate; Unavailable not provided) and `coverageOf`: live updates
  provided is `live`; down or indeterminate is `unknown`; Unavailable defers to the schedules
  (provided `schedules_only`, down or indeterminate `unknown`, Unavailable `not_covered`).
  `coverageTtlMs`: `unknown` stands an hour (`COVERAGE_RETRY_MS`), every other answer a day. A
  check the budget refuses keeps its call record and stores nothing; the board-triggered
  `health` call skips the boards share and the airports cap but keeps the per-second floor;
  `airport_state_coverage_checked` logs the raw schedules, live and ADS-B statuses;
  `AdbCoverage.covered` and `COVERED_STATUSES` are gone, and the answer lives in the object's
  own storage only (R15 dropped the unread KV copy). Proven: the 36-pair table with each TTL; a
  value outside the enum is `unknown` (pure, and in the object with the board fetched); live
  Down with schedules Degraded is `unknown` with FIDS fetched and recovers to `live` at +1 h;
  schedules OK with live Degraded is `live` with one check in 23 hours; Unavailable twice is a
  404 with no FIDS call and one check a day; a refused check stores nothing (at +1 s the check
  runs: `not_covered`, 0 FIDS calls); 70 checks take no airport slot; checks keep the floor at
  Growth's 10 a second; the fixtures' `'NoData'` (not in the spec) became `'Unavailable'`.
- **R6 (review A's ma1): a billed 200 whose items all fail mapping is stored, empty.** Finding:
  it was refetched and billed again every minute and never stored, and `not_a_fids_contract`
  and deterministic 4xx answers looped the same way. Changed, part S2a: the empty bucket is
  stored while the call record keeps `result: 'error'` (`fidsAllSkipped`); deterministic
  answers (an error record below HTTP 500 other than 429, and `not_a_fids_contract`) wait for
  the bucket's fresh time on the ladder, with the share's multiplier; transport errors, 5xx,
  push-backs and thrown calls keep the 60-second retry. Proven: one all-skipped bucket stored
  empty, two ladder waits (a 400, a 200 that is not a FIDS contract), two minute retries (a 429,
  a transport error).
- **R7 (review A's ma2 and two nits): the probe measures the production fetch shape.** Finding:
  the probe never measured the bill of the call production makes (U2 used `Both` without
  `withLeg`, U3 `withLeg` with one direction, U4 had no reading, and there was no final
  reading), while the ledger prices it at 2 units (`ADB_UNITS.fids`); its fetch followed
  redirects carrying `X-Api-Key`; its findings would have kept flight numbers and times in git.
  Changed, part S4 (`scripts/probe-adb-boards.mjs`): `BOARD_SHAPE` is now byte for byte the
  adapter's `FIDS_QUERY` (it had `withCodeshared` before `withCancelled`); `u4-KATL-am` (KATL's
  00:00 to 11:59 bucket, already in the plan) is read between two counter readings,
  `before-production` and `after-production`, and a last reading, `end`, follows the last call;
  the findings gain `bill.productionCallUnits` (that call alone) and `bill.runUnits` (first
  reading to last); the fetch passes `redirect: 'error'`; the findings keep booleans and counts
  only: U1 no longer names the delayed flight or its times, U7 counts the 12:00 departures
  instead of listing them, and no call keeps its path or purpose (U1's windows are cut around a
  real flight's times; the dry run reprints every other path from the recorded date). The
  owner's step 5 and runbook step 20 say to set `ADB_UNITS.fids` to the measured units. Proven
  (`tools/providers/probe-adb-boards.test.js`, 13, 3 new): `BOARD_SHAPE` equals the
  `URLSearchParams` built from the adapter's `FIDS_QUERY` block, read from its source; the
  production call's path, units and its two readings, with no other reading between them; the
  dry run's lines for it and its totals; the bill from a set of readings; against the stubbed
  gateway, every reading taken in order (`before` through `after-u6-too-wide`, then the two
  production readings, then `end`), and a findings file with no flight number, callsign,
  registration, path or clock time but the run's own timestamp, the stub exiting 96 if a fetch
  would follow a redirect. Ten mutants, each reverted after its run, all killed (below). The
  probe was not run against AeroDataBox (no key): the dry run and the stubbed gateway only.
- **R8 (review A's ma3): boards are off in production until AeroDataBox's written End Use
  answer.** Finding: `/v1/airports` was mounted unconditionally, so any production deploy
  exposed boards to every signed-in user, and the only stop, the provider kill switch, stops the
  trackers too. Changed, part S1: `BOARDS_ENABLED` (`boardsEnabled(env)` in `src/env.ts`;
  anything but `"true"` is off) and `requireBoardsEnabled()` first on both routes, before the
  route's session checks, brakes and lookups: off, they answer 404 `boards_disabled` (a new
  `API_ERROR_CODES` entry); `"true"` in the local and staging vars. Amended by the orchestrator
  after S1 and applied in part S2a: `"false"` in `env.production.vars` rather than absent
  (absent, wrangler warns on every production deploy, and copying `"true"` there would switch
  boards on); `worker-configuration.d.ts` regenerated (`"true" | "false"`). Part S3: the board
  says "Airport boards are not available yet." and the route search "Finding a flight by route
  is not available yet. Add the flight by its number instead.", as notices, not errors; the
  entry points stay. Proven: absent and `"false"` give 404 with no brake taken, `"true"` reaches
  the routes, the config test expects `"false"` in production, the production dry run shows
  `env.BOARDS_ENABLED ("false")` with no warning, and the app's board and route-search suites
  show the notices. The flip is runbook step 20's, after the written answer and the per-user
  caps (R3).
- **R9 (review B's m1): a second leg of the same flight number can be added from a board.**
  Finding: `findTracked` ignored `origin`, so the KLAX leg of AA100 and the KBNA leg of WN1234
  answered `already_tracked`. Changed, part S3 (in `apps/mobile/src/lib/`): `pendingFlightKey`
  takes an optional origin (the placeholder key ends `:<origin ICAO>`); `keyOriginIcao`,
  `liveRowNamed` and `pendingMatchesLive` respect it (`flight-model.ts`); `findTracked`
  (`flights.ts`) compares the departure origin when `origin` is set; `addFlight` writes it into
  the placeholder key. Proven: AA100's KLAX leg queued while KJFK is tracked (by key and through
  the BA1511 codeshare); WN1234 at KMDW pending, then its KBNA leg queued; a board leg over a
  typed pending add.
- **R10 (review B's m2): route search charges only for a search the user asked for.** Finding:
  every pull on the route search was a charged search, both notices said "Pull down", and
  `partial` marked a permanent `out_of_range` bucket too, so a late-evening search stayed
  partial and invited charged pulls. Changed, part S2b (server): `partial` only when a bucket is
  neither `ok` nor `out_of_range`; part S3 (app): `routeSearchAsksAgain` (an error, or an answer
  at least `ROUTE_SEARCH_STALE_MS`, 5 minutes, old, and never while a fetch runs) gates the pull
  and a repeated tap; the notices no longer mention pulling ("These times may be out of date.";
  "Part of this time range could not be loaded, so some flights may be missing."). Proven: at
  the lookahead's edge a 200 with `partial` false and one FIDS call; the app's route-search
  suite.
- **R11 (review B's m3): shared addresses are not starved.** Finding: `BOARD_RL`'s IP key was the
  raw address (three addresses of one /64 counted apart) and everyone behind one NAT shared 30 a
  minute; the anonymous per-IP search cap's 403 named no scope, so an anonymous user held by the
  network's cap was never told to sign in. Changed, part S1: `BOARD_IP_RL`, 300 per 60 s in
  every environment (namespace ids 3005, 1005 and 2005), keyed `ip:` plus
  `normaliseClientIp(clientIp(c))`, so a /64 shares one key; `BOARD_RL` stays 30 per 60 s per
  user; every 403 `cap_exceeded` carries `scope` (`'user' | 'ip'`, typed inline so the typed
  client does not import the database package); `worker-configuration.d.ts` regenerated. Part
  S3: `scope: 'ip'` reads "Without an account, route searches are limited to 30 a day per
  network, and this network's are used up today. Sign in to keep searching, or add the flight by
  its number." with a sign-in button. Proven: both bindings' config; each refusing with its own
  `limiter` and `Retry-After` 60; three addresses in one /64 answer 404, 404, 429 while another
  /64 has its own allowance; `scope` in the cap tests and the shared parse; the app's
  route-search suite.
- **R12 (review B's m4): codeshares group without aircraft keys, and rows are unique.** Finding:
  AA100 (`IsOperator`) with BA1511 and IB4218 (`IsCodeshared`) at the same time and counterpart
  came out as three rows, since days ahead the aircraft is usually unknown, and one flight
  returned by two buckets got a duplicate row id. Changed, part S2b (`src/boards/view.ts`):
  `uniqueRows` keeps the first copy per direction, designator and scheduled UTC minute before
  grouping; a keyless `IsCodeshared` row joins the only `IsOperator` row with the same
  direction, minute and counterpart (alone when there are none or several); the route search
  keeps only rows whose `scheduledDepartureDateLocal` is the searched date. Part S4: the probe's
  B7 call (`b7-days-ahead`) counts, 3 days out, the codeshare rows carrying a callsign, a
  registration or neither, with the same counts for the run's date and 180 days out. Proven:
  review B's three rows as one, on the board and in the route search; keyless codeshares alone
  with no operator and with several; dedup across buckets with unique ids; the previous and next
  days' flights dropped from a route search; the probe's counts (`codeshareKeys`) and the stubbed
  run, keyed on the run's date and keyless days ahead.
- **R13 (review B's m5): hub boards render as a list.** Changed, part S3:
  `apps/mobile/src/components/BoardList.tsx` (a FlatList, `keyExtractor` on the row id),
  `BoardRow` memoised, stable callbacks (`useRowAdd`, `onAdd`) and a memoised `useDisplayPrefs`.
  Proven: a 700-row board renders with its first 10 rows mounted in order; going offline
  re-renders the screen and no row; a row re-renders only when its props change.
- **R14 (review B's m6): delayed flights stay on the board.** Changed, part S2b: a flight is in
  the window by its home leg's scheduled time or its best time (actual, else estimated), or,
  scheduled before the window, while it has not yet departed or arrived with live data behind
  that status (an estimate, or for an arrival its departure); only the buckets already read are
  searched. Proven: `board-view.test.ts`, "keeps a delayed flight: its best time in the window,
  or earlier and not yet moved", and B7's window test unchanged. Narrower than the ruling's
  words, a departure (below).
- **R15 (nits).** Part S1: `AuthenticatedUser.kind` (`'session' | 'api_token'`, only `session`
  issued) and `requireSession()` (401 with no principal, 403 `insufficient_scope` for any other
  kind) on both routes, before the user scope and the brakes; proven with an `api_token`
  principal holding the user scope, refused with no brake taken. Part S2a: `store_failed` keeps
  the billed call's record and sets the 60-second retry; `composeBudgets` keeps the highest
  `boardsShareSpent`; the `adb:coverage` KV write and `adbCoverageKvKey` are removed (nothing
  read them). Part S2b: a range past the lookahead is not `partial`. Part S3: an arrival reads
  "Arrived" for the in-block time; a cancelled row shows no "Expected"; a row that cannot be
  added is muted and says "Cannot be added here. Add it by its flight number." Part S4: "U7
  needs nothing either way" is corrected above (the owner's step 5 and Unverified).
- **Not ruled, unchanged.** Review A's nit that concurrent misses of one `ref:airport` KV key
  write it at once (a KV 429 swallowed): the writes carry the same answer, and a lost one costs
  one more Postgres lookup later. Review B's optional release of route-search slots on a
  `partial` answer: R10 stopped the charged pulls instead.

### Where the rulings were silent

The orchestrator accepted each of these after its part.

Part S1 (the routes and access):

- The 72-hour bound answers the designator search's 422 `date_out_of_range`, with
  `maxHoursAhead: 72`, checked before the airport lookup; it replaces the board's plan-lookahead
  check, which it subsumes; exactly 72 hours is allowed.
- The boards gate runs before the route's session checks: a disabled deployment answers 404
  `boards_disabled` even to a request with no session.
- `scope` rides on every 403 `cap_exceeded` (an added field), typed inline so the typed client
  does not import the database package.
- The brake tests use stand-in limits; the config test pins the real 30 and 300.

Part S2a (the budget and storage):

- The floor is derived from the bucket (half the burst, rounded down) rather than a table per
  plan, so it stays right if an admin changes the per-second limit; a test pins Starter 1,
  Growth 2 and Scale 5.
- The board test harness's ProviderBudget clock follows the harness clock, and `uniqueDay` steps
  16 days (the floor exposed wall-clock refills and budget days shared between tests); the
  AirportState tests run at Growth's real 10 a second.
- `store_failed` waits the 60-second retry, like a transport error; 408 is not special-cased
  (only 429 and 5xx are retryable, the repository's convention).
- R15 allowed reading the `adb:coverage` KV copy or dropping its write; nothing read it, so the
  write and `adbCoverageKvKey` are gone.

Part S3 (the mobile app):

- R10's "stale" is the app's 5-minute staleness (`ROUTE_SEARCH_STALE_MS`), not the answer's
  `stale` flag: an answer the provider cannot refresh stays stale, so the flag would make every
  pull a charged search. A `partial` 200 is not "failed". The route search keeps pull to
  refresh, gated by `routeSearchAsksAgain`, and nothing on the screen invites it; the board's
  pull is unchanged.
- R9: a board leg added over a typed pending add (which names no leg) is queued rather than
  refused, so two pending rows can show until the server's `created: false` settles it; a typed
  add still matches any leg. `apps/mobile/README.md` documents the key's origin suffix.
- R11's sign-in prompt keys on `scope: 'ip'` alone (the API sends it only to anonymous
  accounts). R8's entry points stay visible and say "not available yet".
- R13's `keyExtractor` mutant survives as equivalent: React Native's default extractor reads
  `item.id` too.

Part S2b (coverage and the board view):

- R5: a check the budget refuses stores nothing, and that one request uses the last stored
  answer (`unknown` if none). The board-triggered `health` call skips the boards share and the
  airports cap but keeps the per-second floor (keyed on `isBoardTrigger`). `FEED_STATES` is a
  `Map`; the adapter keeps `z.string()` for the statuses, so a value outside the enum reaches
  the mapping and is logged.
- R10: a bucket state this build does not know counts as partial; out of range never does.
- R12: dedup and grouping compare the scheduled UTC minute; dedup ignores the counterpart (the
  row id has none); a keyed `IsCodeshared` row whose key matches nothing stays alone.

Part S4 (the probe and these documents):

- R7's production call is a call already in the plan (`u4-KATL-am`), so the bill costs no extra
  call, and it has two readings of its own rather than being read by difference from its
  neighbours, so a reordered plan cannot mix another call into it. `BOARD_SHAPE` now matches the
  adapter's query byte for byte (the order of `withCancelled` and `withCodeshared` differed), and
  the test reads the adapter's source, so a change there fails the probe's test.
- The findings drop every call's path and purpose, not only U1's: the dry run reprints every
  planned one from the recorded date, page size and empty airport (U1's two windows are chosen
  at run time and never planned).
- R12's clause is one production call at KATL 3 days out (the board's 72-hour reach; 2 units),
  with the same counts for the run's date (`u4-KATL-am`) and 180 days out (`u5-180-days`), both
  already in the plan: 25 calls and 44 units in all.
- The owner's step 4 and runbook step 20 no longer say to run Prettier on the findings file:
  `docs/increments/` is in `.prettierignore`, so it did nothing, and the script writes indented
  JSON.
- `docs/plans/phase1-plan.md` still says "purge 48 hours after a bucket ends"; the approved plan
  is left as written, and spec B3 and R3 D5 carry ruling R4.

### Departures

- **R1 changes Phase 0 routes**, as the ruling itself records: `no-store` is the default of
  every `/v1` route (the sync feed, the designator search, `/v1/me` and the devices routes
  included), not only this increment's two routes. Nothing in the app relied on the platform
  cache; what is lost is the bandwidth of the 304s the platform stacks earned on their own by
  revalidating stored copies.
- **R8's production value is `"false"`, not absent** (the orchestrator's amendment after S1):
  absent, wrangler warns on every production deploy that a top-level var is missing from
  `env.production.vars`, and the obvious fix, copying `"true"` there, would switch boards on.
- **R14 keeps an earlier flight only with live data behind its status**, and only when it was
  scheduled before the window. A schedules-only airport's rows read `boarding` from the
  timetable alone, so the literal "not yet departed or arrived" would keep about 12 hours of
  long-gone flights at the top of those boards (it broke B7's window test); a delayed flight
  with no revised time still drops off.
- **One second skeptic across MA1 to MA4, not two per finding.** The spec's header promised two
  skeptics on every serious finding; the second opinion on MA1 to MA4 was one agent reading all
  four for severity, while M1 had two of its own.

### What ran

The same machine as the build. Each part ran the files its changes touch one at a time and
reverted its mutants after each run; S1 to S2b are recorded from their reports, S4's are its own
runs on this commit's tree, and the orchestrator's full checks cover everything else.

| Part | Check | Result |
| --- | --- | --- |
| Orchestrator | Full check of c5d7b3f (the build; the turbo run, then prettier, the guards, the migration hash, actionlint, shellcheck and both dry runs) | failed: 13 of 14 tasks passed (tools 70 in 7 files, shared 797 in 29, db 203 in 12, mobile 696 in 38 suites); api failed 20 tests in 9 files on "too many clients" (R0); the rest passed |
| S1 | 14 API files one at a time: boards.access 10, boards.routes 10, sync 14, flights.search 8, chain 17, airport-ref 2, me 11, rate-limit 11, admin-boards 3, flights.subscribe 23, app-type 9 (unit), idempotency 31, webhooks 23, events 6 | passed: 178 tests |
| S1 | Shared suite; typecheck and lint (apps/api, packages/shared); prettier; the toolchain guard; the migration hash; `wrangler types --check`; both dry runs | passed: shared 29 files, 798 tests |
| Orchestrator | Full check of 94f1248 (S1, increment 15's final state and `main` merged) | passed (exit 0): turbo 14 of 14 tasks in 167 s, none cached: api 1,109 passed and 1 skipped in 90 files, no "too many clients"; shared 815 in 29 files; db 203 in 12; mobile 703 in 38 suites; tools 98 in 7; prettier, the guards, the migration hash, actionlint, shellcheck and both dry runs (the production one warning that `BOARDS_ENABLED` was missing, which S2a removed) |
| S2a | Shared `boards` 19, `index` 3; API unit `token-bucket` 21, `budget` 20, `aerodatabox.adapter` 72, `aeroapi.mock` 62, `cost-log` 5, `router` 7; Workers `provider-budget` 27, `airport-state` 25, `boards.access` 10, `boards.routes` 10, `admin-boards` 3, `flights.subscribe` 23, `flight-tracker.retries` 7 | passed: 314 tests in 15 files |
| S2a | Typecheck, lint, prettier, `wrangler types`, both dry runs | passed; the production dry run shows `env.BOARDS_ENABLED ("false")` with no warning |
| S2a | Mutants | 22, 21 killed; the survivor exposed a redundant retry, which was removed |
| S3 | Mobile suites one at a time: boards 33, airport-board 28, route-search 17, add-flight 71, flight-model 27, local-intent 5, sync-apply 37, offline-flow 13, outbox-hooks 4, home-list 24, detail 26, settings-units 7, house-style 182, and eight more suites | passed; snapshots moved only for the board and the route search, light and dark |
| S3 | Typecheck, lint, prettier (apps/mobile) | clean |
| S3 | Mutants | 22, 21 killed, one equivalent (React Native's default key extractor reads `item.id`) |
| S2b | API unit `board-view` 18, `aerodatabox.adapter` 73; Workers `airport-state` 31, `provider-budget` 29, `boards.routes` 12, `boards.access` 10, `admin-boards` 3, `do-ping` 9 | passed: 185 tests in 8 files |
| S2b | Typecheck and lint (apps/api, packages/shared), prettier; mutants | clean; 20 mutants, all killed |
| Orchestrator | Full check of f3a918f (every code part in) | passed (exit 0): turbo 14 of 14 tasks in 166 s, none cached: api 1,145 passed and 1 skipped in 90 files, no "too many clients"; shared 819 in 29 files; db 203 in 12; mobile 727 in 38 suites; tools 98 in 7; prettier, the guards, the migration hash, actionlint, shellcheck and both wrangler dry runs, the production one with no warning |
| S4 | `pnpm exec vitest run tools/providers/probe-adb-boards.test.js` (root) | passed: 13 tests (10 before, 3 new) |
| S4 | `node scripts/probe-adb-boards.mjs --dry-run --date 2026-10-02` | 25 calls, 44 units expected (40 if 204 and 400 are free, 66 if `direction=Both` bills both directions); no network call |
| S4 | Mutants of the probe, each reverted after its run | 10, all killed: the redirect followed (1 test failed), the old query order (1), no reading before the production call, in the run (1) and in the plan (3), no last reading (1), U1 keeping the flight (2), calls keeping their path (1), U7 listing numbers (2), the days-ahead answer not kept (1), the registration read from the wrong field (2) |
| S4 | The em dash scans over the changed documents and the probe: `test/style.test.ts` (packages/shared, `docs/architecture.md`), `test/schema-contracts.test.ts` (packages/db, `docs/schema-review.md`), `__tests__/house-style.test.ts` (apps/mobile: this file, the runbook, the probe) | passed: 71, 104 and 182 tests |
| S4 | `pnpm run lint:root` (eslint over scripts and tools); `pnpm exec prettier --check` on every changed file | clean |
