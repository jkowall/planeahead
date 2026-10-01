# Increment 15: notification policy

Status: built (2026-10-01) in four parts and reviewed; the review round's rulings (Q1 to Q18)
were applied the same day in four parts: B (the policy, the adapters and the rendering), A1 (the
tracker), A2 (persist, `notify` and the push consumer) and C (the injector and these documents).
A re-review found one regression (Q19: a frozen diversion suspicion looped the alarm), fixed the
same day by a Fable 5.1 escalation round; a second re-review found no blocker or major, and the
close-out fixed or recorded its smaller findings.
What ran, the departures, the review round and what stays unverified are in
`docs/increments/15-verification.md` (the rulings' changes in its Review round section). Spec
written 2026-09-30. Builder: Opus 5.5. Reviewers: a Fable 5.1 lens on the tracker's alarm, outbox
and retry semantics (the owner's decision 11) and an Opus 5.5 lens on the policy rules,
preferences and the `notify` consumer, plus the orchestrator's read; two skeptics on every serious
finding. Branch `inc15-notification-policy`, stacked on `inc14-push-transport` after its review
fixes.

Review round. The two lenses found the same blocker independently (F1, B1): a confirmed
cancellation, and an arrival delay produced on the landing observation, reached the inbox and no
device, because the alarm that confirmed it also released the live-tracking slot in the same
flush. Three majors followed (M1 arrival bands without hysteresis, M2 a missing estimate read as
on time, M3 a suspected cancellation decided by another provider), and F2 (a Postgres outage
longer than notify's five retries, about a minute, lost the intents produced meanwhile), rated a
narrow major by its skeptics; the rest were minor or nits. Every finding was accepted.

Departures from these rulings, each with its reason in the verification file: the flap
suppression of N3 holds only before the first push (after it the return is a correction, as N3
itself records against the plan); every intent's `expiresAt` is floored at 15 minutes after it
was produced (`RELEVANCE_FLOOR_MINUTES`), so a stale estimate cannot make the push path drop it
unsent; pushes go only to subscriptions that were live-tracked when the change happened (flagged
`live_tracked`, or released at or after the intent's `producedAt`: the orchestrator's ruling after
part 3, from increment 8's O3 and the Phase 0 free tier, as review ruling Q1 corrected it), while
every subscriber who passes the preferences still gets the `notifications` row; the preferences
ride on the existing `PATCH /v1/me/preferences` as a nested `notifications` object, with a new
`GET /v1/me/preferences`; and an un-cancellation after a pushed cancellation is pushed only once a
re-read confirms it, like the cancellation itself (the orchestrator's ruling on N4). The review
round changed N4 itself: a suspected cancellation or diversion is evidence, not state, decided
only by a conclusive answer from the provider that raised it (Q11), and alert merges never confirm
one, against the plan row's "an alert code confirms". Its own departures from the review rulings:
a suspicion holds the finish for the policy's 3 fast re-reads, not Q4's literal two (part A1);
part A2 ordered supersession by `created_at` until part C put the intent's `producedAt` first; and
the departure correction at the 15-minute line keeps the owner's literal rule (decision 3) while
the arrival bands gained a 5-minute margin (Q9), the same margin for departures being a
recommendation in `docs/open-decisions.md`.

Read first: `docs/plans/phase1-plan.md` (section 3 rows Fan-out, Classification, Delay rule,
Gates, Cancellation and diversion, Cadence, Client push; section 4 Push path and Event injector;
section 5; section 8 row 15; section 9 item 3; section 13 decisions 3 to 6 and 11),
`docs/research/phase1/R4-change-detection.md` (design items D2, D3, D10 to D12 and facts 22, 27,
29, 40), `docs/research/phase1/R2-client-push.md` (time-sensitive facts 11 to 14),
`apps/api/src/do/flight-tracker.ts` (the alarm, `diffSnapshots`, the outbox, `notif_dedupe`, the
finish logic around `context.phase === 'cancelled'`), `apps/api/src/do/outbox.ts`,
`apps/api/src/do/migrations/flight-tracker/`, `packages/shared/src/cadence.ts`,
`apps/api/src/queues/persist.ts` and `notify.ts`, the increment 14 transport and `push` queue
(`docs/increments/14-push-transport.md`, including its review round: the push consumer re-reads
each target's `push_tokens` row and sends only when the row is live and its `user_id` is the
target's `subjectId`), `packages/db/src/schema/notifications.ts`, `apps/api/src/routes/me.ts`
(preferences), ADR 0011 (alarm idempotency) and ADR 0007.

## Goal

Flight changes become push jobs: the tracker classifies each change against the owner's rules,
writes one intent per push-worthy change inside the state transaction, and the pipeline resolves
the users and devices that should hear about it. Rules are provider-neutral, so they hold under any
answer from FlightAware.

## Rulings

- **N1. Classification on `FlightStatus` diffs.** A pure function over the previous and next
  snapshot plus the tracker context returns zero or more intents; it never reads provider-specific
  fields. Increment 17 later feeds alert codes into the same function as accelerators.
- **N2. Delay (decision 3).** The departure delay is the best estimate of out against scheduled
  out. When it first reaches 15 minutes, the tracker records a pending delay and moves its next
  alarm to at most 5 minutes later, whatever the cadence says; that settle re-read (one provider
  read per delay event, $0.005) produces the intent only if the delay is still 15 minutes or more,
  with the re-read's value, and otherwise clears the pending delay. After a pushed delay, a new
  intent needs the estimate to move 15 minutes or more from the last pushed value; a correction
  goes out when it falls back under 15; and never more than one delay intent per flight per 15
  minutes (a change inside that window is re-evaluated at the next observation after it). An
  arrival delay produces an intent only when it crosses a 15-minute band the last departure intent
  did not already imply. The constants live in `packages/shared` beside the cadence.
- **N3. Gates (decision 4).** Origin gate changes count from T-6 h to actual out, destination gate
  changes from actual off to actual in. A gate change is pushed when it is observed, because a late
  gate push costs the traveller more than an occasional flap. A to B to A within 10 minutes is
  suppressed only while the first change's intent has not left the tracker (both are dropped); once
  B was pushed, the return to A is pushed as a correction, because suppressing it would leave the
  user at the wrong gate, and the shared collapse id replaces B on screen. Record this as a
  departure from the plan's "suppressed". A first gate assignment produces an intent only for users
  whose preference enables it (off by default).
- **N4. Cancellation and diversion (decision 5).** A snapshot whose phase turns `cancelled` puts
  the tracker in a new `cancel_suspect` state that never finishes the tracker. A confirming re-read
  by designator (through the provider router, not by `fa_flight_id`, which returns the same flag)
  runs at the next alarm, at most 5 minutes later; a confirmed cancellation produces the intent and
  then finishes the tracker as today; a re-read that is not cancelled clears the state and produces
  nothing. An un-cancellation after a pushed cancellation produces a correction. Diversion follows
  the same confirm-then-push shape without finishing the tracker.
- **N5. Time-sensitive (decision 6).** An intent is time-sensitive when it is produced within the
  hour before the departure's best estimate and before actual out, for any kind; otherwise active.
- **N6. Relevance windows.** Each intent carries `expiresAt`: the departure's best estimate for an
  origin gate change, the arrival's best estimate for a destination gate change and for delays,
  scheduled departure plus 24 hours for a cancellation, and the arrival's best estimate plus 6
  hours for a diversion. The push path drops targets past it (increment 14).
- **N7. `notify_intent` through the outbox.** The alarm writes a `notify_intent` outbox row in the
  same transaction as the state change, guarded by `notif_dedupe`. The dedupe key names the flight,
  the kind, the value pushed and the tracker's change sequence, so a retried alarm reproduces the
  same key while a later change back to a value pushed before (a delay of 20, then 10, then 20)
  gets a new one. The outbox flushes to `persist` as today; `persist` forwards the intent to
  `notify` and confirms the row only after the forward succeeded, so a finished tracker still
  deletes only with an empty outbox (ADR 0011's invariant). Alarm retries never produce a second
  intent.
- **N8. Cadence anchored on departure.** The 15-minute band runs until `max(scheduled out,
  estimated out)` or actual out, and the 30-minute band starts there, keeping 74 polls for an
  on-time flight; the cadence tables and `docs/architecture.md` update from the shared constants.
- **N9. The `notify` consumer.** `max_batch_size` 10, `max_batch_timeout` 1 s, `max_concurrency` 5.
  For an intent it resolves the flight's live subscriptions and drops muted ones, users whose
  `push_enabled` is false, and users whose per-kind preference is off. It inserts `notifications`
  rows idempotently (unique per user and dedupe key, so a redelivered intent inserts no second
  row). It renders title and body per kind: plain, factual, every push self-contained with the
  current times and gate, within the shared length bounds. It sends `push` jobs of up to 50
  targets, one target per live token of each user, each target's `subjectId` being that user's
  id (the push consumer's liveness check compares it with the token row), and skips tokens whose
  permission is `denied` or `undetermined` (a null permission, from a client before increment 16,
  is sent). The jobs go out in as few `sendBatch` calls as the queue's limits allow (100 messages
  and 256 KB a call), and the intent is acknowledged only after the last one succeeds. A
  redelivered intent (a failure part way) re-sends all of its jobs rather than risk losing a
  target; the duplicate push that can cause is tolerated, as plan section 4 says, because the
  collapse id replaces it on screen.
- **N10. Preferences.** Per-kind toggles live in `notification_preferences.events` (delay,
  gate_change, first_gate_assignment, cancellation, diversion; defaults on except
  first_gate_assignment), exposed through `PATCH /v1/me/preferences` with the shared contract;
  per-flight mute is the existing subscription flag. The mobile UI is increment 16.
- **N11. The event injector.** An Access-protected admin action sends a synthetic next snapshot
  (a gate change, a delay, a cancellation, a diversion) to one tracker through a new RPC. The
  tracker classifies it against its current snapshot with the same function and writes the intents
  through the same outbox, but never stores the synthetic snapshot as its state, so the next real
  poll diffs against real data and produces no spurious change back. Injected intents skip the
  settle re-read and the cancellation confirmation (they are confirmed by construction), carry the
  injection id in their dedupe key, and are marked as tests in the payload and in `notifications`.
  On staging a test intent reaches every subscriber of the flight; on production `notify` sends a
  test intent only to subscribers whose user id is in `PUSH_INJECT_ALLOWED_USER_IDS`, and the
  admin action refuses a flight none of them follows. An `audit_log` row names the operator.

## Acceptance

- Policy table tests: every rule in N2 to N6, including the settle re-read (confirmed and
  cleared), the 15-minute moves, the one-per-15-minutes limit, the correction, the arrival bands,
  the gate windows, flap handling before and after the first push, the first-assignment
  preference, and `cancel_suspect` never finishing a tracker without confirmation.
- The FlightTracker lifecycle test extended: an intent under alarm retries is written once and
  confirmed once; a finished tracker with an unconfirmed intent does not delete; after the confirm
  it does.
- `notify`: a redelivery inserts no second `notifications` row and loses no target after a
  `sendBatch` that fails part way; preference and mute filtering, `push_enabled`, the 50-target
  split and the `sendBatch` limits, permission filtering, `subjectId` per target, and the
  production allow-list for test intents.
- The injector end to end in the Workers pool with a stubbed transport: one push job for a gate
  change, none for a replay, none for jitter under the thresholds, and the tracker's stored
  snapshot unchanged afterwards.
- The cadence change keeps 74 polls on time and adds about D/30 on a D-minute ground delay (tests on
  the shared constants).
- The full check and both wrangler dry runs are green.

## Out of scope

AeroAPI alert codes (increment 17), the mobile client (increment 16), quiet hours (Phase 2), the
in-app alerts inbox screen (Phase 2).
