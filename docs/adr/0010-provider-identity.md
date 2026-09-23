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

We will key a flight by the best-known operating DESIGNATOR at creation (carrier and number
together), record how it was decided, and reconcile later through the merge path, never by
renaming.

1. **`resolveOperator`** (`@planeahead/shared`, pure, table-tested) turns the evidence into an
   operating carrier, the operating flight number that goes with it, and an `operatorSource`:
   - `IsOperator`: the marketing designator, source `provider`.
   - `Unknown`: the marketing designator, source `marketing`.
   - `IsCodeshared`: the airline callsign read as a designator, its carrier AND its number
     (`callsign`: `BA1512` flown as `AAL100` is `AAL` `100`); else the regional operator hint's
     carrier with the marketing number (`hint`: regional flying keeps the number, `AA3456` flown
     as `ENY3456`); else the marketing designator (`marketing`). A callsign whose suffix is not a
     flight number (`BAW12AB`, an alphanumeric ATC callsign) is not used at all
     (`parseAirlineCallsign`).
2. **What the instance records.** `FlightStatus` gains `operatorSource`, `marketingCarrierIcao`
   and `marketingFlightNumber`; the FlightTracker stores `operator_source` on its `flight` row and
   `flight_instances.operator_source` (already in the schema, mirrored by `OPERATOR_SOURCES`)
   persists it. `FlightStatus.flightNumber`, and therefore the key's number, is the OPERATING
   number: the callsign's own number for source `callsign`, the marketing number for every other
   source. A board row resolves the same way, so a row and its tracker's key agree.
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
   with the environment's token.
5. **AeroAPI's account-wide alert endpoint is set, not avoided** (amended in review, ruling I7).
   The vendored 4.17.1 spec makes `PUT /alerts/endpoint` a prerequisite: until it is set,
   `POST /alerts` answers 400. `registerAlert` therefore first PUTs this environment's own
   token-bearing webhook URL as the account default (idempotent, zero cost, at most once per
   isolate, recorded as an `alert_manage` call), then posts the alert with the same URL as its
   mandatory `target_url`. A delivery never depends on the account default, which every
   environment on one key shares and overwrites: whichever environment registered last owns it,
   and only alerts WITHOUT a `target_url` (which we never create) would follow it. A 400 that
   still names the missing endpoint is surfaced as `alert_endpoint_missing` and makes the next
   registration PUT again; a refused PUT is `alert_endpoint_not_set` and no alert is posted. The
   router builds the URL only from a well-formed 256-bit token, the same check the receiver
   applies, so no alert is ever registered to a URL our own route would answer 404.

**Open owner decision (Phase 1): one AeroAPI key per environment, or one shared.** With one key,
staging and production share the account-wide endpoint and the account's alert list (`GET
/alerts` shows both environments' alerts, and a cleanup job in one could delete the other's).
Separate keys isolate them at the cost of two Standard subscriptions and two $100 monthly
minimums. Decide before `AEROAPI_MODE=live` in staging.

## Consequences

- Easier: a tracker can be created from one AeroDataBox call weeks out, as the weekly pre-48 h
  cadence needs, and every instance says how much its operator can be trusted. The admin page
  and the drift metrics can count instances by `operator_source`.
- A callsign codeshare lands on its operator's own instance: `BA1512` (callsign `AAL100`) keys as
  `AAL-100-...`, exactly like `AA100`, so the two share one tracker and one provider spend. It
  can never take the key of an unrelated flight: the first build paired the callsign's carrier
  with the MARKETING number (`AAL-1512-...`), which is American's own AA 1512 from the same
  airport on the same day, one Durable Object and one row for two different aircraft, and an
  alert registered on the wrong flight. `packages/shared/test/operator.test.ts` and the
  AeroDataBox adapter tests pin the collision case.
- Harder: without a callsign (the usual case weeks out), two marketing numbers on one aircraft
  still become two trackers and two provider spends until merged: `BA1512` keys as
  `BAW-1512-...` (source `marketing`) while `AA100` keys as `AAL-100-...`; both are polled, each
  within its own per-flight budget, until the merge path sees the shared `fa_flight_id` or
  AeroAPI's codeshare idents. Phase 0 accepts that cost; the hint table narrows it for regional
  flying.
- Residual: a callsign that parses as a designator but is not the flight's own number (an
  operator that files `BAW15L` for a flight sold as BA 1512) keys as `BAW-15L-...`; the merge
  path reconciles it like any other drift. Alphanumeric suffixes of two or more letters, the
  common non-numeric ATC form, are not read as designators at all.
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
| Callsign carrier with the MARKETING number (the first build)                      | Names a third, real flight: `BA1512` flown as `AAL100` became `AAL-1512-...`, American's own AA 1512. Replaced in review (ruling I3).                                |
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
  `apps/api/src/providers/aeroapi.mock.ts` (`registerAlert`, `#ensureAlertEndpoint`),
  `apps/api/src/providers/router.ts` (`aeroApiAlertTargetUrl`), `apps/api/src/routes/webhooks.ts`.

## Amendments

- 2026-09-22, increment 6 review (orchestrator rulings I3 and I7): the key's number is the
  operating number (a callsign supplies carrier and number together, decisions 1 and 2), and the
  AeroAPI account endpoint is set before the first alert instead of never used (decision 5, with
  the open owner decision on keys per environment). The original text said the account endpoint
  "is never used" and that "a callsign's digits are not trusted to be the operating flight
  number"; both are superseded above.
