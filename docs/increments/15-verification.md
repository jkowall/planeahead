# Increment 15 verification: notification policy

Branch `inc15-notification-policy` (stacked on `inc14-push-transport` after its review fixes),
2026-10-01. The increment was built in four parts: the pure policy rules and the cadence change
(`86200c6`), the tracker writing `notify_intent` outbox rows with its injector RPC (`b89a974`), the
`notify` consumer, channels, preferences and Postgres migration 0008 (`6e587f1`), and the
live-tracking gate, the admin injector route, the end-to-end acceptance test and these docs (part
4). This file records what ran on the build machine with its result, how each acceptance item is
proven, the measurements, what the build found that the spec did not have, where the build departs
from the spec and why, and what stays unverified. Two reviews then read the build, and their rulings
(Q1 to Q18) were applied in four more parts: B (`f75e473`: the policy, the adapters, the rendering),
A1 (`54b0cf7`: the tracker), A2 (`55ca02a`: persist, `notify`, the push consumer) and C (the
injector and these documents). The [Review round](#review-round) records them; the sections before
it describe the build, corrected where the round changed what they say, and their counts are the
build's (the round's are under the Review round's What ran). A re-review then found one
regression (Q19), fixed by a Fable escalation round (`0725c7b`) and read by a second re-review;
both, and the close-out, are under the [Re-review round](#re-review-round). The spec is
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
  --silent=false --reporter=verbose`), as the review round left it (part A1, and part C's own run
  of the same command): `[lifecycle] polls=74 alarms=74 rows_written_lifetime=1204
  rows_read_lifetime=3912 per_alarm_avg=16.3 max_batch_messages=7 max_message_bytes=1635
  instance_message_bytes_median=1318`, and 13 rows written per unchanged alarm. Increment 12
  measured 1,203 written, 3,917 read and 1,635 bytes; the build measured 1,205, 3,916 and 1,657
  (median 1,340). Two rows are SQLite migration 003's `ALTER TABLE flight ADD COLUMN
  policy_state` and its migration id row; the policy state itself rides on the existing
  `UPDATE flight`, so an alarm writes no extra row, and an on-time flight writes no
  `notify_intent` row. Part A1 saved one: an observation that moves the schedule now writes the
  flight row once, the schedule included. The build's 22 extra bytes were
  `"cancelSuspect":false,` on every instance row, a field the review round removed. ADR 0011,
  `docs/architecture.md` and `docs/cost-estimate.md` cite 1,204.
- **Polls** (`cadence.test.ts`, on the shared constants): A2 on time 74 (24 and 6 around the
  departure anchor instead of 22 and 8 around boarding). A ground delay of 60 minutes: 78 polls
  anchored on departure, 76 anchored on boarding; 120 minutes: 82 against 78. A2's gap across the
  landing instant is 30 minutes (out+150 min to in; 10 before N8).
- **Provider reads the policy adds**: one settle re-read per delay event reaching the line (N2
  prices it at $0.005, an AeroAPI read), and at most two more when settle re-reads fail (Q3); a
  suspected cancellation or diversion costs re-reads on the window's own provider (AeroAPI on A2
  in live mode, AeroDataBox in mock mode): up to 3 fast re-reads 5 minutes apart, then one at the
  sooner of the next cadence slot or 60 minutes, within a budget of 6 fast re-reads per flight
  (Q11; the build sent a cancellation's re-read to AeroDataBox, and retried a failed one every 5
  minutes without a cap). The tracker's N4 test counts 4 calls on the fake gateway: the creation
  fetch, the poll that saw the cancellation, the failed re-read and the confirming one.
- **Rows an intent costs**: in the tracker one `notif_dedupe` row and one outbox row (deleted on
  the confirm); in Postgres one `notifications` row per subscriber who passes the preferences,
  then one `notification_deliveries` row per target from the push outcomes (increment 14). An
  injection writes the same two tracker rows per intent and nothing else there.
- **Bundle**: 3,649.32 KiB, gzip 727.26 KiB, 78.59 KiB more than increment 14's 3,570.73 KiB.
  After the review round 3,672.40 KiB, gzip 732.93 KiB (part C's dry runs; part A2 measured
  3,669.99 and 732.29).

## Findings the spec did not have

1. **The policy runs on every stored snapshot**, not only in the alarm: the alarm, a user
   refresh, the reconcile refresh, an alert merge and a re-seed. Run in the alarm alone, a user
   refresh that saw `cancelled` would have finished the tracker unconfirmed (part 2).
2. **What counts as the re-read**: only the tracker's own provider read made once the re-read is
   due (5 s tolerance). An alert merge or a re-seed never confirms a suspicion (part 2).
3. **The finish hold needs a bound.** The build held the `cancelled` finish only while the flight
   would still have cadence slots (`#lifetimeLeft`), so a cancellation first seen at the last slot
   finished unconfirmed and a suspected diversion was never held (review findings F4 and the
   skeptics' diversion gap). Since part A1 a suspected cancellation or diversion holds the finish
   while fast re-reads are left, even past the last slot, then finishes unconfirmed without a
   push; the hard cap and a key drift still end it, so a provider that never answers cannot keep
   a tracker alive for ever (part 2, then Q4 and Q11).
4. **A failed re-read is never trusted either way.** The build retried it 5 minutes later
   (`POLICY_REREAD_RETRY_MS`) with no cap (F3). That constant is gone since part A1: a failed
   settle re-read is retried twice 5 minutes apart and then waits for the next cadence slot, and a
   failed suspicion re-read counts as inconclusive, spending a fast re-read (`evaluateFailedReread`;
   Q3, Q11).
5. **Where the re-reads go.** The build sent a cancellation's re-read to AeroDataBox (a
   `cancelled` phase had no cadence window), so in live mode an AeroDataBox answer could clear an
   AeroAPI suspicion (M3). Since parts B and A1 a suspicion is evidence, not state: the tracker
   keeps its confirmed phase, so every re-read goes to the window's own provider by designator,
   and only a conclusive answer from the provider that raised it decides (Q11).
6. **A suspected cancellation released the live-tracking slots.** Persist's `liveWindowStage`
   judged a `cancelled` instance row as over and released its subscriptions' `live_tracked`
   slots before the cancellation was confirmed. The orchestrator ruled the slot stays, and part 3
   built it as a `cancelSuspect` flag on the instance row, which `liveWindowStage` judged by time
   alone. This file said the flag was set while the policy state was `suspect` or `cancelled`;
   the code set it for `suspect` only (review B's nit, Q18). The flag no longer exists: since part
   A1 the tracker never stores or sends a suspected snapshot, so persist sees a `cancelled` row
   only once the cancellation is confirmed, and part A2 removed the field and persist's special
   case.
7. **An un-cancellation cannot happen in a running tracker**: a confirmed cancellation finishes
   it. The correction path (built and tested, the tracker test setting the pushed state
   directly) is reachable only if a later increment keeps a cancelled flight tracked (part 2);
   `docs/open-decisions.md` gives it to increment 17, where FlightAware's `uncancelled` alerts
   make it cheap.
8. **Arrival bands at a band edge.** Before out, a drift smaller than the 15-minute step could
   still produce an arrival intent when the estimate crossed a band edge (part 1; a review item).
   Review B measured the flap (M1), and part B gave the bands hysteresis on the way down (Q9).
9. **The live-tracking gate's reach** (part 4). The flag is set by persist only when the flight
   enters its live window (48 hours before scheduled out) and the free tier's cap allows, so a
   change detected before the window (a cancellation announced three days out) or on a
   subscription past the cap reaches the inbox and no device. Recorded in
   `docs/open-decisions.md`, section 8. The build also lost the pushes of a change confirmed in
   the alarm that released the flag (F1 and B1, the blocker); since part A2 the gate is
   "live-tracked when the change happened" (Q1).
10. **An injection meets the policy's windows** (part 4). The injector judges at the tracker's
    clock: a destination gate change injected before off, or an origin gate change more than six
    hours before scheduled out, produces no intent, and an injected delay on a flight already out
    changes nothing (the observed out wins over the estimate). The answer page says "no intents"
    and why, rather than failing.
11. **The instance row grew by 22 bytes** in the build (`"cancelSuspect":false,` on every row;
    the largest outbox message 1,657 bytes), far inside the 240 KB chunk limit. The review round
    removed the field; the largest message is 1,635 bytes again.

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
   open decision. Review ruling Q1 made the gate "live-tracked when the change happened": a
   subscription flagged `live_tracked`, or released at or after the intent's `producedAt`
   (`flight_subscriptions.live_tracked_released_at`, Postgres migration 0009).
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
  pending and pushes at the next observation after the window, with no extra read. (Since part B
  the limit is compared with 60 s of tolerance, Q13.)
- The arrival band is `max(0, floor(delay / 15))`; a departure intent implies the band of the
  arrival estimate it carried; a return to band 0 is a correction. (Since part B a band is left
  only 5 minutes below its edge and arrival delays are clamped at 0, Q9.)
- N5 runs from 60 minutes before the departure's best estimate until out is observed, so a flight
  held past a stale estimate stays time-sensitive. The origin gate window is anchored on
  scheduled out; "observed" means the actual time is present or the status is past that point.
- Gate memory (`seen`) keeps a gate that disappears and reappears from becoming a first
  assignment.
- A diversion is the status `diverted` or an actual destination other than the planned one; a
  diversion to another airport than the one pushed is pushed again; the build had no un-diversion
  correction (since part B a confirmed un-diversion is one, and the destination rules resume, Q14).
  While cancelled or suspected cancelled every other rule is skipped; while diverted the destination
  gate and arrival delay rules are.
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
  one; the row's `data` keeps the intent's fields and the injection id (and, since part C, the
  intent's `producedAt`). An unreadable intent is
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
  504, with the replay button, since the call may still land. Since part C (review ruling Q5) also
  409 when the tracker ignores the injection because its policy state holds a suspected
  cancellation or diversion or its stored snapshot is cancelled.
- The `audit_log` row (actor `admin`, action `notify.injected`, target the `flight_instances` id,
  null when Postgres lacks the flight) carries the flight key, the injection id, whether it was a
  replay, the event, the outcome, the intents and how many were written, and the operator's email
  and Access subject. The build wrote it after the tracker answered, as the test push writes its
  row after the send, so a timeout or an error left no row (F7, m5). Since part C (Q6) it is
  written before the tracker call with the outcome `pending` and settled after it as `written`
  (with the intents and how many were written), `ignored` (with the reason), `timeout` or `error`;
  a form the route itself refuses still writes none.

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
- **The in-app display of a suspected cancellation.** The build's synced status said `cancelled`
  for up to 5 minutes before the push; since part A1 the tracker keeps its last confirmed
  snapshot while a suspicion holds, so the app never shows an unconfirmed cancellation. Whether
  it shows a neutral note meanwhile is increment 16's (`docs/open-decisions.md`, section 8).
- **The Android channels' names and importance**, and that the ids are right before the first
  Android build creates them (the same section).
- **Cloudflare's own queues.** In the Workers pool the `persist`, `notify` and `push` messages
  were captured and handed to the consumers by the tests; the wrangler settings (`notify`: batch
  10, 1 s, concurrency 5, `max_retries` 100), notify's own retry delays and real delivery,
  retries and dead-lettering are proven only by the dry runs and by staging.
- **Scale.** `notify`'s runs of 500 and the `sendBatch` packing are tested on dozens of
  subscribers and 150 tokens, not on a flight with thousands of followers over Hyperdrive.
- **Production's allow-list on a real deploy**, for test intents and for the injector, until
  `PUSH_INJECT_ALLOWED_USER_IDS` is set there (runbook step 19).
- **AeroAPI in live mode.** The evidence-not-state routing is tested against a fake AeroAPI
  (`flight-tracker.aeroapi.test.ts`); no real AeroAPI answer has raised or decided a suspicion,
  and how often AeroDataBox drops a `revisedTime` it sent (Q10's residual assumption) is
  unmeasured.

## Review round

Two lenses read the build at `6c0a503` on 2026-10-01. Review A (Fable 5.1, the owner's decision
11) read the alarm, the outbox, idempotency, the policy state, the finish hold and the injector,
with probes in its own checkout (findings F1 to F10). Review B (Opus 5.5) read the rules,
`notify`, the rendering, the preferences and the injector, with policy probes and one Workers-pool
probe (B1, M1 to M3, m1 to m7 and nits). Both found the same blocker independently (F1 = B1).
Two skeptics then checked every serious finding (F1, F2, M1, M2, M3): one through the code path
with its own probes, one on severity and remedy. The orchestrator accepted every finding, as
rulings Q1 to Q18, applied in four parts: B (`f75e473`: the policy, the adapters, the
rendering), A1 (`54b0cf7`: the tracker), A2 (`55ca02a`: persist, `notify`, the push consumer)
and C (this commit: the injector, the supersession order, the preferences read, these
documents). Names: F1 or M1 is a review finding, Q1 a ruling of this round, N4 a ruling of the
spec.

Both reviews also listed what they found correct. Review A: one transaction for the intents, the
state, the events, the instance row and the alarm; one dedupe row and one seq under two alarm
retries; a dedupe key that cannot collide; deletion waiting for the intent's confirmation;
migration 003 and the reseeding; every stored snapshot evaluated once; only the tracker's own
reads resolving a due re-read; the injector storing nothing of its synthetic snapshot; N8's anchor
and its 74 polls. Review B: N2 (the line, the settle, the moves, the correction, the rate limit,
20/10/20), N3, N4 in the policy, N5 and N6 with its floor; `notify`'s filtering, idempotent rows,
jobs per time format, channels, collapse id and `sendBatch` packing; the rendering in
airport-local time; the preferences (old bodies still validate, the jsonb merge, the revival, the
sync row in one transaction); the injector's Access, Origin check, form action, allow-list,
validation and audit.

### The skeptics

**F1, skeptic 1 (code path): a real blocker, reproduced.** Its probe printed the confirming
alarm's outbox: the suspect instance row, the provider call, the `notify_intent`, a cancelled
non-suspect row under the same version, the `finished` event and the finished row, in two
`sendBatch` calls. All through persist, then `notify`: 0 jobs and 1 inbox row; `notify` run
between the intent and the rest: 1 job. When the re-read's fields differ (likely in production,
the re-read then going to AeroDataBox), the cancelled row releases the slot even without the
finish rows; a flag snapshot taken in persist would not help, since Queues do not order
deliveries. It also found two payloads under one version (`cancelSuspect` true, then false), the
same drop for an arrival delay on the first `arrived` observation, and a suspected diversion
never held against the finish.

**F1, skeptic 2 (remedy): the blocker holds; review A's fix (a) with three changes.**
`live_tracked_released_at` is sound under Queues semantics because the flag's clear and the stamp
are one UPDATE. Its holes: a duplicate push about 22 hours later, when a lost confirmation makes
the finished tracker re-send the intent (hence a guard on delivery rows); clock skew, removed by
stamping the releasing row's own Durable Object instant; and every place that takes a slot must
reset the stamp. Skipping the gate for cancellations was rejected (it is the deferred product
decision, and misses the arrival-delay case), and holding the finish until confirmed was wrong
(persist's confirmation means only "on the notify queue"). It found the account-merge gap too.

**F2, skeptic 1 (code path): real, a narrow major, the trigger overstated.** Dead-lettering takes
at least 62 s of continuous failure over six deliveries: a 60 s outage drops nothing, a 90 s one
about its first 28 s of intents. Persist does not fail first (its `notify_intent` branch never
opens the database). The dead letters are archived and alerted, not silent, but nothing replays
them, against the project's own rule AA16. Recommended: more retries (config only), plus a
replay.

**F2, skeptic 2 (severity and remedy): real, a major to fix before push goes live.** An outage
past the retry span loses the push and the inbox row of every intent, and does not heal: the
tracker has already advanced its policy state. A nightly replay arrives 1 to 27 hours late and
would stamp stale inbox rows, and review A's `pushed_at` marker does not work as worded.
Recommended: retries bounded by the intent's relevance (`max_retries` toward Cloudflare's cap of
100, an acknowledgement as `notify_intent_expired` past `expiresAt`, one alert at attempt 6),
which became Q2.

**M1, skeptic 1 (probes): real, major.** Departure pushed at 30, then arrival 29, 31, 29, 31, 29
in flight gave 5 intents; 16, 14, 16, 14 before out gave 4; the dedupe key includes the version,
so nothing downstream damps it. The plan's purpose clause (no storms from estimate jitter)
applies, while the spec's own departure line flaps the same way at 16/14.

**M2, skeptic 1 (probes): real, major.** A dropped estimate gave a 0 correction ("no longer
delayed"), then 45 again after the settle; a cancellation re-read answering `scheduled` without
estimates cleared the suspicion and sent the 0 correction; an answer with only `actualOff` after
takeoff gave a false "on time". Every AeroDataBox status without `revisedTime` produced it.

**M1, skeptic 2 (severity and remedy): real, major.** On a realistic 6-hour flight, 3 to 6
alternating pushes against 1 intended, up to 12. Recommended the fix that keeps N2's band wording:
hysteresis on the way down only, a shared 5-minute margin, arrival delays clamped at 0; and the
departure line's same flap under the owner's literal rule as a ruling, not a silent change.

**M2, skeptic 2 (severity and remedy): real, major.** One dropout gives 3 pushes against 1.
Recommended changing only `departureDelayMinutes`, routing an unmeasurable re-read through the
branch that clears the pending, clearing a settled pending on unknown too, and recording the
residual assumption.

**M3, skeptic 1 (probes): real, major, latent.** Unreachable while AeroAPI is in mock mode
everywhere. In live mode a suspected cancellation stored the `cancelled` phase, the re-read fell
back to AeroDataBox, whose `CanceledUncertain` and `Unknown` mapped to an operating status: 21
instance versions in 80 minutes alternating scheduled and cancelled, 0 intents, until the
lifetime. A same-provider re-read is only a debounce (polls are designator reads already), and
AeroAPI's `nearestInstance` could re-pick a stale cancelled `fa_flight_id`.

**M3, skeptic 2 (severity and remedy): real, major, latent; fix it in this increment.** With
AeroAPI live it is near certain for advance cancellations from T-48 h to T-24 h. Its rule set
became Q11: a suspicious read is evidence, not state; only conclusive reads from the raising
provider decide; 3 fast re-reads, then slower ones; a cancellation-aware instance selection; a
budget of 6 fast re-reads per flight; alert merges stay non-confirming. It also noted that the
un-cancellation correction is unreachable while a confirmed cancellation finishes the tracker.

### By ruling

- **Q1 (F1 = B1, blocker; F6): push to subscriptions live-tracked when the change happened.**
  Finding: the alarm that confirmed a cancellation wrote the intent and, in the same flush, the
  rows that release the live-tracking slot, so `notify`, reading `live_tracked` about a second
  later, pushed nothing; an arrival delay produced on the `arrived` observation was lost the same
  way. Changed, part A1: every instance row `#applyStatus` sends carries its own version, never two
  payloads under one (`expectOnePayloadPerVersion` in six tests). Part A2: Postgres migration
  0009 adds `flight_subscriptions.live_tracked_released_at` (`DB_SCHEMA_VERSION` 10, ten
  migrations, hash `e7dc3113...`); persist's over branch stamps it in the UPDATE that clears the
  flag, with the releasing row's own Durable Object instant (`finishedAt`, else
  `lastRefreshedAt`); persist's entering pass and the subscribe route clear it; `notify` pushes a
  subscription that is live-tracked or was released at or after the intent's `producedAt`, and
  skips a token that already has a `notification_deliveries` row for its recipient's
  notification (logged `already_delivered`); the dead `cancelSuspect` field and persist's case
  for it are gone. Proven: `notify.real-path.test.ts` (4, new), through the real tracker, the
  whole flush through persist, then `notify`: a suspected, then confirmed cancellation makes one
  push job, to the live-tracked subscriber only; the same when the confirming re-read differs;
  an arrival delay produced on the landing observation is pushed; a re-sent intent pushes again
  before its deliveries are recorded and nothing once they are. `notify.test.ts`: a subscription
  released at or after `producedAt` is pushed, one released before or never held (the cap
  refused it) is inbox only; a token with a delivery row gets nothing. `live-tracked.test.ts`:
  the stamp is the releasing row's own instant, never the consumer's clock, never on a refused
  subscription, and is cleared by the entering pass and a subscribe (the build's test of the
  `cancelSuspect` slot is gone). Against a mutant, all four real-path tests failed with no push
  job; with the guard removed, its two tests failed.
- **Q2 (F2, a narrow major): `notify` retries within the intent's relevance.** Changed, part A2:
  the `notify` queue's `max_retries` is 100 in every environment, and `notify` has its own failure
  policy in `consumeBatch` (the other consumers are unchanged): a retry after
  `min(120, 2^attempts)` seconds, about 3.17 hours of runway; an acknowledgement logged
  `notify_intent_expired` when the next attempt would land past the intent's `expiresAt`; one
  `notify_intent_failing` ops alert at attempt 6 while the retries continue. The dead-letter
  alert stays for poison; `dlq/notify/` is not replayed (the skeptics). Proven:
  `notify.test.ts`, four new tests: a failing database with a future `expiresAt` retries and
  sends nothing, then sends once after recovery; a passed `expiresAt` is acknowledged without
  sending or dead-lettering; the alert once, at attempt 6; 100 retries, about three hours, in all
  three environments' wrangler settings.
- **Q3 (F3, minor): at most two consecutive failed re-reads at +5 minutes.** Finding: a failed
  re-read was retried every 5 minutes with no cap until the hard cap. Changed, part B:
  `evaluateFailedReread` counts a settle's failed re-reads (`SETTLE_FAILED_REREADS` 2), after
  which the settle stays due for the next cadence slot; part A1: `POLICY_REREAD_RETRY_MS` is gone,
  a due re-read that produced no snapshot stores `evaluateFailedReread`'s state, and the alarm is
  the sooner of the cadence slot and the policy's `wants.at`. For a suspicion Q11 replaced it: a
  failed read spends a fast re-read. Proven: the policy's table rows; in
  `flight-tracker.suspicion.test.ts`, a settle re-read fails at most twice at +5 minutes and then
  the next slot reads, and a suspicion whose re-reads all fail costs its fast re-reads and then
  rides the cadence; in `flight-tracker.aeroapi.test.ts`, failing re-reads cost the fast re-reads
  on top of the cadence and no more.
- **Q4 (F4 and the skeptics' diversion gap): the hold is bounded by re-reads, not the lifetime.**
  Changed, part A1: `holdsFinish` holds the finish while a suspected cancellation or diversion has
  fast re-reads left, even past the cadence's last slot (that re-read goes to the last window's
  provider, `windowSourceAt`); once they are spent the flight finishes with the cadence's reason,
  pushes nothing and logs `cancel_unconfirmed` or `diversion_unconfirmed`; the hard cap and a key
  drift still end it. The cancelled-phase finish hold and `#lifetimeLeft` are gone. Proven
  (`flight-tracker.suspicion.test.ts`): a cancellation first seen at the last slot is confirmed
  and pushed; a diversion first seen at the last slot is confirmed and pushed; a flight still
  suspect once its fast re-reads are spent finishes, pushes nothing and says so.
- **Q5 (F5, minor): the injector refuses (409) an unsettled tracker.** Finding: an injection into a
  tracker whose cancellation was suspected wrote a test cancellation intent whatever was injected,
  the injection being confirmed by construction. Changed, part C: the tracker's
  `injectPolicyEvent` answers `ignored` with the new reasons `suspected` (its stored policy state
  holds a suspected cancellation or diversion) or `cancelled` (its stored snapshot is), checked
  with no await before the evaluation's transaction, and the route answers 409 with the reason;
  it now answers 409 for every `ignored` answer, as its own `getState` check already did for a
  finished tracker. Proven (`admin-inject.test.ts`, new): a suspected cancellation, a suspected
  diversion and a cancelled snapshot each answer 409, write and store nothing, and leave an audit
  row `ignored` with its reason; settled again, the same form injects. With the tracker's check
  disabled, that test fails.
- **Q6 (F7, m5): the audit row before the tracker call.** Changed, part C: the route inserts the
  `audit_log` row (its id a UUIDv7 minted by the route) with the outcome `pending` and the
  injection id before calling `injectPolicyEvent`, and updates its `details` after: `written`
  (the intents and how many were written), `ignored` (the reason), `timeout` or `error` (the
  error's name, the error then rethrown). A failed update is logged
  (`admin_inject_audit_unsettled`) and the operator still gets the tracker's answer. Proven
  (`admin-inject.test.ts`, new): while the call is in flight its row is there, `pending`, naming
  the operator; a timeout (504) settles it as `timeout` and a throw (500) as `error`. The
  acceptance and production tests now expect `written`. Without the pre-call insert, every test
  that audits fails (four of eight).
- **Q7 (F8, nit): N8's departure anchor.** Changed, part B: `actualOut ?? actualOff ??
  max(scheduledOut, estimatedOut)`; the cadence table is unchanged. Proven in `cadence.test.ts`.
- **Q8 (F9, F10, nits).** ADR 0011 item 6 gains the sentence on N4's hold (part C); part A1
  memoises `#storedPolicyState` on the stored text.
- **Q9 (M1, major): arrival bands with hysteresis on the way down.** Changed, part B: the arrival
  band moves up to `floor(delay / 15)` at once and leaves band b only when the arrival delay falls
  below 15b minus `ARRIVAL_CORRECTION_MARGIN_MINUTES` (5, shared); arrival delays are clamped at 0,
  so early to on time is silent; a re-entry after a correction mirrors the departure line. The
  departure correction at the 15 line keeps the owner's literal rule (decision 3), and
  `docs/open-decisions.md` recommends the same margin there. Proven in the policy's table tests:
  31/29 in flight gives one push; 16/14 before out one; a real recovery (20, then 8) corrects;
  early to on time is silent; 20, 8, 18 pushes 18; the one-intent-per-15-minutes arrival row stays
  green.
- **Q10 (M2, major): an unknown departure delay is unknown, not zero.** Changed, part B:
  `departureDelayMinutes` is undefined without an actual or estimated out (`departureEstimateMs`
  keeps its scheduled fallback for N5, N6 and the origin gate window); with it unknown the delay
  rules skip; an unmeasurable re-read, and a settled pending that turns unknown, clear the pending
  delay. The residual assumption (a provider that signals on time by omitting the estimate gets
  no correction until out) is in `departureDelayMinutes`'s doc comment. Proven in the table
  tests: a dropout after a push is silent with `wants` null; a runway time only after takeoff is
  silent; a recovery after a dropout corrects; an unmeasurable settle re-read clears the pending;
  a dropout while pending, then a measurable re-read, pushes; a settled pending then unknown
  clears and the arrival intent still pushes.
- **Q11 (M3, major, latent): a suspicion is evidence, not state.** Changed, part B (the policy
  and the adapters): `FlightStatus.statusUncertain`, set by the AeroDataBox adapter for
  `CanceledUncertain` and `Unknown`; a suspicion records its raising provider, its re-reads and
  its fast re-reads left (`PolicyState` v2; `readPolicyState` migrates v1); only the raising
  provider's conclusive answer on a due re-read decides (`cancelled` confirms, a positively
  operating answer clears); `unknown`, uncertain, another provider and failed reads keep it; 3
  fast re-reads 5 minutes apart (`CONFIRM_FAST_REREADS`), then the slow one bounded at 60 minutes
  (`CONFIRM_SLOW_REREAD_MINUTES`), within a per-flight budget of 6 (`CONFIRM_FAST_REREAD_BUDGET`);
  AeroAPI's `nearestInstance` prefers an operating `fa_flight_id` among equally near instances.
  Part A1 (the tracker): a snapshot showing only a suspected change keeps the stored snapshot,
  phase and times (`showsSuspectedChange`; the version moves with the schedule), writes the policy state and a
  `cancel_suspect` or `diversion_suspect` event, and no instance row or KV write shows it; the
  re-read goes to the window's own provider; an alert merge passes its provider, so it never
  decides a suspicion. Part A2 removed persist's `cancelSuspect` case, now dead. Proven: the
  policy's table rows, `status-derivation`, `aerodatabox.adapter` and `aeroapi.mock` tests (part
  B); `flight-tracker.suspicion.test.ts` in mock mode (`Canceled` twice gives one intent and
  nothing shows cancelled before it; `Canceled` then `CanceledUncertain` keeps the suspicion);
  `flight-tracker.aeroapi.test.ts` in live mode with a fake AeroAPI (an AeroAPI suspicion is
  re-read through AeroAPI, never AeroDataBox; one intent, and cancelled shown only with it; a
  `cancelled` alert onto an AeroDataBox snapshot is AeroAPI evidence, confirmed by AeroAPI).
- **Q12 (m1): the departure-delay rule stops once out is observed**, dropping a pending delay; the
  arrival rule takes over (part B, table tests).
- **Q13 (m2): the rate limit compares with a tolerance** of 60 s, so a move at the next slot is
  not held a full slot by seconds (part B, table tests).
- **Q14 (m3): a confirmed un-diversion is a correction** (value `undiverted`), confirmed by a
  re-read like an un-cancellation, and the destination rules resume; a bare `diverted` after a
  pushed airport is the same diversion (part B; table tests and `notify-render.test.ts`).
- **Q15 (m4): a correction's title states the new value**: "AA100 delay now 5 min", "AA100 now
  on time", and the arrival equivalents (part B, `notify-render.test.ts`).
- **Q16 (m6): the push consumer drops a superseded target.** Changed, part A2: the consumer's one
  liveness read also answers which targets' notifications a newer row for the same user, kind
  and flight has superseded; such a target is dropped unsent as `failed`, reason `superseded`; a
  test row never supersedes a real one, and the admin page's test push names no notification.
  Part C, on the orchestrator's ruling on A2's caveat: newer is ordered by the intent's
  `producedAt`, which `notify` now keeps in each `notifications` row's `data` (no migration), then
  by `created_at` and the id, so an older intent inserted after a newer one (after an outage in
  `notify`'s retries) never supersedes it; a row without `producedAt` is placed at its
  `created_at`. Proven (`push-consumer.test.ts`): A2's test (a superseded target dropped, the
  newest sent, a test push or a test row never superseding), and part C's: of two rows for the
  same user, kind and flight, the one produced at 11:55 and inserted first is sent and the one
  produced at 11:40 and inserted 30 s later is dropped as superseded; with A2's order that test
  fails. `notify.test.ts` (part C): the row's `data` keeps the intent's `producedAt`.
- **Q17 (m7): gates are compared after normalising case and whitespace**; gate memory keeps the
  latest spelling (part B, table tests).
- **Q18 (nits).** Part B: an arrival intent on landing reads "arrived N min late"; a diversion
  says "Departed" only with an actual out, else "Scheduled to depart"; pushes name the flight as
  the app does (`AA100`). Part C: finding 6 above no longer misstates `cancelSuspect`;
  `GET /v1/me/preferences` ignores a tombstoned `user_preferences` row, as `notify` does, and so
  does `GET /v1/me`, which reads the same preferences through its own join (`me.test.ts`, new:
  after the row is tombstoned both answer the defaults; with the filters removed it fails);
  `docs/open-decisions.md` gives `notificationOverrides.events` to increment 16 to use or drop.
- **Recorded, not fixed in this round.** The un-cancellation correction stays unreachable while a
  confirmed cancellation finishes the tracker (increment 17, where FlightAware's `uncancelled`
  alerts make it cheap), and an account merge that tombstones a live-tracked loser can leave the
  surviving subscription without its flag (`src/auth/merge.ts`, pre-existing, a separate task);
  both are in `docs/open-decisions.md`, section 8, with the departure correction's margin.

### Where the rulings were silent

Part B (the policy, the adapters, the rendering):

- `PolicyState` v1 migrates to v2 dropping a v1 suspicion (it names no provider); a suspected
  un-cancellation restores its pushed state; the next observation that still shows the change
  raises the suspicion again.
- A seed without an estimate keeps a baseline of 0 when scheduled out is known (the first
  intent's `previousValue` is `'0'`); the seed is not an observation.
- Every due re-read in the fast phase spends one unit of the budget, decided or not; a suspicion
  raised with the budget spent gets no fast re-reads; slow re-reads repeat every
  `min(slot, 60 min)` until the lifetime.
- A settle's failed re-reads go through `evaluateFailedReread` too (two retries 5 minutes apart,
  then due for the cadence slot, bounded at 60 minutes); a pending settle is left out of `wants`
  while a cancellation is not `none`.
- A suspicion is decided only by a read from its own `wants.from` minus `REREAD_TOLERANCE_MS`
  (5 s); the settle still resolves on any re-read.
- A diversion takes the same shape and shares the budget with cancellations; a bare `diverted`
  after a pushed airport is the same diversion.
- An injected confirmed snapshot that is unknown or uncertain decides nothing on a suspicion.
- The arrival correction's pushed value is the clamped arrival delay (0 for early: "now
  arriving on time"); "Arrived" titles key on `actualIn` only; gate memory stores the latest
  spelling and compares the normalised key; `positivelyOperating` is internal, with
  `applyUncancellation` folded into `applyCancellation` and `resolveCancellation`.

Part A1 (the tracker):

- A snapshot showing only a suspected change keeps the stored snapshot text (its `fetchedAt`
  too, so old data is never presented as re-confirmed), phase and scalar times (the version
  moves with the schedule), writes
  no diff events, and stores the policy state, the call's cost and `last_refreshed_at_ms` (a read
  did happen, so a user refresh within 60 s coalesces); a new suspicion writes a `cancel_suspect`
  or `diversion_suspect` event whose source is the raising provider.
- `#expectedCall` resolves the window from the operational phase; past the cadence's last slot
  `windowSourceAt` uses the last window's provider, else an AeroAPI suspicion at the last slot
  could never be confirmed in live mode.
- Step 1 plans its read as a failed one, so a crash before the answer cannot make the platform's
  retry poll twice.
- `cancel_unconfirmed` and `diversion_unconfirmed` are logged at warn level, with no timeline
  event.
- Intents produced alongside a held diversion are still written: dropping them would desync the
  policy state.
- A tracker that stored a cancelled phase under the build finishes at its next alarm without a
  re-read (transitional; the build never shipped).
- Tests changed on purpose where Q11 and Q1 changed behaviour: the N4 policy test (the phase stays
  scheduled while suspected, a `cancel_suspect` event, the policy's +5 minute re-read), the
  finish test (a refresh that suspects answers scheduled) and the designator resolver's (a
  re-seed with a fresher `fetchedAt` goes out at version 2).

Part A2 (persist, `notify`, the push consumer):

- `notify`'s retry policy lives in `consumeBatch` as `notify`'s own failure policy; the other
  consumers keep theirs.
- The duplicate guard is logged `already_delivered`; a redelivery after a failed `sendBatch`
  still sends, since no delivery row exists yet.
- A test row never supersedes a real one, so an injection cannot cancel a user's pending real
  push; a test push target (the admin page's) names no notification and is never superseded.

Part C (the injector, the supersession order, the preferences read):

- Q5's check lives in the injector RPC, not in `getState`: it runs in the tracker with no await
  before the evaluation's transaction, so no alarm can slip in between, and a refusal is audited
  under Q6. `InjectPolicyEventResponseV1.reason` gains `suspected` and `cancelled`, an optional
  enum, so the RPC version is unchanged.
- The route answers 409 for every `ignored` answer, including a flight that finished between
  `getState` and the call (the build answered 200 with a note), as its own `getState` check does.
- The audit outcome `written` covers every answer `injected`, a replay included (with `written`
  0); `error` records the error's name, not its message; the route mints the row's id; a failed
  settle is logged and masks neither the tracker's answer nor the original error.
- `producedAt` joins `data` under its existing layout `v: 1` (an added field); the supersession
  order casts it to `timestamptz`, falling back to `created_at` for a row without it.
- `GET /v1/me` ignores a tombstoned preferences row too: same file, same defect, and the two
  reads would otherwise disagree.
- `admin-inject.test.ts` uses the shared `test/workers/helpers/pipeline.ts` (`persist`,
  `pipeline`, `plantFollower`); its private copies are gone. The timeout is tested with a fake
  injector rejecting with `DeadlineExceededError`, the route's branch, rather than by waiting 8 s.

### Departures from the rulings

- **Q4's two re-reads became the policy's three** (part A1). Q11's 3 fast re-reads govern a
  suspected cancellation or diversion, and a hold of two would finish the flight before the third
  could decide it; the hold lasts while fast re-reads are left.
- **Supersession first ordered by `created_at`** (part A2), which lets an older intent that
  `notify` inserted late after an outage supersede a newer one; the orchestrator ruled
  `producedAt` first, and part C applied it.
- **The departure correction at the 15 line** keeps the owner's literal rule (decision 3) while
  the arrival bands gained the margin (Q9); the margin for departures is a recommendation in
  `docs/open-decisions.md`, not a change.
- **Alert merges never confirm**, which Q11 (6) itself records as a departure from the plan row's
  "an alert code confirms": a `cancelled` alert on a stale `fa_flight_id` is the same artefact as
  the polled flag.

### What ran

The same machine as the build; every API test file run alone from `apps/api` with
`pnpm exec vitest run <file>`, as the brief asks. Parts B, A1 and A2 are recorded from their
reports and logs; part C's are its own runs on this commit's tree.

| Part | Check | Result |
| --- | --- | --- |
| B | Shared suite (`pnpm exec vitest run`, packages/shared) | passed: 27 files, 766 tests; the policy file 130, of which 32 fail on the pre-fix policy |
| B | API unit: `aeroapi.mock`, `aerodatabox.adapter`, `notify-render` | passed: 3 files, 146 |
| B | Workers: the tracker's policy and `notify`; then `admin-inject`, the lifecycle walk and persist | passed: 2 files, 17; 3 files, 19 |
| B | Typecheck and lint (apps/api, packages/shared) | passed (9 migrations then) |
| A1 | 16 files one at a time: the tracker's `aeroapi` 4, `finish` 13, `lifecycle` 3, `outbox` 4, `policy` 8, `refresh` 8, `retries` 7, `scheduler` 2, `suspicion` 8; `persist` 10, `notify` 9, `admin-inject` 6, `live-tracked` 4, `flights.refresh` 6, `webhooks` 23, `designator-resolver` 11 | passed: 126 tests; the lifecycle line 1,204 rows written, largest message 1,635 bytes |
| A2 | 18 files one at a time: `notify` 15, `notify.real-path` 4, `persist` 10, `push-consumer` 19, `push-persist` 17, `live-tracked` 5, `flights.subscribe` 23, `admin-inject` 6, `admin-push` 12, `secrets-in-logs` 6, the tracker's `policy` 8, `suspicion` 8 and `lifecycle` 3, `dlq` 6, `dispatch` 33, `crons` 36; unit `push-transport` 76, `push-credentials` 22 | passed: 309 tests; the last four `notify`, `live-tracked`, `push-consumer` and `notify.real-path` re-run green |
| A2 | Shared and db suites; typecheck and lint (apps/api, packages/shared, packages/db) | passed: shared 27 files, 767; db 11 files, 195 |
| A2 | Mutants | the duplicate guard removed: its two tests failed (`notify`, `notify.real-path`); the real-path mutant: all four real-path tests failed, each with no push job |
| A2 | Migration hash; both dry runs | up to date, 10 migrations, `e7dc3113...`; 3,669.99 KiB, gzip 732.29 KiB |
| C | API typecheck and lint (`pnpm run typecheck`, `pnpm run lint`) | passed |
| C | Shared typecheck, lint and suite (packages/shared; `rpc.ts` changed) | passed: 27 files, 767 tests |
| C | The five files of the brief, one at a time: `admin-inject`, `push-consumer`, `notify`, `notify.real-path`, `me` | passed: 8 (6 and 2 new), 20 (19 and 1 new), 16 (15 and 1 new), 4, 12 (11 and 1 new) |
| C | Twelve more files the part's code reaches, one at a time: the lifecycle walk 3 (`--silent=false`, the line under [Measurements](#measurements)), the tracker's `policy` 8 (the injector RPC), `admin-push` 12, `admin-access` 9, `persist` 10, `live-tracked` 5, `flights.subscribe` 23, `me.delete` 9, `sync` 13, `auth-anonymous` 5, `secrets-in-logs` 6, `push-persist` 17 | passed: 120 tests (180 with the five above, in 17 files) |
| C | Mutants, each reverted after its run | the tracker's Q5 check disabled: its test failed (1 of 8); the pre-call audit insert skipped: 4 of 8 failed; A2's `created_at` order: the new order test failed (1 of 20); the tombstone filters removed: the new `me` test failed (1 of 12) |
| C | Migration hash (`node scripts/gen-migration-hash.mjs --check`) | up to date: 10 migrations, `e7dc311354dd...` (no migration in part C) |
| C | Cadence table (`pnpm run gen:cadence-table`, packages/shared) | `docs/architecture.md` up to date |
| C | Both dry runs (`pnpm --filter @planeahead/api exec wrangler deploy --dry-run --env staging`, then `production`) | passed: 3,672.40 KiB, gzip 732.93 KiB; `env.NOTIFY_QUEUE (planeahead-notify-staging)` and `(planeahead-notify)` |
| C | Formatting (`pnpm exec prettier --check` on every changed file, repository root) | clean: 16 files, of which the two under `docs/increments/` are skipped by `.prettierignore` |

The whole API suite was not run in one call (the brief runs named files one at a time), nor the
db suite in part C (no schema change) or the mobile app's (untouched); the orchestrator's full
check covers them.

### Re-review round

The Opus re-review of `6c0a503..bea247c` (2026-10-01) confirmed the blocker gone and every
ruling Q1 to Q18 applied, and found one major regression the fix round had introduced (Q19) and
a docs nit (Q20); the orchestrator escalated the fix to a Fable round, read by two skeptics.

- **Q19 (major regression): a suspected diversion frozen by a later suspected cancellation
  looped the alarm and held the finish.** AeroDataBox answered `Diverted`, then `Canceled` on
  the diversion's re-read. `run()` resolved the diversion only while the cancellation was
  `none`, so its window stayed at `lastReadAt + 5 min` in the past; `#policySchedule` scheduled
  `now` whenever `wants.at` had passed, with no floor after a read; `holdsFinish` held the
  finish on the frozen diversion once the cancellation was confirmed. Probes (mock mode): 900
  alarms and 900 AeroDataBox calls in 20 simulated minutes; run on, 4,880 alarms and 4,879 calls
  to the hard cap, the cancellation pushed once at alarm 591 and the flight finished `hard_cap`,
  not `cancelled`. Ruling, as the second skeptic refined it: (a) a cancellation, suspected
  (an un-cancellation too) or pushed, supersedes an open diversion suspicion: restored to its
  push when it carries one, else `none`, no intent, no budget unit, normalised in `run()` after
  the cancellation rule (the rule order kept) and at the top of `evaluateFailedReread`; (b)
  `policyWants` lists a diversion suspicion only while the cancellation is `none`, and
  `holdsFinish` holds only on a suspicion `policyWants` lists; (c) narrowed to a backstop: after
  a provider read, a policy `wants.at` still at or before the read plus the tolerance is floored
  to the read plus `CONFIRM_REREAD_MINUTES`, logged at error level as `policy_wants_overdue`,
  and holds no finish; the cadence's slot and a future `wants.at` are never touched;
  `EARLY_ALARM_TOLERANCE_MS` is now `REREAD_TOLERANCE_MS`; no per-time-window call bound beyond
  it; (d) with (a) at most one suspicion is ever open: a property assertion, no code. Changed:
  `supersedeDiversion` and the `policyWants` gate (`packages/shared`); `holdsFinish` by
  `wants.reasons`, `#schedule`'s `read` (`none`, `planning`, `made`) with the floor and the
  log, and the `policy` test seam (`flight-tracker.ts`). Proven: seven policy rows (Diverted
  then Canceled: diversion `none`, no intent, the cancellation's re-read 5 minutes on, then one
  intent; cleared while still Diverted: suspected afresh and confirmed; cleared with no
  diversion: nothing; an un-diversion or re-diversion then Canceled restores the push, the
  un-diversion suspected again and corrected after the clear; a cancelled alert merge drops it;
  a stored state with both open) and a seeded random walk (10 seeds by 80 steps of reads made
  exactly when the tracker would, failed reads and alert merges: after every read `wants.at` is
  past the read, never a cancellation beside a diversion suspicion, `wants.reasons` is exactly
  the open windows, the budget drops by at most 1 per evaluation and 3 per suspicion). Tracker:
  the probe as a regression (the next alarm 5 minutes on, one intent, finished `cancelled` at
  +10 minutes, 4 provider calls; the 1-second-per-alarm walk ends after 2 alarms, rows written
  under `ROWS_WRITTEN_BUDGET_PER_FLIGHT`); the cleared variant (phase `diverted`, no finish);
  the live-mode variant (a `diverted` alert merge, AeroAPI `cancelled` on the poll, 2 AeroAPI
  reads, finished `cancelled`); the backstop through the seam (a policy that moves no window:
  the alarm at the read plus 5 minutes, `policy_wants_overdue` once, and past the last slot the
  flight finishes `lifetime`, unheld); and `nextAlarm` now asserts, in every tracker test, that
  the alarm after an alarm is later than it plus the tolerance. The probes after the fix: 2
  alarms, 2 calls, finished `cancelled`, no alarm at `now`.
- **Q20 (nit): a held read does not keep the version** (`emit = changed || rescheduled || seed`
  bumps it whenever the alarm moves). Reworded in `flight-tracker.ts` (the header and
  `#applyStatus`), `docs/architecture.md`, `docs/open-decisions.md` and above: the snapshot,
  phase and times stay; the version moves with the schedule.

What ran, on this tree: typecheck and lint in `apps/api` and `packages/shared`; the shared suite
(27 files, 784 tests; the policy file 148, 17 new); one file per command from `apps/api`: the
tracker's `suspicion` 14 (6 new), `aeroapi` 5 (1 new), `policy` 8, `finish` 13, `lifecycle` 3,
`outbox` 4, `refresh` 8, `retries` 7, `scheduler` 2; `notify.real-path` 4, `persist` 10,
`admin-inject` 8; `prettier --check` on every changed file; the migration hash (up to date, 10
migrations, no migration in this round).

### Re-review of the escalation fix, and the close-out

An Opus 5.5 re-review of `0725c7b` (2026-10-01) found no blocker or major; the fix is sound. Its
probes: the skeptic's loop probe now takes 2 alarms and 2 AeroDataBox calls after the Diverted
read and finishes `cancelled` at +10 minutes, never an alarm at `now`; restoring to the push pushes
one diversion and one cancellation with no duplicate, and a cleared cancellation re-raises the
un-diversion, its correction following; Canceled then CanceledUncertain to the end takes 20 alarms
and 20 calls in 8 hours and finishes `lifetime` with `cancel_unconfirmed` once; the narrowed floor
never delays a grid slot, a user refresh before `from` or an alert merge's window. The shared
random walk catches the old bug (all 10 seeds fail on `bea247c`, on the right assertions). Q19 (a)
to (d) and Q20 are applied, and the `policy` seam is test-only in practice (nothing in `src`
assigns it, and RPC cannot set it). Findings and what the close-out did:

- **Minor 1: the tracker-level walk would not have caught the bug.** Its seeds (11, 23, 37) never
  answer Canceled while a diversion suspicion is open. Fixed: seeds 6 and 15, which fail on
  `bea247c` and pass on `0725c7b`, and an assertion that the walks meet that case at least once;
  with only the old seeds the assertion fails (0 cases met).
- **Minor 2: an unconfirmed diversion can become state while a cancellation is suspected.** A read
  that is not a re-read and shows `Diverted` is stored (`showsSuspectedChange` with `run()`); no
  push is sent. It exists since Q11 and is reachable now through Q19's path. Recorded for
  increment 17 in `docs/open-decisions.md`, section 8.
- **Nit 3: the backstop floors the combined `wants`,** not only the overdue window; unreachable with
  today's policy. Recorded here only.
- **Nit 4: a doc comment had moved onto Q19's describe** in the shared policy test. Moved back to
  `first`.
- **Nit 5: a superseded diversion leaves no closing trace.** A `diversion_superseded` info log would
  help; recorded for increment 17 (a tracker change) beside Minor 2.
- **Out of scope (Q11, live mode only): a cancellation that AeroDataBox suspects before T-48 h
  becomes undecidable** once the window switches to AeroAPI, because only the raising provider's
  conclusive answer decides it. Recorded for increment 17 beside Minor 2.

What ran for the close-out: the tracker's `suspicion` file, 14 of 14 (25 s); the mutant above
(only the old seeds, the walk alone with `-t`: the new assertion fails); `prettier --check` on both
changed test files and eslint on the tracker's. The full check of the final tree is in
`docs/build-log.md`, increment 15.
