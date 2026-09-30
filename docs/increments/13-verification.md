# Increment 13 verification: store pipeline

Branch `inc13-store-pipeline` (stacked on `fix-android-nightly-disk`), 2026-09-30. This file
records what ran on the build machine with its result, what the build found that the research
sheet did not, the exact commands the owner runs, and what stays unverified until the accounts
exist. The spec is [13-store-pipeline.md](13-store-pipeline.md); the research behind it is
`docs/research/phase1/R5-store-distribution.md` (R5 below).

The machine: Xcode 27.0 (27A266a) with the iOS 26.5 runtime, a dedicated iPhone 17 Pro simulator
created for these runs and deleted afterwards, macOS 27.0, CocoaPods 1.17.0, JDK 21, Node 24.21.0,
pnpm 12.5.1 (isolated linker), the Android SDK with build-tools 35 to 37 and NDK 27.1.12297006.
No Xcode 26.6 (the gate leg's Xcode, and the EAS image's), no Apple, Google Play, Expo or Firebase
account: nothing was signed or uploaded.

## What ran here

| Check | Command | Result |
| --- | --- | --- |
| Full check | `pnpm turbo run typecheck lint test --force --continue --concurrency=2 && pnpm prettier --check . && node scripts/toolchain-guard.mjs && node scripts/vitest-exit-guard.mjs && node scripts/mobile-migrations-guard.mjs --base origin/main && actionlint && shellcheck scripts/native-smoke.sh` | passed, 2 min 5 s for turbo: 14 tasks, none cached; 2,234 tests passed (tools 60, shared 589, db 182, api 777 with 1 skipped, mobile 626 in 35 suites); Prettier clean; the toolchain, exit and migrations guards ok (4 migrations, the committed files unchanged); actionlint and shellcheck clean |
| Config plugins against generated projects | `pnpm --filter @planeahead/mobile exec jest __tests__/store-bundles.test.ts` | 13 tests passed, 4 real `expo prebuild --platform ios --no-install` runs in temporary copies of the app (about 2 s each). The three manifests land in their own targets' Resources phases and match the plugin's data; the app keeps Expo's; every embedded target has the app's version and build number in both configurations; a second run adds nothing; a target removed from the parsed project, a `targets/watch-widget` removed before the prebuild, apple-targets removed from the plugins, and the two plugins listed after it each fail as intended. With the two plugin entries removed from app.config.ts, 9 of the 13 fail (the version test still passes: see finding 1) |
| App config and eas.json | `jest __tests__/app-config.test.ts` | passed: the plugin order, `APPLE_TEAM_ID` to `ios.appleTeamId` (and nothing without it, a malformed id refused), every build profile resolved through `extends` as eas-cli does with the pinned images, CocoaPods 1.17.0 and `SENTRY_DISABLE_AUTO_UPLOAD`, the production submit profile on the internal track without an `ascAppId` |
| `APPLE_TEAM_ID` in a prebuild | `APPLE_TEAM_ID=ABCDE12345 expo prebuild --platform ios --no-install` on a temporary copy | `DEVELOPMENT_TEAM = ABCDE12345` in all eight build configurations of the four targets, and apple-targets' missing-team warning gone; without it, no `DEVELOPMENT_TEAM` and the warning, as before |
| Tools tests | `pnpm exec vitest run --dir tools tools/workflows/native-smoke.test.js` | 29 passed, running the script: every workflow step dispatched (with failing stubs for xcodebuild, xcrun, pnpm, adb, plutil, nm and vtool) and the usage for anything else; `ios-device-archive` calls `xcodebuild archive` for `generic/platform=iOS`, Release, `CODE_SIGNING_ALLOWED=NO`, removes a stale archive first, fails when xcodebuild writes no app, keeps xcodebuild's exit code and stops before it with less than 5 GB free; the `undeclared-reasons` classifier on every symbol of the table, the multi-architecture `nm` layout, the `$INODE64` variant and the either-category rule; `elf-load-misaligned`; `page-alignment` on stored zips built in the test (newest build-tools' zipalign, 32-bit libraries exempt, a planted 4 KB library, no library, an unreadable one); the gate leg's Xcode equal to the eas.json image's. Ten script mutants were planted one at a time (the `$INODE64` rule, the deduplication, the either-category rule, the 32-bit exemption, the 16 KB threshold, `-P 16`, the library count, `CODE_SIGNING_ALLOWED=NO`, the stale archive removal, the step's dispatch); all are caught, two of them (the `$INODE64` rule, the library count) only after the tests gained the cases that catch them |
| iOS prebuild, production variant | `scripts/native-smoke.sh ios-prebuild` | passed, 27 s with `pod install`: the manifests written for `ExpoWidgetsTarget`, `PlaneAheadWatch` and `PlaneAheadWatchWidget` and each passes `plutil -lint`; the earlier assertions unchanged |
| iOS simulator build | `scripts/native-smoke.sh ios-build` | BUILD SUCCEEDED, 125 s from empty derived data |
| iOS app contents and store checks | `scripts/native-smoke.sh ios-archive` | passed, 1 s: every one of the four bundles has its own manifest, which declares every category its executable's undefined symbols need (the app FileTimestamp, UserDefaults, SystemBootTime and DiskSpace; the extension UserDefaults; the watch shells none), and `0.1.0` and `1` |
| iOS launch | `SMOKE_SIMULATOR=<dedicated UDID> SMOKE_GRACE_SECONDS=45 scripts/native-smoke.sh ios-launch` | passed: alive 45 s after launch, 76 s for the step |
| iOS device archive | `scripts/native-smoke.sh ios-device-archive` | ARCHIVE SUCCEEDED unsigned, 143 s after the simulator build in the same derived data (107 s incremental): the app and the extension `IOS` (arm64), the watch app and complication `WATCHOS` (arm64 and arm64_32), and the ios-archive store checks all pass on the archived app. The archive added 2.1 GB of intermediates |
| Android prebuild, build (x86_64), APK checks | `ANDROID_HOME=~/Library/Android/sdk ANDROID_SDK_ROOT=~/Library/Android/sdk SMOKE_ANDROID_ABIS=x86_64 scripts/native-smoke.sh android-prebuild`, then `android-build` and `android-archive` | passed: BUILD SUCCESSFUL in 2 min 36 s; the earlier checks, then `zipalign -c -P 16 -v 4` verifies the release APK and all 28 x86_64 libraries align every LOAD segment to 0x4000 |
| The same with the device ABI | `SMOKE_ANDROID_ABIS=arm64-v8a,x86_64`, `android-build` and `android-archive` | passed: 1 min 33 s; zipalign verifies, all 56 64-bit libraries (28 per ABI) aligned to 16 KB |

Every step above was run again on the committed script after its last change (the device
archive's disk check), and all passed: iOS prebuild 29 s, simulator build 91 s and device archive
99 s (both incremental, 891 GB free before the archive), launch 47 s; Android x86_64 build 1 min
43 s, the APK checks 2 s.

### Planted failures

Each planted in a built product or in the source, run through the step, then undone; the control
before and after passed.

| Plant | Step | Result |
| --- | --- | --- |
| The watch complication's `PrivacyInfo.xcprivacy` removed from the built app | ios-archive | FAIL: `PlaneAhead.app/Watch/PlaneAheadWatch.app/PlugIns/PlaneAheadWatchWidget.appex carries no PrivacyInfo.xcprivacy` |
| The watch app's `CFBundleShortVersionString` set to `1.0` | ios-archive | FAIL: `... PlaneAheadWatch.app CFBundleShortVersionString is '1.0', expected '0.1.0'` |
| The widget extension's `CFBundleVersion` set to `2` | ios-archive | FAIL: `... ExpoWidgetsTarget.appex CFBundleVersion is '2', expected '1'` |
| The widget extension's manifest replaced by one that declares no API | ios-archive | FAIL, printing `_OBJC_CLASS_$_NSUserDefaults NSPrivacyAccessedAPICategoryUserDefaults` |
| The widget extension declaring UserDefaults with no reason | ios-archive | FAIL: `... declares NSPrivacyAccessedAPICategoryUserDefaults without a reason` |
| The watch app's manifest not a property list | ios-archive | FAIL: `... its PrivacyInfo.xcprivacy does not parse` |
| `targets/watch/PlaneAheadWatchApp.swift` reads `UserDefaults.standard` (a later API use, manifest not extended) | ios-device-archive | ARCHIVE SUCCEEDED, then FAIL on `PlaneAheadWatch.app` with `_OBJC_CLASS_$_NSUserDefaults` |
| The watch app's `MARKETING_VERSION` set to `1.0` in the generated project | ios-device-archive | ARCHIVE SUCCEEDED (see finding 2), then FAIL: `... PlaneAheadWatch.app CFBundleShortVersionString is '1.0', expected '0.1.0'` |
| An x86_64 library linked with `-z max-page-size=4096` (LOAD alignment 0x1000), stored and zip-aligned in the release APK | android-archive | zipalign passes, then FAIL: `64-bit libraries with a LOAD segment aligned below 16 KB (0x4000): lib/x86_64/libplanted.so`, its three LOAD lines printed |
| A 16 KB-aligned library stored at an offset off a 16 KB boundary | android-archive | FAIL at zipalign: `lib/x86_64/libaligned.so (BAD - 3866)`, `... is not aligned for 16 KB pages` |

### Before the increment, same machine

The five iOS steps on the unmodified tree (`fix-android-nightly-disk` at `6288fa9`), for
comparison: the simulator build 135 s, an unsigned device archive 131 s and ARCHIVE SUCCEEDED.
Of the four bundles, `ExpoWidgetsTarget.appex` and `PlaneAheadWatchWidget.appex` had no manifest,
and `PlaneAheadWatch.app` had a byte-for-byte copy of the phone app's (finding 3). Every bundle
already had `0.1.0` and `1`. `nm -u` of the archived executables, filtered to the required-reason
symbols: the app `_NSFileCreationDate _NSURLCreationDateKey _OBJC_CLASS_$_NSUserDefaults _fstat
_fstatfs _lstat _stat`; the widget extension `_OBJC_CLASS_$_NSUserDefaults` alone; the watch app
and complication none.

## Measurements

- **macOS minutes the device archive adds.** Locally 143 s against 125 s for the simulator build
  (1.14 times). The weekly gate leg's simulator build took 14 min 24 s on the `macos-26` runner
  on 2026-09-29 (run 36570838498), so the archive should add about 16 macOS minutes, taking the
  gate leg from about 23 to about 39 minutes a run. At $0.062 a macOS minute that is about $10 a
  month of the $12 GitHub Free's 2,000 minutes are worth, before the Android leg and the pull
  request checks (runbook step 15 now says so). The first weekly run after the merge measures
  it.
- **16 KB pages.** The release APK passes `zipalign -c -P 16 -v 4`; every LOAD segment of all 28
  x86_64 libraries, and of all 56 when arm64-v8a is built too, is aligned to 0x4000 (NDK
  27.1.12297006, AGP 8.12.0). R5 L1 measured the same for all four ABIs on `3302d39`.

## Findings the research did not have

1. **The watch version mismatch does not occur with apple-targets 5.0.0.** R5 L4 read
   `configuration-list.js`, which writes `MARKETING_VERSION = 1.0` for the watch targets, but the
   same package's mod ends with `syncMarketingVersions()` (`build/with-xcode-changes.js`), which
   sets every target's `MARKETING_VERSION` to `ios.version` or `version`. The generated project
   had `0.1.0` everywhere before this increment, and the archived watch app and complication
   carried `0.1.0` and `1`. `plugins/withExtensionVersions.ts` keeps the rule as the project's
   own (ruling S3): its test plants the drift in a parsed generated project and the plugin
   removes it; the smoke checks the built bundles.
2. **Xcode 27 archives a watch app whose short version differs from the app's.** With the watch
   app's `MARKETING_VERSION` planted at `1.0`, the unsigned `xcodebuild archive` succeeded and
   only the smoke's check failed. R5 U3 feared `ValidateEmbeddedBinary` would refuse it; it does
   not here, unsigned, on Xcode 27. So the smoke's version check is the only local guard, and
   whether a signed Xcode 26.6 build or App Store Connect refuses the mismatch stays unverified
   (the check keeps it from arising).
3. **The watch app shipped the phone app's privacy manifest.** React Native's CocoaPods privacy
   aggregation (`privacy_manifest_utils.rb`, `ensure_reference`) adds the project's first
   `PrivacyInfo.xcprivacy` to every application target without one, the watch app included, so
   `pod install` gave it the phone app's aggregated manifest (collected data types and all).
   With its own manifest in its Resources phase, the aggregation leaves it alone.
4. **The widget extension needs UserDefaults only.** Its executable's one required-reason symbol
   is `_OBJC_CLASS_$_NSUserDefaults` (expo-widgets' `WidgetsStorage`, `UserDefaults(suiteName:)`,
   the only UserDefaults use in its sources), so ruling S1's single declaration is complete for
   what `nm -u` can see. React Native's privacy bundles copied into the extension
   (`React-Core_privacy.bundle` and two more) are resource bundles, not its manifest.
5. **The embedded frameworks carry no manifest of their own, and three use required-reason
   APIs.** SDK 57 links React Native and the Expo modules as prebuilt dynamic frameworks
   (`RCT_USE_PREBUILT_RNCORE`, `EXPO_USE_PRECOMPILED_MODULES`), and none of the archive's eight
   (`hermesvm`, `React`, `ReactNativeDependencies`, `ExpoModulesCore`, `ExpoModulesJSI`,
   `ExpoModulesWorklets`, `ExpoFileSystem`, `ExpoFont`) has a `PrivacyInfo.xcprivacy` at its
   root (nor a signature, the archive being unsigned). By the smoke's classifier, `React`
   references `NSUserDefaults`, `stat`, `fstat` and `mach_absolute_time`,
   `ReactNativeDependencies` `stat` and `fstat`, and `ExpoFileSystem` the file date and file
   system size keys (and the `fileModificationDate` selector); `ExpoFileSystem_privacy.bundle`
   holds no manifest at all. Every one of those categories is declared, with a reason, in the
   app's own manifest, which is where App Store Connect's ITMS-91053 message asks for them; the
   app's binary also carries the `systemUptime` selector, covered by its SystemBootTime entry.
   Apple's third-party SDK list names `hermes` (R5 F13, U5), for App Review submissions. Out of
   ruling S2's scope (`.app` and `.appex` bundles); the first upload's email says whether App
   Store Connect wants more.

## Departures from the spec

- **S2's symbol table also covers `getattrlist` twice.** Apple lists `getattrlist`,
  `fgetattrlist` and `getattrlistat` under both the file timestamp and the disk space categories;
  the table keeps both, and a manifest that declares either covers them.
- **S3's check also compares `CFBundleVersion`.** The spec names `CFBundleShortVersionString`;
  the plugin aligns `CURRENT_PROJECT_VERSION` too, so the check proves both.
- **S4's step also checks the platform of each archived executable and the free space first.**
  `IOS` for the app and the extension, `WATCHOS` for the watch shells (the point of the step is
  the device SDKs), and 5 GB free before archiving, like the Android build's guard, so a full
  runner disk is a readable failure.
- **S7 validates the value.** `APPLE_TEAM_ID` must be ten uppercase letters or digits, or the
  config refuses to evaluate, as `APP_VARIANT` and `APNS_ENVIRONMENT` do.
- **S6's Android submit profile sets `releaseStatus: completed` explicitly** (the default), so an
  internal release reaches testers without a Play Console step.
- **Where the plugins run.** S1 asks for a post-order mod "like withExpoWidgetsBuild", which edits
  Expo's `xcodeproj` chain; the watch targets do not exist there, so both plugins edit
  @bacons/apple-targets' own project chain (`xcodeProjectBeta2`) instead, listed before
  apple-targets, with a finalized mod that fails the prebuild if that chain never ran.

## The owner's commands

The store steps are `docs/runbooks/first-deploy.md` step 18, in order, after steps 11, 12 and 17.
In short, from `apps/mobile`:

1. App Store Connect record (`PlaneAhead`, `app.planeahead.mobile`, SKU `planeahead-ios`), then its
   Apple ID into `apps/mobile/eas.json` as `submit.production.ios.ascAppId`, with the matching
   change to the assertion in `__tests__/app-config.test.ts`, committed.
2. Internal TestFlight group with automatic distribution; the testers as App Store Connect users.
3. Team API key: `eas credentials --platform ios` (production), App Store Connect API key.
4. Play Console app and its internal testers' email list.
5. Play service account: `eas credentials --platform android` (production), Google Service
   Account.
6. `eas build --platform ios --profile production`, interactively, logged in with the Apple ID.
7. `eas build --platform android --profile production`.
8. `eas submit --platform ios --profile production --latest` and
   `eas submit --platform android --profile production --latest` (the draft-app fallback is in
   the runbook).
9. The signing fingerprints into `ANDROID_SHA256_FINGERPRINTS` and the Google OAuth Android
   clients.
10. The export compliance attestation behind `ITSAppUsesNonExemptEncryption: false`.
11. When Sentry exists: remove `SENTRY_DISABLE_AUTO_UPLOAD` from `eas.json` `build.base.env`.

The smoke on GitHub, once Actions minutes are available (runbook step 15):
`gh workflow run native-smoke.yml -f platforms=ios`, then `gh run watch`; the gate leg now ends
with "Archive for a device, unsigned, and assert every bundle's manifest and version".

## Unverified

- **The uploads.** Whether App Store Connect processes the first build without an ITMS-91053
  email (a required-reason API without a declared reason), an ITMS-90473 version email or an
  Invalid Binary, and whether Play accepts the first AAB on the internal track; needs the
  accounts (runbook step 18, check item).
- **Xcode 26.6.** Every iOS step here ran on Xcode 27; the gate leg's Xcode 26.6, which the EAS
  image also has, runs on GitHub only.
- **Signed builds.** The device archive is unsigned; whether signing or App Store Connect refuses
  a watch version mismatch (finding 2), and the EAS builder's own `CFBundleVersion` rewrite
  (R5 L5) with these targets, are proven by the first EAS build.
- **The EAS images and CocoaPods pin.** `macos-tahoe-26.5-xcode-26.6`,
  `ubuntu-26.04-jdk-17-ndk-r27b-sdk-57` and CocoaPods 1.17.0 are Expo's published names (R5 E3);
  no EAS build ran, so whether EAS accepts them and how long installing CocoaPods 1.17.0 adds are
  unmeasured.
- **Selector-only required-reason APIs.** `nm -u` cannot see `ProcessInfo.systemUptime`,
  `UIDocument.fileModificationDate` or `UITextInputMode.activeInputModes`, which leave no
  undefined symbol. A scan of the archived binaries for those selector names found
  `systemUptime` in the app's executable only (declared) and `fileModificationDate` in
  `ExpoFileSystem` (finding 5); neither extension nor watch shell has any.
- **The frameworks' own manifests** (finding 5, R5 U5). If the first upload's email names a file
  under `Frameworks/` for a missing declaration or manifest, the fallback within this
  repository is to link those libraries statically again, into the app's binary and under its
  manifest: `expo-build-properties` `ios.buildReactNativeFromSource: true` and
  `ios.usePrecompiledModules: false`, at the cost of longer builds; otherwise it is an upstream
  fix in React Native or Expo.
- **The first Play submit.** Whether `eas submit` can create a brand-new app's first internal
  release or Play answers that only a draft release may be created on a draft app (R5 U14); the
  runbook gives the manual fallback.
- **The minutes the device archive costs on the runner**, estimated above from the local ratio.
