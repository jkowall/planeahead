# R5: Shipping to TestFlight and internal Android testing (facts sheet)

Checked 2026-09-30 against primary sources (Apple Developer, App Store Connect Help, Play Console Help, Android Developers, Expo docs and the eas-cli source) and against the repository at main `3302d39`. Every fact below was fetched live on 2026-09-30; quotes are at most 15 words. Local evidence (L-facts) was produced read-only: a release APK built locally from a clean checkout of `3302d39` (x86_64), and the installed package sources of that checkout. Nothing under `/Users/jkowall/PlaneAhead` was modified.

## 1. Questions answered

1. What must exist before the first TestFlight build: a paid Apple Developer membership, explicit App IDs for the app and its three extension targets, the variant's App Group, Push, SIWA and Associated Domains capabilities, signing profiles for four targets, and an App Store Connect app record (F4, F5, F16 to F19, E9, E10).
2. Internal versus external TestFlight: internal (up to 100 App Store Connect users, no review, builds usable once processed) versus external (up to 10,000, first build of each version needs Beta App Review) (F6 to F9).
3. Privacy manifests: required-reason APIs must be declared or App Store Connect refuses the upload (since 2024-05-01), and each executable's own bundle needs its own manifest, so the widget extension needs one (F11 to F13, L2).
4. Export compliance: `ITSAppUsesNonExemptEncryption = NO` covers OS-provided encryption (HTTPS, Keychain) and removes the per-upload questionnaire; without it builds sit in Missing Compliance (F14, F15).
5. Minimum toolchain: Xcode 26 with the iOS 26 SDK since 2026-04-28; iOS 27 SDK (Xcode 27) from April 2027, exact day not yet published; deployment target iOS 13+ since 2026-09-09 (F1 to F3).
6. Play account type: organization avoids the 12-tester, 14-day closed test that gates PRODUCTION for personal accounts created after 2023-11-13; it does not gate the internal track (G1 to G5).
7. D-U-N-S lead time: Apple says up to 5 business days plus 2 for Apple to see it; Google says the D&B process can take up to 30 days (F20, G3).
8. Play internal testing: up to 100 email testers, usable before app setup is complete, exempt from the Data safety form, live within minutes (G6).
9. 16 KB page size: required for apps with native code targeting Android 15+ since 2025-11-01; the developer page says non-compliant updates cannot be released from 2027-02-01; the current release APK passes (G9 to G11, L1).
10. Target API level: API 36 for new apps and updates since 2026-08-31 (extension to 2026-11-01 on request); the repo targets 36; no 2027 date is published yet (G8).
11. Data safety: FCM tokens and install ids fall under "Device or other IDs"; first-party analytics is "collected" for the Analytics purpose, not "shared"; none of it is needed for the internal track (G6, G12, G13).
12. Play App Signing: app bundles are mandatory for new apps and require Play App Signing; new apps now default to quantum-ready hybrid signing with THREE app-signing fingerprints to register (G14 to G16).
13. EAS Starter: $19 a month with $45 of build credit, 1 concurrent build, 2-hour timeout, high priority, large workers; builds cost $1 (Android medium) and $2 (iOS medium) after credit (E1, E2).
14. EAS images for SDK 57: iOS `macos-tahoe-26.5-xcode-26.6` (Xcode 26.6, 17F113), Android `ubuntu-26.04-jdk-17-ndk-r27b-sdk-57` (NDK 27.1.12297006); the Xcode 27 image is aliased to SDK 58 (E3, E4).
15. EAS Submit: iOS via Apple ID or App Store Connect API key, `ascAppId` skips app creation and is required for CI; Android via a Play service account key, the first release can go to the internal track through `eas submit` once the app exists in Play Console (E5 to E8).
16. Is EAS Build needed: no; `eas build --local`, Xcode plus Transporter/altool, or Gradle plus a Play Console upload all work, but local builds ignore the pinned image and would use this Mac's Xcode 27 instead of the 26.6 gate (E11, F10).
17. What blocks the first internal build: accounts, EAS project and credentials, the Sentry upload settings, the App Store Connect record or `ascAppId`, the Play app and service account, and likely the widget extension's privacy manifest and the watch version mismatch (section 3.3).

## 2. Verified facts

All checked 2026-09-30.

### Apple

F1. https://developer.apple.com/news/upcoming-requirements/ : since 2026-04-28 uploads "must be built with Xcode 26 or later using an SDK for iOS 26" (watchOS 26 SDK likewise). Since 2026-09-09, iOS apps "uploaded to App Store Connect must target iOS 13 or later." The page lists no 2027 item yet.

F2. https://developer.apple.com/news/?id=k1mtkt1k (published 2026-09-09, "App Store submissions now open for the latest OS releases"): starting April 2027, iOS apps "must be built with the iOS 27 & iPadOS 27 SDK or later"; watchOS apps with the watchOS 27 SDK. No day of the month is given. It tells developers to use the Xcode 27 Release Candidate now.

F3. https://developer.apple.com/news/?id=ueeok6yw (2026-02-03): the precedent. The Xcode 26 requirement was announced about 12 weeks before its 2026-04-28 effective date.

F4. https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app : creating an app record needs Account Holder, Admin or App Manager and asks for platform, name, primary language, bundle ID, SKU and user access. An app name can be used for "one app per localization."

F5. https://developer.apple.com/help/app-store-connect/reference/app-information/app-information : Bundle ID: "You can't change this property after you upload a build." SKU cannot change after the app is added. Name: at least two and "no more than 30 characters", editable until submitted to App Review.

F6. https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview : up to 100 internal testers (App Store Connect users) and up to 10,000 external testers. For external groups, "A review is required only for the first build." Builds are testable for up to 90 days.

F7. https://developer.apple.com/testflight/ : internal testers are up to 100 team members holding "Account Holder, Admin, App Manager, Developer, or Marketing role". External testing needs the first build approved by App Review for TestFlight; public links can filter by device and OS.

F8. https://developer.apple.com/help/app-store-connect/reference/app-uploads/app-build-statuses/ : "Ready to Submit" means "Your build can be distributed to internal testers" (no review step). "Missing Compliance": "Your build is missing export compliance documentation." "Expired": past "its 90-day availability window." "Invalid Binary": did not meet upload requirements.

F9. https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers : "The first build you submit requires a full review"; one build per version in review at a time; up to six builds for TestFlight App Review per 24 hours; external testers need test information (what to test, feedback email, contact).

F10. https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds : builds can be uploaded with Xcode, altool, Transporter, the App Store Connect API or Xcode Cloud. "Required role: Account Holder, Admin, App Manager, or Developer". The bundle ID and version tie a build to its app and version record, and the build string identifies the build uniquely.

F11. https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api (via its DocC JSON) : "Starting May 1, 2024, apps that don't describe their use of required reason API" are not accepted by App Store Connect. Before that date Apple only emailed a reminder (the ITMS-91053 class).

F12. Same page: for each executable or dynamic library that uses a required-reason API, "the bundle that includes the executable or dynamic library needs to include a privacy manifest". In short, each .appex with such calls needs its own `PrivacyInfo.xcprivacy`.

F13. https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk and https://developer.apple.com/support/third-party-SDK-requirements/ : App Store Connect "rejects app submissions that include invalid privacy manifest files"; from 2025-02-12, apps submitted for review must include a valid manifest for each listed third-party SDK (and a signature when it is used as a binary dependency). This is the ITMS-91061 class; the page ties it to review submissions, not to internal TestFlight uploads. The list includes `hermes`, `GoogleSignIn`, `AppAuth`, `GTMAppAuth`, `GTMSessionFetcher`, Firebase SDKs; Sentry is not on it.

F14. https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption (DocC JSON) : set `NO` if the app, "including any third-party libraries", uses no encryption or only exempt encryption. Without the key, App Store Connect "walks you through an export compliance questionnaire every time".

F15. https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations (DocC JSON) : typically "the use of encryption that's built into the operating system" (for example HTTPS via URLSession) is exempt from documentation upload. https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds : without the answer the beta sits in Missing Compliance and testers cannot get it.

F16. https://developer.apple.com/help/account/identifiers/register-an-app-id/ : App IDs are explicit (one bundle ID) or wildcard; capabilities that need an explicit App ID are disabled for wildcards. One App ID can build iOS and watchOS apps since Xcode 11.4.

F17. https://developer.apple.com/tutorials/data/documentation/xcode/configuring-app-groups.json : "A container ID must begin with `group.` and then a custom string." "You need to register app groups for iOS, iPadOS, tvOS, visionOS, and watchOS apps." Each target that shares the container enables the same group. https://developer.apple.com/help/account/identifiers/register-an-app-group/ : registering needs Account Holder or Admin.

F18. https://developer.apple.com/help/account/capabilities/group-apps-for-sign-in-with-apple/ : each App ID is enabled as a primary or grouped with an existing primary; grouping means users consent once across related apps. "Turning off the Sign in with Apple capability will reset any saved configurations." Ungrouping converts each grouped App ID to a primary.

F19. https://developer.apple.com/tutorials/data/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api.json : "To generate team keys, you must have an Admin account"; key roles mirror user roles; individual keys cannot use provisioning endpoints; "The private key is available for download a single time."

F20. https://developer.apple.com/help/account/membership/D-U-N-S/ : the D-U-N-S number is free; "allow up to 5 business days to receive your number from D&B" and "up to 2 business days for Apple to receive your information", then the organization can enroll. Expediting does not shorten it.

F21. https://developer.apple.com/programs/enroll/ and https://developer.apple.com/help/account/membership/program-enrollment/ : organizations need legal entity status (no DBAs), a D-U-N-S number, legal binding authority, a work email on the organization's domain, and a website that is "publicly available and functional" (registrar parking pages are refused). Individuals need none of that, but their personal legal name is shown as the seller. The fee is "99 USD per membership year".

F22. https://developer.apple.com/support/enrollment/ : an individual membership can be converted to an organization by contacting Apple ("please contact us"). Organizations buy the membership only after Apple Developer Support verifies the enrollment and emails next steps; no duration is published.

### Google Play and Android

G1. https://support.google.com/googleplay/android-developer/answer/14151465 : personal accounts created after 2023-11-13 must run a closed test with at least 12 testers "opted in continuously for at least 14 days" before production access; production review "usually takes seven days or less". It does not apply to organization accounts. Internal testing is available before this.

G2. https://support.google.com/googleplay/android-developer/answer/6112435 : "US$25 one-time registration fee". New personal accounts must "verify that they have access to an Android device using the Play Console mobile app".

G3. https://support.google.com/googleplay/android-developer/answer/13628312 : organization accounts need a D-U-N-S number, legal name, address, phone and website. For D-U-N-S: "This process can take up to 30 days so you should plan ahead." Payment-method verification: "Verification can take up to 5 days". Identity details must be verified "before publishing on Google Play".

G4. https://support.google.com/googleplay/android-developer/answer/13634888 : a personal account can be changed to an organization (new organization payments profile, verified, linked). The reverse is not possible: "Currently, we do not support changing an account from organization to individual."

G5. https://support.google.com/googleplay/android-developer/answer/9859152 : creating an app asks for name, default language, app or game, free or paid, and acceptance of the Play App Signing Terms. "Package names for app files are unique and permanent". https://developer.android.com/build/configure-app-module : never change the application ID after publishing, or Play treats it as a new app.

G6. https://support.google.com/googleplay/android-developer/answer/9845334 : internal testing reaches "up to 100 testers" (email lists). "You can start an internal test before completing app setup." Internal-track apps are "exempt from inclusion in Google Play's Data safety section." A new bundle "becomes available to testers within minutes"; first uploads show a temporary name for up to 48 hours. "Internal tests might not be subject to standard Play policy or security reviews."

G7. https://developer.android.com/developer-verification : Play Console registration covers apps on and off Play and "automatically registers 99% of apps". Sideloaded apps from unverified developers are blocked on certified devices from 2026-09-30 in Brazil, Indonesia, Singapore and Thailand; global rollout 2027 and later.

G8. https://developer.android.com/google/play/requirements/target-sdk and https://support.google.com/googleplay/android-developer/answer/11926878 : since 2026-08-31, "New apps and app updates must target Android 16 (API level 36) or higher"; Wear OS and Automotive need API 35; extension on request "to November 1, 2026". No 2027 requirement is published.

G9. https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html : from 2025-11-01, new apps and updates "targeting Android 15+ devices must support 16 KB page sizes." Compliance shows in Play Console's App bundle explorer.

G10. https://developer.android.com/guide/practices/page-sizes (updated 2026-09-16) : applies to apps targeting API 35+ on 64-bit devices; Java/Kotlin-only apps comply by default. "Starting February 1, 2027", non-compliant updates: "you won't be able to release these updates." Checks: `zipalign -c -P 16 -v 4 app.apk`, `check_elf_alignment.sh`, `bundletool dump config --bundle=app.aab | grep alignment` (want `PAGE_ALIGNMENT_16K`), APK Analyzer and lint. AGP 8.5.1+ packages aligned by default; NDK r28+ compiles aligned; NDK r27 and lower need `-Wl,-z,max-page-size=16384`.

G11. https://support.google.com/googleplay/android-developer/answer/17492799 : "Apps that contain native code must support devices with 16 KB memory page sizes." and must support 64-bit. Wear OS: 64-bit and 16 KB "Required as of 15 Sep, 2026". Upcoming: February 2027, a minimum "25% optimization, obfuscation and shrinking" for apps above 10 MB of DEX; April 2027, apps with sign-in must support Zero-Tap Sign-In restoration (the Restore Credentials API).

G12. https://support.google.com/googleplay/android-developer/answer/10787469 : "Device or other IDs" covers ids for a device, browser or app, including "Firebase installation ID". Collection is "Transmitting data from your app off a user's device". The Analytics purpose covers usage and performance. Transfers to service providers acting on the developer's instructions are not "sharing". Internal-track apps are exempt.

G13. https://firebase.google.com/docs/android/play-data-disclosure : FCM "Collects the FCM token" and Firebase Installations collects a per-installation FID; both are collected automatically. Firebase leaves the Data safety answers to the developer.

G14. https://support.google.com/googleplay/android-developer/answer/9844279 : "Starting August 2021, new apps are required to publish with the Android App Bundle". "To use app bundles, you must enroll in Play App Signing."

G15. https://support.google.com/googleplay/android-developer/answer/9842756 : new apps are "automatically enrolled in quantum-ready, hybrid signing with Google-generated keys" (RSA 4096 plus ML-DSA-65). With hybrid signing "you must copy the fingerprints for three keys and register each of them" with API providers. Android 17+ verifies with APK Signature Scheme v3.2 and older versions use the classical blocks. The default can be changed "before there is a release rolled out in open testing track or production track".

G16. Same page: the upload key is an RSA 2048+ keystore kept by the developer; a lost upload key can be reset; fingerprints are under Protected with Play > Play Store distribution > Play app signing.

### Expo EAS

E1. https://expo.dev/pricing : Free: 15 Android and 15 iOS builds a month, 1 concurrency, 45-minute timeout, low priority, no large workers, updates to 1K MAU. Starter: $19 a month "plus usage", $45 build credit, 1 concurrency (up to 5 extra at $50 each), 2-hour timeout, high priority, large workers, 3K MAU. Production: $199, $225 credit, 2 concurrency. EAS Submit is on every plan. After credit: Android medium $1, large $2; iOS medium $2, large $4.

E2. https://docs.expo.dev/billing/usage-based-pricing/ : the same per-build prices; credits are "reset at the start of the billing period and expire at the end" of it; usage is billed at the end of the period.

E3. https://docs.expo.dev/build-reference/infrastructure/ (and its source `docs/pages/build-reference/infrastructure.mdx`) : SDK 57's image (aliases `latest`, `sdk-57`) is `macos-tahoe-26.5-xcode-26.6`: macOS 26.5.2, Xcode 26.6 (17F113), Node 22.23.1, pnpm 11.9.0, CocoaPods 1.16.2, Ruby 3.2. `macos-tahoe-26.6-xcode-27.0` (Xcode 27.0, 27A266a) is aliased `sdk-58`; an Xcode 27.1 beta image also exists. Android: `ubuntu-26.04-jdk-17-ndk-r27b-sdk-57` (NDK 27.1.12297006). iOS medium is 5 performance cores and 20 GiB; large 10 cores and 40 GiB; Android medium 4 vCPU and 16 GB.

E4. Same page: without `image` in eas.json the build uses the `auto` alias, chosen from the SDK and React Native versions; "SDK aliases will be updated with every new SDK release"; a full image name "guarantees a consistent environment". `ios.image`, `ios.cocoapods`, `android.image`, `android.ndk`, `node` and `pnpm` are valid eas.json fields (schemas under `docs/public/static/schemas/unversioned/`).

E5. https://docs.expo.dev/submit/ios/ (source `docs/pages/submit/ios.mdx`) : `eas submit` prompts for an Apple ID on first run and uploads; the build appears in TestFlight "after processing (usually 10-15 minutes)"; credentials are an App Store Connect API key (`ascApiKeyPath`, `ascApiKeyIssuerId`, `ascApiKeyId`) or an app-specific password; `eas credentials` can create and store the API key; the EAS Workflows `testflight` job can add builds to internal and external groups. Expo's key guide (https://github.com/expo/fyi/blob/main/creating-asc-api-key.md) asks for the Admin role.

E6. eas.json submit schema (`eas-json-submit-ios-schema.js`): `ascAppId`: "When set, results in skipping the app creation step." `groups` names TestFlight internal groups. eas-cli source `packages/eas-cli/src/submit/ios/AppProduce.ts`: without `ascAppId`, eas submit signs in with the Apple ID, registers the bundle ID, creates the App Store Connect app (name from the app config) and an internal TestFlight group.

E7. https://docs.expo.dev/submit/android/ (source `submit/android.mdx`) : prerequisites are a Play developer account, the app created with "Create app" in Play Console, and a Google Service Account key uploaded to EAS. First submission: the default `eas submit` "creates your app's first release on the internal testing track"; the app stays draft until the store listing and setup tasks are done; `releaseStatus: draft` is available. Expo's service-account guide (https://github.com/expo/fyi/blob/main/creating-google-service-account.md) enables the Google Play Android Developer API and grants release, testing-track and store-presence permissions.

E8. https://docs.expo.dev/submit/eas-json/ : a `production` submit profile with `android.track: "internal"` and `ios.ascAppId` is required to run submissions in CI.

E9. https://docs.expo.dev/build-reference/ios-capabilities/ : `eas build` syncs capabilities from entitlements, enabling what is present and disabling what is absent (App Groups, Associated Domains, Push Notifications, Sign In with Apple are supported). "Merchant IDs, App Groups, and CloudKit Containers" are registered only with Apple cookie authentication (a local, interactive run), because the App Store Connect API cannot. eas-cli `capabilityList.ts`: when Sign in with Apple is absent it is enabled with option ON (the code path has no grouping choice), and it is skipped when already enabled with settings. Manual grouping done first therefore survives EAS builds.

E10. https://docs.expo.dev/build-reference/app-extensions/ : CNG projects declare extensions in `extra.eas.build.experimental.ios.appExtensions` so EAS creates their credentials before prebuild. https://docs.expo.dev/build/internal-distribution/ : `distribution: internal` gives an APK on Android and ad hoc provisioning on iOS (a UDID allow-list, 100 iPhones a year, new devices need a rebuild or re-sign; fresh memberships can take 24 to 72 hours to process a new device).

E11. https://docs.expo.dev/build-reference/local-builds/ : `eas build --local` runs the same pipeline on your machine; the only calls to EAS check the project and download managed credentials. `node`, `pnpm`, `cocoapods`, `ndk` and `image` in eas.json are ignored. Secret-visibility variables are not supported.

E12. https://docs.expo.dev/build-reference/app-versions/ : with `appVersionSource: remote` the remote build number starts at 1 on the first build (or from app config) and is written into the native project at build time; app-config build numbers are ignored.

### Local evidence (read-only)

L1. 16 KB, measured: `app-release.apk` built on 2026-09-30 from a clean `3302d39` tree (AGP 8.12.0, NDK 27.1.12297006, all four ABIs, 28 `.so` per ABI) passes `zipalign -c -P 16 -v 4` ("Verification successful"), and all 56 64-bit libraries (arm64-v8a and x86_64: hermesvm, reactnative, NitroModules, NitroGoogleSignin, expo-sqlite, sentry, reanimated, worklets and the rest) have ELF LOAD alignment `0x4000` (`llvm-readelf -lW`).
L2. expo-widgets 57.0.20: the generated widget Swift calls `WidgetsStorage.getString`/`getArray`, and `ios/WidgetsStorage.swift` is `UserDefaults(suiteName:)` (a required-reason API), linked into `ExpoWidgetsTarget`. Neither expo-widgets 57.0.20 nor @bacons/apple-targets 5.0.0 writes a `PrivacyInfo.xcprivacy` for any target. apple-targets links every file in `targets/<name>/` into its target (a synchronized folder), so a manifest dropped there is included.
L3. The watch shells (`targets/watch/PlaneAheadWatchApp.swift`, `targets/watch-widget/PlaneAheadWatchWidget.swift`) call no required-reason API today.
L4. @bacons/apple-targets 5.0.0 `build/configuration-list.js` hard-codes `MARKETING_VERSION: "1.0"` for the watch and watch-widget targets and sets `CURRENT_PROJECT_VERSION` from `ios.buildNumber || 1`. expo-widgets writes the app's `version` (0.1.0) into its extension's Info.plist.
L5. eas-cli `build/ios/prepareJob.ts` sends only `version.buildNumber`, and the builder (`packages/build-tools/src/ios/configure.ts`) writes `CFBundleVersion` into each provisioned target's `INFOPLIST_FILE`. So EAS does not align `CFBundleShortVersionString` across targets.
L6. @sentry/react-native 7.11.0 `scripts/sentry-xcode.sh` sets `exitCode=1` when the source-map upload fails unless `SENTRY_DISABLE_AUTO_UPLOAD=true` (`SENTRY_ALLOW_FAILURE=true` is the other escape). `sentry.gradle` runs the same upload on Android release builds. The nightly sets `SENTRY_DISABLE_AUTO_UPLOAD: 'true'` (`native-smoke.yml:36`), so this path has never run.
L7. expo/expo#47537 (the SDK 57 Xcode 27 defect the repo calls open) was closed 2026-07-06 by PR #47562, released in expo-modules-autolinking 57.0.5 (2026-07-07). The lockfile pins 57.0.13.
L8. GitHub `macos-26` arm64 image 20260907: Xcode 26.6 (17F113) is the default, the same build as the EAS image; CocoaPods 1.17.0, Ruby 3.4.10, Node 24.20.0; no Xcode 27 on that label (https://raw.githubusercontent.com/actions/runner-images/main/images/macos/macos-26-arm64-Readme.md).
L9. Icons `assets/icon-{production,preview,development}.png` are 1024x1024 with no alpha channel. eas-cli latest is 24.8.0, which satisfies `cli.version >= 24.7.0`. react-native-nitro-google-signin depends on `GoogleSignIn ~> 10.0`. React Native 0.86.3 vendors Hermes V1 as `hermesvm.framework`.

## 3. Conflicts with the repository

### 3.1 Conflicts

C1. `apps/mobile/eas.json:49-51`: `"submit": { "production": {} }` has no `ios.ascAppId`, no `android.track`, and no service-account reference. Expo says the production submit profile "is required" in CI (E8). Without `ascAppId`, eas submit falls into the interactive Apple ID app-creation step (E6), so an unattended `--auto-submit` cannot work.
C2. `apps/mobile/eas.json:28-37`, `docs/adr/0001-expo.md:41-43`, `apps/mobile/app.config.ts:24-27`, `docs/adr/0005-identifiers.md:55-57`: preview is `distribution: internal`, which on iOS is ad hoc (UDID allow-list, 100 devices a year) and on Android an APK (E10). Neither can go to TestFlight or a Play track. Under the brief's "TestFlight and internal Android testing", the pre-release build testers get is a store-signed build, which only the `production` profile makes today.
C3. `apps/mobile/eas.json:6-13` (no `image`, no `cocoapods`) against `.github/workflows/native-smoke.yml:11-15` ("mirrors the EAS SDK 57 build image"): EAS uses `auto` and SDK aliases move (E4). Parity on Xcode already holds (26.6, 17F113 on both, L8), but CocoaPods does not: EAS has 1.16.2 (E3), while GitHub and every spike (`docs/adr/0001-expo.md:116-120`, `docs/adr/0008-expo-widgets.md:202-203`) used 1.17.0.
C4. `apps/mobile/app.config.ts:203` (`version: '0.1.0'`) against apple-targets' hard-coded watch `MARKETING_VERSION "1.0"` (L4), with no override in `apps/mobile/targets/watch/expo-target.config.js:18-28` or `targets/watch-widget/expo-target.config.js:4-13`. EAS rewrites only `CFBundleVersion` (L5). Apple's forum reports Xcode 13.3+ failing when the WatchKit app's short version differs from the companion app's (https://developer.apple.com/forums/thread/702394). The nightly builds only for the simulator and has never archived for a device (ADR 0008:249-250).
C5. `apps/mobile/app.config.ts:231-308`: the privacy manifest covers the app target only. The widget extension's own executable uses UserDefaults (L2), and Apple requires a manifest in that bundle (F12) and refuses undeclared reasons (F11). `docs/open-decisions.md:80` and `docs/adr/0008-expo-widgets.md:375-376` already flag this "before the first TestFlight upload"; it is now primary-sourced and should be treated as a gate, not an open question.
C6. `docs/adr/0005-identifiers.md:14-19`, `docs/increments/09-11-mobile.facts.md:36,150`: bundle-ID immutability is marked unverified. App Store Connect Help now says it outright (F5), and Play says package names are "unique and permanent" (G5). This is not a design change; update the citations.
C7. `.github/workflows/native-smoke.yml:12-13` and `docs/increments/09-11-mobile.facts.md:79` say expo/expo#47537 "is open". It was fixed in expo-modules-autolinking 57.0.5 and the lockfile has 57.0.13 (L7). The reason for keeping the Xcode 27 leg non-gating is weaker than stated.
C8. `docs/runbooks/first-deploy.md:256-257` and `apps/mobile/README.md:146-148,153-156` register two Android fingerprints per package (upload plus app signing). New Play apps default to hybrid signing, with three app-signing fingerprints to register with every API provider (G15). That means `ANDROID_SHA256_FINGERPRINTS` (assetlinks) and the Google OAuth Android clients (one SHA-1 each) need up to four entries per package, or the app must opt out before its first open-testing or production release.
C9. `docs/open-decisions.md:47` ("When: before the first internal Android track") and `apps/mobile/README.md:153-154`: the 12-tester, 14-day gate applies to production access for personal accounts only; internal testing is open to any account (G1, G6). Personal to organization is a supported change (G4). The organization recommendation stands, but its real deadline is production access, not the first internal build.
C10. `docs/open-decisions.md:83` ("make it the gate when Xcode 27 is the App Store requirement"): Apple has now set April 2027 for the iOS 27 SDK (F2). EAS's Xcode 27 image is aliased to SDK 58 (E3), so this is also the latest date for the SDK 58 upgrade (`docs/open-decisions.md:28`, "Upgrade in its first stable week").
C11. `apps/mobile/eas.json:10-12` (base `env` has only `EXPO_NO_GIT_STATUS`): an EAS Release build with no `SENTRY_AUTH_TOKEN`/org/project and no `SENTRY_DISABLE_AUTO_UPLOAD` hits the failing Sentry upload path on both platforms (L6). `apps/mobile/README.md:157-159` lists the Sentry EAS variables as an owner task but not as a build prerequisite.
C12. `docs/runbooks/first-deploy.md:264-283` (step 12) and the runbook as a whole have no mobile-store steps: no Apple or Play enrollment, App Store Connect record, API key, TestFlight group, Play app, service account, `eas init`, first interactive build or submit. Step 17 (`:347-349`) puts the Data safety form with production, which is consistent with G6 (the internal track is exempt).
C13 (minor). `apps/mobile/app.config.ts:215-230` has no `ios.appleTeamId`, which `apps/mobile/README.md:171-173` asks for before the first device build. On EAS, the builder assigns each target's team from its provisioning profile (`configure.ts`), so this matters only for local device builds.

### 3.2 What the repository lacks for a first upload

- eas.json: submit values (`ascAppId`, `android.track: internal`, optionally `ios.groups`), pinned `image` per platform, a `cocoapods` pin, and Sentry settings for EAS (variables in the EAS environment, or `SENTRY_DISABLE_AUTO_UPLOAD=true` until Sentry exists).
- A config plugin that puts a `PrivacyInfo.xcprivacy` in `ExpoWidgetsTarget` (UserDefaults `1C8F.1` at least, plus whatever the statically linked ExpoWidgets, ExpoModulesCore and ExpoUI code references), and optionally files in `targets/watch*/` for Phase 2.
- A correction making the watch targets' `MARKETING_VERSION` equal to the app's `version` (and `CURRENT_PROJECT_VERSION` equal to the build number), or a documented proof that it is unnecessary.
- A nightly unsigned device archive (`xcodebuild archive -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO`) and 16 KB checks on the Android artifacts. The nightly proves only simulator and APK builds today.
- EAS project id, EAS environment variables, EAS-managed credentials (distribution certificate, four provisioning profiles per store variant, Android upload keystore), and a release workflow (GitHub `eas build --auto-submit` with `EXPO_TOKEN`, or an EAS Workflow).
- The store-side records: the App Store Connect app, internal TestFlight group, ASC API key, Play app, internal tester list and service account.

### 3.3 What blocks the first internal build

Hard blockers: (1) an Apple Developer membership and a Play Console account (identity verified) plus an Expo account; (2) the Sentry upload settings in the EAS environment (C11, L6); (3) the first iOS credential run done interactively with an Apple ID, because App Group identifiers need cookie auth (E9) and four targets need profiles (E10); (4) an App Store Connect record, or an interactive `eas submit` that creates it (E6), and a Play app created by hand plus a service-account key (E7).
Likely blockers, unproven until the first upload: the widget extension manifest (C5) and the watch short-version mismatch (C4).
Not blockers: Beta App Review (internal TestFlight, F8), the Play Data safety form, content rating and store listing (internal track, G6), the App Privacy label (not asked for internal testing in the pages cited, U15), and D-U-N-S if individual or personal accounts are used first.

## 4. Design implications for Phase 1

D1. TestFlight and the Play internal track carry the `production` variant (`app.planeahead.mobile`, store distribution, `production` channel, production APNs). Preview stays the ad hoc/APK build for PR updates on owner devices. Trade-off: testers use `api.planeahead.app`, so the production API (runbook step 17, real provider keys) must be live before the first invite. The alternative is a second App Store Connect record and Play app for `.preview`: one more app name, record and tester list, and it would still talk to the production API (`app.config.ts:72-78`).
D2. Build on EAS in the cloud with `eas build --profile production --platform all --auto-submit`. Run the very first build of each platform interactively on the owner's Mac so EAS can register App Groups, create profiles for four targets and generate the upload keystore; later builds run from CI with `EXPO_TOKEN` and a stored ASC API key. Trade-off: $19 a month and a dependency on Expo's builders, against local builds that are free but ignore the pinned image (E11) and would use this Mac's Xcode 27 rather than the 26.6 gate, with signing done by hand.
D3. Pin `ios.image: macos-tahoe-26.5-xcode-26.6`, `android.image: ubuntu-26.04-jdk-17-ndk-r27b-sdk-57` and `ios.cocoapods: 1.17.0` so EAS, the nightly and the spikes use one toolchain. Trade-off: every SDK bump must also bump the pins; EAS installs CocoaPods 1.17.0 at build start, which adds time.
D4. Add a `withExtensionPrivacyManifests` plugin (post-order, like `withExpoWidgetsBuild`) that writes the widget extension's manifest. Check in the nightly that every `.app` and `.appex` in the Release product has a `PrivacyInfo.xcprivacy`, and scan the extension binary for required-reason symbols with `nm -u`. Trade-off: one more correction to generated output to re-check on each expo-widgets bump, against an upload refusal or Invalid Binary on the first TestFlight build.
D5. Align the watch targets' versions in a plugin and add the unsigned device-archive step to the nightly iOS gate. Trade-off: 10 to 20 more macOS minutes a night (billed at a multiple on a private repository, runbook step 15), against discovering `ValidateEmbeddedBinary` or device-SDK failures on a paid EAS build.
D6. Front-load the store plumbing: make the first Phase 1 increment "store pipeline" and upload the Phase 0 app to TestFlight and the Play internal track before feature work. Trade-off: the accounts are needed in week one, so D-U-N-S lead time can push the org enrollment onto the critical path (see D7), but every ITMS surprise (C4, C5, F13's SDK list) is found on a small app with few moving parts, and each fix costs one rebuild rather than a release slip.
D7. Account type: organization on both stores (brand as seller, no personal 14-day production gate, org website and D-U-N-S). If D-U-N-S or Apple's verification lags, enroll Apple as an individual and Play as personal to unblock internal testing, then convert (Apple through support, F22; Play in-console, G4). Trade-off: Apple shows the owner's legal name as seller until converted, conversion is manual work, a personal Play account needs Android-device verification (G2), and whether conversion lifts the 12-tester rule for apps created before it is unverified.
D8. Android signing: take Play's default hybrid signing for new apps, and register all three app-signing fingerprints plus the upload key in `ANDROID_SHA256_FINGERPRINTS` and the Google OAuth Android clients. Decide before the first open-testing or production release, the last point the default can change (G15). Trade-off: up to four OAuth clients and assetlinks entries per package, against a classical-only key that gives up PQC verification on Android 17+.
D9. 16 KB: the current native set passes (L1). Add `zipalign -c -P 16`, an ELF alignment check and `bundletool dump config` on the AAB to the Android nightly, so the maps increment (MapLibre linked, ADR 0001 decision 5) cannot regress it silently. Trade-off: about a minute of CI.
D10. Stay on Xcode 26.6 and SDK 57 for Phase 1: valid for uploads until April 2027 (F1, F2). Schedule the SDK 58 upgrade, whose EAS image is Xcode 27.0, in Q1 2027 at the latest, with `enableSceneSupport` already set (`app.config.ts:335-337`). Trade-off: SDK 58 moves from optional to mandatory on a fixed date; it also unlocks expo-widgets' Android widgets (`docs/open-decisions.md:81`).
D11. Plan for Play's 2027 rules now: R8 shrinking and obfuscation of 25%+ once DEX exceeds 10 MB (February 2027), and Zero-Tap Sign-In restoration through the Restore Credentials API for apps with sign-in (April 2027) (G11). Trade-off: minifying a React Native release risks reflection breakage that needs its own test pass; restoration touches the Better Auth session model.
D12. Keep `ITSAppUsesNonExemptEncryption: false` (`app.config.ts:229`). The app's encryption is OS-provided: HTTPS, Keychain through expo-secure-store, CommonCrypto through expo-crypto (F14, F15). That avoids Missing Compliance on every build. Trade-off: it is the owner's legal attestation and must be revisited if any non-OS cryptography library is added.
D13. Testers: internal TestFlight testers must be App Store Connect users with a role (F7) and get builds without review; family or friends need an external group and a Beta App Review for the first build of each version (F6, F9). Play internal testers are an email list of up to 100 (G6). Trade-off: internal testing is instant but costs a seat per person; external adds a review per version but scales to 10,000 with public links.
D14. Sequencing: Play Data safety, content rating and store listing are not needed for the internal track (G6), and no TestFlight page cited (F6 to F9) asks for the App Privacy label before internal testing (U15 covers external). Answer them before external TestFlight, closed testing or production. For Data safety: FCM token, FID and install id are "Device or other IDs" (App functionality); the analytics id is "Device or other IDs" (Analytics); email, user id and name are App functionality; crash logs go to Sentry as a service provider, so they are not "shared" (G12, G13). Trade-off: none beyond keeping ADR 0005's table and the form in step.

## 5. Costs

Accounts:
- Apple Developer Program: $99 a year (F21). D-U-N-S: $0 through Apple's lookup (F20).
- Google Play Console: $25 once (G2).
- EAS Starter: $19 a month including $45 of build credit (E1).
- First year: $99 + $25 + (12 x $19 = $228) = **$352**, before any build overage.

Per-build prices after credit (E1): iOS medium $2, iOS large $4, Android medium $1, Android large $2. One release pair on medium workers (iOS plus Android) costs $2 + $1 = $3.

Phase 1 scenario (assumed cadence: two release pairs a week plus four preview pairs a month):
- Releases: about 9 pairs a month (2 x 52 / 12 = 8.7, rounded up) x $3 = $27.
- Previews: 4 pairs x $3 = $12.
- Total usage $27 + $12 = $39, under the $45 credit, so the cash cost is **$19 a month**.
- Credit breakeven: $45 / $3 = 15 medium pairs a month. With iOS on large workers, $45 / ($4 + $1) = 9 pairs.
- Overage example: 20 medium pairs = $60 of usage, $60 - $45 = $15 over, so $19 + $15 = $34 that month.
- For comparison, a nightly iOS build on EAS: 30 x $2 = $60 a month for iOS alone, above the $45 credit. This confirms ADR 0008's choice to keep the nightly on GitHub (`docs/adr/0008-expo-widgets.md:424`).
- Extra concurrency: $50 a month per build slot (E1); not needed at this cadence.
- Free-plan alternative: $0 for up to 15 iOS and 15 Android builds a month. It fits the scenario (9 + 4 = 13 builds per platform) only if an iOS build of this app finishes inside the 45-minute timeout and the low-priority queue is acceptable. Build time is unmeasured (U6).

## 6. UNVERIFIED items and how to settle each

U1. The exact April 2027 day for the iOS 27 SDK requirement. Settle: watch https://developer.apple.com/news/upcoming-requirements/ (the 2026 date was published about 12 weeks ahead, F3).
U2. The next Play target-API deadline (API 37, presumably August 2027) is not published. Settle: https://developer.android.com/google/play/requirements/target-sdk once Google posts it.
U3. Whether the watch shells' short version "1.0" against the app's "0.1.0" fails a device archive (`ValidateEmbeddedBinary`) or an App Store Connect upload. The nightly simulator build passes, and the Apple forum thread is from the Xcode 13.3 era. Settle: `xcodebuild archive -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO` on Xcode 26.6 and inspect `Watch/PlaneAheadWatch.app/Info.plist`, or read the first EAS build log.
U4. Whether App Store Connect refuses outright (Invalid Binary) or only emails ITMS-91053 when only an extension lacks its manifest, and which required-reason APIs the extension binary references besides UserDefaults. Settle: `nm -um` on the built `ExpoWidgetsTarget.appex` binary for the categories in F11, then the first upload's email.
U5. Whether React Native 0.86's `hermesvm.framework` counts as Apple's listed `hermes` SDK, and whether it and GoogleSignIn 10 carry the manifests and signatures ITMS-91061 wants. Settle: list `PrivacyInfo.xcprivacy` and `_CodeSignature` inside the built app's Frameworks and resource bundles, then the first upload.
U6. EAS iOS build duration for this app (four targets, 132 pods) on medium versus large workers, which decides whether the Free plan's 45 minutes suffices and which resource class to buy. Settle: the first EAS build's timing.
U7. Whether an App Store Connect API key with App Manager, rather than Expo's recommended Admin, is enough for `eas submit` (Apple lets Developer and above upload, F10). Settle: create an App Manager team key and run one submit.
U8. Whether converting a personal Play account to organization lifts the 12-tester, 14-day requirement for apps created before the conversion. Settle: Play Console support, before choosing a personal account.
U9. How long Apple's organization verification takes after D-U-N-S; no figure is published (F22). Settle: none in advance; budget one to two weeks.
U10. Whether sentry-cli actually exits non-zero with no auth token in `react-native xcode` and the Gradle upload, which would make the EAS build fail. The scripts treat a failed upload as fatal (L6). Settle: one local Release build with `SENTRY_DISABLE_AUTO_UPLOAD` unset and no token.
U11. Whether Google Sign-In (Credential Manager) and App Links verification on Android 17+ devices under hybrid signing use the new classical key's fingerprints, as Play's "register all three" implies (G15). Settle: install from the Play internal track on an Android 17 device or emulator and try Google sign-in and `adb shell pm get-app-links`.
U12. Whether a Play app set up as free can later be made paid. This is widely reported as one-way, but not confirmed on a primary page here; it is moot for a freemium app with in-app subscriptions. Settle: Play Console Help on pricing before choosing "free".
U13. Whether the App Store name "PlaneAhead" is free. A web search found no exact match (Google Play has "PlanAhead"). Settle: create the App Store Connect record early (F4); Play names need not be unique.
U14. Whether `eas submit` can create a brand-new Play app's first release non-interactively in CI (the docs say the default command works, E7). Settle: run the first Android submit locally; fall back to a manual Play Console upload of the EAS-built AAB.
U15. Whether App Store Connect requires the App Privacy answers (and the age-rating questionnaire, F1's January 2026 item) before an external TestFlight group can be submitted to Beta App Review. The TestFlight pages cited list only test information and export compliance. Settle: the first external group submission.

## 7. Owner actions ordered by lead time

Weeks (start now, in parallel):
1. Decide the legal entity that will be the seller on both stores (an existing company or a new LLC). Everything organizational below depends on it. If an LLC must be formed, that adds the state's filing time.
2. D-U-N-S for that entity: look it up or request it free through Apple's tool (up to 5 business days, then up to 2 more for Apple, F20). Google allows up to 30 days for the D&B process (G3).
3. A public, functional website on the organization's domain and a work mailbox on that domain for the Apple Account Holder (F21). `planeahead.app` currently serves only the API hosts; a registrar or parking page is refused.
4. Apple Developer Program enrollment as the organization (web only, $99 a year). Apple verifies before payment, duration unpublished (F22). Fallback: enroll as an individual now and convert later (D7).
5. Google Play Console organization account ($25), payments profile verification (up to 5 days) and identity verification before publishing (G3). Fallback: personal account (Android device verification, G2), converted later (G4).

Days:
6. Expo: account on Starter, `eas init` in `apps/mobile`, EAS environment variables per environment (Plain text or Sensitive, as the README says), and the Sentry variables with `SENTRY_AUTH_TOKEN` as a Secret. Until Sentry exists, set `SENTRY_DISABLE_AUTO_UPLOAD=true` for EAS builds (C11).
7. Production API live (runbook steps 0 to 17) before the first tester invite, because the TestFlight and Play builds of the production variant call `api.planeahead.app` on first launch (D1).
8. APNs auth key (for the Phase 1 push sender) and a Firebase project with the Android apps and `google-services.json` as the EAS file variable `GOOGLE_SERVICES_JSON` (FCM token, ADR 0001 spike 3). This is not needed to upload, but it is needed for Phase 1's push.

Hours:
9. Apple portal (runbook step 12): App IDs for `app.planeahead.mobile` and its `.widgets`, `.watchkitapp` and `.watchkitapp.widget`; the App Group `group.app.planeahead.mobile`; Push, Associated Domains and Sign in with Apple, with production as the SIWA primary and the other variants grouped (F18). EAS can do all of this except the grouping on the first interactive build (E9).
10. App Store Connect: create the app record (name "PlaneAhead", bundle ID `app.planeahead.mobile`, a SKU; bundle ID and SKU are permanent, F5), note its Apple ID for `ascAppId`, create an internal TestFlight group with automatic distribution, and give each internal tester an App Store Connect role (F7). Create a team API key (Admin per Expo, or App Manager, U7) and store it in EAS; download it once (F19).
11. Play Console: create the app (free, default language, `app.planeahead.mobile`; package names are permanent, G5), an internal-testing email list, a Google Cloud service account with the Play Developer API enabled, invited in Play Console with release and testing-track permissions, and its JSON key uploaded to EAS (E7).

At first build:
12. Run the first `eas build --profile production` for iOS interactively on the Mac with an Apple ID (App Groups need cookie auth, E9), and Android (EAS generates the upload keystore). Then run `eas submit` for each platform, or use `--auto-submit` once `ascAppId` and the key are in eas.json (C1).
13. After the first Play upload: copy the app-signing fingerprints (three under hybrid signing) and the upload fingerprint into `ANDROID_SHA256_FINGERPRINTS` and the Google OAuth Android clients (C8). Decide hybrid versus classic before any open or production release (G15).
14. Confirm the export-compliance attestation behind `ITSAppUsesNonExemptEncryption: false` (D12), and read the ITMS emails after the first upload (U3 to U5).
