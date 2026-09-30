# Increment 13 verification: store pipeline

Branch `inc13-store-pipeline` (stacked on `fix-android-nightly-disk`), 2026-09-30. This file
records what ran on the build machine with its result, what the build found that the research
sheet did not, the exact commands the owner runs, and what stays unverified until the accounts
exist. The spec is [13-store-pipeline.md](13-store-pipeline.md); the research behind it is
`docs/research/phase1/R5-store-distribution.md` (R5 below). The increment's review round (rulings
F1 to F13 and G3 to G7) changed the smoke's schedule and checks, the version plugin and the
runbook; what it changed and what ran for it are in [Review round](#review-round) at the end, and
the sections before it are corrected where the round made them wrong.

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
  on 2026-09-29 (run 36570838498), so the archive adds about 16 macOS minutes to a gate leg of
  about 22 billed minutes (the smoke reviewer's measurement, which also puts the Xcode 27 leg at
  about 1.5 while it fails at selection). The review round therefore runs the archive on a
  release check only, before each store build, and keeps the weekly run at about 22 (ruling F1,
  runbook step 15).
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
   holds no manifest at all. The build treated the app's own manifest as enough; the review
   round did not (rulings F5 and G3): Apple wants the manifest in the bundle that holds the
   executable, and App Store Connect rejects the prebuilt ExpoFileSystem for exactly this
   (expo/expo#50503, ITMS-91053). So the smoke now checks each framework on its own,
   ExpoFileSystem is built from source into the app's binary, under the app's manifest, until SDK
   58, and React Native's two prebuilt frameworks are allowed without one. `hermes` on Apple's
   list of commonly used SDKs is not Meta's Hermes: Apple's statement, relayed by the React
   Native team on 2024-04-09
   ([discussions-and-proposals#776](https://github.com/react-native-community/discussions-and-proposals/discussions/776)),
   so `hermesvm.framework` owes neither a manifest nor a signature under that rule. That rule
   (ITMS-91061) marks a build Invalid Binary at upload, so it would block TestFlight as well as
   App Review for an SDK it does list. GoogleSignIn, which it lists, is built from source here and
   ships its manifest in `GoogleSignIn.bundle`. R5 U5 is closed.

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

1. As the Account Holder, accept every pending agreement at developer.apple.com/account and in
   App Store Connect > Business, before any API key or upload.
2. App Store Connect record (`PlaneAhead`, `app.planeahead.mobile`, SKU `planeahead-ios`), then its
   Apple ID into `apps/mobile/eas.json` as `submit.production.ios.ascAppId`, with the matching
   change to the assertion in `__tests__/app-config.test.ts`, committed.
3. Internal TestFlight group with automatic distribution; the testers as App Store Connect users.
4. Team API key: `eas credentials --platform ios` (production), App Store Connect API key.
5. Play Console app (its contact email `support@planeahead.app`) and its internal testers' email
   list.
6. Play service account: `eas credentials --platform android` (production), Google Service
   Account.
7. Confirm the export compliance attestation behind `ITSAppUsesNonExemptEncryption: false`
   before the first build: the key in the binary is the answer for every build.
8. Check the production EAS environment: `GOOGLE_IOS_CLIENT_ID` and the other inputs present
   (a production build refuses to evaluate without the client id), `IOS_DEVELOPMENT_TEAM` absent.
9. The release check, before every production build and after any native dependency or Xcode
   bump: `gh workflow run native-smoke.yml -f platforms=all -f release_check=true`, then
   `gh run watch`; the Xcode 26.6 and Android legs green.
10. `eas build --platform ios --profile production`, interactively, logged in with the Apple ID.
11. `eas build --platform android --profile production`.
12. `eas submit --platform ios --profile production --latest` and
    `eas submit --platform android --profile production --latest` (the draft-app fallback, a
    `production-draft` submit profile and a manual roll-out, is in the runbook).
13. The signing fingerprints into `ANDROID_SHA256_FINGERPRINTS` and the Google OAuth Android
    clients.
14. When Sentry exists: remove `SENTRY_DISABLE_AUTO_UPLOAD` from `eas.json` `build.base.env`.
15. Later builds from CI, each after its release check:
    `eas build --platform all --profile production --auto-submit --non-interactive`.

The weekly smoke on GitHub, once Actions minutes are available (runbook step 15), runs the Xcode
26.6 gate leg and Android without the device archive; the release check above adds the archive
("Archive for a device, unsigned, and assert every bundle's manifest and version"), arm64-v8a
and the Xcode 27 leg.

## Unverified

- **The uploads.** Whether App Store Connect processes the first build without an ITMS-91053
  email (a required-reason API without a declared reason), an ITMS-90473 version email or an
  Invalid Binary, and whether Play accepts the first AAB on the internal track; needs the
  accounts (runbook step 18, check item).
- **Xcode 26.6.** Every iOS step here ran on Xcode 27, ExpoFileSystem's build from source
  included; the gate leg's Xcode 26.6, which the EAS image also has, runs on GitHub only.
- **The release check on GitHub.** It has never run: no Actions minutes. Whether the device
  archive fits the `macos-26` runner's 120-minute timeout after the rest of the gate leg (the
  local archive took 99 s after a warm build), and whether the Android runner keeps the 30 GB the
  two-ABI build now asks for, are its first run's to show.
- **Signed builds and EAS's numbers.** The device archive is unsigned; whether signing or App
  Store Connect refuses a watch version mismatch (finding 2) is proven by the first EAS build.
  That EAS exports `EAS_BUILD_IOS_BUILD_NUMBER` and `EAS_BUILD_IOS_APP_VERSION` to the prebuild
  is eas-cli's source (`packages/worker/src/env.ts`); the smoke gives the build number the same
  way (4242) and the local build carried it into every bundle, but no EAS build has run.
- **The EAS images and CocoaPods pin.** `macos-tahoe-26.5-xcode-26.6`,
  `ubuntu-26.04-jdk-17-ndk-r27b-sdk-57` and CocoaPods 1.17.0 are Expo's published names (R5 E3);
  no EAS build ran, so whether EAS accepts them and how long installing CocoaPods 1.17.0 adds are
  unmeasured. Likewise the `eas env:list --environment production` form the runbook gives:
  eas-cli is not installed here.
- **React Native's prebuilt frameworks without manifests.** `React.framework` and
  `ReactNativeDependencies.framework` use required-reason APIs and carry no manifest; the check
  allows them on the ruling that no rejection of that prebuilt core has been reported (F5). If
  the first upload's email names one, `ios.buildReactNativeFromSource: true` in
  expo-build-properties links React Native into the app's binary, at the cost of longer builds.
- **A known gap: selector-only required-reason APIs** (ruling F11). `nm` cannot see
  `ProcessInfo.systemUptime`, `UIDocument.fileModificationDate` or
  `UITextInputMode.activeInputModes` (the whole active keyboards category): they leave no
  undefined symbol, so a new use of one passes the check. A scan of this round's archived
  executables and frameworks for the three selector names found `systemUptime` and
  `fileModificationDate` (ExpoFileSystem's, now linked in) in the app's executable only, whose
  manifest declares SystemBootTime and FileTimestamp; no extension, watch shell or framework has
  any. A new selector-only use needs its declaration by hand.
- **Before the first App Store submission (not TestFlight)** (ruling G7). The production archive
  carries expo-dev-client's `NSLocalNetworkUsageDescription` ("Expo Dev Launcher uses the local
  network..."), `NSBonjourServices` (`_expo._tcp`) and `NSAppTransportSecurity`
  `NSAllowsLocalNetworking` (checked in the archive of this round). App Review may ask why a
  store app declares local-network access it never uses; decide before the first submission
  whether production builds keep expo-dev-client, and remove the keys from them if not. No code
  change in this increment.
- **The first Play submit.** Whether `eas submit` can create a brand-new app's first internal
  release, or Play answers that only a draft release may be created on a draft app, and what
  ends the draft state (R5 U14); the runbook gives the `production-draft` fallback.

## Review round

Two Opus 5.5 reviewers read `980d772`: one through the native smoke and its tests (findings
smoke-1 to smoke-13), one through store compliance and the build system (store-1 to store-7). The
orchestrator's rulings settle each: F1 to F13 for the smoke findings and the two the reviews
shared (store-1 with smoke-6, store-2 with smoke-5), G3 to G7 for the rest of the store review.
All of them are applied here. The smoke reviewer's 32 mutants of the script and the workflow had
left 22 alive under the increment's tests: every store check, the device archive's platform
checks, an over-matching table entry, android-archive's 16 KB wiring, the prebuild's manifest
check and four workflow changes.

### By ruling

- **F1 (smoke-1, cost).** Finding: the weekly run paid for the device archive, about 16 billed
  macOS minutes on a gate leg of about 22, and the Xcode 27 leg would double the weekly minutes
  once an image carries Xcode 27. Changed: a `workflow_dispatch` boolean input `release_check`
  (default false) turns on the device archive, on the gate leg only, and the arm64-v8a build
  (F4); the matrix is `["26.6"]` for a scheduled run and `["26.6","27"]` for a manual one; the
  workflow's cost comment and runbook step 15 carry the reviewer's measured table; runbook step 18
  runs `gh workflow run native-smoke.yml -f platforms=all -f release_check=true` before each
  production build and after native dependency or Xcode bumps; open decision 7 records it.
  Proven: the tools tests evaluate the workflow's expressions (`evaluate` and `stepRuns` in the
  test) for a scheduled run, a plain manual run and a release check: the schedule has the one leg
  and never archives, the archive runs only with `release_check` on 26.6, the Android ABIs and
  the disk they ask for follow the input. Mutants W2, W5 and F1a to F1e.
- **F2 (smoke-2, untested checks).** Changed: an internal `store-bundles APP` subcommand runs
  `check_store_bundles`; PlistBuddy comes from `SMOKE_PLISTBUDDY`, plutil, nm and vtool from PATH;
  `tools/workflows/apple-tools-stub.mjs` stands in for the four (XML property lists, and fake
  executables that hold their platform and their undefined symbols per architecture), so the
  checks run on the Linux runner. Tests build a fake app (the app, the widget extension, the
  watch app and its complication, universal like the device slices, and three frameworks) and
  fail it on a missing manifest, an unparsable one, a category without a reason, an entry without
  a category, a non-array `NSPrivacyAccessedAPITypes`, an undeclared API in the nested
  complication's arm64_32 slice and in a framework (with and without a manifest of its own),
  `@AppStorage`, a short-version and a build-number mismatch, and executables nm cannot read or
  lists nothing for (16 cases). ios-archive, ios-device-archive (an xcodebuild stub copies the
  tree into `-archivePath`), ios-prebuild and android-archive (stored-zip APKs, an aapt2 stub, a
  misaligned debug APK beside an aligned release one) run end to end. Irreducibly macOS, and so
  `it.runIf(process.platform === 'darwin')`: Apple's plutil and PlistBuddy give the stand-ins'
  verdicts on the same fixtures (every case above, and tool by tool the same stdout and exit
  status), and the real nm on a universal binary compiled for the test. Proven: all 32 of the
  reviewer's mutants are killed (below).
- **F3 (smoke-3).** Finding: `nm -u` reads only the host's slice of a universal binary, so the
  watch shells' arm64_32 slices went unread, and output with no symbol passed. Changed:
  `nm -u -j -arch all`, and an executable nm lists no undefined symbol for fails. Proven: the
  stand-in nm reads the arm64 slice only without `-arch all`, as Apple's does on this Mac, and a
  symbol planted in the complication's arm64_32 slice alone fails the check; the macOS-only test
  compiles a universal binary whose x86_64 slice alone calls `stat`, which the real nm finds only
  with `-arch all`. Mutants F3a and F3b.
- **F4 (smoke-4).** Changed: the Android step's name says 16 KB pages on x86_64, and arm64-v8a on
  a release check (so do ADR 0008 and the mobile README); and the check fails when a 64-bit ABI
  the build was asked for (`SMOKE_ANDROID_ABIS`) is missing from the release APK (departure 1).
  Proven: tools tests; mutant F4a; the local two-ABI build below.
- **F5 (smoke-5, store-2).** Finding: embedded frameworks were not checked, and the prebuilt
  `ExpoFileSystem.framework`, which references file dates and disk space, carries no manifest,
  for which App Store Connect rejects the upload (ITMS-91053; expo/expo#50503, merged 2026-09-25,
  fixed only in expo-file-system 58.0.2). Changed: every framework whose executable references a
  required-reason API must carry its own manifest that declares it, except
  `FRAMEWORKS_WITHOUT_MANIFEST` (React.framework and ReactNativeDependencies.framework, React
  Native's prebuilt core: no rejection reported, fallback `ios.buildReactNativeFromSource:
  true`); a manifest a framework does carry must parse and give reasons (departure 2).
  `apps/mobile/package.json` builds ExpoFileSystem from source
  (`expo.autolinking.ios.buildFromSource`); package.json holds no comments, so the note to drop it
  at SDK 58 sits in app.config.ts beside expo-build-properties, and an app-config test fails once
  expo-file-system reaches 58 (departure 3). Proven: the builder's device archive fails the new
  check, on `ExpoFileSystem.framework` and its six symbols; this round's from-scratch prebuild and
  device archive have no ExpoFileSystem.framework, its code in the app's binary (which now
  references the disk space keys and `_fstatfs`), its manifest's reasons (FileTimestamp `0A2A.1`
  and `3B52.1`, DiskSpace `85F4.1`) aggregated into the app's manifest, and every check green;
  autolinking resolves the option (app-config test). Mutants F5a to F5d and M8.
- **F6 (smoke-6, store-1).** Finding: the build number comparison could not fail (1 everywhere),
  and EAS's build number never reaches the embedded bundles: they build with
  `GENERATE_INFOPLIST_FILE`, whose `CURRENT_PROJECT_VERSION` wins over the Info.plist EAS
  rewrites, so from the second EAS build they would carry 1 against the app's number. Changed:
  withExtensionVersions takes `EAS_BUILD_IOS_BUILD_NUMBER` and `EAS_BUILD_IOS_APP_VERSION` when
  present (EAS exports both to the whole build, eas-cli `packages/worker/src/env.ts`) and the
  config's values otherwise, never through `ios.buildNumber`, which @expo/fingerprint hashes; a
  value Apple would refuse fails the prebuild (departure 4); its header comment is corrected.
  ios-prebuild gives the prebuild `EAS_BUILD_IOS_BUILD_NUMBER=4242` and writes 4242 into the
  app's `CFBundleVersion`, as EAS does, and unsets any EAS version variable the caller has.
  Proven: a store-bundles prebuild with `EAS_BUILD_IOS_BUILD_NUMBER=7` has 7 in all six embedded
  build configurations and the app target's own untouched; unit tests of the precedence and the
  validation; the ios-prebuild tools test; this round's prebuild wrote 4242 into the six
  configurations and every simulator and archived bundle carries 4242. Mutants F6a to F6c and M1
  to M4.
- **F7 (smoke-7).** Changed: ios-device-archive asserts the archive's
  `ApplicationProperties:ApplicationPath` is `Applications/PlaneAhead.app` and that `Products`
  holds nothing else, which is what makes it an app archive App Store Connect takes rather than a
  generic one. Proven: tools test (a library installed under `Products/usr`, an archive without
  `ApplicationProperties`); this round's archive passes both. Mutants F7a and F7b.
- **F8 (smoke-8).** Changed: `id: prebuild`, and the archive step's `if` is
  `!cancelled() && steps.prebuild.outcome == 'success' && inputs.release_check && matrix.xcode == '26.6'`,
  so it runs after a failed build or launch too. Proven: the tools test models GitHub's implicit
  `success() &&` for a condition without a status function; the archive runs after a failed
  launch and not after a failed prebuild or a cancellation. Mutants F8a to F8c.
- **F9 (smoke-9).** Changed: tools tests pin no step-level `continue-on-error` in either job,
  exactly three `if:` (the two platform conditions and the archive's) and an iOS timeout of at
  least 60 minutes. Mutants W1, W3 and W4.
- **F10 (smoke-10).** Changed: the test parses `REQUIRED_REASON_SYMBOLS` from the script and
  compares it with its own table exactly (the getattrlist family under both categories, in the
  script's order). Mutants C1 to C3 and F11a.
- **F11 (smoke-11).** Changed: `_$s7SwiftUI10AppStorageV*` under UserDefaults, a trailing `*`
  making an entry a prefix that matches every member of the property wrapper, reported once;
  selector-only APIs are a known gap under Unverified. Proven: classifier tests; on the smoke
  reviewer's `@AppStorage` watchOS binary, this classifier names
  `_$s7SwiftUI10AppStorageV12wrappedValue...` under UserDefaults and 980d772's names nothing.
  Mutants F11a and F11b.
- **F12 (smoke-12).** Changed: `platform_of` reads `$1 == "platform"` only. Proven: the
  ios-archive tools test runs under a derived data path that contains "platform", which vtool
  prints first. Mutant F12.
- **F13 (smoke-13).** Changed: nothing in the workflow (one concurrency group per platform
  choice); runbook step 15 says that a one-platform manual run during the weekly run runs that
  platform's legs twice, and that a release check and the weekly run share the `all` group, the
  later cancelling the earlier. Proven: the tools test evaluates the group for each kind of run.
- **G3 (store-3).** Changed: finding 5 clears `hermes` for the right reason (Apple's statement,
  relayed on 2024-04-09 in discussions-and-proposals#776, that the listed Hermes is not Meta's),
  says ITMS-91061 marks a build Invalid Binary at upload, so a listed SDK would block TestFlight
  too, drops "for App Review submissions", and closes R5 U5 (GoogleSignIn, also listed, is built
  from source with its manifest).
- **G4 (store-4).** Changed: runbook step 18 says what ends a new Play app's draft state is
  unverified and gives the fallback (a `production-draft` submit profile that extends
  `production` with `releaseStatus: draft`, then a manual roll-out per release), adds
  `--non-interactive` to the CI command, and names the contact email Play's Create app form asks
  for.
- **G5 (store-5).** Changed: runbook step 18 confirms the export compliance attestation before
  the first build (the binary's `ITSAppUsesNonExemptEncryption` is the attestation), has the
  Account Holder accept pending agreements at developer.apple.com/account and in App Store
  Connect > Business before any API key or upload, and checks the production EAS environment
  before the first build; app.config.ts throws on an EAS builder without `GOOGLE_IOS_CLIENT_ID`
  for preview and production, as it does without `APNS_ENVIRONMENT`. Proven: app-config tests
  (refused on EAS for both variants, the placeholder elsewhere and for development, a real id in
  the URL scheme); the entitlements test's introspection gives the builder its id. Mutants M5,
  M6 and M9.
- **G6 (store-6).** Changed: the app's input is `IOS_DEVELOPMENT_TEAM` (`APPLE_TEAM_ID` is the API
  Worker's variable for the association files); the README, ADR 0001 and runbook step 18 say it
  is for local device builds only and never set in an EAS environment, because `ios.appleTeamId`
  is part of the fingerprinted config. Proven: app-config test (`APPLE_TEAM_ID` no longer reaches
  the config). Mutant M7.
- **G7 (store-7).** Recorded under Unverified as a task before the first App Store submission;
  the keys were read from this round's production archive. No code change.

### What ran

The same machine as above, Xcode 27.0 (27A266a), a dedicated iPhone 17 Pro simulator on iOS 26.5
created for these runs and deleted afterwards, from a frozen copy of the script.

| Check | Command | Result |
| --- | --- | --- |
| Full check | as in the table above | 13 of 14 turbo tasks passed (typecheck and lint everywhere; tools 88, shared 589, db 182, mobile 632 in 35 suites); Prettier clean; the toolchain, exit and migrations guards ok; actionlint and shellcheck clean. `@planeahead/api#test` had 764 passed, 1 skipped and 5 timed out (below) while another agent's API suite and another project's suite ran on the machine; after the last edit, `turbo run typecheck lint test --filter=@planeahead/mobile --force` (which also runs the tools tests and the root lint) passed its 8 tasks in 29 s |
| The API suite on its own | `pnpm turbo run test --filter=@planeahead/api --force`, while the machine stayed shared | @@APIFINAL@@ |
| Tools tests | `pnpm exec vitest run --dir tools` | 88 passed (60 before the round), of which `native-smoke.test.js` 57, two of them macOS only |
| Mobile suites the round changed | `pnpm exec jest __tests__/app-config.test.ts __tests__/store-bundles.test.ts __tests__/entitlements.test.ts` | 49 passed, 4.5 s, five real prebuilds among them (one with `EAS_BUILD_IOS_BUILD_NUMBER=7`) |
| iOS prebuild, from scratch | `rm -rf apps/mobile/ios`, then `scripts/native-smoke.sh ios-prebuild` | passed, 27 s with `pod install`: ExpoFileSystem a source pod (`-lExpoFileSystem`); the app's `CFBundleVersion` 4242 as EAS writes it; `CURRENT_PROJECT_VERSION = 4242` in the six configurations of the three embedded targets, the app target's own left at 1 |
| iOS simulator build | `ios-build`, in the builder's derived data | BUILD SUCCEEDED, 95 s |
| iOS store checks | `ios-archive` | passed, 1 s: the four bundles with their manifests, `0.1.0` and `4242`; seven frameworks and no ExpoFileSystem among them: ExpoFont, ExpoModulesCore, ExpoModulesJSI, ExpoModulesWorklets and hermesvm reference no required-reason API, React and ReactNativeDependencies are allowed |
| iOS launch | `SMOKE_SIMULATOR=<dedicated UDID> SMOKE_GRACE_SECONDS=45 ios-launch` | passed: alive 45 s after launch, 70 s for the step |
| iOS device archive | `ios-device-archive` | ARCHIVE SUCCEEDED unsigned, 99 s: `ApplicationPath` `Applications/PlaneAhead.app`, Products holding it alone, `IOS` and `WATCHOS` platforms, then the ios-archive checks on the archived app, all passing. Its manifest declares FileTimestamp (`C617.1`, `0A2A.1`, `3B52.1`), UserDefaults (`CA92.1`, `C56D.1`, `1C8F.1`), SystemBootTime (`35F9.1`) and DiskSpace (`E174.1`, `85F4.1`), ExpoFileSystem's reasons aggregated in |
| The builder's archive under the new checks | `store-bundles` on its archived app, before this round's archive replaced it | FAIL: `PlaneAhead.app/Frameworks/ExpoFileSystem.framework calls required-reason APIs and carries no PrivacyInfo.xcprivacy of its own`, naming its six symbols (the file creation and modification dates, the file system's free and total size, two volume capacity keys) |
| Planted in copies of this round's archived app | `store-bundles` with the baseline archive's `ExpoFileSystem.framework` copied into `Frameworks/`; then with an empty manifest in `React.framework` | FAIL on `ExpoFileSystem.framework` and its six symbols; FAIL, `React.framework calls required-reason APIs its privacy manifest does not declare` (the allowlist excuses a missing manifest only); the control passed |
| `@AppStorage` | `nm -u -j -arch all` of the smoke reviewer's watchOS `@AppStorage` binary, through `undeclared-reasons` | this script: `_$s7SwiftUI10AppStorageV12wrappedValue_5store...` under UserDefaults; `980d772`'s: nothing |
| Android, x86_64 (the weekly build) | `SMOKE_ANDROID_ABIS=x86_64`, `android-prebuild`, `android-build`, `android-archive` | passed: BUILD SUCCESSFUL in 29 min 51 s, a full rebuild (2,057 of 2,389 tasks ran) with the machine under another agent's test load; zipalign verifies the release APK, all 28 x86_64 libraries align every LOAD segment to 16 KB |
| Android, arm64-v8a and x86_64 (a release check's build) | `SMOKE_ANDROID_ABIS=arm64-v8a,x86_64`, `android-build`, `android-archive` | passed: BUILD SUCCESSFUL in 16 min 51 s after the x86_64 build; zipalign verifies the release APK, and the new check finds both ABIs it asked for: all 56 64-bit libraries (28 an ABI) align every LOAD segment to 16 KB |
| Mutants | `python3 mutate.py`, `python3 jest-mutate.py` (in the session's scratch directory) | 56 of 56 and 9 of 9 killed, the controls passing before and after |

API timeouts. This round changes nothing under `apps/api` or `packages/`, and every API failure in
these runs was a test that timed out while another agent's API suite (increment 14) and another
project's test suite shared the machine; the set differed from run to run, and each file passes
on its own. In the full check: `flight-tracker.finish` ("spaces a poison row out to 16 hours
after five dead-letterings", 60 s), `flight-tracker.lifecycle` ("walks creation to deleteAll with
exactly A2_EXPECTED_POLLS provider calls", 180 s), `flights.refresh` ("turns 500 refreshes inside
60 seconds from 50 users into one provider call", 180 s), `flights.subscribe` ("refuses a flood
through the real PUBLIC_RL binding", 60 s) and `provider-budget` ("holds the per-second rate from
a bucket refilled on read", 180 s), with a "Timeout starting cloudflare-pool runner". In a first
solo run (774 passed, 1 skipped): `auth-session-refresh` ("is NOT refreshed by a /v1 request",
60 s) and `provider-budget` again. In a second (765 passed, 1 skipped): `flight-tracker.finish`
("heals a persist outage longer than the retry window"), `flights.refresh` ("answers 504
refresh_timeout") and `flights.subscribe` ("reserved webhook stubs answer 501"), each at 60 s.
Alone, `flight-tracker.finish` passed 13 of 13, `flight-tracker.lifecycle` 2 of 2,
`flights.refresh` 6 of 6, `flights.subscribe` 23 of 23, `provider-budget` 22 of 22, and
`auth-session-refresh` with `provider-budget` 25 of 25. @@APIFINALPARA@@

### Mutants

The smoke reviewer's harness (`mutate.py`) carried over: one mutant at a time in a mirror of the
files the tools test reads, the native-smoke tools tests run, killed when any test fails. The
reviewer's 32 keep their ids, their text following the script where it moved; W2 is replaced,
because a schedule that skips the archive is now ruling F1. 24 more probe this round's changes,
and 9 more (M1 to M9) the mobile ones, applied in place to `apps/mobile` with the app-config,
store-bundles and entitlements suites run (`jest-mutate.py`). All 65 are killed, so there is no
survivor to justify; the controls before and after each run pass.

| Id | Mutant | Before this round | Now |
| --- | --- | --- | --- |
| S1 | no manifest presence check | survived (0 failing) | killed (3 failing) |
| S2 | no manifest parse check | survived (0 failing) | killed (3 failing) |
| S3 | no reason check | survived (0 failing) | killed (2 failing) |
| S4 | undeclared symbols never fail | survived (0 failing) | killed (8 failing) |
| S5 | nm never run (a constant symbol instead) | survived (0 failing) | killed (10 failing) |
| S6 | short version never compared | survived (0 failing) | killed (2 failing) |
| S7 | build number never compared | survived (0 failing) | killed (3 failing) |
| S8 | appex bundles skipped | survived (0 failing) | killed (10 failing) |
| S9 | ios-archive drops the store checks | survived (0 failing) | killed (1 failing) |
| S10 | ios-device-archive drops the store checks | survived (0 failing) | killed (1 failing) |
| S11 | every category treated as declared | survived (0 failing) | killed (8 failing) |
| D1 | no app platform check | survived (0 failing) | killed (1 failing) |
| D2 | no watch platform check | survived (0 failing) | killed (1 failing) |
| D3 | simulator destination | killed (1 failing) | killed (1 failing) |
| D4 | no default disk guard | killed (1 failing) | killed (1 failing) |
| D5 | no app-exists check | killed (1 failing) | killed (1 failing) |
| C1 | over-match: _open added to FileTimestamp | survived (0 failing) | killed (1 failing) |
| C2 | over-match: _mach_continuous_time added | killed (1 failing) | killed (2 failing) |
| C3 | fstatfs dropped | killed (1 failing) | killed (2 failing) |
| C4 | declarations ignored | killed (2 failing) | killed (21 failing) |
| E1 | 4 KB threshold | killed (2 failing) | killed (3 failing) |
| E2 | empty output passes | killed (1 failing) | killed (1 failing) |
| E3 | arm64-v8a skipped | killed (1 failing) | killed (2 failing) |
| E4 | android-archive drops the 16 KB checks | survived (0 failing) | killed (1 failing) |
| E5 | android-archive checks the debug APK | survived (0 failing) | killed (1 failing) |
| E6 | oldest NDK | survived (0 failing) | killed (2 failing) |
| P1 | prebuild manifest check removed | survived (0 failing) | killed (1 failing) |
| W1 | device archive step may fail silently | survived (0 failing) | killed (1 failing) |
| W2 | device archive back on every run, the schedule included | new (replaces the reviewer's W2, now the ruling) | killed (2 failing) |
| W3 | iOS timeout below a run with the archive | survived (0 failing) | killed (1 failing) |
| W4 | 16 KB step may fail silently | survived (0 failing) | killed (1 failing) |
| W5 | Xcode 27 leg dropped from manual runs | killed (1 failing) | killed (1 failing) |
| F1a | Xcode 27 leg back on the schedule | new | killed (1 failing) |
| F1b | device archive on the Xcode 27 leg too | new | killed (2 failing) |
| F1c | a release check builds no arm64-v8a | new | killed (1 failing) |
| F1d | release_check on by default | new | killed (1 failing) |
| F1e | no more room asked for two ABIs | new | killed (1 failing) |
| F3a | nm reads the host slice only | new | killed (3 failing) |
| F3b | no symbols passes | new | killed (2 failing) |
| F4a | a requested ABI missing from the APK passes | new | killed (2 failing) |
| F5a | frameworks never checked | new | killed (7 failing) |
| F5b | every framework allowed without a manifest | new | killed (3 failing) |
| F5c | the allowlist also excuses an incomplete manifest | new | killed (2 failing) |
| F5d | ExpoFileSystem allowed again | new | killed (2 failing) |
| F6a | prebuild without the EAS build number | new | killed (1 failing) |
| F6b | the app's Info.plist keeps the config's build number | new | killed (1 failing) |
| F6c | the caller's EAS version variables leak into the prebuild | new | killed (1 failing) |
| F7a | ApplicationPath never checked | new | killed (1 failing) |
| F7b | extra products pass | new | killed (1 failing) |
| F8a | no archive after a failed launch | new | killed (2 failing) |
| F8b | archive after a failed prebuild | new | killed (2 failing) |
| F8c | the prebuild step has no id | new | killed (1 failing) |
| F11a | @AppStorage dropped from the table | new | killed (5 failing) |
| F11b | prefix entries match whole symbols only | new | killed (4 failing) |
| F12 | platform matched anywhere in the line | new | killed (1 failing) |
| F2a | store-bundles checks nothing | new | killed (20 failing) |
| M1 | F6: EAS's build number ignored | new | killed (3 failing) |
| M2 | F6: EAS's app version ignored | new | killed (2 failing) |
| M3 | F6: any value accepted | new | killed (1 failing) |
| M4 | F6: the prebuild never reads the environment | new | killed (1 failing) |
| M5 | G5: a store build keeps the placeholder client id | new | killed (1 failing) |
| M6 | G5: development builds refused too | new | killed (1 failing) |
| M7 | G6: the API's APPLE_TEAM_ID read again | new | killed (1 failing) |
| M8 | F5: ExpoFileSystem prebuilt again | new | killed (1 failing) |
| M9 | G5: EAS_BUILD never read | new | killed (1 failing) |

### Departures from the rulings

1. **A requested ABI must be in the APK** (F4). `check_page_alignment` fails when a 64-bit ABI in
   `SMOKE_ANDROID_ABIS` (every ABI when unset) is missing from the release APK, so a release
   check proves arm64-v8a or fails, rather than passing on x86_64 alone.
2. **Manifests are read by count, and framework manifests are always validated** (F2, F5). The
   entries are counted (`plutil -extract ... raw` prints an array's length), so an entry without
   a category or a non-array `NSPrivacyAccessedAPITypes` fails instead of ending the scan
   silently; a framework's manifest is checked whenever present, and the allowlist excuses only a
   missing manifest, not an incomplete one.
3. **Where the SDK 58 note lives** (F5). package.json cannot hold a comment: app.config.ts carries
   it beside expo-build-properties, and an app-config test demands the override while
   expo-file-system is below 58 and its removal from 58 on.
4. **EAS's values are validated** (F6). One to three period-separated integers, Apple's form, or
   the prebuild fails.
5. **Room for two ABIs** (F1). A release check's Android job asks for 30 GB free before the build,
   5 more than the weekly run's 25, following the script's own 5 GB an ABI.
6. **The Play fallback is documented, not committed** (G4). The `production-draft` profile is a
   snippet in the runbook, since the ruling put it there and it may never be needed.
7. **The workflow's expressions are evaluated, not matched** (F1, F8, F9, F13). The tools test
   runs the matrix, the step and job conditions, the Android environment and the concurrency group
   through a small evaluator of the operators the workflow uses, with GitHub's implicit
   `success() &&`.
