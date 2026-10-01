# Increment 14: push transport

Status: built (2026-09-30), and the review round's rulings (R1 to R12) applied the same day; what
ran, the departures, the owner's steps to prove the staging send and what stays unverified are in
`docs/increments/14-verification.md` (the rulings' changes in its Review round section). Builder:
Opus 5.5. Reviewers: two Opus 5.5 lenses (push protocol correctness against Apple and Google;
queues, idempotency and data) plus the orchestrator's read. Branch `inc14-push-transport`, stacked
on `inc13-store-pipeline`.

Review round. The two lenses read the first build (findings data-1 to data-7 and proto-1 to
proto-5): no blocker, one major, data-1 (a token signed out, rotated or moved to another user
after its job was queued was still sent, on a first attempt behind a backlog, a retry or a hold).
Every finding was accepted, as rulings R1 to R12: the push consumer reads token liveness once per
batch before its first send (R1, which amends P4 below), a job's follow-ups leave in one
`sendBatch` (R2), a production platform without usable credentials raises an ops alert (R3),
registration locks the device row (R4), the dead letter log carries no device token (R5),
`last_used_at` is written per token (R6), the test result page stops reloading (R7), a failed FCM
token exchange is not repeated within a minute (R8), key fingerprints hash the DER bytes (R9), FCM
429 backs off exponentially (R10), Apple's `apns-unique-id` is kept and shown (R11), and the
runbook covers HTTP/2 to the origin (R12). One departure: ruling R1's liveness read leaves its
client to Hyperdrive instead of ending it before the sends (the verification doc says why).

Read first (the plan and the facts sheets reach `main` with PR #14): `docs/plans/phase1-plan.md` (sections 3 rows Push transport, Push credentials and
Fan-out; section 4 Push path, Payload contract, Transport gate; section 5; section 8 row 14;
section 13 decisions 7 and 8), `docs/research/phase1/R1-push-transport.md` (all of it),
`docs/research/phase1/R2-client-push.md` (facts 36 to 52 on payload shape, conflicts, design items
1, 5 to 11), `apps/api/src/queues/` (`notify.ts`, `persist.ts`, `consume.ts`, `index.ts`),
`apps/api/src/routes/devices.ts`, `apps/api/src/routes/admin.ts`, `apps/api/src/env.ts`
(`WORKER_SECRET_NAMES`, `OPTIONAL_SECRET_NAMES`), `apps/api/wrangler.jsonc`,
`packages/db/src/schema/notifications.ts`, `docs/architecture.md`, `docs/runbooks/first-deploy.md`.

## Goal

A tested path from a `push` job to APNs and FCM and back: credentials, transport, the `push`
queue and its consumer, retries, dead-token handling, delivery records, token registration and
sign-out invalidation. Nothing produces real push jobs yet (increment 15 does); an admin action
sends a test push through the real consumer so the transport can be proven on staging.

## Rulings

- **P1. `PushTransport`.** An interface with two implementations behind injected `fetch`: APNs
  (`POST https://api.push.apple.com/3/device/{token}` or the sandbox host by environment; headers
  `authorization: bearer <jwt>`, `apns-topic` from the token's `app_id`, `apns-push-type: alert`,
  `apns-priority`, `apns-expiration`, `apns-collapse-id` at most 64 bytes; payload at most 4,096
  bytes) and FCM HTTP v1 (`POST https://fcm.googleapis.com/v1/projects/{id}/messages:send` with a
  bearer access token; `message.token`; notification plus flat string `data`; `android.priority`
  `high`; `android.notification.channel_id` and `tag`; `android.ttl`). Every response maps to one
  outcome: `sent` (with the `apns-id` or FCM message name), `retry` (with a delay), `invalid_token`,
  or `failed` (with the reason). The relay of decision 8 is designed in the interface's comment, not
  built.
- **P2. Payload contract (plan section 4).** App data rides in a top-level APNs `body` dictionary
  beside `aps`, never as peers of `aps`; FCM `data` is flat strings with no `body` key and repeats
  `tag` and `channelId`. `aps.thread-id` is the flight key; `apns-collapse-id` and the Android `tag`
  are `{kind}:{flightKey}`. `interruption-level` is `time-sensitive` only when the job says so
  (increment 15 decides; decision 6). Builders take a typed job and are unit-tested for shape and
  size.
- **P3. `PushAuth`.** A new Durable Object class (objects `apns:sandbox`, `apns:production`,
  `fcm`): it mints the APNs ES256 JWT (WebCrypto, P-256 PKCS#8 from the `.p8`, the raw R||S
  signature) at most every 30 minutes and never within 20 minutes of the last mint, persisting
  `minted_at`, and exchanges the FCM service-account RS256 JWT for an access token cached until
  shortly before expiry. Isolates cache the token they were given until its window ends. Tests
  cover the mint window (never within 20 minutes, never older than 60), the signature format and
  the FCM exchange with injected `fetch`.
- **P4. The `push` queue.** `push` and `push-dlq` in every environment (`wrangler.jsonc`,
  `parseQueueName`, runbook step 2). The consumer (no Postgres; `max_batch_size` 5,
  `max_batch_timeout` 0) sends each job's targets with at most 6 requests in flight, a 10-second
  timeout per request and `body.cancel()` on unread bodies; it acknowledges each job and
  re-enqueues only retryable targets with an explicit `delaySeconds` (FCM at least 10 s; FCM 429
  honours `Retry-After`, else 60 s; APNs `TooManyRequests` 60 s; APNs 5xx 15 minutes per Apple),
  dropping a target once past the job's `expiresAt` (decision 7). Outcomes go to `persist` as a new
  message kind, so `persist` stays the only Postgres writer.

  Amended by the review round (ruling R1): "no Postgres" now reads "no Postgres connection in use
  while the sends wait". Before the first provider request of a batch the consumer reads, in one
  statement, the `push_tokens` rows of every target it could send, and sends a target only when
  its row is live and still belongs to the target's subject (else `failed` `token_inactive`); a
  failed read sends nothing and re-enqueues after 60 s. `persist` stays the only writer. The
  limit of that fix: a push APNs or FCM accepted before a sign-out stays with the provider until
  `apns-expiration` or the FCM `ttl` (the job's `expiresAt`) and can still reach a phone that was
  offline at sign-out; no server-side check can recall it. Ruling R1 closes the window for every
  batch whose liveness read starts after the invalidation commits (first attempts in the queue,
  retries, holds); a batch already past its read can still finish its sends, usually within
  seconds and at most about seven minutes (the re-review's probe showed it). Increment 16 owns
  the client half: at sign-out the app also drops its device token on the device, and whether
  that stops an already-accepted push from displaying is to be verified there against Apple's and
  Google's documentation. Ruling R10 replaces the flat 60 s after an FCM 429 without
  `Retry-After` with an exponential backoff from Google's one-minute minimum, with jitter.
- **P5. Dead tokens and deliveries.** `persist` records one `notification_deliveries` row per
  notification and token (the new unique key makes a redelivered outcome a no-op; test pushes carry
  no notification id and record under a test marker) and invalidates tokens: APNs `Unregistered`
  and `ExpiredToken` only when `registered_at` is at or before the 410 `timestamp`;
  `BadDeviceToken` and `DeviceTokenNotForTopic` always; FCM `UNREGISTERED`, `SENDER_ID_MISMATCH`,
  and `INVALID_ARGUMENT` only when the error detail is `FcmError`.
- **P6. Migration and registration.** `push_tokens` gains `app_id` (the bundle or package id),
  `registered_at` and the notification permission state. `POST /v1/devices` accepts `appId` and
  the permission state, writes `registered_at` on every registration, and invalidates the other
  live rows of the same device and kind. New `POST /v1/devices/current/invalidate` needs the
  session, takes the install id, and invalidates every token kind for that installation. The mobile
  client changes come in increment 16; the API accepts old clients (both new fields optional, an
  absent `appId` defaulting to the production bundle id).
- **P7. Secrets.** `APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID` and the FCM service account are
  required in production and optional in staging and local, so staging deploys before the Apple
  account exists; without them the consumer holds its jobs as `not_configured` and the admin page
  says so. Every secret stays out of logs (the existing secrets-in-logs test covers the new names).
- **P8. The staging smoke as an admin action.** Instead of a GitHub workflow, which would need
  Access service tokens and Actions minutes, an Access-protected admin form "Send a test push"
  takes a token, its kind and app id, enqueues one job through the real `push` queue and consumer,
  and shows the outcome (status, `apns-id` or reason). On production it accepts only tokens of user
  ids in `PUSH_INJECT_ALLOWED_USER_IDS`. The plan's staging smoke is this form with a Simulator
  sandbox token; record the deviation from the plan's wording.
- **P9. Admin visibility.** The admin page shows the transport's configuration per environment,
  the last mint times, and counts of outcomes by reason for the last 24 hours (from
  `notification_deliveries` and the push outcome messages), which increment 16's soak reads.

## Acceptance

- Unit tests with injected `fetch`: request path and headers per platform, payload under 4,096
  bytes, collapse id under 64 bytes, every mapped APNs and FCM reason to its outcome, the 410
  timestamp guard, the FCM `INVALID_ARGUMENT` detail rule.
- `PushAuth`: the mint window, the signature format, token caching, the FCM exchange.
- The consumer: at most 6 requests in flight, the retry delays, expiry drops, per-target
  acknowledgement, outcome messages; `persist`: delivery idempotency and every invalidation rule.
- The devices route: new fields, rotation invalidation, the invalidation endpoint needing a
  session, old clients still accepted; the migration generated by drizzle-kit and the hash
  regenerated.
- The admin action end to end in the Workers pool with a stubbed transport.
- The full check and both wrangler dry runs are green. The real staging send is unverified until
  staging and the sandbox key exist; the verification doc gives the exact steps.

## Out of scope

Producing push jobs from flight changes (increment 15), the mobile client (increment 16), the
soak (increment 16), the relay (built only if the soak fails).
