# Increments 6 and 7 facts (verified 2026-09-20)

Five research passes against primary sources. Every fact carries its URL. `(unverified)` means no primary source confirmed it. `PLAN CONFLICT` means it contradicts phase0-plan.md.

## 1. AeroDataBox API

- Direct gateway base URL is `https://api.aerodatabox.com/`; auth header is `X-Api-Key` (apiKey in header, root-level security). Not RapidAPI's header pair. Spec version 1.15.3.0 (https://doc.aerodatabox.com/docs/openapi-direct-v1.yaml). The API.Market copy ships empty `securitySchemes`; do not use it as source of truth.
- **PLAN CONFLICT (hard, section 7).** Flight status path is `GET /flights/{searchBy}/{searchParam}/{dateLocal}`, not `/flights/{number}/{dateLocal}`. `searchBy` enum: `Number|Reg|CallSign|Icao24`. Correct URL: `/flights/Number/AA100/2026-09-19` (same source).
- Flight status is TIER 2 = 2 units on every plan. Tier 1 = 1, Tier 3 = 6, Free = 0 (openapi x-badges; https://aerodatabox.com/pricing/). Confirms increment 2 `cost.ts`.
- Returns a JSON **array** on 200 and **204 No Content** on a miss. No 404. Never call `.json()` on a 204; debit 2 units anyway (openapi responses).
- **PLAN CONFLICT (hard, section 7 / flight-status.ts).** No separate estimated and actual times. `revisedTime` is documented as "Actual /estimated time". Disambiguate only via the `status` enum, in one tested pure function, recorded in `fieldQuality` (openapi `FlightAirportMovementContract.revisedTime`).
- **PLAN CONFLICT (hard, section 5 / ADR 0003).** No operating carrier anywhere. `FlightContract.airline` is "Airline owning the flight number" (marketing carrier). `codeshareStatus` is `Unknown|IsOperator|IsCodeshared`, a marker not an identity. Only operator hint is `callSign`, rated "rare" pre-departure (openapi; https://aerodatabox.com/data-coverage/). DesignatorResolver cannot canonicalise from one call.
- No codeshare sibling list; `FlightStatus.codeshares` cannot be filled from AeroDataBox (openapi).
- Datetimes are `{local:"2023-10-01 14:30:00", utc:"...Z"}` with a space separator and no offset on `local`. In a Worker, `new Date(local)` parses as UTC and is silently wrong. Parse `.utc`, derive offset as local minus utc (https://aerodatabox.com/breaking-changes-2023-10/).
- **PLAN CONFLICT (hard, section 5 security).** Webhook subscriptions have no secret, no HMAC. `CreateWebHookSubscription` accepts only `url` and `maxDeliveryRetries`, and the URL "must not require additional authorization" (openapi).
- **PLAN CONFLICT (hard, section 5).** Alerts subscribe by `FlightByNumber` or `FlightByAirportIcao` only, never per instance. Billing is 1 credit per flight item per notification across a 6h-back to 72h-ahead window. One subscription per FlightTracker bills for untracked dates (openapi `SubscribeWebhook`).
- Alerts resolve a plan unknown: `FlightNotificationItemContract` embeds the full movement contract, so gate, terminal, baggage belt and all three time fields are present. Which changes *trigger* a delivery is undocumented (openapi).
- Delivery retries default to **0**, max 2, 10 second timeout. Alerts are at-most-once and lossy; the reconciliation poll is load-bearing (openapi).
- Alert management endpoints are all FREE TIER; only refill is TIER 1 (openapi x-badges).
- **PLAN CONFLICT (soft, section 8).** Schedules layer refreshes once per two weeks per airport; live layer reaches "typically up to tomorrow" (https://aerodatabox.com/data-coverage/). Daily pre-48h polling buys almost no detection.
- **PLAN CONFLICT (soft, section 7).** `withFlightPlan` doubles cost on Starter only; Growth, Scale and Mega carry no surcharge (https://aerodatabox.com/pricing/).
- **PLAN CONFLICT (soft, section 7).** `maxDaysAhead` and the FIDS window are plan attributes, not provider constants: 180/365/365 days, 12/24/48 hour FIDS windows (pricing page).
- **PLAN CONFLICT (licensing).** Starter caching term is "Standard (7 days)". Persisting flight_instances to Postgres and archiving to R2 requires Growth ($99) or above (pricing page).
- 451 is legal suppression; treat as terminal for that key, not retryable (openapi).
- Health-check endpoints are FREE TIER and can pre-check airport coverage (openapi `/health/services/*`).
- **(unverified)** The 400 body for an out-of-range date. Only a generic `ErrorContract {message, details}` is documented; unauthenticated probes hit a Cloudflare HTML 403.
- **(unverified)** 429 behaviour. No 429 declared on any endpoint in either spec despite documented 5/10/20 req/s limits. Treat any 429, 503 or non-JSON body as `rate_limited` at zero cost.

## 2. AeroAPI shapes

- Spec is 4.17.1 at https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml. Auth `x-apikey`. `ident_type` enum is `designator|registration|fa_flight_id` (no `ident` value).
- `start`/`end` limited to 10 days past and 2 days future; start inclusive, end exclusive. Confirms plan line 20.
- Billing is per result set of 15 records; `max_pages` default 1 means one billed set per call (https://www.flightaware.com/commercial/aeroapi/).
- **`status` has no enum and no example anywhere in the spec.** Derive our nine-value status from the boolean flags and OOOI timestamps; keep the string as opaque display text. Do not build a mapping table from FlightAware web UI wording.
- AeroAPI has no boarding concept and no ICAO 24-bit hex (`hex` appears zero times). `icaoHex` must come from AeroDataBox or a registration table.
- `fa_flight_id` is **not unique** in a response: a diverted flight returns the original leg and each diversion with a duplicate id. That second item is the only source for `actualDestination`. Adapter must return `FlightStatus[]`.
- Alert delivery `flight` object is a different, smaller shape: flat `origin`/`origin_icao` strings, **no timezone**, no status, no operator, no codeshares. An alert cannot build a FlightStatus; it must merge onto the last polled snapshot.
- **PLAN CONFLICT (line 21).** `hold_start` and `hold_end` do not exist. The events object has exactly nine booleans: arrival, cancelled, departure, diverted, filed, out, off, on, in.
- **PLAN CONFLICT (line 21).** Gate changes *are* in the departure bundle (up to 5 changes shared with delay alerts), so "AeroAPI does not cover gate changes" is wrong at the origin. Arrival-gate changes en route remain a real gap.
- **PLAN CONFLICT (dossier line 303).** `max_weekly` is a creation-time rejection threshold, write-only, and explicitly does not prevent deliveries. It is not a spend cap. The budget guard must count deliveries in our own ledger and `DELETE /alerts/{id}`.
- `PUT /alerts/endpoint` is account-wide and shared across environments on one key. Make `target_url` mandatory per alert.
- `event_code` is an 18-value enum, wider than the 9 configurable events. `parseWebhook` must not throw on unknown codes.
- `POST /alerts` returns 201 with the id in the `Location` header, no body. Parse with a regex.
- **PLAN CONFLICT (minor, line 19).** Standard tier carries a $100/month minimum the plan omits. Volume discounting is confirmed marginal, not retroactive.
- `/schedules` carries no estimated or actual times, no gates, no status, at 4x the price. AeroAPI is unusable beyond 48h, not merely expensive.
- `/flights/{ident}/canonical` at $0.001 is one fifth a status poll and returns `idents[]`. Add to `cost.ts`.
- **(unverified)** Whether errors and zero-result responses are billed. No FlightAware source states it; the billing page is login-gated. Default the ledger to billing every non-200.
- **(unverified)** 429 shape. No 429, Retry-After or rate-limit header appears in the spec.

## 3. Durable Object alarms and transactions

- **Resolves the increment 4 open question.** `setAlarm()` inside `transactionSync()` **is** covered by rollback. `transactionSync` opens a real SQLite SAVEPOINT; `setAlarm` writes to the `_cf_METADATA` table inside it; `SqliteMetadata::setAlarm` registers an `onRollback` that unwinds the in-memory cache; the scheduler is notified only at outer commit (https://github.com/cloudflare/workerd/blob/main/src/workerd/io/actor-sqlite.c%2B%2B, .../util/sqlite-metadata.c%2B%2B, .../api/actor-state.c%2B%2B). No docs page states this and no test covers `transactionSync` specifically, so keep a 20-line spike test.
- Signature is `setAlarm(scheduledTime: number|Date, options?)` returning a Promise. Do not await it inside `transactionSync` (@cloudflare/workers-types 5.20260919.1).
- Retries: exponential backoff from 2 seconds, max 6, only for the most recent `setAlarm` (https://developers.cloudflare.com/durable-objects/api/alarms/). **(unverified)** the multiplier and cap between the 2 second start and the 6th retry.
- Storage writes from a failed attempt are **not** rolled back; a retry sees them. That is what makes the plan's pre-I/O `transactionSync` block idempotent (workerd `ImplicitTxn`, `runAlarm` catch path).
- When the alarm manager gives up, workerd calls `abandonAlarm` and clears the row, so `getAlarm()` returns null. The `*/15` reconcile cron is the only recovery (actor-sqlite.c++).
- Adopt Cloudflare's pattern: at `retryCount >= 5`, `setAlarm(now+30s)` and **return**, never set-then-throw (https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).
- `waitForOutputLocks()` runs after the handler resolves, so an alarm whose writes fail to flush is retried. No manual `sync()` needed.
- **PLAN CONFLICT (soft, design gap).** Input gates do not cover an `await` on `fetch()`. A `subscribe()` or `forceRefresh()` RPC will interleave mid-fetch. "Coalesced inside the DO" needs an explicit `this.inflightFetch` handle. Do not use `blockConcurrencyWhile` here (30 second timeout resets the object) (https://developers.cloudflare.com/durable-objects/api/state/).
- **Foreign keys are ON by default** in DO SQLite: workerd compiles `SQLITE_DEFAULT_FOREIGN_KEYS=1`, inverting stock SQLite (https://github.com/cloudflare/workerd/blob/main/build/BUILD.sqlite3). Delete ordering in the FlightTracker schema matters.
- **(unverified)** Whether `PRAGMA foreign_keys` can be set at all inside a DO; SQLite treats it as a no-op inside a transaction and workerd wraps writes implicitly. Use `defer_foreign_keys`, which is on the allowlist.
- `sql.exec()` cannot run BEGIN or SAVEPOINT; the migration runner must use `transactionSync`.
- At `compatibility_date 2026-09-01`, `deleteAll()` also cancels the alarm and is atomic. It cannot be called inside a transaction.
- **(unverified)** What happens to in-flight RPC after `deleteAll()`. Re-read the phase marker immediately before `deleteAll` in the same synchronous block.
- Limits: 2 MB row/value, 100 KB statement, 100 columns per table, 10 GB per object, 15 minute alarm wall time. Check the flight table against the 100-column ceiling.
- **(unverified)** Whether a floating rejected promise inside `alarm()` fails the invocation. Inferred no from `runAlarm`, documented nowhere. Catch everything explicitly.
- **(unverified)** Whether DO alarms fire on wall clock under vitest-pool-workers. Still open from increment 4.

## 4. Queues, outbox and Analytics Engine

- Queue producer bindings work inside a Durable Object; `this.env.QUEUE.send()` is the documented pattern (https://developers.cloudflare.com/queues/examples/use-queues-with-durable-objects/).
- `sendBatch` caps at 100 messages **and** 256 KB total; each message up to 128 KB. A full batch allows only ~2.56 KB average, so chunk by byte count (https://developers.cloudflare.com/queues/platform/limits/).
- At-least-once delivery, and ordering is explicitly **not** guaranteed. The Postgres upsert must be idempotent and monotonic, guarded on a version column, not last-write-wins (https://developers.cloudflare.com/queues/reference/delivery-guarantees/).
- An uncaught exception retries the entire batch minus already-acked messages. Per-message try/catch, ack/retry, never throw out of `queue()` (https://developers.cloudflare.com/queues/configuration/batching-retries/).
- Defaults: batch size 10, timeout 5s, max_retries 3, concurrency autoscales to 250. **PLAN CONFLICT:** 250 concurrent consumers against a Hyperdrive budget of ~100 Neon connections is oversubscribed. Set `max_concurrency` to 10 to 20 (https://developers.cloudflare.com/queues/configuration/consumer-concurrency/).
- **Resolves an increment 4 unknown.** Paid message retention default is 345600s (4 days), configurable 60s to 14 days.
- DLQ messages with no active consumer are deleted after 4 days. The plan declares DLQs but assigns no consumers, so a thrice-failed outbox row is silently lost.
- AE cap is 250 data points per invocation; keep the 200-point chunk. The "25" figure in the brief appears in no Cloudflare source.
- **`writeDataPoint` can throw synchronously** (`JSG_REQUIRE` TypeError) on more than 20 blobs, more than 20 doubles, more than 1 index, index over 96 bytes, or cumulative blobs over **16,000 bytes** (800 x 20, stricter than the docs' "16 KB") (https://github.com/cloudflare/workerd/blob/main/src/workerd/api/analytics-engine-impl.h). Not documented. Wrap every call in try/catch or one long blob DLQs the batch.
- **(unverified)** Whether production throws or silently drops at point 251. The open-source limit enforcer is an empty no-op; the production one is closed source.
- AE sampling is equitable **per index value**. The plan sets `index1 = provider`, a two-value dimension, which is worst case. Every cost query must use `SUM(_sample_interval)`. AE retains 3 months, so Postgres stays the ledger.
- KV: 1 write per second per key throws 429; the plan's 2s debounce is inside it. `expirationTtl` minimum is 60s. Cross-region visibility lags up to 60s on top of TTL.
- R2 single-part put handles up to 5 GiB; multipart requires 5 MiB minimum parts, so it is structurally unusable for a sub-5 MB archive.
- Workers Logs: 7 day retention, 256 KB per log, account-wide forced 1% sampling above 5 billion logs/day. **(unverified)** whether `head_sampling_rate` applies to DO invocations.

## 5. DesignatorResolver and ProviderBudget

- The rate limit binding **cannot** express a daily budget: `simple.period` is hard-enumerated to 10 or 60 seconds. Counters are also per Cloudflare location across 348 cities, and Cloudflare states the binding is "intentionally designed to not be used as an accurate accounting system" (https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/). The Durable Object is the only viable budget authority.
- **PLAN CONFLICT (soft).** The Rules page names "using a Durable Object for global rate limiting or global counters" as an anti-pattern. The numbers survive it: ~3.4 debits/s average, ~14/s peak at 100k flights/month against a 200 to 500 req/s band for storage-write workloads. Record the escape hatch rather than ignore the warning.
- **PLAN CONFLICT (section 7).** AeroDataBox may **not** hard-stop at quota: credits consume first, then overage billing on supporting plans, then rejection. The DO hard cap is the only real ceiling (https://aerodatabox.com/pricing/).
- AeroDataBox enforces per-second limits the plan never records: 5/10/20 req/s on Starter/Growth/Scale. Add a rate dimension to ProviderBudget.
- `idFromName` HMACs the exact byte string, so a non-canonical flight key silently creates a second object and breaks the one-call-per-flight invariant. The normaliser is load-bearing. Only documented threshold is 1,024 bytes, above which `ctx.id.name` becomes undefined; our longest key is 23 bytes.
- First `get()` on a never-used name pays a global uniqueness check of up to a few hundred milliseconds. DesignatorResolver mints a new name per designator per day on the search path. Keep the 900s KV cache in front and catch the undocumented account-level "generating too much load" error with backoff (https://developers.cloudflare.com/durable-objects/api/namespace/, .../observability/troubleshooting/).
- A DO with a pending alarm **does** hibernate and is not billed for duration. But any pending `setTimeout` makes it permanently non-hibernateable. Debounce the KV snapshot with stored state and the next alarm, never `setTimeout` (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/).
- `connect()` or outbound WebSockets defer eviction and keep the object billable up to 15 minutes. Third independent reason DOs must not hold a Postgres socket.
- Each RPC method call is its own billed request. Storage bills until `deleteAll()`; an empty SQLite DB is ~12 KB, so the finish-path delete is a billing requirement.
- Billable usage rounds **up to the next million** before the rate applies. The 100k-flight scenario lands at ~384,000 GB-s, 4% under the 400,000 allowance; crossing it costs a full $12.50.
- Do not `setAlarm` in the constructor: an alarm waking the object runs the constructor first and would postpone cleanup forever.
- Objects and storage per account are unlimited; 500 DO classes on Paid. Five classes is fine.

## Decisions the orchestrator must take

1. **Flight key identity.** Make the key's carrier the marketing carrier with a documented merge path when AeroAPI supplies the operator; the trade-off is that two marketing numbers on one metal become two trackers and two provider spends until merged.
2. **Alert subscription ownership.** Move subscriptions to an account-level coordinator keyed by flight number and fan out by scheduled local date; the trade-off is a new component in increment 7 against uncontrolled credit burn on untracked dates.
3. **Webhook authentication.** Accept an unguessable path token plus strict schema validation and treat the body as a hint that triggers a DO re-read; the trade-off is a documented residual risk in the ADR since no cryptographic option exists.
4. **AeroDataBox plan floor.** Buy Growth at $99, not Starter at $19; the trade-off is $80/month against a licensing term that forbids the plan's own Postgres and R2 retention.
5. **Pre-48h cadence.** Cut to weekly plus one poll at T-48h; the trade-off is a slightly later schedule-change detection against roughly 5x fewer units for data that refreshes biweekly upstream.
6. **Budget authority.** Build ProviderBudget as an unsharded DO per provider per UTC day with both a unit cap and a per-second token bucket; the trade-off is a documented anti-pattern and one cross-colo round trip per debit, mitigated by a short-TTL KV copy on the read path.
7. **Queue concurrency.** Pin `max_concurrency` at 10 to 20 on the persist queue; the trade-off is slower backlog drain against exhausting the Neon connection budget.
8. **DLQ consumers.** Add a minimal DLQ consumer writing raw messages to R2 with an alert; the trade-off is one more Worker against silent four-day data loss.
9. **Status derivation.** Derive our nine-value status from flags and OOOI timestamps in one shared tested function per adapter, never from provider status strings; the trade-off is adapter complexity against building on an undocumented vocabulary.
10. **Sequencing.** Ship increment 2 before increment 6. `packages/shared/src/providers.ts` and `flight-status.ts` do not exist; `src/` holds only `index.ts`, and its `flightKeyPlaceholder` omits the origin ICAO.
11. **AeroAPI alert endpoint.** Make `target_url` mandatory per alert rather than relying on the account-wide `PUT /alerts/endpoint`; the trade-off is a per-alert field against staging leaking into production on a shared key.

## Pins and prices

| Item | Value | Source |
|---|---|---|
| AeroDataBox base URL / auth | `https://api.aerodatabox.com/`, header `X-Api-Key` | doc.aerodatabox.com/docs/openapi-direct-v1.yaml |
| AeroDataBox spec version | 1.15.3.0 (vendor a pinned snapshot) | same |
| ADB flight status | TIER 2 = 2 units; 200 array or 204 | same |
| ADB airport lookup / FIDS | 1 unit / 2 units; history range TIER 3 = 6 units | same |
| ADB alert item / management | 1 credit per item; management 0 units, refill TIER 1 | same |
| ADB plans | Starter $19 / 40k / 5 req/s; Growth $99 / 400k / 10 req/s; Scale $499 / 4M / 20 req/s | aerodatabox.com/pricing |
| ADB caching term | Starter 7 days; Growth unlimited while subscribed | same |
| AeroAPI spec version | 4.17.1, header `x-apikey` | flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml |
| AeroAPI prices | flight $0.005, canonical $0.001, position $0.010, schedules $0.020, airport flights $0.020, arrivals/departures $0.005, alert delivery $0.020, alert config $0.000 | flightaware.com/commercial/aeroapi |
| AeroAPI tiers | Personal 10/min; Standard $100/mo min, 5/s; Premium $1,000/mo min, 100/s | same |
| AeroAPI result set | 15 records; `max_pages` default 1 | same |
| DO requests / duration | 1M then $0.15/M; 400k GB-s then $12.50/M, rounded up to next million | developers.cloudflare.com/durable-objects/platform/pricing |
| DO rows written / read | 50M then $1.00/M; 25B then $0.001/M; `setAlarm` = 1 row written | same |
| DO limits | 2 MB row, 100 KB statement, 100 columns, 10 GB, 1,000 req/s soft, 15 min alarm | .../platform/limits |
| DO alarm retries | 2s backoff, max 6, then alarm abandoned | .../api/alarms |
| Queues sendBatch | 100 messages or 256 KB total; 128 KB per message | queues/platform/limits |
| Queues consumer | batch 10 / 5s, retries 3, retention 4 days, cap concurrency at 10 to 20 | queues/configuration/configure-queues |
| Analytics Engine | 250 points per invocation (use 200), 20 blobs, 20 doubles, 1 index, 96 B index, 16,000 B blobs, 3 month retention | analytics-engine/limits + workerd analytics-engine-impl.h |
| KV | 1 write/s per key, `expirationTtl` min 60s, 60s cross-region lag | kv/api/write-key-value-pairs |
| Estimated DO cost | ~$0.001 per flight; ~$31/mo at 100k flights, $0 incremental at 10k **(unverified, derived)** | derived from DO pricing |

## Appendix: open questions per research topic

### aerodatabox-api (56 facts, 2 unverified)

- What exactly does a 400 for an out-of-range dateLocal look like? The OpenAPI documents only a generic ErrorContract {message, details} with no code and no example, and it is not even confirmed that an out-of-range date yields 400 rather than 204. Unverifiable without a key, because unauthenticated calls to api.aerodatabox.com are blocked by Cloudflare with an HTML 403.
- What is the 429 shape? Neither the direct nor the API.Market OpenAPI declares a 429 on any endpoint, and no primary page documents a body or a Retry-After header, yet per-second limits (5/10/20 req/s) plainly exist. Whether the throttle comes from AeroDataBox as JSON or from Cloudflare as HTML is unknown.
- Which field changes actually trigger an alert delivery? The docs say only 'whenever the flight information gets updated'. A gate change, a one-minute ETA drift and a status transition may or may not each generate a separate billable notification, which directly determines the ASSUMED_ALERTS_PER_FLIGHT = 12 constant in increment 2's cadence.ts.
- Is there a cap on the number of webhook subscriptions per account? Neither the OpenAPI nor the alert guide states one. This bounds how many distinct flight numbers PlaneAhead can cover with alerts at all.
- On a Diverted flight, is arrival.airport rewritten to the diversion airport, or does it keep the original destination with the diversion visible only through the status enum? Undocumented, and it decides whether a diversion is a field update or requires a separate event type.
- Does the direct gateway accept lowercase searchBy path segments ('number') as well as the enum casing ('Number')? The spec's prose uses lowercase while the enum is capitalised. Sending the enum casing is safe, but knowing whether both work affects how tolerant the URL builder needs to be.
- Does the direct gateway return quota headers (remaining units, reset time) the way the marketplace gateways do? If so, the ProviderBudget DO could track the real quota rather than its own counter, which would remove a whole class of drift.
- Do the direct plans grandfather on price and quota the way the marketplace plans do? The pricing FAQ says AeroDataBox 'will generally follow the same grandfathering principle' for direct subscribers but 'reserve the right to apply any pricing plan changes to existing subscriptions'. A weaker guarantee than the marketplaces give, on a product twelve days old.

### aeroapi-shapes (35 facts, 1 unverified)

- Are AeroAPI error responses and zero-result responses billed? No FlightAware primary source states this. The billing page is login gated. This changes how src/providers/cost-log.ts records a not_found, which is the common case for our plus-or-minus-1-day designator retry. Recommend an owner task: ask FlightAware in writing before increment 6 merges, and default the mock and the ledger to billing every non-200 until answered.
- What does AeroAPI return when the Standard 5 result-sets-per-second limit is exceeded? The 4.17.1 spec documents no 429, no Retry-After and no rate-limit headers on any path. Without this the token bucket in src/providers/token-bucket.ts is guessing at backoff. Recommend recording it empirically in increment 6 against a real key and pinning the observed shape in a fixture.
- Does the alert departure bundle actually deliver a gate change, and under which event_code? The tag description says gate changes are in the bundle and the payload carries gate_origin and gate_destination, but the only plausible enum value is the generic 'change'. This decides whether plan section 2 item 3 needs rewriting or deleting, and whether the Phase 1 target cadence B can meet the 15-minute gate SLO on AeroAPI alone at the origin. Needs a live alert on a real flight to settle.
- Does an arrival-gate change en route produce any alert at all? The arrival bundle is described as 'up to 5 en-route changes (including delays of over 30 minutes and excluding diversions)', which does not mention gates. If arrival gates are poll-only, the destination-gate SLO cannot be met by alerts at any price and the cadence table's post-departure poll count cannot go to zero.
- Where does FlightStatus.icaoHex come from now that AeroAPI is confirmed to have none? Options are AeroDataBox, a registration-to-hex table seeded into packages/db, or keying the PositionPoller on callsign instead. This is a Phase 1 blocker that the Phase 0 schema should anticipate, since flight_instances would need the column either way.
- Should the account-wide PUT /alerts/endpoint be used at all, given it is shared across every environment on one API key? Either staging and production need separate AeroAPI keys (which multiplies the $100 Standard monthly minimum), or every alert must carry its own target_url. The plan does not choose. Recommend mandatory per-alert target_url plus a deliberate DELETE /alerts/endpoint so a misconfigured alert fails loudly rather than leaking into the wrong environment.
- Does GET /account/usage exist and what is its shape? It is priced at $0.000 on the pricing page but absent from the OpenAPI spec. If it exists it is the natural free reconciliation source for the ProviderBudget daily counter.
- Increment 2 has not been built, so packages/shared/src/providers.ts and flight-status.ts do not exist. Should the corrections in this sheet (remove hold_start and hold_end from AlertEvent, add flight_by_canonical to the price table, split the airport arrivals and departures price from airport_flights) be folded into increment 2 before it is built, or tracked as increment 6 amendments?

### do-alarm-transactions (33 facts, 5 unverified)

- Does a rejected promise created inside alarm() but not returned from it count as an alarm failure? workerd's runAlarm only joins the handler's returned promise, so a floating rejection appears not to trigger a retry, but this is inferred from source and stated nowhere in the docs. Load-bearing for the plan's 'every provider error is caught and logged as an error record with zero cost' rule.
- What is the exact exponential backoff multiplier and cap between the documented 2 second first delay and the 6th retry? Cloudflare publishes only the starting delay and the retry ceiling, so the total window before the alarm is abandoned (and before the */15 reconcile cron must catch it) is unknown.
- What happens to in-flight RPC calls after deleteAll()? No Cloudflare page covers this; the lifecycle page's in-flight rule is about object shutdown, which deleteAll does not trigger. Concretely: can a subscribe() landing between the outbox-empty check and deleteAll() in the +22h finish alarm resurrect the tracker as an empty DO?
- Can PRAGMA foreign_keys be set at all from inside a Durable Object, given SQLite's 'no-op within a transaction' rule and workerd's implicit transaction? Specifically, does a PRAGMA issued as the very first statement in the constructor, before any write, take effect? Untested and undocumented. Matters because workerd's build turns FK enforcement ON by default, so the FlightTracker cannot assume the stock SQLite default of OFF.
- What are the semantics of routingMode: 'primary-only', which appears in DurableObjectNamespaceGetDurableObjectOptions in @cloudflare/workers-types 5.20260919.1 alongside locationHint but is not documented on the data-location page or anywhere else in the Durable Objects docs?
- What does ctx.abort(reason, { retryAlarm: false }) actually do to a pending alarm retry? DurableObjectAbortOptions.retryAlarm exists in the types but no docs page describes it. It is the only apparent way to deterministically suppress a retry, since deleteAlarm() inside the handler is explicitly best-effort.
- Do Durable Object alarms scheduled during a vitest-pool-workers test fire on their own wall clock, or only via runDurableObjectAlarm? Still open from 04-api-bootstrap.facts.md; nothing found this pass resolves it. Settle with the throwaway 200 ms spike test before increment 7 commits to the afterEach drain as its only guard.
- Does the plan's FlightTracker 'flight' table stay under the 100-column-per-table DO SQLite limit, given it mirrors the wide flight_instances row from plan section 6 (OOOI columns, gates, terminals, baggage, aircraft, provider refs)?
- packages/shared/src/providers.ts and packages/shared/src/flight-status.ts do not exist yet. /Users/jkowall/PlaneAhead/packages/shared/src/ contains only index.ts, whose own header says 'Increment 2 fills this with Zod schemas, FlightStatus, the provider interfaces'. The interfaces the increment 6 adapters must satisfy are therefore still only specified in prose in plan section 7, not in code. Confirm increment 2 is expected to land before increment 6 starts.

### queues-outbox-ae (34 facts, 2 unverified)

- Does the production Analytics Engine limit enforcer actually throw at data point 251, or silently drop? The workerd limit-enforcer.h interface comment says it "Throws a JSG exception if the operation should be blocked due to exceeding limits", but the open-source server.c++ implementation is an empty no-op and the production enforcer is closed source. The 200-point chunk is safe either way. Resolve empirically on staging by writing 300 points in one queue() invocation and observing whether the invocation fails.
- Does the Analytics Engine 250-point cap apply per queue() invocation or per consumer batch? The workerd call path puts the counter on IoContext, which is per invocation regardless of handler type, so per invocation is the strong inference. But a persist batch of 100 messages each producing 2 or 3 AE points lands at 200 to 300, right at the boundary. Either cap points per batch explicitly or reduce max_batch_size so the worst case stays under 200.
- Does Workers Logs head_sampling_rate apply to Durable Object invocations, and is there any DO-specific observability config? No Cloudflare page mentions Durable Objects in the Workers Logs docs, despite Alarm appearing in the invocation handler table. Verify on the first staging deploy.
- Does a queue send from inside a Durable Object participate in the DO output gate, and can a send be lost if the DO's storage write fails after the send resolves? The workerd source shows writeDataPoint defers behind waitForOutputLocksIfNecessary for actors, but no source states the equivalent for QUEUE.send. This matters for the plan's "append the outbox intent" step inside transactionSync. Safest design regardless: persist the outbox row to DO SQLite first, send to the queue after the transaction commits, and delete the row only on a later confirmed flush.
- What is the actual per-message serialized size of a FlightTracker outbox row carrying a full normalised FlightStatus? Cannot be measured until increment 2 lands flight-status.ts. This determines the real sendBatch chunk size against the 256 KB cap.
- Does the Analytics Engine SQL API have a rate limit? Not documented on the SQL API page. Relevant to how aggressively the admin page can poll the "queries per provider per day" metric.

### designator-and-budget (48 facts, 3 unverified)

- What is the real billable wall clock of one FlightTracker alarm? The whole duration line, and the 4 percent margin under the 400,000 GB-s allowance at 100k flights/month, rests on an assumed 400 to 1,000 ms per alarm dominated by AeroDataBox latency. Measure p50 and p95 AeroDataBox response time during increment 6 and feed the real number back into docs/cost-estimate.md before increment 7 freezes the cadence.
- How many SQLite rows does one alarm actually write? Rows written is 70 to 85 percent of the per-flight Durable Objects cost, and the estimate spans 500 to 1,200 rows per flight because the FlightTracker schema is not written yet. Every index on an alarm-written table adds at least one more row per write. Count the rows in the increment 7 lifecycle test and treat the count as a budgeted number, not an emergent one.
- Is there any hard length or character limit on idFromName in production? workerd HMACs the raw bytes with no check, and the docs state none. The only published threshold is the 1,024-byte point at which ctx.id.name becomes undefined. PlaneAhead is nowhere near it, so this is unverified but harmless. Do not build any product feature (a user-supplied tracker name, for example) on an unbounded DO name without testing the real edge.
- Does the plan want EU data residency for flight or subscriber data? jurisdiction('eu') works with idFromName and is cheap to adopt now, but a jurisdictional namespace produces different ids for the same name, so switching later orphans every existing object. The docs also warn that the DurableObjectId is logged outside the jurisdiction for billing and debugging, which weakens any strict residency claim. Decide before the first production FlightTracker exists, because this is a one-way door.
- Should ProviderBudget carry an explicit locationHint? Objects do not relocate after creation, and a fresh budget object is created each UTC day at whatever colo happens to make the first provider call that day. If alarm traffic concentrates in Eastern North America, pinning 'enam' removes a daily lottery on the latency of every debit. Unmeasured today.
- Does the hot read path need a cached copy of the counter? Every is-this-provider-over-budget read is a billed request plus a cross-colo round trip to a single data center. Writing the counter to KV or the Cache API on each debit and reading that on the fast path is the obvious fix, but no Cloudflare page prescribes it, so it is inference. Decide whether increment 6 pays the round trip or adds the cache.
- What does AeroAPI do when a rate limit or monthly cap is breached? The pricing page states the caps (5 result sets/second on Standard, 100 on Premium) but not the failure mode. Whether a breach returns 429, silently queues, or bills anyway changes how the budget guard's AeroAPI branch must behave. Ask FlightAware sales alongside the volume-band confirmation the plan already flags.
- Does AeroDataBox now bill cash overages on the direct Growth and Scale plans, or only via ADS-B feeding credits? The pricing page says overages apply on 'plans that support overages' and lists direct-plan overages as 'via ADS-B feeding (other options soon)', with a cash rate shown only for the API.Market Mega plan. If direct plans can accrue cash overage, the DO hard cap is the sole defence against an unbounded bill and needs an alerting path, not just a kill switch.
- Can setAlarm be called inside transactionSync, and is the alarm write covered by rollback? Carried forward unresolved from the increment 4 facts sheet and still unanswered by any doc. Plan section 5 places it inside the transaction. This blocks increment 7. Resolve with a spike test, or move setAlarm outside the transaction and rely on the reconcile cron to re-arm trackers whose alarm never got written.

