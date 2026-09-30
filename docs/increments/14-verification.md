# Increment 14 verification: push transport

Branch `inc14-push-transport` (stacked on `inc13-store-pipeline`), 2026-09-30. This file records
what ran on the build machine with its result, how each acceptance item is proven, where the build
departs from the spec and why, the owner's exact steps to prove the staging send, and what stays
unverified until staging, an APNs key and a Firebase project exist. The spec is
[14-push-transport.md](14-push-transport.md); the research behind it is
`docs/research/phase1/R1-push-transport.md` (R1) and `R2-client-push.md` (R2).

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
  material) is replaced at once, the one exception to "never within 20 minutes": a token signed by
  a key the Worker no longer holds is useless. And the FCM exchange is not repeated within 60
  seconds of the last one after a refusal. The 20-minute floor also governs `expire`, whose answer
  (when a new token may be minted) sets the retry delay after `ExpiredProviderToken`.
- **P4: the hold and the follow-ups.** `not_configured` targets are re-enqueued unsent every five
  minutes and dropped as `expired` at `expiresAt`, rather than retried as queue messages (which
  would dead-letter every job of an unconfigured environment with an ops alert). A delay is capped
  at 12 hours, under Queues' `delaySeconds` limit. If the re-enqueue fails, the message is retried
  whole (its sent targets may be sent twice, which the collapse id makes replace the first); if the
  outcome message fails twice, the job is still acknowledged and the loss logged at error level.
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
   push" on the Simulator. Record the answer here. Anything else is also a finding: the reason
   (a 403 names the key or topic problem; `edge_52x` without an `apns-id` is the HTTP/2 question,
   R1 U1) and the admin page's credential row (`apns:sandbox` minted once).
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
  `PushAuth` RPC before a send and the queue sends after a job are outside the pool (both short).
- **Queues' `delaySeconds` ceiling.** R1 F45 reads 24 hours; the consumer caps at 12, which is
  inside either reading.
- **The admin page under a real Access session,** as in increment 12, including its
  `<meta http-equiv="refresh">` under the page's CSP in a browser.
