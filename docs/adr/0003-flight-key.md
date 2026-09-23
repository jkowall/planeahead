# 0003. Flight identity: the canonical flight key

- Status: Accepted
- Date: 2026-09-19
- Deciders: @jkowall
- Supersedes: none
- Superseded by: none

## Context

Every part of the system needs one name for "this operation of this flight": the FlightTracker
Durable Object is named by it, `flight_instances` has it as a generated unique column, R2 event
archives and KV snapshots are keyed by it, and the shared-flight invariant (one provider call per
flight regardless of subscribers) only holds if two users adding the same flight land on the
same name. Once data exists under a name, changing the naming rule means renaming Durable
Objects (impossible) and rewriting a generated Postgres column (drizzle-kit drops and recreates
it), so the rule must be right before increment 3.

The inputs disagree with each other:

- Providers key flights differently. AeroAPI returns a `fa_flight_id` per operation and accepts
  ICAO or IATA idents; AeroDataBox keys by IATA or ICAO number plus origin-local date and
  returns UTC and local times side by side. Neither id is stable across providers.
- Codeshares: `BA1512` and `AA100` can be the same aircraft, and the marketing designator a
  user types is often not the operating carrier. Regional flying (`AA3xxx` operated by Envoy)
  changes operator by number block and by season.
- Airports: OurAirports has fields with an ICAO code and no IATA code, and AeroAPI idents and
  aviationweather.gov are ICAO-keyed. Some airports have no ICAO code at all.
- Dates: a flight scheduled at 23:50 local that slips to 00:10 local is the same operation,
  but its UTC date and even its local date changed. The same flight number can also operate
  twice on one day out of the same airport (shuttle patterns), which is unverified but cheap to
  guard against.

## Decision

We will identify a flight instance by the provider-independent key

```
${OPERATING_ICAO}-${NUMBER}-${YYYY-MM-DD}-${ORIGIN_ICAO}[-L${legSeq}]
```

for example `AAL-100-2026-09-19-KJFK`, built and parsed only by `@planeahead/shared`
(`buildFlightKey`, `parseFlightKey`, `canonicalizeFromProvider`), with these rules:

1. **Operating carrier, ICAO.** Marketing designators and codeshares collapse onto the
   operator. IATA is resolved to ICAO through the `airlines` seed in `packages/db`
   (vradarserver standing-data spine with OPTD alliances), with a small built-in
   fallback table for offline use. `regionalOperatorHint` and the `regional_operators` table
   only guess an operator so the DesignatorResolver can find an existing tracker before paying
   for a provider call; the provider's operating carrier is authoritative.
2. **Flight number normalised.** Leading zeros stripped, optional single-letter suffix kept,
   anything outside `^[0-9]{1,4}[A-Z]?$` rejected. Flight number 0 does not exist.
3. **Origin-local scheduled departure date.** Derived from `times.scheduledOut` in
   `origin.tz` with `Intl.DateTimeFormat` (available in Node 24, Workers and Hermes; no date
   library). If the time zone is unknown the provider's own local date field is used. If both
   are missing the normaliser throws `missing_local_date`; it never assumes UTC.
4. **Origin airport, ICAO.** Airports without an ICAO code get a synthetic `ZZ` plus two
   characters minted by `packages/db` and flagged `synthetic: true`; `ZZ` is unassigned in
   the ICAO scheme so it cannot collide.
5. **`legSeq`** distinguishes a second operation of the same number from the same origin on
   the same day. It is 1 by default and only rendered as `-L2`, `-L3`, ... when greater than 1.
6. **Keys are immutable after creation.** A tracker keeps the key it was created with. When a
   later status canonicalises differently, `reconcileFlightKey` returns the existing key plus a
   drift classification: `date_shift` (only the local date moved) becomes a schedule-change
   event; `different_flight` (operator, number, origin or leg changed) becomes a merge
   candidate. The 23:50 to 00:10 midnight slip is therefore a `date_shift` on the original key,
   not a new flight.
7. **A real reschedule to another day is a new instance and a merge case.** The
   DesignatorResolver for the new date creates a second instance; when a provider reference
   (`fa_flight_id`, AeroDataBox id) shows both instances are one operation, the persist
   consumer records the pair in `flight_instance_merges`, sets `superseded_by_id` on the loser
   and the tracker adopts the subscribers (`adoptSubscribers`, Phase 1). Nothing is ever
   renamed.

### Amendment (increment 6, 2026-09-22): the operator at creation

Rule 1 assumed a provider names the operating carrier. The provider that answers every Phase 0
lookup, AeroDataBox, does not: its `airline` is the marketing carrier, `codeshareStatus` is a
marker, and the ATC callsign is rarely present before departure. The key therefore carries the
best-known operating designator at creation, decided by `resolveOperator` in
`@planeahead/shared` (the marketing designator unless a callsign or the regional hint says
otherwise; a callsign supplies the carrier AND the number, so `BA1512` flown as `AAL100` keys as
`AAL-100-...` and never as `AAL-1512-...`, which is another flight), `operatorSource`
(`provider`, `callsign`, `hint` or `marketing`) is stored on the instance, and the Phase 1 merge
path, fed by AeroAPI's `operator_icao`, reconciles an instance keyed by a weaker source with the
operator's own; rule 6 still holds, so reconciliation is a merge, never a rename.
[ADR 0010](0010-provider-identity.md) records the decision and its cost.

## Consequences

- Easier: two users, two providers and two marketing designators for one operation all resolve
  to one Durable Object and one row, which is what makes "one provider call per flight"
  structural. Keys are readable in logs, admin pages and R2 listings.
- Harder: the normaliser needs an operating carrier and an origin time zone before it can name
  anything, so the first provider call must happen before a tracker exists (the
  DesignatorResolver serialises it). Operator swaps and day-shifted reschedules need the merge
  path, which Phase 1 builds; until then they surface as drift metrics.
- Commits us to ICAO codes everywhere a key is built, to the origin-local date as the only
  local date in the system (every other instant is `timestamptz`), and to freezing the
  generated-column expression in `packages/db`.
- Reversibility: low. Changing the format after increment 3 means renaming Durable Objects,
  rewriting a generated column, re-keying R2 and KV, and invalidating every mobile cache.

## Alternatives considered

| Option                                        | Why not                                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider id (`fa_flight_id`) as the key       | Ties identity to one vendor, unknown until the first AeroAPI call, and AeroAPI is mocked in Phase 0 while AeroDataBox is real.                                |
| Marketing designator plus date                | `BA1512` and `AA100` would be two trackers for one aircraft, doubling provider spend and breaking the shared-flight invariant.                                |
| UTC date instead of origin-local date         | Late-evening departures in the Americas and early-morning departures in Asia would land on the wrong calendar day and split from what the airline calls them. |
| IATA airport codes                            | AeroAPI and aviationweather.gov are ICAO-keyed and some OurAirports fields have no IATA code.                                                                 |
| Opaque UUID only, natural key as a soft index | The Durable Object name and the idempotent upsert need a deterministic name derivable from a provider answer.                                                 |

## References

- Phase 0 plan section 6 and section 7, `docs/plans/phase0-plan.md`.
- Dossier section 5 (irreversible schema decision 3), `docs/research/phase0-dossier.md`.
- AeroAPI OpenAPI spec (`/flights/{ident}` window and `fa_flight_id`):
  https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml
- AeroDataBox flight status by number and local date:
  https://api.market/store/aedbx/aerodatabox/openapi.yaml
- OurAirports data dictionary (airports without IATA codes): https://ourairports.com/data/
- ICAO location indicators (`ZZZZ` placeholder): ICAO Doc 7910.
