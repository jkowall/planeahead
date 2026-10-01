# R1: Push transport from Cloudflare Workers (facts sheet)

Checked 2026-09-30 against primary sources. Repository read-only at `/Users/jkowall/PlaneAhead`, main `3302d39`. Raw copies of the fetched pages were kept outside the repository; every fact carries its URL. Apple documentation pages were read through Apple's JSON data endpoint (`developer.apple.com/tutorials/data/documentation/...json`), which carries the same text as the HTML page and no "last updated" date. GitHub issues were read through the GitHub API.

## 1. Questions answered

1. **Can a Worker's `fetch` talk HTTP/2 to APNs?** In production, very probably yes: Cloudflare's Workers runtime team says the production proxy speaks HTTP/2 to origins, and several 2026 projects ship it; Cloudflare's documentation never says so, and it has not been proven for this account. Locally, never: workerd has no HTTP/2 client on any OS (not only macOS), and nothing is in flight to add one.
2. **APNs token auth:** ES256 JWT with header `alg`, `kid` and claims `iss` (Team ID), `iat`; WebCrypto ECDSA P-256 output is already the JWS R||S format; refresh no more often than every 20 minutes and at least every 60; an `iat` older than one hour gets 403 `ExpiredProviderToken`; a new token more than once per 20 minutes on one connection gets 429 `TooManyProviderTokenUpdates`.
3. **FCM HTTP v1:** RS256 service-account JWT exchanged at `oauth2.googleapis.com/token` for a one-hour access token (scope `firebase.messaging`); one message per `messages:send` call (no batch method in v1); error codes and retry rules verified; 600k messages per minute per project by default; the `token` target is now deprecated in favour of `fid`, with no removal date.
4. **Cloudflare limits that bound fan-out:** 6 connections waiting for response headers per invocation (this is the real throughput bound); 10,000 subrequests per invocation by default; queue consumer CPU 30 s default (up to 5 min) and 15 min wall; `sendBatch` 100 messages or 256 KB; consumer batch up to 100; 250 concurrent consumer invocations; 128 KB messages; 5,000 messages per second per queue; $0.40 per million operations after 1M.
5. **PushSender design:** one shared APNs token per APNs environment and one FCM access token, minted by a singleton Durable Object and cached per isolate; two-stage fan-out through Queues (plan in `notify`, deliver in a new `push` queue, results back through `persist`); at most 6 requests in flight per invocation; dead tokens invalidated from the provider response with Apple's 410 timestamp guard. Push volume is 2 to 3 orders of magnitude below every limit even at 100k flights per month; latency, not throughput, is the design driver.

## 2. Verified facts

All checked 2026-09-30. Quotes are at most 15 words; everything else is paraphrase.

### 2.1 Transport: HTTP/2 from Workers

- **F1. workerd#4841 status.** Opened 2025-08-20 by a user (author association NONE); still open, no labels, no assignee, last updated 2025-08-20; since then only cross-references (latest 2026-09-29). The reporter says `fetch` to APNs fails on macOS under wrangler 4.29.0 and "works correctly when deployed on production Cloudflare Workers". https://github.com/cloudflare/workerd/issues/4841
- **F2. Maintainer statement on #4841 (2025-08-20).** Cloudflare org member `kentonv` (who writes of "us on the Workers Runtime team" in F3's thread): "`workerd` doesn't have HTTP/2 support"; production proxy "(apparently) upgrades to HTTP/2 before talking to the origin"; "there are no active plans to implement this"; suggests a local nginx proxy for testing. The "(apparently)" is his hedge. https://github.com/cloudflare/workerd/issues/4841#issuecomment-3206419952
- **F3. Firmer maintainer statement (2026-03-29).** On workerd#6455 (gRPC), `kentonv`: "our production environment supports speaking HTTP/2 to origin servers", but full duplex is lost in the proxy stack. https://github.com/cloudflare/workerd/issues/6455#issuecomment-4150474480
- **F4. Local HTTP/2 is only a feature request.** workerd#5266 "Local development: Support HTTP/2 for fetch requests" (2025-10-04, label `feature request`, no maintainer reply). https://github.com/cloudflare/workerd/issues/5266
- **F5. Nothing in flight.** Draft PR workerd#7438 (2026-09-19) moves workerd's HTTP stack to hyper under a build flag and describes it as "workerd's HTTP/1.1 client and server"; no HTTP/2. https://github.com/cloudflare/workerd/pull/7438
- **F6. Cloudflare documentation is silent on the outbound protocol.** The Fetch API page (updated 2026-07-05), the Protocols page and the Logs "Worker subrequests" FAQ (updated 2026-04-23) do not name the protocol a Worker subrequest uses. https://developers.cloudflare.com/workers/runtime-apis/fetch/ , https://developers.cloudflare.com/workers/reference/protocols/ , https://developers.cloudflare.com/logs/faq/worker-subrequests/
- **F7. Zone-level "HTTP/2 to Origin" (updated 2026-08-14).** Enabled by default on every plan; negotiated by ALPN, falls back to HTTP/1.1; pooled connections, up to 200 streams on Free/Pro/Business, closed after 900 s idle (a reuse of a closed connection may surface as a 520). The page describes a zone proxying to its own origin and says nothing about Worker subrequests to third-party hosts. https://developers.cloudflare.com/speed/optimization/protocol/http2-to-origin/
- **F8. `node:http2` is a non-functional stub** in Workers (enabled with `nodejs_compat` from compatibility date 2025-09-01), so Node APNs libraries built on `http2` cannot run. `node:tls` is partial. https://developers.cloudflare.com/workers/runtime-apis/nodejs/ (updated 2026-08-12)
- **F9. `connect()` exposes no ALPN option.** `SocketOptions` are `secureTransport` and `allowHalfOpen` only; sockets count toward the 6-connection limit; Cloudflare IP ranges are blocked. A hand-written HTTP/2 client over platform TLS cannot ask for `h2`. https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ (updated 2026-06-19)
- **F10. Local development options.** Service bindings support `remote: true` in local development (the Worker runs locally, the binding reaches the deployed Worker); `wrangler dev --remote` uploads and executes the Worker on Cloudflare's infrastructure but does not support Queues. https://developers.cloudflare.com/workers/local-development/ (2026-08-20), https://developers.cloudflare.com/workers/local-development/bindings-per-env/ (2026-06-25)
- **F11. Anecdotal production evidence (claims, no volume or error metrics).** PRs that send APNs from deployed Workers with `fetch`: CPAllen55/Bilancio-Money#18 (merged 2026-09-11, JWT reused 45 min), zeronsh/zeron#589 (merged 2026-09-28, JWT cached 50 min per isolate), samuelloranger/tether#229 (merged 2026-09-28, replaced a Bun `node:http2` relay with a Worker), kylebjordahl/i-got-that#197 (merged 2026-08-25). Libraries: FiveSheepCo/cloudflare-apns2 (created 2025-01-03, 22 stars, 0 issues), jonesphillip/paje (2026-02-15). Counter-example: cleerox-svg/getrelay#242 (2026-08-15) routed iOS through FCM because the direct path "would be untestable outside production". No public issue mentions `UnrelatedKeyIdInToken` or `TooManyProviderTokenUpdates` with Cloudflare (GitHub search, 2026-09-30). https://github.com/CPAllen55/Bilancio-Money/pull/18 , https://github.com/zeronsh/zeron/pull/589 , https://github.com/samuelloranger/tether/pull/229 , https://github.com/FiveSheepCo/cloudflare-apns2 , https://github.com/cleerox-svg/getrelay/pull/242

### 2.2 Relay alternatives

- **F12. Cloudflare Containers pricing (updated 2026-08-28).** Workers Paid includes 25 GiB-hours memory, 375 vCPU-minutes and 200 GB-hours disk per month, then $0.0000025 per GiB-s, $0.000020 per vCPU-s, $0.00000007 per GB-s; memory and disk bill on provisioned size, CPU on active use; egress $0.025/GB in North America and Europe with 1 TB included; each container also has a Durable Object billed normally. Instance types: lite 1/16 vCPU, 256 MiB, 2 GB; basic 1/4 vCPU, 1 GiB, 4 GB; up to standard-4. https://developers.cloudflare.com/containers/platform/pricing/ , https://developers.cloudflare.com/containers/platform/limits/ (2026-09-30)
- **F13. Containers behaviour.** Cold starts "often be in the 1-3 second range"; the `Container` class sleeps after 10 minutes idle by default; disk is ephemeral; internet egress is allowed by default, and outbound handlers intercept only HTTP on 80 and HTTPS on 443 when configured (`interceptHttps`). Local development needs a Docker-compatible CLI and engine, and `wrangler deploy` from a local Dockerfile needs Docker running (a prebuilt image reference can be pulled instead). https://developers.cloudflare.com/containers/faq/ , https://developers.cloudflare.com/containers/configuration/outbound-traffic/ , https://developers.cloudflare.com/containers/local-dev/ , https://developers.cloudflare.com/containers/get-started/ (all 2026-09-30)
- **F14. FCM can relay Live Activities to iOS** (start from iOS 17.2, update, end) through `apns.live_activity_token`, but every request also needs the app's FCM registration token, which requires the Firebase iOS SDK in the app. https://firebase.google.com/docs/cloud-messaging/customize-messages/live-activity (2026-09-24), https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages (2026-09-08)
- **F15. Server-side import of APNs tokens into FCM is closing.** All Instance ID server APIs, including `iid/v1:batchImport`, were deprecated in September 2026; new users can onboard only before 2027-01-01; requests fail after 2027-09-29; "Creating FCM registrations from APNs tokens on the server side won't be supported." https://firebase.google.com/docs/cloud-messaging/troubleshooting (2026-09-29)
- **F16. Expo Push Service.** `POST https://exp.host/--/api/v2/push/send`, a message or an array of up to 100; limit 600 notifications per second per project; receipts cleared after 24 hours; "does not have an SLA"; optional access-token security; the page does not mention Live Activities. Requires Expo push tokens (`getExpoPushTokenAsync`), not raw tokens. https://docs.expo.dev/push-notifications/sending-notifications/

### 2.3 APNs

- **F17. Connection.** HTTP/2 and TLS 1.2 or later to `api.sandbox.push.apple.com:443` or `api.push.apple.com:443` (port 2197 also accepted); multiple connections allowed to improve performance; do not assume a stream count; with token auth "APNs allows only one stream" until a request with a valid token; PRIORITY frames ignored; `GOAWAY` carries a JSON `reason`. https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
- **F18. Provider token.** JWT header `alg` = `ES256` (only algorithm), `kid` = 10-character Key ID; claims `iss` = 10-character Team ID, `iat` = seconds since epoch, "no more than one hour from the current time"; an `iat` over one hour old is rejected with 403 `ExpiredProviderToken`; "Refresh your token no more than once every 20 minutes"; error "if you use a new token more than once every 20 minutes on the same connection"; "You can use the same token from multiple provider servers." https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
- **F19. Key scoping (new since February 2025).** Team-scoped keys are restricted to Sandbox or Production, maximum two per environment (older both-environment keys still work); topic-specific keys up to 200 per environment with up to 400 topics each. APNs binds a team and its bundle IDs to a connection at the first push; pushing to a newly added bundle ID on that connection errors, and a new topic needs new connections; "APNs doesn't support authentication tokens from multiple developer accounts over a single connection"; a different environment's key or an unrelated key on an established connection errors. https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns , https://developer.apple.com/news/?id=wy4tb0uo (2025-02-17)
- **F20. Signing with WebCrypto.** JWS ES256 is the 64-octet R||S concatenation (RFC 7518 section 3.4); WebCrypto ECDSA `sign()` returns r and s concatenated (IEEE P1363), so no DER conversion is needed; Workers WebCrypto supports ECDSA and RSASSA-PKCS1-v1_5 `sign` and `importKey`. https://www.rfc-editor.org/rfc/rfc7518#section-3.4 , https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/sign , https://developers.cloudflare.com/workers/runtime-apis/web-crypto/ (2026-04-23)
- **F21. Request headers.** `:path` `/3/device/<token>`; `authorization: bearer <jwt>`; `apns-push-type` must match the payload (`alert` recommended on iOS, required on watchOS); `apns-topic` required (bundle ID, suffixed for some push types); `apns-id` optional canonical lowercase UUID, echoed back; `apns-expiration` epoch seconds, `0` = try once and do not store, omitted = storage policy; `apns-priority` 10 (default, immediate), 5 (power-aware), 1; `apns-collapse-id` "must not exceed 64 bytes". APNs may store an undeliverable notification up to 30 days and "stores only one notification per bundle ID" per device. https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
- **F22. Payload size.** 4 KB (4096 bytes) for every non-VoIP notification, 5 KB for VoIP; uncompressed JSON. Broadcast Live Activity payloads allow 5,120 bytes. https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification , https://developer.apple.com/documentation/usernotifications/sending-broadcast-push-notification-requests-to-apns
- **F23. Responses.** 200 with empty body; errors carry JSON `reason`, and `timestamp` (milliseconds) only with 410, the time APNs "confirmed the token was no longer valid for the topic". Status meanings: 400 bad request, 403 certificate or token error, 404 bad path, 405 not POST, 410 token inactive for the topic, 413 payload too large, 429 too many requests for the same device token, 500, 503. Reasons include 400 `BadCollapseId`, `BadDeviceToken` ("Verify ... that the token matches the environment"), `BadExpirationDate`, `BadMessageId`, `BadPriority`, `BadTopic`, `DeviceTokenNotForTopic`, `DuplicateHeaders`, `IdleTimeout`, `InvalidPushType`, `MissingDeviceToken`, `MissingTopic`, `PayloadEmpty`, `TopicDisallowed`; 403 `ExpiredProviderToken`, `Forbidden`, `InvalidProviderToken`, `MissingProviderToken`, `UnrelatedKeyIdInToken` (open a new connection), `BadEnvironmentKeyIdInToken`; 410 `ExpiredToken` (new) and `Unregistered`; 413 `PayloadTooLarge`; 429 `TooManyProviderTokenUpdates` and `TooManyRequests`; 500 `InternalServerError`; 503 `ServiceUnavailable`, `Shutdown`. `apns-unique-id` is returned in the Development environment only. https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns
- **F24. Retry rules.** "After 15 minutes, you can retry" 5xx responses, with back-off; do not retry `BadDeviceToken`, `DeviceTokenNotForTopic`, `Forbidden`, `ExpiredToken`, `Unregistered`, `PayloadTooLarge`; retry `TooManyRequests` with a delay. 4xx errors slow a provider down; APNs disconnects connections with too many errors, sooner for `BadDeviceToken`; "status code 410 isn't considered an error condition". Same source as F23.
- **F25. Connection best practice.** Uncached DNS lookup before each connection; spread bursts across connections; reuse connections "for many hours to days", PING after an hour idle; HPACK: encode `:path` and `authorization` as literals without indexing. Same source as F21.
- **F26. Live Activity pushes (settles a Phase 0 unverified item).** `apns-push-type: liveactivity`; `apns-topic: <bundleID>.push-type.liveactivity`; `apns-priority` 5 or 10; priority 10 counts toward an hourly budget and can be throttled, priority 5 does not count; `NSSupportsLiveActivitiesFrequentUpdates` raises it; payload `aps.timestamp`, `event`, `content-state`, optional `stale-date`, `dismissal-date` (default: visible up to four hours after end). https://developer.apple.com/documentation/activitykit/starting-and-updating-live-activities-with-activitykit-push-notifications
- **F27. Broadcast channels (iOS 18+).** One publish reaches every device subscribed to a channel; Apple names "flight status updates" as a use case; recommends "Most Recent Message Stored" for flight updates (stored up to 8 hours); up to 10,000 channels per app per environment; channel management at `api-manage-broadcast.sandbox.push.apple.com:2195` and `api-manage-broadcast.push.apple.com:2196` over HTTP/2; publishing path `/4/broadcasts/apps/<bundle ID>`. https://developer.apple.com/documentation/usernotifications/setting-up-broadcast-push-notifications , https://developer.apple.com/documentation/usernotifications/sending-channel-management-requests-to-apns
- **F28. Simulator receives sandbox pushes.** iOS 16+ simulators on macOS 13+ Macs with Apple silicon or T2 receive remote notifications from `api.sandbox.push.apple.com`, with tokens unique per simulator and Mac. https://developer.apple.com/documentation/xcode-release-notes/xcode-14-release-notes

### 2.4 FCM HTTP v1

- **F29. Auth scope.** Mint a short-lived OAuth 2.0 access token from a service account and request scope `https://www.googleapis.com/auth/firebase.messaging`; send it as `Authorization: Bearer`. The send method accepts `firebase.messaging` or `cloud-platform`. https://firebase.google.com/docs/cloud-messaging/auth-server (2026-09-28), https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send (2026-09-21)
- **F30. Token exchange.** JWT `alg` must be RS256 (the only algorithm); claims `iss` (service account email), `scope`, `aud` = `https://oauth2.googleapis.com/token`, `exp` at most one hour after `iat`, `iat`; POST `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>` to `https://oauth2.googleapis.com/token`; response example `expires_in: 3600`; reuse the token for that window; `invalid_grant` when `exp` exceeds `iat` by more than 65 minutes or the clock is off. Self-signed JWTs that skip the exchange work only for APIs whose service definition is in the googleapis repository, which holds `google/firebase/fcm/connection` but not the v1 send API. https://developers.google.com/identity/protocols/oauth2/service-account (2026-03-23), https://github.com/googleapis/googleapis/tree/master/google/firebase/fcm
- **F31. Send endpoint.** `POST https://fcm.googleapis.com/v1/projects/{project}/messages:send`, body `{ validate_only, message }`; `validate_only` tests "without actually delivering the message"; response is the `Message` (its `name`). `v1.projects.messages` has one method, `send`: there is no batch method in v1. Firebase's own example request is HTTP/1.1. https://firebase.google.com/docs/reference/fcm/rest (2026-09-08), https://firebase.google.com/docs/cloud-messaging/send/v1-api (2026-09-28)
- **F32. No batching in the SDKs either.** Admin Node 12.3.0 (2024-07-25) added HTTP/2 transport to `sendEach()` and `sendEachForMulticast()`, which issue individual sends; the older `sendAll()` and `sendMulticast()` were removed; multicast takes up to 500 targets per call. https://firebase.google.com/support/release-notes/admin/node , https://firebase.google.com/docs/cloud-messaging/send/admin-sdk (2026-09-24)
- **F33. Android fields.** `android.priority` "normal" or "high" (high is the default for notification messages and wakes the device); `android.ttl` a duration string such as `"3.5s"`, default and maximum 4 weeks, `0` sends immediately; `android.collapse_key`, maximum 4 different keys at a time; `android.notification.tag` replaces a shown notification with the same tag; `android.notification.channel_id` must exist on the device, otherwise the manifest default channel is used; `notification_priority` is ignored from Android 8. `ApnsConfig` defaults: `apns-expiration` 30 days, `apns-priority` 10. https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages (2026-09-08)
- **F34. Target field deprecation.** `token` is marked deprecated ("Use fid instead"; during the transition it also accepts FIDs); Admin Node 14.1.0 (2026-06-24) deprecated `token`; Android `firebase-messaging` 25.1.0 deprecated `getToken`, `deleteToken`, `onNewToken`; both registration styles are "fully co-supported"; no removal date is published. `expo-notifications` still pins `firebase-messaging:25.0.1` on the `sdk-57`, `sdk-58` and `main` branches, so the app's Android tokens are legacy registration tokens. https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages , https://firebase.google.com/support/release-notes/admin/node , https://firebase.google.com/support/release-notes/android , https://firebase.google.com/docs/cloud-messaging/manage-tokens (2026-09-24), https://github.com/expo/expo/blob/sdk-57/packages/expo-notifications/android/build.gradle
- **F35. Error codes (updated 2026-02-03).** `INVALID_ARGUMENT` 400 (bad token, package name, message over 4096 bytes or 2048 for topics, reserved data key, TTL outside 0 to 2,419,200 s); `UNREGISTERED` 404 (remove the token); `SENDER_ID_MISMATCH` 403; `QUOTA_EXCEEDED` 429 (message rate: back off from a 1-minute minimum; device rate; topic rate); `UNAVAILABLE` 503 (honour `Retry-After`, exponential backoff, jitter; problem senders "risk being denylisted"); `INTERNAL` 500 (retry with backoff); `THIRD_PARTY_AUTH_ERROR` 401 (APNs or web push credentials); `UNSPECIFIED_ERROR`. Error bodies carry `details[]`: `google.firebase.fcm.v1.FcmError` with `errorCode` for FCM errors versus `google.rpc.BadRequest` with `fieldViolations` for payload errors. https://firebase.google.com/docs/reference/fcm/rest/v1/ErrorCode , https://firebase.google.com/docs/cloud-messaging/error-codes (2026-09-24)
- **F36. Retry guidance.** Timeout at least 10 s; do not retry 400, 401, 403, 404; 429: wait for `retry-after`, default 60 s; 500: exponential backoff; never retry sooner than 10 s; cap total retry time; ramp from 0 to peak rate over at least 60 s; avoid the two minutes around :00, :15, :30 and :45. https://firebase.google.com/docs/cloud-messaging/scale-fcm (2026-09-24)
- **F37. Quotas.** Default 600k messages per minute per project, counted in messages, per-minute but not clock-aligned; 4xx client errors count (429 excepted); increases up to +25% on request; collapsible messages: burst of 20 per app per device, refill one per 3 minutes; Android per-device limit 240 per minute and 5,000 per hour. https://firebase.google.com/docs/cloud-messaging/throttling-and-quotas (2026-09-24)
- **F38. Registration hygiene.** A registration is stale after a month without contact; Android registrations inactive for 270 days expire; delete on `UNREGISTERED`, or `INVALID_ARGUMENT` when the payload is known to be valid; store a registration timestamp and refresh it regularly (monthly suggested). https://firebase.google.com/docs/cloud-messaging/manage-tokens (2026-09-24)
- **F39. Least-privilege IAM.** Permission `cloudmessaging.messages.create` is in `roles/firebasecloudmessaging.admin`, `roles/cloudmessaging.editor`, `roles/firebase.admin`, owner, editor; a custom role can hold it alone. https://docs.cloud.google.com/iam/docs/roles-permissions/firebasecloudmessaging (2026-09-24)
- **F40. Key creation may be blocked.** Organizations created on or after 2024-05-03 enforce `constraints/iam.managed.disableServiceAccountKeyCreation` by default. https://docs.cloud.google.com/resource-manager/docs/manage-baseline-constraints (2026-09-24)
- **F41. Expo client behaviour.** `getDevicePushTokenAsync()` returns the native FCM or APNs token for direct sending; with expo-notifications, a notification message is shown by the OS when the app is in the background or terminated, while data-only messages are presented by expo-notifications on Android only when `data` carries `title` or `message`. https://docs.expo.dev/push-notifications/sending-notifications-custom/ , https://docs.expo.dev/push-notifications/what-you-need-to-know/

### 2.5 Cloudflare limits and pricing (Workers Paid)

- **F42. Subrequests.** 10,000 per invocation by default, configurable to 10 million with `limits.subrequests` (changelog 2026-02-11); every redirect hop counts; subrequests are not billed. https://developers.cloudflare.com/workers/platform/limits/ (2026-09-05), https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/ , https://developers.cloudflare.com/workers/wrangler/configuration/
- **F43. Simultaneous connections.** "Each Worker invocation can have up to six connections simultaneously waiting for response headers": `fetch`, KV, Cache, R2, Queues `send`/`sendBatch`, `connect()`, outbound WebSockets; once headers arrive the connection no longer counts; a seventh waits; callees reached through a service binding share the caller's limit; Durable Objects have the same limit. https://developers.cloudflare.com/workers/platform/limits/ , https://developers.cloudflare.com/durable-objects/platform/limits/ (2026-06-01)
- **F44. CPU and wall time.** HTTP invocations 30 s CPU default, up to 5 min with `limits.cpu_ms`; queue consumers 30 s default, configurable to 5 min; wall time 15 min for queue consumers, cron triggers and alarm handlers; 128 MB memory per isolate. The pricing page instead says "Max of 15 minutes of CPU time per Cron Trigger or Queue Consumer invocation" (a documentation inconsistency; irrelevant at our CPU use). https://developers.cloudflare.com/queues/platform/limits/ (2026-04-21), https://developers.cloudflare.com/workers/platform/pricing/ (2026-08-28)
- **F45. Queues limits (2026-04-21).** 10,000 queues per account; message 128 KB (1 KB = 1,000 bytes, about 100 bytes of metadata); retries up to 100; consumer batch up to 100 messages; `sendBatch` up to 100 messages "or 256KB in total"; batch wait up to 60 s; 5,000 messages per second per queue, beyond which `send` throws; retention default 4 days, up to 14; backlog 25 GB; 250 concurrent consumer invocations (push-based); `delaySeconds` up to 24 hours. https://developers.cloudflare.com/queues/platform/limits/
- **F46. Queues consumer behaviour.** `max_batch_size` default 10 (1 to 100); `max_batch_timeout` default 5 s (0 to 60); `max_retries` default 3; the whole batch retries unless messages are acknowledged individually; concurrency autoscales on backlog and error rate, but only "after processing an entire batch"; Cloudflare recommends leaving `max_concurrency` unset; `retry()` does not count as a failed invocation; delivery is at-least-once. https://developers.cloudflare.com/queues/configuration/batching-retries/ , https://developers.cloudflare.com/queues/configuration/consumer-concurrency/ , https://developers.cloudflare.com/queues/reference/delivery-guarantees/ (all 2026-04-21)
- **F47. Queues pricing.** 1,000,000 operations per month included, then $0.40 per million; one operation per 64 KB written, read or deleted; usually 3 per message; each retry adds a read; a dead-letter write adds a write. https://developers.cloudflare.com/queues/platform/pricing/ (2026-04-21)
- **F48. Durable Objects.** CPU per request 30 s default, configurable to 5 min; 6 simultaneous outgoing connections; soft limit 1,000 requests per second per object; SQLite 10 GB per object, 2 MB per row, 100 bound parameters per query. Alarms: one at a time per object, at-least-once, up to 6 retries with exponential backoff from 2 s, only the most recent `setAlarm()` retried, 15-minute wall time. Requests $0.15 per million after 1M, alarm invocations included. https://developers.cloudflare.com/durable-objects/platform/limits/ , https://developers.cloudflare.com/durable-objects/api/alarms/ (2026-04-21), https://developers.cloudflare.com/workers/platform/pricing/
- **F49. Workers pricing.** 10M requests per month included then $0.30 per million; 30M CPU-ms included then $0.02 per million CPU-ms. https://developers.cloudflare.com/workers/platform/pricing/
- **F50. Secrets fit.** 128 variables per Worker, 5 KB per variable: a `.p8` key (about 250 bytes) and a service-account JSON (about 2.3 KB) both fit. https://developers.cloudflare.com/workers/platform/limits/
- **F51. Placement does not help consumers.** Smart Placement "only affects the execution of fetch event handlers", not RPC or named entrypoints. https://developers.cloudflare.com/workers/configuration/placement/ (2026-04-23)

## 3. Conflicts with the repository

1. **`docs/plans/phase0-plan.md:42`, `docs/research/phase0-dossier.md:64`, `apps/api/src/queues/notify.ts:9-10`.** All say APNs fails "in local workerd on macOS". workerd has no HTTP/2 client at all (F2), so `wrangler dev`, Miniflare and `@cloudflare/vitest-plugin` fail on every OS, Linux CI included. The same lines state "works in production" as fact; the evidence is two maintainer comments (one hedged) and third-party claims (F2, F3, F11), and Cloudflare's docs are silent (F6).
2. **`docs/research/phase0-dossier.md:439`.** "APNs adapter against a fake HTTP/2 endpoint" cannot run: the adapter executes inside workerd, whose client speaks HTTP/1.1 only. Test the adapter through an injected `fetch` that asserts method, path, headers and body; prove HTTP/2 only in staging.
3. **`apps/api/src/queues/notify.ts:4-6` versus `docs/plans/phase0-plan.md:42`.** The code comment routes plain notifications through "the Expo adapter"; the plan chose `apns-direct` and `fcm-v1` with raw tokens. Pick one. Expo needs Expo push tokens, not the raw tokens `POST /v1/devices` stores (F16).
4. **`packages/db/src/schema/notifications.ts:74-100` and `apps/api/src/routes/devices.ts:49-70`.** No bundle ID or app variant is stored per token. `api.planeahead.app` receives production-environment APNs tokens from both `app.planeahead.mobile` and `app.planeahead.mobile.preview` (`apps/mobile/app.config.ts:22-27`, `:66`, `:73`), and `apns-topic` must match the registering app, so the production sender cannot choose a topic. A wrong guess returns `DeviceTokenNotForTopic`, which APNs counts toward disconnecting the connection (F23, F24).
5. **`apps/api/wrangler.jsonc:130-134` (also `:281-285`, `:426-430`).** The `notify` consumer sets only `max_retries` and a DLQ: default `max_batch_timeout` 5 s adds up to 5 s latency whenever fewer than 10 messages are queued (the normal case), and `max_concurrency` defaults to autoscaling up to 250 although the file's own comment (`:43-45`) caps Postgres-touching consumers for the Neon connection budget.
6. **`apps/api/src/queues/consume.ts:16-20` and `:37-54`.** Retry delays of 2, 4, 8 s are shorter than FCM's 10 s floor and 60 s default for 429 (F36) and Apple's 15-minute guidance for 5xx (F24); the loop awaits messages one at a time, which limits a push consumer to about 1/L sends per second instead of 6/L (F43).
7. **`apps/api/src/routes/devices.ts:121-127`.** `lastUsedAt: now` is written at registration. APNs 410 handling needs the registration time to compare with the 410 `timestamp` (invalidate only if the token was registered before APNs saw it die); if a Phase 1 sender also stamps `last_used_at` on send, that comparison breaks. Define `last_used_at` as registration time or add `registered_at`.
8. **`packages/db/src/schema/notifications.ts:210-221`.** `notification_deliveries` has no unique key on `(notification_id, push_token_id, channel)`, so at-least-once redelivery (F46) creates duplicate rows and gives the sender no idempotency anchor.
9. **`apps/api/src/queues/notify.ts:21-25`.** `NotifyMessage` is per user (`kind`, `userId`, `payload`); the recommended flow is one message per flight event, fanned out by the consumer (a new versioned shape).
10. **`docs/plans/phase0-plan.md:273` and `docs/research/phase0-dossier.md:63`.** "APNs `liveactivity` header requirements" are listed as unverified; F26 now verifies them (resolution, not a defect).
11. **`docs/plans/phase0-plan.md:250`.** A physical device is listed for Phase 1 token tests; the sandbox alert smoke can run on the Simulator (F28). A physical device is still needed for production-environment (TestFlight) pushes and push-to-start.
12. **`apps/api/wrangler.jsonc:203-222`.** `secrets.required` has no APNs or FCM secrets yet (expected for Phase 1): add the `.p8`, its Key ID and the service-account JSON; `APPLE_SIWA_TEAM_ID` can serve as the APNs `iss`.

## 4. Design implications for Phase 1

Each item states the choice and its trade-off.

1. **Keep `apns-direct` over Workers `fetch`, but make it a Phase 1 exit gate.** A manually dispatched staging job sends one alert to a Simulator sandbox token and one to a TestFlight device production token, from the queue-consumer path (the path production uses), and asserts 200 plus `apns-id`. Hide the transport behind `PushTransport` so a relay can replace it without touching fan-out. *Trade-off:* no extra infrastructure, but it relies on undocumented platform behaviour (F3, F6); the relay (item 11) is the insurance.
2. **Testing without HTTP/2.** All local and CI tests stub `fetch` (the repo already injects `fetch` into adapters). For a real end-to-end check during development, bind the notify path to a deployed push-gateway Worker with a `remote: true` service binding, or run `wrangler dev --remote` (F10). *Trade-off:* no fully local end-to-end test; a separate gateway Worker is one more deployable, and callees share the caller's 6-connection budget (F43).
3. **One shared APNs token per APNs environment, minted by a singleton Durable Object.** A new `PushAuth` class (objects `apns:sandbox`, `apns:production`, `fcm`) mints the ES256 JWT at most every 30 minutes and never within 20 minutes of the last mint, persists `minted_at` in SQLite, and serves the exact token string; isolates cache it until the window ends. ECDSA signatures are randomized, so independently minted tokens always differ as strings. *Trade-off:* a sixth DO class, and adding it to `exports` needs a full deploy once; the alternative (per-isolate minting, as the F11 projects do) risks 429 `TooManyProviderTokenUpdates` if Cloudflare multiplexes several isolates onto one APNs connection, which is unknown (U2).
4. **One APNs key per environment for the whole account.** Staging only serves the development variant (sandbox), production serves `.mobile` and `.preview` (production), so staging holds a Sandbox team-scoped key and production a Production team-scoped key; never mix key types on a host (F19). *Trade-off:* a leaked key covers every topic in that environment; topic-specific keys narrow that but multiply keys.
5. **Store the APNs topic per token.** Add `app_id` (bundle ID) to `push_tokens` (or `devices`), sent by the app at registration; derive the Live Activity topic as `<app_id>.push-type.liveactivity`. *Trade-off:* a migration and a client change now, versus `DeviceTokenNotForTopic` errors that can get shared connections dropped.
6. **Two-stage fan-out through Queues.** The FlightTracker alarm writes a `notify_intent` outbox row inside the state-change transaction (guarded by `notif_dedupe`), flushed to `notify` after commit. Stage 1 (`notify`, touches Postgres: `max_batch_size` 10, `max_batch_timeout` 1, `max_concurrency` about 5) resolves targets, inserts `notifications` rows idempotently, renders per locale and platform, and `sendBatch`es `push` jobs of at most 50 targets (about 13 KB each, so at most 18 per `sendBatch` under 256 KB). Stage 2 (`push`, no Postgres: `max_batch_size` 1 to 5, `max_batch_timeout` 0, `max_concurrency` unset) sends. Outcomes go back through `persist`, which stays the only Postgres writer. *Trade-off:* one more queue and hop, versus a Neon-bounded consumer doing slow network I/O and a DB connection held during sends.
7. **Bounded parallelism inside stage 2.** A semaphore of exactly 6 concurrent requests per invocation (F43), 10 s timeout, and `body.cancel()` on unread bodies. *Trade-off:* a little code, for about 6 times the sequential throughput.
8. **Per-target retry, not per-message retry.** Acknowledge each job, re-enqueue only retryable targets with an explicit `delaySeconds`: FCM at least 10 s, 429 honours `Retry-After` or 60 s; APNs `TooManyRequests` 60 s; APNs 5xx per Apple after 15 minutes; drop anything past its `expiresAt`. Add the unique key from conflict 8. *Trade-off:* Apple's 15-minute rule can make a gate alert late; the alternative (retrying sooner) goes against Apple's text. Product decides between late and missing.
9. **Duplicates are tolerated, not prevented.** Queues is at-least-once (F46), so a job may be delivered twice; `apns-collapse-id` and `android.notification.tag` set to `<flightKey>:<kind>` (at most 44 bytes with the 32-character key maximum and `gate_change`, under APNs' 64) make a duplicate replace the first on screen. *Trade-off:* a rare second sound versus a per-target check against the database in the hot path.
10. **Dead-token invalidation.** APNs: `Unregistered` and `ExpiredToken` invalidate only when the token's registration time is at or before the 410 `timestamp`; `BadDeviceToken` and `DeviceTokenNotForTopic` invalidate (never retry on the other environment: that produces another error on a shared connection). FCM: `UNREGISTERED`, `SENDER_ID_MISMATCH`, and `INVALID_ARGUMENT` only when the detail type is `FcmError` rather than `BadRequest`. Keep the 30-day purge of invalidated rows; have the app re-register on every launch so `last_used_at` stays fresh against FCM's 270-day expiry (F38). *Trade-off:* strict rules risk wasted sends; loose rules risk silently dropping a live device.
11. **Payload rules.** Each push carries the full current state (gate and time), because APNs keeps only one pending notification per bundle ID for an offline device (F21); `apns-expiration` and `android.ttl` end at the moment the information stops mattering (departure for a gate change, arrival for a delay); `thread-id` = flight key; priority 10 and `high` for gate and delay; Android `notification` messages on channel `flight-alerts` (created by the app at start-up) so the OS shows them when the app is killed (F41), with `data` for the deep link; stay under 4,096 bytes on both (F22, F35). *Trade-off:* high priority costs battery and, for Live Activities, budget (F26).
12. **Fallbacks, in order, only if item 1 fails or the soak test (U2) shows pooling errors.** (a) Cloudflare Container relay with a real HTTP/2 client: about $1.71 per month always-on at `lite`, 1 to 3 s cold start if allowed to sleep, needs Docker in CI (the owner has no local Docker). (b) FCM for iOS: adds the Firebase iOS SDK and FCM registration on iOS, supports Live Activities (F14). (c) Expo Push Service for alerts only: 600 per second, no SLA, no Live Activities (F16). Importing APNs tokens into FCM server-side is not an option (F15). *Trade-off:* (a) keeps one vendor but adds a runtime; (b) removes HTTP/2 entirely but adds an SDK and Google in the iOS path; (c) is the least work and the least control.
13. **FCM FID migration is a watch item, not Phase 1 work.** The `token` field still works and accepts FIDs; `expo-notifications` still produces legacy tokens (F34). Keep `kind = 'fcm'` and treat the value as opaque. *Trade-off:* none now; a future Expo release will force a migration.
14. **Live Activities later: use broadcast channels for flights.** Apple recommends channels exactly for flight status (F27): one publish per flight update instead of one per device, 10,000 channels per app per environment. Channel management runs on ports 2195 and 2196, and whether Worker `fetch` reaches non-443 ports is unverified (U9). *Trade-off:* iOS 18+ only, and one more APNs surface to prove.

### 4.1 PushSender sketch

```ts
// packages/shared/src/push.ts: versioned contracts (zod in the real code)
export type ApnsEnv = 'sandbox' | 'production';
export interface PushTarget {
  pushTokenId: string;          // push_tokens.id
  kind: 'apns' | 'fcm';
  token: string;                // opaque; FCM value may later be a FID
  env: ApnsEnv;                 // APNs only (push_tokens.environment)
  appId?: string;               // NEW: bundle id of the registering variant, the apns-topic
  registeredAtMs: number;       // registration time, for the APNs 410 guard
  notificationId: string;       // notifications.id of this user's inbox row
}
export interface PushJobV1 {    // one `push` queue message: <= 50 targets, about 13 KB
  v: 1;
  jobId: string;                // uuidv7
  flightKey: string;
  kind: 'gate_change' | 'delay';
  collapseId: string;           // `${flightKey}:${kind}`, <= 64 bytes
  expiresAtS: number;           // relevance end, epoch seconds
  priority: 'high' | 'normal';
  render: { title: string; body: string };   // already localised in stage 1
  data: Record<string, string>; // flightKey, kind; string values only (FCM)
  targets: PushTarget[];
}
export type PushOutcome =
  | { t: 'sent'; providerId: string }                       // apns-id or FCM message name
  | { t: 'dead'; reason: string; apnsTimestampMs?: number } // invalidate the token
  | { t: 'retry'; reason: string; afterS: number }
  | { t: 'error'; reason: string };                         // config or payload bug: alert, no retry

// apps/api/src/do/push-auth.ts: NEW Durable Object, one object per credential
const APNS_WINDOW_MS = 30 * 60_000;   // Apple: refresh between every 20 and every 60 minutes
const APNS_MIN_MINT_GAP_MS = 20 * 60_000;
const FCM_MARGIN_MS = 5 * 60_000;

export class PushAuth extends DurableObject<Env> {
  // idFromName('apns:sandbox' | 'apns:production' | 'fcm'); row persisted in SQLite so a restart
  // never re-mints early.
  async current(name: string): Promise<{ token: string; notAfterMs: number }> {
    const now = Date.now();
    const row = this.load(name);                     // { token, mintedAtMs, notAfterMs } | null
    if (row && now < row.notAfterMs) return row;
    if (name.startsWith('apns:')) {
      if (row && now - row.mintedAtMs < APNS_MIN_MINT_GAP_MS) return row;
      const token = await signJwt(
        { alg: 'ES256', kid: this.env.APNS_KEY_ID },
        { iss: this.env.APPLE_SIWA_TEAM_ID, iat: Math.floor(now / 1000) },
        await this.ecKey(),                          // importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' })
        { name: 'ECDSA', hash: 'SHA-256' },          // output is R||S, what JWS ES256 wants
      );
      return this.save(name, { token, mintedAtMs: now, notAfterMs: now + APNS_WINDOW_MS });
    }
    const sa = JSON.parse(this.env.FCM_SERVICE_ACCOUNT_JSON);
    const iat = Math.floor(now / 1000);
    const assertion = await signJwt(
      { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id },
      { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 },
      await this.rsaKey(sa.private_key),             // importKey('pkcs8', ..., { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' })
      { name: 'RSASSA-PKCS1-v1_5' },
    );
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const { access_token, expires_in } = await res.json<{ access_token: string; expires_in: number }>();
    return this.save(name, { token: access_token, mintedAtMs: now,
                             notAfterMs: now + expires_in * 1000 - FCM_MARGIN_MS });
  }
  // FCM 401 or APNs ExpiredProviderToken: drop notAfter; the 20-minute floor still applies to APNs.
  async expire(name: string): Promise<void> { /* ... */ }
}

// Isolate cache: immutable values with an expiry, never request state.
const authCache = new Map<string, { token: string; notAfterMs: number }>();
async function authToken(env: Env, name: string): Promise<string> {
  const hit = authCache.get(name);
  if (hit && Date.now() < hit.notAfterMs) return hit.token;
  const fresh = await env.PUSH_AUTH.get(env.PUSH_AUTH.idFromName(name)).current(name);
  authCache.set(name, fresh);
  return fresh.token;
}

// Stage 2: the `push` consumer. max_batch_size 1-5, max_batch_timeout 0, max_concurrency unset.
export async function handlePushBatch(batch: MessageBatch<PushJobV1>, { env }: QueueContext) {
  for (const msg of batch.messages) {
    const job = msg.body;
    const limit = semaphore(6);                      // Workers: 6 connections waiting for headers
    const results = await Promise.all(job.targets.map((t) => limit(async () => ({
      t, o: t.kind === 'apns' ? await sendApns(env, job, t) : await sendFcm(env, job, t),
    }))));
    const nowS = Math.floor(Date.now() / 1000);
    const retry = results.filter((r) => r.o.t === 'retry' && nowS + r.o.afterS < job.expiresAtS);
    await env.PERSIST_QUEUE.send({ kind: 'push_results', v: 1, jobId: job.jobId,
                                   results: results.map(compactResult) });   // Postgres writes stay in persist
    if (retry.length > 0) {
      await env.PUSH_QUEUE.send({ ...job, targets: retry.map((r) => r.t) },
        { delaySeconds: Math.max(...retry.map((r) => (r.o as { afterS: number }).afterS)) });
    }
    msg.ack();                                       // never retryAll: that resends the successes
  }
}

async function sendApns(env: Env, job: PushJobV1, t: PushTarget): Promise<PushOutcome> {
  if (!t.appId) return { t: 'error', reason: 'missing_app_id' };
  const host = t.env === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
  const res = await fetch(`https://${host}/3/device/${t.token}`, {
    method: 'POST',
    headers: {
      authorization: `bearer ${await authToken(env, `apns:${t.env}`)}`,
      'apns-topic': t.appId,
      'apns-push-type': 'alert',
      'apns-priority': job.priority === 'high' ? '10' : '5',
      'apns-expiration': String(job.expiresAtS),
      'apns-collapse-id': job.collapseId,
      'apns-id': uuidv4(),                           // canonical lowercase UUID; log it
      'content-type': 'application/json',
    },
    body: JSON.stringify({                           // <= 4096 bytes
      aps: { alert: job.render, sound: 'default', 'thread-id': job.flightKey },
      ...job.data,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const apnsId = res.headers.get('apns-id');
  if (res.status === 200) { await res.body?.cancel(); return { t: 'sent', providerId: apnsId ?? '' }; }
  if (!apnsId) { await res.body?.cancel(); return { t: 'retry', reason: `edge_${res.status}`, afterS: 30 }; } // not an APNs answer
  const { reason, timestamp } = await res.json<{ reason: string; timestamp?: number }>();
  switch (reason) {
    case 'Unregistered': case 'ExpiredToken':          return { t: 'dead', reason, apnsTimestampMs: timestamp };
    case 'BadDeviceToken': case 'DeviceTokenNotForTopic': return { t: 'dead', reason };
    case 'ExpiredProviderToken':                        await expireAuth(env, `apns:${t.env}`);
                                                        return { t: 'retry', reason, afterS: 10 };
    case 'TooManyProviderTokenUpdates':                 return { t: 'retry', reason, afterS: 60 }; // never mint here
    case 'TooManyRequests':                             return { t: 'retry', reason, afterS: 60 };
    case 'InternalServerError': case 'ServiceUnavailable': case 'Shutdown':
                                                        return { t: 'retry', reason, afterS: 900 }; // Apple: after 15 minutes
    default:                                            return { t: 'error', reason }; // InvalidProviderToken, UnrelatedKeyIdInToken, BadTopic, PayloadTooLarge, ...
  }
}

async function sendFcm(env: Env, job: PushJobV1, t: PushTarget): Promise<PushOutcome> {
  const nowS = Math.floor(Date.now() / 1000);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await authToken(env, 'fcm')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: {
      token: t.token,                                // deprecated in favour of `fid`, still accepted
      notification: { title: job.render.title, body: job.render.body },
      data: job.data,
      android: {
        priority: job.priority,                      // "high" | "normal"
        ttl: `${Math.max(0, job.expiresAtS - nowS)}s`,
        notification: { channel_id: 'flight-alerts', tag: job.collapseId },
      },
    } }),
    signal: AbortSignal.timeout(10_000),             // FCM: at least 10 s
  });
  if (res.ok) return { t: 'sent', providerId: (await res.json<{ name: string }>()).name };
  const body = await res.json<FcmErrorBody>().catch(() => null);
  const fcm = body?.error.details?.find((d) => d['@type'].endsWith('google.firebase.fcm.v1.FcmError'));
  const code = fcm?.errorCode;
  const after = retryAfterSeconds(res.headers.get('retry-after'));
  if (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') return { t: 'dead', reason: code };
  if (code === 'INVALID_ARGUMENT')                   return { t: 'dead', reason: code };  // FcmError, not BadRequest
  if (res.status === 401 && code !== 'THIRD_PARTY_AUTH_ERROR') {
    await expireAuth(env, 'fcm');                    // expired or revoked access token
    return { t: 'retry', reason: 'unauthenticated', afterS: 10 };
  }
  if (res.status === 429)                            return { t: 'retry', reason: code ?? 'QUOTA_EXCEEDED', afterS: after ?? 60 };
  if (res.status >= 500)                             return { t: 'retry', reason: code ?? `http_${res.status}`, afterS: Math.max(10, after ?? 10) };
  return { t: 'error', reason: code ?? `http_${res.status}` };  // BadRequest payload errors land here
}

// Persist consumer, kind 'push_results' (the only Postgres writer):
//   INSERT INTO notification_deliveries (...) ON CONFLICT (notification_id, push_token_id, channel) DO UPDATE ...;
//   UPDATE push_tokens SET invalidated_at = now()
//    WHERE id = $1 AND invalidated_at IS NULL
//      AND ($2::bigint IS NULL OR last_used_at <= to_timestamp($2 / 1000.0));  -- APNs 410 guard
```

Stage 1 (`notify` consumer), in outline: select active subscriptions for the flight with their users' preferences and live `apns`/`fcm` tokens (the `push_tokens_user_id_idx` partial index covers the token side); `INSERT ... ON CONFLICT (user_id, dedupe_key)` returning ids of new and existing rows; skip rows that already have a `sent` delivery (a redelivered notify message must not lose or double the batch); apply quiet hours; group by platform and locale; chunk to 50 targets; `sendBatch` in slices of at most 100 messages and 256 KB.

## 5. Cost and throughput

### 5.1 Assumptions (state them, then measure in Phase 1)

| Symbol | Value | Source |
|---|---|---|
| s, subscribers per flight | 1.2 / 1.5 / 2.5 at 1k / 10k / 100k flights per month | plan section 9 |
| d, devices per subscriber | 1.2 | assumption, UNVERIFIED |
| E, push-worthy events per flight (gate assigned or changed, delay updates) | 4 | assumption, UNVERIFIED |
| Month | 30 days = 43,200 minutes | |
| Peak factor | 4x the average minute | plan section 8, itself an assumption |
| L, time to response headers from a consumer to APNs or FCM | 0.10 to 0.25 s | assumption, UNVERIFIED (U4) |
| K, targets per `push` job | 50 | design choice |
| CPU per send | about 1 ms | assumption |

Per-invocation send rate = 6 / L = 6 / 0.25 = **24 per second** to 6 / 0.10 = **60 per second** (F43).

### 5.2 One flight with 500 subscribers

- Targets: 500 x 1.2 = **600** devices.
- Jobs: ceil(600 / 50) = **12**; bytes: 12 x about 13.5 KB = about 162 KB, so one `sendBatch` (limits 100 messages and 256 KB, F45).
- One invocation doing everything: 600 / 60 = **10 s** to 600 / 24 = **25 s** until the last device.
- Twelve invocations in parallel: 50 / 60 = **0.8 s** to 50 / 24 = **2.1 s** each, plus the queue hop. Queues raises concurrency only after a batch finishes (F46), so the real figure sits between 2 s and 25 s until measured (U5).
- Per invocation: 50 subrequests plus 1 or 2 for auth (limit 10,000); CPU about 50 ms (limit 30 s); wall about 2 s (limit 15 min).
- Queue operations: 1 notify message (3) + 12 jobs (36) + up to 12 result messages (36) = at most **75 operations**, $0.00003.
- Provider limits: 600 FCM messages against 600,000 per minute (F37); APNs publishes no rate limit.

### 5.3 Peak minute

Pushes per month P = F x s x d x E:

- 1k: 1,000 x 1.2 x 1.2 x 4 = **5,760**
- 10k: 10,000 x 1.5 x 1.2 x 4 = **72,000**
- 100k: 100,000 x 2.5 x 1.2 x 4 = **1,200,000**

| | 1k flights | 10k flights | 100k flights |
|---|---|---|---|
| Average per minute, P / 43,200 | 0.13 | 1.67 | 27.8 |
| Peak minute at 4x | 0.53 | 6.7 | 111 (1.9 per s) |
| Stress minute: 10% of a day's flights (F / 30 x 0.10) alert at once, x s x d | 3.3 x 1.44 = 4.8 | 33 x 1.8 = 60 | 333 x 3.0 = 1,000 (16.7 per s) |
| Stress plus one 500-subscriber flight | 605 | 660 | 1,600 (26.7 per s) |
| Invocations busy at L = 0.25 s for the worst row | 0.4 | 0.5 | 1.1 |

Headroom at the worst row (1,600 per minute): Queues concurrency 250 x 24 to 60 = 6,000 to 15,000 sends per second; one queue carries 5,000 messages per second (250,000 targets per second at K = 50); FCM 600,000 per minute. The binding constraints are the 6-connection rule per invocation and consumer ramp-up, which set latency; volume is 2 to 3 orders of magnitude below any limit.

### 5.4 Monthly cost of the push path

Events per month = F x E = 4,000 / 40,000 / 400,000. Queue operations per event: notify 3, one push job 3 (flights average 1.4 to 3 devices, so one job per event), one result message 3 = 9.

| Line | 1k | 10k | 100k |
|---|---|---|---|
| Queue operations (events x 9) | 36,000 | 360,000 | 3,600,000 |
| Queue cost at $0.40 per million (the included 1M is already used by `persist` traffic, about 500 operations per flight in `docs/cost-estimate.md`) | $0.01 | $0.14 | $1.44 |
| Worker invocations (about 3 per event) | 12k | 120k | 1.2M, inside 10M included |
| CPU (P x 1 ms + events x 5 ms) | 26k ms | 272k ms | 3.2M ms, inside 30M included |
| `PushAuth` DO requests (at most one per isolate per 30-minute window) | under 10k | under 50k | under 200k, $0.03 at most |
| APNs and FCM fees | $0 | $0 | $0 |
| **Total marginal** | **about $0.01** | **about $0.15** | **about $1.50** |

Token minting: APNs 48 tokens per day per environment (1,440 per month); FCM 24 access tokens per day (720 oauth2 calls per month).

### 5.5 Relay container, only if needed (F12)

- `lite` always on: memory 0.25 GiB x 2,592,000 s = 648,000 GiB-s, minus 90,000 included = 558,000 x $0.0000025 = **$1.40**; disk 2 GB x 2,592,000 s = 5,184,000 GB-s, minus 720,000 included = 4,464,000 x $0.00000007 = **$0.31**; CPU at 100k: 1.2M x 2 ms = 2,400 vCPU-s = 40 vCPU-min, inside 375 included; egress about 2.4 GB, inside 1 TB. Total **about $1.71 per month**, plus its Durable Object's duration.
- `basic` always on: memory 1 x 2,592,000 minus 90,000 = 2,502,000 x $0.0000025 = $6.26; disk 4 x 2,592,000 minus 720,000 = 9,648,000 x $0.00000007 = $0.68; total **about $6.93 per month**.
- Letting it sleep saves most of this but adds a 1 to 3 s cold start (F13) to the first push after 10 idle minutes.

### 5.6 Live Activities (Phase 2 preview)

If each flight showed about 10 visible Live Activity updates: per-device sending at 100k is 100,000 x 2.5 x 1.2 x 10 = 3,000,000 pushes per month; with broadcast channels it is 100,000 x 10 = 1,000,000 publishes, independent of subscribers (F27). Channel count: 3,333 flights per day with channels alive about 12 hours gives 3,333 x 12 / 24 = about 1,700 concurrent channels, under the 10,000 per app per environment limit.

## 6. UNVERIFIED items and how to settle each

- **U1. HTTP/2 to APNs from this account in production, from the queue-consumer path.** Settle with the staging smoke in 4.1: a Simulator sandbox token (F28) and a TestFlight device production token; pass = 200 with `apns-id`; also record `apns-unique-id` (sandbox) and latency.
- **U2. How Cloudflare pools origin connections for Worker subrequests** (per zone, per account, per machine, or shared across customers). This decides whether `UnrelatedKeyIdInToken` (another customer's key on a shared connection) or `TooManyProviderTokenUpdates` (several isolates' tokens on one connection) can occur. Settle with a 24 to 48 hour staging soak that counts 403 and 429 reasons, a deliberate canary that mints two tokens 1 minute apart from two isolates, and a question to Cloudflare support.
- **U3. Whether the zone's "HTTP/2 to Origin" toggle governs Worker subrequests to third-party hosts** (F7). Keep it on for `planeahead.app`; ask Cloudflare support.
- **U4. Latency L to APNs and FCM from consumer locations**, and where consumers run (Queues docs are silent; Smart Placement does not apply, F51). Settle by logging send durations in staging per environment.
- **U5. Consumer ramp-up speed** for a burst of 12 to 120 jobs. Settle with an FCM `validate_only: true` load test (F31), which exercises the full path without delivering; APNs has no dry run, so test it with a handful of Simulator tokens at low rate (per-device 429 threshold unknown).
- **U6. Whether APNs detects a "new token" by string or by `iat`.** Not observable directly; the shared-token design makes it moot.
- **U7. How Cloudflare's proxy applies HPACK** to `authorization` and `:path`, against Apple's guidance (F25). Not observable; watch for edge 52x responses without `apns-id` in the soak.
- **U8. The `.p8` is PKCS#8 importable with WebCrypto `pkcs8`.** Apple only says ".p8 text file"; community libraries show a `BEGIN PRIVATE KEY` PEM. Settle with a unit test on the real key in staging (import and sign).
- **U9. Worker `fetch` to non-443 ports** (APNs 2197, broadcast channel management 2195 and 2196). Settle with one staging request before Phase 2 Live Activities.
- **U10. `time-sensitive` interruption level entitlement.** The Apple entitlement page did not load; Apple's enum page confirms the level breaks through Focus. Settle in Xcode capabilities before using it; until then send `active`.
- **U11. Queue consumer CPU ceiling** (limits page 5 min versus pricing page 15 min, F44). Irrelevant at about 50 ms per invocation.
- **U12. Whether queue consumer invocations bill as Worker requests.** Negligible either way; confirm on the first invoice.
- **U13. FCM `token` removal date** (F34). Watch Firebase release notes and Expo's `firebase-messaging` pin.
- **U14. APNs throughput per connection and any account-level cap.** Apple publishes none; monitor 429s.
- **U15. Cloudflare's edge trusting Apple's current APNs certificate chain** (USERTrust root since 2025). The smoke test settles it.
- **U16. A container's direct egress negotiating ALPN `h2` with APNs.** A spike only if the relay is needed.
- **U17. The sizing assumptions** (d = 1.2, E = 4, peak 4x, L). Replace with Phase 1 telemetry.

## 7. Owner actions with lead time

1. **Apple Developer Program (organization) active.** Prerequisite for every APNs step; already an open owner task. Lead time: not re-verified here; start first if not done.
2. **App IDs with Push Notifications on all three variants before the first push** (runbook `docs/runbooks/first-deploy.md` step 12). APNs binds bundle IDs to a connection at first push, and a Worker cannot force new connections (F19). Lead time: minutes, plus EAS profile regeneration.
3. **Two team-scoped APNs keys: one Sandbox (staging Worker), one Production (production Worker).** Download each `.p8` once; record Key IDs and the Team ID; set them as Worker secrets. Lead time: minutes. Maximum two keys per environment (F19), so keep one slot free for rotation.
4. **Firebase project with the three Android packages** (`app.planeahead.mobile`, `.preview`, `.dev`), FCM API (V1) enabled, a dedicated service account holding only `cloudmessaging.messages.create` (F39), and a JSON key. If the Google Cloud project sits under an organization created on or after 2024-05-03, an org admin must exempt it from `iam.managed.disableServiceAccountKeyCreation` first (F40). Lead time: minutes on a no-organization project; days if Spacelift's org administrators are involved. Decide one Firebase project for all variants (simplest) or one per environment (isolation, but a `SENDER_ID_MISMATCH` trap).
5. **Test devices.** The owner's Mac Simulator covers the sandbox smoke (F28); one physical iPhone on TestFlight covers the production path and push-to-start (iOS 17.2+). The Pixel AVD covers Android if it runs a Google Play image (UNVERIFIED for the local AVD). Lead time: a processed TestFlight build.
6. **Product decision on retries versus staleness** (4.8): accept Apple's 15-minute rule for 5xx or drop alerts after their relevance window. Lead time: none; needed before the sender is built.
7. **Cloudflare:** keep "HTTP/2 to Origin" on for `planeahead.app`, and optionally open a support ticket asking how Worker subrequest connections to third-party origins are pooled (U2, U3). Lead time: support response in days.
8. **Google Play Console** for the internal Android track (an Organization account per `docs/open-decisions.md:47`). Outside push transport, but Phase 1 cannot ship Android without it. Lead time: account verification, not re-verified here.
