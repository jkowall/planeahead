# 0011. Alarm idempotency: the attempt row, the retry ladder, the in-flight handle, the outbox confirmation

- Status: Accepted
- Date: 2026-09-22
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none

## Context

The FlightTracker Durable Object polls a provider from its alarm handler. Four platform facts
decide how that handler has to be written (all verified in
`docs/increments/06-07-providers-and-trackers.facts.md` section 3 and by the increment 7 spikes in
`apps/api/test/workers/spikes.test.ts`):

1. Alarms are delivered at least once and a handler that throws is retried up to six times with
   exponential backoff from 2 seconds
   ([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)). Storage writes from
   a failed attempt are NOT rolled back; the retry sees them (workerd `ImplicitTxn`, `runAlarm`).
   When the platform gives up it clears the alarm, so `getAlarm()` reads null and nothing but the
   reconcile cron would ever wake the object again.
2. `setAlarm()` inside `transactionSync()` is covered by the transaction's rollback: a throw after
   it leaves `getAlarm()` at its previous value (spike 1, and workerd's `SqliteMetadata::setAlarm`
   registering an `onRollback`). So the attempt row, the budget debit, the outbox intent and the
   next alarm can commit as one unit.
3. Input gates do not cover an `await` on `fetch()`: an RPC arriving while the alarm waits on the
   provider runs interleaved. `blockConcurrencyWhile` around the fetch is not an option (a 30
   second budget that resets the object on timeout).
4. Queues deliver at least once and out of order, and a send can be lost after the object's own
   write committed. A tracker cannot open Postgres to write its rows itself (ADR 0007).

A provider call is the expensive thing in this system: a retry that repeats one doubles the
flight's cost for nothing, and a lost outbox row is a flight whose Postgres registry row falls
behind its tracker.

## Decision

We will make the alarm handler idempotent per cadence slot with four mechanisms, in this order:

1. **The attempt row.** The first thing an alarm does is ONE `transactionSync` before any I/O:
   read `alarmInfo?.retryCount`, find the slot (the alarm's scheduled time), and either insert the
   `attempts` row, debit the per-flight budget, append the outbox intent row and `setAlarm(next)`
   (not awaited: it is covered by the commit), or, on a retry whose slot already has an attempt
   started less than one tier interval ago, mark it `skipped_retry` and do no provider I/O at all.
   A retry after a crash therefore re-sends what the failed attempt left in the outbox and never
   repeats its provider call. A duplicate delivery that arrives before its slot (more than five
   seconds early) only re-arms.
2. **The retry ladder.** At `retryCount >= 5` the handler `setAlarm(now + 30 s)` and returns,
   never set-then-throw. The 30 second alarm is an ordinary slot: it polls and the cadence resumes.
   The reconcile cron is the backstop for an alarm the platform has already abandoned, not the
   primary recovery.
3. **The in-flight handle.** The fetch, the apply and the flush run behind `#inflight`, an
   explicit promise on the instance. `subscribe`, `forceRefresh` and `ingestProviderEvent` that
   arrive while it is set await it and answer from its result: a burst of user refreshes during a
   poll costs nothing extra. Every provider error is caught and recorded as an error
   `ProviderCallRecord` at zero cost; only a storage error throws, because only a storage error is
   something a platform retry can fix.
4. **The outbox confirmation protocol.** Rows are written to the object's `outbox` table inside
   the transaction that produced them and sent to the `persist` queue only after it commits, in
   byte-chunked batches (at most 100 messages and 240 KB of JSON per `sendBatch`; a single row over
   120 KB is never sent and becomes an error event). `sent_at` is set on the rows the queue
   accepted. Rows are DELETED only when the persist consumer, having written a batch, confirms the
   seqs it wrote to the one tracker lifetime that sent them (`confirmPersisted`, keyed by the
   `flight_tracker:{key}@{epochMs}` origin, so a recreated object never accepts a confirmation
   meant for its predecessor). A row unconfirmed for longer than a short grace is re-sent by the
   next flush; the consumer's writes are idempotent (monotonic `version` on `flight_instances`,
   `(flight_instance_id, seq)` on `flight_events`, `id` on `provider_calls`), so a re-send is
   harmless and a failed confirmation is logged and not retried. Outbox seqs are allocated from a
   counter on the flight row rather than the rowid, because SQLite reuses a rowid once the rows
   above it are deleted, and a confirmed outbox row is exactly that.

Rows written are a budgeted number: every statement runs through one helper that sums the
cursor's `rowsWritten`, each `setAlarm` counts one, the totals are stored on the attempt row, and
the lifecycle test holds a full A2 walk under `ROWS_WRITTEN_BUDGET_PER_FLIGHT`.

## Consequences

- Easier: a retry is safe by construction (the slot's attempt row is the idempotency key, not a
  guess about what the failed attempt got to); the cost of a flight is bounded by its cadence
  whatever the platform does; a lost queue send is a delay, not a loss; and the persist consumer
  can be restarted, re-delivered or reordered without a Postgres row going backwards.
- Harder: the outbox holds rows until the consumer confirms them, so a consumer outage grows
  every active tracker's storage (bounded by the finish path, which gives up on an unconfirmable
  outbox after six hourly retries and deletes the object); the alarm handler is five steps with
  two transactions, not one function; and every RPC that reads the snapshot has to know about
  `#inflight`.
- Commits us to `setAlarm` inside `transactionSync` (pinned by spike 1: a workerd change there
  fails the suite, not a flight), to the confirmation RPC as the only way outbox rows leave, and
  to the per-alarm row counts as a reviewed number. Reversibility: medium. Moving `setAlarm` out
  of the transaction would need the reconcile cron promoted to primary recovery; replacing the
  confirmation with a fixed retention would need a different idempotency story on the consumer.

## Alternatives considered

| Option                                                  | Why not                                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Let the platform retry the whole handler                | Storage writes from the failed attempt persist, so the retry would re-poll the provider on top of a half-applied result: double spend and a torn snapshot. |
| `blockConcurrencyWhile` around the fetch                | Its 30 second timeout resets the object; a slow provider would turn into a lost alarm.                                                                     |
| Delete outbox rows on a successful `sendBatch`          | A message the queue accepted can still be lost before the consumer writes it; the row would be gone with it.                                               |
| Keep outbox rows for a fixed time instead of confirming | Either too short (a consumer outage loses rows) or too long (every tracker carries hours of sent rows); confirmation is exact and cheap.                   |
| Write Postgres from the alarm                           | ADR 0007: connection budget and the same idempotency problem one hop later.                                                                                |

## References

- Durable Objects alarms (at-least-once, retries, `alarmInfo`): https://developers.cloudflare.com/durable-objects/api/alarms/
- Rules of Durable Objects (the `retryCount >= 5` pattern): https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Storage API (`transactionSync`, `deleteAll` cancelling the alarm): https://developers.cloudflare.com/durable-objects/api/storage-api/
- workerd alarm and metadata sources: https://github.com/cloudflare/workerd/blob/main/src/workerd/io/actor-sqlite.c%2B%2B, https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite-metadata.c%2B%2B
- Queues delivery guarantees and limits: https://developers.cloudflare.com/queues/reference/delivery-guarantees/, https://developers.cloudflare.com/queues/platform/limits/
- Increment 7 spikes: `apps/api/test/workers/spikes.test.ts`; the handler: `apps/api/src/do/flight-tracker.ts`.
