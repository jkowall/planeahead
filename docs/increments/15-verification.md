# Increment 15 verification: notification policy

Branch `inc15-notification-policy` (stacked on `inc14-push-transport` after its review fixes),
2026-10-01. The increment was built in four parts: the pure policy rules and the cadence change
(`86200c6`), the tracker writing `notify_intent` outbox rows with its injector RPC (`b89a974`),
the `notify` consumer, channels, preferences and Postgres migration 0008 (`6e587f1`), and the
live-tracking gate, the admin injector route, the end-to-end acceptance test and these docs (part
4). This file records what ran on the build machine with its result, how each acceptance item is
proven, the measurements, what the build found that the spec did not have, where the build
departs from the spec and why, and what stays unverified. The spec is
[15-notification-policy.md](15-notification-policy.md); the research behind it is
`docs/research/phase1/R4-change-detection.md` (R4) and `R2-client-push.md` (R2).

The machine: macOS 27.0, Node 24.21.0, pnpm 12.5.1, wrangler 4.135.0, embedded PostgreSQL 18.4.
No provider, Apple, Google or Cloudflare account: every provider read went to the test harness's
fake gateway, and every queue the increment produces into (`persist`, `notify`, `push`) was a
recorder in the Workers pool, its messages handed to the real consumers by the tests.

## What ran here

Parts 2 and 3 recorded no counts in their commits; their tests are among the files part 4 re-ran
one at a time below, with the counts as of part 4.

| Part | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | Shared policy and cadence tests | `pnpm exec vitest run` (packages/shared) | passed: notification-policy 85, cadence 60 (3 new for N8), cadence-table 8; shared 695 in all |
| 4 | Shared suite | `pnpm exec vitest run` (packages/shared) | passed: 27 files, 712 tests; notification-policy 89 (part 2 added the un-cancellation rows), cadence 60, cadence-table 8, notify 6 (the channels), preferences 10 |
| 4 | Shared typecheck and lint | `pnpm run typecheck`, `pnpm run lint` (packages/shared) | passed |
| 4 | API typecheck and lint | `pnpm run typecheck` (the migration hash, `tsc -b` with the tests, the consumer check), `pnpm run lint` (apps/api) | passed |
| 4 | The injector, new | `pnpm exec vitest run test/workers/admin-inject.test.ts` | passed: 6 (the acceptance test end to end, the form and its link, the refusals, production's allow-list, two on the event builder) |
| 4 | `notify` | `pnpm exec vitest run test/workers/notify.test.ts` | passed: 9 (8 from part 3, one for the live-tracking gate) |
| 4 | The tracker's policy | `pnpm exec vitest run test/workers/flight-tracker.policy.test.ts` | passed: 8 |
| 4 | The lifecycle walk | `pnpm exec vitest run test/workers/flight-tracker.lifecycle.test.ts` | passed: 3 (the measurement line is under [Measurements](#measurements)) |
| 4 | persist | `pnpm exec vitest run test/workers/persist.test.ts` | passed: 10 |
| 4 | The admin page | `pnpm exec vitest run test/workers/admin-push.test.ts`, then `admin-access.test.ts` | passed: 12, 9 |
| 4 | Preferences and the live-tracking slots | `pnpm exec vitest run test/workers/me.test.ts`, then `live-tracked.test.ts` | passed: 11, 4 |
| 4 | `notify`'s pure parts | `pnpm exec vitest run test/unit/notify-jobs.test.ts`, then `notify-render.test.ts` | passed: 3, 10 |
| 4 | Formatting | `pnpm exec prettier --check` on every changed file (repository root) | clean |
| 4 | Migration hash | `node scripts/gen-migration-hash.mjs --check` | up to date: 9 migrations, `807a78c70e44...` (migration 0008 is part 3's) |
| 4 | Cadence table | `pnpm run gen:cadence-table` (packages/shared) | `docs/architecture.md` up to date |
| 4 | Staging dry run | `pnpm --filter @planeahead/api exec wrangler deploy --dry-run --env staging` | passed: 3,649.32 KiB, gzip 727.26 KiB (increment 14: 3,570.73 and 707.80); `env.NOTIFY_QUEUE (planeahead-notify-staging)` among the bindings |
| 4 | Production dry run | the same with `--env production` | passed: the same size; `env.NOTIFY_QUEUE (planeahead-notify)` |

Not run in part 4: the whole API suite in one call (the brief runs the named files one at a
time), the db package's suite (its changes are part 3's: migration 0008 with
`notifications.is_test`, and the push-transport migration test cutting the journal at 0007), and
the mobile app's (untouched).

## Acceptance, item by item

- **Policy table tests** (every rule in N2 to N6):
  `packages/shared/test/notification-policy.test.ts`, 89 tests in table form under N2 (the line and its settle re-read, confirmed and cleared; after a
  pushed delay the 15-minute moves, the one-per-15-minutes limit and the correction; the arrival
  bands), N3 (the origin and destination windows, the flap dropped inside one evaluation and
  corrected after a push, the first assignment), N4 (suspect, confirm, clear, the diversion, the
  un-cancellation), N5, N6 and the policy state. In the tracker,
  `apps/api/test/workers/flight-tracker.policy.test.ts` (8): a suspected cancellation never
  finishes the tracker before its re-read, a failed re-read is retried, a confirmed one writes one
  intent and finishes, a cleared one keeps polling and writes nothing; the un-cancellation pushed
  only after its own re-read; the settle re-read at most 5 minutes after the line, pushing the
  re-read's value or clearing; the stored policy state's seeding.
- **The lifecycle test extended**: `flight-tracker.lifecycle.test.ts`, "a notify intent through
  the outbox": the intent written once under alarm retries (one `notif_dedupe` row, one distinct
  seq), persist's forward failing leaves it unconfirmed while every other row is confirmed, the
  +22 h alarm defers deletion while it is unconfirmed, and deletes once it is confirmed.
- **`notify`**: `apps/api/test/workers/notify.test.ts` (9): the subscription, mute, `push_enabled`
  and per-kind filtering with the first-assignment opt-in; pushes only to `live_tracked`
  subscriptions with a row for every subscriber who passes (part 4); the production allow-list
  for test intents and staging's every-subscriber; the 50-target split with `subjectId`,
  `notificationId` and the subscription per target; a redelivery inserting no second row; the
  permission and token-kind filtering; the channel per kind and the 12 or 24 hour text; the
  `sendBatch` packing by bytes, and a `sendBatch` failing part way, whose redelivery loses no
  target; an unreadable intent acknowledged.
- **The injector end to end**: `apps/api/test/workers/admin-inject.test.ts`, "the injector end to
  end (acceptance, plan section 8 row 15)". A tracker created through the resolver 2 hours before
  departure (origin gate B10) and persisted into Postgres, one follower live-tracked and one not,
  each with a token. Through the real admin route behind Access, the real tracker (its policy,
  `notif_dedupe`, outbox flush), the real persist consumer (forward and confirm) and the real
  `notify` consumer: the gate change to B12 makes one push job with one target (the live-tracked
  follower) and two `is_test` rows; the replay of the same injection id (the answer page's button)
  writes nothing, forwards nothing and pushes nothing; a 10-minute departure delay produces no
  intent; and afterwards the tracker's stored snapshot, policy state, version, next alarm and phase
  equal what they were before. Three `audit_log` rows name the operator.
- **The cadence change**: `packages/shared/test/cadence.test.ts`: 74 polls on time, and on a
  D-minute ground delay about D/30 more polls than the boarding-anchored A2 (within one poll for
  15, 30, 45, 90 and 180 minutes); `flight-tracker.policy.test.ts` walks a held flight polling
  every 15 minutes past scheduled out, then every 30 from out.
- **The full check and both dry runs**: green as run above. The full check was run as the named
  files one at a time rather than as one turbo call.

## Measurements

- **The lifecycle walk** (`pnpm exec vitest run test/workers/flight-tracker.lifecycle.test.ts
  --silent=false --reporter=verbose`): `[lifecycle] polls=74 alarms=74 rows_written_lifetime=1205
  rows_read_lifetime=3916 per_alarm_avg=16.3 max_batch_messages=7 max_message_bytes=1657
  instance_message_bytes_median=1340`, and 13 rows written per unchanged alarm. Increment 12
  measured 1,203 written, 3,917 read and 1,635 bytes. The two rows are SQLite migration 003's
  `ALTER TABLE flight ADD COLUMN policy_state` and its migration id row; the policy state itself
  rides on the existing `UPDATE flight`, so an alarm writes no extra row, and an on-time flight
  writes no `notify_intent` row. The 22 bytes are `"cancelSuspect":false,` on every instance row.
  ADR 0011, `docs/architecture.md` and `docs/cost-estimate.md` now cite 1,205.
- **Polls** (`cadence.test.ts`, on the shared constants): A2 on time 74 (24 and 6 around the
  departure anchor instead of 22 and 8 around boarding). A ground delay of 60 minutes: 78 polls
  anchored on departure, 76 anchored on boarding; 120 minutes: 82 against 78. A2's gap across the
  landing instant is 30 minutes (out+150 min to in; 10 before N8).
- **Provider reads the policy adds**: one settle re-read per delay event reaching the line (N2
  prices it at $0.005, an AeroAPI read), one confirming re-read per suspected cancellation (to
  AeroDataBox, 2 units, because a `cancelled` phase has no cadence window) or diversion (the
  window's provider, AeroAPI on A2), and one more per failed re-read, 5 minutes apart. The
  tracker's N4 test counts 4 calls on the fake gateway: the creation fetch, the poll that saw the
  cancellation, the failed re-read and the confirming one.
- **Rows an intent costs**: in the tracker one `notif_dedupe` row and one outbox row (deleted on
  the confirm); in Postgres one `notifications` row per subscriber who passes the preferences,
  then one `notification_deliveries` row per target from the push outcomes (increment 14). An
  injection writes the same two tracker rows per intent and nothing else there.
- **Bundle**: 3,649.32 KiB, gzip 727.26 KiB, 78.59 KiB more than increment 14's 3,570.73 KiB.

## Findings the spec did not have

1. **The policy runs on every stored snapshot**, not only in the alarm: the alarm, a user
   refresh, the reconcile refresh, an alert merge and a re-seed. Run in the alarm alone, a user
   refresh that saw `cancelled` would have finished the tracker unconfirmed (part 2).
2. **What counts as the re-read**: only the tracker's own provider read made once the re-read is
   due (5 s tolerance). An alert merge or a re-seed never confirms a suspicion (part 2).
3. **The finish hold needs a bound.** It holds the `cancelled` finish only, and only while the
   flight would still have cadence slots; the hard cap, a key drift and an unschedulable flight
   finish as before, so a provider that never answers cannot keep a tracker alive for ever
   (part 2).
4. **A failed re-read is retried 5 minutes later** (`POLICY_REREAD_RETRY_MS`), never at once and
   never trusted either way (part 2).
5. **Where the re-reads go.** A `cancelled` phase has no cadence window, so a cancellation's
   designator re-read falls back to AeroDataBox, independent of AeroAPI and priced as an
   AeroDataBox call; a diversion's re-read uses the window's provider (part 2).
6. **A suspected cancellation released the live-tracking slots.** Persist's `liveWindowStage`
   judged a `cancelled` instance row as over and released its subscriptions' `live_tracked`
   slots before the cancellation was confirmed. The orchestrator ruled the slot stays: the
   tracker sets `cancelSuspect` on the instance row while its policy state is `suspect` or
   `cancelled`, `liveWindowStage` judges such a row by time alone, and when the suspicion clears
   the entering pass retries the subscriptions the cap refused earlier (part 3).
7. **An un-cancellation cannot happen in a running tracker**: a confirmed cancellation finishes
   it. The correction path (built and tested, the tracker test setting the pushed state
   directly) is reachable only if a later increment keeps a cancelled flight tracked (part 2).
8. **Arrival bands at a band edge.** Before out, a drift smaller than the 15-minute step can
   still produce an arrival intent when the estimate crosses a band edge (part 1; a review item).
9. **The live-tracking gate's reach** (part 4). The flag is set by persist only when the flight
   enters its live window (48 hours before scheduled out) and the free tier's cap allows, so a
   change detected before the window (a cancellation announced three days out) or on a
   subscription past the cap reaches the inbox and no device. Recorded in
   `docs/open-decisions.md`, section 8.
10. **An injection meets the policy's windows** (part 4). The injector judges at the tracker's
    clock: a destination gate change injected before off, or an origin gate change more than six
    hours before scheduled out, produces no intent, and an injected delay on a flight already out
    changes nothing (the observed out wins over the estimate). The answer page says "no intents"
    and why, rather than failing.
11. **The instance row grew by 22 bytes** (`"cancelSuspect":false,` on every row; the largest
    outbox message is 1,657 bytes), far inside the 240 KB chunk limit.

## Departures from the spec, and clarifications

### Departures

1. **N3 narrows the plan's "suppressed"** to before the first push. A to B to A inside one
   evaluation never shows up as a change, so both halves drop; once B was pushed, the return to A
   within 10 minutes is pushed as a correction. Suppressing it would leave the traveller at the
   wrong gate, and the shared collapse id replaces B on screen. N3 itself records this against
   the plan.
2. **An expiry floor the rulings do not have**: every intent's `expiresAt` is at least 15 minutes
   after it was produced (`RELEVANCE_FLOOR_MINUTES`). N6 anchors most windows on an estimate; a
   flight held past a stale departure estimate would otherwise carry an `expiresAt` already in
   the past, and the push consumer would drop the intent unsent as `expired`. A review item: the
   floor's length is a judgement, not a measurement.
3. **Pushes only to `live_tracked` subscriptions** (the orchestrator's ruling after part 3,
   applied in part 4). N9 resolves "the flight's live subscriptions"; increment 8's ruling O3 and
   the Phase 0 free tier (5 subscriptions, 2 live-tracked) say the flag "from Phase 1 gates
   notifications and the Live Activity". Every subscriber who passes the preferences still gets
   the `notifications` row; only the live-tracked ones get a device target. The gate applies to
   test intents too, so an injection exercises the real path. The consequence (finding 9) is an
   open decision.
4. **The preferences route's shape.** N10 names `PATCH /v1/me/preferences` with the shared
   contract. That route already served the display preferences, so its body gains a nested
   `notifications: { pushEnabled?, events? }` mirroring the sync row (the mobile outbox's existing
   bodies still work), merged with jsonb `||` in one statement with its sync change; a new
   `GET /v1/me/preferences` answers the effective preferences, and a tombstoned preferences row
   is revived from the defaults. One route per user resource, and no client change before
   increment 16.
5. **An un-cancellation is confirmed by a re-read.** N4 says an un-cancellation after a pushed
   cancellation produces a correction; part 1 pushed it when observed, and the orchestrator ruled
   it must be confirmed like the cancellation (part 2's `applyUncancellation`): the provider flap
   that makes a cancellation suspect makes its reversal just as suspect, and "not cancelled"
   followed by "cancelled" again is the worst sequence a traveller can receive. A re-read still
   cancelled restores the pushed state.

### Where the spec was silent

The policy (part 1):

- The settle re-read applies only when the delay crosses the 15-minute line while nothing at or
  over 15 is pushed (including after a correction), so 20, 10, 20 produces a new intent; moves
  and corrections push when observed. A settle re-read that cannot measure the delay (no
  scheduled out) clears the pending delay.
- The one-per-15-minutes limit covers every delay intent (departure, arrival, corrections); a
  held change is re-evaluated at the next observation, and a settle the limit holds back stays
  pending and pushes at the next observation after the window, with no extra read.
- The arrival band is `max(0, floor(delay / 15))`; a departure intent implies the band of the
  arrival estimate it carried; a return to band 0 is a correction.
- N5 runs from 60 minutes before the departure's best estimate until out is observed, so a flight
  held past a stale estimate stays time-sensitive. The origin gate window is anchored on
  scheduled out; "observed" means the actual time is present or the status is past that point.
- Gate memory (`seen`) keeps a gate that disappears and reappears from becoming a first
  assignment.
- A diversion is the status `diverted` or an actual destination other than the planned one; a
  diversion to another airport than the one pushed is pushed again; there is no un-diversion
  correction. While cancelled or suspected cancelled every other rule is skipped; while diverted
  the destination gate and arrival delay rules are.
- N8 changes A2 only (A1, B and the literal brief keep boarding); "D/30 more polls" is measured
  against the boarding-anchored A2 for the same delay; A2's landing gap widens from 10 to 30
  minutes with no extra arrival slot (R4's D3 trade-off).

The tracker and persist (part 2):

- SQLite migration 003 adds `flight.policy_state`, `SCHEMA_VERSION` 3; the state is seeded at
  creation and reseeded when null, unreadable or of an unknown version.
- The dedupe key is `{flightKey}:{kind}:{dedupeValue}:v{version}`, the flight row's version as the
  change sequence; an injected intent's key ends `test:{injectionId}` with no version, so a
  replay dedupes.
- `NotifyIntentV1.intent.kind` uses the wider `NotificationKindSchema`, so increment 17's kinds
  need no contract change.
- `injectPolicyEvent` answers `written` per intent and ignores an absent or finished tracker.

The `notify` consumer and preferences (part 3):

- Two Android channels, `flight_changes` and `flight_delays` (`ANDROID_CHANNEL_IDS`,
  `androidChannelFor` over all 12 kinds); their names and importance are an open decision.
- Subscribers are read in runs of 500; the rows go in with `on conflict (user_id, dedupe_key) do
  nothing` and their ids are read back; `packSendBatches` counts each job as its JSON bytes plus
  1,024; wrangler sets 10, 1 s and 5 in every environment.
- Postgres migration 0008 adds `notifications.is_test` (`DB_SCHEMA_VERSION` 9, hash
  `807a78c70e44`).
- Test intents obey mute, push-off and the per-kind toggles; the allow-list is an extra filter
  on production only. `flight_subscriptions.notification_overrides` is not read (N10 names only
  mute).
- The text follows the user's `time_format` (jobs cut per format, at most two groups), times
  airport-local with a marked UTC fallback, the carrier by IATA code from the shared table else
  ICAO, the operating designator; "Earlier reported" only when the previous delay was 15 minutes
  or more; text over the bounds is cut with an ellipsis.
- A user dropped by the preferences gets no row; a recipient with no sendable token still gets
  one; the row's `data` keeps the intent's fields and the injection id. An unreadable intent is
  acknowledged and logged; built jobs are checked with `PushJobV1.parse`; a job too large for any
  `sendBatch` goes alone.

The gate and the injector (part 4):

- The gate lives in `selectRecipients` (src/notify/recipients.ts): it returns every recipient
  (each gets the row) and the live-tracked subset (`pushed`), whose tokens alone are read; the
  `notify_intent_done` log line gains `push_recipients`.
- `allowedTestPushUserIds` moved to `src/lib/push-allow-list.ts`, read by the test push, `notify`
  and the injector alike.
- The injector lives at `/admin/push/inject` beside the test push and is linked from the push
  section of `/admin`. Every page of it carries a form, so all are served with
  `form-action 'self'` and `Referrer-Policy: same-origin` (rr-ops-1).
- A replay goes through the route: the form takes an optional `injection_id` (a UUIDv7; blank
  mints a fresh one, as N11 asks for a new injection), and the answer page's "Replay this
  injection" button posts the same event with the same id. The tracker answers `written: false`
  and nothing more is sent; the acceptance test's replay is this button.
- The events: a gate change sets `originGate` or `destinationGate` (1 to 8 letters, digits or
  hyphens); a departure delay of N minutes (0 to 1,440) sets estimated out to scheduled out plus
  N and estimated in to scheduled in plus N, with `departureDelaySec` and `arrivalDelaySec`, so
  the departure intent carries the arrival it implies; a cancellation sets the status; a
  diversion sets the status `diverted` and `actualDestination` to the code (marked synthetic for
  a `ZZxx` code) and refuses the planned destination. The copy is observed at the request's time
  (`fetchedAt`) and validated with `FlightStatusSchema` before the call.
- On production the check is a live (not unsubscribed) subscription of an allow-listed user, as
  the brief words it, whatever its `live_tracked` flag; the pushes then need the flag too, which
  the form's note says.
- The answers: another origin 403 with no body (as the test push); a malformed form 400; no
  tracker 404; a finished tracker or one without a snapshot 409; a tracker past the 8 s deadline
  504, with the replay button, since the call may still land.
- The `audit_log` row (actor `admin`, action `notify.injected`, target the `flight_instances` id,
  null when Postgres lacks the flight) carries the flight key, the injection id, whether it was a
  replay, the event, the outcome, the intents and how many were written, and the operator's email
  and Access subject. It is written after the tracker answered, as the test push writes its row
  after the send; a refused form writes none.

## Unverified

- **Real providers and devices.** No policy push has reached a phone: the transport is increment
  14's, proven only against an injected `fetch` until the staging send, and every provider read
  here came from the fake gateway, so no real AeroDataBox or AeroAPI answer has produced an
  intent. Once a device is registered on staging and follows a flight inside its live window
  (the subscription must be `live_tracked`), the injector proves the path: inject an origin gate
  change (the flight within six hours of departure), see the push and the inbox row, press
  "Replay this injection" and see nothing arrive, inject a 10-minute delay and see nothing.
- **The soak.** Flap rates, the settle re-read's hit rate, the cancellation re-reads' outcomes
  and the duplicate pushes a `notify` redelivery causes are measured only by real traffic over
  days (increment 16's soak, with the push outcomes increment 14 records).
- **The in-app display of an unconfirmed cancellation.** For up to 5 minutes (longer while
  re-reads fail) the synced status says `cancelled` before the push is confirmed; how the app
  shows that is increment 16's (`docs/open-decisions.md`, section 8).
- **The Android channels' names and importance**, and that the ids are right before the first
  Android build creates them (the same section).
- **Cloudflare's own queues.** In the Workers pool the `persist`, `notify` and `push` messages
  were captured and handed to the consumers by the tests; the wrangler settings (`notify`: batch
  10, 1 s, concurrency 5) and real delivery, retries and dead-lettering are proven only by the
  dry runs and by staging.
- **Scale.** `notify`'s runs of 500 and the `sendBatch` packing are tested on dozens of
  subscribers and 150 tokens, not on a flight with thousands of followers over Hyperdrive.
- **Production's allow-list on a real deploy**, for test intents and for the injector, until
  `PUSH_INJECT_ALLOWED_USER_IDS` is set there (runbook step 19).
- **The review** of the four parts (a Fable 5.1 lens on the tracker and an Opus 5.5 lens on the
  policy, preferences and `notify`) is pending.
