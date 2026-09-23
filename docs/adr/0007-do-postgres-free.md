# 0007. Durable Objects never open Postgres

- Status: Accepted
- Date: 2026-09-20
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none

## Context

FlightTracker Durable Objects drive the refresh cadence from alarms. Alarms are delivered at
least once and are retried up to six times when the handler throws
([Durable Objects alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)). The
plan expects on the order of 10,000 in-window trackers at 100k flights per month, each waking on
its own schedule (hourly at T-48h, every 15 minutes near departure, every 30 minutes in flight),
plus a DesignatorResolver object per search, a UserInbox per user and eight ProviderBudget shards
per provider per day.

Two forces decide where those objects may write:

1. **Connection budget.** Hyperdrive opens roughly 100 origin connections per configuration on
   Workers Paid (a soft ceiling) and Neon reserves 7 of its per-compute limit, leaving 97 usable
   at 0.25 CU and 202 at 0.5 CU (`docs/increments/03-db-schema.facts.md` section 5). A tracker
   that opened a client inside its alarm would hold an origin connection for the life of the
   alarm; thousands of alarms landing in the same minute would queue behind that ceiling and
   starve the API Worker, which shares the same Hyperdrive configuration. Cloudflare also cleans
   Hyperdrive connections up only at the end of an invocation or on hibernation, so an object
   that stays awake keeps the socket.
2. **At-least-once alarms.** A retried alarm re-runs the handler. Every Postgres write from a
   Durable Object would have to be idempotent on its own, and a partial failure (provider call
   done, Postgres write failed) would either re-spend the provider call or lose the event.
   Keeping the object's own SQLite storage as the only thing an alarm writes makes the
   idempotency argument local: one `transactionSync` records the attempt and the outbox intent
   before any I/O, so a retry finds the attempt and skips.

## Decision

We will never open a Postgres connection from a Durable Object. Objects write only their own
SQLite storage and append intents to an outbox; the outbox is flushed to the `persist` queue,
and the queue consumer is the only writer of `flight_instances`, `flight_events` and
`provider_calls`. The API Worker and the queue consumers are the only holders of Hyperdrive
connections.

## Consequences

- Easier: the connection budget has two consumers to size (request handlers and queue batches
  of 100), the alarm handler's idempotency lives entirely inside `transactionSync`, and Postgres
  writes arrive in batches with `on conflict` on `(flight_instance_id, seq)` and on the provider
  call id, so replays are harmless.
- Harder: persistence lags the object by the queue's delivery time (seconds), so
  `flight_instances` is eventually consistent with the tracker; readers that need the live state
  read the KV snapshot or call `getState()`. Durable Object storage is authoritative only until
  flush; a deleted object loses unflushed events, which the plan accepts and documents.
- Commits us to the outbox table in every object that persists anything, and to the persist
  consumer as the single Postgres writer for flight state. Reversibility: medium. Allowing a
  direct write path later is a code change, but the connection arithmetic above would have to
  be redone.

## Alternatives considered

| Option                                               | Why not                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Each tracker writes Postgres in its alarm            | Thousands of concurrent alarms exhaust the ~100 origin connections; every write must be idempotent under retries.   |
| Tracker calls the API Worker over RPC to write       | Same connection pressure, one hop later, and the alarm still blocks on the write.                                   |
| Write-through with a bounded retry inside the object | Turns a storage failure into a provider re-spend or an event loss; the outbox already solves this without coupling. |

## References

- Durable Objects alarms (at-least-once, retry count): https://developers.cloudflare.com/durable-objects/api/alarms/
- Hyperdrive limits: https://developers.cloudflare.com/hyperdrive/platform/limits/
- Hyperdrive connection lifecycle: https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/
- Neon connection limits and the 7 reserved connections: https://neon.com/docs/connect/connection-pooling
- Phase 0 plan section 5 (Durable Objects, outbox, persist queue), `docs/plans/phase0-plan.md`.
