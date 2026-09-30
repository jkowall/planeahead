# 0005. App identifiers: bundle ids, App Groups, links, the install id and the analytics id

- Status: Accepted
- Date: 2026-09-23
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none
- Amended: 2026-09-30, increment 13: the permanence of the bundle ids and package names is now
  primary-sourced (context item 1)

## Context

Increment 9 fixes the identifiers the app is known by. Some are expensive or impossible to
change once anything ships, and two of them are privacy decisions, not naming ones:

1. A bundle identifier (iOS) and a package name (Android) name the app in the App Store, in Play,
   in every credential (APNs keys, Sign in with Apple, Google OAuth clients, Play signing) and in
   every association file. Both stores say they are permanent. App Store Connect, of an app
   record's bundle ID: "You can't change this property after you upload a build"
   ([App information](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information));
   Play: package names "are unique and permanent"
   ([Create and set up your app](https://support.google.com/googleplay/android-developer/answer/9859152)),
   and changing the application id makes a different app
   ([Configure the app module](https://developer.android.com/build/configure-app-module)). Checked
   2026-09-30 (`docs/research/phase1/R5-store-distribution.md` F5, G5); increment 9's facts
   sheet had marked the point unverified.
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

| Identifier                                 | Value                                                                                                                        | Where it is set                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Bundle id and Android package, production  | `app.planeahead.mobile`                                                                                                      | `app.config.ts` `VARIANT_IDENTITIES`                                                                 |
| Bundle id and Android package, preview     | `app.planeahead.mobile.preview`                                                                                              | same                                                                                                 |
| Bundle id and Android package, development | `app.planeahead.mobile.dev`                                                                                                  | same                                                                                                 |
| App Group                                  | `group.<bundle id>`, one per variant, declared explicitly                                                                    | `ios.entitlements`                                                                                   |
| URL scheme                                 | `planeahead` (dev client and the Better Auth Expo origin `planeahead://`)                                                    | `scheme`                                                                                             |
| Universal link / App Link                  | path `/auth/magic-link*`; production and preview claim `api.planeahead.app`, development claims `api-staging.planeahead.app` | `ios.associatedDomains`, `android.intentFilters` (`autoVerify`), `apps/api/src/routes/well-known.ts` |
| Install id                                 | a random v4 UUID created on first use, kept in the kv-store                                                                  | `src/lib/identity.ts`                                                                                |
| Analytics id                               | a DIFFERENT random v4 UUID created on first use, kept in the kv-store                                                        | `src/lib/identity.ts`                                                                                |

1. **Variants.** `APP_VARIANT` defaults to `production`; EAS profiles set it explicitly. Each
   variant has its own name, icon and App Group; the owner registers all three App Groups and the
   Sign in with Apple capability on all three App IDs before the first device build.
2. **Links, one owner per host.** The path is the emailed landing page the API already serves
   outside the Better Auth mount (`MAGIC_LINK_LANDING_PATH`, increment 5 ruling G3, which moved it
   from `/api/auth/magic-link/*`). Each host is claimed by exactly one kind of build, so which app
   a link opens on a phone with several variants is predictable (fix-round ruling S2):
   - the development build claims `api-staging.planeahead.app` and talks to the staging API;
   - the production build claims `api.planeahead.app`;
   - the preview build, the pre-release build of the store app, claims `api.planeahead.app` too
     and talks to the production API, since a link it can open has to come from the API it
     requested it from. A tester with production and preview both installed gets whichever app
     iOS picks for that host.

   The association files come from the API's environment (`APPLE_TEAM_ID`, `APP_BUNDLE_IDS`,
   `ANDROID_SHA256_FINGERPRINTS`) and name only that host's variants: staging (and a local
   Worker) the development id, production the production and preview ids, whatever else the
   variables hold (`APP_BUNDLE_IDS` stays a list and overrides the default). They are mounted in
   `apps/api/src/index.ts` outside `AppType` (no client calls them) and answer 404 until the team
   id, or a fingerprint for one of the host's packages, is configured: Apple and Google cache a
   success, and an empty association would be cached as "this domain opens no app".

3. **Install id.** Random, not derived from the device (no IDFV, no Android ID), so a reinstall
   is a new installation and nothing ties it to hardware. It is registered with
   `POST /v1/devices` under the signed-in or anonymous user and rides on every `/v1` request as
   `X-Install-Id`, and on the magic-link request, where it keys the owner's own budget. It is
   therefore linked to the account server-side, by design, and is never used for analytics.
4. **Analytics id.** Random and separate from the install id, sent only to `POST /v1/events`,
   with no session cookie and no `X-Install-Id` on that request, so the analytics store can never
   join an event to a person. `POST /v1/events` was the API's 501 stub until increment 12 built
   it (anonymous, `EVENTS_RL` per client IP, the batch shape this client sends, one Analytics
   Engine point per accepted event, 202); the client still turns itself off on a 501. No App Tracking
   Transparency prompt: first-party analytics to our own endpoint is not tracking under Apple's
   definition.
5. **App Privacy answers** (the App Store label, and the privacy manifest `app.config.ts` writes,
   `NSPrivacyCollectedDataTypes`; increment 9 review, expo-correctness-5). Nothing is used for
   tracking.

   | Data type                    | Linked to the user | Purposes                     | Why                                                                           |
   | ---------------------------- | ------------------ | ---------------------------- | ----------------------------------------------------------------------------- |
   | Identifiers > Device ID      | yes                | App Functionality, Analytics | the install id is registered under the account; the analytics id is analytics |
   | Contact Info > Email Address | yes                | App Functionality            | the magic-link address, and the address Apple or Google shares                |
   | Identifiers > User ID        | yes                | App Functionality            | the account's id, on every `/v1` request                                      |
   | Contact Info > Name          | yes                | App Functionality            | the name Apple sends on the first native sign-in                              |
   | Diagnostics > Crash Data     | no                 | App Functionality            | Sentry, `sendDefaultPii: false`, no user set                                  |

   The spec and the facts sheet declared the device id "Data Not Linked to You". That holds for
   the analytics id alone, but the label shows a data type in ONE section and the install id of
   the same type is joined to the account in `devices`, so Device ID is declared Linked, with
   both purposes; the analytics id still never reaches the account on our side. Play's Data
   safety form has no linked/not-linked split: "Device or other IDs", "Email address", "User
   IDs" and "Name", collected, for app functionality (and analytics for the ids). The flights a
   user follows are added to the answers with increment 10's add-flight screen.

## Consequences

- Easier: every credential, association file and store listing can be created once from this
  table; the privacy answers follow from how the ids are sent, not from a promise.
- Harder: the three bundle ids triple the owner's Apple and Google setup (three App Groups,
  three Sign in with Apple App IDs, three sets of Play fingerprints for `assetlinks.json`).
  Production and preview share a host, so a phone with both installed opens a magic link in
  whichever of the two iOS picks; the development build's host is its own.
- The API verifies Apple identity tokens against ONE `APPLE_BUNDLE_ID` per environment
  (increment 5). Staging's Apple sign-in belongs to the development build (fix-round ruling S3):
  staging's `APPLE_BUNDLE_ID` is `app.planeahead.mobile.dev`. Production's is
  `app.planeahead.mobile`. Increment 12 made the accepted audience a list (`APPLE_BUNDLE_IDS`,
  defaulting to the variants the association files name for the environment, plus
  `APPLE_BUNDLE_ID`), so the preview build signs in with Apple against production and the code is
  exchanged for the bundle id the token names; the deletion's revocation still names
  `APPLE_BUNDLE_ID` (docs/open-decisions.md).
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
- `docs/research/phase1/R5-store-distribution.md` F5 and G5
- https://developer.apple.com/help/app-store-connect/reference/app-information/app-information
- https://support.google.com/googleplay/android-developer/answer/9859152
- https://developer.apple.com/app-store/app-privacy-details/
- https://support.google.com/googleplay/android-developer/answer/10787469
- https://docs.expo.dev/linking/ios-universal-links/
- https://docs.expo.dev/linking/android-app-links/
