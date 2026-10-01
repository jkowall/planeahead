# R4: Detecting the changes that trigger delay and gate-change pushes

Checked 2026-09-30 against live sources. Repository read at main `3302d39` (read only, nothing
modified). Raw downloads (specs, pages, forum JSON) are kept in `phase1-research/r4-src/` next to
this file.

Evidence grades used below:

- **Primary**: FlightAware or AeroDataBox documentation, OpenAPI specs, pricing pages, FAQ, support
  centre articles; Apple, Google and eCFR documentation.
- **Staff forum**: a reply on discussions.flightaware.com carrying the "FlightAware Staff" badge.
- **Forum**: any other forum reply. Replies by `bovineone` carry no badge but quote FlightAware's
  internal account data, so they are FlightAware personnel by inference only.
- **Third party**: vendor or press pages.

Two FlightAware support articles return HTTP 403 as HTML; their public Zendesk Help Center JSON
(`https://support.flightaware.com/api/v2/help_center/en-us/articles/{id}.json`) serves the same
public article, and that is what was read.

## 1. Questions answered (one line each)

1. AeroAPI alert events: 11 configurable booleans in the current spec 4.30.0 (the repo's 4.17.1 has 9), plus `eta`, `impending_arrival` and `impending_departure` timers; 22 delivery codes (facts 1 to 4).
2. Gate changes do trigger deliveries (event code `change`, inside the departure bundle before departure and the arrival bundle en route); estimated-time changes trigger only above 30 minutes (1801 s), up to 5 changes per bundle (facts 5, 21, 22).
3. Terminal changes: plausible (same `change` mechanism, staff answered a gate-and-terminal question with "yes") but no example shows a terminal-only change: UNVERIFIED (U1).
4. Delivery price: $0.020 per Push Alert Delivery; every alert and endpoint management call is $0.000 (fact 8).
5. Account-level endpoint: `PUT /alerts/endpoint` is account-wide and shared by every key on the account; per-alert `target_url` overrides it; extra keys are free, so staging and production need separate keys, not separate accounts (facts 12, 13).
6. Limits: no documented cap on alerts per account and no weekly delivery cap on Standard; `max_weekly` is a per-alert creation-time rejection threshold (defaults 1,000 Standard, 4,000 Premium) that does not stop deliveries; more than 50 identical enabled alerts is a 400 (facts 14, 15).
7. Delivery authentication: none from FlightAware (no signature, no secret); FlightAware recommends a token in the URL or URL basic auth over HTTPS; three published IPs exist for firewalls (fact 19).
8. Retries: none; a failed AeroAPI delivery is lost; the receiver must answer within about 5 s (facts 17, 18).
9. Rate limits: Personal 10 result sets per minute, Standard 5 per second, Premium 100 per second; 429 costs no quota; 200 and non-429 4xx responses consume rate quota (facts 10, 11, 20).
10. AeroDataBox alerts on Growth: available (40,000 credits per refill); 1 credit (1 API unit) per flight item per delivery attempt; per flight number or airport only, covering flights from 6 h ago to 72 h ahead; best effort, no retries by default, no authentication; which field changes trigger an item is undocumented (facts 32 to 38).
11. Worst-case poll gap for a gate change under A2: 60 min (T-48 h to T-6 h), 15 min (T-6 h to boarding), 30 min (boarding to arrival, and during any ground delay), 60 min (arrival to stop) (section 5.4).
12. Notification-worthy delay: 15 min is the US regulatory "late" line (14 CFR 234.2); carriers must notify at 30 min (14 CFR 259.8); FlightAware's own alerts use 1801 s; a competitor skips delays under 15 min (facts 39 to 44).
13. Storm control: APNs `apns-collapse-id` (64 bytes max), FCM `android.notification.tag`, hysteresis and a settle window; APNs keeps only one pending notification per app for an offline device (facts 45 to 47).
14. Beyond delay and gate: push cancellation (including un-cancellation) and diversion in Phase 1, confirmed by a re-read, never from AeroAPI's polled `cancelled` flag alone (section 4, D11).
15. Merge trigger: two keys are one flight when AeroAPI returns the same `fa_flight_id`; ids appear about 48 h before scheduled gate departure (sometimes later), can occasionally be replaced, and codeshare lists are aliases, not proof (facts 24 to 28).

## 2. Verified facts

All checked 2026-09-30.

### AeroAPI: spec versions and alert vocabulary

1. **The current AeroAPI spec is 4.30.0 and lives at a different URL than the one vendored.** Primary. https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml returns `version: 4.30.0` (SHA-256 `edf79679752d095f42e03160ea3dabb3945c36d3815246affe74b4097f8e0ef7`); the spec's own introduction names this URL, and the developer portal (https://www.flightaware.com/aeroapi/portal/documentation) loads it from its app bundle. The legacy URL https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml still serves 4.17.1, byte-identical to the vendored file (SHA-256 `3023e7a0...da5`). Checked 2026-09-30.
2. **4.30.0 `POST /alerts` has 11 event booleans**, all in the schema's `required` list: arrival, cancelled, departure, diverted, filed, out, off, on, in, `hold_start`, `hold_end`. Primary: https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml (`POST /alerts`). The support article updated 2026-07-31 (https://support.flightaware.com/hc/en-us/articles/33381502369175-How-Do-I-Create-A-Post-Alert-In-AeroAPI) shows the same 11 in its example body, but also advises deleting optional fields not in use. Checked 2026-09-30.
3. **Timer triggers (4.30.0):** `eta` (minutes before ETA; only after 15 minutes airborne), `impending_arrival` (up to 10 values, from 15 min after actual departure) and `impending_departure` (up to 10 values, valid 60 to 5 minutes before estimated departure). The support article says `eta` and impending arrival are the same thing and only one may be set; values in 5-minute steps. Primary: https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml; https://support.flightaware.com/hc/en-us/articles/33381502369175-How-Do-I-Create-A-Post-Alert-In-AeroAPI. Checked 2026-09-30.
4. **Delivery `event_code` enum has 22 values in 4.30.0** (18 in 4.17.1): filed, departure, arrival, out, off, on, in, diverted, cancelled, `uncancelled`, position_only_arrival, position_only_departure, fru_arrival, nonairport_arrival, nonairport_departure, nonairport_filed, minutes_out, power_on, change, `impending_departure`, `hold_entry`, `hold_exit`. Primary: https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml (`deliver_alert` callback). A 2018 forum reply adds that codes are added "every few months" and a 2018 delivery used an undocumented `delay` code (https://discussions.flightaware.com/t/get-alerted-when-a-flight-is-delayed/12474). Checked 2026-09-30.
5. **Bundles (identical text in 4.17.1 and 4.30.0, alerts tag).** `departure` bundles the OFF alert, the flight plan filed alert and "up to 5 per-departure changes" covering delays over 30 minutes, gate changes and airport delays; `arrival` bundles the ON alert and up to 5 en-route changes (delays over 30 minutes, excluding diversions). Enabling a bundled and an unbundled on/off yields one alert where they overlap. Primary: https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml; https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml. Checked 2026-09-30.
6. **`cancelled` (4.30.0):** both cancelled and uncancelled events generate alerts, at most three of each per configured alert. Primary: https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml (`events.cancelled`). Checked 2026-09-30.
7. **Delivery payload (both versions):** `long_description`, `short_description`, `summary`, `event_code`, `alert_id` and a `flight` object whose only required field is `fa_flight_id`; it carries OOOI scheduled, estimated and actual times, `gate_origin`, `gate_destination`, `terminal_origin`, `terminal_destination`, `baggage_claim`, `cancelled`, `diverted` and `error`, but no timezone and no status. The flight fields are identical in 4.17.1 and 4.30.0. Primary: https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml; https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml. Checked 2026-09-30.

### AeroAPI: price, tiers, keys, limits

8. **Prices** (https://www.flightaware.com/commercial/aeroapi/, "Query fees breakdown"): Push Alert Delivery $0.020 per result set; `GET/POST/PUT/DELETE /alerts...` and `/alerts/endpoint` $0.000; `GET /flights/{ident}` $0.005; `/flights/{ident}/canonical` $0.001; `/schedules` $0.020; `/account/usage` $0.000. Primary. Checked 2026-09-30.
9. **FAQ on alert pricing** (https://www.flightaware.com/commercial/aeroapi/faq.rvt): you are charged for each alert delivered; departure and arrival events may each yield the actual event plus "potentially 1-2 additional alerts" of change information. Primary. Checked 2026-09-30.
10. **Tiers** (https://www.flightaware.com/commercial/aeroapi/): Personal 10 result sets per minute, no minimum, alerts not included; Standard 5 result sets per second, $100 per month minimum, alerts included; Premium 100 per second, $1,000 minimum. Volume discounts are marginal: first $1,000 at list, $1k to $2k 30% off, $2k to $4k 51%, $4k to $8k 65%, $8k to $16k 76%, $16k to $32k 83%, $32k to $64k 88%, above $64k 94%. Primary. Checked 2026-09-30.
11. **Result sets and rate quota** (https://www.flightaware.com/commercial/aeroapi/faq.rvt): 200 and 4xx responses except 429 return result sets and consume rate-limit quota; `max_pages` is checked against remaining quota and `num_pages` is deducted. Primary. Checked 2026-09-30.
12. **Keys** (https://www.flightaware.com/commercial/aeroapi/faq.rvt): multiple API keys are encouraged, for example one for development and one for production; "no additional fees for additional keys". Primary. Checked 2026-09-30.
13. **Endpoint scope** (https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml; https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml): `PUT /alerts/endpoint` sets the account-wide default; an alert's `target_url` overrides it, which the spec suggests for sending alerts to "an alternate development environment". `GET /alerts` returns every alert on the account, including alerts made on FlightAware's website or apps. Each callback is charged to the key that created the alert; disabling or deleting that key removes the alert. Primary. A user with one key per environment found the endpoint "seems common"; the FlightAware Staff answer was to set `target_url` per alert (https://discussions.flightaware.com/t/register-alert-endpoint-by-api-key/96280, 2024-12-02). Staff forum. Checked 2026-09-30.
14. **`max_weekly`** (https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml; https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml; https://support.flightaware.com/hc/en-us/articles/33381502369175-How-Do-I-Create-A-Post-Alert-In-AeroAPI): the new alert is rejected when its estimated weekly deliveries, from historical trends, would exceed the value; it counts only that alert, is checked only at creation or modification, and "does not prevent alerts from being delivered". Defaults: 1,000 Standard, 4,000 Premium (spec and support article 2026-07-31). Primary. Checked 2026-09-30.
15. **Duplicate limit:** more than 50 alerts with the exact same configuration return 400 (https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml; https://support.flightaware.com/hc/en-us/articles/33381502369175-How-Do-I-Create-A-Post-Alert-In-AeroAPI, updated 2026-07-31). Forum detail: the count is of ENABLED alerts sharing ident, origin and destination; start and end dates do not make alerts unique; an alert with an end date is disabled automatically once the date passes (https://discussions.flightaware.com/t/post-alert-error/95778, 2024-10). Primary plus forum. Checked 2026-09-30.
16. **Dates** (support articles): create alerts 1 to 2 days ahead; start and end may be omitted, in which case monitoring runs until the alert is deleted (https://support.flightaware.com/hc/en-us/articles/33381502369175-How-Do-I-Create-A-Post-Alert-In-AeroAPI, updated 2026-07-31). The API defaults a date's start time to 00:00Z, and creating an alert after that time to start the same day errors (article 32809242173591, https://support.flightaware.com/hc/en-us/articles/32809242173591-Troubleshooting-Common-AeroAPI-Errors, updated 2025-07-12). Forum: `start cannot be before current day` for an overnight flight registered after UTC midnight (thread 95778, 2024-10-28). Primary plus forum. Checked 2026-09-30.

### AeroAPI: delivery behaviour and authentication

17. **No retries.** "AeroAPI push alerts will not automatically retry once they fail" (https://support.flightaware.com/hc/en-us/articles/32809242173591-Troubleshooting-Common-AeroAPI-Errors, updated 2025-07-12). Forum 2019: failed production alerts cannot be retried (https://discussions.flightaware.com/t/problem-with-alerts/47403). Primary plus forum. Checked 2026-09-30.
18. **Timing** (forum, thread 47403, 2019): the endpoint "must respond in 5 seconds or less"; failures logged with durations of 5.2 to 7.2 s; successful deliveries typically completed under 10 s from queueing, some up to 35 s. A FlightAware Staff reply (2019) flagged endpoint responses over 2 s as a problem (https://discussions.flightaware.com/t/registered-alert-endpoint-not-recieving-notifications-suddenly/46594). Forum and staff forum. Checked 2026-09-30.
19. **Authentication** (https://www.flightaware.com/commercial/aeroapi/faq.rvt; https://support.flightaware.com/hc/en-us/articles/32809242173591-Troubleshooting-Common-AeroAPI-Errors): put a unique token parameter in the endpoint URL and verify it, or use URL basic auth (HTTPS only, "not recommended"); deliveries carry constant headers including `User-Agent: AeroAPI/4.0`. The FAQ asks firewall owners to authorize 35.192.194.208, 35.192.194.209 and 35.192.156.45 (it does not say these are the push source). No signature appears in either spec. Primary. Checked 2026-09-30.
20. **429 and billing of errors** (FlightAware Staff, https://discussions.flightaware.com/t/query-response-limit/80831, 2022-03-07): rate limiting is per result set; a 429 consumes 0 quota; 404 and 400 consume 1; FlightAware had "adjusted our billing approach to not bill for any 4xx errors (besides 404s)". 429 body: `"reason": "RATE_LIMIT_ERROR"` (https://discussions.flightaware.com/t/rate-limit-error-when-i-should-be-within-my-bounds/86412). Rate limiting is enforced by a "network-layer partner" and near-limit clients can hit 429 at the "minute interval roll-over" (https://discussions.flightaware.com/t/experiencing-intermittent-429-errors-when-querying-aeroapi-endpoints/93288, 2024-06). Staff forum and forum. Checked 2026-09-30.

### AeroAPI: what triggers change deliveries

21. **Gate changes are delivered.** FlightAware Staff (https://discussions.flightaware.com/t/flight-gate-and-terminal-changes/73932, 2021-02-25): gate and terminal changes before departure trigger under the filed channel (FlightXML naming; the v4 departure bundle includes the filed alert) and en-route changes under arrival, example "Arrival Gate is now D4". A 2025 delivery shown in https://discussions.flightaware.com/t/which-times-are-used-in-the-alerts-endpoints-long-description/98017 is event code `change` carrying new departure and arrival times and "Arrival Gate is now C6"; the FlightAware Staff reply says description times are `estimated_off` and `estimated_on` (out and in for out and in events). Staff forum. Checked 2026-09-30.
22. **Delay threshold and trigger model.** Forum (https://discussions.flightaware.com/t/delay-times/18700, 2016): the estimated-time threshold for alerts is 1801 s and not configurable, chosen because many 30-minute adjustments are erroneous or temporary. FlightAware Staff (https://discussions.flightaware.com/t/delayed-flight-eventcodes-and-push-notification-expectations/60907, 2020): `change` responds to an updated flight plan filing, normally before departure; a flight that left the gate on time and sat 50 minutes on the tarmac produced no `change`. Forum and staff forum. Checked 2026-09-30.
23. **Partial deliveries.** A delivery can carry only `fa_flight_id` plus `error` ("Extended details unavailable"); only `alert_id`, the event code and the flight id are meant for machine processing and the description texts must not be parsed (thread 12474, 2018). Forum. Checked 2026-09-30.
24. **Observed volume.** An alert with all nine 4.17.1 events on an on-time TAP298 flight produced 4 triggers (out, off, on, in), per FlightAware Staff (https://discussions.flightaware.com/t/aeroapi-alerts-not-being-delivered-confirmed-flight-event-without-notification-alert-id-106060439/100235, 2026-03-27). Staff forum. Checked 2026-09-30.

### AeroAPI: identity (merge trigger)

25. **`fa_flight_id` semantics** (https://www.flightaware.com/commercial/aeroapi/faq.rvt; https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml): all responses with the same `fa_flight_id` "can be assumed" to be the same flight; the id is opaque; one flight is one takeoff and one full-stop landing. Spec: a diverted flight's new leg carries a duplicate `fa_flight_id`; `/flights/{ident}` with a flight id returns at most that flight plus diversion legs; `/schedules` returns `fa_flight_id` null "for flights scheduled more than a few days in the future" and `actual_ident` (the operator's ident) for codeshares, up to one year ahead at $0.020 per set. Primary. Checked 2026-09-30.
26. **When the id appears.** Forum (https://discussions.flightaware.com/t/feature-always-return-a-fa-flight-id-on-scheduled-flight-response/82637, 2022-09-16): ids are generated when FlightAware starts tracking, "generally about 48 hours prior to scheduled block off"; 2018: "at most 48 hours prior", possibly much less without operator data (https://discussions.flightaware.com/t/getflightid-flight-not-found/36047). Inference only: decoding example ids gives creation 50 to 54 h before departure. Forum. Checked 2026-09-30.
27. **Ids can be replaced.** A flight id was "suspended" and the flight tracked under a new id, so its alert delivered only `filed` (thread 47403, 2019); FlightAware Staff acknowledged six ids for one SWA flight during an incident (https://discussions.flightaware.com/t/multiple-fa-flight-ids-assigned-to-same-flight/40565, 2018). Forum and staff forum. Checked 2026-09-30.
28. **Codeshares.** `/flights` returns `codeshares` and `codeshares_iata` (Primary). Requesting any codeshare partner's ident returns the operating flight, which is the primary ident (FlightAware Staff, https://discussions.flightaware.com/t/portuguese-domestic-flights-are-incorrect/18442, 2016). Codeshare lists are not transitive: `DAL6890` was listed on `WJA723` but `/flights/DAL6890` returned `WEN3194` (https://discussions.flightaware.com/t/codeshares-are-not-synchronized/80665, 2021). The alert `ident` may be rewritten by codeshare resolution with the original kept in `user_ident` (spec). Primary, staff forum, forum. Checked 2026-09-30.
29. **`cancelled` flag in `/flights`** (https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml; https://www.flightaware.com/commercial/aeroapi/resources/aeroapi-openapi.yml): means FlightAware is no longer tracking the flight; airline cancellation is one reason, "but that will not always be the case". Primary. Checked 2026-09-30.
30. **Gate data coverage** (FlightAware Staff, https://discussions.flightaware.com/t/when-is-inbound-fa-flight-id-populated/96100, 2024-11-22): every tier gets the same gate and baggage data; availability depends on the carrier and airport combination. Staff forum. Checked 2026-09-30.
31. **Usage endpoint** (https://static.flightaware.com/rsrc/aeroapi/aeroapi-openapi.yml; https://www.flightaware.com/commercial/aeroapi/faq.rvt): `GET /account/usage` is free, filters by key (`all_keys`) and date range, reports `total_cost` and `total_discount_cost` per resource, and is "updated every 10 minutes"; there is no account spend cap. Primary. Checked 2026-09-30.

### AeroDataBox

32. **Spec unchanged.** https://doc.aerodatabox.com/docs/openapi-direct-v1.yaml is 1.15.3.0, byte-identical to the vendored copy (SHA-256 `9d2d6b90...c4b5`). Primary. Checked 2026-09-30.
33. **Granularity** (https://doc.aerodatabox.com/docs/openapi-direct-v1.yaml, `SubscribeWebhook`): subjects are `FlightByNumber` or `FlightByAirportIcao` only; notifications cover flights "from 6 hours ago up to 72 hours in future" and include only the items actually updated; subscriptions never expire; creation is FREE TIER. Primary. Checked 2026-09-30.
34. **Billing** (https://aerodatabox.com/flight-alert-api-2026/, updated 2026-01-31; transition ended 2026-04-04): 1 credit per flight item per delivery attempt, retries included; charged when sent, not when delivered; refill converts 1 API unit to 1 credit; one balance for all subscriptions, and all pause at zero. Pricing page (https://aerodatabox.com/pricing/): maximum credits per refill call 4,000 Starter, 40,000 Growth, 400,000 Scale; Growth $99, 400,000 units, 10 req/s; Scale $499, 4,000,000 units, 20 req/s; direct-plan overage only via ADS-B feeding. Primary. Checked 2026-09-30.
35. **Delivery** (https://doc.aerodatabox.com/docs/openapi-direct-v1.yaml, `SubscribeWebhook`, `CreateWebHookSubscription`, `FlightNotificationContract`): best effort, "might be missing or delayed"; 10 s timeout; `maxDeliveryRetries` 0 by default, 2 at most, each billed; notification `id` stays the same across retries; each notification carries the remaining balance. The URL must be public HTTP(S) on ports 80, 443, 8008, 8080 or 49152 and above, "not requiring additional authorization"; there is no secret or signature. Primary. Checked 2026-09-30.
36. **Triggers** (https://doc.aerodatabox.com/docs/openapi-direct-v1.yaml): "whenever the flight information gets updated"; items embed full movement contracts (times, gate, terminal, belt, status) plus `notificationSummary` and `notificationRemark` texts. Which field changes trigger an item is not documented. Primary. Checked 2026-09-30.
37. **Coverage** (https://aerodatabox.com/data-coverage/, https://aerodatabox.com/faq/): no alert updates for airports without stable live or ADS-B coverage; United States live status coverage 86% (table updated 2026-06-03); the live layer updates "typically from nearly real-time up to once in a few hours"; gate is present "sometimes"; live look-ahead is about a day. Primary. Checked 2026-09-30.
38. **Plan fit** (https://aerodatabox.com/pricing/): the Flight Alert API row lists Growth, so alerts are available on Growth. Primary. Checked 2026-09-30.

### Thresholds, practice and push mechanics

39. **14 CFR 234.2** (https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-234/section-234.2, read through the eCFR API at version 2026-09-01): a late flight arrives at the gate 15 minutes or more after its published arrival time; on time is under 15 minutes. Primary. Checked 2026-09-30.
40. **14 CFR 259.8** (https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-259/section-259.8): carriers must notify ticketed passengers and subscribers within 30 minutes of learning of a cancellation, diversion or "delay of 30 minutes or more", for flights within seven days. Primary. Checked 2026-09-30.
41. **14 CFR 260.2** (https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-260/section-260.2): a "significantly delayed" flight (refund right) is 3 h domestic or 6 h international. Primary. Checked 2026-09-30.
42. **Airline practice:** JetBlue notifies within 30 minutes for delays of 30 minutes or more, including push (https://www.jetblue.com/customer-assurance/customer-service-plan). Primary (carrier page). Checked 2026-09-30.
43. **Flighty** (https://flighty.com/help/flighty-notifications, updated 2026-08-16): pushes delay predictions, airport delays, inbound plane, gate change, taxi, takeoff and landing, cancellation or diversion, baggage claim and check-in; no numeric thresholds published. Third party. Checked 2026-09-30.
44. **TripWaffle benchmark** (https://tripwaffle.com/data/flight-alerts/, data as of 2026-09-30, vendor-run): TripWaffle does not alert delays under 15 minutes; median landed alerts 11 s (Flighty), 13 s (TripWaffle), 1 min 8 s (TripIt) after touchdown. Third party. Checked 2026-09-30.
45. **APNs request headers** (https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns): `apns-collapse-id` merges notifications, 64 bytes at most; APNs stores only one notification per bundle ID for an offline device, usually the latest; priority 5 and 1 may be grouped and throttled. Primary. Checked 2026-09-30.
46. **APNs payload** (https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification): `interruption-level` passive, active, time-sensitive or critical; `thread-id` groups; `relevance-score` 0 to 1. Time Sensitive breaks through Notification Summary and Focus, and the user can turn it off (UNNotificationInterruptionLevel.timeSensitive page). Primary. Checked 2026-09-30.
47. **FCM** (https://firebase.google.com/docs/cloud-messaging/customize-messages/collapsible-message-types, updated 2026-09-24): at most four collapse keys per registration token; notification messages are always collapsible and ignore `collapse_key`. FCM v1 reference (updated 2026-09-08): `android.notification.tag` replaces a shown notification with the same tag. Primary. Checked 2026-09-30.

## 3. Conflicts with the repository

| # | File:line | Repository says | Source says |
|---|---|---|---|
| C1 | `apps/api/src/providers/specs/README.md:12` | AeroAPI spec vendored at 4.17.1 from the `resources` URL | Current spec is 4.30.0 at `static.flightaware.com` (fact 1); the legacy URL is stale |
| C2 | `packages/shared/src/flight-status.ts:113-117` | `hold_start` and `hold_end` "do not exist in the spec" | They exist, and are listed as required, in 4.30.0 (fact 2) |
| C3 | `packages/shared/src/flight-status.ts:140-159` | 18 delivery codes | 22: adds `uncancelled`, `impending_departure`, `hold_entry`, `hold_exit` (fact 4); `uncancelled` currently parses as `unknown` |
| C4 | `apps/api/src/providers/aeroapi.mock.ts:1321-1330` | Sends 9 booleans, `eta: 0`, `start = end =` origin-local date | 4.30.0 requires 11 booleans (400 risk, U3); same-day or before-UTC-day starts are refused (fact 16), so late-added and overnight flights may fail to register |
| C5 | `docs/plans/phase0-plan.md:21` | "AeroAPI push alerts do not cover gate changes"; alerts "bundle ETA changes" | Gate changes are in both bundles; estimate changes only above 30 min (1801 s), at most 5 per bundle (facts 5, 21, 22) |
| C6 | `packages/shared/src/cadence.ts:343`, `docs/architecture.md:348` | "In-flight polls only need to catch gates"; "OOOI and ETA arrive by alert" | ETA drift under 30 min never arrives by alert; the 30-min in-flight polls are its only source (fact 22) |
| C7 | `packages/shared/src/cadence.ts:520-529` (`boundsOf`) | Departure-side windows anchor on scheduled out | A ground delay sits in the 30-min band, so gate changes during delays wait up to 30 min against a 15-min SLO |
| C8 | `docs/adr/0010-provider-identity.md:83-87`, `docs/open-decisions.md:50` | Separate keys cost "two $100 monthly minimums" | Extra keys are free and encouraged for dev and prod on one account (fact 12); only the default endpoint stays shared (fact 13) |
| C9 | `docs/plans/phase0-plan.md:249`, `docs/research/phase0-dossier.md:13,485` | An "account-level weekly alert cap" of 1,000 on Standard | `max_weekly` is per alert and creation-time only; no account weekly cap is documented; the account limit is 50 identical enabled alerts (facts 14, 15) |
| C10 | `docs/research/phase0-dossier.md:303,307,548` | `max_weekly` 20 is "the external backstop"; non-retry "unverified here"; silence = no delivery by scheduled off + 15 min | Not a backstop (fact 14); non-retry verified (fact 17); the clock-based silence rule false-fires on any gate-delayed flight that got no `filed` alert, as on the TAP298 example (fact 24) |
| C11 | `apps/api/src/routes/webhooks.ts:23-25` | "a provider that times out on its own webhook retries it" | AeroAPI never retries; AeroDataBox retries only when `maxDeliveryRetries` is set (default 0) (facts 17, 35). A slow receiver loses the event |
| C12 | `apps/api/src/providers/aeroapi.mock.ts:878` (`mergeAeroApiAlert`) | A delivery for another `fa_flight_id` "is not applied" | FlightAware can re-key a flight (fact 27); dropping it silently loses the flight's alerts |
| C13 | `packages/shared/src/cadence.ts:190`, `docs/cost-estimate.md:19,129` | 12 deliveries per flight | FAQ: each bundle is the event plus potentially 1 to 2 changes; an on-time flight with all events gave 4 (facts 9, 24). Inference: 5 to 9 typical; 12 is conservative |
| C14 | `apps/api/src/providers/aeroapi.mock.ts:25-26` | Every non-200 billed | 429 consumes no quota; non-429 4xx other than 404 unbilled as of 2022 (fact 20). Conservative, not unsafe |
| C15 | `apps/api/src/providers/config.ts:57` vs `docs/research/phase0-dossier.md:307` | Token bucket at 5/s (code) vs 4/s (dossier) | Near-limit clients see 429 at minute roll-over (fact 20); 5/s leaves no headroom |
| C16 | `docs/research/phase0-dossier.md:348` | Alert deliveries "do not consume result sets/second" | No FlightAware source says so (U7) |
| C17 | `packages/shared/src/cadence.ts:386-393` (cadence B) | AeroDataBox webhooks "carry gates and times" | Payload carries them, but triggers are undocumented, gates are "sometimes" and live updates can lag hours (facts 36, 37) |

## 4. Design implications for Phase 1

- **D1. Re-vendor AeroAPI 4.30.0 before `AEROAPI_MODE=live`.** Send all 11 event booleans explicitly (holds `false`), drop `eta: 0` (the support article asks for minimal bodies), and add the four new delivery codes with `uncancelled` routed as a cancellation correction. Trade-off: re-pins the spec hash, fixtures and contract tests; the vendoring source URL in the README changes.
- **D2. Alerts accelerate, polls decide.** Merge every delivery, but run one confirming re-read (1 result set, $0.005) for `change`, `cancelled`, `uncancelled`, `diverted` and any delivery carrying `error`, before a user-visible push. Trade-off: about one extra poll per eventful flight and a few seconds of push latency, against pushing from a partial or stale payload.
- **D3. Re-anchor the 15-minute band on departure, not boarding.** Keep the 15-minute grid until `max(scheduled_out, estimated_out)` (or actual out) and start the 30-minute band there. On time this is cost-neutral: 24 + 6 slots instead of 22 + 8 (both 30; A2 stays 74 polls). A gate delay of D minutes adds about D/30 polls ($0.01 for 60 min). Trade-off: the last in-flight slot moves from in-10 to in-30, widening the landing gap from 10 to 30 min unless one arrival-anchored slot is kept (+1 poll, $0.005); the `on` and `in` deliveries cover it in normal operation.
- **D4. Register alerts by `fa_flight_id` once known, not by ident, origin and date.** First AeroAPI poll (T-47 h or later) yields the id; register with the id as `ident`, no start date, `end` = origin-local date + 1, and DELETE on finish. Before an id exists, register by operating ident, ICAO origin and date only when the start date is not earlier than the current UTC day. Trade-off: id-only alerts are forum-attested, not documented (U4), and a re-keyed flight silences the alert, which D5 must catch.
- **D5. Silence detection keyed on observed events, not on the clock.** When a poll sees `actual_out`, `actual_off`, `actual_on` or `actual_in` (events the alert is registered for and FlightAware always sends) and no delivery for it arrives within 10 minutes, mark the alert suspect, re-read by designator to catch a new `fa_flight_id`, re-register, and run A1 for that flight until deliveries resume. Globally, zero deliveries for 30 minutes while at least N tracked flights are airborne raises the ops alert and moves everyone to A1. Gate and estimate changes are not usable as silence signals because their delivery is not guaranteed (facts 5, 22). Trade-off: extra polls during a FlightAware push outage, and silence is only detectable once the flight reaches out, so a pre-departure outage goes unnoticed until then.
- **D6. Webhook receiver SLO.** Acknowledge AeroAPI in under 2 s (FlightAware treats more than 5 s as failure and never retries) and AeroDataBox in under 10 s; enqueue only (already the design). Log `CF-Connecting-IP` and user agent for every delivery and compare against the FAQ IPs as a signal, not a gate. Keep TLS 1.2 enabled on the API hostname (a 2024 user report says FlightAware push lacked TLS 1.3). Trade-off: none material; a future WAF or bot rule on the webhook path would silently drop unretried deliveries.
- **D7. One FlightAware account, one key per environment.** Extra keys are free (fact 12), deliveries bill to the creating key (fact 13), and `target_url` stays mandatory. PUT the account default only when `GET /alerts/endpoint` returns none (both calls are free), so the environments stop overwriting each other, and filter every `GET /alerts` cleanup by the environment's `target_url` token because the list is account-wide and includes website and app alerts. Use a dedicated company FlightAware login. Trade-off: the default endpoint is still shared, and if the 5/s limit is per account (U8), staging traffic eats production's rate.
- **D8. Budget lease inputs.** Lease AeroAPI at 4 result sets/s (80% of Standard), treat non-429 4xx as consuming rate quota, and reconcile the ledger, including FlightAware-initiated deliveries, against free `GET /account/usage?all_keys=true` every 15 minutes (10-minute freshness). Do not split AeroAPI's per-second rate across 8 shards (0.5/s each starves bursty alarms); shard only the unit ledger if throughput demands it. Trade-off: 20% of paid rate unused, against fewer 429s and simpler sharding.
- **D9. `max_weekly` as a misconfiguration guard only.** Set it to the lowest value that passes for a daily flight with the full event set (start at 50, calibrate in staging); cap spend with the ledger and `DELETE`. Trade-off: too low a value produces false 400s at registration.
- **D10. Push policy for delays.** First delay push when departure delay reaches 15 minutes (14 CFR 234.2), ahead of the carriers' 30-minute duty and FlightAware's 1801 s alerts; re-push only when the estimate moves 15 minutes or more from the last pushed value, or falls back under 15; a 5-minute settle window absorbs jitter; at most one delay push per flight per 15 minutes; arrival-ETA pushes only when the arrival delay crosses a new 15-minute band not already implied by the departure push. Every push is self-contained (current times and gate) because APNs keeps only the latest pending notification; `apns-collapse-id` and Android `tag` = `{kind}:{flightKey}` (well under 64 bytes). Trade-off: a 15-minute line pushes more often than a 30-minute line; 30 minutes would match airlines and cut volume but lose the product's speed edge.
- **D11. Push cancellation and diversion in Phase 1.** Detection is already paid for (A2 registers both), DOT defines them as the core status changes (fact 40), and competitors push them (fact 43). Source them from the `cancelled`, `uncancelled` and `diverted` codes or AeroDataBox `Canceled` and `Diverted` statuses, each confirmed by a re-read; never from AeroAPI's polled `cancelled` flag alone (fact 29); send a correction on `uncancelled`. Use Time Sensitive for cancellation, diversion and gate changes within 2 h of departure. Trade-off: $0.005 and seconds per confirmation, against the reputational cost of a false cancellation.
- **D12. Gate push rules.** Origin gate from T-6 h to out, destination gate from off to in; first assignment is a user setting, not a default push; suppress an A to B to A flap within 10 minutes. Every OOOI delivery carries the current gates (fact 7), so `on` refreshes the destination gate at no extra cost. Trade-off: first-assignment pushes are useful but double early volume.
- **D13. Merge trigger.** Equal `fa_flight_id` on two keys is proof (fact 25); an operator or codeshare mismatch is only a candidate (fact 28); a different id does not prove different flights (fact 27). The persist consumer can look up duplicates through the non-unique `flight_instances_aeroapi_fa_flight_id_idx`. Earliest proof: the first AeroAPI poll after FlightAware starts tracking (about T-48 h, sometimes later). Earlier candidate evidence is `/schedules` `actual_ident` at $0.020 per set. Trade-off: merging at T-48 h keeps two pre-48 h trackers alive on cheap weekly AeroDataBox polls; merging earlier costs one `/schedules` call per candidate pair.
- **D14. `mergeAeroApiAlert` on a mismatched id.** Treat a delivery for a new `fa_flight_id` as an identity event: re-read by designator and reconcile, instead of dropping it. Trade-off: one poll per re-key, which is rare.
- **D15. AeroDataBox alerts stay behind the flag until measured.** A per-number coordinator subscribes when the first tracked date enters the minus 6 h to plus 72 h window and unsubscribes when the last leaves; units come out of the same quota as polls. Measure triggers, items per flight and latency on 50 flights before cadence B. Trade-off: cheap per item but lossy, unauthenticated, quota-bound and as slow as "a few hours" where live coverage is weak.

## 5. Cost numbers

### 5.1 Inputs

- AeroAPI: poll $0.005, delivery $0.020 (fact 8); Standard $100 minimum (fact 10); marginal bands (fact 10).
- AeroDataBox Growth unit: $99 / 400,000 = $0.0002475 (fact 34).
- A2 polls per flight: 74 (`A2_EXPECTED_POLLS`, docs/architecture.md); D3 keeps 74 for an on-time flight.
- Deliveries per flight with the A2 event set: on-time floor 4 to 5 (fact 24: out, off, on, in, plus filed where FlightAware has one); each bundle adds 0 to 2 change alerts in the FAQ's words (fact 9). Central assumption 7 (ASSUMED, not measured).

### 5.2 Per flight, AeroAPI list price

| Scenario | Arithmetic | Per flight |
|---|---|---|
| A2 as built (repo) | 74 x $0.005 + 12 x $0.020 = $0.370 + $0.240 | $0.610 |
| A2, on-time floor | 74 x $0.005 + 5 x $0.020 = $0.370 + $0.100 | $0.470 |
| A2, central | 74 x $0.005 + 7 x $0.020 = $0.370 + $0.140 | $0.510 |
| A2, high (5 base + 2 bundles x 5 changes + 1 other) | 74 x $0.005 + 16 x $0.020 = $0.370 + $0.320 | $0.690 |
| **Recommended (D2, D3), central** | (74 + 1 confirm) x $0.005 + 7 x $0.020 = $0.375 + $0.140 | **$0.515** |
| A1 polls only (fallback) | 84 x $0.005 | $0.420 |
| Cadence B, AeroAPI part | 5 x $0.005 + 8 x $0.020 = $0.025 + $0.160 | $0.185 |
| D3 on a gate delay of D min | + (D / 30) x $0.005; D = 60 gives 2 x $0.005 | + $0.010 |

### 5.3 Monthly AeroAPI invoice (bands applied as marginal to list spend)

| Scenario | 1k flights | 10k flights | 100k flights |
|---|---|---|---|
| A2 as built ($0.610) | list $610, invoice $610 | list $6,100: 1,000 + 1,000 x 0.70 + 2,000 x 0.49 + 2,100 x 0.35 = **$3,415** | list $61,000: 1,000 + 700 + 980 + 1,400 + 1,920 + 2,720 + 29,000 x 0.12 = **$12,200** |
| Recommended ($0.515) | list $515, invoice $515 | list $5,150: 1,000 + 700 + 980 + 1,150 x 0.35 = **$3,083** | list $51,500: 1,000 + 700 + 980 + 1,400 + 1,920 + 2,720 + 19,500 x 0.12 = **$11,060** |
| A1 ($0.420) | $420 | list $4,200: 1,000 + 700 + 980 + 200 x 0.35 = **$2,750** | list $42,000: ... + 10,000 x 0.12 = **$9,920** |
| B, AeroAPI part ($0.185) | $185 | list $1,850: 1,000 + 850 x 0.70 = **$1,595** | list $18,500: 1,000 + 700 + 980 + 1,400 + 1,920 + 2,500 x 0.17 = **$6,425** |

The $100 minimum never binds at 1k flights for any scenario above ($185 or more). At 100k flights A2 needs Premium for rate (section 5.6); Premium's per-query prices are the same and its $1,000 minimum is below usage, so the invoice is unchanged. Per flight after
bands at 10k: $0.342 (A2 as built) versus $0.308 (recommended); at 100k: $0.122 versus $0.111.

### 5.4 Gate-change detection gap under A2, and what closes it

| A2 band (cadence.ts) | Poll interval | Worst-case poll gap for a gate change | Closed by | Marginal price |
|---|---|---|---|---|
| Pre-48 h (AeroDataBox weekly) | 7 d | not tracked (the gate SLO starts at 48 h) | nothing needed | n/a |
| T-48 h to T-6 h | 60 min | 60 min | departure bundle `change` (origin gate) | $0.02 per change delivered |
| T-6 h to boarding (T-40 min) | 15 min | 15 min | meets SLO; bundle `change` makes it seconds | $0.02 per change |
| Boarding to arrival (and any ground delay) | 30 min | 30 min (origin gate during boarding or delay; destination gate en route) | D3 re-anchor (origin); arrival bundle `change` and the `on` delivery (destination) | $0 on time, $0.005 per extra poll; $0.02 per change |
| Arrival to stop (in + 120) | 60 min | 60 min (baggage, not gates) | `in` delivery carries the final gate | already paid |

Add pipeline latency on top of each gap: AeroAPI delivery under 10 s typical, up to 35 s (fact 18).
AeroDataBox alerts would close the same gaps at 1 unit per item ($0.0002475 on Growth), but with
live updates as slow as "once in a few hours" in weak regions (fact 37).

### 5.5 AeroDataBox alert add-on (cadence B or a hybrid): units and plan fit

Units per tracked flight = items per dated flight (I) x multi-date factor (m, other dates of the same
number inside minus 6 h to plus 72 h). Polls and searches add about 8 units per flight
(`docs/cost-estimate.md` section 3).

| Case | I x m | $ per flight (Growth) | 1k flights (units incl. 8 for polls) | 10k flights | 100k flights |
|---|---|---|---|---|---|
| Low | 10 x 1 = 10 | 10 x $0.0002475 = $0.0025 | 18,000: Growth | 180,000: Growth | 1,800,000: Scale |
| Central (repo's 15 items) | 15 x 2 = 30 | $0.0074 | 38,000: Growth | 380,000: 95% of Growth, so Scale ($499) | 3,800,000: 95% of Scale, so Custom |
| High | 50 x 3 = 150 | $0.0371 | 158,000: Growth | 1,580,000: Scale | 15,800,000: Custom |

In dollars AeroDataBox alerts are noise; the binding constraint is quota. A per-number coordinator
drives m toward 1.

### 5.6 Rate check (Standard 5 result sets/s)

A2 polls: 10k flights x 74 = 740,000 per month / 2,592,000 s = 0.29/s average, 1.14/s at the
assumed 4x peak; 100k flights: 2.85/s average, 11.4/s peak, so Premium (100/s) is needed near 45k
flights (1.29/s average x 4 = 5.1/s). Deliveries are excluded pending U7. Leasing at 4/s (D8) moves
the Premium threshold to about 35k flights on A2.

## 6. UNVERIFIED items and how to settle each

| # | Item | How to settle |
|---|---|---|
| U1 | Whether `change` carries terminal changes as well as gates | Staging key: alerts on 20 hub flights for 2 weeks, log every `change` payload |
| U2 | Whether `filed` plus `departure` delivers the filed alert twice | Same staging run; drop explicit `filed` if duplicated (saves up to $0.02 per flight) |
| U3 | Whether 4.30.0 rejects a body missing `hold_start` and `hold_end` | One free `POST /alerts` in staging |
| U4 | Whether an alert with a `fa_flight_id` as `ident` and no origin or dates works, and what happens when the id is replaced | Staging test plus a written question to FlightAware |
| U5 | Which "current day" (UTC or origin local) the start-date check uses, and whether same-day starts fail | Staging test on a 21:00 Pacific departure registered after 00:00Z; written question |
| U6 | Whether timed-out or failed deliveries are billed (a 2024 user report says cost accrued) | Written question; compare `/account/usage` against received deliveries |
| U7 | Whether deliveries consume the 5 result sets/s | Written question to FlightAware |
| U8 | Whether rate limits are per key or per account | Written question |
| U9 | Deliveries per flight with the A2 event set (repo 12, evidence 5 to 9) | `alerts_delivered` per flight in staging for 2 weeks |
| U10 | Whether the three FAQ IPs are the push source | Log `CF-Connecting-IP` on every delivery for 2 weeks |
| U11 | Whether FlightAware push supports TLS 1.3 (2024 user report says no) | Keep TLS 1.2 on; confirm with FlightAware |
| U12 | End-to-end OOOI delivery latency versus the 2-minute SLO | Receive time minus `actual_*` in each delivery, staging |
| U13 | Whether the 2022 "no bill for 4xx except 404" rule still holds | Written question; reconcile `/account/usage` failed-call counts |
| U14 | Whether the rate limiter is a per-minute window (300/min) or per second | Written question |
| U15 | Whether an airport-delay `delay` code still exists in v4 | Tolerant parser logs unknown codes |
| U16 | AeroDataBox: triggering fields, items per flight, latency, whether ADS-B or location updates trigger, codeshare items, subscription count limit, maximum balance per plan, source IPs | 50-flight staging run with `ADB_ALERTS_ENABLED`; written questions to AeroDataBox |
| U17 | Whether Time Sensitive needs a separate capability on the App ID | Apple entitlement docs during the push build |
| U18 | FlightAware's own gate-data latency relative to airline systems | Compare staging deliveries with airline app pushes on 20 flights |

## 7. Owner actions with lead time

| Action | Lead time | Needed before |
|---|---|---|
| Create a dedicated company FlightAware account (not a personal login) on Standard ($100 minimum) with two keys, `staging` and `production` | Same day | First alert registration in staging |
| Written questions to FlightAware (integration sales or support): U4, U5, U6, U7, U8, U13, U14, U2, U1, U11 | Allow 1 to 2 weeks for answers | `AEROAPI_MODE=live` in production |
| Buy AeroDataBox alert credits for the measurement run (for example 10,000 credits = 10,000 Growth units, 2.5% of the month) | Same day once Growth is active | Cadence B decision (end of Phase 1) |
| Confirm the Cloudflare zone keeps TLS 1.2 enabled and no WAF or bot challenge covers `/v1/webhooks/*` | 15 minutes | First live delivery |
| Decide the default delay threshold (15 or 30 minutes), whether users can change it, and whether first gate assignment pushes | One product review | Push UX build |
| Enable the Time Sensitive Notifications capability on the production App ID if Apple requires it | Minutes, once the App ID exists | First TestFlight build with pushes |
