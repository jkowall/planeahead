# Increment 11: native surface shells and nightly smoke

Status: spec (2026-09-20). Builder: Opus 5. Reviewers: Opus 5 (build-system correctness) plus orchestrator read. Branch `inc11-native-shells` based on `inc10-home-add-detail`.

Read `docs/increments/09-11-mobile.facts.md` section 5 first. It reshapes this increment: expo-widgets already covers Android widgets behind a flag and SDK 58 promotes it, apple-targets is on an alpha pbxproj parser with open watch defects, and expo-widgets hard-codes a sandbox `aps-environment`.

## Goal

Compiling shells for every native surface Phase 1 and 2 will fill, plus the nightly `native-smoke` job that proves the iOS and Android projects still build and launch with all of them present. No behaviour beyond token listeners.

Acceptance: nightly `native-smoke` on `macos-26` (Xcode 26.6, mirroring the EAS SDK 57 image) and `ubuntu` runs `expo prebuild` (clean by default in SDK 57, `EXPO_NO_GIT_STATUS=1`), `xcodebuild` for the simulator and `gradle assembleDebug`, then installs and launches both apps on a simulator and an emulator (a dyld failure builds clean and dies at launch, so compile-only is not enough); an Xcode 27 leg runs with `continue-on-error`; the iOS archive contains the expo-widgets extension (placeholder widget plus the Live Activity layout) and, if the two-hour coexistence spike passes, the apple-targets watch shells; the app's `aps-environment` entitlement equals `production` in the production variant after all plugins ran (a test parses the generated entitlements); the push-to-start token listener posts to `/v1/devices` with kind `apns_live_activity_push_to_start`; per-activity token updates are logged and discarded in Phase 0 (they belong to `live_activities` in Phase 1).

## Decisions taken

- expo-widgets `57.0.20` exact: one `widgets[]` entry for the placeholder widget with `supportedFamilies`; the Live Activity is created with `createLiveActivity` and must NOT appear in `widgets[]` (an entry without families generates an invalid target). Widget components use the `'widget'` directive and only `@expo/ui/swift-ui`. Explicit `groupIdentifier` equal to the App Group declared in `app.config.ts`. `enableAndroid: true` is tried behind a flag; the hand-written Kotlin Glance widget is dropped (redundant with expo-widgets, and SDK 58 promotes Android widgets). `modules/android-surfaces` keeps only the ongoing-notification stub (Android 16 Live Updates need API 36 and `POST_PROMOTED_NOTIFICATIONS`; the stub compiles, nothing else).
- `plugins/withApsEnvironment.ts` (reserved in increment 9) runs last and sets `aps-environment` from the EAS profile's distribution (`APNS_ENVIRONMENT` in `eas.json`, increment 9's ruling S8: `production` for the production and preview profiles, since ad hoc and App Store signed apps register with the production APNs environment, and `development` for the development profile), because expo-widgets writes the literal `development` unconditionally and `ios.entitlements` is applied before plugins; the entitlements test asserts the value per profile, not per variant.
- Live Activity content state uses shared's `LiveActivityContentStateV1` and a test asserts the encoded static-plus-dynamic payload stays under 4 KB; the 8-hour active limit versus long-haul flights is recorded as an open decision for Phase 1 (re-start on landing approach or split by phase).
- apple-targets watch shells: a two-hour time-boxed coexistence spike with `@bacons/apple-targets 5.0.0` on Xcode 26.6 (it pins `@expo/prebuild-config ~55`, claims Xcode 16, and has open watch defects); if prebuild, both compiles and launch succeed with the widget extension and the watch target in one archive, the shells ship; otherwise ADR 0008 records the failure and watch moves to Phase 2 (the Live Activity `bannerSmall` region already renders on a paired watch without a watchOS target).
- Wear OS: `plugins/withWearApp.ts` written from scratch (Expo has no Wear support) adds a Compose for Wear OS module with one Tile to the Gradle build; compile only.
- Widget bundle resolution under a pnpm isolated workspace (expo/expo#49752) is spike 2; if it reproduces, the workaround (hoisting only `expo-widgets` peers) is recorded.

## Files

```
apps/mobile/widgets/{placeholder.tsx, live-activity.tsx, content-state.ts}
apps/mobile/src/lib/live-activity/tokens.ts (push-to-start listener, per-activity listener that logs only)
apps/mobile/plugins/{withApsEnvironment.ts (real), withWearApp.ts}
apps/mobile/targets/watch/expo-target.config.js, targets/watch-widget/... (only if the spike passes)
apps/mobile/modules/android-surfaces/{expo-module.config.json, android/src/main/java/app/planeahead/surfaces/OngoingNotificationModule.kt}
apps/mobile/wear/ (Compose + Tiles module)
apps/mobile/__tests__/{entitlements.test.ts, content-state-size.test.ts}
.github/workflows/native-smoke.yml
docs/adr/0008-expo-widgets.md (with the coexistence spike result)
```

## Constraints

- Nightly builds run on GitHub runners, never on EAS (Starter credit does not cover nightly iOS builds).
- No behaviour in the shells beyond token posting and logging. No hand-written SwiftUI outside what expo-widgets requires.
- No em dashes.
