# Increment 7: FlightTracker and DesignatorResolver Durable Objects

Status: complete (2026-09-23) on branch `inc7-flight-tracker`, stacked PR opened for CI. Outcome, rulings and deviations are in `docs/build-log.md` and ADR 0011; where the text below disagrees with the review rulings recorded there (retry decisions from the committed schedule, every refresh path finishing a flight, no `deleteAll` while outbox rows remain, lifetimes identified in Postgres by `do_lifetime_epoch_ms` with a per-lifetime R2 archive key, dead-lettered rows re-sent with a doubling spacing rather than confirmed, the 60 s refresh freshness window, the 30 s provider fetch timeout, migration 0002 for the lifetime column), the build log wins. Builder: Fable 5.1. Reviewers: two Opus 5 lenses (alarm and transaction correctness, outbox and data flow) plus orchestrator read. Branch `inc7-flight-tracker` based on `inc6-provider-layer`.

Read `docs/increments/06-07-providers-and-trackers.facts.md` sections 3, 4 and 5 and `04-api-bootstrap.facts.md` first. The alarm-inside-transaction question is resolved from workerd source: `setAlarm()` inside `transactionSync()` is covered by rollback. Everything below is written against that.

## Goal

The FlightTracker Durable Object (one per flight key) with the idempotent alarm handler, the per-flight budget ledger, the outbox to the `persist` queue, the persist consumer writing Postgres and Analytics Engine, the debounced KV snapshot, the finish and `deleteAll()` path, the hard lifetime; the DesignatorResolver that serialises the first provider call per marketing designator and date; the DLQ consumer; and the reconcile cron. This is where the shared-flight invariant becomes structural: one provider call per flight regardless of subscribers.

Acceptance: `flight-tracker.lifecycle.test.ts` walks a flight from creation through weekly, hourly, 15-minute, 30-minute and tail windows to `finished` and `deleteAll()` with a stubbed provider and an injected clock, asserting the provider call count equals `A2_EXPECTED_POLLS` (74) imported from `@planeahead/shared` and the AeroDataBox share equals the cadence constants for the chosen lead time; two subscribers cause one call per refresh; a repeated alarm at the same clock is a no-op; a throwing provider yields one error record per slot across six simulated retries; a flight that never reports `in` is terminated at `MAX_LIFETIME`; the rows-written count per alarm is asserted as a budgeted number; `designator-resolver.test.ts` shows 50 concurrent searches produce one provider call; `persist.test.ts` proves idempotent and monotonic upserts under duplicate and reordered delivery and that a bad Analytics Engine blob never fails a batch; `reconcile.test.ts` re-arms a tracker whose alarm was abandoned; a spike test pins that `setAlarm` inside `transactionSync` rolls back with the transaction.

## Spikes first (results recorded in the build log)

1. `setAlarm` inside `transactionSync` with a throw after it: `getAlarm()` must still return the previous value.
2. Whether an alarm scheduled in a test fires on its own wall clock under the Vitest pool (drives the `afterEach` drain design).
3. A floating rejected promise inside `alarm()`: whether it triggers a retry (the handler catches everything explicitly regardless).
4. `PRAGMA foreign_keys` behaviour in the DO: enforcement is ON by default in workerd; confirm and order deletes accordingly, using `defer_foreign_keys` in migrations if needed.

## FlightTracker

- Name = flight key. `locationHint: 'enam'` on every `getByName` call site (only the first touch honours it). No `setAlarm` in the constructor. No `setTimeout` anywhere (a pending timer makes the object non-hibernateable and billable while idle).
- SQLite schema (migrations table runner from increment 4): `flight` (key, phase, snapshot JSON as one column plus a handful of indexed scalar columns: scheduled_out, scheduled_in, actual_off, actual_in, next_refresh_at, version, operator_source; stay well under the 100-column limit by keeping the snapshot as JSON), `subscribers`, `events`, `positions` (empty ring in Phase 0), `budget` (pe spent by trigger, caps from shared), `attempts` (slot, started_at, retry_count, outcome), `user_refresh` (per user per day), `outbox` (seq, kind, payload, created_at, sent_at, confirmed_at), `notif_dedupe`, `alert_registrations` (unused until Phase 1), `kv_debounce` (last_write_at, pending). Foreign keys are enforced; deletes are ordered.
- RPC (versioned zod payloads from shared, all carrying `rpcVersion`): `subscribe`, `unsubscribe`, `getState`, `forceRefresh(reason)` (coalesced: if a fetch is in flight, the caller awaits it; per-user cap 10 per flight per day in `user_refresh`, separate sub-budget that never debits the scheduled cadence), `getCostLedger`, `ingestProviderEvent` (merges an alert payload onto the snapshot, never replaces it; alert payloads lack timezone and status).
- Alarm handler:
  1. One `transactionSync` before any I/O: read `alarmInfo?.retryCount`; look up the current slot from `refreshIntervalFor` with the injected clock; if this is a retry and an `attempts` row for this slot exists with `started_at` newer than the tier interval, mark it `skipped_retry` and skip provider I/O; otherwise insert the attempt, debit the per-flight budget (soft cap logs and stretches one tier, hard cap deletes alerts, stops polling and schedules one reconciliation poll at scheduled arrival), append the outbox intent row, and `setAlarm(next.nextRefreshAt)` without awaiting inside the transaction. The commit makes attempt, debit, outbox row and alarm atomic.
  2. If `retryCount >= 5`: `setAlarm(now + 30 s)` and return (never set-then-throw); the reconcile cron is the backstop, not the primary recovery.
  3. Fetch through the router with an explicit `this.inflightFetch` promise handle (input gates do not cover an `await` on `fetch`; `subscribe` and `forceRefresh` arriving mid-fetch await the same promise). Every provider error is caught and recorded as an error `ProviderCallRecord` with zero cost; only storage errors throw.
  4. Apply the result in a second `transactionSync`: `reconcileFlightKey` (drift recorded as an event, never a rename), snapshot update with a monotonically increasing `version`, `events` rows, outbox rows for `flight_instances`, `flight_events`, `provider_calls` and the Analytics Engine point; KV snapshot debounce state.
  5. After commit: send outbox rows to the `persist` queue in byte-chunked batches (about 240 KB, at most 100 messages), mark `sent_at`; rows are deleted only when the consumer's confirmation comes back (a `persist-ack` message or the next flush observing the row's `confirmed_at`), so a lost send is re-sent by the next alarm. Write the KV snapshot `flight:snapshot:{key}` (TTL 180 s) only if the last write is older than 2 s; a KV 429 is logged and never fails the alarm.
- Finish: `in` observed, or `MAX_LIFETIME` from shared. Flush the outbox, archive `events` to R2 (`events/{key}.json`, single put), set phase `finished`, `setAlarm(+22 h)`; that alarm re-reads the phase and the outbox in the same synchronous block, and if the outbox is empty and no subscriber arrived, calls `deleteAll()` (which cancels the alarm at this compatibility date). `subscribe()` on a finished object returns `archived`.
- Rows written per alarm is a budgeted number: the lifecycle test asserts it and the build log records it, because rows written dominate the per-flight Durable Object cost.

## DesignatorResolver

- Name `${marketingIata}${number}-${dateLocal}`. `resolve()`: check KV `search:number:{designator}:{date}` (900 s) in the Worker before touching the object (first `getByName` on a new name costs a global uniqueness check); inside the object, if a resolution is stored return it; otherwise look for an existing tracker using `regionalOperatorHint` and the marketing carrier, and if none exists make the single AeroDataBox call (in-flight promise handle for concurrent callers), run `resolveOperator` and `canonicalizeFromProvider`, create or adopt the FlightTracker, store the result for 24 h via an alarm-driven cleanup, then `deleteAll()` at expiry. The Worker catches the account-level "generating too much load" error with backoff.

## Persist consumer and DLQ

- `queue()` loops per message with its own try/catch: `ack()` on success, `retry({ delaySeconds })` with backoff from `attempts` on transient failure; never throws out of the handler. Idempotency key is `flight_key + outbox seq`; the `flight_instances` upsert is monotonic on `version` (a stale row never overwrites newer state); `flight_events` and `provider_calls` insert on conflict do nothing. Analytics Engine: every `writeDataPoint` in its own try/catch (it throws synchronously on more than 20 blobs, 20 doubles, 1 index, a 96-byte index or 16,000 cumulative blob bytes), blobs truncated, at most 200 points per invocation counted explicitly. `max_concurrency` on the persist consumer is 10 (Neon connection budget). After the batch, send a `persist-ack` with the confirmed seqs to the originating trackers (or mark confirmation in Postgres for the next flush to read).
- DLQ consumers (one per queue) write the raw message to R2 `dlq/{queue}/{id}.json` and log at error level with a Sentry event; without a consumer a thrice-failed row is deleted after four days silently.

## Reconcile cron

`*/15 * * * *` with 30 s CPU: page through `flight_instances` where `tracking_state = 'active'` and `next_refresh_at < now - 20 min`, fan out to a `reconcile` queue, and the consumer calls `getState` and re-arms via `forceRefresh('reconcile')` when `getAlarm()` is null and the phase is not finished (an alarm handler in progress also reports null, so the phase column is checked first).

## Files

```
apps/api/src/do/{flight-tracker.ts, designator-resolver.ts, migrations/flight-tracker/001.ts, migrations/designator-resolver/001.ts}
apps/api/src/queues/{persist.ts, dlq.ts, reconcile.ts}
apps/api/src/cron/reconcile.ts (real)
apps/api/src/kv/snapshot.ts, src/r2/archive.ts
apps/api/test/workers/{flight-tracker.lifecycle.test.ts, flight-tracker.retries.test.ts, designator-resolver.test.ts, persist.test.ts, dlq.test.ts, reconcile.test.ts, spikes.test.ts}
docs/adr/0011-alarm-idempotency.md, docs/adr/0007 amended with the third reason (sockets defer eviction)
```

## Constraints

- Durable Objects never open Postgres (ADR 0007). No `setTimeout`, no `blockConcurrencyWhile` around provider I/O, no `allowUnconfirmed` on budget, attempt or outbox writes, no `allowConcurrency` anywhere.
- Unique DO name per test, alarms drained in `afterEach`, no `test.concurrent` in DO files.
- No em dashes. ESM.
