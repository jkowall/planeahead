# PlaneAhead Phase 1 Plan: Core tracking

Date: 2026-09-30. Status: proposed, waiting for the owner's go-ahead. Drafted by Opus 5.5 from five
facts sheets verified against primary sources on 2026-09-30 (`docs/research/phase1/`), then
red-teamed by Fable 5.1 (2 blockers, 9 majors, 13 minors, 6 nits, all applied below).

## 1. Scope

The brief defines Phase 1 as: add and track flights, flight detail, the `FlightTracker` Durable
Object with its refresh schedule, airport boards, and basic push notifications for delay and gate
change on both platforms, shippable to TestFlight and internal Android testing.

Phase 0 built the first three (increments 7, 8 and 10), every table Phase 1 needs (`push_tokens`,
`notifications`, `notification_deliveries`, `notification_preferences`) and the shells it fills
(the `notify` consumer, `AirportState`, both providers' board methods). Phase 1 adds:

1. The first builds in testers' hands: TestFlight and the Play internal track.
2. A push path from the tracker to phones: APNs direct and FCM HTTP v1, from Workers.
3. Notification policy for delay, gate change, cancellation and diversion, without storms.
4. Real provider traffic, under the licence posture in section 2.
5. Airport boards for any covered airport, and search by route and date from the same cache.

**Carried in from Phase 0, stated so nothing is silent:** the flight detail's progress and
remaining time while airborne (the brief's detail item, not built in increment 10); Apple refresh
token validation (TN3194) and the Apple server-to-server notification handler; the AeroDataBox
alert field-coverage measurement that open decision 2 needs by the end of Phase 1. **Additions
beyond the brief's wording:** cancellation and diversion pushes, route search. **Deferred, and to
where:** Live Activities, Dynamic Island, widgets and the status timeline to Phase 2 (the brief's
own split); quiet hours and an in-app alerts inbox screen to Phase 2 (Phase 1 writes the
`notifications` rows they will read); the `UserInbox` object stays with email import in Phase 3.

**Milestone.** On TestFlight and the Play internal track, against the production API, a signed-in
user adds a flight by number or from an airport board. A gate change, cancellation, diversion or
OOOI event that a provider alert carries reaches the phone within about a minute; a change that
only a poll sees arrives within that band's poll interval (up to 60 minutes from T-48 h to T-6 h,
15 minutes from T-6 h to departure, 30 minutes in flight). Boards load from cache. A signed-out
device receives nothing.

## 2. Where I push back

1. **FlightAware's licence gates the provider design.** Item 10 of the AeroAPI Standard licence
   (January 2025) says the licensee may not "use the AeroAPI Data in conjunction with or as a
   backfill to" another real-time provider's data without written permission. Phase 0 blends
   AeroAPI inside 48 hours with AeroDataBox (ADB) elsewhere, and Phase 2's ADS-B feeds would be a
   third real-time source, so no option escapes the question. I read the licence and terms text
   myself.
2. **Retention: assume 24 hours until FlightAware writes otherwise.** FlightAware's September 2026
   terms (3.4 iii) allow storing its data "for a maximum of twenty-four (24) hours from receipt,
   or as otherwise allowed in the Order", and they control over an Order unless the Order is
   negotiated; the licence's own escape is that "Derivative Works may be stored in perpetuity".
   Phase 1 therefore stores only derived, normalised data from AeroAPI (`FlightStatus` with
   per-field provenance, never raw AeroAPI JSON), keeps `provider_webhook_events` unwritten,
   redacts AeroAPI bodies in `dlq/` archives after 24 hours, records no production fixtures, and
   adds a per-source retention switch for `flight_events`, R2 timelines and sync snapshots. The
   first written question is whether normalised snapshots, per-flight timelines and logbook
   entries are Derivative Works; the logbook (Phase 6), the offline store and share pages (Phase
   5) depend on the answer.
3. **Section 4.8 reaches how this project is built.** The terms bar using FlightAware data "with
   any AI System", large language models included, without written authorisation. That covers the
   MCP endpoint and in-app questions (Phase 6), feature logging for a trained delay model (Phase
   4), and the Opus and Fable agents that build and review this code. Until FlightAware answers,
   agents work only on synthetic fixtures and redacted logs, and a person runs the analysis of
   real AeroAPI soak data.
4. **APNs from Workers is plausible, not documented.** APNs requires HTTP/2 and workerd has no
   HTTP/2 client; a Cloudflare maintainer says production fetch negotiates HTTP/2 to origins, and
   2026 deployments report it working, but no Cloudflare page says so. Phase 1 gates on a staging
   send and a 24 to 48 hour soak, behind a `PushTransport` interface with a designed fallback.
5. **Live Activities are Phase 2.** ADR 0008 and `docs/open-decisions.md` section 5 call several
   Live Activity items "Phase 1"; they move to Phase 2, except token hygiene on sign-out, which the
   Phase 1 sender needs for every token kind.
6. **Store plumbing starts first.** TestFlight and the Play internal track take store-signed
   production builds that talk to `api.planeahead.app`. Phase 0's build already has two upload
   blockers (the widget extension has no privacy manifest; the watch shells hard-code version 1.0
   against the app's 0.1.0), cheaper to find now than on the push release.

## 3. Decisions (each with why and how reversible)

| Area | Decision | Why | Reversible |
| --- | --- | --- | --- |
| Distribution | TestFlight and Play internal carry the `production` variant, built on EAS Starter with pinned images (`macos-tahoe-26.5-xcode-26.6`, `ubuntu-26.04-jdk-17-ndk-r27b-sdk-57`, CocoaPods 1.17.0); the first build of each platform runs interactively on your Mac | App Groups registration needs an Apple ID login; the pins keep EAS, the smoke and local spikes on one toolchain | Yes |
| Push transport | APNs direct over `fetch` and FCM HTTP v1, behind `PushTransport`; fallbacks designed, not built, in this order: a Cloudflare Container relay (about $1.71 a month; its image builds in CI, which has Docker), FCM for iOS (adds the Firebase iOS SDK), Expo's push service for plain alerts | Direct APNs is needed anyway for Live Activities | Yes, per transport |
| Push credentials | One APNs key per environment (sandbox on staging, production on production), one shared JWT per environment minted by a new `PushAuth` Durable Object; FCM OAuth tokens the same way | APNs rejects a new token more than once per 20 minutes on a connection, and pooling across isolates is unknown | Yes |
| Fan-out | `notify_intent` rides the tracker's existing outbox to `persist`, which forwards it to `notify` and confirms it; `notify` resolves targets and writes `notifications` rows; a new `push` queue sends with at most 6 requests in flight per invocation | Keeps one outbox sink and its confirm protocol, so the +22 h deletion invariant holds; keeps Postgres out of the network-bound stage | Yes |
| Classification | Provider-neutral: rules run on `FlightStatus` diffs (`diffSnapshots` exists); AeroAPI alert codes only accelerate, isolated in increment 17 | The rules must survive any provider decision | Yes |
| Delay rule | First push at 15 minutes late (the DOT's definition), a 5-minute settle re-read before it ($0.005 per delay event), then only when the estimate moves another 15, at most one per flight per 15 minutes; a correction when it falls back under 15; arrival delays push only on crossing a new 15-minute band not implied by the departure push | Ahead of airlines' 30-minute duty without storms from estimate jitter | Yes, constants |
| Gates | Origin gate pushes from T-6 h to out, destination gate from off to in; A to B to A within 10 minutes is suppressed; first assignment is a setting, off by default | Flaps and first assignments are noise for most users | Yes |
| Cancellation, diversion | Pushed, only after confirmation: a polled `cancelled` flag puts the tracker in a new `cancel_suspect` state that never finishes the tracker; an alert code or a designator re-read (not an `fa_flight_id` re-read, which returns the same flag) confirms it | FlightAware re-keys flights; Phase 0 would finish the tracker on a false cancellation | Yes |
| Cadence | A2 (74 polls), with the 15-minute band anchored on departure, not boarding | Closes the gate gap during boarding and ground delays; cost-neutral on time | Yes, a constant |
| Alerts | Register by `fa_flight_id` once known (about T-48 h); by ident only when the start date is tomorrow or later in UTC; silence detection on observed OOOI events falls back to A1 | FlightAware refuses same-day ident registration; a re-keyed flight silences its alert | Yes |
| Boards | ADB only, one fetch shape (`direction=Both`, codeshares, cancelled), 12-hour buckets per airport in `AirportState` and KV, R3's six-row freshness ladder (normative), a boards share of the daily ADB budget, caps per principal and per IP, a global cap on distinct airports refreshed per hour, anonymous users limited to airports of their tracked flights | 100x to 700x cheaper than AeroAPI boards, no item-10 exposure, and no quota sweep that looks like a dump to ADB | Yes |
| Route search | From the origin's board buckets, filtered by destination | About $0.001 per uncached search against $0.02 to $0.14 on AeroAPI `/schedules` | Yes |
| Client push | Explicit permission in context after the first add; token and permission state re-registered on every launch and rotation; two Android channels fixed before the first build; time-sensitive only within an hour of departure, for any kind | Provisional stays quiet even after "Keep"; channel importance is frozen at creation; Apple's rule for time-sensitive is "now or within an hour" | Channel ids are permanent |
| Toolchain | Xcode 26.6 and SDK 57 for Phase 1 | Uploads valid until April 2027; SDK 58 (Xcode 27) in Q1 2027 | Yes |

## 4. Architecture changes

**Push path.** The `FlightTracker` alarm classifies a state change and writes a `notify_intent`
row to its outbox in the same transaction, guarded by `notif_dedupe`. The outbox flushes to
`persist` as today; `persist` forwards the intent to `notify` and confirms the row, so a finished
tracker still deletes only once its outbox is empty. `notify` (Postgres; `max_batch_size` 10,
`max_batch_timeout` 1 s, `max_concurrency` 5) resolves live subscriptions, preferences and tokens
with permission, inserts `notifications` rows idempotently (unique per user and dedupe key), and
sends `push` jobs of up to 50 targets. `push` (no Postgres; `max_batch_size` 5,
`max_batch_timeout` 0) sends through `PushTransport` with a 6-way semaphore and a 10-second
timeout, retries per target with explicit delays (FCM 429 honours `Retry-After`; APNs 5xx waits
Apple's 15 minutes, or is dropped past the event's relevance window, section 11), and reports
outcomes to `persist`, which records deliveries and invalidates dead tokens (APNs `Unregistered`
only when the token was registered before the 410 timestamp). Duplicates are tolerated:
`apns-collapse-id` and the Android `tag` are `{kind}:{flightKey}`, so a redelivered push replaces
the first on screen, and every push carries the full current state.

**Payload contract.** App data rides in a top-level APNs `body` dictionary beside `aps` (never as
peers of `aps`, which expo-notifications does not expose), and in flat FCM `data` strings that
never include a `body` key: `flightSubscriptionId`, `kind`, `v`, plus `tag` and `channelId`
repeated in `data`. `apns-expiration` and the FCM `ttl` end when the information stops mattering
(departure for a gate change, arrival for a delay).

**Transport gate and soak.** Staging holds only the sandbox key, so its smoke sends from the
queue-consumer path to a Simulator sandbox token and asserts 200 with an `apns-id`. The
production smoke runs from the production Worker with the production key to your TestFlight
iPhone. Then a 24 to 48 hour soak of synthetic injected events on staging counts every 403 and
429 reason (`UnrelatedKeyIdInToken`, `TooManyProviderTokenUpdates`) and edge 52x without an
`apns-id`, with a canary that sends from two isolates at once. A failure ships the relay, with no
change above `PushTransport`.

**Event injector.** An Access-protected admin action writes a synthetic change into a tracker, on
staging for anyone with Access and on production only for user ids in
`PUSH_INJECT_ALLOWED_USER_IDS`; injected pushes are marked as tests. It drives every push exit
test without waiting for a real gate change.

**Boards.** `AirportState`, one per ICAO code, is the only caller of the FIDS endpoint. It
coalesces concurrent misses per bucket, stores each bucket as one compressed blob, and writes KV
`board:v2:{ICAO}:{bucket}` with `fetchedAt`, `freshUntil` and `staleUntil`. Workers read KV and
call the object only on a miss or past freshness. The ladder is R3's (5 minutes fresh for the
bucket containing now, 30 minutes 3 to 24 hours ahead, 3 hours to 72 hours, 12 hours beyond, 15
minutes for buckets ended under 3 hours ago, no refresh after 24 hours, purge 48 hours after a
bucket ends). The boards share (35 percent of the daily ADB cap recommended) doubles the ladder at
70 percent, quadruples it at 90, serves stale only at 100. On Growth that keeps about 8 hub
airports at 5-minute freshness around the clock; the admin page shows airports kept live against
that ceiling. Filters apply after the cache; rows are UI-shaped; boards stay out of share pages and
MCP until ADB confirms.

**Providers.** The AeroAPI adapter moves to spec 4.30.0 (the repo vendored 4.17.1). One
FlightAware account with one key per environment, bought after its written answers; the account
default endpoint is set only when none exists; alert cleanup filters by the environment's target
URL. The budget leases AeroAPI at 4 result sets a second (80 percent of Standard) and reconciles
against `/account/usage` every 15 minutes; budget caps become settable (nothing calls
`configure()` today). The tracker merge path runs when two keys resolve to one `fa_flight_id`.
The provider attribution on the detail screen carries "Contains AeroAPI data (c) FlightAware LLC
[year]" once AeroAPI is live. Until then every environment runs AeroAPI in mock mode.

## 5. Data model changes (migrations 0007 onward)

- `push_tokens`: `app_id` (the bundle or package id, which picks the APNs topic),
  `registered_at` (the 410 guard compares against it; `last_used_at` stays the send time), and
  the permission state; a registration invalidates the other live rows of the same device and
  kind.
- `notification_deliveries`: a unique key per notification and token.
- `provider_calls`: `board` and `route_search` triggers and an `airport_icao` column.
- Per-source retention switches for `flight_events`, R2 timelines and sync snapshots (section 2).
- `POST /v1/devices/current/invalidate`: needs the session, called before `authClient.signOut()`;
  offline, sign-out proceeds and the next online registration re-points the token (upserts are
  keyed by kind and token), and the app retries the invalidation on its next launch.
- `POST /v1/devices` gains the permission state and `app_id`; sends skip devices without
  permission (FCM deprioritises apps that send high-priority messages nobody sees).
- Durable Objects: `FlightTracker` gains the `notify_intent` outbox kind, `cancel_suspect`, and uses
  `notif_dedupe` and `alert_registrations`; `AirportState` gets its bucket tables; `PushAuth` is a
  new class.
- Queues: `push` and `push-dlq` in every environment (runbook step 2); the APNs and FCM secrets in
  `secrets.required`.

## 6. External calls

| Call | When | Price |
| --- | --- | --- |
| APNs `POST /3/device/{token}` (HTTP/2, ES256 JWT) | per iOS target | free |
| FCM `POST /v1/projects/{id}/messages:send` and the OAuth token exchange | per Android target; a token an hour | free |
| AeroAPI `GET /flights/{ident}` (4.30.0) | tracker polls, confirmation re-reads | $0.005 a result set |
| AeroAPI alerts: `POST`, `DELETE /alerts`, `GET`, `PUT /alerts/endpoint`; deliveries to `/v1/webhooks/aeroapi` | per flight from about T-48 h | $0.020 a delivery |
| AeroAPI `GET /account/usage?all_keys=true` | every 15 minutes | free |
| AeroDataBox FIDS `/flights/airports/icao/{code}/{from}/{to}` and the free coverage check | board and route-search misses | 2 units ($0.000495 on Growth) |

## 7. Cost impact

Provider cost per flight once AeroAPI is live: (74 polls + 1 confirmation, conservatively per
flight) x $0.005 + 7 deliveries x $0.020 = **$0.515 list**, plus $0.005 for each delay's settle
re-read (Phase 0 assumed $0.61; staging measures deliveries, since evidence says 5 to 9, not 12).

| Monthly | 1k flights | 10k flights | 100k flights |
| --- | --- | --- | --- |
| AeroAPI invoice, volume bands applied | $515 | $3,083 | $11,060 (Premium for rate from about 35k, with the 4-a-second lease) |
| ADB with AeroAPI live (flights, boards, search; worst case, no cache sharing) | Growth $99 (5 percent) | Growth $99 (63 percent) | Scale $499 (92 percent) |
| ADB while AeroAPI stays mock (about 156 units a flight) | Growth $99 (42 percent) | Scale $499 (43 percent) | no published plan |
| Boards and search on Cloudflare | about $0 | about $0 | about $24 |
| Push (Queues, Workers, `PushAuth`; APNs and FCM are free) | about $0.01 | about $0.15 | about $1.50 |
| Apple $99 a year, Play $25 once, EAS Starter $19 a month | about $29 | about $29 | about $29 plus build overage |
| GitHub Actions: native smoke weekly | inside GitHub Free | inside GitHub Free | inside GitHub Free |

The Actions line is measured: September's six nightly runs used 136 macOS and 616 Linux minutes,
about 22 macOS minutes a run, priced at $0.062 a minute against $0.006 for Linux; nightly would
be about $45 a month, weekly about $6 of the $12 that GitHub Free's 2,000 minutes are worth.
Assumptions to measure: deliveries per flight, 6 board views and 2 route searches per monthly
user, 4 push-worthy events per flight, 1.2 devices per user. `docs/cost-estimate.md` is updated
in the last increment. Option (c) in section 11 would drop the $99 Growth plan but add $276 to
$3,630 a month for AeroAPI boards and search, and move the first lookup to `/schedules` at $0.020.

## 8. Increments, order and critical path

Every increment: an Opus 5.5 builder, two reviewers with different lenses, two skeptics per
serious finding, a fix round and a re-review, all Opus, with a Fable fix round only if serious
findings survive (section 11, decision 11, proposes one Fable reviewer for increment 15). Tests
are part of each increment, as the brief requires.

| # | Increment | Tests (beyond the exit test) | Exit test | Blocked on |
| --- | --- | --- | --- | --- |
| 13 | **Store pipeline.** Widget-extension privacy manifest (a post-order plugin) and a smoke check that every `.app` and `.appex` carries one; watch-version alignment; unsigned device archive and 16 KB page-size checks in the native smoke; `eas.json` image pins, submit profiles, Sentry build settings; runbook store steps | Plugin unit tests on generated projects; smoke checks against planted failures | Code: prebuild and smoke pass. Accounts: EAS production builds pass App Store Connect processing and the Play upload | Code: nothing. Upload: Apple and Play accounts, Expo, production API live for installs |
| 14 | **Push transport.** `PushTransport` (APNs, FCM), `PushAuth`, `push` queue and consumer, per-target retries, dead-token rules, `push_tokens` columns, delivery key, sign-out invalidation, staging smoke workflow | Injected `fetch`: path, headers, payload under 4,096 bytes, collapse id under 64 bytes, every mapped reason, the 410 guard; `PushAuth` never mints within 20 minutes or past 60; the 6-way semaphore; retry delays; the invalidation route | Staging smoke to a Simulator sandbox token | Code: nothing. Smoke: staging deployed, Apple account (sandbox key) |
| 15 | **Notification policy.** Provider-neutral classification (delay, gate, cancellation, diversion rules of section 3), `cancel_suspect`, `notify_intent` through `persist`, the departure-anchored band, target resolution with preferences (per-kind toggles, per-flight mute), `notifications` rows, relevance windows, the event injector | Policy tables (15-minute bands, settle re-read, correction, arrival bands, flap suppression, cancel_suspect never finishing); the lifecycle test extended with `notify_intent` under alarm retries and the confirm path; `notify` redelivery idempotency | In Miniflare: an injected gate change produces one push job, a replay produces none, jitter under the thresholds produces none | Nothing |
| 18 | **Boards and route search.** Starts with R3's test calls (about 40 units: `direction=Both` billing, 204 billing, page-size bounds, lookahead) and a hub bucket measured against the 2 MB value cap; then `AirportState`, KV, the ladder, budget share and caps, coverage check, `GET /v1/airports/{icao}/board`, `GET /v1/flights/search`, board and route-search screens with add-from-board | Coalescing (N concurrent views, one call), ladder and degrade steps, caps, route-search filtering, anonymous airport limit | Boards for KATL, EGLL and KJFK from cache on staging | ADB Growth key; ADB's written End Use confirmation before real users |
| 16 | **Client push.** Permission in context, token and permission registration on launch, foreground and rotation, sign-out invalidation, channels and icon, time-sensitive entitlement, foreground handler, tap routing to the flight; the 24 to 48 hour transport soak | Mobile: permission flow, tap routing, channel creation, re-registration, offline sign-out retry | TestFlight iPhone and internal Android build receive an injected production event (allow-listed tester) and open the flight; nothing after sign-out; the soak's reason counters clean | Production deployed, TestFlight and Play internal, the physical devices |
| 17 | **Live providers.** AeroAPI 4.30.0, live mode per environment, alert accelerators (codes feeding section 3's rules), registration by `fa_flight_id`, silence detection and the A1 fallback, 2-second webhook acknowledgement, the 4-a-second lease, usage reconciliation, settable caps, the merge path, retention switches; the 50-flight ADB alert run for open decision 2 | Adapter contract tests on 4.30.0 fixtures (synthetic); silence detection; lease; redacted DLQ archives after 24 hours | Two weeks on staging: detection latency per cadence band and per source, deliveries per flight, alert silence rate; a person analyses the real payloads | FlightAware's written answers, then the account |
| 19 | **Phase 1 release.** Flight detail progress and remaining time; TN3194 validation cron and the Apple server-to-server handler (Phase 0 debt); cost estimate and architecture from staging data; open decisions; the Phase 1 summary | Unit tests for the progress maths and both Apple paths | The milestone in section 1 on TestFlight and Play internal | 13 to 18 |

**Critical path.** Build order follows the table: 13's code, 14's code with stubbed `fetch`, then
15 and 18, which complete without any account; 13's uploads, 14's staging smoke, 16, 17 and 19
follow as accounts and answers arrive. The path
runs through the Apple organisation (D-U-N-S up to 5 plus 2 business days, then an unpublished
verification time; budget one to two weeks) and FlightAware's answer (2 to 4 weeks) plus 17's
two-week soak. Earliest Phase 1 release: about 6 to 8 weeks from today if the D-U-N-S request and
the FlightAware letter go out this week.

## 9. Verification (end to end)

1. Store: production builds pass App Store Connect processing (no ITMS-91053, no embedded-binary
   version error) and install from TestFlight and the Play internal track.
2. Transport: the staging smoke returns 200 with an `apns-id`; the production smoke reaches the
   TestFlight iPhone; the soak shows no pooling errors; dead tokens are invalidated only on the
   documented responses.
3. Policy: injected events push once per rule, never twice on a redelivery, never below the
   thresholds; a polled cancellation never finishes a tracker without confirmation.
4. Client: the injected production event arrives, collapses a superseded one and opens the flight;
   sign-out stops delivery; rotation re-registers.
5. Providers: detection latency per band and per source, deliveries per flight and alert silence
   rate replace the assumptions in `docs/cost-estimate.md`.
6. Boards: cache hit rate, provider calls per bucket, payload size, airports kept live.

## 10. What I need from you, by lead time

**Weeks (start this week, in parallel):**

1. The legal entity that sells the app; its D-U-N-S (Apple up to 5 plus 2 business days, Google
   allows up to 30); a public website and a work mailbox on `planeahead.app`. Then the Apple
   Developer Program as that organisation ($99 a year) and a Google Play organisation account
   ($25). Fallback if D-U-N-S lags: enrol Apple as an individual now and convert later (unverified:
   whether conversion keeps the Team ID, App IDs, APNs keys and TestFlight builds; ask Apple).
2. A written letter to FlightAware sales, in this order: (a) whether normalised snapshots,
   per-flight timelines and logbook entries are Derivative Works, and which retention rule
   governs a self-serve Standard account; (b) item 10 permission to use AeroAPI alongside
   AeroDataBox and, from Phase 2, community ADS-B feeds (adsb.lol) and possibly Flightradar24;
   (c) section 4.8 authorisation for AI-assisted development and testing of the integration, for
   feature logging behind a future trained delay model, and for the MCP endpoint and in-app
   questions; (d) the attribution string and brand rules; (e) billing of errors, empty results and
   failed deliveries, whether rate limits are per key or per account.
3. A written question to AeroDataBox: in-app boards for any airport and route search as End Use;
   share pages and MCP; whether its terms restrict processing by AI tools.

**Days:** Cloudflare Workers Paid and the runbook through staging, then production (installs of
the production variant need `api.planeahead.app`); AeroDataBox Growth; Expo Starter; a Firebase
project with the three Android apps and a send-only service account (days if an organisation
policy blocks key creation); two APNs keys (sandbox, production). FlightAware Standard only after
its answer, to avoid an idle $100 minimum.

**Hours:** App IDs, App Group and capabilities (runbook step 12, now with Push and time-sensitive
notifications); the App Store Connect record and an internal TestFlight group; the Play app and
its internal list; a physical iPhone (iOS 26.4 or later) and an Android 13+ device; channel names,
a monochrome notification icon and the permission pre-prompt copy.

## 11. Open decisions (recommendation first)

1. **Provider path under item 10, time-boxed.** (a) Ask FlightAware now and keep Phase 0's split;
   if written permission has not arrived four weeks after the letter, ship Phase 1 on (b)
   AeroDataBox only (cadence B with ADB alerts, measured by 17's 50-flight run), flipping to (a)
   when permission arrives. (c) AeroAPI only does not remove the question once Phase 2 adds ADS-B,
   costs $276 to $3,630 a month more for boards and search, and saves the $99 Growth plan.
   Recommend (a) with the (b) default.
2. **Retention posture:** assume 24 hours and store only derived data until FlightAware answers
   (recommended), or wait for the answer before building 17.
3. **Delay threshold:** 15 minutes, then every 15 more (recommended), or 30 like the airlines.
4. **First gate assignment:** a setting, off by default (recommended), or on.
5. **Cancellation and diversion in Phase 1:** yes, confirmed (recommended).
6. **Time-sensitive:** within an hour of departure for any kind (recommended), or never.
7. **APNs 5xx:** wait Apple's 15 minutes and drop past the relevance window (recommended), or
   retry sooner against Apple's guidance.
8. **If the APNs gate or soak fails:** the Container relay (recommended), FCM for iOS, or Expo's
   push service for plain alerts.
9. **TestFlight audience:** internal testers only in Phase 1 (recommended), or an external group
   with a Beta App Review per version.
10. **Play signing:** accept the hybrid default and register all its fingerprints (recommended), or
    classic; decide before any open or production release.
11. **Fable in the build loop:** one Fable reviewer lens on increment 15, whose outbox and alarm
    semantics are the class Phase 0 gave Fable because mistakes are expensive to unwind
    (recommended); Fable as 15's builder; or Opus only with Fable on escalation.
12. **Native smoke cadence:** weekly (now), or nightly for about $45 a month once a payment method
    covers Actions.

## 12. Model allocation

Opus 5.5 builds, reviews, verifies and fixes every increment; Fable 5.1 runs escalation fix rounds
(pinned with `model: 'fable'`), decision 11's reviewer lens if approved, and red-teamed this plan.
Documentation sweeps run at lower effort. Tokens per increment and model go into
`docs/build-log.md` as in Phase 0.
