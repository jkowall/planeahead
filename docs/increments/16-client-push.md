# Increment 16: client push

Status: built (2026-10-01) in four parts, reviewed, and the review round's rulings applied
(2026-10-02 to 2026-10-05). Part 1 (`82b1543`): the app's push lifecycle, C1 to C4, C6 and C7.
Part 2 (`e4754d6`): the notification icon and the time-sensitive entitlement, C5, C8 and the
plugin's default channel. Part 3a (`47fc437`, built on its own branch and merged as `741ec86`):
notification settings, the overrides contract and the tray at sign-out, C11 and C12. Part 3b
(`ac113d7`): the transport soak harness, C9. A test-only fix (`de4237c`) then stopped the API suite
exhausting Postgres connections, which main shares. Part 4: the documents. The review found no
blocker and three majors (A1: an offline sign-out left the old account's alerts arriving while the
app ran signed out; A2: one failed token read failed every later read in the process; M1: the
soak's canary cannot show the pooling R1 U2 asks about, which the documents said a clean soak
settles), with minors and nits, all accepted. Fix parts: F1a (`df11589`: the sign-out lifecycle),
F1b (`363142a`, merged as `1f38465`: the token read, through the repository's first dependency
patch, and the screens), F2a (`47c10f5`: the invalidation ends the caller's session, the soak's
fixes) and F2b (`89ba245`: the overrides contract, the test cluster, the injector's refusals),
merged as `dfad10d`; the close-out's native smoke fix (`c5639b6`); F3a and F3b, the documents. The
rulings amend C1 (the pre-prompt from every add entry point, O1), C2 (the patched token read, A2),
C3 (sign-out's order, its retries while signed out and the session it ends: A1, A3, A4, N1, N2,
N7), C9 (what the soak measures; U2 stays open, M1) and C12 (`notificationOverrides` left the
request contract, m1), and departure 1 is back with the owner. What ran, the measurements, the
findings, the departures and what stays unverified, with the steps that settle it, are in
`docs/increments/16-verification.md` (the round's changes in its Review round section). Spec written
2026-10-01, revised after increment 15 merged (58d7774). Builder: Opus 5.5, in parts (F2b the
orchestrator's). Reviewers: two Opus 5.5 lenses (the mobile client's push lifecycle on both
platforms; the soak, the API changes and their tests) plus the orchestrator's read; two skeptics on
every serious finding. Branch `inc16-client-push` from main at 58d7774 (increment 15 merged), with
main (increment 18) merged in as `b42b0a8` before the fix round.

Departures from these rulings, each with its reason in the verification file: the hourly canary
sends its two test pushes from one invocation, each with a cold token cache, held so both ask
`PushAuth` in the same instant, not from two isolates (C9: a Worker cannot choose its isolate, and
two queued jobs would run one after the other); the flight in front loses its list entry and its
sound as well as its banner (C6, as R2 design 12 words it); the toggles are read from the sync
feed's `notification_preferences` row, which carries what `GET /v1/me/preferences` answers (C11);
and the native smoke checks the entitlement, the plugin-chain test the icon. C2 and C7 below already
carry part 1's corrections: the token registers in every permission state, and the dismissal also
matches the flight's collapse ids as identifiers or tags.

Read first: `docs/plans/phase1-plan.md` (section 3 row Client push; section 4 Transport gate and
soak; section 8 row 16; section 9 items 2 and 4; section 10 Hours and Days),
`docs/research/phase1/R2-client-push.md` (all of it: facts 1 to 64, conflicts 1 to 11, design
items 1 to 17, U1 to U11, owner actions 1 to 8), `docs/increments/14-push-transport.md` and its
verification (the registration fields, the invalidate endpoint, the admin test push, what sign-out
cannot recall), `docs/increments/15-notification-policy.md` (the kinds, `timeSensitive`, the
channel ids `notify` sends, the event injector) and its verification, `docs/open-decisions.md`
section 8 (the rows marked increment 16), `packages/shared/src/push.ts` (the app data every push
carries: `v`, `kind`, `flightSubscriptionId`, plus FCM's `tag` and `channelId`; the collapse id
`{kind}:{flightKey}`), `packages/shared/src/notify.ts` (`ANDROID_CHANNEL_IDS`,
`ANDROID_CHANNEL_BY_KIND`), `packages/shared/src/preferences.ts` (the notification toggles) and
`apps/api/src/routes/me.ts` (`GET` and `PATCH /v1/me/preferences`), `apps/mobile/src/lib/push.ts`,
`session.ts`, `services.ts` (`forgetAccount`), `src/app/_layout.tsx`, `src/app/(app)/_layout.tsx`,
`(app)/settings.tsx`, `(app)/flight/[id].tsx`, `apps/mobile/app.config.ts` and its plugins
(`withApsEnvironment`), `apps/mobile/eas.json`, ADR 0001, ADR 0008.

## Goal

The app receives every push increment 15 sends: it asks for permission in context, keeps its token
and permission state registered, shows pushes in the foreground, opens the flight on a tap, uses two
permanent Android channels, and stops receiving at sign-out as far as a device can. A soak harness
proves the transport over 24 to 48 hours once staging and the keys exist.

## Rulings

- **C1. Permission in context (plan section 3; R2 design 2, 17).** After the user's first flight
  add succeeds, a pre-prompt screen explains what the alerts are for; its "Turn on" asks for alert
  and sound only (no badge in Phase 1, no provisional). Asked once: a later add never re-asks, and
  Settings offers the system settings link when the state is denied. `src/lib/push.ts` stops
  treating iOS provisional as denied (`ios.status` 3 is `provisional`, R2 fact 8) and checks before
  it requests.
- **C2. Registration on every launch and rotation (R2 design 4, 15).** On each session start and
  each return to the foreground the app reads the device token (`getDevicePushTokenAsync`, which
  needs no permission, R2 facts 22 and 24) and registers it with `POST /v1/devices`, sending
  `appId` (the variant's bundle or package id) and `pushPermission`. It does so whatever the
  permission: the API keeps the state only on a token row and ignores a `pushPermission` sent
  without a token (apps/api/src/routes/devices.ts), so a denied or undetermined state goes with
  the token, and `notify` skips that token (apps/api/src/notify/recipients.ts). Without a token
  the device still registers. `addPushTokenListener` re-registers on rotation, debounced and
  guarded against re-entry (the listener also fires on reads, R2 fact 23). The Settings button
  stops being the only path.
- **C3. Sign-out (plan section 5; R2 design 6).** Before `authClient.signOut()` the app calls
  `POST /v1/devices/current/invalidate` with its install id. Offline, sign-out proceeds and the
  call is queued keyed by install id and retried on the next launch before anything else
  registers; the next online registration re-points the token anyway (upserts are keyed by kind
  and token). Then `unregisterForNotificationsAsync()` on both platforms (Android deletes the FCM
  token; Apple names logout as a reason to unregister, R2 fact 61). Whether either stops a push the
  provider had already accepted from displaying is checked against Apple's and Google's documents
  and recorded; it cannot be tested without devices (increment 14's verification lists it).
- **C4. Two Android channels (plan section 3; R2 design 9).** Created at every app start, before
  any permission request, from `ANDROID_CHANNEL_IDS` in `packages/shared` (the constant increment
  15's `notify` already names on every job): `flight_changes` ("Flight changes": gate changes,
  first gate assignments, cancellations, diversions and their corrections) and `flight_delays`
  ("Delays": delays and their corrections), both `HIGH` importance so they sound and show heads-up
  by default and the user can lower either; the plugin's `defaultChannel` is `flight_changes`. The
  ids, names and importance stay a decision the owner confirms before the first Android build
  (docs/open-decisions.md section 8; R2 owner action 6), since importance is frozen at creation.
- **C5. Android notification icon (R2 design 14).** The expo-notifications plugin gets `icon` and
  `color`. Until the owner's monochrome icon exists (R2 owner action 5), a placeholder white plane
  glyph on transparent, 96 by 96, generated by a committed script so it can be regenerated; the
  runbook names the swap.
- **C6. Foreground presentation (R2 design 12).** `setNotificationHandler` installed once at module
  scope: banner, list and sound, except when that flight's detail screen is open, where the screen
  refreshes in place and the banner is suppressed (as built, the list entry and the sound too, as R2
  design 12 words it: departure 2 in the verification file). It answers synchronously from in-memory
  state, never a network call, well inside the 3-second limit.
- **C7. Tap routing (R2 design 13).** A root-level observer reads `getLastNotificationResponse()`
  at mount and subscribes to responses; once a session exists it routes to
  `/flight/{flightSubscriptionId}` (the app data's field) and clears the response. An id the local
  store does not know triggers one sync and, if still unknown, the home screen. Opening a flight
  dismisses its delivered notifications: the presented ones whose data names its
  `flightSubscriptionId`, and those whose identifier or tag is one of the flight's collapse ids
  (`{kind}:{flightKey}`, one per kind, so no single one names them all). The second is for
  Android, where a notification FCM displayed itself keeps its data in the tap intent only:
  expo reads such a notification back from the notification's own extras, without app data, and
  names it after its tag.
- **C8. Time-sensitive (decision 6; R2 design 3).** `com.apple.developer.usernotifications.time-sensitive`
  in `ios.entitlements` for all three variants; the fingerprint changes and the native smoke
  covers it. Correct the comments that say expo-notifications writes `aps-environment` from `mode`
  (R2 conflict 9).
- **C9. The soak harness (plan section 4 Transport gate and soak).** An Access-protected admin
  action on staging starts and stops a soak: on a schedule (every 5 minutes for the chosen hours),
  it injects synthetic events through increment 15's injector into one test flight followed by the
  owner's test devices, and once an hour sends a canary test push from two isolates at once (as
  built, two sends from one invocation, each with a cold token cache, held so both ask `PushAuth` in
  the same instant, since a Worker cannot choose its isolate: departure 1). The admin page shows the
  soak's counts by reason from the delivery attempt log: every 403 and 429 reason
  (`UnrelatedKeyIdInToken`, `TooManyProviderTokenUpdates`), edge 52x answers without an `apns-id`,
  and sent counts. Staging only; production refuses to start one.
- **C11. Notification settings (decision 4; increment 15's N10).** The Settings screen shows the
  push switch (`pushEnabled`) and the five per-kind toggles that `GET /v1/me/preferences` returns
  under `notifications` (as built, read from the sync feed's `notification_preferences` row, which
  carries the same values: departure 3): delays, gate changes, first gate assignment (off by
  default, the owner's decision 4), cancellations and diversions. A change applies at once and is
  queued as `PATCH /v1/me/preferences` with `{ notifications: ... }` through the outbox, the path
  the screen's units already take (src/lib/settings.ts `updatePreferences`,
  src/lib/preference-mutations.ts), so it holds offline and across a relaunch. While permission is
  denied the toggles stay editable, beside C1's link to the system settings.
- **C12. Per-flight overrides (open decision, section 8).** Phase 1 offers no per-flight event
  lists, so `notificationOverrides.events` leaves the contract: `NotificationOverridesSchema`
  (packages/shared/src/rpc.ts) keeps `muted` only and no longer passes unknown keys through
  (nothing sends `events`, and nothing is deployed). Per-flight mute stays API-only in Phase 1: no
  route changes it after the subscribe, and a switch on the flight's screen belongs with per-flight
  settings in Phase 2. Update the section 8 row.
- **C13. The unconfirmed-cancellation note (open decision, section 8): not built.** The app shows
  the last confirmed state, as increment 15 keeps a suspicion out of the synced row; carrying it
  would change the sync contract and the tracker. It stays the owner's decision, and the default
  (no note) is what ships; update the section 8 row to say so.
- **C10. Tests.** Mobile (Jest): the permission flow (granted, provisional, denied, asked once),
  registration on launch, foreground and rotation (debounced), the offline sign-out queue and its
  retry order, channel creation before the prompt, the foreground handler's decisions, tap routing
  (known id, unknown id then sync, no session yet), the dismissal of a flight's presented
  notifications, the notification toggles (read, queued through the outbox, first gate assignment
  off by default). API (Workers pool): the soak action's schedule, its staging-only
  guard and its counts; the overrides schema refusing `events` and unknown keys.

## Acceptance

- Every C10 test; the app-config tests cover the entitlement, the plugin's icon, colour and
  default channel, and the fingerprint change is recorded.
- The native smoke's iOS and Android steps pass locally with the new entitlement and icon (as built,
  the smoke checks the entitlement, and the plugin-chain test the icon's metadata: departure 5).
- The full check and both wrangler dry runs are green.
- Unverified until the accounts, the devices and staging exist, with exact steps in the
  verification doc: the exit test (the TestFlight iPhone and the internal Android build receive an
  injected production event for an allow-listed tester and open the flight; nothing after
  sign-out), R2 U1, U3, U4, U7 to U10, and the soak's 24 to 48 hours with clean counters.

## Out of scope

Badges, provisional authorization, Live Activities over push (Phase 2), per-flight Android grouping
(not possible through expo-notifications, R2 fact 40), FCM installation ids (R2 design 7), and the
in-app alerts inbox (Phase 2).
