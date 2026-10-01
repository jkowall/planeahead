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
stays unverified, with the steps that settle it. The spec is [16-client-push.md](16-client-push.md);
the research behind it is `docs/research/phase1/R2-client-push.md` (R2); the server half of
registration and sign-out is increment 14's ([14-verification.md](14-verification.md)).

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
| 4 | The runtime fingerprints of the final tree (`APP_VARIANT=preview APNS_ENVIRONMENT=production node_modules/.bin/expo-updates fingerprint:generate --platform ios`, then `android`, from `apps/mobile`) | iOS `5068d917e263...`, Android `3cb004ba8dd1...`: part 2's values, all 62 sources equal (parts 3a and 3b changed no fingerprint source) |
| 4 | The icon (`node scripts/gen-notification-icon.mjs --check`, and a decode of the PNG) | up to date; the numbers are under [Measurements](#measurements) |
| 4 | The documents: `pnpm exec prettier --check` on the four documents Prettier formats (the two under `docs/increments/` are skipped by `.prettierignore` and wrapped at 100 columns by hand); the tests that read them | clean; passed: the mobile house-style test 183 (it scans the runbook), the shared style test 66 (it scans `docs/architecture.md`) and the cadence-table test 8; no em dash in any changed file |

Not run in the build: the native smoke itself (its iOS prebuild step now requires the entitlement;
both legs are the close-out's run), any simulator or device (the parts needed none), and the full
check of the final tree, which is the orchestrator's.

## Acceptance, item by item

- **Every C10 test, mobile (Jest).**
  - The permission flow (C1): `push-permission.test.ts` (20): granted; provisional read from
    `ios.status` 3 as a quiet grant, never prompted over; denied; Android's `denied` before any
    request read as undetermined until this installation has asked once; a request checks first and
    asks for alert and sound only (no badge, no provisional); the pre-prompt offered once per
    installation and only while the system prompt can still show. `add-flight.test.tsx` (3 new): the
    first add that succeeds gives way to the pre-prompt and a later add never shows it; a decided
    permission or a refused add offers nothing. `settings-push.test.tsx` (4): each state's line,
    "Turn on notifications" while the prompt can show (registering the answer at once), "Open system
    settings" when denied, the state read again on the way back.
  - Registration on launch, foreground and rotation (C2): `push-registration.test.tsx` (15): the
    device token goes with the permission the app holds; without a token, or without a readable
    permission, the device registers without one; one registration at a time, triggers during it
    making one more run; the listener's echo of the registrar's own read ignored; a rotation
    registered once, debounced, as the listener carried it (no read); `reset` and `idle`;
    `useSessionWork` registers on session start, on every return to the foreground and on a
    rotation, not without a session, and not after a revoked Apple credential, which signs out the
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
    offline it signs out at once and the next launch sends the call before any registration.
  - Channel creation before the prompt (C4): `push-permission.test.ts`: both channels at start-up,
    `HIGH`, from `ANDROID_CHANNEL_IDS`; they exist before the permission request asks; none on iOS.
  - The foreground handler's decisions (C6): `push-handling.test.tsx` (16): the flight a push names
    is read only from data it knows (`v` 1 and a UUID); a push is presented (banner, list and sound)
    unless its flight is in front, and one that names no flight (a test push), or carries a data
    version this build cannot read, is presented; the handler is installed once and answers from
    memory as the detail screen comes and goes; a foreground push naming a flight syncs the store.
  - Tap routing (C7): the same file: a cold start's last response waits for a session, then opens
    the flight once and is cleared; an unknown id gets one sync, then the flight, or the home screen
    if it is still unknown; the flight already in front refreshes in place; a tap naming no flight
    is cleared and routes nowhere; the same tap from both sources routes once.
  - The dismissal of a flight's presented notifications (C7): the same file: those whose data names
    the flight, and those FCM displayed, by their tag; the detail screen does it when it opens, once
    the flight key is loaded.
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
  The overrides schema refusing `events` and unknown keys: `packages/shared/test/rpc.test.ts`; in
  `flights.subscribe.test.ts` the subscribe route refuses both with no row written and stores and
  relays `muted`, and a repair re-subscribe relays a stored bag narrowed to `muted`, which the
  tracker accepts.
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
  5). The close-out runs both legs.
- **The full check and both dry runs**: the full check of `741ec86` failed only on the API suite's
  connections (finding 9); after the fix the API suite passed in full twice and in the failing order
  under load. Both dry runs passed at `741ec86`, and the fix changed no production code. The full
  check of the final tree is the orchestrator's.
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
  and one `audit_log` row; a canary round every hour, 24 a day, of two test pushes, which holds up
  to two more Neon connections briefly. Outside a soak each tick reads one KV value and logs.

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
   narrows a stored bag to `muted` on all three paths.
8. **"Two isolates at once" cannot be arranged on Workers** (part 3b). A Worker cannot choose the
   isolate an invocation runs in; Queues raises consumer concurrency only after a batch has finished
   (R1 F46), so two queued canary jobs would run one after the other; the push queue runs a batch's
   jobs one after another; and the second job would take its provider token from the isolate's
   module-scope cache. Departure 1 is the answer.
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
   its pull request, and so to main.
10. **A transient failure at an online sign-out can leave the token live** (part 1; for the review).
    When the invalidation at sign-out is queued (a 408, 429 or 5xx, a network failure, or no answer
    within 5 s) and the session revoke that follows succeeds, the queued retry acts as a revoked
    session, gets 401 and is dropped, so the token row stays live for the signed-out user until APNs
    or FCM reports it dead or the next session's registration re-points it. On Android the token
    deletion makes FCM answer `UNREGISTERED` to the next send, which invalidates the row; on iOS
    whether APNs refuses the old token after `unregisterForRemoteNotifications` is not documented.
    Whether the server should invalidate an installation's tokens when its session is revoked is the
    review's question (`docs/security/threat-model.md`, section 1.8).
11. **An offline sign-out's call waits for a cold launch or a sign-in** (part 1). The queued
    invalidation is retried at launch and before every registration, and a signed-out app registers
    nothing, so a phone that signed out offline and comes back online keeps its token live on the
    server until the app next starts from cold or someone signs in. Android's token deletion is a
    network call and fails offline too (sign-out waits for it at most 5 s).

## Departures from the spec, and clarifications

### Departures

1. **The canary from one invocation, not two isolates** (C9, part 3b; accepted by the orchestrator).
   Each hourly canary sends its two test pushes at the same moment from ONE invocation, each through
   the push consumer's own batch handler as a batch of one with an empty token cache of its own, the
   first token request of each held at a gate until both arrive (at most 5 s, then a send asks
   alone), so both ask `PushAuth` in the same instant, as two cold isolates would. Why: finding 8.
   Lost: the queue hop on the first attempt (the sends' retries go through the push queue like any
   job's) and the cross-isolate case (R1 U2), which the soak's 403, 429 and edge counts still
   measure over its ordinary pushes.
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
  system settings". The pre-prompt is a modal route that takes the add sheet's place; "Turn on"
  registers the answer at once rather than at the next foreground.
- An add queued offline counts as a success for the pre-prompt: both outcomes take the same branch
  in `add.tsx`, and no test drives the queued case on its own.
- iOS `ephemeral` counts as granted, and an unknown status as denied.
- A revoked Apple credential signs out through the same path as the button, the invalidation first;
  an account deletion and `401 account_deleted` end in `forgetAccount` alone, since the tokens
  cascade with the user and no session is left to invalidate with.
- The queued invalidation keeps the signed-out session's cookie map in SecureStore (through the Expo
  client's chunked adapter), so its retry acts as the signed-out user, never as the next session.
  One record, the first kept: while it waits every registration waits too, so a later session has
  registered nothing from this installation that a second record would need. `registerDevice`
  settles it before every registration, and it is retried at launch. The call times out after 5 s;
  three 408, 429 or 5xx answers drop it, as do any other 4xx and cookies that have all expired; a
  network failure keeps it without counting; each drop is reported to Sentry
  (`device_invalidation_dropped`).
- Sign-out waits at most 5 s for a registration in flight and at most 5 s for Android's token
  deletion.
- The Live Activity push-to-start token's registration carries `appId` too.
- Taps are taken in the root layout, so a cold start's tap is not lost behind the session gate, and
  routed by the `(app)` layout once a session exists; the same tap seen through the last response
  and the listener routes once.
- The flight is "in front" while its detail screen is focused, and its presented notifications are
  dismissed on that focus, once the flight key is loaded.
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
  the lock screen and the shade (the builder's suggested follow-up, accepted).
- The labels are "Flight alerts", "Delays", "Gate changes", "First gate assignment", "Cancellations"
  and "Diversions", for the owner to confirm. With "Flight alerts" off the five are greyed out and
  keep their values, as `notify` drops a user with push off before it reads the kinds.
- The persisted settings version stays 1: a state saved before increment 16 loads with the
  notification defaults.
- The queued-body reader parses the whole `PATCH` body (`PreferencesPatchSchema`), so the display
  overlay and the notification overlay each read their own part.
- The sync row's `notificationOverrides` stays a loose record, forward compatible; `storedOverrides`
  narrows what the API re-sends (finding 7).

The soak (part 3b):

- The record is one JSON value in `CONFIG` KV (`push-soak:v1`, beside the kill switch): no
  migration, no new Durable Object, and a staging-only harness kept out of production's schema. It
  holds the canary's `push_tokens` row id, never the device token. KV is eventually consistent, so a
  stop can let one more tick through elsewhere; each step reads the record again and skips a stopped
  or replaced soak.
- Ticks plan their steps on the existing `housekeeping` queue: a 03:00 UTC tick can wait behind the
  nightly steps. The ids a step writes under are minted at the tick, so a redelivery replays them,
  and the tracker writes nothing for a replayed injection id.
- The injected event is a departure delay of 30, 60, 90 and 120 minutes in turn: the policy pushes a
  delay at any distance from departure (a gate change only from six hours before it), it reads as
  routine on the test devices, and with values 30 minutes apart a real delay pushed meanwhile blocks
  at most one tick in four.
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
  airplane mode on; inject a delay (APNs accepts and holds it; its delivery row reads `sent`); sign
  out, offline, so the call is queued and the app unregisters; airplane mode off; wait two minutes.
  Record whether the held push is shown, and, after a cold launch, that the queued call landed
  (`invalidated_at` set). On Android the same steps show only the offline case, since the token
  deletion itself needs the network (finding 11), and FCM holds nothing for a phone that is online.
- **The soak's 24 to 48 hours with clean counters** (C9; R1 U1 and U2), on staging: runbook step
  19's soak items. Record the hours, the ticks, the sends by channel, every row under "403 and 429
  answers, by reason" and "Edge 52x answers without an apns-id" (a clean soak has none), the
  injections by outcome and the canary rounds with their sends' first answers. While the Postgres
  reads of the push consumer fail, an unsent retry can overwrite a 429's attempt log entry
  (increment 14's verification, Unverified), so a soak whose window had such failures can count
  fewer 429s than happened.
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
