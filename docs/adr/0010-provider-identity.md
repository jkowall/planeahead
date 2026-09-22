# 0010. Provider identity: operator resolution and the merge path

- Status: Accepted
- Date: 2026-09-22
- Deciders: @jkowall
- Supersedes: none (amends [0003](0003-flight-key.md), which gains a paragraph)
- Superseded by: none

## Context

ADR 0003 names a flight instance by its OPERATING carrier (`AAL-100-2026-09-19-KJFK`) and says
"the provider's operating carrier is authoritative". Increment 6 built the providers and found
that the provider which answers every Phase 0 lookup never names one
(`docs/increments/06-07-providers-and-trackers.facts.md` section 1, against the vendored
AeroDataBox direct-gateway OpenAPI 1.15.3.0):

- `FlightContract.airline` is "Airline owning the flight number": the MARKETING carrier.
- `codeshareStatus` is `Unknown | IsOperator | IsCodeshared`, a marker that says whether the
  marketing carrier flies the aircraft, never who does when it does not.
- The only operator evidence is the ATC `callSign` (`AAL100`), which AeroDataBox's own coverage
  page rates "rare" before departure, the one moment the DesignatorResolver needs it.
- There is no codeshare sibling list, so `FlightStatus.codeshares` is always empty.

AeroAPI does carry `operator_icao` and the codeshare idents, but it is mocked in Phase 0
(`AEROAPI_MODE=mock`), cannot see a flight more than two days out, and is never called before
T-48 h. Meanwhile the key must exist at creation, often weeks before departure: it names the
FlightTracker Durable Object and the `flight_instances` row, and it is immutable (ADR 0003 rule 6).

A second identity question sits beside it: when a provider POSTs to us, how do we know it is that
provider? AeroDataBox subscriptions accept only a URL that "must not require additional
authorization", with no secret and no HMAC; AeroAPI alerts carry nothing either (facts sheet
sections 1 and 2).

## Decision

We will key a flight by the best-known operator at creation, record how that operator was
decided, and reconcile later through the merge path, never by renaming.

1. **`resolveOperator`** (`@planeahead/shared`, pure, table-tested) turns the evidence into an
   operator and an `operatorSource`:
   - `IsOperator`: the marketing carrier, source `provider`.
   - `Unknown`: the marketing carrier, source `marketing`.
   - `IsCodeshared`: the airline callsign's three-letter prefix (`callsign`), else the regional
     operator hint (`regionalOperatorHint`, `hint`), else the marketing carrier (`marketing`).
2. **What the instance records.** `FlightStatus` gains `operatorSource`, `marketingCarrierIcao`
   and `marketingFlightNumber`; the FlightTracker stores `operator_source` on its `flight` row and
   `flight_instances.operator_source` (already in the schema, mirrored by `OPERATOR_SOURCES`)
   persists it. The key's flight NUMBER is the marketing number the evidence was asked about: a
   callsign's digits are not trusted to be the operating flight number (`BAW12AB`).
3. **Reconciliation, not renaming.** Evidence ranks `provider` over `callsign` over `hint` over
   `marketing`. When a later answer is stronger (a callsign appears near departure, or AeroAPI's
   `operator_icao` inside 48 h in `live` mode), `reconcileFlightKey` reports
   `different_flight` drift, the tracker records it as an event, and the Phase 1 merge path
   (`flight_instance_merges`, `superseded_by_id`, `adoptSubscribers`) folds the weaker instance
   into the stronger one. A key never changes; an instance can be superseded.
4. **Provider deliveries are authenticated by an unguessable path.** Each receiver has a 256-bit
   token per provider and per environment (`/v1/webhooks/aerodatabox/{token}`,
   `/v1/webhooks/aeroapi/{token}`), compared in constant time after a length check; a wrong token
   is the app's ordinary 404. The body is validated strictly and treated as a HINT: an
   AeroDataBox delivery makes the tracker re-read the flight, an AeroAPI delivery is a patch
   merged onto the last snapshot (it has no timezone and no status), and nothing in a delivery is
   trusted to create or rename an instance. AeroAPI alerts always carry a per-alert `target_url`
   with the environment's token; the account-wide endpoint, shared by every environment on one
   key, is never used.

## Consequences

- Easier: a tracker can be created from one AeroDataBox call weeks out, as the weekly pre-48 h
  cadence needs, and every instance says how much its operator can be trusted. The admin page
  and the drift metrics can count instances by `operator_source`.
- Harder: two marketing numbers on one aircraft become two trackers and two provider spends until
  merged. `BA1512` (a codeshare, callsign `AAL100`) keys as `AAL-1512-...` while `AA100` keys as
  `AAL-100-...`; both are polled, each within its own per-flight budget, until the merge path
  sees the shared `fa_flight_id` or AeroAPI's codeshare idents. Phase 0 accepts that cost; the
  hint table narrows it for regional flying.
- A delivery cannot be proven to come from the provider. A leaked token lets anyone make us
  re-read a flight (a provider call inside the per-flight and provider budgets) or merge a
  plausible patch until the next poll corrects it. Residual risk, accepted: the token is not
  logged by our code and is redacted from Sentry, but Cloudflare's own invocation logs keep
  request URLs, so anyone with access to Workers Logs can read it; rotate a token when that access
  widens or a leak is suspected (rotation is a secret change plus, for AeroAPI, re-registering the
  live alerts with the new `target_url`).
- Reversibility: medium. The resolution rule for NEW keys can change in one function; existing
  keys are immutable, so a change only affects how future instances are named and how the merge
  path ranks evidence.

## Alternatives considered

| Option                                                                            | Why not                                                                                                                                                              |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Always the marketing carrier, ignore callsigns and hints                          | Throws away evidence that is free in the same response; every regional codeshare would split from the operator's own number.                                         |
| Take the callsign's digits as the operating flight number                         | Would collapse `BA1512` onto `AAL-100`, but callsigns are not reliably carrier plus flight number (`BAW12AB`); a wrong collapse merges two real flights.             |
| Ask AeroAPI for the operator at creation (`/flights/{ident}/canonical` at $0.001) | AeroAPI is mocked in Phase 0, cannot see beyond two days, and `canonical` returns idents, not an operator; a Phase 1 candidate for the merge path, not for creation. |
| Create the tracker only once the operator is known                                | No tracker before T-48 h means no schedule-change detection weeks out, which the pre-48 h cadence exists for.                                                        |
| HMAC or a shared secret on webhooks                                               | Neither provider supports one; AeroDataBox forbids a URL that requires authorisation.                                                                                |
| An authorisation header on the AeroAPI `target_url`                               | AeroAPI posts to a URL; it sends no headers we control.                                                                                                              |

## References

- Facts sheet sections 1, 2 and 5 and decisions 1 and 3: `docs/increments/06-07-providers-and-trackers.facts.md`.
- AeroDataBox direct-gateway OpenAPI 1.15.3.0, `FlightContract`, `CodeshareStatus`,
  `CreateWebHookSubscription`: `apps/api/src/providers/specs/aerodatabox-direct-v1.15.3.yaml`
  (https://doc.aerodatabox.com/docs/openapi-direct-v1.yaml).
- AeroDataBox data coverage (callsign "rare" before departure): https://aerodatabox.com/data-coverage/
- AeroAPI OpenAPI 4.17.1, `operator_icao`, `codeshares`, `POST /alerts` `target_url`,
  `PUT /alerts/endpoint`: `apps/api/src/providers/specs/aeroapi-v4.17.1.yaml`
  (https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml).
- Code: `packages/shared/src/operator.ts`, `apps/api/src/providers/aerodatabox.adapter.ts`,
  `apps/api/src/routes/webhooks.ts`.
