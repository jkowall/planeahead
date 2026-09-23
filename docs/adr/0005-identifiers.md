# 0005. App identifiers: bundle ids, App Groups, links, the install id and the analytics id

- Status: Accepted
- Date: 2026-09-23
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none

## Context

Increment 9 fixes the identifiers the app is known by. Some are expensive or impossible to
change once anything ships, and two of them are privacy decisions, not naming ones:

1. A bundle identifier (iOS) and a package name (Android) name the app in the App Store, in Play,
   in every credential (APNs keys, Sign in with Apple, Google OAuth clients, Play signing) and in
   every association file. Treating them as immutable after the first store upload is the
   conservative reading; no primary source found for this ADR states it outright
   (`docs/increments/09-11-mobile.facts.md` section 2 marks it unverified), but App Store Connect
   and Play Console offer no way to change them on an existing app record.
2. Each `APP_VARIANT` is a separate app on a device, so each needs its own App Group
   (`group.<bundle id>` is what expo-widgets defaults to in increment 11, and `@bacons/apple-targets`
   reads the entitlement at config time, so it is declared explicitly in `app.config.ts`).
3. The magic link opens the app through a universal link (iOS) and a verified App Link (Android).
   Apple's CDN caches `apple-app-site-association`, so the path the app claims is effectively
   permanent once a build ships (facts section 2).
4. The API needs to tell installations apart: `POST /v1/devices` upserts on the pair
   `(user_id, install_id)`, and an anonymous caller's `Idempotency-Key` is scoped by
   `X-Install-Id` (increment 4). Separately, first-party analytics needs a stable per-install
   id that is NOT linked to a person (Phase 0 plan section 3), which Apple's App Privacy form
   asks about ([App privacy details](https://developer.apple.com/app-store/app-privacy-details/)).

## Decision

We will use the identifiers below and treat the first three rows as permanent.

| Identifier                                 | Value                                                                                           | Where it is set                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Bundle id and Android package, production  | `app.planeahead.mobile`                                                                         | `app.config.ts` `VARIANT_IDENTITIES`                                                                 |
| Bundle id and Android package, preview     | `app.planeahead.mobile.preview`                                                                 | same                                                                                                 |
| Bundle id and Android package, development | `app.planeahead.mobile.dev`                                                                     | same                                                                                                 |
| App Group                                  | `group.<bundle id>`, one per variant, declared explicitly                                       | `ios.entitlements`                                                                                   |
| URL scheme                                 | `planeahead` (dev client and the Better Auth Expo origin `planeahead://`)                       | `scheme`                                                                                             |
| Universal link / App Link                  | `https://api.planeahead.app` and `https://api-staging.planeahead.app`, path `/auth/magic-link*` | `ios.associatedDomains`, `android.intentFilters` (`autoVerify`), `apps/api/src/routes/well-known.ts` |
| Install id                                 | a random v4 UUID created on first use, kept in the kv-store                                     | `src/lib/identity.ts`                                                                                |
| Analytics id                               | a DIFFERENT random v4 UUID created on first use, kept in the kv-store                           | `src/lib/identity.ts`                                                                                |

1. **Variants.** `APP_VARIANT` defaults to `production`; EAS profiles set it explicitly. Each
   variant has its own name, icon and App Group; the owner registers all three App Groups and the
   Sign in with Apple capability on all three App IDs before the first device build.
2. **Links.** The path is the emailed landing page the API already serves outside the Better
   Auth mount (`MAGIC_LINK_LANDING_PATH`, increment 5 ruling G3, which moved it from
   `/api/auth/magic-link/*`). All three variants claim both hosts; the association files list the
   three app ids and the Play fingerprints from the API's environment (`APPLE_TEAM_ID`,
   `APP_BUNDLE_IDS`, `ANDROID_SHA256_FINGERPRINTS`).
3. **Install id.** Random, not derived from the device (no IDFV, no Android ID), so a reinstall
   is a new installation and nothing ties it to hardware. It is registered with
   `POST /v1/devices` under the signed-in or anonymous user and rides on every `/v1` request as
   `X-Install-Id`, and on the magic-link request, where it keys the owner's own budget. It is
   therefore linked to the account server-side, by design, and is never used for analytics.
4. **Analytics id.** Random and separate from the install id, sent only to `POST /v1/events`,
   with no session cookie and no `X-Install-Id` on that request, so the analytics store can never
   join an event to a person. Declared in App Privacy as Identifiers > Device ID, Data Not Linked
   to You, purpose Analytics, and in the privacy manifest as
   `NSPrivacyCollectedDataTypeDeviceID` (not linked, not tracking); Play's Data safety form lists
   it under "Device or other IDs". No App Tracking Transparency prompt: first-party analytics to
   our own endpoint is not tracking under Apple's definition.

## Consequences

- Easier: every credential, association file and store listing can be created once from this
  table; the privacy answers follow from how the two ids are sent, not from a promise.
- Harder: the three bundle ids triple the owner's Apple and Google setup (three App Groups,
  three Sign in with Apple App IDs, three sets of Play fingerprints for `assetlinks.json`).
  With several variants installed on one iPhone, which app a universal link opens is not
  deterministic; the preview and development builds are for testers who know that.
- The API verifies Apple identity tokens against ONE `APPLE_BUNDLE_ID` per environment
  (increment 5). A development or preview build signing in with Apple against staging needs
  staging's value to be that variant's bundle id; which variant owns staging's Apple sign-in is
  an open owner decision (apps/mobile/README.md).
- Reversibility: low for the bundle ids and the link path, high for the two random ids (a new
  scheme only needs a new kv key).

## Alternatives considered

| Option                                                         | Why not                                                                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One bundle id, variants as build configurations                | A preview and a production build could not be installed side by side, and they would share an App Group and keychain                                                                                 |
| IDFV / Android ID as the install id                            | Platform identifiers with their own lifetimes (the IDFV survives a reinstall while another app from the same vendor stays installed); a random id is ours to reset and says nothing about the device |
| The install id as the analytics id                             | It is joined to the account in `devices`, which would make every event linked to a person                                                                                                            |
| A custom scheme link (`planeahead://`) for the magic link      | Any app can claim a custom scheme on Android and receive the token (increment 5, threat model 1.5)                                                                                                   |
| Claiming the links on `planeahead.app` instead of the API host | The landing page, the AASA and assetlinks are all served by the API Worker; a second host is a second deployment to keep in step                                                                     |

## References

- `docs/increments/09-11-mobile.facts.md` sections 2 and 5
- https://developer.apple.com/app-store/app-privacy-details/
- https://support.google.com/googleplay/android-developer/answer/10787469
- https://docs.expo.dev/linking/ios-universal-links/
- https://docs.expo.dev/linking/android-app-links/
