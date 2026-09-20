# Increment 6: provider layer

Status: spec (2026-09-20). Builder: Opus 5. Reviewers: Opus 5 (adapter correctness against the vendored OpenAPI specs) plus orchestrator read. Branch `inc6-provider-layer` based on `inc5-auth`.

Read `docs/increments/06-07-providers-and-trackers.facts.md` sections 1, 2 and 5 first. Several plan statements about the providers were wrong and are corrected below.

## Goal

The provider layer in `apps/api/src/providers`: a real AeroDataBox adapter built against the vendored direct-gateway OpenAPI 1.15.3.0, a mocked AeroAPI adapter built against the vendored AeroAPI OpenAPI 4.17.1 fixtures, the cost logger, the per-flight budget guard, a per-provider token bucket, the ProviderBudget Durable Object (unit cap plus per-second rate, kill switch) and a provider router. Plus the `@planeahead/shared` amendments the research surfaced. Every call returns a `ProviderResult` with a `ProviderCallRecord`; a call without a cost record does not compile.

Acceptance: adapter unit tests pass against recorded and synthetic fixtures (Node-side Vitest with undici `MockAgent`); Workers tests prove `ProviderBudget` serialises debits, enforces the daily unit cap and the per-second rate, and flips the kill switch; the router picks AeroDataBox for every window when `AEROAPI_MODE=mock`; the AeroDataBox lookahead and the p50/p95 latency are measured with a real key when one exists and recorded in the build log (marked pending otherwise); the cadence docs regenerate with the new pre-48h rule; full check green.

## Shared amendments (`packages/shared`, done first, with tests and regenerated docs)

- `ALERT_EVENTS`: remove `hold_start` and `hold_end` (they do not exist in AeroAPI 4.17.1); the nine events are filed, departure, arrival, cancelled, diverted, out, off, on, in. Add `AEROAPI_EVENT_CODES` (the 18-value delivery `event_code` enum from the spec) as a tolerant enum for `ProviderEvent.kind` mapping, unknown codes map to `unknown`.
- `cost.ts`: add aeroapi `flight_by_canonical` 1,000 micros, `airport_arrivals` and `airport_departures` 5,000 micros (distinct from `airport_flights` 20,000), and note that the Standard tier carries a $100 monthly minimum; keep `pollEquivalents` derived.
- `FlightStatus`: add optional `operatorSource: 'provider' | 'callsign' | 'hint' | 'marketing'` and optional `marketingCarrierIcao`, `marketingFlightNumber`; add `ProviderCapabilities.maxDaysAhead` as a per-plan value supplied by config, not a constant (AeroDataBox 180 / 365 / 365 days by plan) and `fidsWindowHours` (12 / 24 / 48).
- `cadence.ts`: the pre-48h windows become one window, `pre48h`, from infinity to T-48h, interval 7 days, end-anchored (AeroDataBox's schedule layer refreshes about every two weeks per airport, so daily polling detected nothing new). Expected AeroDataBox calls become 1 / 2 / 4 at 3 / 14 / 30 day lead times (creation fetch plus weekly slots). The SLO relaxation report records the reason "AeroDataBox schedule layer refreshes biweekly; a weekly poll is the data source's own resolution" for the two pre-48h SLO windows. Inside-48h counts are unchanged.
- `providers.ts`: `ProviderResult.data` for `getFlight` is `FlightStatus[]` (a diverted AeroAPI flight returns two items with the same `fa_flight_id`); add `resolveOperator` and `deriveStatus` as pure functions exported from shared (see below) so both adapters and the DesignatorResolver share them.

## Pure functions (in `packages/shared`, exhaustively tested)

- `deriveStatus(input: { cancelled, diverted, actualOut?, actualOff?, actualOn?, actualIn?, scheduledOut, now })` returns the nine-value `FlightStatusValue` from flags and OOOI timestamps only. Neither provider's status string is ever parsed: AeroAPI's `status` has no enum and AeroDataBox's enum is used only to disambiguate `revisedTime`.
- `disambiguateRevisedTime(status: AdbStatus, revised, scheduled)` maps AeroDataBox's single `revisedTime` (documented as "actual / estimated") to `estimatedX` or `actualX` per movement based on the AeroDataBox status enum, and records `fieldQuality` `estimated` or `live`. Table-driven, one test per enum value.
- `resolveOperator({ marketingIcao, marketingNumber, codeshareStatus, callSign?, hint? })` returns `{ operatingCarrierIcao, operatorSource }`: `IsOperator` or `Unknown` yield the marketing carrier with source `provider` (for `IsOperator`) or `marketing`; `IsCodeshared` yields the callsign's first three letters when present (`callsign`), else the regional hint (`hint`), else the marketing carrier (`marketing`). AeroDataBox never returns an operating carrier; ADR 0003 gains a paragraph: the key carries the best-known operator at creation, `operatorSource` is stored on the instance, and the Phase 1 merge path (AeroAPI `operator_icao`) reconciles.
- `parseAdbDateTime({ local, utc })` parses only `.utc` (the `local` string has a space separator and no offset, and `new Date(local)` in a Worker silently reads it as UTC) and derives the offset from local minus utc; `scheduledDepartureDateLocal` comes from the `local` date part.

## AeroDataBox adapter (real)

- Base URL `https://api.aerodatabox.com/`, header `X-Api-Key`, vendored spec `apps/api/src/providers/specs/aerodatabox-direct-v1.15.3.yaml` with its SHA-256 in a test.
- `getFlight`: `GET /flights/Number/{designator}/{dateLocal}` (enum casing `Number`), `withFlightPlan` never set (it doubles cost on Starter), a plus or minus one day retry on a miss. 200 returns a JSON array; 204 is a miss and never calls `.json()`; both debit 2 units (`result: 'ok'` or `'not_found'`). 451 is legal suppression and is terminal for that key (`result: 'error'`, no retry). 429, 503 and any non-JSON body are `rate_limited` at zero cost with backoff from the token bucket. `codeshares` stays empty (the API has no sibling list).
- `getBoard`: FIDS by airport with the plan's window limit from config; 2 units.
- Airport lookup: 1 unit. Health endpoints (free tier) are exposed as `checkCoverage(icao)` for the DesignatorResolver's not-found path.
- `parseWebhook`: implemented behind `ADB_ALERTS_ENABLED=false`. Facts: subscriptions have no secret and no HMAC, so the webhook route is `/v1/webhooks/aerodatabox/{token}` with a 256-bit per-environment path token compared in constant time, strict schema validation, and the body treated as a hint that triggers a DO re-read rather than as data. Subscriptions are per flight number (not per instance) across a 6h-back to 72h-ahead window, so the subscription owner is an account-level coordinator designed in increment 7 and built in Phase 1.
- Capabilities from config: `maxDaysAhead` and `fidsWindowHours` per plan; `alertFields: ['status', 'times', 'gate']` once measured, `['unknown']` until then.
- Fixtures: synthetic responses shaped strictly from the vendored schema for scheduled, delayed with gate change, cancelled, diverted (arrival airport handling marked unverified), landed, arrived, a 204, a 451 and a Cloudflare HTML 403; recorded fixtures replace them when a key exists (`scripts/record-adb-fixtures.mjs` redacts the key and pins the date).

## AeroAPI adapter (mocked)

- Full `FlightDataProvider` from fixtures shaped strictly from the vendored 4.17.1 spec (`x-apikey` header, `ident_type` enum `designator|registration|fa_flight_id`). Two rules unit-tested: the first fetch brackets `start`/`end` around `scheduled_out` plus or minus one day (start inclusive, end exclusive, within 10 days past and 2 days future); every later poll uses `ident_type=fa_flight_id`, `max_pages=1`, so one poll is exactly one result set. A diverted flight fixture returns two items with the same `fa_flight_id`; the adapter returns both and marks `actualDestination` on the diversion leg.
- Alerts: `registerAlert` posts the nine boolean events with a mandatory per-alert `target_url` (never the account-wide endpoint, which is shared across environments on one key), parses the id from the 201 `Location` header, and records that `max_weekly` is a creation-time threshold, not a spend cap; `deleteAlert` exists; `parseWebhook` maps the 18 `event_code` values tolerantly and produces a `ProviderEvent` whose payload is the small alert `flight` object (no timezone, no status), which the tracker merges onto its last snapshot rather than treating as a full status.
- Every non-200 is billed in the ledger until FlightAware confirms otherwise (owner task: ask in writing).

## Cost logger, budget guard, token bucket, ProviderBudget

- `CostLogger.record()` appends to a DO outbox when running inside a Durable Object (passed in) or writes `provider_calls` directly through `withDb` from a Worker; the persist consumer (increment 7) turns records into rows and Analytics Engine points.
- `BudgetGuard` implementations: the per-flight ledger (increment 7 inside the FlightTracker, derived caps `A2_SOFT_CAP_PE` and `A2_HARD_CAP_PE` from shared) and `ProviderBudget`.
- `ProviderBudget` Durable Object, name `${provider}:${utcDate}`: SQLite tables `ledger (units, pe, calls, by trigger)`, `config (daily_unit_cap, per_second_limit, kill_switch)`, a token bucket refilled on read from stored state (never `setTimeout`), RPC `reserve(request) -> BudgetDecision` with the 70 / 90 / 100 percent ladder, `release`, `snapshot`, `setKillSwitch`; a daily alarm at 00:05 UTC of the next day writes the final counters to the outbox and calls `deleteAll()`. Per-second limits per plan: AeroDataBox 5 / 10 / 20 req/s (Starter / Growth / Scale), AeroAPI 5 result sets/s on Standard. A short-TTL KV copy (`budget:${provider}:${date}`, 60 s) serves the fast "is it over budget" read so the DO is only hit on debits. The Rules page calls global counters in a DO an anti-pattern; the arithmetic (about 3.4 debits/s average, 14/s at peak at 100k flights/month against a 200 to 500 req/s band) is recorded in the module comment with the 8-way sharding escape hatch. Hard caps are the only real ceiling: AeroDataBox may bill overage before rejecting on plans that support it, so the kill switch also raises a Sentry alert.
- Router: `providerFor(source, env)` returns the AeroDataBox adapter for every window while `AEROAPI_MODE=mock`; cost attribution always names the provider that answered. Zero AeroAPI calls before T-48h stays a routing invariant.

## Files

```
packages/shared/src/{flight-status.ts, cost.ts, cadence.ts, providers.ts, status-derivation.ts, operator.ts, adb-time.ts} + tests, docs/architecture.md regenerated, ADR 0003 amended
apps/api/src/providers/{router.ts, aerodatabox.adapter.ts, aeroapi.mock.ts, cost-log.ts, budget.ts, token-bucket.ts, specs/*.yaml, fixtures/**}
apps/api/src/do/provider-budget.ts (real), src/do/migrations/provider-budget/001.ts
apps/api/src/routes/webhooks.ts (aerodatabox path token, aeroapi target_url token; verify and enqueue on provider-events only)
apps/api/test/unit/{aerodatabox.adapter.test.ts, aeroapi.mock.test.ts, cost-log.test.ts, budget.test.ts, token-bucket.test.ts}
apps/api/test/workers/{provider-budget.test.ts, webhooks.test.ts}
scripts/record-adb-fixtures.mjs, docs/adr/0010-provider-identity.md (operator resolution and the merge path)
```

## Constraints

- No new runtime dependencies beyond `undici` as a devDependency for `MockAgent` (Node-side tests only); fetch is injected into adapters so Workers-pool tests can stub it.
- Never parse a provider status string into our enum. Never call `.json()` on a 204. Never set `withFlightPlan`. Never use the account-wide AeroAPI alert endpoint.
- No em dashes. ESM. The ESLint module-scope rule stays green; the token bucket keeps its state in the DO, not in isolate globals.

## Owner tasks surfaced

- AeroDataBox direct plan: Growth ($99), not Starter: the Starter caching term (7 days) forbids persisting flight instances to Postgres and R2. Needed before staging carries real users; a Starter key is enough for fixture recording only if the recorded data is not retained.
- FlightAware: ask in writing whether error and zero-result responses are billed, and what a rate-limit breach returns.
- Decide EU jurisdiction for Durable Objects before the first production tracker exists (one-way door).
