# 0008. Native surfaces: expo-widgets, the watchOS shells, the Android stubs, the nightly smoke

- Status: Accepted
- Date: 2026-09-23
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none
- Amended: 2026-09-23, by the increment's review round (rulings Z1 to Z11; what ran is in
  `docs/increments/11-verification.md`)

## Context

PlaneAhead's value is on surfaces outside the app: the Lock Screen and Dynamic Island (a Live
Activity), home-screen widgets, the watch, Android's ongoing notification. Every one is native
code in any cross-platform framework. The Phase 0 plan (section 3) chose `expo-widgets`, which
builds WidgetKit widgets and Live Activities from JavaScript layouts, and increment 11 turns that
into compiling shells for every surface Phase 1 and 2 fill, plus a nightly job that proves the
native projects still build and launch with all of them present. Facts that shape the decisions
(`docs/increments/09-11-mobile.facts.md` section 5 and its native-surfaces open questions):

1. expo-widgets 57.0.20 is stable since SDK 56, iOS documented, not in Expo Go
   ([docs](https://docs.expo.dev/versions/latest/sdk/widgets/)). A Live Activity created with
   `createLiveActivity` must not have a `widgets[]` entry, and a widget component uses the
   `'widget'` directive and only `@expo/ui/swift-ui`, with nothing from outside its body.
2. Its config plugin sets `aps-environment` to the literal `development` unconditionally, and
   `ios.entitlements` is applied before every plugin
   ([withPushNotifications.ts](https://raw.githubusercontent.com/expo/expo/sdk-57/packages/expo-widgets/plugin/src/ios/withPushNotifications.ts)).
   A production Live Activity token would be minted against the sandbox APNs.
3. Apple caps a Live Activity's static plus dynamic data at 4 KB and its active life at 8 hours,
   12 on the Lock Screen
   ([ActivityKit](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities)).
   Push tokens are per activity and rotate, which increment 5's `push_tokens` cannot represent.
4. expo/expo#49752: the widget JavaScript bundle fails to resolve hoisted packages in a
   workspace; whether it reproduces under pnpm's isolated linker was unknown.
5. `@bacons/apple-targets` 5.0.0 depends on `@expo/prebuild-config ~55` against SDK 57's 57.0.16,
   claims only Xcode 16, rewrites the project with a second pbxproj parser (`@bacons/xcode`
   1.0.0-alpha.32) and has open watch defects (207, 171, 148) plus #194, a dyld failure that
   builds clean and dies at launch.
6. expo-widgets 57.0.20 already carries an Android Glance implementation behind `enableAndroid`,
   which SDK 58 promotes. Android 16 Live Updates need API 36 and `POST_PROMOTED_NOTIFICATIONS`.
   Expo has no Wear OS support of any kind.
7. The EAS SDK 57 images are `macos-tahoe-26.5-xcode-26.6` and
   `ubuntu-26.04-jdk-17-ndk-r27b-sdk-57`; nightly EAS iOS builds would exceed the Starter credit.

## Decision

We will build every iOS surface with expo-widgets 57.0.20, ship the watchOS shells with
`@bacons/apple-targets` 5.0.0 because the coexistence spike passed, keep Android to an
ongoing-notification stub and a Wear OS module that compile, and prove all of it every night on
GitHub runners by building, installing and launching both apps.

1. **expo-widgets, exact 57.0.20** (the toolchain guard asserts the pin and one installed copy).
   One `widgets[]` entry, the placeholder home-screen widget (`PlaneAheadPlaceholder`,
   `systemSmall` and `systemMedium`, widgets/placeholder.tsx). The flight Live Activity
   (`FlightActivity`, widgets/live-activity.tsx) is created with `createLiveActivity` and is not
   in `widgets[]`; expo-widgets compiles its one `WidgetLiveActivity` into the extension anyway.
   The plugin gets an explicit `groupIdentifier`, the App Group `ios.entitlements` declares for
   the variant (ADR 0005), and an explicit extension bundle id, the app's plus `.widgets`
   (`app.planeahead.mobile.widgets`, `.preview.widgets`, `.dev.widgets`), because it is
   permanent once a build ships. `enablePushNotifications` is on (the token observers need it),
   `frequentUpdates` off. Both layouts register themselves with the App Group when the app
   imports `widgets/` on launch (src/lib/live-activity/tokens.ts), which a push-started activity
   needs before it can render. No hand-written SwiftUI: the layouts are JavaScript.

   One generator defect is corrected rather than patched in the package
   (`plugins/withExpoWidgetsBuild.ts`, listed right after `expo-widgets`; review ruling Z11).
   expo-widgets 57.0.20 writes the same build settings into both configurations of
   `ExpoWidgetsTarget`, `SWIFT_OPTIMIZATION_LEVEL = "-Onone"` included
   (`plugin/build/ios/xcode/addXCConfigurationList.js`), and Xcode then turns on the debug dylib
   for the Release configuration too: a Release product carried the extension as a 40 KB stub
   plus `ExpoWidgetsTarget.debug.dylib` (8 MB) and `__preview.dylib`, unoptimised, in a WidgetKit
   extension that runs under a tight memory limit. The plugin sets `-O` and
   `ENABLE_DEBUG_DYLIB = NO` on that Release configuration. Like `withApsEnvironment` it is a
   base mod that runs the rest of the `xcodeproj` chain first and edits on the way out, so it
   edits the project after expo-widgets created the target; apple-targets' own mod rewrites the
   project later and keeps build settings. `xcodebuild -showBuildSettings` confirms the values
   after every nightly prebuild, and the nightly fails on any `*.debug.dylib` or
   `__preview.dylib` in the Release app. Upstream generator behaviour under the exact pin: an
   expo-widgets bump re-checks it.

2. **Layout rules, tested in the extension's own terms.** babel-preset-expo turns each
   `'widget'` function into a string; the extension evaluates it in a JavaScriptCore context
   whose only globals are `@expo/ui/swift-ui`, its modifiers and a JSX runtime.
   `__tests__/widgets.test.ts` captures the strings Jest compiled with the same preset and
   evaluates them in a fresh `vm` context holding exactly those names, so a helper or constant
   from outside the body fails as a ReferenceError in CI (it was proven by planting one).
3. **`aps-environment` has the last word from the EAS profile.** `plugins/withApsEnvironment.ts`,
   the last plugin, sets the value from `APNS_ENVIRONMENT` (eas.json: `production` for the
   production and preview profiles, `development` for development; ADR 0001 decision 2). Being
   last in `plugins` is not enough: a `withEntitlementsPlist` mod wraps the chain registered
   before it and runs its action FIRST (`withMod` in @expo/config-plugins 57.0.9 runs `action`,
   then `nextMod`), so a plain one was overwritten by expo-widgets (measured below). The plugin
   registers a base mod that runs the rest of the chain first and writes on the way back out.
   `__tests__/entitlements.test.ts` runs `expo config --type introspect` per profile with the
   profile's `env` and `EAS_BUILD=true`, and asserts the value, the App Group, and that the widget
   extension and both watch shells carry exactly the app's group; the nightly asserts the same on
   the files a real prebuild writes.
4. **Tokens: push-to-start registered, per-activity logged and discarded.** The push-to-start
   token belongs to an installation and rotates rarely, so it is a `push_tokens` row of the new
   kind `apns_live_activity_push_to_start` (migration 0004 widens the check constraint; the one
   API change of this increment). What the table stores is one row per `(kind, token)`: a
   rotated token is a new row next to the earlier ones, and the newest row of a device is its
   current token; sign-out and rotation leave rows behind, which gates the Phase 1 sender (open
   decision 7). src/lib/live-activity/tokens.ts posts it through increment 9's
   devices module (`POST /v1/devices`, the install id in the body and in `X-Install-Id`, the APNs
   environment from the signing, a direct call, not the outbox) for the session user, again for
   each new user and each new token. A 200 with `pushTokenSkipped` (the token's row belongs to
   another user's device from another installation, the API's anti-hijack outcome) is not a
   success: `registerDevice` returns `{ registered: false, reason }`, and the app logs
   `live_activity_push_to_start_token_skipped` with the reason and the token's length and sends
   a Sentry warning, so Phase 1 can size how often a device cannot be push-started (ruling Z4).
   Per-activity update tokens are N per device and rotate
   during an activity with a server obligation to invalidate the old one; Phase 0 logs that one
   arrived (the activity id, never the token) and discards it. They belong to `live_activities`
   (keyed by activity id) in Phase 1. Increment 3's `apns_live_activity_start` kind stays
   accepted; no client ever sent it.
5. **Content state.** The activity's props are the shared `LiveActivityContentStateV1` itself,
   extended with the three fields the Lock Screen and the Dynamic Island print and the schema
   lacked: `designator`, `originIata`, `destinationIata`, optional like every field added to a
   loose schema later. `gate` and `terminal` are the origin's (the departure pair), and the
   review added the arrival pair, `destinationGate` and `destinationTerminal`, optional too; the
   layout prints the destination gate right after the arrival time and nowhere when it is
   absent (ruling Z7). Every field is bounded (`LIVE_ACTIVITY_FIELD_MAX_LENGTH`: gate 16,
   terminal 32, baggage claim 32, and, because their grammars alone allow any length, the flight
   key 32 and each instant 30), set before anything produces the state because tightening later
   needs a `V2` schema (ruling Z2). Parsing stays loose; the encoder,
   `encodeContentState(state, attributes)`, keeps only the schema's own fields, validates every
   bound and throws `ContentStateTooLargeError` when static plus dynamic data would reach 4 KB. Progress stays `progressPercent` (0 to 100, as `FlightStatus` has it; the
   layout divides by 100), because retyping a field needs a new versioned schema. On the wire
   expo-widgets stores `{ name, props }` with the state JSON-encoded into the `props` STRING, and
   its one attributes type, `LiveActivityAttributes`, holds only `{ url }`; a Phase 1 push names
   that attributes type and carries `encodeContentState(state, attributes)`
   (widgets/content-state.ts).
6. **watchOS shells ship.** `@bacons/apple-targets` 5.0.0 (exact), listed after expo-widgets, with
   `targets/watch` (a watchOS 11 app, `<bundle id>.watchkitapp`) and `targets/watch-widget` (a
   watch-face complication embedded in it, `<bundle id>.watchkitapp.widget`), both on the app's
   App Group. The two targets need two small SwiftUI files (an `App` and a `Widget` that print
   the name), the only hand-written Swift in the repository, which the target type requires.
   The watch app carries the variant's app icon (`icon` in `targets/watch/expo-target.config.js`,
   ruling Z10): App Store Connect wants an app icon catalog in every app bundle, and without it
   apple-targets wrote none (no `Assets.car`, no `CFBundleIconName`). apple-targets generates that
   catalog into `targets/watch/Assets.xcassets` on every prebuild; it is gitignored and left out
   of the fingerprint. The complication needs no icon. The runtime fingerprint hashes `targets/`
   and `wear/` as extra sources (`fingerprint.config.js`, ruling Z9): @expo/fingerprint finds
   the config and the plugins but not the Swift and Kotlin they point at, so a change to the
   watch's Swift alone kept the runtime version.
7. **Android.** No hand-written Glance widget: expo-widgets' Android widgets stay behind
   `PLANEAHEAD_ANDROID_WIDGETS=1` (off by default) until SDK 58 supports them. While the flag is
   off, expo-widgets is also excluded from Android autolinking (ruling Z3): its Android module,
   autolinked whatever `enableAndroid` said, brought `androidx.glance` 1.2.0-rc01 (a release
   candidate) and through it `androidx.work` 2.7.1, which merged `FOREGROUND_SERVICE`,
   WorkManager's startup initializer (its database opened on every launch), its foreground and
   job services and Glance's receivers into the production manifest. The app's JavaScript needs
   no native module on Android (expo-widgets resolves `build/ExpoWidgets.js` there, a pure stub).
   The exclusion keys off the same flag: `plugins/withExpoWidgetsBuild.ts` writes
   `expoAutolinking.exclude = ['expo-widgets']` before `useExpoModules()` in settings.gradle
   when `enableAndroid` is off, which the Gradle projects and the generated package list both
   honour, so the trial needs no hand edit and its builds get the rc Glance back. The nightly
   asserts that the merged manifests carry no WorkManager or Glance component and that the
   release APK declares exactly an expected list of permissions (`aapt2 dump permissions`).
   `modules/android-surfaces` is a local Expo module with one Kotlin class,
   `OngoingNotificationModule`, exposing one no-op method (`update`) and the Live Updates
   builder behind an API-level guard, never called in Phase 0; it declares no permission.
   `plugins/withWearApp.ts`, written from scratch, includes a Compose for Wear OS module with one
   Tile in the Gradle build; its sources are apps/mobile/wear and its build script is generated
   with every version pinned in the plugin:

   | Artefact                                      | Version | Why this one                                                   |
   | --------------------------------------------- | ------- | -------------------------------------------------------------- |
   | `androidx.wear.compose:compose-material3`     | 1.6.2   | 1.7.0 needs compileSdk 37 and AGP 9.1; 1.6.2 needs 35 and 8.6  |
   | `androidx.wear.compose:compose-foundation`    | 1.6.2   | same line                                                      |
   | `androidx.compose.ui:ui`, `foundation-layout` | 1.9.0   | what Wear Compose 1.6.2 depends on (Kotlin 2.1.20, the app's)  |
   | `androidx.activity:activity-compose`          | 1.11.0  | compileSdk 36, AGP 8.9.1, Kotlin stdlib 2.0.21                 |
   | `androidx.wear.tiles:tiles`                   | 1.6.2   | newest stable; compileSdk 35, AGP 8.6, Kotlin 2.1.20           |
   | `androidx.wear.protolayout:protolayout`       | 1.4.2   | what Tiles 1.6.2 depends on                                    |
   | `androidx.concurrent:concurrent-futures`      | 1.3.0   | `CallbackToFutureAdapter` for the Tile's futures               |
   | `com.google.guava:listenablefuture`           | 1.0     | the `ListenableFuture` interface only                          |
   | Compose compiler Gradle plugin                | Kotlin  | `rootProject.ext.kotlinVersion` (2.1.20), as expo-modules-core |

   The watch app is `minSdk 30` (Wear OS 3) and shares the phone app's package, which is what
   pairs the two. EAS builds run `:app:` tasks and never build it.

8. **Native smoke** (`.github/workflows/native-smoke.yml`, every step in
   `scripts/native-smoke.sh`): a weekly cron (nightly until 2026-09-30, when six nightly runs had
   used up GitHub Free's monthly Actions allowance; ADR 0001 and the build log) plus
   `workflow_dispatch` with a `platforms` input, never on EAS, no secrets. The iOS
   job is a matrix on `macos-26`: Xcode 26.6 (the gate) and Xcode 27 (`continue-on-error`). It
   prebuilds the production variant with the production profile's `APNS_ENVIRONMENT`, asserts
   the generated entitlements and `xcodebuild -list`, builds Release for an iPhone simulator
   with `-destination` only, asserts the app holds the widget extension with its runtime bundle
   and the watch shells built for watchOS, installs, launches and fails unless the process is
   alive after 45 s; the review added the widget extension's Release settings after prebuild and,
   in the app, the watch app's icon catalog and the absence of any debug dylib. The ubuntu job
   prebuilds, runs `assembleDebug` (the compile the spec names) and `assembleRelease` for the
   emulator's `x86_64` ABI (every ABI until 2026-09-30, which filled the runner's disk; ADR 0001)
   with a 4 GB Gradle heap, asserts the Wear APK, the stub module's class, the Tile service,
   the release APK's embedded `index.android.bundle`, the merged manifests and the permissions,
   and launches the RELEASE APK on an API 36 emulator (ruling Z5): the debug APK embeds no
   JavaScript (it is the dev launcher), so launching it proved only the native shell. The launch
   fails on a dead process or on a `FATAL EXCEPTION` naming the app or a `ReactNativeJS` error in
   logcat within the grace period.

## Spike results (2026-09-23, this machine)

Xcode 27.0 (27A266a), the iOS 26.5 runtime on an iPhone 17 Pro simulator, macOS 27.0,
CocoaPods 1.17.0, JDK 21, Node 24.21.0, pnpm 12.5.1 with the isolated linker. Xcode 26.6, the
EAS image's, is not installed here: its leg is proven by the nightly only.

### Spike 1: does the widget bundle resolve under pnpm's isolated linker (expo/expo#49752)?

It does; no workaround was applied. The Pods target's "Build ExpoWidgets Bundle" phase ran
`expo export:embed` on `expo-widgets/bundle/index.ts`: "iOS Bundled 2261ms ... (111 modules)",
written into the installed package (`node_modules/.pnpm/expo-widgets@57.0.20.../bundle/build/`)
and copied into both the app and the appex. `xcodebuild` for the iPhone 17 Pro simulator (Debug,
development variant): **BUILD SUCCEEDED** in 2 min 26 s cold; the app launched and was alive
20 s later; the appex carries `app.planeahead.mobile.dev.widgets` and the variant's group. Two
things the build leans on, recorded rather than fixed: the bundle scripts `require` two
packages expo-widgets lists only as devDependencies (`@expo/spawn-async` in `build-bundle.mjs`,
`resolve-workspace-root` in its `metro.config.js`), which resolve through pnpm's hidden hoist
(`hoistPattern: ['*', '!@types/jsdom']`), so narrowing that pattern would break the widget build;
and the phase writes into the package directory, so two iOS builds in one checkout race.

The layouts were also evaluated in the built `ExpoWidgets.bundle` itself (Node `vm`): the
placeholder for both families and the Live Activity for a full and a minimal state produce the
node trees the Swift side reads (2717 and 2721 bytes of JSON for the nine regions).

### Spike 2: apple-targets next to expo-widgets in one prebuild (time box two hours)

**Passed on Xcode 27, in about twenty minutes.** `expo prebuild` wrote one project with four
targets (`PlaneAheadDev`, `ExpoWidgetsTarget`, `PlaneAheadWatch`, `PlaneAheadWatchWidget`);
`xcodebuild -list` parses it. The build compiled the app and extension for the iOS simulator
and the watch app and complication for the watchOS simulator (`vtool`: `IOSSIMULATOR` minos
16.4, `WATCHOSSIMULATOR` minos 11.0), embedded as `Watch/PlaneAheadWatch.app` with
`PlugIns/PlaneAheadWatchWidget.appex`; **BUILD SUCCEEDED**, and the app was alive 20 s after
launch (no dyld failure). The two pbxproj writers do not lose each other's work, and their order
in `plugins` does not matter: with the two entries swapped the generated project is the same
set of lines. Findings on the way:

- `-sdk iphonesimulator` on the command line forces EVERY target onto the iOS SDK: the first
  build "succeeded" with the watch targets compiled as iOS simulator binaries (a
  `TARGETED_DEVICE_FAMILY (4)` warning, `vtool` platform `IOSSIMULATOR`). The nightly and the
  README use `-destination` only, and the workflow test forbids `-sdk iphonesimulator`.
- `@bacons/xcode` re-serialises the file expo-widgets wrote: the widget extension's
  entitlements and Info.plist build files are labelled `[missing build phase]`, cosmetically.
- The plugin pulls a second, SDK 55 `@expo/config-plugins` (55.0.11) through
  `@expo/prebuild-config` 55.0.22, and `@expo/require-utils` 55.0.8 peers on TypeScript 5 (a
  peer warning under 6.0.3). It warns that `ios.appleTeamId` is missing; simulator builds need
  none, device builds will.
- apple-targets adds the two watch targets to the EAS `appExtensions` list with the app's
  group, so EAS provisions them.

Not proven here: Xcode 26.6 (the nightly's gate leg), a Release archive signed for a device, and
the watch app running on a watchOS simulator (no watchOS runtime is installed).

### Spike 3: Android SDK levels and the Live Updates calls

Expo SDK 57 builds with React Native 0.86.3's catalog: compileSdk 36, targetSdk 36, minSdk 24,
build-tools 36.0.0, NDK 27.1.12297006, Kotlin 2.1.20, KSP 2.1.20-2.0.1 (Gradle's
`[ExpoRootProject]` banner), AGP 8.12.0, Gradle 9.3.1. API 36 is installed (platforms `android-36`
revision 2 and `android-36.1`). Its `android.jar` has `Notification.ProgressStyle` and
`Notification.Builder#setShortCriticalText` but NOT `Notification.Builder#setRequestPromotedOngoing`
or `Manifest.permission.POST_PROMOTED_NOTIFICATIONS`: both first appear in API 36.1 (Android 16
QPR2, `Build.VERSION_CODES_FULL.BAKLAVA_1`). The first androidx.core with
`NotificationCompat.Builder#setRequestPromotedOngoing` is 1.17.0 (1.16.0 has none; its
`minCompileSdk` is 36), so the stub calls that, compiled against 36, behind
`SDK_INT >= BAKLAVA`. `./gradlew assembleDebug` (arm64-v8a) with the stub and the Wear module:
**BUILD SUCCESSFUL**, 930 tasks, the Wear APK `app.planeahead.mobile.dev`, compileSdk 36,
targetSdk 36, feature `android.hardware.type.watch`.

`enableAndroid: true` (`PLANEAHEAD_ANDROID_WIDGETS=1`) was tried: prebuild writes the
`APPWIDGET_UPDATE` receiver, `@xml/plane_ahead_placeholder_info` and
`res/values/expo_widgets.xml`, and `assembleDebug` succeeds. The first attempt, a cold build,
failed in D8 with `OutOfMemoryError` under the template's `-Xmx2048m`; the same build passed
when re-run, and the nightly runs Gradle with 4 GB. The widget was not rendered (the AVD's adb
authorisation is the owner's to accept). Note that expo-widgets' Android module (with
`androidx.glance` 1.2.0-rc01) was autolinked into every Android build whatever the flag said; the
flag only added the receiver. The review round excluded it while the flag is off (decision 7).

### Observed: `aps-environment` through the plugin chain

`expo config --type introspect`, production profile (`APNS_ENVIRONMENT=production`): with the
increment 9 no-op plugin, `development`; with a plain `withEntitlementsPlist` in the last plugin,
still `development`; with the post-order base mod, `production` (and `production` for preview,
`development` for development). `entitlements.test.ts` fails against the plain mod.

### Observed: a push-to-start token on the Simulator

Yes. On the development build (Xcode 27, iOS 26.5 runtime), a listener on the native
`ExpoWidgets` module's `onExpoWidgetsPushToStartTokenReceived`, added through the debugger,
received one token of 256 hex characters (value not recorded) within 25 s, without a device.
Both layouts were in the App Group's defaults after launch
(`__expo_widgets_PlaneAheadPlaceholder_layout`,
`__expo_widgets_live_activity_FlightActivity_layout`), and an activity started from the stored
layout made the extension process run a render batch that ended in success (it was then ended;
the Simulator screenshot does not draw the Dynamic Island, so the rendering was not seen).
The app's own listener was not exercised end to end: it runs for a session user, and no API is
reachable from this machine; `__tests__/live-activity-tokens.test.ts` covers it.

### Content state size

As built, the "worst case" in `__tests__/content-state-size.test.ts` was a hand-picked fixture
(693 bytes), while the schema admitted unbounded free text and kept unknown keys: the review
parsed a 5.8 KB state (ruling Z2). Since the review every field is bounded and the worst case is
the schema's own: each field at its bound, each free-text field filled with a control character,
whose double JSON encoding costs 7 bytes (`\\u0001`), the most of any of the 65,536 UTF-16 code
units (the test proves it; a double quote costs 4), instants at nanosecond precision, the
longest number JSON prints between 0 and 100. It comes to 1,355 bytes as JSON, 1,593 bytes as the
stored `{ name, props }`, 66 bytes of attributes: **1,659 bytes** of the 4,096 budget (the
review's quote-heavy shape, 1,251). The Phase 1 push-to-start payload carrying it with an alert
is 1,935 bytes.

## Verification on the build's tree (2026-09-23, this machine)

`scripts/native-smoke.sh`, all eight steps, exactly as the nightly runs them (production variant,
`APNS_ENVIRONMENT=production`), with Xcode 27.0 standing in for the 26.6 gate leg:

- `ios-prebuild`: the generated app entitlements say `aps-environment` `production`; the app, the
  widget extension and both watch shells carry `group.app.planeahead.mobile`;
  `xcodebuild -list` shows the four targets. 51 s with `pod install` (132 pods).
- `ios-build`: Release for the iPhone 17 Pro simulator, `-destination` only,
  `ONLY_ACTIVE_ARCH=YES`: **BUILD SUCCEEDED** (121 s incremental; a first Release build without
  `ONLY_ACTIVE_ARCH`, which also compiles an x86_64 slice, succeeded too).
- `ios-archive`: the app holds `PlugIns/ExpoWidgetsTarget.appex` (`app.planeahead.mobile.widgets`,
  its runtime bundle, the App Group) and `Watch/PlaneAheadWatch.app` with its complication, both
  `WATCHOSSIMULATOR`; the app itself `IOSSIMULATOR`.
- `ios-launch`: alive 45 s after launch, on the sign-in screen (no API is reachable), with both
  widget layouts in the App Group's defaults: the embedded Release bundle ran and registered
  them.
- `android-prebuild`, `android-build` (`arm64-v8a` only here, 4 GB heap), `android-archive`,
  `android-launch`: the Wear module included and no widget receiver; **BUILD SUCCESSFUL**; the
  app APK carries `OngoingNotificationModule` and the Wear APK `NextFlightTileService`; on the
  `Pixel_10_Pro_Fold_-_EMU` AVD (Android 37, arm64), which accepted adb this time, the debug
  build (the dev launcher) was alive 45 s after launch with no fatal in logcat. That launch ran
  no JavaScript: the debug APK embeds none. The review round replaced it (below).

## Verification after the review round (2026-09-23, this machine)

The same eight steps on the review round's tree, production variant, Xcode 27.0 again standing
in for the 26.6 gate leg; commands and full results in `docs/increments/11-verification.md`.

- `ios-prebuild`: as before, plus `ExpoWidgetsTarget` Release at `-O` with
  `ENABLE_DEBUG_DYLIB = NO` (`xcodebuild -showBuildSettings`; Debug unchanged) and the watch
  target with `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon`.
- `ios-build`: **BUILD SUCCEEDED**, 1 min 56 s from empty derived data.
- `ios-archive`: as before, plus the watch app's `Assets.car` and its `CFBundleIconName`
  (`AppIcon`, under `CFBundleIcons.CFBundlePrimaryIcon`, where the iOS app records its own), and
  no debug dylib: the extension is one optimised 7.98 MB binary where it was a 40 KB stub plus an
  8 MB `ExpoWidgetsTarget.debug.dylib` and `__preview.dylib`. Both new checks fail when their
  condition is planted.
- `ios-launch`: alive after 45 s on the sign-in screen, both layouts in the App Group.
- `android-prebuild`: `expoAutolinking.exclude = ['expo-widgets']` in settings.gradle; with
  `PLANEAHEAD_ANDROID_WIDGETS=1` the line is absent and the widget receiver present.
- `android-build`: `assembleDebug assembleRelease` (arm64-v8a), **BUILD SUCCESSFUL** in
  2 min 16 s.
- `android-archive`: the release APK embeds `index.android.bundle`; no WorkManager or Glance
  component in either manifest; the release APK's 26 permissions are exactly the expected list,
  every one from increment 9's dependencies or the template, none `FOREGROUND_SERVICE`.
- `android-launch`, now the RELEASE APK: on the same AVD, alive 45 s after launch with no
  `FATAL EXCEPTION` for the app and no `ReactNativeJS` error; logcat shows
  `ReactNativeJS: Running "main"` and the screen the sign-in screen, which the `(app)` layout
  redirects to after importing the token listeners and `widgets/`, so those imports ran on
  Android.

## Open Phase 1 decisions

1. **The 8-hour limit against long-haul flights.** An activity is active for 8 hours and stays
   on the Lock Screen for 12. Either start the activity late (boarding or T-2h) and re-start it
   by push-to-start on the landing approach when the first one has ended, or split the flight by
   phase (departure, cruise, arrival), each its own activity. Both need the push-to-start token
   this increment registers; the second needs `live_activities` to track a chain per flight.
2. **Per-activity tokens:** the `live_activities` writes, the invalidation of a rotated token,
   and whether the app or the push-to-start path creates the row. The Phase 0 listeners attach
   only to the activities alive when they start (on mount and for each new user); an activity
   push-started while the app runs gets none until the next start (ruling Z6). Phase 1 re-runs
   `getInstances()` when the app becomes active and after any start, attaching listeners to new
   activity ids only.
3. **`frequentUpdates`** and the push budget at the tracker's cadence (Apple publishes no number).
4. **Privacy manifests for the extensions:** Apple wants one per executable using a
   required-reason API; Expo writes only the app's (facts section 2 open question).
5. **Android:** adopt expo-widgets' Android widgets with SDK 58, whose Glance is 1.2.0-rc01 (a
   release candidate) under 57.0.20 and brings WorkManager 2.7.1 with `FOREGROUND_SERVICE`; the
   module stays unlinked until then (decision 7), and adopting it means adding that permission
   to the nightly's expected list and checking the privacy answers. Live Updates need compileSdk
   36.1 (or androidx.core's call), the `POST_PROMOTED_NOTIFICATIONS` permission and a
   notification channel.
6. **Retire `apns_live_activity_start`**, which nothing sends, in a later migration.
7. **The push-to-start token's lifecycle, a gate on the Phase 1 push-to-start sender** (ruling
   Z1). Nothing sends a push in Phase 0, so neither gap harms anyone yet; both must be closed
   before the sender ships.
   - (a) Sign-out leaves the token bound to the old account. `forgetAccount` signs out, the app
     returns to the sign-in group without a new session, and nothing re-posts or invalidates the
     token (Better Auth's sign-out request carries no `X-Install-Id`, so the server cannot tell
     which device left). A handed-down phone would be push-started with the previous owner's
     flight. The fix: an invalidate-by-install-id call from `forgetAccount` before `signOut`, or
     `X-Install-Id` on the auth client's sign-out so the server invalidates that device's rows.
   - (b) Rotation leaves every earlier token a live row: `push_tokens` is unique on
     `(kind, token)` only, so a sender that fans out to every live row could start duplicate
     activities. The fix: invalidate the other rows of the same `device_id` and kind on
     registration, or have the sender use only the newest row per device.

## Consequences

- Easier: every surface compiles from day one, so Phase 1 fills layouts and handlers instead of
  fighting generated projects; a nightly that launches the apps catches the dyld class of failure
  a compile misses; the APNs environment of every token follows the signing.
- Harder: two pbxproj writers, one of them an alpha, touch every iOS prebuild, and a version bump
  of either is a new spike; the widget build relies on pnpm's default hidden hoisting; two
  corrections to expo-widgets' generated output (`plugins/withExpoWidgetsBuild.ts`) to re-check
  on every bump; three more bundle ids per variant to register with Apple; a list of expected
  Android permissions to keep in step with the dependencies; the nightly costs macOS runner
  minutes and a release Android build.
- Reversibility: high for the Android stub, the Wear module and the watch shells (delete the
  directory and the plugin entry); medium for expo-widgets (the layouts are JavaScript, but the
  bundle ids and App Groups the extension uses are permanent once shipped).

## Alternatives considered

| Option                                                 | Why not                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Hand-written WidgetKit and ActivityKit targets (Swift) | A second UI codebase for Phase 1 to keep in step with the app; expo-widgets renders the same layouts from JavaScript     |
| A `widgets[]` entry for the Live Activity              | An entry without families generates an invalid target (facts section 5)                                                  |
| `withEntitlementsPlist` in the last plugin             | Measured to lose to expo-widgets: mods listed last run first                                                             |
| Storing per-activity tokens in `push_tokens`           | N rotating tokens per device with an invalidation duty; `push_tokens` is one row per `(kind, token)` and per device kind |
| Watch shells deferred to Phase 2 without trying        | The spike passed in a fraction of its time box; the `bannerSmall` region already reaches a paired watch without them     |
| csark0812/expo-targets instead of apple-targets        | Not evaluated; apple-targets passed, and a third pbxproj writer would be a new spike                                     |
| Hand-written Kotlin Glance widget                      | Redundant with expo-widgets' Android widgets, which SDK 58 supports                                                      |
| Nightly builds on EAS                                  | The Starter credit does not cover nightly iOS builds (facts section 2)                                                   |
| A compile-only nightly                                 | A dyld failure builds clean and dies at launch (apple-targets #194)                                                      |

## References

- `docs/increments/09-11-mobile.facts.md` section 5 and its native-surfaces open questions
- https://docs.expo.dev/versions/latest/sdk/widgets/
- https://raw.githubusercontent.com/expo/expo/sdk-57/packages/expo-widgets/plugin/src/ios/withPushNotifications.ts
- https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities
- https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications
- https://developer.android.com/develop/ui/views/notifications/live-update
- https://github.com/EvanBacon/expo-apple-targets
- https://docs.expo.dev/build-reference/infrastructure/
