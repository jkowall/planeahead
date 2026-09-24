# Increment 11 verification: native surface shells and nightly smoke

Branch `inc11-native-shells` (based on `main` with increments 2 to 10), 2026-09-23. This file
records what ran on the build machine, with its result, the exact commands the owner runs, and
what stays unverified until the nightly runs or a device and an Apple team exist. The spike
results and the design are in [ADR 0008](../adr/0008-expo-widgets.md); this file is the evidence
for the tree as it stands after the review round.

Commits: "Increment 11: native surface spikes" (the three time-boxed spikes of ruling V1),
"Increment 11: native surface shells and nightly smoke" (the build) and "Increment 11: apply
review findings" (the review round, rulings Z1 to Z12, below). The numbers in the first table are
from the review round's final run.

The machine: Xcode 27.0 (27A266a) with the iOS 26.5 runtime on an iPhone 17 Pro simulator,
macOS 27.0, CocoaPods 1.17.0, JDK 21, Node 24.21.0, pnpm 12.5.1 (isolated linker), the Android SDK
with build-tools 35 to 37 and platforms `android-36` and `android-36.1`, and the
`Pixel_10_Pro_Fold_-_EMU` AVD (Android 37, arm64). No Xcode 26.6, no Expo account, no Apple
developer team, no provider keys, no deployed API.

## What ran here

| Check | Command | Result |
| --- | --- | --- |
| Full check | `pnpm turbo run typecheck lint test --force && pnpm prettier --check . && node scripts/toolchain-guard.mjs && node scripts/vitest-exit-guard.mjs && node scripts/mobile-migrations-guard.mjs --base origin/main` | passed, 1 min 46 s: 14 turbo tasks; 2,108 tests passed (tools 36, shared 582, db 178, api 708 with 1 skipped, mobile 604 in 34 suites); Prettier clean; toolchain guard ok; exit guard ok; migrations guard ok (4 migrations, the committed files unchanged). `apps/api` is untouched by the review round |
| `expo prebuild`, production variant, production profile | `scripts/native-smoke.sh ios-prebuild` | passed, 29 s with `pod install`: `aps-environment` `production`; the app, the widget extension and both watch shells on `group.app.planeahead.mobile`; four targets; `ExpoWidgetsTarget` Release `SWIFT_OPTIMIZATION_LEVEL = -O`, `ENABLE_DEBUG_DYLIB = NO` (Debug keeps `-Onone` and the debug dylib); the watch target's `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon` |
| iOS simulator compile (Release, the nightly's) | `SMOKE_DERIVED_DATA=<dir> scripts/native-smoke.sh ios-build` | BUILD SUCCEEDED, 1 min 56 s from empty derived data |
| iOS app contents | `scripts/native-smoke.sh ios-archive` | passed: the extension (`app.planeahead.mobile.widgets`, its runtime bundle, the App Group); the watch app and complication built for `WATCHOSSIMULATOR`; the watch app's `Assets.car` (an `AppIcon`, idiom `watch`) and `CFBundleIcons.CFBundlePrimaryIcon.CFBundleIconName = AppIcon`, where the iOS app records its own; no `*.debug.dylib` or `__preview.dylib` (the extension is one 7.98 MB optimised binary, where the build had a 40 KB stub plus an 8 MB debug dylib) |
| Negative controls of the new iOS checks | a planted `ExpoWidgetsTarget.debug.dylib`, then the watch app's `Assets.car` moved away, `ios-archive` each time | FAIL "the Release app carries debug dylibs"; FAIL "the watch app has no compiled asset catalog (Assets.car)"; passed again once restored |
| iOS launch | `SMOKE_GRACE_SECONDS=45 scripts/native-smoke.sh ios-launch` | passed: alive 45 s after launch on the sign-in screen (no API is reachable); both widget layouts in the App Group's defaults (`__expo_widgets_PlaneAheadPlaceholder_layout`, `__expo_widgets_live_activity_FlightActivity_layout`), so the embedded Release bundle ran |
| `expo prebuild`, Android | `scripts/native-smoke.sh android-prebuild` | passed: the Wear module included, no widget receiver, and `expoAutolinking.exclude = ['expo-widgets']` before `useExpoModules()` in settings.gradle; `expo-modules-autolinking resolve --platform android` with that exclusion lists no expo-widgets |
| Android compile | `ANDROID_HOME=~/Library/Android/sdk ANDROID_SDK_ROOT=~/Library/Android/sdk SMOKE_ANDROID_ABIS=arm64-v8a scripts/native-smoke.sh android-build` | BUILD SUCCESSFUL in 2 min 16 s (`assembleDebug assembleRelease`, 1,999 tasks, Gradle's build cache warm from the build's runs): `app-debug.apk`, `app-release.apk` (signed with the template's debug keystore), `wear-debug.apk` |
| Android APK contents | `scripts/native-smoke.sh android-archive` | passed: the stub module's class and the Tile service; `assets/index.android.bundle` in the release APK; no `androidx.work` or `androidx.glance` component in either APK's manifest; the release APK's 26 permissions exactly the expected list, with no `FOREGROUND_SERVICE` (the manifest merger's report attributes every one to increment 9's dependencies or the template). A first run against a guessed list failed with the diff of the 18 it had missed, which is how the list was written |
| Android launch, the release APK | `SMOKE_GRACE_SECONDS=45 scripts/native-smoke.sh android-launch` on `Pixel_10_Pro_Fold_-_EMU`, headless (`emulator -avd Pixel_10_Pro_Fold_-_EMU -no-window -no-audio -no-boot-anim -no-snapshot-save`) | passed: alive 45 s after launch (the AVD accepted adb headless), no `FATAL EXCEPTION` for the app and no `ReactNativeJS` error; logcat shows `ReactNativeJS: Running "main"` and the screen shows the sign-in screen, which the `(app)` layout redirects to after importing `src/lib/live-activity/tokens.ts` and `widgets/`, so the new startup imports ran on Android |
| The Android widgets trial flag | `PLANEAHEAD_ANDROID_WIDGETS=1 pnpm exec expo prebuild --platform android --no-install` (production variant), then again without the flag | with the flag: no `expoAutolinking.exclude` line and the `APPWIDGET_UPDATE` receiver in the manifest; without it: the exclusion and no receiver |
| Runtime fingerprint probe (ruling Z9) | see "The fingerprint probe" below | the watch's Swift and the Wear module's Kotlin now move the runtime version; the generated icon catalog does not |
| Workflow files | the job-key uniqueness and YAML parse of every workflow (`yaml` 2.9.1, `uniqueKeys: true`) | every workflow parses; no duplicate job key (`native-smoke.yml`: `ios`, `android`) |

### The fingerprint probe

`@expo/fingerprint` 0.20.13, the copy expo-updates resolves, run on apps/mobile with the preview
profile's environment (`APP_VARIANT=preview APNS_ENVIRONMENT=production`), before and after
appending a comment to one file. The absolute values are those of the committed tree at the fix
commit `e12e62a` (the re-review re-ran the probe there; the fixer's earlier values were taken
before its last edits under `targets/`); any later edit under `targets/` or `wear/` changes them,
so what the table proves is the before-and-after relation, not the numbers:

| Change | iOS hash | Android hash |
| --- | --- | --- |
| none | `0f3ef213...` | `a485fbe9...` |
| a generated `targets/watch/Assets.xcassets` (empty, or with the icon set after a production prebuild and both builds) | `0f3ef213...` (ignored) | `a485fbe9...` |
| a comment appended to `targets/watch-widget/Info.plist` | `523ac043...` | `c4fcac3b...` |
| an edit to `wear/src/main/res/values/strings.xml` | `cf6bd48c...` | `a059ef07...` |
| both reverted | `0f3ef213...` | `a485fbe9...` |

Before the fix the review measured a Swift and a Kotlin edit leaving both hashes unchanged; the
fixer's own probe of those two files moved them likewise.
`targets/` and `wear/` are hashed as whole directories for both platforms, so an edit to either
moves both runtime versions: one extra build at most, never an update reaching a build it cannot
run on.

## The review round

The review panel's findings and the orchestrator's rulings Z1 to Z12, as applied. No API code
changed (ruling Z1); `apps/api` is as the build left it.

- **Z1, the push-to-start token's lifecycle** (contracts-and-safety-1). No code change. ADR 0008's
  open Phase 1 decision 7 records both gaps as a gate on the Phase 1 push-to-start sender:
  sign-out leaves the token on the old account (fix: invalidate by install id from
  `forgetAccount` before `signOut`, or `X-Install-Id` on the auth client's sign-out), and
  rotation leaves every earlier token a live row (fix: invalidate the other rows of the same
  device and kind on registration, or send to the newest row per device only). "One per
  installation" is reworded in ADR 0008, `packages/db/src/schema/notifications.ts`,
  `src/lib/live-activity/tokens.ts` and `src/lib/devices.ts` to what the table stores: one row
  per `(kind, token)`, the newest of a device being the current one.
- **Z2, the content state's size** (contracts-and-safety-2). `LiveActivityContentStateV1` bounds
  `gate` (16), `terminal` (32) and `baggageClaim` (32), and also the flight key (32) and every
  instant (30): their grammars alone allow any number of leg digits and any sub-second precision,
  so without those two bounds the schema still had no worst case. The bounds are exported as
  `LIVE_ACTIVITY_FIELD_MAX_LENGTH`. `WORST_CASE_CONTENT_STATE` is built from them with the
  costliest character, a control character at 7 bytes once encoded twice (a quote costs 4), and
  `content-state-size.test.ts` proves no UTF-16 code unit costs more: 1,659 bytes of static plus
  dynamic data. `encodeContentState(state, attributes)` strips unknown keys (`z.object` over the
  shared shape), validates the bounds, and throws `ContentStateTooLargeError` at 4,096 bytes;
  parsing stays loose. Tests: `packages/shared/test/live-activity.test.ts` (each bound, the loose
  parse), `content-state-size.test.ts` (the costliest character, the worst case, stripping,
  refusal at and above the limit).
- **Z3, expo-widgets on Android** (contracts-and-safety-3, build-system-3). While
  `PLANEAHEAD_ANDROID_WIDGETS` is unset, `plugins/withExpoWidgetsBuild.ts` writes
  `expoAutolinking.exclude = ['expo-widgets']` into settings.gradle: the autolinking config can be
  conditional there (the Gradle settings plugin passes `exclude` to `resolve`, whose result both
  links the Gradle projects and generates the package list), so the trial flag turns the widgets
  on and the exclusion off together. The JavaScript keeps working through expo-widgets' non-iOS
  stub. android-archive asserts no `androidx.work` or `androidx.glance` component in either APK's
  manifest and compares the release APK's `aapt2 dump permissions` with an expected list (which
  has no `FOREGROUND_SERVICE`). Tests: `expo-widgets-build-plugin.test.ts`, `widgets.test.ts`
  (one flag for both), `tools/workflows/native-smoke.test.js` (the permission classifier).
- **Z4, a refused registration** (contracts-and-safety-4). `registerDevice` returns
  `{ registered: true }` or `{ registered: false, reason }` from the 200 body's
  `pushTokenSkipped`; increment 9's callers ignore it. tokens.ts logs
  `live_activity_push_to_start_token_skipped` with the reason and the token's length and sends a
  Sentry warning message. Tests: `live-activity-tokens.test.ts` (the 200 plus `pushTokenSkipped`
  case, no token value in any log or message), `devices.test.ts`.
- **Z5, the Android launch runs the JavaScript** (contracts-and-safety-5). android-build runs
  `assembleDebug assembleRelease`; android-archive asserts `assets/index.android.bundle` in the
  release APK; android-launch installs the release APK and fails on a dead process, a
  `FATAL EXCEPTION` whose process is the app, or a `ReactNativeJS` error in logcat. Tests: the
  logcat classifier in `tools/workflows/native-smoke.test.js` (a fatal in another process, or in
  `app.planeahead.mobile.preview`, does not count).
- **Z6, per-activity listeners** (contracts-and-safety-6). No code change: the limitation is in the
  tokens.ts header and ADR 0008's open decision 2.
- **Z7, the arrival pair** (contracts-and-safety-7). `destinationGate` and `destinationTerminal`
  join the schema (optional); `gate` and `terminal` are documented as the origin's. The layout
  prints the destination gate right after the arrival time, in the banner and the expanded
  bottom region, and nothing there when it is absent; in the expanded bottom region the departure
  gate now sits beside the departure time. `destinationTerminal` is carried, not printed, in
  Phase 0. Tests:
  `widgets.test.ts` (what is printed beside each time, with and without the destination gate).
- **Z9, the runtime fingerprint** (build-system-1). `fingerprint.config.js` adds `targets` and
  `wear` as `dir` extra sources and ignores `targets/*/Assets.xcassets/**/*`, the catalog
  apple-targets now generates on every prebuild (it exists on a builder after prebuild and never
  under `eas update`, so hashing it would split the runtime version the way the Google services
  file once did). The app.config.ts comment is corrected. Tests: `app-config.test.ts` (both
  sources listed; Swift, plist and Kotlin sources not ignored; the generated catalog ignored);
  the probe above.
- **Z10, the watch app's icon** (build-system-2). `targets/watch/expo-target.config.js` sets
  `icon` from the variant's app icon (resolved against the target directory); the generated
  catalog is gitignored. ios-archive asserts the icon name and `Assets.car`.
- **Z11, the widget extension's Release settings** (build-system-4). `withExpoWidgetsBuild`'s
  base mod on `xcodeproj` runs the rest of the chain first and then sets `-O` and
  `ENABLE_DEBUG_DYLIB = NO` on `ExpoWidgetsTarget`'s Release configuration; ios-prebuild checks
  them with `xcodebuild -showBuildSettings`, ios-archive fails on any debug dylib. Tests:
  `expo-widgets-build-plugin.test.ts` (the edit, the missing-target failure, and that it lands
  after a mod registered before it rewrote `-Onone`).

## Accepted as built (ruling Z8)

- **Commit trailers.** The two build commits carry `Co-Authored-By: Claude Opus 5.5 (1M context)`,
  the model that wrote them, accepted by ruling Z8. The review round's commit carries the same
  trailer for the same reason: the session's attribution rule names the model that did the work,
  and the fix rules' `Claude Fable 5.1` trailer would misattribute it (reported to the
  orchestrator).
- **The hand-written Swift in the watch targets**: a `@main` `App` and a `@main` `Widget`, the
  minimum each target type compiles, and the only hand-written Swift in the repository.
- **The explicit extension bundle id** `<bundle id>.widgets` instead of expo-widgets'
  `.ExpoWidgetsTarget` fallback, because it is permanent once a build ships.
- **The entitlements test runs `expo config --type introspect`** (the whole plugin chain, per EAS
  profile) rather than a full prebuild per profile; the nightly's ios-prebuild asserts the same
  values with PlistBuddy on the files a real prebuild writes.
- **Release iOS legs**, with `ONLY_ACTIVE_ARCH=YES`, and the Xcode 27 leg's selection by the
  newest `/Applications/Xcode_27*.app` on the `macos-26` image, reporting "Xcode missing" until an
  image carries one.
- **Files beyond the spec's list**: the fixtures and tests, `scripts/native-smoke.sh`,
  `tools/workflows/native-smoke.test.js`, migration 0004 and its snapshot, and in the review round
  `plugins/withExpoWidgetsBuild.ts` and this file.
- **`DB_SCHEMA_VERSION` 5** and the new kind `apns_live_activity_push_to_start` added beside
  increment 3's unused `apns_live_activity_start`, which a later migration retires (ADR 0008,
  open decision 6).

## Commands for the owner

Everything below runs from the repository root; Android needs the SDK exported in the same
shell (`export ANDROID_HOME=~/Library/Android/sdk ANDROID_SDK_ROOT=~/Library/Android/sdk`).

1. **Run the nightly by hand** once the branch is merged: `gh workflow run native-smoke.yml`, then
   `gh run watch`. The Xcode 26.6 leg is the gate; the Xcode 27 leg may fail with "Xcode missing"
   until GitHub's `macos-26` image carries Xcode 27, without failing the run.
2. **The same steps on a Mac**, as the review round ran them:
   ```sh
   export SMOKE_DERIVED_DATA=/tmp/dd-native-smoke SMOKE_GRACE_SECONDS=45
   scripts/native-smoke.sh ios-prebuild && scripts/native-smoke.sh ios-build \
     && scripts/native-smoke.sh ios-archive && scripts/native-smoke.sh ios-launch
   # Android: boot an emulator first (accept "Allow USB debugging?" once if it asks).
   scripts/native-smoke.sh android-prebuild
   SMOKE_ANDROID_ABIS=arm64-v8a scripts/native-smoke.sh android-build
   scripts/native-smoke.sh android-archive && scripts/native-smoke.sh android-launch
   ```
   `SMOKE_DERIVED_DATA` outside `apps/mobile/ios` keeps Xcode's derived data across prebuilds
   (prebuild clears `ios/`).
3. **The first TestFlight upload of each variant** (after the Apple team exists and EAS signs):
   App Store Connect's processing email must not report a missing icon for
   `PlaneAheadWatch.app` (ITMS-90713 class) or reject the extension. Nothing here can prove it
   without a signed archive.
4. **The push-to-start token end to end** on a device or the simulator against staging: sign in,
   then `psql "$DB" -c "select kind, environment, invalidated_at, created_at from push_tokens where kind = 'apns_live_activity_push_to_start' order by created_at desc limit 5;"`.
   Expected: one row per token the device reported, `environment` `sandbox` for a development
   build and `production` for a preview or store build.
5. **The Android widgets trial**, whenever it is wanted: `PLANEAHEAD_ANDROID_WIDGETS=1` on
   `expo prebuild --platform android` turns expo-widgets' Android widgets on and its autolinking
   exclusion off (no hand edit); android-archive then fails on the Glance and WorkManager
   components and `FOREGROUND_SERVICE` until the expected list is widened on purpose (ADR 0008,
   open decision 5).

## Unverified

- **The Xcode 26.6 leg**, the nightly's gate: Xcode 26.6 is not installed here, so only the
  Xcode 27 leg's steps ran. Unverified until the first nightly run.
- **The ubuntu leg as such**: the Android steps ran on macOS against an arm64 Android 37 AVD, not
  on `ubuntu-24.04` with JDK 17 and the API 36 x86_64 `google_apis` image the workflow boots.
- **App Store Connect's acceptance** of the watch app's icon catalog and of the Release extension
  (no Apple team, no device-signed archive).
- **A rendered Live Activity**: the simulator screenshot does not draw the Dynamic Island, and no
  activity is started in Phase 0 (ADR 0008 records the stored-layout render batch the spike saw).
- **The skipped-token path against a real API**: covered by `live-activity-tokens.test.ts` and
  increment 5's route tests; no API is reachable here.
- **The watch app running on a watchOS simulator**: no watchOS runtime is installed; the watch
  binaries are checked by platform and contents only.
