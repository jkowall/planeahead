# @planeahead/shared

Contracts shared by every PlaneAhead tier: Zod 4 schemas with inferred types for everything
that crosses a boundary (mobile to API, Worker to Durable Object, adapter to tracker), the
provider interfaces, the flight identity normaliser (ADR 0003), the refresh cadence with its
SLO table, UUIDv7 (ADR 0006) and the provider cost table. Pure TypeScript: no I/O, no platform
API beyond `crypto.getRandomValues`, `Date` and `Intl.DateTimeFormat`.

## Modules

| Module             | What it owns                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `ids.ts`           | `uuidv7()` with a monotonic sub-millisecond counter; throws `MissingCryptoError` without a CSPRNG    |
| `airports.ts`      | `AirportRef` (ICAO identity, synthetic `ZZxx` codes), `isValidTimeZone`                              |
| `carriers.ts`      | `CarrierRef`, `carrierIcaoFromIata(iata, table)` with a small offline fallback table                 |
| `flight-key.ts`    | `buildFlightKey`, `parseFlightKey`, `canonicalizeFromProvider`, `reconcileFlightKey`, operator hints |
| `flight-status.ts` | `FlightStatus`, `BoardRow`, `AircraftPosition`, `ProviderEvent`, `ProviderCallRecord` (all loose)    |
| `providers.ts`     | `FlightDataProvider`, `AircraftPositionProvider`, `ProviderCallContext`, `BudgetGuard`, `CostLogger` |
| `cost.ts`          | List prices in USD micros, `pollEquivalents`, `costUnits`, `estimateCostUsdMicros`                   |
| `cadence.ts`       | `SLO_TABLE`, `CADENCE_A1` / `A2` / `B`, `refreshIntervalFor`, `expectedCalls`, the derived constants |
| `rpc.ts`           | Versioned Durable Object RPC payloads (`SubscribeRequestV1`, `GetStateResponseV1`, ...)              |
| `sync.ts`          | `SyncCursor` (`xid:seq`) and `SyncEnvelopeV1`                                                        |
| `live-activity.ts` | `LiveActivityContentStateV1`                                                                         |
| `secrets.ts`       | `SECRET_PATTERNS` for the client-bundle grep                                                         |

Every object schema is `z.looseObject`: Durable Objects roll out gradually, so a payload from a
newer producer must parse on an older consumer. Add fields freely; rename or retype through a new
`V2` schema. Two consequences worth knowing:

- The loose inferred types carry a string index signature, which disables TypeScript's
  excess-property check. Producers (adapters, the tracker) type what they build as
  `Exact<FlightStatus>` and so on, so a misspelled field fails to compile; consumers keep the
  loose types. Open-keyed records (`providerRefs`, `fieldQuality`) keep their index signature
  under `Exact`, so they stay readable and writable by any string key.
- A `status`, a provider event `kind` or a tracker phase this build does not know parses as
  `unknown` (`tolerantEnum`); the field itself stays required, so an absent key, `null` or a
  number is still rejected. Every other vocabulary (`ProviderId`, triggers, results, alert
  events, field qualities, sync entities) is closed and append-only: emit a new value one
  release after every consumer accepts it.

## Clocks and randomness

Nothing here reads the wall clock except the default clock of `uuidv7()`. Adapters take their
time from `ProviderCallContext.now`; the cadence takes it from `CadenceContext.now`. A test
(`test/style.test.ts`) fails if `Date.now()` or `new Date()` appears anywhere else in `src/`.

`uuidv7()` needs `globalThis.crypto.getRandomValues`. Node 24, Workers and browsers provide it.
React Native does not: the mobile app must import `expo-crypto` (or
`react-native-get-random-values`) before any shared code runs, otherwise `uuidv7()` throws
`MissingCryptoError` instead of silently falling back to `Math.random`.

## Regional operator hints

`src/data/regional-operators.seed.json` maps marketing flight-number blocks to probable regional
operators so the DesignatorResolver can look for an existing tracker before paying for a provider
call. It is a hint table with a `confidence` per rule; `packages/db` seeds `regional_operators`
from OPTD and overrides it. The provider's operating carrier is always authoritative.

## Cadence table

`pnpm --filter @planeahead/shared gen:cadence-table` renders the refresh-cadence tables from
`src/cadence.ts` into `docs/architecture.md` between the `<!-- cadence:start -->` and
`<!-- cadence:end -->` markers. The script is idempotent, and `test/cadence-table.test.ts` fails
when the committed document drifts from the code.
