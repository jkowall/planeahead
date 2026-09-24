# 0008. Native surfaces: expo-widgets, the watchOS shells, the Android stubs, the nightly smoke

- Status: Proposed
- Date: 2026-09-23
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none

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

Pending: this draft records the increment 11 spikes (ruling V1) before the shells are built on
them. The spikes' verdicts: expo-widgets resolves under the isolated linker without a
workaround, the watchOS shells ship (the coexistence spike passed on Xcode 27), and the Android
stub builds against API 36 with the Live Updates promotion call behind an API-level guard.

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

The spike's placeholder and Live Activity layouts were also evaluated in the built
`ExpoWidgets.bundle` itself (Node `vm`): both produce the node trees the Swift side reads.

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
  `TARGETED_DEVICE_FAMILY (4)` warning, `vtool` platform `IOSSIMULATOR`). Builds that include
  the watch shells must use `-destination` only.
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
`androidx.glance` 1.2.0-rc01) is autolinked into every Android build whatever the flag says; the
flag only adds the receiver.
