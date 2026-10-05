# Increment 16 verification: client push

Branch `inc16-client-push` (from main at `58d7774`, increment 15 merged), 2026-10-01. The increment
was built in four parts: the app's push lifecycle (`82b1543`: rulings C1 to C4, C6 and C7), the
notification icon and the time-sensitive entitlement (`e4754d6`: C5, C8 and the plugin's default
channel), notification settings, the overrides contract and the tray at sign-out (`47fc437`, built
on its own branch and merged as `741ec86`: C11 and C12), the transport soak harness (`ac113d7`: C9),
and these documents (part 4). The full check of the merged tree then failed on the API suite's
Postgres connections, which a test-only fix closed (`de4237c`, finding 9). This file records what
ran on the build machine with its result, how each acceptance item is proven, the measurements, what
the build found that the spec did not have, where the build departs from the spec and why, and what
stays unverified, with the steps that settle it. Two review lenses and six skeptics then read the
build at `422bfe3`, main (increment 18) was merged in (`b42b0a8`), and the round's rulings were
applied in four code parts: F1a (`df11589`: the sign-out lifecycle), F1b (`363142a`, merged as
`1f38465`: the token read and the screens), F2a (`47c10f5`: the invalidation ends the session, the
soak's fixes) and F2b (`89ba245`: the overrides contract, the test cluster, the injector's
refusals), the two F2 parts merged as `dfad10d`. The close-out's native smoke then failed on a
false check, fixed in `c5639b6`, and F3a and F3b wrote the documents. The
[Review round](#review-round) records them; the sections before it describe the build, corrected
where the round changed what they say, and their counts are the build's (the round's are under the
Review round's What ran). The spec is [16-client-push.md](16-client-push.md); the research behind
it is `docs/research/phase1/R2-client-push.md` (R2); the server half of registration and sign-out
is increment 14's ([14-verification.md](14-verification.md)).

The machine: macOS 27.0.1, Node 24.21.0, pnpm 12.5.1, wrangler 4.135.0, Jest 29.7.0 with jest-expo
57.0.5, Vitest 4.1.11, embedded PostgreSQL 18.4. No Apple, Google, Expo, provider or Cloudflare
account and no simulator or device: the Jest suites fake expo-notifications
(`apps/mobile/__tests__/support/fake-notifications.ts`) and the API, and in the Workers pool every
provider read went to the harness's fake gateway and every push request to a `fetch` the test
answers.

## What ran here

Each part ran the files its changes touch, one file per command (`pnpm exec jest <file>` from
`apps/mobile`, `pnpm exec vitest run <file>` from `apps/api` or `packages/shared`), then typecheck,
lint and `prettier --check`; the counts below are the parts' own runs.

| Part | Check | Result |
| --- | --- | --- |
| 1 | The new mobile suites | passed: push-permission 20, push-registration 15, push-handling 16, sign-out 16, settings-push 4 |
| 1 | Mobile suites the part changed or reaches | passed: devices 9 (3 new), add-flight 72 (3 new), settings 2, settings-units 7 (its 2 snapshots moved: the Notifications section), detail 24, sign-in 25, live-activity-tokens 9, house-style 182 |
| 1 | Mutants, each reverted after its run | 41 of 41 killed: C1 7, C2 8, C3 9, C4 3, C6 4, C7 10 |
| 2 | App config and the plugin chain | passed: app-config 27, entitlements 13, store-bundles 17 (a real prebuild of a copy of the config), house-style 182 |
| 2 | The native smoke's own tests (`pnpm exec vitest run tools/workflows/native-smoke.test.js`, repository root) | passed: 57 |
| 2 | Typecheck and lint (`apps/mobile`; the root's eslint over `eslint.config.js`, `scripts`, `tools`) | passed |
| 2 | Mutants | 11 of 11 killed: the entitlement, the icon, the colour and the channel each removed (app-config and the chain test fail), a misnamed plugin prop (typecheck), the wrong channel, the script drifting from the PNG, a pixel that is not white, a pixel on the edge, the smoke's entitlement check, the plist stub's boolean |
| 3a | Shared and API | passed: shared `rpc` 20; API `flights.subscribe` 25 (2 new), `crons` 36, `merge.sync` 1, `reconcile` 6 |
| 3a | Mobile, 24 suites one at a time | passed: settings-notifications 5 (new), sync-apply 39, settings 3, settings-units 8 (snapshots: the six new rows), sign-out 18, theme 34, and 18 other suites the changed modules reach (among them push-permission 20, push-handling 16, push-registration 15, add-flight 72, home-list 24) |
| 3a | Lint (`apps/api`, `apps/mobile`, `packages/shared`) and mutants | clean; 14 of 14 killed |
| 3b | The soak, new (`test/workers/push-soak.test.ts`) | passed: 14 |
| 3b | Files the part changed or reaches | passed: dispatch (updated), admin-inject 8, admin-push 13, crons 36, among others |
| 3b | Mutants | 22 of 22 killed (the list is under [Acceptance](#acceptance-item-by-item)) |
| 3b | Both dry runs (`pnpm --filter @planeahead/api exec wrangler deploy --dry-run --env staging`, then `production`) | passed: 3,709.16 KiB, gzip 742.97 KiB |
| Merge | The full check of `741ec86` (the orchestrator's) | failed: the API suite, 23 tests in 7 files, 22 of them "too many clients" (finding 9). Everything else passed: typecheck and lint in every package; mobile 41 suites, 742 tests, 12 snapshots; shared 27 files, 785; db 11 files, 195; tools 6 files, 88; prettier, the toolchain and exit guards, the mobile migrations guard, the migration hash (10 migrations, `e7dc311354dd`), actionlint, shellcheck; both dry runs 3,709.12 KiB, gzip 743.02 KiB |
| Fix | `de4237c`, test code only | the failing file order on a 100-connection cluster with main's suite running beside it as load: 85 files passed, no exhaustion; `pnpm exec vitest run` (apps/api, no filter) twice: 85 files, 1,065 passed and 1 skipped each time; typecheck, lint, prettier clean |
| 4 | The runtime fingerprints of the final tree (`APP_VARIANT=preview APNS_ENVIRONMENT=production node_modules/.bin/expo-updates fingerprint:generate --platform ios`, then `android`, from `apps/mobile`) | iOS `5068d917e263...`, Android `3cb004ba8dd1...`: part 2's values, all 62 sources equal (parts 3a and 3b changed no fingerprint source); the review round's dependency patch moved both again (see [Measurements](#measurements)) |
| 4 | The icon (`node scripts/gen-notification-icon.mjs --check`, and a decode of the PNG) | up to date; the numbers are under [Measurements](#measurements) |
| 4 | The documents: `pnpm exec prettier --check` on the four documents Prettier formats (the two under `docs/increments/` are skipped by `.prettierignore` and wrapped at 100 columns by hand); the tests that read them | clean; passed: the mobile house-style test 183 (it scans the runbook), the shared style test 66 (it scans `docs/architecture.md`) and the cadence-table test 8; no em dash in any changed file |

Not run in the build: the native smoke itself (its iOS prebuild step now requires the entitlement;
both legs are the close-out's run), any simulator or device (the parts needed none), and the full
check of the final tree, which is the orchestrator's. Both ran after the review round, on `dfad10d`,
and every step passed, the smoke's once `c5639b6` had fixed one false failure (the Review round's
[full checks and native smoke](#the-full-checks-and-the-native-smoke)).

## Acceptance, item by item

- **Every C10 test, mobile (Jest).**
  - The permission flow (C1): `push-permission.test.ts` (20): granted; provisional read from
    `ios.status` 3 as a quiet grant, never prompted over; denied; Android's `denied` before any
    request read as undetermined until this installation has asked once; a request checks first and
    asks for alert and sound only (no badge, no provisional); the pre-prompt offered once per
    installation and only while the system prompt can still show. `add-flight.test.tsx` (3 new): the
    first add that succeeds gives way to the pre-prompt and a later add never shows it; a decided
    permission or a refused add offers nothing. Since the review round (O1) the first add that
    succeeds from an airport board or the route search offers it too, over that screen
    (`airport-board.test.tsx`, `route-search.test.tsx`). `settings-push.test.tsx` (4): each state's
    line, "Turn on notifications" while the prompt can show (registering the answer at once), "Open
    system settings" when denied (since N3 the app's notification settings, not its settings page),
    the state read again on the way back.
  - Registration on launch, foreground and rotation (C2): `push-registration.test.tsx` (15): the
    device token goes with the permission the app holds; without a token, or without a readable
    permission, the device registers without one; one registration at a time, triggers during it
    making one more run; the listener's echo of the registrar's own read ignored; a rotation
    registered once, debounced, as the listener carried it (no read); `reset` and `idle`;
    `useSessionWork` registers on session start, on every return to the foreground and on a
    rotation (since the review round's A1 also on a network return while a sign-out's call is
    queued), not without a session, and not after a revoked Apple credential, which signs out the
    way the button does. `devices.test.ts` (3 new): the variant's `appId` with a token and the
    permission with a device token; an unreadable app id left out; every registration waits for a
    queued invalidation and sends nothing while it stays queued.
  - The offline sign-out queue and its retry order (C3): `sign-out.test.ts` (16, then 18 with part
    3a's tray): the invalidation goes with the session being signed out of; it is queued without a
    request while the phone knows it is offline, and after a network failure, a 503, a 429 or the
    timeout; refused, not queued, on any other 4xx or with no session cookie left; a second sign-out
    keeps the first queued call; the next launch sends it with the signed-out session's cookies,
    then forgets it; it stays through a network failure, and is dropped and reported after three 5xx
    answers, on a 401, once its cookies have all expired, and when unreadable; concurrent settles
    make one request; `signOut` stops registration, invalidates, clears the tray, forgets the
    account, then unregisters, and a tray clearance that fails or never settles holds nothing up;
    offline it signs out at once and the next launch sends the call before any registration. Since
    the review round (A1, A3, A4, N1, N2, N7) sign-out pauses registration, invalidates, drops a
    waiting tap and the last response, starts the token deletion beside `forgetAccount` (which
    clears the tray, resets the registrar, and sends no `/sign-out` when the call was queued),
    waits for the deletion a bounded time and clears the tray again; while signed out the call and
    an owed deletion are retried on every return to the foreground and every network return (the
    round's tests are under [By ruling](#by-ruling)).
  - Channel creation before the prompt (C4): `push-permission.test.ts`: both channels at start-up,
    `HIGH`, from `ANDROID_CHANNEL_IDS`; they exist before the permission request asks; none on iOS;
    since N4 one channel that fails to be created leaves the other.
  - The foreground handler's decisions (C6): `push-handling.test.tsx` (16): the flight a push names
    is read only from data it knows (`v` 1 and a UUID); a push is presented (banner, list and sound)
    unless its flight is in front (since A1, nothing while the session is known to be null:
    `sign-out-lifecycle.test.tsx`), and one that names no flight (a test push), or carries a data
    version this build cannot read, is presented; the handler is installed once and answers from
    memory as the detail screen comes and goes; a foreground push naming a flight syncs the store.
  - Tap routing (C7): the same file: a cold start's last response waits for a session, then opens
    the flight once and is cleared; an unknown id gets one sync, then the flight, or the home screen
    if it is still unknown; the flight already in front refreshes in place; a tap naming no flight
    is cleared and routes nowhere; the same tap from both sources routes once.
  - The dismissal of a flight's presented notifications (C7): the same file: those whose data names
    the flight, and those FCM displayed, by their tag; the detail screen does it when it opens, once
    the flight key is loaded, and since A6 when the app returns to the foreground on it
    (`push-handling.test.tsx`, 17).
  - The notification toggles (C11): `settings-notifications.test.tsx` (5): the defaults (alerts on,
    every kind on but first gate assignment); the account's choices read from the sync feed, the
    defaults for what it leaves out; a change applies at once, persists, and is queued as
    `PATCH /v1/me/preferences` through the outbox; a change queued offline holds over the older
    choices a sync page brings; the toggles stay editable while the permission is denied, beside the
    system settings link. Also `sync-apply.test.ts` (2 new: the row read with defaults filled in; a
    tombstoned row reads as the defaults, an unparsable one is skipped), `settings.test.tsx` (a
    state persisted before increment 16 keeps its values and takes the notification defaults),
    `settings-units.test.tsx` (each queued body laid over its own part) and `theme.test.ts` (a
    switch's tracks keep 3:1 against their section).
- **Every C10 test, API (Workers pool).** `push-soak.test.ts` (14): the schedule (a tick inside the
  soak injects a departure delay into the test flight end to end, through the real tracker, persist
  and `notify`, to one push job; a tick outside plans nothing and a step of a stopped or replaced
  soak does nothing; the canary on every twelfth tick from the start, the first included; its two
  sends ask `PushAuth` in the same instant past a warm isolate cache and carry one token on both
  APNs requests; a canary for a token invalidated since the start is recorded refused and sends
  nothing; a send asks alone once the gate's wait ends); the staging-only guard (production refuses
  to start a soak, shows no form, and its tick and steps do nothing; `wrangler.jsonc` gives staging
  alone the soak's cron, and every expression is routed); the counts (every 403 and 429 reason, edge
  52x answers and the sends inside the soak's window, and its 409s; the named answers drawn out of
  the attempt rows); start and stop (behind Access, linked from `/admin`, each audited `pending`
  before the record changes and settled `error` when KV fails; another origin, a malformed form, an
  unknown or invalidated token and an untracked flight refused). Each of part 3b's 22 mutants made
  at least one of them fail: the three production guards, the production cron, a tick before the
  start, after the end and after a stop, the hourly canary, a stopped and a replaced soak's steps,
  the audit row's order, a second start while one runs, the canary's gate and its cold cache, the
  invalidated canary token, the per-tick refusals, the injection id minted at the tick, the delays
  in turn, the edge filter, the 403 and 429 filter, the window's end, and the housekeeping route.
  Since the review round the injection id is derived from the soak and the slot (n2), the canary's
  ids are minted at its step (n6) and its audit row records how the gate opened and whether the
  tokens matched (M1 (c)); the file has 20 tests. The overrides schema refusing `events` and
  unknown keys: `packages/shared/test/rpc.test.ts`; in `flights.subscribe.test.ts` the subscribe
  route refuses both with no row written and stores and relays `muted`, and a repair re-subscribe
  relays a stored bag narrowed to `muted`, which the tracker accepts. Since m1 the subscribe body
  refuses `notificationOverrides` altogether (`{ muted: true }`, `{}` and an `events` bag answer 400
  and write nothing), the top-level `muted` is the one per-flight mute and reaches the column and
  the tracker, and a repair relays no stored bag (the two tests rewritten).
- **The app-config tests cover the entitlement, the icon, the colour and the default channel.**
  `app-config.test.ts` (27): the time-sensitive entitlement in every variant; the expo-notifications
  entry `{ mode, icon, color, defaultChannel }` checked with `satisfies NotificationsPluginProps`,
  the channel equal to `ANDROID_CHANNEL_IDS.flightChanges`; the icon a 96 by 96 PNG, white wherever
  it is not transparent, with an empty 1 dp edge, between 5 and 50 percent opaque, and what the
  committed script draws (`--check`). `entitlements.test.ts` (13), through the whole plugin chain:
  each profile keeps the entitlement and gives Android the icon, colour and channel metadata. The
  fingerprint change is under [Measurements](#measurements).
- **The native smoke's iOS and Android steps with the new entitlement and icon**: not run in the
  build. The iOS prebuild step requires the entitlement (`scripts/native-smoke.sh`, held by
  `tools/workflows/native-smoke.test.js`); the Android step has no icon check of its own (departure
  5). The close-out ran both legs locally on `dfad10d`: every step passed on both platforms, the
  iOS prebuild printing the entitlement `true`, once `c5639b6` had fixed a check that failed with
  the JavaScript bundle present (the Review round's
  [full checks and native smoke](#the-full-checks-and-the-native-smoke)).
- **The full check and both dry runs**: the full check of `741ec86` failed only on the API suite's
  connections (finding 9); after the fix the API suite passed in full twice and in the failing order
  under load. Both dry runs passed at `741ec86`, and the fix changed no production code. The full
  checks of `b42b0a8` (main merged in) and of `dfad10d` (every fix part merged) passed, both dry
  runs included (the Review round).
- **Unverified until the accounts, the devices and staging exist**: under [Unverified](#unverified),
  with the steps.

## Measurements

- **The runtime fingerprint** (C8, and the plugin entry of C4 and C5). With the preview profile's
  environment (`APP_VARIANT=preview`, `APNS_ENVIRONMENT=production`), from main at `58d7774` to part
  2: iOS `a7995e0008b7...` to `5068d917e263...`, Android `3907e6d07d38...` to `3cb004ba8dd1...`. On
  each platform 2 of the 62 sources changed: the resolved config's contents (the entitlement and the
  plugin's options) and `plugins/withApsEnvironment.ts` (its corrected comment). Part 4 recomputed
  both on the final tree and found part 2's values with every source equal. So no update published
  from this tree reaches a build with the old runtime version: testers need a new native build. The
  icon's file is not a source (its path is, inside the plugin's options), so a PNG replaced in place
  keeps the runtime version, and the new icon shows only after a native build (runbook step 18).
  The review round's dependency patch (A2) moved both again: iOS `5068d917e263...` to
  `d27e470b75f2...`, Android `3cb004ba8dd1...` to `a692967f8cd6...` (F1b's values; F3a recomputed
  them on `c5639b6` and found them again, 62 sources each). On each platform 2 sources changed:
  expo-notifications' native directory, whose store path now carries the patch hash, and the
  autolinking config. The patch touches no native file, but the runtime version moves, so the fix
  ships with a native build, never over the air, and any later edit of the patch moves it again.
- **The icon** (`apps/mobile/assets/notification-icon.png`): 1,167 bytes; 96 by 96, 8-bit RGBA, not
  interlaced; 1,268 fully opaque pixels (13.8 percent) and 376 partly transparent edge pixels; every
  pixel that is not transparent is white, and none lies within 4 px (1 dp at xxxhdpi) of the border;
  the glyph spans columns 8 to 82 and rows 19 to 76, inside the 80 px (20 dp) live area. The plugin
  scales it to the other densities at prebuild.
- **The bundle**: 3,709.12 KiB, gzip 743.02 KiB at `741ec86` in both environments, 36.72 KiB (gzip
  10.09 KiB) more than increment 15's 3,672.40 KiB and 732.93 KiB: the soak's two modules and the
  injector's core extracted for them. Neither the fix (tests) nor part 4 (documents) changes it.
- **Postgres connections in the API suite** (finding 9), measured by sampling `pg_stat_activity`
  every 100 ms against a PostgreSQL 18 cluster: the per-file peaks summed to 389 on main and 411 on
  this branch, the new `push-soak` file 29 and every other file as on main; the failing run's file
  order needed 117 connections on a 600-connection cluster, where the check's cluster allows 100.
  After the fix the same order peaks at 55, and the per-file peaks sum to 246.
- **What a soak costs staging**: inside a soak a tick every 5 minutes, 288 a day, each one
  `housekeeping` message, one tracker injection with its `notify` and push jobs to the test devices,
  and one `audit_log` row (one more for each redelivered step, review n2); a canary round every
  hour, 24 a day, of two test pushes, which holds up to two more Neon connections briefly. Outside a
  soak each tick reads one KV value and logs.

## Findings the spec did not have

1. **The API drops a permission sent without a token** (part 1; C2's text corrected in the same
   commit). The state is stored only on a token row (`apps/api/src/routes/devices.ts`), so a phone
   that turned notifications off and reported it without its token would keep a `granted` row and
   keep being sent to, which Android deprioritizes (R2 fact 20). The app registers its token in
   every permission state, and `notify` already skips a token that is `denied` or `undetermined`.
2. **A notification FCM displayed itself carries no app data when read back** (part 1; C7's text
   corrected). With the app in the background FCM shows the push and keeps its data in the tap
   intent only; expo rebuilds such a notification from its own extras, without
   `flightSubscriptionId`, and names it `expo-notifications://foreign_notifications?tag=...` after
   its tag, the collapse id. Dismissal therefore also matches the flight's collapse ids
   (`{kind}:{flightKey}`, one per kind), as identifiers or tags.
3. **Android 13 and later report `denied` before the first request** (part 1). Expo answers `denied`
   while the app's notifications are off, asked or not, so the app keeps its own record of having
   asked (the kv store's `pushPermissionRequested`): a state that is not granted reads as
   undetermined while the system can still ask and this installation has not, and as denied after
   one ask, when Settings offers the system settings.
4. **Token reads need guards** (part 1). On iOS a second concurrent `getDevicePushTokenAsync`
   rejects the first (R2 fact 21), some Simulator builds never answer (fact 60), and the token
   listener fires on every read (fact 23). So one registration runs at a time with at most one more
   queued, a read gives up after 10 s (`PUSH_TOKEN_TIMEOUT_MS`), the listener ignores the last token
   read or registered, and a rotation is debounced 1 s and registered as the listener carried it,
   without a read.
5. **The config loader cannot import `@planeahead/shared`** (part 2). Node loads `app.config.ts`'s
   imports and cannot resolve the package's extensionless TypeScript imports, so the plugin's
   `defaultChannel` is the literal `'flight_changes'`, which `app-config.test.ts` holds equal to
   `ANDROID_CHANNEL_IDS.flightChanges`.
6. **The notification icon is not a fingerprint source** (part 2): an in-place swap keeps the
   runtime version (see [Measurements](#measurements)).
7. **A strict overrides schema would break re-subscribes** (part 3a). Three API paths re-send a
   subscription's stored overrides to its tracker: the subscribe route's repair, the account merge
   and the subscriber reconciliation. Under the strict `NotificationOverridesSchema` a stored bag
   with `events` or any other key would be refused, and `isAbsentTrackerError` would take the
   refusal for a tracker that holds no flight. `storedOverrides` (`apps/api/src/lib/trackers.ts`)
   narrowed a stored bag to `muted` on all three paths. The review round (m1) went further: the
   subscribe body no longer accepts `notificationOverrides`, its `muted` having been stored and read
   by nothing, so `storedOverrides` and every relay are gone and none of the three paths re-sends a
   stored bag; the column gets an empty bag.
8. **"Two isolates at once" cannot be arranged on Workers** (part 3b). A Worker cannot choose the
   isolate an invocation runs in; Queues raises consumer concurrency only after a batch has finished
   (R1 F46), so two queued canary jobs would run one after the other; the push queue runs a batch's
   jobs one after another; and the second job would take its provider token from the isolate's
   module-scope cache. Departure 1 is what was built instead, and the review round found that it
   cannot show the pooling R1 U2 asks about (M1; departure 1 as corrected below).
9. **The API suite exhausted Postgres connections, on main as well** (after the merge). The full
   check of `741ec86` failed 23 API tests in 7 files, 22 of them "too many clients". The cause,
   measured as above: in the Workers pool a postgres.js client opened from a test file's own context
   (`createAdminRoutes` called with `app.fetch`, `handleNotifyBatch`, `handlePersistBatch`), or
   opened per helper call (`withDb`, `openDb`), keeps its sockets until the file's isolate ends; the
   `/admin` index renders its sections in `Promise.all`, up to 5 connections a render; and 17 files
   run in parallel. Every file but the new `push-soak` peaked as on main, and in the failing run's
   order main failed too (22 "too many clients" in 8 files on a 100-connection cluster): main had
   passed only by file order. The fix (`de4237c`, test code only) gives each path the file's own
   handle: the admin route helpers pass `db: () => db()` (`push-soak`, `admin-push`, `admin-inject`,
   `admin-access`), the notify drivers and `helpers/pipeline.ts` pass the file's handle,
   `persist.test.ts` uses `fileDb()` for its consumers and its seven per-test `openDb` calls, and a
   new `withFileDb` (`helpers/routes.ts`) gives `auth-magic-link` and `devices` one client per file.
   No production code changed: a client opened per invocation is closed by the runtime when the
   invocation ends and lingers only in the test pool. What remains: requests through
   `exports.default.fetch`, and the push consumer's liveness read, which builds its own client. Main
   shares the hazard, so the orchestrator carries the shared files' changes to increment 18 before
   its pull request, and so to main (done: increment 18 carried them, `09e99ac`). The fix lowers the
   connections but does not bound them (review m2). From the after-fix per-file peaks
   (auth-magic-link 25, caps.concurrency 20, flights.refresh 20, flights.subscribe 15, then 13 and
   less; the heaviest 17 sum to 194, all 85 to 246), lens B simulated 5,000 random file orders on
   17 workers: with each file holding its peak from its start, a median of 89, a 95th percentile of
   111 and 18 percent of orders over 100; with connections ramping to the peak, a median of 61, a
   99th percentile of 91, a maximum of 112 and 0.18 percent over 100. The truth sits between. CI's
   `postgres:18` service allows 100 too, but its few workers (3 in the same model) peak at 65, so
   the exposure is a local full check on an 18-core machine. The embedded cluster now runs with
   `max_connections=200` (`packages/db/test/embedded.ts`, F2b) and CI's service keeps 100. What
   remains: a real leak (a file opening a client per call) still climbs until it exhausts either,
   and every request through `exports.default.fetch` holds sockets until its file ends, so the
   margin shrinks as tests are added. The full checks of `b42b0a8` and `dfad10d` (API 1,172 and
   1,183 tests in 91 files) saw no "too many clients".
10. **A transient failure at an online sign-out could leave the token live** (part 1; for review).
    When the invalidation at sign-out is queued (a 408, 429 or 5xx, a network failure, or no answer
    within 5 s) and the session revoke that follows succeeds, the queued retry acts as a revoked
    session, gets 401 and is dropped, so the token row stays live for the signed-out user until APNs
    or FCM reports it dead or the next session's registration re-points it. On Android the token
    deletion makes FCM answer `UNREGISTERED` to the next send, which invalidates the row; on iOS
    whether APNs refuses the old token after `unregisterForRemoteNotifications` is not documented.
    Whether the server should invalidate an installation's tokens when its session is revoked is the
    review's question (`docs/security/threat-model.md`, section 1.8). The review answered it for an
    explicit sign-out only (A3, A4): `POST /v1/devices/current/invalidate` now also deletes the
    caller's session row in the same transaction, and when the call is queued the app clears its
    session on the phone without `/sign-out`, so the session lives on for the queued call to end it
    with the tokens. The same change closes a registration racing the sign-out, which A3's probe
    reached with no failure at all (a 5.5 s token read, or a foreground during the invalidation):
    one that lands after the invalidation gets 401, and the registrar posts nothing after a reset or
    while sign-out runs. An expired or merged session never touches tokens, which belong to the
    device. What remains: a queued call that is dropped (refused, three transient answers, or its
    cookies expired) leaves the row live until a provider reports the token dead or a registration
    re-points it, and on Android the owed token deletion (A1) is then the device's one stop.
11. **An offline sign-out's call waited for a cold launch or a sign-in** (part 1). The queued
    invalidation was retried at launch and before every registration, and a signed-out app registers
    nothing, so a phone that signed out offline and came back online kept its token live on the
    server until the app next started from cold or someone signed in. Android's token deletion is a
    network call and fails offline too (sign-out waits for it at most 5 s). Since the review round
    (A1), while signed out the root layout retries the queued call and an owed token deletion on
    every return to the foreground and every network return, the foreground handler presents
    nothing, and opening the app clears the tray. The true residual: until the app is next opened
    online, since no JavaScript runs in a killed, suspended or frozen app, nor in a process FCM
    starts to display a notification message; and after 30 days the queued call is dropped (its
    cookies have expired), after which only the device's deletion stops display. Android's deletion
    does not complete offline: in firebase-messaging 25.0.1 (javap, skeptic 1) `deleteToken` awaits
    `GmsRpc.deleteToken()` before `Store.deleteToken`, so offline the token survives on the phone
    and, by inference, at FCM, which displays every push still sent to it (R2 design 6 said the
    opposite; corrected there). iOS unregisters locally, offline too; whether it still shows what
    APNs holds is the device step under [Unverified](#unverified). Closing the tail of a phone never
    opened again (a background retry, a server rule treating unrefreshed registrations as stale, or
    a notice when signing out offline) is the owner's (`docs/open-decisions.md`, section 8).

## Departures from the spec, and clarifications

### Departures

1. **The canary from one invocation, not two isolates** (C9, part 3b; accepted by the orchestrator,
   then put back to the owner by the review round, M1 (d)). Each hourly canary sends its two test
   pushes at the same moment from ONE invocation, each through the push consumer's own batch handler
   as a batch of one with an empty token cache of its own, the first token request of each held at a
   gate until both arrive (at most 5 s, then a send asks alone), so both ask `PushAuth` in the same
   instant, as two cold isolates would. Why: finding 8. Lost: the queue hop on the first attempt
   (the sends' retries go through the push queue like any job's) and the cross-isolate case (R1
   U2). The build said the soak's counts still measure that case; the review found it false (M1).
   R1's canary mints two different tokens a minute apart from two isolates, so that a shared
   connection answers `TooManyProviderTokenUpdates`; this one sends one token twice. Ordinary
   rotation puts no two tokens on one connection inside 20 minutes while clocks agree (skeptic 1's
   probe S1); clock skew at a rotation, an `expire` after `ExpiredProviderToken`, a key change or a
   connection first used just before a rotation can, and none of them is pooling between accounts.
   So the soak measures edge 52x answers without an `apns-id` over its hours (R1 U1),
   `UnrelatedKeyIdInToken` on the sandbox host at staging's volume (about 14 APNs pushes an hour,
   one iPhone), and `TooManyProviderTokenUpdates` from `PushAuth`'s own rotation, which points at
   rotation, clock skew or a `PushAuth` fault before it points at the relay. The canary checks only
   that concurrent cold asks of `PushAuth` get one token; its audit row records how the gate opened
   and whether the tokens matched (M1 (c)). R1 U2 stays open until Cloudflare answers the ticket
   opened when the soak starts (owner action 7; [Unverified](#unverified)). The plan's two-isolate
   canary is not delivered: `docs/open-decisions.md`, section 8, recommends accepting the soak and
   Cloudflare's answer as the transport gate, and an own-mint canary (three tokens minted in
   sequence from the sandbox key, staging only, no retries) only if the owner wants evidence of
   connection reuse within the account, which on its own would not ship the relay.
2. **The flight in front gets no list entry and no sound either** (C6, part 1; accepted). The ruling
   suppresses the banner for the flight whose detail screen is open; the build suppresses list and
   sound too, as R2 design 12 words it: the screen already shows the change in place, and a silent
   entry in Notification Center for what the user is looking at would only need dismissing.
3. **The notification toggles are read from the sync feed** (C11, part 3a; accepted). The ruling
   names the toggles `GET /v1/me/preferences` returns; the app never calls that route, because the
   sync feed already carries the `notification_preferences` row (increment 15) with the same values.
   The screen reads them as it reads the display preferences, `effectiveNotificationPreferences`
   filling in the defaults and a tombstoned row reading as the defaults, as the route does since
   increment 15's ruling Q18.
4. **C2 and C7 as first written** (part 1; accepted, and the spec text corrected in the same
   commit). C2 first reported a denied or undetermined state without a token; it now registers the
   token in every state (finding 1). C7's dismissal now also matches the flight's collapse ids, as
   identifiers or tags (finding 2).
5. **The native smoke checks the entitlement, not the icon** (C8 and the acceptance's "with the new
   entitlement and icon", part 2; accepted). The iOS prebuild step requires the time-sensitive
   entitlement. The Android step gains no icon check: `entitlements.test.ts` runs the whole plugin
   chain and checks the manifest's icon, colour and channel metadata, and the close-out's Android
   build generates the real icon resources.

### Where the spec was silent

The app's push lifecycle (part 1):

- The pre-prompt's and Settings' copy are the builder's, for the owner to confirm (R2 owner action
  8; `docs/open-decisions.md`, section 8): the title "Alerts for your flights", a body naming
  delays, gate changes, cancellations and diversions, "Turn on notifications" and "Not now"; in
  Settings one line per state ("Notifications are on for this phone." and three more) and "Open
  system settings". The pre-prompt is a modal route that takes the add sheet's place (since O1,
  from an airport board or the route search it opens over that screen, which keeps the add's
  outcome); "Turn on" registers the answer at once rather than at the next foreground. Since N3
  "Open system settings" opens the app's notification settings (iOS `app-settings:notifications`;
  Android 8 and later the `APP_NOTIFICATION_SETTINGS` intent naming the package), and the app's
  settings page on an older Android or when the system refuses the link.
- An add queued offline counts as a success for the pre-prompt: both outcomes take the same branch
  in `add.tsx`, and no test drives the queued case on its own; a board's or a search's add counts
  the same way (`addBoardRow`'s `added`, O1).
- iOS `ephemeral` counts as granted, and an unknown status as denied.
- A revoked Apple credential signs out through the same path as the button, the invalidation first;
  an account deletion and `401 account_deleted` end in `forgetAccount` alone, since the tokens
  cascade with the user and no session is left to invalidate with. Since N1 `forgetAccount` clears
  the tray and resets the registrar too, on all three exits.
- The queued invalidation keeps the signed-out session's cookie map in SecureStore (through the Expo
  client's chunked adapter), so its retry acts as the signed-out user, never as the next session.
  One record, the first kept: while it waits every registration waits too, so a later session has
  registered nothing from this installation that a second record would need. `registerDevice`
  settles it before every registration, and it is retried at launch (since A1 also while signed
  out, on every return to the foreground and every network return). The call times out after 5 s;
  three 408, 429 or 5xx answers drop it, as do any other 4xx and cookies that have all expired; a
  network failure keeps it without counting; each drop is reported to Sentry
  (`device_invalidation_dropped`).
- Sign-out waits at most 5 s for a registration in flight and at most 5 s for Android's token
  deletion.
- The Live Activity push-to-start token's registration carries `appId` too. Sign-out's pause and the
  registrar's epoch (A3) do not hold it: harmless while Phase 1 sends no push-to-start, recorded
  under the Review round.
- Taps are taken in the root layout, so a cold start's tap is not lost behind the session gate, and
  routed by the `(app)` layout once a session exists; the same tap seen through the last response
  and the listener routes once.
- The flight is "in front" while its detail screen is focused, and its presented notifications are
  dismissed on that focus, once the flight key is loaded (since A6 also on every return to the
  foreground while it is focused).
- A push received in the foreground that names a flight starts a sync: that is how the screen
  refreshes in place.
- A registration the API kept without its token (`owned_by_another_user`) is a Sentry warning; no
  token at all is a breadcrumb, being common in builds without Firebase config.

The icon and the entitlement (part 2):

- The accent `color` is each variant's launcher background (`#1C4FD6` production, `#6D28D9` preview,
  `#B45309` development) until the owner picks one.
- `mode` stays in the plugin entry as a harmless fallback: expo-notifications writes it only where
  `aps-environment` is absent, and `ios.entitlements` always sets it.
- The glyph is the app icon's paper plane with a 1 dp gap along its fold, the one way an alpha
  channel can show the fold, centred in Material's 20 dp live area. The script is dependency-free;
  `--check` compares decoded pixels, not bytes, which another zlib build may deflate differently;
  turbo's mobile test inputs include it.

Settings, the overrides contract and the tray (part 3a):

- The tray: sign-out calls `dismissAllNotificationsAsync()` right after the invalidation step,
  started and never awaited (a rejection goes to Sentry), so the signed-out account's flights leave
  the lock screen and the shade (the builder's suggested follow-up, accepted). Since N1 and N7
  `forgetAccount` clears it (still never awaited) and sign-out clears it once more after the token
  deletion; since A1 opening the app signed out clears it too.
- The labels are "Flight alerts", "Delays", "Gate changes", "First gate assignment", "Cancellations"
  and "Diversions", for the owner to confirm. With "Flight alerts" off the five are greyed out and
  keep their values, as `notify` drops a user with push off before it reads the kinds.
- The persisted settings version stays 1: a state saved before increment 16 loads with the
  notification defaults.
- The queued-body reader parses the whole `PATCH` body (`PreferencesPatchSchema`), so the display
  overlay and the notification overlay each read their own part.
- The sync row's `notificationOverrides` stays a loose record, forward compatible; `storedOverrides`
  narrows what the API re-sends (finding 7). Since m1 the request no longer carries the field and
  the API re-sends nothing; the column, the sync row's field and the tracker RPC's optional
  `overrides` stay, unused, for Phase 2's per-flight settings to decide.

The soak (part 3b):

- The record is one JSON value in `CONFIG` KV (`push-soak:v1`, beside the kill switch): no
  migration, no new Durable Object, and a staging-only harness kept out of production's schema. It
  holds the canary's `push_tokens` row id, never the device token. KV is eventually consistent, so a
  stop can let one more tick through elsewhere; each step reads the record again and skips a stopped
  or replaced soak. That re-read goes through the same edge cache (up to 60 s), so it catches a
  stale tick only if the step waited longer in the queue; and a stop writes from its own read, which
  could overwrite a soak started elsewhere within that minute (review n5: one operator on staging,
  recorded only).
- Ticks plan their steps on the existing `housekeeping` queue: a 03:00 UTC tick can wait behind the
  nightly steps. The ids a step writes under are minted at the tick, so a redelivery replays them,
  and the tracker writes nothing for a replayed injection id. Since the review round the injection
  id is derived from the soak and the slot (n2), so a tick the cron delivers twice injects once, and
  the canary's job ids are minted when its step runs (n6), so its result page's window starts at
  the send; a canary step redelivered after its sends sends two more under new ids.
- The injected event is a departure delay of 30, 60, 90 and 120 minutes in turn: the policy pushes a
  delay at any distance from departure (a gate change only from six hours before it), it reads as
  routine on the test devices, and with values 30 minutes apart a real delay pushed meanwhile blocks
  at most one tick in four. For 15 minutes after each real delay intent the injected ones push
  nothing either, up to three ticks (the policy's interval between delay intents, review n3).
- Ticks act as `system`, their audit rows naming the soak and the operator who started it; start and
  stop act as `admin` with the Access identity, each audited `pending` before the KV write and
  settled after (`written` or `error`).
- The counts cover every push in the soak's window, not only the soak's own; the injections are
  counted by audit outcome (a 409 for a suspicion is `ignored`, a tick refused before the tracker
  call `refused`), the canaries by round and by each send's first answer.
- A failed canary round is not retried: a later copy would not be two sends at once, and the next is
  due within the hour.
- Production refuses start and stop with 403 and shows no form; `PUSH_SOAK_CRON` (`*/5 * * * *`) is
  declared in `env.staging.triggers` only; every step refuses in production as well.
- `injectSyntheticEvent` is extracted from the injector route unchanged in behaviour, with a new
  `refused` audit outcome; the hours run from 1 to 72 (the plan's soak is 24 to 48).

## Unverified

Nothing below can run without the Apple and Google accounts, the devices and the deployed
environments; each item names its steps, and its answer is recorded here. The runbook carries the
same steps in order (`docs/runbooks/first-deploy.md`: the soak and the exit test in step 19, the
channels and the icon in step 18).

- **The exit test** (plan section 8, row 16). On production, once step 17's deploy has the four push
  secrets, step 18's builds are installed (the TestFlight build on the iPhone, the internal-track
  build on an Android 13 or later phone with Google Play) and `PUSH_INJECT_ALLOWED_USER_IDS` holds
  the tester's user id (step 19):
  1. Sign in as the tester on both phones. On the iPhone add a flight that departs 6 to 47 hours
     from now, inside its live window, so the subscription is live-tracked (the free tier allows
     two). The pre-prompt follows the add: "Turn on notifications", then Allow. On the Android phone
     the flight arrives by sync; Settings > Notifications > "Turn on notifications", then Allow.
  2. In the Neon SQL editor on `main`:

     ```sql
     select kind, app_id, environment, permission, invalidated_at from push_tokens
     where user_id = '<tester user id>' order by registered_at desc;
     select fi.flight_key, fs.live_tracked from flight_subscriptions fs
     join flight_instances fi on fi.id = fs.flight_instance_id
     where fs.user_id = '<tester user id>';
     ```

     Pass: a live `apns` row (`app.planeahead.mobile`, `production`, `granted`), a live `fcm` row
     (`granted`), and the flight live-tracked.
  3. Both apps in the background, then `https://api.planeahead.app/admin/push/inject`: the flight
     key, a departure delay of 30 minutes, Inject. Pass: the answer lists one intent written; both
     phones show the push within a minute; a tap on each opens the app on that flight, and the
     notification leaves the tray.
  4. The cold-start tap: swipe both apps away (not Android's Force stop, after which FCM delivers
     nothing until the app is reopened, R2 fact 44), inject a 60-minute delay, tap the push. Pass:
     the app starts on the flight.
  5. The foreground: with the flight's detail screen open, inject 90 minutes. Pass: no banner, and
     the screen shows the new delay. From the home screen, inject 120 minutes. Pass: a banner.
  6. Sign out on both phones, online. Pass: the tray is empty; both rows of step 2 have
     `invalidated_at`; a new 30-minute injection answers one intent written, nothing arrives on
     either phone, and the newest notification has no delivery:

     ```sql
     select n.created_at, count(d.id) as deliveries from notifications n
     left join notification_deliveries d on d.notification_id = n.id
     where n.user_id = '<tester user id>' group by n.id order by n.created_at desc limit 1;
     ```
- **What a sign-out cannot recall** (C3's question; increment 14's ruling R1). The documents, as R2
  read them on 2026-09-30 (this build made no network call): Apple's
  `unregisterForRemoteNotifications()` page names logging out of an account associated with push
  notifications as a reason to call it, and says the app can always register again (R2 fact 61);
  Firebase's reference says `deleteToken()` deletes the token, a new one being generated the next
  time the app starts while auto-init is on (fact 62); APNs stores one notification per bundle id
  for an offline device until `apns-expiration` (fact 45) and FCM until the `ttl` (fact 42), both
  the job's `expiresAt`. Neither page, as R2 records them, says what becomes of a notification the
  provider accepted for a token before the app unregistered, so the documents do not answer C3's
  question and a device must. On the TestFlight iPhone, signed in, the app in the background:
  airplane mode on; inject a delay (APNs accepts and holds it; its delivery row reads `sent`); open
  the app and sign out, offline, so the call is queued and the app unregisters; send the app to the
  background (since A1 the app presents nothing in the foreground while signed out, and clears the
  tray whenever it opens, either of which would hide the answer); airplane mode off; wait two
  minutes. Record whether the held push is shown on the lock screen; then open the app, and record
  that the queued call landed on that opening, with no cold launch (`invalidated_at` set). On
  Android the same steps show only the offline case, since the token deletion itself needs the
  network (finding 11), and FCM holds nothing for a phone that is online.
- **The soak's 24 to 48 hours with clean counters** (C9; R1 U1; not U2, see the next item), on
  staging: runbook step 19's soak items. Record the hours, the ticks, the sends by channel, every
  row under "403 and 429 answers, by reason" and "Edge 52x answers without an apns-id" (a clean soak
  has none), the injections by outcome and the canary rounds with their sends' first answers. A
  `TooManyProviderTokenUpdates` row points at rotation, clock skew or a `PushAuth` fault before it
  points at the relay (departure 1). While the Postgres reads of the push consumer fail, an unsent
  retry can overwrite a 429's attempt log entry (increment 14's verification, Unverified), so a soak
  whose window had such failures can count fewer 429s than happened. The page leaves out what each
  canary round's audit row adds (M1 (c)); in the Neon SQL editor on `staging`, with the id the
  page's "Soak" column shows:

  ```sql
  select created_at, details->>'outcome' as outcome, details->>'gate' as gate,
    details->>'tokens_matched' as tokens_matched
  from audit_log where action = 'push.soak_canary' and details->>'soak_id' = '<soak id>'
  order by created_at;
  ```

  Record the rounds by `gate` and `tokens_matched`. Expected: `sent` rounds with `together` and
  `true`. `timeout` means the asks did not meet within 5 s and each send asked alone, so `false`
  there can be a legal rotation between the asks; `together` with `false` is a `PushAuth` fault;
  `unused` means no send asked, and a `refused` row (the token gone, invalidated or of another
  kind) has neither field.
- **R1 U2, how Cloudflare pools Worker subrequest connections.** Open: no canary built from one
  team's keys can provoke `UnrelatedKeyIdInToken`, and this one sends one token twice (departure 1,
  review M1), so a clean soak does not settle it. When the soak starts, open the Cloudflare support
  ticket (owner action 7, runbook step 19: how Worker subrequest connections to third-party origins
  are pooled, per zone, account or machine, or across customers) and record its answer and date
  here. Whether to add an own-mint canary as well is the owner's (`docs/open-decisions.md`,
  section 8).
- **Dismissal by tag of notifications FCM displayed** (C7, Android). On the Android phone, the app
  in the background, inject a departure delay and an origin gate change (a gate change counts from
  six hours before departure): FCM displays both. Open the app from its launcher icon, not from a
  notification, then the flight. Pass: both leave the shade. Then the same with the app in the
  foreground on the home screen (expo presents them, with their data): both leave when the flight
  opens.
- **R2 U1, the Android 13 prompt without a channel.** The app creates both channels at every start
  and again before asking (C4), so U1 no longer decides whether its prompt shows. On a fresh install
  on Android 13 or later, before any add: Settings > Apps > PlaneAhead > Notifications lists "Flight
  changes" and "Delays"; after the first add, "Turn on notifications" shows the system dialog.
  Settling U1 itself needs a build that asks before creating any channel, which this app never does.
- **R2 U3, the explicit prompt over provisional.** Moot while no build asks for provisional: the app
  reads a provisional state as a quiet grant and never prompts over it. If a later build adopts
  provisional, settle it with a development build that asks with `allowProvisional: true` and then
  again for alert and sound without it, and record whether the second request shows the prompt.
- **R2 U4, the cold-start tap with scene support on an iOS 27 SDK build.** The exit test's step 4
  proves the cold-start tap on the TestFlight build, which EAS builds with Xcode 26.6
  (`macos-tahoe-26.5-xcode-26.6`) and scene support on. U4 as R2 words it waits for an image with
  Xcode 27 (`docs/open-decisions.md`, section 5, row 7), and is then the same step.
- **R2 U7, Google Play services' proxy display.** On the Android phone, the app in the background,
  inject two departure delays of the same flight, 30 and then 60 minutes. Pass: the second replaces
  the first (one tag, the collapse id `{kind}:{flightKey}`), a long press names the "Delays"
  channel, and the status bar shows the plane in the variant's colour. Whether Play services proxied
  the display is not visible from here; comparing with `android.notification.proxy: DENY` needs a
  sender change, which is not built.
- **R2 U8, the small icon.** Moot since the plugin names `icon` (C5). Check instead, in the
  background case (FCM displays) and the foreground case (expo displays), that the status bar and
  the shade show the white plane tinted with the variant's colour, never a filled square or the
  launcher icon.
- **R2 U9, the FCM token before the permission.** Install the development build fresh (with
  `GOOGLE_SERVICES_JSON` naming the development app's file) on an Android 13 or later emulator with
  Google Play, open it against staging, and before any add run in the Neon SQL editor on `staging`:

  ```sql
  select kind, permission, registered_at from push_tokens
  where kind = 'fcm' order by registered_at desc limit 3;
  ```

  Pass: a row from the first launch with the permission `undetermined`. No row means the token waits
  for the permission; the device row is written either way.
- **R2 U10, the time-sensitive entitlement.** At the first `eas build` of each profile the build
  log's capability sync lists Time Sensitive Notifications, and the App ID shows it in Certificates,
  Identifiers and Profiles; on the built app,
  `codesign -d --entitlements - --xml Payload/PlaneAhead.app` (from the unzipped `.ipa`) shows
  `com.apple.developer.usernotifications.time-sensitive` true. Then, on the iPhone with a Focus on
  that does not allow PlaneAhead, inject a delay inside the hour before the flight's departure,
  where the intent is time-sensitive (increment 15's N5). Pass: it breaks through, marked Time
  Sensitive.
- **The Android channels, the copy, the accent colour and the icon** are the owner's to confirm
  (`docs/open-decisions.md`, section 8); the channels before the first Android build that reaches a
  tester, since a channel's importance cannot change once created (runbook step 18).

## Review round

Two Opus 5.5 lenses read the build at `422bfe3` (`git diff 58d7774 422bfe3`) on 2026-10-01, each in
its own checkout, with probes. Lens A read the mobile client's push lifecycle (C1 to C8, C11 and
C13's app side): two majors (A1, A2), four minors (A3 to A6) and seven nits (N1 to N7). Lens B read
the soak, the API changes and their tests: one major (M1), three minors (m1 to m3) and six nits (n1
to n6). Neither found a blocker. The orchestrator added O1 (after increment 18 merged in, the
pre-prompt was offered only from the add sheet) and O2 (C3's document check was never read from
Apple's and Google's pages). Two skeptics then checked each major, one through the code path with
its own probes, one on severity and remedy. Every finding was accepted as a ruling of the same
name, applied on the branch with main merged in (`b42b0a8`) in four code parts: F1a (`df11589`: A1,
the device half of A3 and A4, N1, N2, N6, N7), F1b (`363142a`, merged into F1a as `1f38465`: A2,
A6, N3 to N5, O1), F2a (`47c10f5`: the server half of A3 and A4, A5, n2, n4, n6, M1 (c), and
`soak.ts`'s part of M1 (a)) and F2b (`89ba245`, the orchestrator's after the F2 agents stalled: m1,
m2, m3); F2a and F2b merged as `dfad10d`. The documents' rulings (M1 (a), (b) and (d), A1 (4) and
(5), n1, n3, n5, O2 and the corrections above) are F3a's (this file, the spec's status line and
increment 14's verification) and F3b's (the architecture, the threat model, R2, the runbook and
open decisions). Names: A1 or M1 is a review finding and its ruling, C1 a ruling of the spec, F1a a
part of this round.

Both lenses also listed what they found sound. Lens A: C1's permission reads on both platforms
(provisional a quiet grant, ephemeral granted, Android 13's `denied` before the first request read
as expo 57's native code reports it, Android 12 and lower answering `canAskAgain` false when
disabled); C2's one run plus one queued, the echo ignored in either arrival order, the debounce and
`appId` validated; the channels at module scope and before every request; the handler installed
once and answering synchronously; C7's taps (an FCM-displayed tap carries the whole data map, with
`google.message_id` as its identifier) and dismissal by tag matching expo's foreign identifier; the
icon, the plugin's metadata and the entitlement in every variant; both fingerprints, which it
recomputed (`5068d917e263`, `3cb004ba8dd1`, 62 sources each); C11 read from the sync feed and queued
through the outbox; C13. Lens B: the staging-only guards (403 and no form in production, every step
refusing there, the cron only in `env.staging.triggers`); the audit order (`pending` before the KV
write, the tracker call or the sends); the housekeeping routing, batch size and concurrency 1; the
counts' SQL against the attempt log's writer, every cell escaped; C12's writers and relays as
built; the canary's Neon cost through Hyperdrive; runbook step 18's references and step 19's SQL
columns; threat model 3.3 against the code.

### The skeptics

**A1, skeptic 1 (code path and platform facts): real, major; the window wider than stated.** The
queued call was settled only at the root layout's module load and inside `registerDevice`, so a
warm return never settled it; and the app has no background task, so a process FCM starts for a
message runs no JavaScript. Its javap of firebase-messaging 25.0.1 showed `deleteToken` awaiting
`GmsRpc.deleteToken()` before `Store.deleteToken` in one `try` (play-services-cloud-messaging
17.2.0's `Rpc` failing a request after 30 s), so offline the token survives on the phone; that FCM
keeps it too is an inference, consistent with finding 11, and R2 design 6 was wrong. Cookies past
the session's 30 days make the queued call drop as `refused`, after which a cold launch no longer
helps. Its probe through the real root layout and `signOut`: online again while signed out, then
background and active twice, sent no invalidation; a leaked push in the foreground was shown in
full; only a cold launch sent the call.

**A1 with A4, skeptic 2 (severity and remedy): real, minor; fix the cheap part now.** A1 needs a
sign-out with no working network (on a slow link the deletion keeps running and lands), sign-out
is rare and deliberate, the alerts name flights, gates and times but no person, and most likely
the person who signed out still holds the phone. App-side triggers close the warm reopen and a
network return in the foreground; the disclosure case (a phone handed on and never opened) no
app-side trigger can close, so that tail is the owner's. Two corrections to the remedy. Its first
probe: retrying the deletion inside `settle()`, which runs after the token read, registers a dead
token for the next session; the retry belongs before the read. Its second applied A4's route
change as a mutant: alone it does not answer the orchestrator's question, since when `/sign-out`
revokes the session before the invalidation commits, the replay gets 401 with the row live, so the
app must not call `/sign-out` while the call is queued. Better Auth 1.7.5's sign-out answers 200
when the session is already gone, so the online path stays safe.

**A2, skeptic 1 (the code): real, major, in practice Android only.** The wrapper keeps a rejected
native promise for the JavaScript runtime's life on both platforms (probes: one native call and
four rejections; after a success the cache clears, and a later failure then sticks; a cold start
asks again). iOS is not materially exposed: its native promise settles only on APNs' answer, so
offline a read hangs, the app gives up at 10 s, and later reads share the pending promise until it
resolves. Android's `blockingGetToken` fetches over the network when no token is stored or it is
stale (7 days, or a changed `versionCode`, so every Play update) and throws on failure with no
fallback to the stored token. Through the real registrar, A2's C1 sequence never sent `granted`.

**A2, skeptic 2 (severity and remedy): real, minor; fix it now anyway, with a pnpm patch.** Two
background refreshes (FCM's eager auto-init at every process start; expo's service started on
`MY_PACKAGE_REPLACED` and `BOOT_COMPLETED`) narrow the trigger to an idle install cold-launched
with no route to FCM, or an FCM fetch failing while the API answers. The common case loses nothing,
the window is one process, and iOS heals itself. Fixed now because it silently disables C2's retry,
the fix is four lines, and A1's deletion retry makes the next read depend on the network. It made
the patch offline, measured both fingerprints moving (the store path only, no native code) and
`ERR_PNPM_UNUSED_PATCH` refusing an install the patch no longer matches, hence the exact pin.

**M1, skeptic 1 (code path): real, major for the transport gate's evidence, no user-facing
defect.** Two isolates through the real `PushAuth`, `durableCredentialSource` and APNs transport
onto one modelled connection: with clocks agreeing, sends every second across the 30-minute
boundary switched tokens once and got no 429 (S1); an isolate 40 ms behind got one 429 (S2); one
`ExpiredProviderToken` five minutes in gave the other isolate 429s for ten minutes (S3); the real
canary was served, not minted, mid-window, minted once at the boundary, and with its gate timed out
across the boundary sent one token then the next while its row read `sent`, recording neither
(S4). So the 429 count cannot measure cross-isolate pooling, while the runbook asked Cloudflare only
on edge 52x.

**M1, skeptic 2 (severity and remedy): real, major for the record and the gate, not a blocker.** No
runtime path is wrong, and the error the canary cannot see is one `PushAuth` is built not to cause;
a 429 costs a 60 s retry. One correction: a connection first used less than 20 minutes before a
rotation and reused after it carries two tokens inside 20 minutes, pooled or not, so the ordinary
429 count can catch rotation on young connections (whether APNs counts a connection's first token
is not documented). The relay decision rests on `UnrelatedKeyIdInToken` and edge 52x, and staging's
volume (about 14 APNs pushes an hour) says little about pooling across accounts. Its prototype
canary minting its own tokens from the sandbox key, never `PushAuth`'s, passed the soak's tests in
its own worktree; the recommendation makes it three tokens in sequence with no retries, and it is
the owner's option, not built.

### By ruling

- **A1 (major; skeptics: major, then minor): an offline sign-out must not leave the old account's
  alerts running longer than the device can stop them.** Finding: after a sign-out made offline
  nothing retried the queued invalidation, or Android's failed token deletion, while the app ran
  signed out, and FCM displayed every alert once the phone was online, lock screen included, until
  a cold launch or a sign-in. Changed, part F1a: `useSignedOutWork` (`src/lib/session.ts`), in the
  root layout, retries the queued call and an owed deletion (`retrySignOutWork`,
  `src/lib/device-invalidation.ts`, one of each at a time) on every `AppState` `active` and every
  network return (expo-network's `isInternetReachable` true) while the session is known to be null,
  and clears the tray whenever the app opens signed out; with a session, a network return registers
  only while a call is queued (registration settles it first). The deletion is recorded before it
  starts (kv `planeahead.push_token_deletion_owed`) and forgotten once it succeeds; it is retried at
  launch and on the triggers above, and at the next session the registrar's new `beforeRead` runs
  it, or joins one running for at most 10 s, BEFORE the token read, never inside `settle()`, then
  forgets the record whatever the outcome. The foreground handler presents nothing while signed
  out. The documents state the true residual (finding 11, threat model 1.8, R2's note on design 6),
  and the tail of a phone never opened again is the owner's (`docs/open-decisions.md`, section 8: a
  background retry with `expo-background-task`, a server rule treating unrefreshed registrations as
  stale, or a notice when signing out offline). Proven: `sign-out-lifecycle.test.tsx` (9, new: the
  app's own queue, token deletion, registrar, `signOut` and session hooks over an Android-like fake
  whose unregister is now scriptable): a network return sends the queued call and the owed deletion
  once each, then nothing; a foreground does the same and clears the tray; a launch tries both; the
  handler presents nothing while the session is known to be null, and as before while it loads; the
  next session deletes the owed token, then reads one, then settles the call and registers; a
  deletion that fails again is forgotten and the new session's token stays; signed in with a call
  queued, a network return registers after the call. `sign-out.test.ts` (27, was 18): a deletion
  failing offline stays owed and is reported; owed from before it starts until it succeeds; one at
  a time; before a read, nothing owed runs nothing and one still running is waited for at most
  10 s.
  `push-registration.test.tsx` (17, was 15): a run settles an owed deletion before it reads. A
  retry placed inside `settle()` is among F1a's 35 mutants, all killed.
- **A2 (major; skeptics: major on Android, then minor; both: fix it now): a failed token read must
  not poison later reads.** Finding: expo-notifications 57.0.20's `getDevicePushTokenAsync` keeps a
  rejected native promise for the life of the JavaScript runtime, so one failed read fails every
  later one in the process; on Android a read made offline with no stored token, or a stale one,
  is enough, and after it a permission granted at the pre-prompt does not reach the server until
  the process ends. Changed, part F1b: the repository's first dependency patch,
  `patches/expo-notifications@57.0.20.patch`, byte for byte skeptic 2's, applied by pnpm's
  `patchedDependencies` (`pnpm-workspace.yaml`, which pnpm resolves against the workspace root): in
  `build/getDevicePushTokenAsync.js` (what Metro bundles) and `src/getDevicePushTokenAsync.ts`
  (kept in step for source maps) the cached promise is cleared in a `finally`, only if it is still
  the one this call made, so concurrent reads still share one native call. The catalog pins
  `expo-notifications: 57.0.20` exactly, with a comment: pnpm refuses an install whose patch matches
  no installed version (`ERR_PNPM_UNUSED_PATCH`), so a bump fails loudly until the patch is dropped
  or redone. The lockfile carries the patch hash; the fingerprints moved (Measurements). Proven:
  `push-token-read.test.ts` (5, new) loads the REAL wrapper through the package's index, as the app
  imports it, with only the native module faked: a read that rejected is asked again; concurrent
  reads share one native call whether it resolves or rejects, and the next read asks again; the
  app's `readDevicePushToken` gives `unavailable`, then the token; and C1 through the real registrar
  (a failed launch read, then the grant: the next run posts the token with `granted`). Against the
  unpatched 57.0.20, 4 of the 5 fail; the one that passes is concurrent reads that resolve, which
  the bug does not touch (F3a's run, under What ran). The shared fake answers every call afresh, as
  a comment there now says, so only this file can see the bug. The upstream report and pull request
  text, not filed, are [below](#the-upstream-report-for-expo-notifications-not-filed).
- **M1 (major; both skeptics: real, major, not a blocker): the record must not close R1 U2.**
  Finding: R1 U2's canary mints two different tokens a minute apart from two isolates, so that a
  shared connection answers `TooManyProviderTokenUpdates`; the built canary sends one `PushAuth`
  token twice (its test asserts one bearer on both requests), ordinary rotation cannot produce that
  429 while clocks agree, and yet `soak.ts`, `docs/architecture.md` section 11, this file's
  departure 1 and Unverified soak line as the build wrote them, and increment 14's verification
  said a clean soak settles U2, while the runbook asked Cloudflare only on edge 52x. Changed: (a)
  the wording, in F2a (`soak.ts`'s header), F3a (departure 1, finding 8, the soak item and a new U2
  item under Unverified, increment 14's "the proof of pooling") and F3b (`docs/architecture.md`
  section 11), the orchestrator's decisions note too: the soak measures edge 52x without an
  `apns-id` (U1), `UnrelatedKeyIdInToken` on the sandbox host at staging's volume, and
  `TooManyProviderTokenUpdates` from `PushAuth`'s own rotation; the canary checks only that
  concurrent cold asks get one token; U2 stays open. (b) Runbook step 19 (F3b): the Cloudflare
  ticket opened when the soak starts, its answer recorded under U2, and the pass rule kept with the
  line on a `TooManyProviderTokenUpdates` row. (c) F2a: the canary's audit row records `gate`
  (`together`, `timeout`, or `unused` when no send asked) and `tokens_matched` (a boolean, null
  unless both sends asked, never a token), read by SQL (the soak item under Unverified), not shown
  on the page. (d) Departure 1 back to the owner, with the recommendation (`docs/open-decisions.md`,
  section 8). Proven, (c): `push-soak.test.ts` records a gate opened by its timeout and still
  whether the tokens matched, records how a gate opened when a send asks alone, and compares only
  each send's first token; three mutants (nothing recorded, always matched, a timeout recorded as
  `together`) each failed it.
- **A3 and A4 (minor; one server change, explicit sign-out only): the invalidation ends the
  caller's session.** Findings: a registration in flight, or started by a foreground, during
  sign-out could land after the invalidation with the signed-out session's cookies and re-point the
  row (A3; lens A's probe: a 5.5 s token read, or a foreground 200 ms into the invalidation); a
  transient failure of the invalidation at an online sign-out, followed by a successful revoke, left
  the row live (the orchestrator's question, finding 10), and an offline sign-out left its session
  valid for 30 days (A4). Changed, part F2a: `POST /v1/devices/current/invalidate` deletes the
  caller's session row (that one only, and only for a session caller) in the same transaction as
  the tokens, tokens first as the merge orders them, and its log line carries `session_ended`.
  Part F1a: the registrar has an epoch (`reset()` bumps it; a run posts only if no reset came
  since it began) and a counted pause (`register()` refuses and the token listener is ignored while
  paused; sign-out pauses, and resumes in a `finally`); a queued invalidation clears the session on
  the phone and sends no `/sign-out` (`forgetAccount(store, { endSession: false })`, through a
  per-call `customFetchImpl`), so the replay ends the session with its tokens; online,
  `authClient.signOut()` stays for the local half. An expired or merged session never touches
  tokens. Proven: `devices.test.ts` (25): only the caller's session ends; a sign-out with the same
  cookie still answers 200 and a registration after both gets 401; a replay after a revoke answers
  401 and leaves the row live (why a queued call skips `/sign-out`); both or neither commit; the
  three tests that reused a session after invalidating it updated. `sign-out-lifecycle.test.tsx`:
  lens A's two orderings post nothing after the invalidation. `forget-account.test.ts` (3, new, on
  the real Better Auth Expo client): a queued sign-out clears the session on the phone and sends
  nothing carrying it; otherwise `/sign-out` goes. Mutants (F2a: the delete removed, every session
  of the user deleted, the delete outside the transaction; F1a: no epoch check, no pause in
  `register()` or the listener, a reset instead of a pause, a pause never released, a queued call
  still signing out) were all killed.
- **A5 (minor): test pushes name the app's channel.** The admin test push, and so the soak's
  canary, named `test_push`, which the app never creates, so a test push shown in the foreground
  made a permanent third Android channel. Changed, part F2a: `TEST_PUSH_CHANNEL_ID` is
  `ANDROID_CHANNEL_IDS.flightChanges` (`routes/admin-push.ts`), the stale comment gone. Proven:
  `admin-push.test.ts` (13); the old channel restored fails it.
- **A6 (minor): returning to a flight's screen dismisses its notifications.** Changed, part F1b:
  `useFlightInFront` dismisses on `AppState` `active` too, while the screen is focused. Proven:
  `push-handling.test.tsx` (17, one new); without it the test fails.
- **m1 (minor): one per-flight mute.** Finding: `notify` drops a muted subscription by the
  `flight_subscriptions.muted` column, which the body's top-level `muted` writes; C12's narrowed
  `notificationOverrides.muted` was stored beside it, relayed to the tracker and read by nothing,
  so a client using it still got every push. Changed, part F2b: `notificationOverrides` left
  `SubscriptionPrefsSchema` (`packages/shared/src/api.ts`), so the strict body refuses it, and
  `NotificationOverridesSchema`'s comment says so (`rpc.ts`); `storedOverrides` and every relay are
  gone (the subscribe route and its repair, the merge, the subscriber reconciliation); the column
  gets an empty bag; the tracker RPC's optional `overrides` and the sync row's loose field stay,
  unused, for Phase 2's per-flight settings to decide. Proven (`flights.subscribe.test.ts`, 25, two
  rewritten): `{ muted: true }`, `{}` and an `events` bag each answer 400 and write nothing; the
  top-level `muted` reaches the column and the tracker; a repair relays no stored bag whatever the
  column holds. That `notify` sends nothing to a subscription whose column is set is increment 15's
  `notify.test.ts` (it reaches live subscriptions less the muted). Mutants: the schema accepting the
  field, the repair relaying a bag; both killed.
- **m2 (minor): the test cluster's connections.** Changed, part F2b: the embedded cluster runs with
  `max_connections=200`, its comment naming why; finding 9 states the residual with lens B's
  numbers. Proven: the whole API suite, 91 files, 1,183 passed and 1 skipped, no "too many clients"
  (F2b's run, and the full check of `dfad10d`).
- **m3 (minor): the injector's two unpinned refusals.** Changed, part F2b, tests only: in
  `admin-inject.test.ts` (9, one new) the route answers 504 when the tracker's `getState` misses its
  deadline and 409 when it holds no running flight, neither reaching `injectPolicyEvent`; in
  `push-soak.test.ts` (20, one new) a soak injection is recorded refused, `not_running`. Mutants:
  lens B's `REFUSAL_STATUS` change (504 to 500, 409 to 400) and `not_running` reported as `absent`;
  both killed.
- **n1, n3, n5 (wording).** n1: runbook step 19 (F3b) asks for a flight still before arrival at the
  soak's end, since after out an injected delay pushes as an arrival delay. n3: an injected delay
  also pushes nothing for 15 minutes after each real delay intent, up to three ticks (`soak.ts`, and
  the soak's silent choices above). n5: the decisions note's "catches" corrected, since the re-read
  can be as stale as the tick (above, and the orchestrator's note).
- **n2, n4, n6 (the soak), part F2a.** n2: the injection id is derived from SHA-256 of the soak id
  and the slot, with UUIDv7's version and variant bits and the slot's instant, so a redelivered or
  duplicated tick injects once per slot (a message queued before the change still parses, its ids
  dropped); the page counts "Rows", one per run, no longer "one per tick". n4: `readPushSoak` reads
  text and parses it in a `try`, so a value that is not JSON reads as no soak. n6: the canary's job
  ids are minted when its step runs. Proven (`push-soak.test.ts`): a slot's injection id is derived
  from the soak and the slot alone; a record that is not JSON reads as none and the page, a start
  and a tick still work; the canary's ids are minted at its step, not the tick. Their six mutants
  (a fresh id per run, the old behaviour, `kv.get` as JSON, no `try`, the tick's instant, a shared
  generator) each failed a test.
- **N1 to N7 (nits).** N1, part F1a: `forgetAccount` dismisses every presented notification
  (never awaited) and resets the registrar, so sign-out, account deletion and `401 account_deleted`
  all clear the tray (`forget-account.test.ts`). N2, F1a: sign-out drops a tap waiting for a session
  and the last response (`sign-out.test.ts`). N3, F1b: "Open system settings" opens the app's
  notification settings, falling back to its settings page (`openNotificationSettings`,
  `src/lib/push.ts`; `push-permission.test.ts` and `settings-push.test.tsx`). N4, F1b: one `try` per
  channel. N5, F1b: the "asked" record is written after the request, and the pre-prompt's offer
  only once it is shown, read again after the permission so two adds finishing together show it
  once. N6, F1a: Sign out has a re-entry guard that Cancel releases (`settings-sign-out.test.tsx`,
  2, new). N7, F1a: the deletion starts right after the invalidation, beside `forgetAccount`, and
  the tray is cleared once more after a bounded wait for it (`sign-out.test.ts`). Each has a
  mutant among its part's, killed.
- **O1 (minor): the pre-prompt from every entry point.** Changed, part F1b: the first add that
  succeeds (added, or queued until PlaneAhead can be reached) offers the pre-prompt from the add
  sheet, an airport board and the route search, through `addBoardRow`'s `added` for the last two,
  over that screen. Proven: `add-flight.test.tsx` (75), `airport-board.test.tsx` (31) and
  `route-search.test.tsx` (19), a test per entry point; two O1 mutants (no offer from a row; an
  offer on any outcome) each failed both screens' tests.
- **O2: recorded only.** C3's document check is the device step under Unverified ("What a sign-out
  cannot recall"), from R2 facts 61 and 62 as part 4 recorded it.
- **Recorded, not fixed in this round** (F1a's residuals and the soak's). The Live Activity
  push-to-start registration (`src/lib/live-activity/tokens.ts`) is held by neither sign-out's
  pause nor the registrar's epoch: harmless while Phase 1 sends no push-to-start, not once Phase 2
  does. A tap on a leaked notification made while already signed out is routed in the next session
  (one sync, then home); N2 drops only what waits at sign-out. A second sign-out while an older
  call is still queued queues nothing (one record, the first kept) and sends no `/sign-out`, so that
  session lasts its 30 days, with no cookie on the phone and no token under it, since registration
  waited on the older call throughout (it takes a partly failing server). The signed-out retries
  run only while the app is open (the tail is the owner's, A1 (5)). `src/lib/services.ts` and
  `src/lib/push-registration.ts` import each other, with no use at module scope. A canary step
  redelivered after its sends sends two more test pushes under new ids (staging only, and only if
  the invocation dies mid-step). The KV stop race (n5) stays as worded above.

### Where the rulings were silent

Part F1a (the sign-out lifecycle):

- The owed deletion lives beside the queued call in `src/lib/device-invalidation.ts`, its record in
  the kv store (`planeahead.push_token_deletion_owed`, no secret in it); the launch retries it too.
- A run waits at most 10 s for a deletion still running (`TOKEN_DELETION_WAIT_MS`) before it reads.
- Opening the app signed out clears the tray but retries nothing: the launch and the sign-out have
  just tried.
- A network return is expo-network's `isInternetReachable === true`.
- Pauses are counted, and sign-out releases its own in a `finally`.
- A queued sign-out answers `/sign-out` on the phone through a per-call `customFetchImpl`, after the
  Expo plugin has cleared the stored cookies, so nothing carrying the session leaves.

Part F1b (the token read and the screens):

- The patch lives at the repository root (`patches/`), where pnpm resolves `patchedDependencies`
  for the workspace, byte for byte skeptic 2's, applied offline.
- N3's iOS link is `app-settings:notifications` (iOS 15.4 and later; the app's minimum is 16.4);
  Android's intent needs Android 8; an older Android or a refused link opens the app's settings.
- N5's offer is read again after the permission read, so two adds finishing at once show the
  pre-prompt once; O1's success is an add made or queued.

Part F2a (the API):

- The session delete runs only for a session caller (`user.kind === 'session'`), after the tokens,
  and the log line `push_tokens_invalidated` carries `session_ended`. A second invalidation with
  the same cookie now answers 401, the session being gone, and a refused call (400) ends nothing;
  so a queued call whose first attempt committed with its answer lost is dropped on a 401 and
  reported, its tokens already invalidated.
- n2's id: SHA-256 of `push_soak:{soak}:{slot}`, given UUIDv7's version and variant bits and the
  slot's instant; a message queued before the change still parses, its ids dropped.
- The canary's `gate` and `tokens_matched` are in the audit row only, not on the page; a refused
  canary row carries no `job_ids`.

Part F2b (the overrides contract, the test cluster, the injector's refusals):

- The column gets an empty bag; the tracker RPC's optional `overrides` stays (a call naming it is
  accepted, stored and never read), as does the sync row's loose field.
- 200 connections, not lens B's 300: twice CI's service and above the simulated 95th percentile of
  111; CI's service keeps 100.

### Departures from the rulings

- **m1's "a test that a muted subscription gets no push"** is proven in two halves rather than one
  test: `flights.subscribe.test.ts` shows the top-level `muted` reaching the column, and increment
  15's `notify.test.ts` that `notify` skips a subscription whose column is set. No test drives one
  muted subscribe through `notify` to an empty push queue.

### What ran

The same machine as the build, each test file alone (`pnpm exec jest <file>` from `apps/mobile`,
`pnpm exec vitest run <file>` from `apps/api`), then typecheck, lint and `prettier --check` in each
package a part touched. The code parts are recorded from their reports and logs; F3a's rows are its
own runs on `c5639b6`.

| Part | Check | Result |
| --- | --- | --- |
| F1a | The suites it added or changed | passed: sign-out 27 (was 18), sign-out-lifecycle 9 (new), push-registration 17 (was 15), forget-account 3 (new), settings-sign-out 2 (new); typecheck and lint clean |
| F1a | Mutants, each reverted after its run | 35 of 35 killed, the deletion retried inside `settle()` among them |
| F1b | The suites it added or changed, then those its modules reach | passed: push-token-read 5 (new), push-permission 30 (was 20), push-handling 17, add-flight 75, airport-board 31, route-search 19, settings-push 4, and among others push-registration, sign-out, settings, sign-in, detail and house-style; typecheck and lint clean |
| F1b | Mutants | 14 of 14 killed: A2 2 (the unpatched wrapper: 4 of the 5 new tests fail; the de-duplication dropped), A6 1, N3 3, N4 1, N5 4, the offer's re-check 1, O1 2 |
| F1b | The fingerprints, preview environment (the command as in part 4's row above) | iOS `5068d917e263...` to `d27e470b75f2...`, Android `3cb004ba8dd1...` to `a692967f8cd6...`, 62 sources each |
| F1a and F1b | The merged app (`1f38465`): typecheck, lint and every suite | clean; 48 suites, 888 tests |
| F2a | devices, admin-push and push-soak, then the suites the soak reaches; typecheck (with the migration hash) and lint | passed: 25, 13 and 19; dispatch 34, crons 36, push-consumer 20; clean |
| F2a | Mutants | 13 runs, each failing a test: A4 3 (no delete, every session of the user, outside the transaction), A5 1, n2 2, n4 2, n6 2, M1 (c) 3 |
| F2b | flights.subscribe, admin-inject and push-soak, then the whole API suite (`pnpm exec vitest run`, apps/api, no filter) | passed: 25, 9 and 20; 91 files, 1,183 passed and 1 skipped, no "too many clients" |
| F2b | The shared and db suites; typecheck and lint in shared, db, api and mobile | passed: shared 822, db 203; clean |
| F2b | Mutants | 4 of 4 killed: the schema accepting the field, the repair relaying a bag, lens B's `REFUSAL_STATUS` change, `not_running` reported as `absent` |
| Close-out | The full checks of `b42b0a8` and `dfad10d`; the native smoke of `dfad10d` on both platforms | passed; passed after `c5639b6` (below) |
| F3a | `push-token-read.test.ts` against the store's unpatched expo-notifications 57.0.20 (a scratch Jest config, outside the repository, mapping the package to that copy), then as committed | 4 failed and 1 passed (concurrent reads that resolve); then 5 of 5 passed |
| F3a | The upstream issue's repro (below), alone, against the unpatched copy and then the patched one | failed (the second call rejected with the first error); then passed |
| F3a | Both fingerprints (part 4's command), compared with F1b's dumps from before the patch | iOS `d27e470b75f2...`, Android `a692967f8cd6...`, 62 sources each; 2 sources moved on each platform (expo-notifications' native directory, the autolinking config) |
| F3a | `pnpm exec vitest run tools/workflows/native-smoke.test.js` (repository root), the close-out's changed test | passed: 58 (57 at part 2, one new) |
| F3a | The em dash scans (`pnpm exec vitest run test/style.test.ts`, packages/shared; `pnpm exec jest __tests__/house-style.test.ts`, apps/mobile), which do not read these files, so also a grep of the three it changed; `prettier --check` on them | passed: 71 and 199; no em or en dash; the three skipped by `.prettierignore`, wrapped at 100 columns by hand |

### The full checks and the native smoke

The orchestrator's full check (turbo's typecheck, lint and tests in every package, Prettier, the
toolchain and exit guards, the mobile migrations guard, the migration hash, actionlint, shellcheck
and both wrangler dry runs) ran three times on this branch:

- **`741ec86`** (parts 1, 2, 3b and 3a; 2026-10-01): failed only the API suite, 23 of 1,066 tests in
  7 of 85 files, 22 of them "too many clients" (finding 9); the rest passed (What ran, above).
- **`b42b0a8`** (`422bfe3` with main at `09e99ac`, increment 18, merged in; 2026-10-01): every step
  passed. turbo 14 of 14 tasks in 164 s, none cached: API 1,172 passed and 1 skipped in 91 files,
  no "too many clients"; shared 822 in 29 files; db 203 in 12; mobile 837 in 44 suites; tools 103
  in 7. The merge had eight conflicts, each resolved by keeping both sides: `admin.ts` (the soak's
  and the boards' sections), `persist.test.ts` (an import), the app's `(app)/_layout.tsx` (both
  modals), `add.tsx` and `flight/[id].tsx` (header comments), `docs/architecture.md` (main's
  request table plus the inject and soak rows), `docs/open-decisions.md` and the runbook (status
  paragraphs, and the runbook's step 19 exit test before main's step 20).
- **`dfad10d`** (every fix part merged; 2026-10-05): every step passed. turbo 14 of 14 tasks in
  177 s, none cached: API 1,183 passed and 1 skipped in 91 files, no "too many clients"; shared 822
  in 29 files; db 203 in 12; mobile 888 in 48 suites; tools 103 in 7; Prettier, the guards, the
  migration hash, actionlint, shellcheck and both dry runs.

The native smoke (`scripts/native-smoke.sh`, every step) ran locally on `dfad10d` on 2026-10-05,
in a detached worktree of its own. iOS ran on a simulator created for the run (iPhone 17 Pro, iOS
26.5, Xcode 27.0) and deleted after it; Android, for arm64-v8a only (`SMOKE_ANDROID_ABIS`), on the
existing Pixel 10 Pro Fold AVD booted `-read-only -no-snapshot -no-window`, so nothing persisted
into it. No simulator or emulator was running before.

- iOS: `ios-prebuild` passed in 30 s, printing the time-sensitive entitlement `true`; `ios-build`
  in 127 s; `ios-archive`; `ios-launch` in 61 s, the app alive after 30 s.
- Android: `android-prebuild` passed, writing the notification icon at 24, 36, 48, 72 and 96 px
  (mdpi to xxxhdpi) and naming it, its colour and `flight_changes` in the manifest for FCM and expo;
  `android-build` in 246 s. `android-archive` FAILED: "the release APK embeds no JavaScript
  bundle", with `assets/index.android.bundle` in the APK (line 45 of a 1,343-line listing). The
  check piped `unzip -l | awk | grep -qx` under `set -o pipefail`: `grep -q` exits at its first
  match, awk dies of SIGPIPE writing the rest of the listing, and pipefail reports 141 (reproduced:
  the same pipeline answered 0, then 141, on the same APK). The script's own comment two checks
  earlier warns of exactly this. It dates from increment 11's ruling Z5 and can flake the weekly
  CI smoke too. Fixed in `c5639b6`: the check counts (`grep -cx`, then `-gt 0`), as the script's
  other checks do, and `tools/workflows/native-smoke.test.js` (58, one new) now fails if any
  pipeline in the script ends in `grep -q` again, and fails with the old line restored; it was the
  script's only such pipeline. With the fix `android-archive` passed 3 of 3 (its 16 KB check: all
  28 arm64-v8a libraries aligned) and `android-launch` passed ("alive after 30s (pid 7663), no
  fatal, no JS error"); the emulator was then stopped, no process left.

Every step of the native smoke passes on both platforms. It proves the builds, the entitlement and
a clean launch; no notification was shown on either (the devices' steps under Unverified).

### The upstream report for expo-notifications, not filed

A2's ruling asks for an issue and a pull request for the owner to file at `expo/expo`. **Neither is
filed.** This round made no network call, so whether `main` or a later SDK already fixes the bug is
unchecked: before filing, read `main`'s `packages/expo-notifications/src/getDevicePushTokenAsync.ts`
and the next SDK's changelog, and if it is fixed there, cite the fix in the patch's comment
(`pnpm-workspace.yaml`) and drop the patch at that upgrade. The 57.0.20 changelog records no fix;
by its entries the shared promise came with 0.3.1 (2020-06-03), PR #8608 ("Fixed
`getExpoPushTokenAsync` rejecting when `getDevicePushTokenAsync`'s `Promise` hasn't fulfilled yet"),
whose diff was not read here. The text, ready to paste:

**Issue title:** getDevicePushTokenAsync caches a rejected native promise for the life of the JS
runtime

**Issue body:** `getDevicePushTokenAsync` shares one native read between concurrent callers through
the module-level `nativeTokenPromise`, set before the `await` and cleared after it. Nothing clears
it when the native read rejects, so the rejected promise stays cached and every later call in the
process rethrows the same error without asking the native side again, until the JS runtime
restarts. The sharing seems to date from #8608 (0.3.1) and is unchanged in 57.0.20 (`src/` lines
21 to 29, and `build/`). On Android the native read rejects when FCM must fetch a token over the
network and cannot: `getToken()` fails with `SERVICE_NOT_AVAILABLE` when no token is stored (a
fresh install, or after `unregisterForNotificationsAsync()` deleted it) or the stored one is stale
(firebase-messaging 25.0.1 refreshes it after 7 days or a changed version code), while the device
is offline, behind a captive portal or on a network that blocks Google. After one such read, an
app that reads the token again on each return to the foreground gets the same error each time
until the process ends, and a permission granted meanwhile never reaches its server with a token.
iOS is barely exposed: its native promise settles only when APNs answers, so offline a read stays
pending rather than rejecting. Repro (Jest with the jest-expo preset, only the native module
mocked):

```ts
let mockNativeCalls = 0;

jest.mock('expo-notifications/build/PushTokenManager', () => ({
  __esModule: true,
  default: {
    addListener: () => ({ remove: () => undefined }),
    removeListeners: () => undefined,
    getDevicePushTokenAsync: () => {
      mockNativeCalls += 1;
      return mockNativeCalls === 1
        ? Promise.reject(new Error('SERVICE_NOT_AVAILABLE'))
        : Promise.resolve(`token-${mockNativeCalls}`);
    },
  },
}));

it('asks the native side again after a read that rejected', async () => {
  const { getDevicePushTokenAsync } = require('expo-notifications');
  await expect(getDevicePushTokenAsync()).rejects.toThrow('SERVICE_NOT_AVAILABLE');
  // 57.0.20: rejects again with the same error, and the native side is not asked again.
  await expect(getDevicePushTokenAsync()).resolves.toMatchObject({ data: 'token-2' });
  expect(mockNativeCalls).toBe(2);
});
```

On 57.0.20 the second call fails: "Received promise rejected instead of resolved. Rejected to value:
[Error: SERVICE_NOT_AVAILABLE]". Expected: after a rejection the next call asks the native side
again, as it does after a success.

**Pull request title:** [notifications] Clear the cached device push token promise when the native
read rejects

**Pull request body:** Fixes #(the issue). `getDevicePushTokenAsync` kept a rejected native promise
cached for the life of the JS runtime, so one failed read (on Android, an FCM fetch that failed
offline) failed every later read. This clears the cached promise in a `finally`, and only when it is
still the one this call created, so concurrent callers still share one native call, whether it
resolves or rejects, and the next call after either asks the native side again. Tests: a native read
that rejects once and then resolves (the repro above, which fails before this change), and two
concurrent reads sharing one rejecting native call, then a third asking again. Changelog: a line
under Unpublished, Bug fixes. The change, in `src/getDevicePushTokenAsync.ts` (and in
`build/getDevicePushTokenAsync.js` if the package's build output is committed):

```diff
   } else {
     // Create a new Promise and clear it afterwards
-    nativeTokenPromise = PushTokenManager.getDevicePushTokenAsync();
-    devicePushToken = await nativeTokenPromise;
-    nativeTokenPromise = null;
+    const promise = PushTokenManager.getDevicePushTokenAsync();
+    nativeTokenPromise = promise;
+    try {
+      devicePushToken = await promise;
+    } finally {
+      // Cleared on a rejection too, so the next call asks the native side again.
+      if (nativeTokenPromise === promise) {
+        nativeTokenPromise = null;
+      }
+    }
   }
```

In this repository the same hunk is `patches/expo-notifications@57.0.20.patch`, in both files. The
repro above is F3a's, run against the store's unpatched 57.0.20 (it fails as quoted) and the patched
copy (it passes); the fuller test is `apps/mobile/__tests__/push-token-read.test.ts`, 4 of whose 5
tests fail on the unpatched package (What ran, above).
