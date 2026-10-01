# Increment 14 verification: push transport

Branch `inc14-push-transport` (stacked on `inc13-store-pipeline`), 2026-09-30. This file records
what ran on the build machine with its result, how each acceptance item is proven, where the build
departs from the spec and why, the owner's exact steps to prove the staging send, and what stays
unverified until staging, an APNs key and a Firebase project exist. The spec is
[14-push-transport.md](14-push-transport.md); the research behind it is
`docs/research/phase1/R1-push-transport.md` (R1) and `R2-client-push.md` (R2). The increment's
review round (rulings R1 to R12; in this file "R1" alone is the research sheet, and a ruling is
always "ruling R1") changed the push consumer, `PushAuth`, the transport, persist, registration,
the dead letter log and the admin page; what it changed and what ran for it are in
[Review round](#review-round) at the end, and the sections before it are corrected where the round
made them wrong.

The machine: macOS 27.0, Node 24.21.0, pnpm 12.5.1, wrangler 4.135.0, embedded PostgreSQL 18.4.
No Apple, Google, Firebase or Cloudflare account: every APNs, FCM and Google OAuth request in
this increment went to an injected `fetch`. Another agent was compiling Android native code on
the same machine for most of the session (load averages up to 25), which matters for the timings
below.

## What ran here

| Check | Command | Result |
| --- | --- | --- |
| API suite | `pnpm turbo run test --filter=@planeahead/api --force` | passed: 76 files, 919 tests with 1 skipped, over two runs: the full run (18 min 33 s under load) passed 74 files and 917 tests, and the two files that hung on embedded-Postgres connection timeouts under that load (`merge.test.ts`, `secrets-in-logs.test.ts`) passed on their own in 8 s |
| Typecheck and lint | `pnpm turbo run typecheck lint --force --continue --concurrency=2` | passed: 9 of 9 tasks (shared, db, api with its consumer check, mobile, and the root lint), none cached; 16 min 43 s under the load |
| The other suites | `pnpm turbo run test --force --continue --concurrency=2 --filter='!@planeahead/api'` | passed: 4 of 4 tasks, none cached; tools 60, shared 604 (25 files), db 191 (11 files), mobile 625 (35 suites) |
| Formatting and guards | `pnpm prettier --check . && node scripts/toolchain-guard.mjs && node scripts/vitest-exit-guard.mjs && node scripts/mobile-migrations-guard.mjs --base origin/main && actionlint` | passed: Prettier clean; toolchain guard ok; the exit guard ok in both packages (`node scripts/vitest-exit-guard.mjs`); the mobile migrations guard ok (4 migrations, 10 committed files unchanged); actionlint clean |
| Staging dry run | `pnpm exec wrangler deploy --dry-run --env staging` (apps/api) | passed: 3,570.73 KiB, gzip 707.80 KiB; `env.PUSH_AUTH (PushAuth)` and `env.PUSH_QUEUE (planeahead-push-staging)` among the bindings |
| Production dry run | `pnpm exec wrangler deploy --dry-run --env production` (apps/api) | passed: the same size; `env.PUSH_AUTH (PushAuth)` and `env.PUSH_QUEUE (planeahead-push)` |
| Migration | `pnpm exec drizzle-kit generate --name push_transport`, then `drizzle-kit check` and a second `drizzle-kit generate` (packages/db) | `0007_push_transport.sql` and `meta/0007_snapshot.json` written by drizzle-kit, then the header comment and one backfill statement appended to the new file (as 0002 and 0003 did); "Everything's fine"; the second generate has nothing to emit |
| Migration hash | `node scripts/gen-migration-hash.mjs --check` | up to date: 8 migrations, `7314ec41f160...`; `DB_SCHEMA_VERSION` 8 |
| Types | `pnpm --filter @planeahead/api run cf-typegen` | `worker-configuration.d.ts` regenerated: `PUSH_QUEUE`, `PUSH_AUTH: DurableObjectNamespace<PushAuth>`, and the four push secrets required in `ProductionEnv` only |

The whole check in one turbo call (`typecheck lint test`, concurrency 2) was tried first and ran
for 15 minutes under the other agent's Android build (one mobile test file took 911 s) before the
session was stopped; it was then run in the pieces above, the API suite on its own as the task
asked. In an earlier full API run under the same load, eight tests in five files outside this
increment timed out (the lifecycle walk, the ProviderBudget rate and KV tests, a Google sign-in
case, the router invariant, two subscribe cases, and the pool failed to start three runners);
rerun on their own with the load lower, all of them passed (61 tests in the four files other than the lifecycle walk, which passed in the next full run).

## Acceptance, item by item

| Acceptance item | Where it is proven | Result |
| --- | --- | --- |
| Request path and headers per platform, injected `fetch` | `test/unit/push-transport.test.ts`, "APNs request" and "FCM request" | passed: `POST https://api.sandbox.push.apple.com/3/device/{token}` for a sandbox token and `api.push.apple.com` for a production one; exactly `authorization: bearer <jwt>`, `apns-topic` (the target's app id), `apns-push-type: alert`, `apns-priority` 10 or 5, `apns-expiration` (the job's `expiresAt` in seconds), `apns-collapse-id`, `content-type`; FCM `POST .../v1/projects/planeahead-test/messages:send` with `Bearer`, `message.token`, `notification`, flat string `data` (no `body` key, `tag` and `channelId` repeated), `android.priority: high`, `android.ttl`, `android.notification.channel_id` and `tag` |
| Payload under 4,096 bytes | same file, "payload and collapse id bounds" | passed: the schema's worst case (100 and 400 characters that JSON-escape to six bytes each, the longest kind and flight key) stays under 4,096 bytes on both platforms, the whole FCM request body included; a payload over the limit fails `PayloadTooLarge` without a request |
| Collapse id under 64 bytes | same file, and `packages/shared/test/push.test.ts` | passed for every notification kind with the longest flight key the schema admits (48 characters) |
| Every mapped APNs and FCM reason to its outcome | same file, the two `it.each` tables and the cases after them | passed: 30 APNs reasons and 16 FCM answers, plus sent, edge answers without an `apns-id`, timeouts, network errors, credential failures, `Retry-After` in seconds and as a date, FCM's backoff, and the token refresh on APNs `ExpiredProviderToken` and FCM 401 |
| The 410 timestamp guard | transport: the timestamp is carried through; persist: `test/workers/push-persist.test.ts`, "dead tokens" | passed: invalidated when the timestamp is after or equal to `registered_at`, not when it is before (a re-registered token), not without a timestamp |
| The FCM `INVALID_ARGUMENT` detail rule | both files | passed: an `FcmError` detail is `invalid_token` and invalidates; a `BadRequest` detail, both details, or none is `failed` and never invalidates |
| `PushAuth`: the mint window | `test/unit/push-credentials.test.ts` (the rules over six simulated hours) and `test/workers/push-auth.test.ts` (the object over three hours on its test clock) | passed: served for 30 minutes, never re-minted within 20 minutes of the last mint even after a refusal, mints at least 20 minutes apart, no served token older than 30 minutes (so never near 60); concurrent callers share one mint; a restart serves from SQLite instead of minting early |
| `PushAuth`: the signature format | both files | passed: header exactly `{ alg: ES256, kid }`, claims exactly `{ iss, iat }`, a 64-byte R||S signature that verifies with WebCrypto against the key's public half and with `jose` as a standard JWS ES256 |
| `PushAuth`: token caching and the FCM exchange | both files | passed: the RS256 assertion (`iss`, `scope`, `aud`, `iat`, `exp` one hour on) verifies; the form POST to `https://oauth2.googleapis.com/token`; the access token served until five minutes before expiry; a refused account is `credentials_rejected`, anything transient `exchange_unavailable`; the isolate cache asks the object once per window and misses on a rotated key |
| The consumer | `test/workers/push-consumer.test.ts` | passed: six in flight at most (27 requests, peak 6), one acknowledgement per job, only retryable targets re-enqueued in groups by delay (10, 60, 120, 900 s) with the attempt counted, drops past `expiresAt` (before a send, and a 15-minute retry past a 10-minute window), the `not_configured` hold, the 12-hour cap on a long `Retry-After`, an unreadable job acknowledged unlogged, a failed re-enqueue retried whole, a lost outcome message logged |
| Persist: delivery idempotency | `test/workers/push-persist.test.ts` | passed: one row per notification and token, and a redelivered outcome writes no new row version (`xmin` unchanged); the newest attempt wins in any order, `sent` is never undone, every attempt stays in `attempt_log`; a test job keys by its job id with `is_test` |
| Persist: every invalidation rule | same file | passed: APNs `Unregistered` and `ExpiredToken` guarded, `BadDeviceToken` and `DeviceTokenNotForTopic` always, FCM `UNREGISTERED` and `SENDER_ID_MISMATCH` always, `INVALID_ARGUMENT` with `FcmError` only; never for another outcome, never twice, never for an answer about another app id or environment than the row's |
| The devices route | `test/workers/devices.test.ts` (increment 14 cases) | passed: `appId` and `pushPermission` stored; an old client's body without them still 200, with the production app id and no permission; `registered_at` written on every registration; rotation invalidates the device's other live rows of the kind and nothing else; a skipped registration rotates nothing; the invalidation endpoint 401 without a session, invalidates every kind of the caller's installation and nothing of another installation or another user, answers 0 when there is nothing, 400 on a malformed or mismatched install id |
| The migration and the hash | `packages/db/test/push-transport-migration.test.ts`, `schema-contracts.test.ts`, `generated-column.test.ts` | passed: 0000 to 0006 applied, rows written, 0007 applied: existing tokens get the production app id and `registered_at` from their `last_used_at`; the unique key refuses a second delivery row; the checks refuse a bad app id and permission; drizzle-kit has nothing to emit and finds the snapshots consistent |
| The admin action end to end with a stubbed transport | `test/workers/admin-push.test.ts` | passed: the form, then the POST puts one job on the push queue (captured), the real consumer sends it through the real APNs transport with the real `PushAuth` object's token (the stub is the `fetch` beneath the transport, which verifies the bearer JWT against the test key), the real persist consumer records the outcome, and the result page shows `sent` with the `apns-id`; the refusals (another origin, no Access, an unregistered token, production without the allow list); a `DeviceTokenNotForTopic` answer for a hand-typed app id shown and the row left alone, a `BadDeviceToken` for the row's own app id invalidating it; the `not_configured` hold without the APNs secrets |
| Secrets out of logs | `test/workers/secrets-in-logs.test.ts` | passed: the four push secrets are listed in `.dev.vars.example` and `.dev.vars.test`, production's `secrets.required` is `WORKER_SECRET_NAMES` then `PUSH_SECRET_NAMES` and staging's has no push secret; the push flows run inside the capture (both `PushAuth` mints, the consumer on a success and on both refused tokens, persist), and no configured value, key body, bearer token, assertion, access token or device token appears in a line |

## Departures from the spec, and clarifications

- **P8: the test push takes a registered token.** The form looks the token up in `push_tokens` by
  kind and token in every environment, not only in production: the delivery row needs the token's
  id and user id (`subject_id` is required), and the row supplies the APNs environment and the
  registration time the job carries. The app id is optional and defaults to the registered one,
  because every client before increment 16 registered without one (so a development build's row
  says `app.planeahead.mobile` until then); the owner types `app.planeahead.mobile.dev` for the
  staging send. The plan's staging smoke (section 4, "a manually dispatched staging job") is this
  form, as the ruling says.
- **P5: an APNs invalidation also requires the row's own routing.** Every APNs reason that
  invalidates is about the topic and environment the request was sent with, so the UPDATE also
  requires the row's `app_id` and `environment` to be the target's: a hand-typed app id in the test
  form, or a row re-registered with another app id while a job was in flight, cannot kill a live
  token. An APNs 410 without a `timestamp` invalidates nothing (the guard cannot be evaluated).
- **P1: two verdicts without a request.** A non-hex APNs token is `invalid_token` with reason
  `BadDeviceToken` and no request, sparing the connection's error budget (R1 F24), and a payload
  over 4,096 bytes is `failed` `PayloadTooLarge`. Outcomes carry `requested`, so neither counts as
  an attempt.
- **P1: mappings the spec does not name.** APNs `IdleTimeout` and `UnrelatedKeyIdInToken` retry
  after 60 s (both are about the connection, and another connection can take the request; the soak
  counts them); an answer without an `apns-id` is `retry` `edge_{status}` after 60 s; a 5xx with an
  unknown reason gets Apple's 15 minutes; a timeout or network failure retries (APNs 60 s, FCM its
  backoff); FCM 5xx without `Retry-After` backs off from 10 s, doubling to 15 minutes; FCM 401
  (not `THIRD_PARTY_AUTH_ERROR`) drops the access token and retries.
- **P3: two additions.** A changed key (a rotated secret, seen as a fingerprint of the key
  material, over the key's DER bytes since ruling R9) is replaced at once, the one exception to
  "never within 20 minutes": a token signed by a key the Worker no longer holds is useless. And
  the FCM exchange is not repeated within 60 seconds in two cases: after a provider refused the
  access token (FCM 401, `expire`), none within 60 seconds of the last exchange; after an exchange
  that failed (Google's 4xx, 429 or 5xx, or a request that never completed), none within 60
  seconds of the failed exchange's start (so about 50 seconds after a 10-second timeout), the
  object answering the stored failure until then. The first build
  had only the first case: every `current()` after a failed exchange called Google again, which
  ruling R8 corrected. The 20-minute floor also governs `expire`, whose answer (when a new token
  may be minted) sets the retry delay after `ExpiredProviderToken`.
- **P4: the hold and the follow-ups.** `not_configured` targets are re-enqueued unsent every five
  minutes and dropped as `expired` at `expiresAt`, rather than retried as queue messages (which
  would dead-letter every job of an unconfigured environment with an ops alert). A delay is capped
  at 12 hours, under Queues' `delaySeconds` limit. A job's follow-ups leave in one `sendBatch`
  (ruling R2). If it fails, the message is retried whole (its sent targets may be sent twice,
  which the collapse id makes replace the first); if the outcome message fails twice, the job is
  still acknowledged and the loss logged at error level.
- **P5 and P9: two columns.** `notification_deliveries` gains `is_test` (the test marker) and
  `attempt_log` (each attempt's outcome, reason, HTTP status and time), which is where the admin
  page's counts by reason come from; the plain `notification_id` index is replaced by the unique
  key that leads with the same column. No separate outcome table.
- **P6: names and semantics.** The permission field is `pushPermission` (`granted`,
  `provisional`, `denied`, `undetermined`; absent keeps the stored state); `appId` and
  `pushPermission` are ignored without a token rather than refused. Registration no longer writes
  `last_used_at`, which becomes the time of the last accepted send (plan section 5); migration
  0007 backfills `registered_at` from it. Rotation applies to every kind, the push-to-start token
  included (ADR 0008 item 7(b)).
- **P7: the lists.** `PUSH_SECRET_NAMES` in `src/env.ts` holds the four push secrets, required in
  production after `WORKER_SECRET_NAMES` and nowhere else. `PUSH_INJECT_ALLOWED_USER_IDS` is a
  setting (`WORKER_SETTING_NAMES`), set with `wrangler secret put` in production so user ids stay
  out of the repository.
- **The new Durable Object's "migrations entry".** `wrangler.jsonc` declares classes through
  `exports`, which excludes a `migrations` array (its layout rule 1); `PushAuth` got its export,
  its binding in all three environments, its SQLite migration 001 and `SCHEMA_VERSION` 1, which
  `/health`, `DO_FILES` in `scripts/health-smoke.mjs` and the tools test now name.
- **Shared names.** No export of `packages/shared/src/push.ts` starts with the APNs or FCM env-var
  prefixes `SECRET_PATTERNS` flags in a client bundle (the package ships in the app); a test holds
  that.
- **The test push's channel** is `test_push`; the app's channels are increment 16's, and a channel
  the app never created falls back to the manifest default on Android.

Two things the spec did not ask for and this increment did not do: open decision 6 (retire
`apns_live_activity_start` in "the next migration touching `push_tokens`") is left, and noted in
`docs/open-decisions.md`; and the 30-day purge of invalidated `push_tokens` and the 90-day purge of
`notification_deliveries` are not built (docs/schema-review.md section 5): until increment 15 only
test pushes write them, so the purges belong with it.

## The owner's steps to prove the staging send

1. Queues (runbook step 2), before the first deploy of this increment:
   `pnpm exec wrangler queues create planeahead-push-staging` and
   `pnpm exec wrangler queues create planeahead-push-dlq-staging --message-retention-period-secs 1209600`
   from `apps/api`. Deploy staging (merge to `main`); it deploys without any push secret.
2. Access for `/admin` on staging (runbook step 14). `https://api-staging.planeahead.app/admin`
   then shows "Push transport": APNs and FCM "no" with the missing names.
3. An APNs key restricted to Sandbox (runbook step 19), then from `apps/api`:
   `pnpm exec wrangler secret put APNS_KEY_P8 --env staging < AuthKey_<KEYID>.p8` (the file as
   downloaded: real newlines are fine, as are `\n` escapes),
   `printf %s <KEYID> | pnpm exec wrangler secret put APNS_KEY_ID --env staging` and
   `printf %s <TEAMID> | pnpm exec wrangler secret put APNS_TEAM_ID --env staging`. The admin page
   now shows APNs "yes".
4. On the Mac (Apple silicon), the development build on the Simulator, from `apps/mobile`:
   `pnpm prebuild` then `pnpm ios --device "iPhone 17 Pro"`, with `APPLE_TEAM_ID` set if the
   Simulator build does not receive a token unsigned. Sign in (a guest is enough), open Settings >
   Notifications > Allow notifications and allow them. The token is now a `push_tokens` row with
   environment `sandbox`.
5. The token: in the Neon SQL editor on the `staging` branch,
   `select token, app_id, environment, registered_at from push_tokens where kind = 'apns' order by registered_at desc limit 5;`.
6. `https://api-staging.planeahead.app/admin/push/test`: the token, kind APNs (iOS), app id
   `app.planeahead.mobile.dev`, Send. The result page reloads until the consumer reports.
7. Pass: status `sent` with an `apns-id`, attempt 1 `sent`, and the notification "PlaneAhead test
   push" on the Simulator. The result page also shows Apple's `apns-unique-id` beside the
   `apns-id`, the key to this notification in the delivery log of Apple's Push Notifications
   Console (ruling R11). Record the answer here. Anything else is also a finding: the reason (a 403
   names the key or topic problem; `edge_52x` without an `apns-id` is the HTTP/2 question, R1 U1)
   and the admin page's credential row (`apns:sandbox` minted once). On `edge_52x`, first check
   that the zone's "HTTP/2 to Origin" setting is on (Speed > Settings > Protocol Optimization,
   runbook step 19), then open the Cloudflare ticket; whether that setting governs Worker
   subrequests at all is unverified (R1 U3), so finding it on does not settle the question.
8. FCM the same way once the Firebase project exists (step 19): `FCM_SERVICE_ACCOUNT_JSON` from the
   JSON key file, a development build on an Android emulator with Google Play and the
   `google-services.json` of `app.planeahead.mobile.dev`, kind FCM (Android).

Production follows the same path after the first TestFlight install (increment 16), with the
Production key, the service account, and `PUSH_INJECT_ALLOWED_USER_IDS` set to the tester's user
id. Production's `secrets.required` now includes the four push secrets, so the next production
deploy waits for them.

## Unverified

- **APNs over Workers `fetch` (R1 U1).** Every test injects `fetch`; workerd has no HTTP/2 client.
  The staging send above is the proof, and the 24 to 48 hour soak of increment 16 (403 and 429
  reasons, edge answers without an `apns-id`) the proof of pooling (R1 U2); the relay is designed in
  `src/push/transport.ts` and not built.
- **A real `.p8` (R1 U8).** The suite's key has Apple's shape (PKCS#8, the P-256 named curve) and
  imports on workerd; a key Apple issued is imported for the first time by the staging send.
- **FCM for real.** The service-account exchange and the send were checked against the documented
  shapes only; the lower-case `android.priority` and the snake-case `channel_id` are what Google's
  Admin SDK sends, not something this build saw FCM accept.
- **The Simulator token without team signing.** Whether an unsigned development build on the
  Simulator receives a token APNs accepts for the team's key is unverified; signing it with
  `APPLE_TEAM_ID` (increment 13) is the fallback.
- **The six-request bound.** It holds the transport's own `fetch` calls to six per invocation; the
  `PushAuth` RPC before a send and the queue sends after a job are outside the pool (both short),
  and so is the liveness read's Postgres client (ruling R1), which stays open and idle until the
  invocation ends. Cloudflare's limits page counts a `connect()` socket only while it is being
  established; that the platform does so for this socket too is not observed here.
- **Queues' `delaySeconds` ceiling.** R1 F45 reads 24 hours, and so does the Queues JavaScript
  API page for a `sendBatch` entry's `delaySeconds` (an integer from 0 to 86400, read in the review
  round); the consumer caps at 12, which is inside either reading.
- **The admin page under a real Access session,** as in increment 12, including its
  `<meta http-equiv="refresh">` under the page's CSP in a browser.
- **What a sign-out cannot recall (ruling R1).** A push APNs or FCM accepted before the sign-out
  stays with the provider until `apns-expiration` or the FCM `ttl` (the job's `expiresAt`) and can
  still reach a phone that was offline at sign-out; no server check recalls it. Whether the app
  dropping its device token at sign-out stops such a push from displaying is increment 16's to
  verify against Apple's and Google's documentation.
- **The liveness read under load (ruling R1).** Each push invocation reads Postgres once through
  Hyperdrive, and the consumer's `max_concurrency` is still left to autoscale (the configuration
  is unchanged). Many concurrent batches queue on Hyperdrive's pool; a read that fails sends
  nothing and retries after 60 s, so the failure mode is delay, not a wrong send. Worth watching
  when increment 15 produces real jobs, where a cap like persist's may be wanted.
- **A sign-out during a batch (re-review).** The liveness read runs once per batch, so a sign-out
  or a re-point that commits after the read still lets the batch's later sends go out: from the
  read to the batch's last send, seconds usually and about seven minutes at worst (five jobs of
  50 targets, six in flight, a 10-second timeout each). The re-reviewer's probe showed a second
  job of the same batch sent after a sign-out made during the first job's send. Reading per job
  (at most five reads a batch) would cut the window to one job, if increment 15's volumes make it
  matter.
- **An attempt log entry can be overwritten (re-review).** An unsent `liveness_unavailable` retry
  keeps its attempt count, so it writes the same `attempt_log` key (`k:retry`) as the provider
  retry before it and replaces that entry: during a Postgres outage a 429's entry can vanish from
  the soak's counts by reason. `credentials_unavailable` already behaved this way.

## Review round

Two Opus 5.5 reviewers read `f9e5d53`: one through queues, idempotency and data (findings data-1
to data-7), one through push protocol correctness against Apple's and Google's documentation
(proto-1 to proto-5, with two probe tests that reproduced proto-1 and proto-2 in the Workers pool).
Neither found a blocker; data-1 was the one major. The orchestrator accepted every finding, as
rulings R1 to R12, and all of them are applied here. Names: "R1 U3" or "R1 F43" is the research
sheet, as everywhere above; a ruling is always "ruling R1".

Two skeptics then checked data-1. The code-path skeptic found every link of the chain holds (a
queued job carries the token and the user id it was built with, the consumer sent it without
looking at the token's row, and a sign-out, a rotation or an account switch between the job's
creation and a send did not stop that send) and rated it minor at `f9e5d53`, because the only
producer is the admin page's test push with its 10-minute window, and a blocker for increment 15,
which produces real jobs; the fix proceeds either way. Beyond first attempts behind a backlog,
retries and holds, the whole-message retry (`message.retry` after a failed re-enqueue or a job
that threw) sends a job's already sent targets again, and ruling R1's check now runs on those
deliveries too.

Second skeptic (impact): minor at this commit, down from the reviewer's major, and not refuted. The mechanism is real, but the only producer is the admin test push (fixed text, a 10-minute window, allow-listed users in production); a hold needs push secrets that are absent or malformed, which production's required secrets make a staging case in practice; a retry needs a failed send for that token plus a sign-out inside a delay of 10 seconds to about 20 minutes; and what leaks is one alert's title and body on the same phone. It also found that the first attempt was unchecked too, which R1's per-batch read now covers, and that store-and-forward at APNs and FCM and an offline sign-out (the app's invalidate call and its retry on the next launch are increment 16's) leave windows no server-side check can close.

### By ruling

- **Ruling R1 (data-1, major): every send re-reads token liveness.** Finding: the consumer sent
  every target its job named, whatever had happened to the token since the job was built: a
  sign-out (`POST /v1/devices/current/invalidate`), a rotation, or an account switch that moves
  the row to the new user under the same id (`src/routes/devices.ts`, the upsert's `setWhere`).
  Changed: `src/queues/push.ts` validates the batch's jobs, then, before the first provider
  request, reads in one statement through `openDb` the `id` and `user_id` of the rows that are
  not invalidated, for every target the batch could send (not past its window, its platform
  configured; at most 250 ids). A target is sent only when its row came back and its `user_id`
  equals the target's `subjectId`; otherwise it is `failed` with reason `token_inactive`,
  `requested` false, its attempt unchanged, which persist records like any failed delivery and
  which invalidates nothing. If the read throws, nothing in the batch is sent: each target that
  needed it is re-enqueued unsent after 60 s (`retry`, reason `liveness_unavailable`) or dropped
  as `expired` when that would land past its window, and `push_liveness_failed` is logged at
  error level; past-window and held targets are decided as before. The read is the
  `PushConsumerDeps.liveTokens` seam (`readLiveTokens` by default). The query binds the ids with
  drizzle's `inArray` (`id in (...)`), the codebase's form of the ruling's `id = any(...)`: the
  same primary-key lookups. Persist's `last_used_at` UPDATE requires `invalidated_at is null`, and
  the admin form refuses an invalidated row (409, "Register the token again from the app"), so a
  token is only ever dropped for dying after its job was queued. P4's text carries an amendment
  note; the consumer's header, `docs/architecture.md` section 9, the comments in
  `wrangler.jsonc`, the header of `src/routes/devices.ts` and the threat model's section 1.8 say
  what the check guarantees and what it cannot. Proven: `push-consumer.test.ts`, against the real
  database through the real routes: a sign-out between the first send (a 429) and its retry
  leaves the retry unsent, `token_inactive`; an account switch between the two (the second user
  registers the same token from the same installation, the row keeps its id, stays live and
  changes owner) does the same; one read for a batch of three jobs, asked for exactly the two
  sendable ids (not the past-window job's, not the held FCM target's) and answered before the
  first `send`, with both live tokens sent; a read that throws sends nothing, re-enqueues the
  sendable targets after 60 s with their attempts unchanged, drops the one whose window ends
  within 60 s, holds the unconfigured one as before, and logs one error line. `push-persist.test.ts`:
  `token_inactive` is a failed delivery that invalidates nothing. `admin-push.test.ts`: the
  refusal, and the end-to-end test of the admin action, which now runs the real read.
  Departure: the ruling asked for the read's connection to be closed before the first provider
  request, because an invocation has six simultaneous connections and the sends use all six. The
  client is left to Hyperdrive instead, like persist's and housekeeping's. Cloudflare counts a
  `connect()` socket toward the six only while the connection is being established and says a
  Worker may have many connections open as long as no more than six are waiting
  (https://developers.cloudflare.com/workers/platform/limits/, read 2026-09-30); Hyperdrive
  returns the origin connection to its pool when the statement's transaction completes
  (https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/), so no database
  connection is in use while the sends wait; and ending a postgres.js 3.4.9 client on workerd is
  not clean: the first run of these tests, which ended the client before the sends, had five
  "This socket has been closed." unhandled rejections for five reads (the socket polyfill's
  pending read rejects after the connection has dropped the socket's listeners), which fail the
  suite and would be one uncaught error per batch in production. The limit of the fix: a push
  APNs or FCM accepted before a sign-out stays with the provider until `apns-expiration` or the
  FCM `ttl` (the job's `expiresAt`) and can still reach a phone that was offline at sign-out; no
  server-side check can recall it. Ruling R1 closes the window only for pushes the consumer has
  not yet sent (first attempts in the queue, retries, holds). Increment 16 owns the client half:
  at sign-out the app also drops its device token on the device, and whether that stops an
  already-accepted push from displaying is to be verified there against Apple's and Google's
  documentation.
- **Ruling R2 (data-2): one `sendBatch` for a job's follow-ups.** Finding: the follow-ups went out
  one `send` per delay group, so a failure after the first `send` retried the whole message with
  some groups already queued. Changed: every follow-up of a job (each delay group, the holds and
  ruling R1's `liveness_unavailable` included) goes out in one
  `pushQueue.sendBatch([{ body, delaySeconds }, ...])`, and `PushConsumerDeps.pushQueue` is
  `Pick<Queue, 'sendBatch'>`; a throw still retries the message whole. What Cloudflare documents:
  only that the messages of a `sendBatch` whose promise resolves are written to disk; nothing
  about one that throws, neither all-or-nothing nor a partial write
  (https://developers.cloudflare.com/queues/configuration/javascript-apis/; the pages on how Queues
  works, delivery guarantees, and batching, retries and delays say nothing about it either). The
  header says so, and handles a throw as nothing written: a follow-up that was written after all
  is one more send, which the collapse id makes replace the first on screen. Proven:
  `push-consumer.test.ts`: two delay groups make one `sendBatch` call with two entries at 60 and
  900 s; the six-target test's four groups make one call of four; a throwing `sendBatch` retries
  the message, acknowledges nothing, records no outcome, and nothing went out through `send`.
- **Ruling R3 (data-3): a production push without usable credentials is loud.** Finding: a
  production secret that is set but unusable held every job quietly until it expired. Changed: in
  production, a target held as `not_configured` (or dropped for it at its window's end) raises
  the new ops alert `push_not_configured` through `raiseOpsAlert`: one error line with the
  platform and the configuration's problem (secret names, never a value) and one Sentry `fatal`
  event, at most once per platform per batch; `platform` is also a Sentry tag
  (`src/observability/ops-alert.ts`). Staging and local keep the quiet hold. Proven:
  `push-consumer.test.ts`: production with a malformed `APNS_KEY_P8`, three jobs of an APNs and an
  FCM target each: exactly one error line (`push_not_configured`, `apns`, "APNS_KEY_P8 is not a
  PKCS8 PEM") and one alert, the key's value in no line, the three APNs targets held and the three
  FCM targets sent; staging with the same key: no error line, no alert, the same holds.
- **Ruling R4 (data-4): registration locks the device row.** Finding: two registrations of the
  same device with different tokens could each insert their row while each rotation missed the
  other's uncommitted insert, leaving two live rows of the kind. Changed: the registration
  transaction's first statement is `select id from devices where id = $1 for update` (drizzle's
  `.for('update')`). Proven: `devices.test.ts`: two rounds of six concurrent registrations of
  different tokens for one device and kind, each round leaving exactly one live row, one of that
  round's tokens. The embedded Postgres reproduces the race without the lock, but not on every
  run, so the test is evidence for the lock rather than proof of it: with the lock line removed,
  the final version failed in four of six runs (two or three live rows, always after the first
  round), and with the lock it passed every targeted run (three, besides the runs below). A
  version with ten rounds of eight failed four of four runs without the lock, but its 80 requests
  each keep a Postgres connection until the test file's isolate ends, and beside the other files
  it exhausted the shared cluster's connections ("too many clients already"), so it was cut down.
  An earlier cut, four rounds of six, had failed two of three runs without the lock.
- **Ruling R5 (data-5): the dead-letter log never carries a device token.** Finding: when a `push`
  job's archive to R2 failed for good, the dead letter consumer logged the job's body, device
  tokens included. Changed: `src/queues/dlq.ts` logs a `push` body through `loggableBody`, which
  replaces each `targets[].token` with `tokenLength` (and a target that is not an object with
  null); the R2 archive keeps the raw message. Proven: `secrets-in-logs.test.ts`: a dead-lettered
  push job whose archive fails on its last attempt, with a sentinel FCM token and a random APNs
  token: the error line is there with each target's `pushTokenId` and `tokenLength`, and neither
  token is in any captured line.
- **Ruling R6 (data-6): `last_used_at` per token.** Finding: persist stamped every token a message
  sent with the newest `at` of the whole message. Changed: one statement per message,
  `update push_tokens set last_used_at = sends.at from (values ...) as sends(id, at)`, with the
  newer-only condition and ruling R1's `invalidated_at is null`. Proven: `push-persist.test.ts`: two
  tokens sent at 12:01:00 and 12:03:30 in one message get their own times (the report counts two);
  a later message moves neither token's time back, and moves one forward where its send is newer;
  an invalidated row is not stamped.
- **Ruling R7 (data-7): the test result page stops reloading.** Finding: a test job whose outcome
  message was lost left its result page reloading every three seconds for ever. Changed:
  `pushTestResult` reads the job id's UUIDv7 time; once that plus `TEST_PUSH_TTL_MS` has passed
  with no delivery row, the page stops reloading, says the outcome was not recorded and points at
  `push_outcome_send_failed` in the logs. `pushTestSend` mints the id at the instant the window
  starts from, and the page refuses an id that is not a UUIDv7 (no test job has one). Proven:
  `admin-push.test.ts`: a job id nine minutes old reloads; one ten minutes and a second old does
  not, and names `push_outcome_send_failed`; a version 4 UUID is refused.
- **Ruling R8 (proto-1): a failed FCM token exchange is not repeated within 60 seconds.**
  Finding: after a failed exchange, every `current()` went back to Google; the reviewer's probe
  made five requests for five calls at one instant after a 503, a 429 and a 400. Changed:
  `PushAuth.current` answers the failure `mint_failure` holds, without calling Google, until
  `FCM_MIN_EXCHANGE_GAP_MS` after it (`withinFailureGap`, `src/push/credentials.ts`); after the gap
  the next call exchanges again, and a success clears the row. An APNs mint is local and never
  held back. A service account replaced inside that minute is used once it has passed: the failure
  row keeps no fingerprint, and adding one would be a migration. The departures section above is
  corrected. Proven: `push-auth.test.ts`, for a 503, a 429, a 400 `invalid_grant` and a network
  error: five sequential and three concurrent calls at one instant make one request and all answer
  the stored failure; a call a millisecond inside the gap makes none, one at the gap the second;
  once Google answers again, the call after the gap takes a token and the stored failure is gone;
  an APNs mint right after a failed one is not held back. `push-credentials.test.ts`: the gap as a
  rule. The reviewer's probe, rerun after the fix: one request for five calls, so its assertion of
  five now fails, as it should.
- **Ruling R9 (proto-2): fingerprints hash the key, not its text form.** Finding: the credential
  fingerprint hashed the PEM text, so the same key put again with real newlines instead of `\n`
  escapes (both accepted, as the owner's steps say) looked like a rotation and was minted at once
  (the probe: two fingerprints, and `mint` one minute after the last mint, inside Apple's 20
  minutes). Changed: `materialFingerprint` hashes the private key's DER bytes with the key id and
  the team id for APNs, and with the client email and the project id for FCM; a PEM whose body
  does not decode stands in as its normalised text, and its first mint fails as before. Proven:
  `push-credentials.test.ts`: the APNs key with real newlines, `\n` escapes and CRLF gives one
  fingerprint, and `serve` a minute after a mint; another key id, team id or key gives another;
  the service account's key in either form one fingerprint, another client email or project
  another; an undecodable PEM still answers. The probe after the fix: one fingerprint, `serve`.
- **Ruling R10 (proto-3): FCM 429 backs off exponentially.** Finding: a 429 without
  `Retry-After` waited a flat 60 s on every attempt, where Google asks for exponential backoff
  from a one-minute minimum (https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode).
  Changed: `fcmQuotaBackoffSeconds`, `min(900, 60 * 2^n * (1 + 0.2 * r))` seconds rounded to whole
  seconds, `n` the target's sends before this one and `r` uniform in [0, 1) from
  `FcmTransportDeps.random` (`Math.random` by default); the jitter only adds, so the first retry is
  never under 60 s. With `Retry-After` the delay stays `max(10, Retry-After)`, capped at
  `MAX_QUEUE_DELAY_SECONDS` by the consumer. APNs `TooManyRequests` stays 60 s. Proven:
  `push-transport.test.ts`: n = 0 gives 60, 66 and 72 for r = 0, 0.5 and 0.9999; n = 1 gives 120
  and 132; n = 4 is the 900 s cap whatever `r` (n = 3 still shows the jitter, 480 and 575); any n
  and a jitter source out of range stay at the cap; `Retry-After` 120 and 2 give 120 and 10
  whatever n; APNs 429 at a fifth attempt is 60 s. The consumer's existing test still caps a
  30-hour `Retry-After` at 12 hours.
- **Ruling R11 (proto-4): keep Apple's `apns-unique-id`.** Finding: the sandbox's `apns-unique-id`,
  the key to a notification in the Push Notifications Console's delivery log, was dropped.
  Changed: `PushTargetResultV1` gains an optional `apnsUniqueId` (the schema is a `looseObject`, so
  an older consumer keeps it and an older producer's result is still valid); the APNs transport
  reads the header for a sandbox target, whatever the outcome, and cites Apple's page
  (https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns);
  persist stores it as `u` in the attempt's `attempt_log` entry; the result page shows it next to
  the `apns-id`, in the summary and in each attempt's row, with a line saying it is the key to the
  Push Notifications Console's delivery log. Proven: `push-transport.test.ts` (a sandbox 200 and a
  sandbox 400 carry it; a production answer and an FCM answer do not, even with the header);
  `push-persist.test.ts` (`u` stored, absent without an id); `admin-push.test.ts` end to end (a
  sandbox send shows the id and the line, a production send shows neither);
  `packages/shared/test/push.test.ts` (optional and bounded).
- **Ruling R12 (proto-5): the runbook covers HTTP/2 to the origin.** Changed: runbook step 19
  gains two items from R1 (U3 and owner action 7): confirm the zone's "HTTP/2 to Origin" setting is
  on before the staging send, and on `edge_52x` answers without an `apns-id` check that setting
  before opening the Cloudflare ticket, with a note that whether the setting governs Worker
  subrequests is unverified (R1 U3). Step 7 of the owner's steps above says the same. Documents
  only.

### What ran

The same machine as above, lightly loaded this time (load averages 3 to 5), on the worktree of
this commit; every API command from `apps/api`.

| Check | Command | Result |
| --- | --- | --- |
| The reviewer's probes, before the fixes | `pnpm exec vitest run --config <scratch>/vitest.scratch.config.mts` (the protocol reviewer's two probe files in the API's Workers pool, kept outside the repository) | 2 files, 4 tests passed: the probes assert the bugs, so both reproduced (five token requests for five `current()` calls after a 503, a 429 and a 400; two fingerprints for one key, and `mint` a minute after the last mint) |
| The same probes, after | the same command | 2 files, 4 tests failed, as they should: one request for five calls, and one fingerprint with `serve` |
| API typecheck | `pnpm run typecheck` (the migration hash, `tsc -b`, the typed client's consumer check) | passed |
| API lint | `pnpm run lint` | passed: 214 files, no error, no warning |
| Shared package | `pnpm run typecheck`, `pnpm run lint`, `pnpm exec vitest run` (packages/shared) | passed; 25 files, 605 tests (604 before the round) |
| Database package (a schema comment changed) | `pnpm run typecheck`, `pnpm run lint` (packages/db) | passed |
| API tests | `pnpm exec vitest run --reporter=verbose <files>`, in two batches of 17: every file the round changed, and every file under `apps/api/test` that mentions push (not counting an array's `.push(`), persist, devices, admin-push, dlq or secrets-in-logs | passed: 34 files, 557 tests (388 in 36.7 s, 169 in 48.9 s), none skipped or failed, no unhandled error; among them push-transport 76, push-credentials 22, devices 21, push-auth 19, push-consumer 18, push-persist 17, admin-push 12, dlq 6, secrets-in-logs 6 |
| The lock of ruling R4 | the R4 test alone (`-t "concurrent registrations"`), the lock line removed, then restored | without the lock, four of six runs failed; with it, every run passed (three) |
| Migration hash | `node scripts/gen-migration-hash.mjs --check` (repository root) | up to date: 8 migrations, `7314ec41f160...` (no migration in the round) |
| Staging dry run | `pnpm --filter @planeahead/api exec wrangler deploy --dry-run --env staging` (repository root, as CI's `wrangler-dry-run` job) | passed: 3,578.92 KiB, gzip 710.09 KiB; `env.PUSH_AUTH (PushAuth)` and `env.PUSH_QUEUE (planeahead-push-staging)` |
| Production dry run | `pnpm --filter @planeahead/api exec wrangler deploy --dry-run --env production` | passed: the same size; `env.PUSH_AUTH (PushAuth)` and `env.PUSH_QUEUE (planeahead-push)` |
| Formatting | `pnpm exec prettier --check` on every changed file (repository root) | clean: 27 files |

Two runs before these failed, and each changed the round: the first run of the push consumer's
tests ended the liveness read's client before the sends and had five unhandled rejections (ruling
R1's departure), and the first batch with the ten-round R4 test exhausted the cluster's
connections (ruling R4). The whole API suite was not run, by the orchestrator's instruction: the
files above exercise what the round changed, and the one module it touched beyond the push path,
`src/observability/ops-alert.ts`, only gained an event name and a tag key no other caller passes.

### Re-review and close-out

An Opus 5.5 re-reviewer read `f9e5d53..c24d880` in full and fetched the five Cloudflare pages the
rulings cite. It found no blocker and no major: all twelve rulings applied, and ruling R1's
departure (the read's client is not closed before the sends) sound, since the Workers limits page
counts a `connect()` socket toward the six only "while the initial connection is being established
and the server has not yet responded" and Hyperdrive returns the origin connection to its pool when
the transaction completes; were the socket to count for its whole life, the sends would have five
slots instead of six, with no effect on correctness. Its findings and what the close-out did:

- **Minor: three docs overclaimed the sign-out guarantee** (`src/routes/devices.ts`,
  `docs/security/threat-model.md`, `docs/architecture.md`, and the weaker form in the increment's
  R1 note): they said nothing sent after the invalidation commits reaches the phone, but the read
  is once per batch. Reworded to "nothing from a batch whose liveness read starts after the
  invalidation commits", naming the window; recorded under Unverified. The code is as ruled.
- **Nit: ruling R8's minute runs from the failed exchange's start**, not its end (`at_ms` is taken
  before a request that can take 10 s). The header of `src/do/push-auth.ts`, `docs/architecture.md`
  and the P3 departure above now say so.
- **Nit: the one-`sendBatch` rule was checked by message count only.** The consumer's header now
  states Cloudflare's 256 KB cap and why an ordinary job stays far below it.
- **Nit: an unsent retry can overwrite the attempt log entry of the provider retry before it.**
  Recorded under Unverified.
- **Nit: ruling R7 covered only a job with no delivery row.** A row still `queued` after the
  window reloaded every three seconds for ever. Fixed: the result page stops reloading once the
  window has passed whatever the row's state, and says the last retry's outcome was most likely
  not recorded. Proven: `admin-push.test.ts` gains a queued row inside the window (reloads) and
  one past it (does not, and names `push_outcome_send_failed`); with the old condition planted
  back, the new test fails.

The orchestrator's full check of `c24d880`, with the increment 15 builder and the re-reviewer
running tests on the same machine:

| Check | Result |
| --- | --- |
| `pnpm turbo run typecheck lint test --force --continue --concurrency=2` | 13 of 14 tasks passed in 709 s: typecheck and lint everywhere; tools 60, shared 605, db 191, mobile 625 in 35 suites; api 954 passed, 1 skipped and 3 failed in 76 files |
| The three failed API files alone | `flights.refresh` 6 of 6, `flight-tracker.lifecycle` 2 of 2, `provider-budget` 22 of 22: 957 API tests pass with 1 skipped. The three are the timing-sensitive tests increment 13's runs also saw time out under load ("answers 504 refresh_timeout", "walks creation to deleteAll with exactly A2_EXPECTED_POLLS provider calls", "serialises concurrent debits") |
| Prettier, the toolchain, exit and mobile migrations guards, the migration hash, actionlint, shellcheck, both wrangler dry runs | all passed |
