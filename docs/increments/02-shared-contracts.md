# Increment 2: `@planeahead/shared` contracts

Status: spec (2026-09-19). Builder: Fable 5.1. Reviewers: two Opus 5 lenses (correctness, API design) plus orchestrator read.

## Goal

`packages/shared` becomes the single source of truth for every type that crosses a boundary (mobile to API, Worker to Durable Object, adapter to tracker): Zod 4 schemas with inferred types, the provider interfaces, the flight identity normaliser, the refresh cadence function with its SLO table, UUIDv7, and the cost table. Pure TypeScript, no I/O, no platform APIs beyond `crypto.getRandomValues` and `Date`. Every exported function has unit tests; the cadence table in `docs/architecture.md` is generated from the code and a test fails if the two drift.

Acceptance: `pnpm turbo run typecheck lint test` green; `pnpm --filter @planeahead/shared gen:cadence-table` rewrites `docs/architecture.md` between the `<!-- cadence:start -->` and `<!-- cadence:end -->` markers and `test/cadence-table.test.ts` asserts the committed doc matches; the constants `A2_EXPECTED_POLLS = 72`, `A2_EXPECTED_ALERTS = 12`, `A2_EXPECTED_PE = 120` are derived by the function, not typed by hand.

## Modules (`packages/shared/src/`)

### `ids.ts`
- `uuidv7(now?: () => number): string`. RFC 9562 layout: 48-bit unix ms, ver 7, 12 bits of a per-millisecond monotonic counter seeded randomly, var 10, 62 random bits. Uses `crypto.getRandomValues`; throws a clear error if `globalThis.crypto` is missing (React Native needs `expo-crypto` or `react-native-get-random-values`, documented in the README). Tests: format regex, version and variant bits, monotonic within one ms, time-ordered across ms.

### `airports.ts`, `carriers.ts` (types only, data lives in `packages/db` seeds)
- `AirportRef = { icao: string; iata?: string; tz?: string }` (Zod). ICAO is the identity because AeroAPI idents and aviationweather.gov are ICAO-keyed; synthetic `ZZ` + 2 chars is allowed for airports without ICAO and flagged with `synthetic: true`.
- `CarrierRef = { icao?: string; iata?: string }`; helper `carrierIcaoFromIata(iata, table)` where `table` is injected (the OPTD-derived map comes from `packages/db` seed data; shared only ships a small built-in table of the top ~60 carriers for offline use, marked as a fallback).

### `flight-key.ts` (irreversible; ADR 0003)
- `FlightKey` branded string `${OPERATING_ICAO}-${NUMBER}-${YYYY-MM-DD}-${ORIGIN_ICAO}` with optional `-L${legSeq}` suffix only when `legSeq > 1`. Example `AAL-100-2026-09-19-KJFK`.
- `normalizeFlightNumber(input: string): { number: string; suffix?: string }` strips leading zeros, keeps an optional single-letter suffix, rejects anything not matching `^[0-9]{1,4}[A-Z]?$` after cleanup.
- `parseDesignator(input: string)` accepts `AA100`, `AA 100`, `AAL100`, `aa0100`, `BA1512` and returns `{ carrier: CarrierRef, number, suffix? }` without resolving codeshares.
- `buildFlightKey(parts: { operatingCarrierIcao; flightNumber; scheduledDepartureDateLocal; originIcao; legSeq? })` and `parseFlightKey(key)`; round-trip tests; rejects lowercase, wrong date shapes, non-ICAO carriers.
- `canonicalizeFromProvider(status: FlightStatus): FlightKey` builds the key from a provider-normalised status using the OPERATING carrier and the origin-local scheduled date (derived from `scheduledOut` in the origin tz when the provider gives a UTC instant; the tz comes from `status.origin.tz`; if tz is missing the provider's local date field is used; if both are missing the function throws, it never guesses UTC).
- `regionalOperatorHint(marketing: CarrierRef, number: string, table: RegionalOperatorRule[]): string | undefined` returns a probable operating ICAO for lookup pre-canonicalisation only. The provider answer is authoritative; this exists so the DesignatorResolver can find an existing tracker before spending a provider call. Ship a small seed `regional-operators.seed.json` with rules for AA (American Eagle blocks operated by ENY, SKW, JIA, PDT), DL (EDV, SKW), UA (SKW, ASH, RPA, GJS, UCA), each rule `{ marketingIata, from, to, operatingIcao, source, asOf }` with a source URL, clearly labelled as a hint table that `packages/db` overrides.
- Tests: `BA1512` marketing on an AA-operated flight resolves to the AA key once the provider status says operator AAL; midnight slip (scheduled_out moves from 23:50 to 00:10 local) does NOT change the key because the key uses the originally scheduled local date stored on first sight (document: the key is immutable after creation; a real reschedule to another day is a new instance and a merge case).

### `flight-status.ts`
Zod schemas and inferred types exactly as in the Phase 0 plan section 7, with these clarifications:
- `ProviderId = 'aeroapi' | 'aerodatabox' | 'adsb_lol' | 'adsb_fi' | 'airplanes_live' | 'aviationweather' | 'nws' | 'open_meteo' | 'faa_nas' | 'llm' | 'mock'`.
- `FlightStatusSchema` with `times` as ISO-8601 UTC strings, `status` enum as listed, `fieldQuality` record, `providerRefs` partial record, `codeshares` array, `legSeq` default 1.
- `BoardRowSchema`, `AircraftPositionSchema` (`icaoHex`, `lat`, `lon`, `altFt?`, `gsKt?`, `trackDeg?`, `vsFpm?`, `seenAt`, `source`), `ProviderEventSchema` (`provider`, `externalId`, `receivedAt`, `kind`, `flightRef`, `payload` unknown), `ProviderCallRecordSchema` (`id`, `provider`, `operation`, `trigger`, `flightKey?`, `airportIcao?`, `requestId`, `startedAt`, `latencyMs`, `httpStatus?`, `result: 'ok'|'not_found'|'rate_limited'|'error'`, `costUnits`, `pollEquivalents`, `estCostUsdMicros`, `responseBytes?`, `error?`).
- All schemas use `z.looseObject` (Zod 4) so unknown fields from newer producers are tolerated; document why (gradual DO rollout).

### `providers.ts`
Interfaces from the plan section 7 (`FlightDataProvider`, `AircraftPositionProvider`, `ProviderCallContext`, `ProviderResult<T>`, `BudgetGuard`, `CostLogger`, `AlertEvent`). `ProviderCallContext.now` is an injectable clock; nothing in shared calls `Date.now()` directly except `uuidv7`'s default.

### `cost.ts`
- `LIST_PRICE_USD_MICROS: Record<ProviderId, Record<operation, number>>` from the plan: aeroapi `flight_by_ident` 5000, `flight_by_id` 5000, `position` 10000, `track` 12000, `schedules` 20000, `airport_flights` 20000, `alert_delivery` 20000, `alert_manage` 0; aerodatabox `flight_status` 2 units, `fids` 2 units, `airport` 1 unit, `alert_item` 1 unit, unit price at Growth 250 micros; community ADS-B 0; weather 0; llm priced per token elsewhere.
- `pollEquivalents(provider, operation): number` per the plan (AeroAPI status 1, alert delivery 4, schedules 4, position 2; ADB status/search 0.1, ADB alert 0.05; ADS-B 0).

### `cadence.ts` (drives the FlightTracker alarm and the docs)
- `SLO_TABLE` as in the plan section 8 (typed constant with per-window detection targets).
- `CADENCE_A1`, `CADENCE_A2`, `CADENCE_B`: window definitions `{ from: minutesBeforeDeparture, to, intervalMinutes, source: 'aerodatabox'|'aeroapi', alerts: boolean }` plus pre-48h rules (daily inside 14 d, every 2 days beyond, source aerodatabox).
- `refreshIntervalFor(cadence, ctx: { now, scheduledOut, scheduledIn, actualOff?, actualOn?, actualIn?, phase })` returns `{ intervalMs, source, tier }`.
- `expectedCalls(cadence, { leadTimeDays, blockMinutes = 180, boardingMinutesBefore = 40, postArrivalStopMinutes = 120 })` returns `{ polls, alerts, adbUnits, pollEquivalents, listCostUsdMicros }` by simulating the schedule with the same function the tracker uses (no separate arithmetic).
- Exported constants computed at module load: `A2_EXPECTED_POLLS`, `A2_EXPECTED_ALERTS` (assumed 12, from a named constant `ASSUMED_ALERTS_PER_FLIGHT` with a comment marking it unverified), `A2_EXPECTED_PE`, `A2_SOFT_CAP_PE = 2x`, `A2_HARD_CAP_PE = 4x`, `MAX_LIFETIME(scheduledIn, actualOff, blockMinutes) = min(scheduledIn + 6 h, actualOff + 2 x block)`.
- Tests: reproduce the plan's table (literal 181, A1 83, A2 72 polls inside 48 h; 3/14/30-day lead times for ADB units 4/26/42); interval at each phase boundary; max lifetime.

### `rpc.ts`
Versioned Zod schemas for DO RPC payloads, all `looseObject`: `SubscribeRequestV1 { subscriptionId, userId, muted?, overrides? }`, `SubscribeResponseV1 { status: 'subscribed'|'already'|'archived', flightKey, snapshotEtag? }`, `UnsubscribeRequestV1`, `GetStateResponseV1 { flightKey, phase, snapshot: FlightStatus | null, nextRefreshAt, doSchemaVersion, subscriberCount }`, `ForceRefreshRequestV1 { reason: 'user_refresh'|'reconcile'|'manual' }`, `ProviderEventV1`. Export `RPC_SCHEMA_VERSION = 1`.

### `sync.ts`
`SyncCursor = { xid: string; seq: number }` encoded as `${xid}:${seq}`; `SyncEnvelopeV1 { cursor, upserts: Array<{ entity, id, row: unknown, updatedAt }>, tombstones: Array<{ entity, id, deletedAt }>, flights: Array<FlightStatus>, hasMore }`.

### `live-activity.ts`
`LiveActivityContentStateV1` Zod: `{ flightKey, status, gate?, terminal?, scheduledOut, estimatedOut?, actualOut?, scheduledIn, estimatedIn?, progressPercent?, baggageClaim?, updatedAt }`, plus `stale_at` guidance in a comment.

### `secrets.ts`
`SECRET_PATTERNS: RegExp[]` (provider hostnames, `AERO`, `APNS_`, `FCM_`, `sk_`, `Bearer `) used by the CI bundle grep in increment 9.

### `index.ts`
Re-exports everything; no default export.

## Scripts and docs
- `packages/shared/scripts/gen-cadence-table.ts` (run with `tsx`, add as dev dependency) renders the per-window and per-lead-time tables into `docs/architecture.md` between markers, creating the file with a stub heading if it does not exist.
- `docs/adr/0003-flight-key.md` written in this increment (context, decision, consequences, the immutability rule, the merge case).
- `docs/adr/0006-uuidv7.md`.

## Constraints
- Zod 4 (`zod@^4.6`), `tsx` for the script, nothing else new. No `Date.now()` outside `ids.ts` default clock. No em dashes. ESM. 100% of exported functions covered by a test that would fail if the behaviour changed.
