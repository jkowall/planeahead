# Increment 10 verification: home, add flight, detail

Branch `inc10-home-add-detail` (based on `main` with increments 2 to 9), 2026-09-23. This file
records what ran on the build machine, with its result, and the exact device steps the owner runs
once an API is reachable. No API is reachable here: staging has no DNS yet and `apps/api` has no
local-dev path without a Neon branch (`wrangler dev` needs
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB`, apps/api/README.md). Following ruling T1, the
provider-call assertions run in the api Workers suite, the screens are proven in Jest, and the one
device check run here is the iPhone 17 Pro simulator launch of the development build to the home
screen over a seeded store.

A review round followed the build (commit "Increment 10: apply review findings"); what it changed,
under the orchestrator's rulings X1 to X7, is in "The review round" below. A re-review of that
round found two minors and three nits, applied under rulings Y1 to Y5 (commit "Increment 10: apply
re-review findings", "The re-review round" below); the numbers in the first table are from its
final run.

## What ran here

| Check | Command | Result |
| --- | --- | --- |
| Full check | `pnpm turbo run typecheck lint test --force && pnpm prettier --check . && node scripts/toolchain-guard.mjs && node scripts/vitest-exit-guard.mjs && node scripts/mobile-migrations-guard.mjs --base origin/main` | passed (close-out, after the second re-review's fix and the merge of `main`): 14 turbo tasks in 1 min 41 s; 1999 tests passed (tools 18, shared 577, db 176, api 707 with 1 skipped, mobile 521; the tools count lost the case the workflow test had generated for the duplicated `vitest-exit-guard` job key that `main` removed, and the mobile count gained the two online-state cases). The re-review round's run: 1998 tests, mobile 519, in 1 min 40 s; Prettier clean; toolchain guard ok; exit guard ok; migrations guard ok. The review round's run: 1983 tests, mobile 504; the build's: 1896, mobile 417. One earlier attempt of the review round's final run hung after all 64 api test files had passed, in the api suite's teardown (embedded Postgres left holding idle connections) while another project's Workers suite ran on the machine; it was interrupted and the rerun passed. `apps/api` is untouched by both rounds |
| Mobile Jest (inside the turbo `test` task) | `pnpm --filter @planeahead/mobile test` | 28 suites, 521 tests, 12 snapshots (light and dark of home, empty home, the first add in the top slot, add sheet, detail, settings) |
| Mobile migrations guard | `node scripts/mobile-migrations-guard.mjs --base origin/main` | ok, 4 migrations, the 6 committed files unchanged (0002 and 0003 appended; the re-review round adds none) |
| `expo prebuild` (development variant) | `cd apps/mobile && LANG=en_US.UTF-8 EXPO_NO_GIT_STATUS=1 CI=1 pnpm prebuild` | passed, 25 s, 132 pods (run again after the review round's last code change; not re-run in the re-review round, which changed JavaScript only and no dependency, config or native file) |
| iOS simulator compile | `xcodebuild -workspace ios/PlaneAheadDev.xcworkspace -scheme PlaneAheadDev -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build` (with `SENTRY_DISABLE_AUTO_UPLOAD=true`) | BUILD SUCCEEDED, 2 min 58 s (review round; the native project is unchanged by the round's later JavaScript edits and by the re-review round, which Metro serves; the build's own run: 2 min 14 s incremental) |
| iPhone 17 Pro simulator launch to the home screen over a seeded store | see "The simulator launch" below | passed: the home screen over the seeded store, light and dark (below) |
| Android compile | `cd apps/mobile/android && ./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a` (with `ANDROID_HOME` and `ANDROID_SDK_ROOT` exported, `SENTRY_DISABLE_AUTO_UPLOAD=true`) | BUILD SUCCESSFUL, 1 min 16 s (the build; not re-run in the review round, which changed JavaScript and one local SQLite migration only) |
| Android launch (best effort), Pixel_10_Pro_Fold_-_EMU headless | see "The emulator launch" below | passed: the home screen over the seeded store, light and dark (the build; not re-run in the review round) |

### The simulator launch

Without an API the first-launch anonymous sign-in fails and the session-gated `(app)` group
redirects to sign-in, so the development build reaches the home screen through
`src/app/dev/seeded-home.tsx`, a route outside the group that exists only in development builds of
the development variant (it redirects home anywhere else). It seeds three demo flights through the
real page apply (`src/dev/demo-flights.ts`, one immediate transaction, one store signal) and
renders the real home screen, which reads them through the increment 9 live query. The launch
argument `-planeaheadSeededHome YES` sends the sign-in group there (`src/dev/seeded-launch.ts`,
read through React Native's `Settings`): a `planeahead://dev/seeded-home` link opened with
`xcrun simctl openurl` stops at iOS's "Open in PlaneAhead Dev?" prompt, which nothing on the
command line can answer.

```sh
cd apps/mobile
LANG=en_US.UTF-8 EXPO_NO_GIT_STATUS=1 CI=1 pnpm prebuild
SENTRY_DISABLE_AUTO_UPLOAD=true xcodebuild -workspace ios/PlaneAheadDev.xcworkspace \
  -scheme PlaneAheadDev -configuration Debug -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath /tmp/dd-inc10 build
SIM=$(xcrun simctl create "iPhone 17 Pro (PlaneAhead inc10)" \
  com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-26-5)
xcrun simctl boot $SIM && xcrun simctl bootstatus $SIM -b
xcrun simctl install $SIM /tmp/dd-inc10/Build/Products/Debug-iphonesimulator/PlaneAheadDev.app
# The dev client's first-run sheet and its menu would cover the screen.
xcrun simctl spawn $SIM defaults write app.planeahead.mobile.dev EXDevMenuIsOnboardingFinished -bool YES
xcrun simctl spawn $SIM defaults write app.planeahead.mobile.dev EXDevMenuShowsAtLaunch -bool NO
xcrun simctl spawn $SIM defaults write app.planeahead.mobile.dev EXDevMenuShowFloatingActionButton -bool NO
APP_VARIANT=development CI=1 npx expo start --dev-client --port 8081 &
xcrun simctl launch $SIM app.planeahead.mobile.dev --initialUrl http://127.0.0.1:8081 -planeaheadSeededHome YES
xcrun simctl io $SIM screenshot home-seeded.png
xcrun simctl ui $SIM appearance dark && xcrun simctl io $SIM screenshot home-seeded-dark.png
```

**Result (2026-09-23).** The development build loaded its bundle from Metro (2268 modules) and
opened on the seeded home screen. What the screenshot shows, top to bottom: the header
"PlaneAhead" with Settings and Add; the NEXT FLIGHT card with a grey "Scheduled" pill,
"AA100  JFK → LHR", "Wed 23 Sep", "7:49 PM → 7:49 AM +1" (New York and London local times in the
12 h form, formatted by Hermes' `Intl` with the airport zones), "Terminal 8, gate B22" and
"Departs in 3 h 3 min" in the accent colour; then OTHER FLIGHTS with "BA117  LHR → JFK",
"Fri 25 Sep, 9:44 PM" (Scheduled) and "DL1  ATL → LAX", "Tue 22 Sep, 10:56 AM" (a green
"Arrived" pill). The screenshot is from a relaunch: the seed ran on the first launch only, and
the relaunch, with no API reachable at all, rendered the same rows from the persisted store (and
the countdown one minute lower). `xcrun simctl ui ... appearance dark` re-themed the running
screen at once (background `#0B0E13`, cards `#171B22`, accent `#7C9DFF`, the Arrived pill
`#123D22` on `#B8EFC9`). The screenshots are in the build's scratch directory, not committed.

**Review round (2026-09-23).** The rebuilt development build was installed over the earlier one
on the same simulator and launched the same way. Its store already held the demo flights and
migrations 0000 to 0002, so the launch also applied `0003_local_intent` to an existing store; the
home screen then rendered the persisted rows as before (AA100 next, "7:49 PM → 7:49 AM +1",
"Terminal 8, gate B22", "Departs in 1 h 54 min", then BA117 and DL1), in light and in dark, with
the header's Add button (named "Add a flight" for a screen reader). Metro bundled 2266 modules.
The simulator was shut down again and the screenshots stay in the scratch directory.

What the development-only pieces are for, and why they are safe to ship (ruling X2): the seeded
route and the launch-argument redirect exist only so this one device check can reach the home
screen without an API. `__tests__/dev-routes.test.tsx` proves them inert elsewhere: with
`__DEV__` false, or in the preview or production variant, or on Android, `seededHomeRequested()`
is false whatever the launch argument says and the sign-in layout never redirects to the route;
the route itself then renders nothing of its own (only the redirect home), opens no store and
seeds nothing.

The run used a dedicated iPhone 17 Pro simulator, `iPhone 17 Pro (PlaneAhead inc10)` (iOS 26.5),
left shut down. A first attempt on the already booted iPhone 17 Pro installed this development
build there and left iOS's "Open in PlaneAhead Dev?" prompt from `simctl openurl` on its screen;
tap Cancel to dismiss it.

### The emulator launch

Best effort, as ruled. The AVD was cold-booted headless; it came up authorised for adb
(`emulator-5554 device`), so no prompt was involved and none was accepted. The debug APK was
installed, the development client pointed at Metro through `adb reverse`, and the seeded route
opened with an explicit-package intent (Android shows no chooser for it):

```sh
$ANDROID_HOME/emulator/emulator -avd Pixel_10_Pro_Fold_-_EMU -no-window -no-audio -no-boot-anim -no-snapshot-save &
adb -s emulator-5554 install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 reverse tcp:8081 tcp:8081
adb -s emulator-5554 shell am start -a android.intent.action.VIEW \
  -d "exp+planeahead://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081" app.planeahead.mobile.dev
adb -s emulator-5554 shell am start -a android.intent.action.VIEW -d "planeahead://dev/seeded-home" app.planeahead.mobile.dev
adb -s emulator-5554 exec-out screencap -d <inner display id> -p > android-home-seeded.png
adb -s emulator-5554 shell cmd uimode night yes   # dark, then `night no`
```

**Result.** The bundle loaded (2366 modules) and the inner display showed the same home screen
as the simulator: "AA100  JFK → LHR", "7:59 PM → 7:59 AM +1", "Terminal 8, gate B22",
"Departs in 3 h 4 min", then BA117 (Scheduled) and DL1 (Arrived), in light and, after
`cmd uimode night yes`, in the dark tokens. After the dev client's first-run sheet was dismissed
with `adb shell input tap`, its floating dev-tools button sits over the Add button (development
builds only). The emulator was shut down afterwards (`adb emu kill`), and the development build
stays installed on the AVD.

## Acceptance, item by item

| Spec acceptance | Proven here by | Device step (pending) |
| --- | --- | --- |
| Adding tomorrow's AA100 shows scheduled times within 5 seconds | `add-flight.test.tsx` "201": the outbox's `onSent` hook writes the server's row and the flight snapshot from the `POST /v1/flights` answer, so the times show when the answer lands, before any sync pull | Step 2 |
| Exactly one AeroDataBox call for that flight key in `provider_calls` (`cost_units = 2`) | `apps/api/test/workers/flights.two-accounts.test.ts` (ruling T1): the real Worker, subscribe route, DesignatorResolver, FlightTracker, persist consumer and embedded Postgres against the fake gateway; one gateway call, one `provider_calls` row `aerodatabox / flight_status / user_search / ok / cost_units 2` | Step 3 |
| Adding the same flight from a second account produces no further provider call | the same Workers test: the second account's subscribe answers 201 from the stored resolution and the seeded tracker (two subscribers), the gateway count stays 1, no second row, no `instances_created` charge | Step 4 |
| Killing the network and relaunching still renders the list from the store | `home-list.test.tsx` "renders from the store alone" (no request at all; `fetch` rejects); increment 9's `settings.test.tsx` for the offline relaunch of the settings store | Step 5 |
| Pull to refresh calls `POST /v1/flights/:id/refresh` at most once per gesture | `detail.test.tsx` "at most once per gesture" (two pulls and a button press while one is running: one request, no `Idempotency-Key`); `home-list.test.tsx` for the home's sync pull | Step 6 |
| The 504 last-known-state case is shown gracefully | `detail.test.tsx` "504" (the payload's flight applied, "still running" said), "null snapshot never replaces", "older snapshot never rolls back", the 8 s deadline UX with fake timers; the route side is increment 8's `flights.refresh.test.ts` | Step 7 (needs a slow tracker; see the step) |
| The detail timeline renders from the snapshot with dark mode via theme tokens | `detail.test.tsx` timeline tests (with the `+1` day cue) and light and dark snapshots; `flight-model.test.ts` `buildTimeline`; `theme.test.ts` (every status pill and text colour at WCAG AA, the input border, the timeline rail and its markers at 3:1, in both schemes) | Step 8 |
| Jest covers add-flight validation against the shared `parseDesignator` | `add-flight.test.tsx`: a table of inputs checked against `parseDesignator`, `DesignatorInputSchema` and `IsoDateSchema`; the number pad's eight-digit date and the hyphens the field inserts | none |
| Jest covers the list rendering from a seeded store | `home-list.test.tsx` (seeded by the real page apply; light and dark snapshots) | none |
| The list re-renders once, not 200 times, for a 200-row page | `live-query-coalescing.test.ts`: the real home screen under a React Profiler, the page applied through `applySyncPage` with 200 per-row tasks delivered after it, measured outside `act()` so every commit counts: 1 commit and 1 list query; control: a writer that signalled per row costs 200 commits; a 3-page pull costs 3 | none |

## Device steps for the owner (all pending)

Each step says what was verified here instead. Prerequisites: either staging deployed with the
real `AERODATABOX_API_KEY` (the development build talks to `api-staging.planeahead.app` by
default), or a local API: `cp apps/api/.dev.vars.example apps/api/.dev.vars`, point
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB` at a Neon branch migrated with
`pnpm --filter @planeahead/db db:migrate "$DB"` (the direct, non-pooler URL), set `AERODATABOX_API_KEY`, run
`pnpm --filter @planeahead/api run dev`, and build the app with
`PLANEAHEAD_API_URL=http://localhost:8787` (simulator) or `http://10.0.2.2:8787` (emulator). Without
the key the local API runs against the mocked provider and steps 3 and 4 stay pending, as the spec
says. `$DB` below is the Neon connection string of that database.

1. **Build and launch.** `cd apps/mobile && pnpm ios --device "iPhone 17 Pro"`; on Android
   `pnpm android` (if the emulator shows "Allow USB debugging?", accept it once; the headless cold
   boot here came up authorised). The app opens on the
   home screen with an anonymous session and the empty state ("No flights yet", Add a flight).
   Verified here instead: the development build launches on the iPhone 17 Pro simulator and renders
   the home screen over a seeded store (above); `home-list.test.tsx` renders the empty state.
2. **Add tomorrow's AA100.** Note the time (`date -u +%FT%TZ`), tap Add, type `AA100`, tap
   Tomorrow, tap Add flight. Expected: the sheet closes, AA100 shows as the next flight with its
   scheduled departure and arrival within 5 seconds of the tap. Verified here instead:
   `add-flight.test.tsx` "201".
3. **One provider call, `cost_units = 2`.** Within a minute of step 2:
   ```sh
   psql "$DB" -c "select provider, operation, trigger, result, cost_units, request_id, flight_key, created_at
                  from provider_calls where provider = 'aerodatabox' and created_at > '<time from step 2>'
                  order by created_at;"
   ```
   Expected: exactly one row, `aerodatabox | flight_status | user_search | ok | 2`. Its `flight_key`
   is empty: the DesignatorResolver's search call is recorded before the key is known (increment
   7), so the row is matched by time (or by `request_id`, the `X-Request-Id` of the subscribe).
   Later rows with `trigger = 'alarm'` and the flight key are the tracker's scheduled polls, not
   this add. Verified here instead: `flights.two-accounts.test.ts`.
4. **Second account, no second call.** On the Pixel AVD (a separate anonymous account), or after
   Settings, Sign out, Continue without an account on the simulator, add `AA100` for tomorrow again
   and re-run the query of step 3. Expected: still one `user_search` row; the second home screen
   shows the same times. Verified here instead: `flights.two-accounts.test.ts`.
5. **Offline relaunch.** Cut the simulator's network (macOS Network Link Conditioner, profile
   "100% Loss", or turn off the Mac's Wi-Fi), then
   `xcrun simctl terminate "iPhone 17 Pro" app.planeahead.mobile.dev && xcrun simctl launch "iPhone 17 Pro" app.planeahead.mobile.dev`.
   Expected: the home screen shows AA100 from the store; pull to refresh ends without an error.
   On the AVD: `adb shell cmd connectivity airplane-mode enable`, force-stop and reopen. Verified
   here instead: `home-list.test.tsx` "renders from the store alone".
6. **One refresh per gesture.** Tail the API (`pnpm --filter @planeahead/api exec wrangler tail --env staging --format pretty`,
   or the `wrangler dev` console), open AA100, pull down twice quickly, then once more after the
   spinner stops. Expected: two `POST /v1/flights/<id>/refresh` lines, not three. Verified here
   instead: `detail.test.tsx`.
7. **504 with the last known state.** Only reproducible with a tracker slower than the route's 8 s
   deadline (a provider outage, or a local API whose `AERODATABOX_BASE_URL` points at a host that
   stalls). Expected: the detail says "The refresh is still running. Showing the last known state",
   the times stay (never blank), and the next sync brings the result. Verified here instead:
   `detail.test.tsx` and increment 8's `flights.refresh.test.ts` ("answers 504 refresh_timeout").
8. **Timeline and dark mode.** Open AA100; the timeline shows gate departure and gate arrival (and
   takeoff and landing when the provider sent those times), the gate, the terminal, the aircraft
   and "Flight data: AeroDataBox". Then `xcrun simctl ui "iPhone 17 Pro" appearance dark` (or
   Settings, Appearance, Dark) and check home, the add sheet, detail and settings. Settings, Units
   and Time format change every time and distance at once. Verified here instead: the light and
   dark snapshots (`home-list`, `add-flight`, `detail`, `settings-units`) and `theme.test.ts`.

## Rulings applied, and departures from the spec

- **Timeline from the snapshot, not `flight_events` (ruling T4).** The spec says the detail
  timeline comes from `timeline_summary` and the snapshot's OOOI times, and the acceptance says it
  "renders `flight_events` from the snapshot". The sync feed carries `FlightStatus` snapshots and
  no event rows in Phase 0, so the timeline is built from the snapshot on the subscription row
  (`src/lib/timeline.ts`): scheduled, estimated and actual out, off, on and in, the gates and
  terminals, the baggage claim and the status. Takeoff and landing are shown only when the snapshot
  has a time for them. For increment 12's docs.
- **The refresh 504 code.** Ruling T3 names `upstream_timeout`; the increment 8 route answers 504
  `refresh_timeout` with the flight (and `upstream_timeout` only on the subscribe path). The app
  treats any 504 carrying a flight the same way, so both are covered and tested.
- **Home pull to refresh is a sync pull.** The per-flight provider refresh is the detail screen's
  gesture: every call is charged to that flight's daily refresh budget (10 on the free plan), and a
  home pull would spend it on every glance. The home pull drains the outbox and pulls
  `GET /v1/sync`, at most once per gesture as well.
- **A local store migration (0002, `finished_at`).** Ruling T3 asks a 410 `flight_archived` to
  mark the subscription finished locally; the sync feed carries no tracker phase, so the store gains
  a local-only column (appended migration, the guard passes). The store schema version changes with
  it, so the first pull after this update takes the no-cursor snapshot (increment 9's rule).
- **Outbox hooks.** `onSent(item, response)` (ruling T2) and a matching `onRefused`, both run
  inside the transaction that settles the item and return the tables they wrote; a hook that
  throws rolls back and the item settles without it (`onHookError`). `DroppedMutation` gains the
  refusal `body` for the user's message; the Sentry report still names method, path, status and
  code only. `applySnapshot` and `upsertSubscription` in `src/lib/sync/apply.ts` are exported, and
  `applySnapshot` gained an `onlyIfNewer` guard for route answers (a refresh or subscribe answer
  never rolls a row back past a newer sync page).
- **The optimistic row's key.** The canonical flight key (operating carrier, origin ICAO) is only
  known once the server resolves the designator, so the optimistic row carries a local placeholder
  key `pending:<DESIGNATOR>:<DATE>` and shows as "Adding"; the success hook replaces it with the
  server's row. A refused add removes it (and any mutation queued for it).
- **The units and time-format toggles also PATCH the account.** They are the account's
  `user_preferences`, so besides the zustand store (ruling T6) they queue
  `PATCH /v1/me/preferences` through the outbox, and a sync page cannot flip a choice back while
  its PATCH is queued (`withPendingPatches`). "Metric" is km and Celsius, "Imperial" miles and
  Fahrenheit. `showLocalTimes` (default on) is honoured: airport-local times.
- **Settings screen and the increment 9 settings test.** The screen now subscribes to the
  preferences, so the increment 9 test's `applyServerPreferences` call is wrapped in `act()`.
- **A development-only seeding route** (`src/app/dev/seeded-home.tsx`, `src/dev/demo-flights.ts`)
  for the one device check, and a launch-argument redirect to it in the sign-in group's layout
  (`src/dev/seeded-launch.ts`, iOS, because `simctl openurl` stops at a system prompt). Both ship
  in the bundle but do nothing outside `__DEV__` and the development variant.
- **No new dependencies, no API, shared-contract, provider, Durable Object or sync-route changes.**
  One api test file was added (ruling T1). The `FlightView` answer shape is parsed locally with zod
  (`src/lib/flights.ts`) rather than adding a schema to `packages/shared`. The review round kept
  all of this (ruling X5).
- **Accepted as built (ruling X1).** Every item above is kept: the timeline from the snapshot, both
  504 codes read as "still running", the home pull as a sync pull, the local migration and the
  store-version bump, the outbox's `onSent`, `onRefused` and `onHookError` hooks and the apply
  exports with the `onlyIfNewer` guard, the pending placeholder key and the "Adding" state, the
  toggles' `PATCH /v1/me/preferences` with the pending-patch overlay, the local zod parsing of
  `FlightView`, the `act()` wrap in the increment 9 settings test, and screenshots kept out of the
  repository.

## The review round

The review panel's findings, applied under the orchestrator's rulings X1 to X7. Every behavioural
fix has a regression test; the files named are under `apps/mobile/`.

**Offline data flow (ruling X7).**

- **A cancelled add never deletes the flight the account already had** (offline-data-flow-1).
  `reconcileSent` now branches on the answer's `created`. On 200 `created: false` under another id
  the add was a no-op on the server: the optimistic row and every outbox item naming it are deleted
  (never pointed at the server's id), its tombstone is never copied onto the server's row, and the
  server's row and flight are still written. `created: true` under another id (a restored
  tombstone) keeps the re-point. Proven by `__tests__/offline-flow.test.ts` with the reviewer's
  codeshare scenario (BA1511 for a tracked AA100): the requests are two POSTs and no DELETE, and
  AA100 stays tracked. `add-flight.test.tsx`'s created-false test now asserts the same.
- **A pending add is shown once** (offline-data-flow-2). The pending placeholder key never equals a
  canonical key, so the increment 9 key-equality guard in `applySyncPage` could not fire; it is
  replaced by a match on designator and origin-local date (`pendingMatchesLive`: the key's
  operating designator, the one typed on this phone, the snapshot's marketing designator and its
  codeshares, in IATA and ICAO spellings). After a page's rows are written, for replace and delta
  pages alike, and when `addFlight` or the success hook writes, a pending row that matches a live
  row is marked `superseded` and hidden from `listFlights`; its POST stays queued, and the 200
  `created: false` settles it. `src/lib/sync/local-intent.ts`; tests in `offline-flow.test.ts` and
  `sync-apply.test.ts`.
- **Local intent survives a pull** (offline-data-flow-3 and -6, rulings X3 and X7 item 3; the
  build's open question). Inside `applySyncPage`'s transaction, after the page's rows, every row a
  queued `DELETE /v1/flights/:id` names gets `deleted_at = coalesce(deleted_at, now)`, and such a
  row is kept through a replace (`deleteSyncedRows`); it goes for good when the DELETE settles (or
  is answered 404). The local-only columns (`finished_at`, `added_as`, `superseded`) are read
  before `deleteSyncedRows` and restored onto the page's rows with the same id. Tested through the
  SqliteLike fake with a 503-deferred DELETE followed by a successful pull, a snapshot replace and a
  delta page that changes the row (`__tests__/local-intent.test.ts`).
- **An add removed before it was sent costs nothing** (offline-data-flow-4). The outbox stamps a
  new `last_attempt_at` column on the head before `transport.send`, synchronously after reading it.
  `removeFlight` on a row whose POST is unstamped (and unattempted) deletes the POST item and the
  optimistic row in one transaction and queues nothing; a stamped one still queues the DELETE,
  because the server may have committed the POST.
- **The detail follows the server's id** (offline-data-flow-5). The success hook records
  `replaced:{optimisticId} = serverId` in the kv-store (`src/lib/flight-replacements.ts`), and
  `useFlight` follows it (the entry is cleared once read, the hook keeps the id it ended on), so a
  detail opened on an "Adding" row shows the flight, not "Flight not found". The refresh and the
  unsubscribe use the shown row's id. `detail.test.tsx` and `offline-flow.test.ts`.

**Screens and contract (ruling X6).**

- **410 without a flight** (screens-and-contract-1): `finished_at` is stamped on the subscription
  by its id in the same commit, whether or not the answer carries a flight; a non-null view is
  still applied by key.
- **The date on the number pad** (screens-and-contract-2): the field keeps `inputMode="numeric"`,
  inserts the hyphens as the digits are typed (`formatDateInput`), and `validateAddFlight` reads
  eight digits as `YYYY-MM-DD` before `IsoDateSchema`. No date-picker dependency.
- **Whose designator** (screens-and-contract-3): the card and the detail show the designator typed
  on this phone (`added_as`, written by `addFlight`, kept by the success hook and across a
  replace), else the key's operating designator, with "Operated as AA100" beside it when they
  differ; never the snapshot's marketing designator, which names whoever searched the flight first.
  The duplicate check (`findTracked`) compares flight keys (the placeholder key, or the key's
  operating carrier, number and date), never designators.
- **A landed flight hands over** (screens-and-contract-4): for the next-flight slot a landed flight
  is over 30 minutes after its best arrival time, or at once when another flight in the list
  departs before then; it stays in the list.
- **401 `account_deleted` on refresh** (screens-and-contract-5): wipes the store and runs the same
  `forgetAccount` path the outbox and the sync client use (`Services.onAccountDeleted`).
- **Accessibility** (screens-and-contract-6): each card is one button whose name carries the
  status, departure time, gate, terminal and, on the hero, the countdown (the hero owns the minute
  clock, so the name and the text tick together); a busy `Button` keeps its name and sets
  `accessibilityState.busy`; the status pill is an accessibility element; the header button is
  named "Add a flight"; timeline steps no longer say "scheduled" without a time and name their
  state in words. Role and name assertions in `home-list.test.tsx` and `detail.test.tsx`.
- **The empty state** (screens-and-contract-7): only when the store has no rows. An add being
  looked up fills the top slot ("NEW FLIGHT", the "Adding" pill) when nothing live is ahead; a list
  of past flights says "No upcoming flights" above them.
- **The rest** (screens-and-contract-8 to -11): the timeline appends `+1` (or `-1`) to a time on
  another local day than the departure date; subscribe refusals other than 403 and 404 are tested,
  and a code this build does not know gets a generic sentence (the code goes to Sentry with the
  drop; the refresh's unknown refusals likewise, as `flight_refresh_refused`); an `inputBorder`
  token and the timeline rail meet 3:1 and `theme.test.ts` checks them; `formatCountdown` returns
  nothing for a non-finite duration.

**What else the round changed, and why.**

- **A second local store migration, `0003_local_intent`** (generated by drizzle-kit, appended; the
  migrations guard passes): `flight_subscriptions.added_as`, `flight_subscriptions.superseded`
  and `outbox.last_attempt_at`, all local only. The store schema version changes with it, so the
  first pull after this update is again the no-cursor snapshot, which now carries the local-only
  columns across.
- **Four increment 9 tests in `sync-apply.test.ts` changed with the rulings**: their optimistic
  row now uses the real writer's placeholder key; a snapshot that carries its flight hides it as
  superseded instead of deleting it; and a queued DELETE now keeps its row as a tombstone through a
  replace (the old test asserted it did not).
- **`LIST_FLIGHTS_SQL`** is exported so the coalescing test counts the list's own statement, not
  the page apply's new local-intent reads of the same table.
- **Recorded for increment 12 by the orchestrator (ruling X4), not changed here**: the resolver's
  `user_search` `provider_calls` row carries `flight_key` NULL, so the admin page joins search calls
  by request id; the increment 12 spec gains "the DesignatorResolver appends its provider_call
  record after resolution with the resolved key".

## The re-review round

The re-review of the review round found two minors and three nits, applied under the
orchestrator's rulings Y1 to Y5; every earlier ruling (T1 to T7, X1 to X7) stands. Every fix has
a regression test; the Y1 to Y4 tests were each checked to fail with their fix reverted (Y5's
tests exercise the new record format and its cleanup, which have no earlier form to revert to).
The files named are under `apps/mobile/`.

- **An add made offline stays cancellable** (rr-offline-data-flow-4-partial, ruling Y1). The add
  sheet drains at once, and that drain stamped `last_attempt_at` even with no network, so the
  offline add could no longer be cancelled outright. The outbox now takes an `isOnline` seam
  (`src/lib/sync/outbox.ts`): after the head is found due and before it is stamped, a phone that
  KNOWS it is offline ends the pass `deferred` with no stamp, no attempt counted and nothing sent;
  every request actually handed to the transport is still stamped first, synchronously. services.ts
  passes TanStack's `onlineManager`, which expo-network already feeds in `src/lib/query.ts`. That
  listener hears changes only, and Android sends none while a phone starts offline, so
  `watchNetwork` also reads `getNetworkStateAsync` once: a known offline answer is applied unless a
  change was heard first, and an unknown or failed read leaves TanStack's default (online), so a
  missing answer never holds the queue back. The network's return still starts the next drain
  (`src/lib/session.ts`). Tests: `add-flight.test.tsx` "known offline" runs the sheet's own
  sequence through the real services (the sheet's `addFlight` and its immediate drain, then
  `removeFlight`): the drain resolves `deferred`, `fetch` is never called, the outbox row has no
  stamp and no attempt, `removeFlight` returns `cancelled`, the row and the item are gone, and a
  drain back online sends nothing; "no answer" shows that online the stamp is in the row when
  `fetch` is called. `offline-flow.test.ts` covers the drain itself, and `online-state.test.ts`
  the launch read (known offline applied, a change heard first wins, online, unknown or failed
  change nothing).
- **"Operated as" keeps the designator's case** (rr-screens-operated-lowercase, ruling Y2). The
  row text and both accessibility labels lower-cased the whole phrase ("operated as ba117").
  `operatedAsPhrase` in `src/lib/flight-model.ts` gives the mid-sentence form ("operated as
  BA117") and serves the row's second line, the row's label and the hero's label; the hero's own
  line keeps `operatedAs` ("Operated as AA100"). `home-list.test.tsx` asserts a codeshare row in
  the rest list (BA117 added as AA6139: its text and its name) and the hero's name.
- **Re-typing a name a card shows says "You already track"** (rr-screens-typed-name-not-tracked,
  ruling Y3). `findTracked` still compares flight keys first; after that it returns the id of a
  live, non-pending row that `pendingMatchesLive` would match on that date: the designator typed
  on this phone (`added_as`), the key's operating designator, the snapshot's marketing designator
  and its codeshares, in IATA and ICAO spelling (the shared `liveRowNamed`). This amends the
  review round's "never designators" for the duplicate check only; the name a card shows is
  unchanged (screens-and-contract-3). `add-flight.test.tsx` adds BA1511 through the sheet (it
  lands on AA100's key, the provider listing no codeshares), then re-types BA1511: the sheet says
  "You already track BA1511 on Wed 23 Sep." and nothing is queued or sent; the duplicate-check test
  now covers the marketing designator and a codeshare in both spellings, and a codeshare no row
  here is known by is still queued.
- **An ICAO spelling is never "operated as" itself** (rr-screens-icao-self-codeshare, ruling Y4).
  `operatedAs` (and `operatedAsPhrase`) return null when `designatorSpellings` of the shown
  designator contains the operating designator, so `AAL100` typed for `AA100` shows no "Operated
  as AA100". `flight-model.test.ts`.
- **The replacement records are bounded** (rr-offline-data-flow-5-kv-leak, ruling Y5).
  `src/lib/flight-replacements.ts` stores `replaced:{optimisticId}` as `{ serverId, at }`; every
  record older than a day (or unreadable) is dropped whenever one is read or written, a record is
  removed once the server row it points at has been read (`readFlightFollowing` forgets the
  records it followed when it finds a row, and keeps them while the row is not in the store yet),
  and `forgetAccount` clears every `replaced:*` record, so sign-out and `401 account_deleted` leave
  none behind. `SyncKv` gains `getAllKeysSync` (expo-sqlite's `Storage` has it; the Jest kv
  stand-ins run the same `SELECT key FROM storage`). Tests: `offline-flow.test.ts` section 5 (kept
  until the row is read, then gone; the day-old sweep on read and on write; `clearReplacements`
  leaves the other kv keys) and `add-flight.test.tsx` "forgetAccount drops every record".

**What else the round changed, and why.**

- `addFlight` no longer runs `markSupersededPending`: with Y3, an add a live row already names is
  answered locally and never queued, so the call could not mark anything. A pending add is still
  marked superseded when a pull (or the success hook) brings a live row that names it after the
  add was queued.
- Tests that queued BA1511 over the seeded store now seed AA100 without codeshares (or queue the
  add before the store knew AA100), because the fixture lists BA1511 as AA100's codeshare and Y3
  answers it locally: `offline-flow.test.ts` section 1, `detail.test.tsx` "follows an add the
  server answered under its own id", `flight-model.test.ts` "matches by designator and date".
- `readFlightFollowing` loses its injectable `take` parameter (only the default was ever used).

**The second re-review.** One nit: after Y1 the outbox gate read `isConnected` only, while the
reconnect drain in `session.ts` fires on `isInternetReachable`. expo-network on Android derives
the two separately (the transport class and the VALIDATED capability), so a validated network on
a transport it does not classify (USB, Thread, LoWPAN, satellite; iOS is unaffected) reported
`isConnected: false, isInternetReachable: true`: the pull ran, every drain returned `deferred`,
and adds, removes and preference patches never left the phone while it stayed on that network.
Fixed in the close-out: `watchNetwork` counts either field as online and the launch read applies
offline only when neither is true. `online-state.test.ts` gains the mixed state (kept online at
launch and on a change; offline once both are false), 2 mobile tests more than the round's count.

## Known issues and open questions

- The mobile Jest run prints "A worker process has failed to exit gracefully" when run on its own
  with many workers; it reproduces on a clean `main` tree (increment 9) and does not fail the run.
  Not introduced here; worth a look in a later increment.
- The owner's `provider_calls` query cannot filter the search call by flight key (see step 3);
  ruling X4 records the fix for increment 12.
- A DELETE the server refuses with anything but 404 leaves its local tombstone without a queued
  DELETE: the row stays hidden until the next snapshot replace brings it back as the server's.
  The route's only other refusals are a malformed id and a missing scope, neither of which the app
  sends.
