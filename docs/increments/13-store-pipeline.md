# Increment 13: store pipeline

Status: built (2026-09-30); what ran, the owner's commands and what stays unverified are in
`docs/increments/13-verification.md`. Builder: Opus 5.5. Reviewers: two Opus 5.5 lenses (store
compliance and build system; native smoke and tests) plus the orchestrator's read. Branch
`inc13-store-pipeline`, stacked on `fix-android-nightly-disk` (PR #13), because both change the
native smoke.

Read first: `docs/plans/phase1-plan.md` (section 2 item 6, section 3 rows Distribution and
Toolchain, section 8 row 13, section 10), `docs/research/phase1/R5-store-distribution.md` (all of
it; facts F11 to F13, E3 to E12, G9 to G11, L1 to L9 and conflicts C1 to C11 drive this spec),
`docs/adr/0001-expo.md`, `docs/adr/0005-identifiers.md`, `docs/adr/0008-expo-widgets.md`,
`apps/mobile/eas.json`, `apps/mobile/app.config.ts`, `apps/mobile/plugins/`,
`apps/mobile/targets/`, `scripts/native-smoke.sh`, `.github/workflows/native-smoke.yml`,
`tools/workflows/native-smoke.test.js`, `docs/runbooks/first-deploy.md`.

## Goal

Everything the first TestFlight and Play internal uploads need that the repository can provide,
proven locally and by the native smoke, so that the owner's first interactive EAS production build
produces binaries App Store Connect and Play accept. No uploads happen in this increment: no Apple,
Google, Expo or Firebase account exists yet.

## Rulings

- **S1. Privacy manifests for every executable bundle the project owns.** A post-order config
  plugin (a base mod that runs the rest of the chain first, like `withExpoWidgetsBuild`), listed
  next to it in `app.config.ts`, adds a `PrivacyInfo.xcprivacy` to the Resources build phase of
  `ExpoWidgetsTarget`, `PlaneAheadWatch` and `PlaneAheadWatchWidget`. The widget extension declares
  `NSPrivacyAccessedAPICategoryUserDefaults` with the App Group reason (`1C8F.1`; confirm the code
  against Apple's required-reason list and cite it), because expo-widgets' `WidgetsStorage` is
  `UserDefaults(suiteName:)` (R5 L2); each declares `NSPrivacyTracking` false and no collected data
  types. The watch shells call no required-reason API today (R5 L3), so theirs declare none, and a
  later API use extends an existing file. The plugin fails the prebuild if a target it expects is
  missing.
- **S2. The smoke proves the manifests.** `ios-archive` fails unless every `.app` and `.appex`
  under the Release product carries a `PrivacyInfo.xcprivacy`, and unless each executable's
  undefined symbols (`nm -u`) that match a required-reason category are declared in its bundle's
  manifest. The symbol table is data (category, symbol patterns), exposed as an internal classifier
  subcommand like `permissions-differ`, and unit-tested in `tools/workflows/native-smoke.test.js`.
- **S3. Versions align across embedded bundles.** A post-order plugin sets `MARKETING_VERSION` of
  every app extension and watch target to the app's `version` and `CURRENT_PROJECT_VERSION` to the
  app's build number, after @bacons/apple-targets hard-codes `1.0` (R5 L4); EAS rewrites only
  `CFBundleVersion` (R5 L5). `ios-archive` fails unless every embedded bundle's
  `CFBundleShortVersionString` equals the app's.
- **S4. An unsigned device archive in the iOS smoke.** A new step `ios-device-archive` runs
  `xcodebuild archive` for `generic/platform=iOS` in Release with `CODE_SIGNING_ALLOWED=NO` and
  applies the S2 and S3 checks to the archive's app, so the device SDK (arm64, the watchOS device
  slices) compiles every week, not only the simulator. It runs after `ios-launch` in the workflow;
  the tools test's step list includes it. It costs roughly 10 to 20 more macOS minutes a run, which
  the weekly cadence absorbs.
- **S5. 16 KB page sizes in the Android smoke.** `android-archive` runs the build-tools'
  `zipalign -c -P 16 -v 4` on the release APK and checks that every 64-bit `.so` in it has LOAD
  segment alignment of at least 16384 (the NDK's `llvm-readelf -l`); either failure fails the step
  (R5 G9 to G11; the current native set passes, R5 L1).
- **S6. `eas.json`.** Pin `ios.image` to `macos-tahoe-26.5-xcode-26.6`, `ios.cocoapods` to
  `1.17.0` and `android.image` to `ubuntu-26.04-jdk-17-ndk-r27b-sdk-57` for every build profile
  (R5 E3, E4, C3). Set `SENTRY_DISABLE_AUTO_UPLOAD` to `true` in the build profiles' `env` until
  Sentry exists, because the Sentry build phase fails a Release build whose upload fails (R5 L6,
  C11); the runbook says when to remove it. The `production` submit profile gets
  `android.track: "internal"` and the settings EAS needs for an unattended submit once the owner
  adds `ios.ascAppId` after creating the App Store Connect record (R5 E6 to E8, C1); document that
  one manual step rather than committing a placeholder id.
- **S7. `ios.appleTeamId` from the environment.** `app.config.ts` reads `APPLE_TEAM_ID` and sets
  `ios.appleTeamId` when present (apple-targets warns without it); absent, nothing changes.
- **S8. Runbook and docs.** `docs/runbooks/first-deploy.md` gains the store steps in order: the App
  Store Connect record (name, bundle id, SKU; both permanent, R5 F5), the internal TestFlight group
  with automatic distribution, the team API key stored in EAS, the Play app and its internal
  tester list, the Play service account stored in EAS, the first interactive
  `eas build --profile production` for iOS (App Groups need an Apple ID login, R5 E9) and for
  Android, `eas submit`, the hybrid-signing fingerprints into `ANDROID_SHA256_FINGERPRINTS` and the
  Google OAuth Android clients (R5 G15), and the export-compliance attestation behind
  `ITSAppUsesNonExemptEncryption: false` (R5 F15). ADR 0005 cites Apple's statement that a bundle
  id cannot change after an upload (R5 F5). `docs/increments/13-verification.md` records what ran,
  the owner's commands and what stays unverified.

## Acceptance

- A production prebuild writes the three manifests into the right targets, the version alignment,
  and the pinned settings; the config-plugin tests prove each plugin against a generated project,
  including the failure when an expected target is missing.
- Locally on Xcode 27: `ios-prebuild`, `ios-build`, `ios-archive`, `ios-launch` and the new
  `ios-device-archive` pass; planted failures (a manifest removed, a version mismatch, an
  undeclared required-reason symbol) fail the right step.
- Locally: `android-build` (x86_64) and `android-archive` with the 16 KB checks pass; a planted
  misaligned library fails.
- The tools tests cover the new classifier and the step list; the full check is green.
- The upload itself is unverified until the owner's accounts exist; the verification doc lists the
  exact commands.

## Out of scope

Accounts, credentials, uploads, push code, and any change to the API.
