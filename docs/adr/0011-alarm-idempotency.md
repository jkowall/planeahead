# 0011. Alarm idempotency: the attempt row, the retry ladder, the in-flight handle, the outbox confirmation

- Status: Accepted
- Date: 2026-09-22 (amended the same day by the increment 7 review fix round)
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none

## Context

The FlightTracker Durable Object polls a provider from its alarm handler. Five platform facts
decide how that handler has to be written (all verified in
`docs/increments/06-07-providers-and-trackers.facts.md` section 3 and by the increment 7 spikes in
`apps/api/test/workers/spikes.test.ts`, plus what the real-scheduler tests in
`flight-tracker.scheduler.test.ts` observed):

1. Alarms are delivered at least once and a handler that throws is retried up to six times with
   exponential backoff from 2 seconds
   ([alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)). Storage writes from
   a failed attempt are NOT rolled back; the retry sees them (workerd `ImplicitTxn`, `runAlarm`).
   When the platform gives up it clears the alarm, so `getAlarm()` reads null and nothing but the
   reconcile cron would ever wake the object again. Observed under the pool's local scheduler
   (workerd 1.20260918.1): a handler that COMMITTED a new `setAlarm` and then threw is not retried
   at all, the committed alarm simply fires; the retry exists only for a handler that left the
   alarm as it found it. The design below does not depend on which of the two a runtime does.
2. `setAlarm()` inside `transactionSync()` is covered by the transaction's rollback: a throw after
   it leaves `getAlarm()` at its previous value (spike 1, and workerd's `SqliteMetadata::setAlarm`
   registering an `onRollback`). So the attempt row, the budget debit, the outbox intent and the
   next alarm can commit as one unit. Inside a scheduler-invoked handler the "previous value" is
   the running alarm's own, already past, time (spike 1b): a handler that swallows such a
   rolled-back transaction and returns normally leaves that stale time visible in `getAlarm()`
   and never re-fired, a ghost `health()` would report as `alarmAt` for ever. So inside `alarm()`
   a transaction that set an alarm must never be swallowed: rethrow it (which every `#tx` in the
   tracker does), or `deleteAlarm()` or `setAlarm` afterwards.
3. Input gates do not cover an `await` on `fetch()`: an RPC arriving while the alarm waits on the
   provider runs interleaved. `blockConcurrencyWhile` around the fetch is not an option (a 30
   second budget that resets the object on timeout).
4. Queues deliver at least once and out of order, and a send can be lost after the object's own
   write committed. A tracker cannot open Postgres to write its rows itself (ADR 0007).
5. A Durable Object that holds a pending timer never hibernates, so the module contains no timer
   of any kind; the one in-request wait is `scheduler.wait` in the finish path, bounded by KV's
   one-second per-key gap.

A provider call is the expensive thing in this system: a retry that repeats one doubles the
flight's cost for nothing, and a lost outbox row is a flight whose Postgres registry row falls
behind its tracker.

## Decision

We will make the alarm handler idempotent per cadence slot with these mechanisms, in this order:

1. **The attempt row and the committed schedule.** The first thing an alarm does, after joining
   whatever is in flight (a fetch or the finish path), is ONE `transactionSync` before any I/O:
   read `alarmInfo?.retryCount`, find the slot, and either insert the `attempts` row, debit the
   per-flight budget, append the outbox intent row and `setAlarm(next)` (not awaited: it is
   covered by the commit), or skip. On a platform retry the COMMITTED SCHEDULE decides, never the
   age of the last attempt: the first delivery's step 1 advanced `next_refresh_at_ms` past now
   (or to NULL when no slot follows), so a retry that finds it there marks the attempt
   `skipped_retry`, does no provider I/O, re-sends what the failed attempt left in the outbox and
   RESUMES the committed plan (re-asserts the committed alarm, one row, or runs the finish path
   when the plan had no next slot or polling is stopped); a retry that finds the due slot still
   due knows step 1 rolled back and polls it. A duplicate delivery that arrives before its slot
   (more than five seconds early) only re-arms. A slot that a refresh from outside the cadence
   (a user's, a reconcile's, a merged alert's) already answered inside the slot's tier interval is
   `satisfied` without a call; the previous scheduled poll never satisfies a slot, whatever the
   gap between two tiers' grids, so the cadence module stays normative for the poll count.
2. **The retry ladder.** At `retryCount >= 5` the handler `setAlarm(now + 30 s)` and returns,
   never set-then-throw, and never touching the committed schedule: when the backstop fires the
   schedule decides again (re-arm to the grid slot when step 1 had committed, poll the still-due
   slot when it had not, finish when it had nothing left). The ladder applies to every plan kind:
   the finish and cleanup alarms re-arm `FINISH_RETRY_MS` out at `retryCount >= 5`, counting the
   deferral. The reconcile cron is the backstop for an alarm the platform has already abandoned,
   not the primary recovery; it also selects an active row whose `next_refresh_at` is NULL and
   whose `updated_at` is older than twenty minutes, and the tracker never persists a NULL
   `next_refresh_at` for a phase that is not finished (the finish instant goes out instead).
3. **The in-flight handle and the finishing marker.** The fetch, the apply and the flush run
   behind `#inflight`, an explicit promise on the instance that `subscribe`, `forceRefresh`,
   `ingestProviderEvent`, `seed` and the alarm itself await. The finish path runs behind
   `#finishing`, which the same callers await before they read the row, so nothing fetches or
   writes events after the archive is taken. Every provider request carries
   `AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)` (30 s, a timer scoped to one request inside a
   running invocation), so the handle lives at most about that long; `health()` reports
   `inflightSinceMs`, the reconcile consumer treats one older than `INFLIGHT_STALE_MS` (5 min) as
   a hung promise and refreshes anyway, and the tracker abandons the stale handle. The adapter is
   resolved inside the fetch's try, so a `ProviderConfigError` is a zero-cost error record and one
   ops alert per configuration error, never a failed alarm; every provider error is caught and
   recorded as an error `ProviderCallRecord` at zero cost; only a storage error throws, because
   only a storage error is something a platform retry can fix.
4. **Coalescing on freshness.** `forceRefresh` coalesces twice over: onto a fetch in flight, and
   onto a snapshot younger than `USER_REFRESH_FRESHNESS_MS` (60 s, a shared constant), answering
   from the stored snapshot without a call; the per-user daily cap (10 per flight) is charged only
   when a provider call is made, and a user refresh is denied when the flight's ledger is at its
   hard cap. 500 refreshes from 500 users inside a minute cost one call.
5. **The outbox confirmation protocol.** Rows are written to the object's `outbox` table inside
   the transaction that produced them, the instance row before the events of the same
   transaction, and sent to the `persist` queue only after it commits, in byte-chunked batches
   (at most 100 messages and 240 KB of JSON per `sendBatch`; a single row over 120 KB is never
   sent and becomes an `outbox_oversize` event). `sent_at` is set on the rows the queue accepted.
   Rows are DELETED only when the persist consumer, having written a batch, confirms the seqs it
   wrote to the one tracker lifetime that sent them (`confirmPersisted`, keyed by the
   `flight_tracker:{key}@{epochMs}` origin, so a recreated object never accepts a confirmation
   meant for its predecessor); there is no `confirmed_at` column, deletion is the confirmation. A
   row unconfirmed for longer than `OUTBOX_RESEND_GRACE_MS` (10 s) is re-sent by the next flush;
   the consumer's writes are idempotent (monotonic `version` on `flight_instances`,
   `(flight_instance_id, seq)` on `flight_events`, `id` on `provider_calls`, and the Analytics
   Engine point written only when the `provider_calls` row was inserted), so a re-send is
   harmless and a failed confirmation is logged and not retried. Outbox seqs are allocated from a
   counter on the flight row rather than the rowid, because SQLite reuses a rowid once the rows
   above it are deleted, and a confirmed outbox row is exactly that.
6. **The finish path and the +22 h alarm.** Every path that learns the flight is done (the alarm,
   a user refresh, a reconcile poll, a merged alert, a re-seed) runs the same finish path: flush,
   archive the events to R2 under a per-lifetime key (`events/{key}@{epochMs}.json`, written with
   `onlyIf: { etagDoesNotMatch: '*' }`, never overwritten), set phase `finished`, write the final
   KV snapshot itself (after the in-flight write and the one-second per-key gap), and arm one
   alarm 22 hours out. That alarm re-reads the phase and the outbox in one synchronous block and
   calls `deleteAll()` ONLY once the outbox is empty, every row confirmed; while rows remain it
   re-arms hourly (`FINISH_RETRY_MS`), bounded by nothing but the rows draining, and raises the
   `flight_tracker_outbox_stuck` ops alert once after the sixth deferral. The DesignatorResolver's
   expiry alarm follows the same rule for its provider call records, deleting only once every row
   is sent, with `designator_resolver_outbox_stuck` after its sixth failed attempt. No
   `deleteAll()` ever discards a row that has not reached the queue: storage for one small object
   is cheaper than losing a flight's events or a billed search's cost record.
7. **One lifetime per flight.** A finished flight never gets a second lifetime: the resolver seeds
   no tracker when the fetched status is terminal and the cadence has nothing left to schedule
   (it answers the search from the status, `tracker: 'none'`), `flight_instances` records the
   lifetime it was written from (`do_lifetime_epoch_ms`), the persist consumer ignores rows from
   an older lifetime and refuses a newer one for a terminal instance with the
   `flight_lifetime_rejected` alert (a reborn finished flight is a bug, not data), and the archive
   key above is per lifetime.

Rows written are a budgeted number: every statement runs through one helper that sums the
cursor's `rowsWritten`, each `setAlarm` counts one, the migration DDL an object pays for at
creation is added from the runner, the totals are stored on the attempt row, and the lifecycle
test holds a full A2 walk under `ROWS_WRITTEN_BUDGET_PER_FLIGHT` (1,600). Measured on 2026-09-22
after the fix round: 1,200 rows for the whole life of an on-time flight created at T-48 h (1,173
before the DDL was counted), 13 per alarm when nothing changed, 16.2 per alarm on average with
the seed, the subscribes, the persist confirmations (charged to the tracker: they are its rows),
the finish path and the +22 h deletion spread over the 74 alarms; the largest `sendBatch` the walk
produced carried 7 messages and the largest message 1,635 bytes (a `flight_instance` row is about
1.3 KB), so the 100-message and 240 KB chunk limits are not reached on an ordinary flight.

Accepted deviations from the increment 7 spec text, stated here so they are not relitigated:
the finish reason `arrived` means the cadence's post-arrival tail poll ran (the cadence module is
normative, not "finish on `in` observed"); no `confirmed_at` column; the oversize event; the
reconcile cron selects `ACTIVE_TRACKING_STATES` (the schema has no `active` value); the router
reads `AERODATABOX_BASE_URL` (a test seam, unset in every deployment); the `queue_dead_letter`
ops event; the `absent` health phase with its 60 s cleanup alarm for an object that holds no
flight; the public test seams set through `runInDurableObject`; the soft cap as one skipped grid
slot; the hard cap's own finish reason; the ProviderBudget's daily row under operation
`budget_daily` (`budget_daily:{n}` per shard, documented in `docs/schema-review.md`).

## Consequences

- Easier: a retry is safe by construction (the committed schedule is the idempotency key, not a
  guess about what the failed attempt got to, and not a clock comparison against a neighbouring
  slot); the cost of a flight is bounded by its cadence whatever the platform does and however
  many people pull to refresh; a lost queue send is a delay, not a loss; the persist consumer can
  be restarted, re-delivered or reordered without a Postgres row going backwards or a finished
  flight coming back to life; and a tracker that dies anywhere in its last slot is still found
  and finished by the reconcile path.
- Harder: the outbox holds rows until the consumer confirms them, so a consumer outage grows
  every active tracker's storage, and a finished object whose rows never confirm lives on at
  storage cost (alerted after six hours, deleted only when the rows drain); the alarm handler is
  five steps with two transactions, not one function; every RPC that reads the snapshot has to
  know about `#inflight` and `#finishing`; and a new lifetime for a flight that is still active in
  Postgres (a recovery, never a rebirth) is applied under the lifetime rule and its events keep
  the first lifetime's `(instance, seq)` identity, which only the R2 archive per lifetime
  disambiguates.
- Commits us to `setAlarm` inside `transactionSync` (pinned by spike 1: a workerd change there
  fails the suite, not a flight), to never swallowing such a transaction inside a handler (spike
  1b), to the confirmation RPC as the only way outbox rows leave, to the per-lifetime archive key
  and the `do_lifetime_epoch_ms` column, and to the per-alarm row counts as a reviewed number.
  Reversibility: medium. Moving `setAlarm` out of the transaction would need the reconcile cron
  promoted to primary recovery; replacing the confirmation with a fixed retention would need a
  different idempotency story on the consumer.

## Alternatives considered

| Option                                                  | Why not                                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Let the platform retry the whole handler                | Storage writes from the failed attempt persist, so the retry would re-poll the provider on top of a half-applied result: double spend and a torn snapshot. |
| Judge a retry by the age of the last attempt            | A step 1 that rolled back leaves the previous slot's attempt looking fresh when tiers are closer together than the previous tier's interval: a lost slot.  |
| `blockConcurrencyWhile` around the fetch                | Its 30 second timeout resets the object; a slow provider would turn into a lost alarm.                                                                     |
| Delete outbox rows on a successful `sendBatch`          | A message the queue accepted can still be lost before the consumer writes it; the row would be gone with it.                                               |
| Keep outbox rows for a fixed time instead of confirming | Either too short (a consumer outage loses rows) or too long (every tracker carries hours of sent rows); confirmation is exact and cheap.                   |
| Force the +22 h delete after a bounded number of tries  | Rows with `sent_at` NULL never reached the queue; deleting them destroys the only copy of a flight's events or a billed search's cost record.              |
| Write Postgres from the alarm                           | ADR 0007: connection budget and the same idempotency problem one hop later.                                                                                |

## References

- Durable Objects alarms (at-least-once, retries, `alarmInfo`): https://developers.cloudflare.com/durable-objects/api/alarms/
- Rules of Durable Objects (the `retryCount >= 5` pattern): https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Storage API (`transactionSync`, `deleteAll` cancelling the alarm): https://developers.cloudflare.com/durable-objects/api/storage-api/
- Durable Object lifecycle (a pending timer prevents hibernation): https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- R2 conditional writes (`onlyIf`): https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- workerd alarm and metadata sources: https://github.com/cloudflare/workerd/blob/main/src/workerd/io/actor-sqlite.c%2B%2B, https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite-metadata.c%2B%2B
- Queues delivery guarantees and limits: https://developers.cloudflare.com/queues/reference/delivery-guarantees/, https://developers.cloudflare.com/queues/platform/limits/
- Increment 7 spikes: `apps/api/test/workers/spikes.test.ts`; the real-scheduler retry tests: `apps/api/test/workers/flight-tracker.scheduler.test.ts`; the handler: `apps/api/src/do/flight-tracker.ts`.
