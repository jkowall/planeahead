# Increment 10 verification: home, add flight, detail

Branch `inc10-home-add-detail` (based on `main` with increments 2 to 9), 2026-09-23. This file
records what ran on the build machine, with its result, and the exact device steps the owner runs
once an API is reachable. No API is reachable here: staging has no DNS yet and `apps/api` has no
local-dev path without a Neon branch (`wrangler dev` needs
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB`, apps/api/README.md). Following ruling T1, the
provider-call assertions run in the api Workers suite, the screens are proven in Jest, and the one
device check run here is the iPhone 17 Pro simulator launch of the development build to the home
screen over a seeded store.

## What ran here

| Check | Command | Result |
| --- | --- | --- |
| Full check | `pnpm turbo run typecheck lint test --force && pnpm prettier --check . && node scripts/toolchain-guard.mjs && node scripts/vitest-exit-guard.mjs` | passed: 14 turbo tasks in 1 min 40 s; 1896 tests passed (tools 19, shared 577, db 176, api 707 with 1 skipped, mobile 417); Prettier clean; toolchain guard ok; exit guard ok |
| Mobile Jest (inside the turbo `test` task) | `pnpm --filter @planeahead/mobile test` | 24 suites, 417 tests, 10 snapshots (light and dark of home, empty home, add sheet, detail, settings) |
| Mobile migrations guard | `node scripts/mobile-migrations-guard.mjs --base main` | ok, 3 migrations, the 6 committed files unchanged (0002 appended) |
| `expo prebuild` (development variant) | `cd apps/mobile && LANG=en_US.UTF-8 EXPO_NO_GIT_STATUS=1 CI=1 pnpm prebuild` | passed, 26 s, 132 pods (run again after the last code change) |
| iOS simulator compile | `xcodebuild -workspace ios/PlaneAheadDev.xcworkspace -scheme PlaneAheadDev -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build` (with `SENTRY_DISABLE_AUTO_UPLOAD=true`) | BUILD SUCCEEDED, 2 min 14 s incremental (run again after the last code change) |
| iPhone 17 Pro simulator launch to the home screen over a seeded store | see "The simulator launch" below | passed: the home screen over the seeded store, light and dark (below) |
| Android compile | `cd apps/mobile/android && ./gradlew assembleDebug -PreactNativeArchitectures=arm64-v8a` (with `ANDROID_HOME` and `ANDROID_SDK_ROOT` exported, `SENTRY_DISABLE_AUTO_UPLOAD=true`) | BUILD SUCCESSFUL, 1 min 16 s |
| Android launch (best effort), Pixel_10_Pro_Fold_-_EMU headless | see "The emulator launch" below | passed: the home screen over the seeded store, light and dark |

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
| The detail timeline renders from the snapshot with dark mode via theme tokens | `detail.test.tsx` timeline tests and light and dark snapshots; `flight-model.test.ts` `buildTimeline`; `theme.test.ts` (every status pill and text colour at WCAG AA in both schemes) | Step 8 |
| Jest covers add-flight validation against the shared `parseDesignator` | `add-flight.test.tsx`: a table of inputs checked against `parseDesignator`, `DesignatorInputSchema` and `IsoDateSchema` | none |
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
  (`src/lib/flights.ts`) rather than adding a schema to `packages/shared`.

## Known issues and open questions

- The mobile Jest run prints "A worker process has failed to exit gracefully" when run on its own
  with many workers; it reproduces on a clean `main` tree (increment 9) and does not fail the run.
  Not introduced here; worth a look in a later increment.
- The owner's `provider_calls` query cannot filter the search call by flight key (see step 3). If
  the acceptance must be phrased per flight key, increment 12 could stamp the resolved key onto the
  resolver's call record before it is persisted.
- Offline deletes: a `DELETE` still queued behind a server error while a later pull succeeds lets
  the pull re-show the row until the DELETE drains. The drain runs before every pull, so this needs
  a 5xx on the DELETE and a successful pull in the same window.
