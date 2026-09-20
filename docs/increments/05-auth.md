# Increment 5: auth, envelope encryption, devices

Status: spec (2026-09-19, revised 2026-09-20 against `05-auth.facts.md`). Builder: Fable 5.1. Reviewers: two Opus 5 lenses (security, Better Auth integration correctness) plus orchestrator read. Branch `inc5-auth` based on `inc4-api-bootstrap`.

Read `docs/increments/05-auth.facts.md` first, then section 1 of `03-db-schema.facts.md` (Better Auth's column requirements). Several facts overrode the first draft of this spec; the rules below already incorporate them.

## Goal

Sign-in on the API Worker via Better Auth 1.7.5 (anonymous, magic link, native Google, native Apple, Expo client transport) with a fail-closed configuration, the envelope-encryption module every later secret column uses, device registration, `/v1/me`, the per-email magic-link caps, and the anonymous-to-account merge that re-keys rows and is safe to replay. Sessions live in Postgres via the Drizzle adapter through `withDb`.

Acceptance (Workers tests against the embedded Postgres 18 harness from increment 3, driven through `exports.default.fetch()`): anonymous sign-in creates a user with `is_anonymous = true`; a magic-link request returns 200 whether or not the email exists and writes a hashed token; a 4th request for the same email within an hour still returns 200 but sends nothing and increments `usage_counters`; native Google sign-in verifies `iss`, `aud` (one of three client ids), `exp` and `nonce` against a JWKS served by the test (a token without a nonce is rejected with 400); native Apple sign-in without `rawNonce` is rejected with 400; with a valid nonce and a stubbed Apple token endpoint the refresh token lands in `accounts.refresh_token_enc` with `key_version = 1` and decrypts under the test KEK, and `accounts.access_token`, `refresh_token` and `id_token` stay NULL; upgrading an anonymous user via magic link, native Google or native Apple re-keys `devices`, `push_tokens`, `user_preferences`, `usage_counters`, `flight_subscriptions`, `trips`, `notification_preferences` and `idempotency_keys` to the new user id in one transaction, enqueues a `merge` job on `persist`, and running the merge a second time is a no-op; two different `cf-connecting-ip` values get independent rate-limit buckets and the limiter is provably on; `createAuth` throws on a missing or short `BETTER_AUTH_SECRET`; `POST /v1/devices` upserts on `(user_id, install_id)`; `GET /v1/me` returns the user and preferences; a test asserts no secret value appears in any log line. Account deletion is increment 8.

## Design

### Better Auth factory (fail closed)

`createAuth(env, db)` is built per request (no module-scope instance; a second ESLint rule flags module-scope `betterAuth(`). Import from `better-auth/minimal` if it exposes the same API for the Drizzle adapter (record the bundle-size difference in the build log; fall back to `better-auth` if anything is missing). Config:

- `baseURL` from `API_PUBLIC_URL`; `secret` from `BETTER_AUTH_SECRET`, asserted present and at least 32 characters before `betterAuth()` is called (Better Auth falls back to a public default secret on Workers because it keys production detection on `NODE_ENV`, which Workers never set).
- `database: drizzleAdapter(db, { provider: 'pg', usePlural: true, schema: { users, sessions, accounts, verifications, rateLimits } })`: the five-key subset, never the full schema. `advanced.database.generateId: () => uuidv7()` from `@planeahead/shared`.
- `session: { expiresIn: 30 days, updateAge: 1 day, cookieCache: { enabled: true } }` (compact strategy and 300 s are the defaults; note that revocation lags by up to 300 s).
- `rateLimit: { enabled: true, storage: 'database', customRules: { '/sign-in/magic-link': { window: 60, max: 3 }, '/sign-in/anonymous': { window: 60, max: 5 } } }` and `advanced: { ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] } }`. `enabled: true` is mandatory (it defaults to off on Workers). Database storage is an accepted Phase 0 interim: one read and one write on `rate_limits` per auth request; the `USER_RL` and `PUBLIC_RL` bindings damp abuse in front of it; a Durable Object `customStorage` is the Phase 1 hardening item (record in open-decisions). Increment 3's round-trip test proves `rate_limits.last_request` reads back as a JavaScript number.
- `trustedOrigins`: `planeahead://` and the web origins in every environment, plus `exp://` only when `ENVIRONMENT === 'local'` (the Expo plugin only adds it under `NODE_ENV=development`).
- Plugins: `anonymous({ onLinkAccount, disableDeleteAnonymousUser: true })`, `magicLink({ storeToken: 'hashed', expiresIn: 600, sendMagicLink })`, `expo()` from `@better-auth/expo` (server side), and the PlaneAhead plugin below.
- `socialProviders`: none of the built-in social sign-in paths are used from mobile. Google and Apple native sign-in both go through the PlaneAhead plugin so the anonymous merge and the nonce rule apply uniformly. Web sign-in with Apple (Services ID) is out of scope for Phase 0.
- A before-hook on `/sign-in/social` rejects any body carrying `idToken` with 400, so the built-in ID-token path cannot be reached by accident (it skips the nonce check when the claim is absent and never stores refresh tokens).
- `account.encryptOAuthTokens` stays off: our plugin endpoints never hand provider tokens to Better Auth, so `accounts.access_token`, `refresh_token` and `id_token` are always NULL (tested). The only encrypted store is `refresh_token_enc` under `TOKEN_KEK_V{n}`.
- Mount with `app.all('/api/auth/*', c => auth.handler(c.req.raw))` after the CORS middleware. Block `GET /api/auth/expo-authorization-proxy` at the Hono layer with 404 (the Expo client sets `x-skip-oauth-proxy`; the proxy's own source carries an open-redirect FIXME). Record in the threat model.
- Session read in middleware: `auth.api.getSession({ headers: c.req.raw.headers })`. There is no Expo session header; the Expo client replays the cookie.

### PlaneAhead auth plugin (`src/auth/plugin.ts`)

A Better Auth plugin built with `createAuthEndpoint` so both native flows reuse Better Auth's cookie signing, session creation and the anonymous after-hook (which only fires for paths under `/sign-in`, `/sign-up`, `/callback`, `/magic-link/verify` and a few others):

- `POST /sign-in/apple-native` body `{ identityToken, authorizationCode, rawNonce, fullName? }` (the body key is `identityToken`, never `idToken`, because the Expo client strips the session cookie from any request whose body has an `idToken` key and the anonymous merge needs that cookie). Steps: (1) verify `identityToken` with `jose.jwtVerify` against Apple's JWKS with `algorithms: ['RS256']`, `issuer: 'https://appleid.apple.com'`, `audience` = iOS bundle id, `maxTokenAge: '1h'`, and require `sha256hex(rawNonce) === claims.nonce` (400 `nonce_required` when `rawNonce` is missing, 401 on mismatch); read `email` (may be absent for managed Apple IDs: reject with 400 `email_required` for Phase 0 and log it), `email_verified` and `is_private_email` accepting booleans or the strings `"true"`/`"false"`; (2) exchange `authorizationCode` at `https://appleid.apple.com/auth/token` (form-encoded `client_id` = bundle id, `client_secret`, `code`, `grant_type=authorization_code`, no `redirect_uri`) with an ES256 client secret minted from `APPLE_SIWA_P8` (payload `iss` team id, `sub` bundle id, `aud` `https://appleid.apple.com`, 1 h lifetime, cached per isolate for 55 minutes; the pkcs8 import is unit-tested first); (3) `handleOAuthUserInfo(ctx, { userInfo: { id: sub, email, emailVerified, name }, account: { providerId: 'apple', accountId: sub } })` with no tokens, then `setSessionCookie(ctx, data)`; (4) envelope-encrypt the refresh token and write `accounts.refresh_token_enc` and `refresh_token_key_version` by `(provider_id, account_id)` after the sign-in transaction (the window between 3 and 4 is not atomic: increment 8's deletion treats a NULL `refresh_token_enc` as "nothing to revoke" and logs it); (5) `fullName` is untrusted input: trim, cap at 100 characters, printable characters only, stored only when the user has no name yet. Private relay is detected by the `is_private_email` claim, never by domain (Apple uses three relay domains).
- `POST /sign-in/google-native` body `{ identityToken, rawNonce }`: verify with a PlaneAhead `verifyGoogleIdToken` built on a module-scope `jose.createRemoteJWKSet(new URL(env.GOOGLE_JWKS_URL ?? 'https://www.googleapis.com/oauth2/v3/certs'))` (jose performs no I/O at construction, keeps its own in-memory cache, and must not be put in KV), `algorithms: ['RS256']`, `issuer` in `['https://accounts.google.com', 'accounts.google.com']`, `audience` in the three client ids, and `claims.nonce === rawNonce` required (400 when absent); then the same `handleOAuthUserInfo` and `setSessionCookie` with `providerId: 'google'`, no tokens.
- The mobile app (increment 9) uses `react-native-nitro-google-signin` 2.3.0 (explicit nonce, Credential Manager on Android) and `expo-apple-authentication` (sends `sha256hex(rawNonce)` to Apple and `rawNonce` to the API). Open decision 7 from the plan is resolved this way; the paid Universal Sign In module and `expo-auth-session` are dropped.

### Merge (`src/auth/merge.ts`)

`mergeUsers(db, { from, to })` is an idempotent function: one transaction re-keying `devices`, `push_tokens`, `user_preferences`, `usage_counters`, `flight_subscriptions`, `trips`, `notification_preferences`, `idempotency_keys` (upsert-on-conflict semantics where a unique key already exists for `to`, keeping the newer row), then `{ kind: 'merge', from, to }` on the `persist` queue; running it twice is a no-op. It is called from `anonymous.onLinkAccount({ anonymousUser, newUser, ctx })` for magic link and from both native endpoints after `setSessionCookie` (they resolve the anonymous session from the request cookie themselves, because `onLinkAccount` is an after-hook outside any transaction and may not fire for plugin endpoints; a test asserts the merge runs exactly once per upgrade whichever path triggered it). The anonymous row is deleted by the queue consumer after verifying zero remaining rows (increment 8 wires the consumer; here the enqueue is tested with `getQueueResult`).

Known device-flow gap to verify in increment 9: the magic-link `GET /magic-link/verify` arrives from a browser opened by the deep link, not from the app's fetch, so the SecureStore cookie is not attached and the anonymous merge may not trigger on a real device. The Workers test drives cookies directly and passes regardless; the mobile increment must confirm on device or route verification through the app.

### Envelope encryption (`src/crypto/envelope.ts`, `key-provider.ts`)

`KeyProvider { getKek(version): Promise<CryptoKey>; currentVersion }` with `WorkersSecretKeyProvider` reading `TOKEN_KEK_V{n}` (standard padded base64 of 32 bytes; base64url input throws a clear error, tested), imported once per isolate as a non-extractable AES-KW key through a lazy memo populated on first use inside a handler (documented exception next to the module-scope ESLint rule; never memoise a DEK). Per-user DEK: 32 random bytes generated inside the handler (`crypto.getRandomValues` throws at global scope), imported `extractable: true` for `wrapKey` (AES-KW exports the key first), wrapped `raw` to exactly 40 bytes (asserted), stored in `user_keys (user_id, wrapped_dek, kek_version)`; on read, `unwrapKey` produces `extractable: false`. `encrypt(userId, table, column, rowId, plaintext)` returns `{ ciphertext: iv(12) || ct || tag(16), keyVersion }` with AES-256-GCM and AAD `${table}:${column}:${rowId}`; `decrypt` enforces a 12-byte IV, a minimum length of 28 and the AAD. `rotateKek(userId, toVersion)` re-wraps only. Token hashes use `crypto.subtle.digest('SHA-256')` and comparisons use `crypto.subtle.timingSafeEqual` after a length check (it throws on unequal lengths). No HKDF subkeys. Tests: AAD mismatch fails, wrong key version fails, IV uniqueness across 10k calls, wrong IV length rejected, wrapped length 40, base64url KEK rejected, round trip.

### MailSender (`src/mail/`)

`MailSender { send({ to, subject, text, html }) }` with `ResendSender` (plain `fetch` to `POST https://api.resend.com/emails`, Bearer `RESEND_API_KEY`, `Idempotency-Key: magic-link/{tokenPrefix}`; 403 `validation_error` and the two quota 429s are configuration failures that log at error level and return without retry; `rate_limit_exceeded` retries once after `retry-after`), `CloudflareEmailSender` (interface implementation only, never wired: the service is Beta, Workers Paid only, with no published starting quota), `NoopSender` for tests. Sender `sign-in@planeahead.app`. Per-email caps live in Hono middleware in front of the Better Auth handler for `/api/auth/sign-in/magic-link`: `usage_counters` rows `magic_link:{lower(email)}:hour` and `:day` with caps 3 and 10, always 200 to the caller, the handler not invoked when over cap (Better Auth always writes a verification row and calls `sendMagicLink` otherwise).

### Devices and me

`POST /v1/devices { installId, platform: 'ios'|'android'|'web', osVersion, appVersion, pushTokenKind?, pushToken? }` upserts `devices` and, when a token is present, `push_tokens` (kinds `apns`, `fcm`, `expo`, `apns_live_activity_push_to_start`). `GET /v1/me` returns the user and preferences; `PATCH /v1/me/preferences` validates with the shared schema.

### Auth middleware

Replaces the increment 4 placeholder: resolves the session from `auth.api.getSession`, sets `c.var.user`; `requireUser` and `requireScope('user')` helpers; `principalLimiter` keyed by user id via `USER_RL`.

## Files

```
apps/api/src/auth/{create-auth.ts, plugin.ts, apple-native.ts, apple-client-secret.ts, google-verify.ts, merge.ts}
apps/api/src/crypto/{envelope.ts, key-provider.ts}
apps/api/src/mail/{sender.ts, resend.ts, cloudflare-email.ts, noop.ts}
apps/api/src/routes/{auth.ts, devices.ts, me.ts}
apps/api/src/middleware/{auth.ts (real), magic-link-cap.ts}
apps/api/test/unit/{envelope.test.ts, apple-client-secret.test.ts, google-verify.test.ts, apple-token-verify.test.ts}
apps/api/test/workers/{auth-config.test.ts, auth-anonymous.test.ts, auth-magic-link.test.ts, auth-apple-native.test.ts, auth-google-native.test.ts, merge.test.ts, devices.test.ts, me.test.ts, rate-limit-buckets.test.ts}
docs/security/threat-model.md (first version: auth section, both encryption schemes named, the proxy route block, the non-atomic refresh-token write)
```

## Constraints

- New deps: `better-auth` 1.7.5 exact, `@better-auth/expo` 1.7.5 exact (server plugin), `jose` ^6.2.12. Nothing else on the API. The mobile peers (`expo-secure-store`, `expo-linking`, `expo-network`, `expo-constants`, `expo-web-browser`, `expo-apple-authentication`, `react-native-nitro-google-signin`) belong to increment 9.
- Secrets in tests come from `.dev.vars.test` with generated dummy keys (a dummy ES256 P-256 key for `APPLE_SIWA_P8`, a test KEK); Apple's token endpoint and both JWKS endpoints are served by the test (inject the URLs through env: `APPLE_TOKEN_URL`, `APPLE_JWKS_URL`, `GOOGLE_JWKS_URL`).
- Every route registered in Hono keeps `AppType` exported for the mobile client; the auth sub-app may be excluded from the chained `AppType` because the mobile client uses the Better Auth client for those paths.
- No em dashes. ESM. The ESLint module-scope rule gains `betterAuth(`; the two documented module-scope exceptions (`createRemoteJWKSet`, the KEK memo) carry a comment saying why they are allowed (no I/O at construction, no request-scoped state).

## Owner tasks surfaced by the research (needed before staging sign-in works end to end)

- Register both `planeahead.app` and `send.planeahead.app` (Resend's default Return-Path subdomain) as email sources under Certificates, Identifiers and Profiles > Services > Sign in with Apple for Email Communication; without it every magic link to a Hide My Email address bounces.
- Resend: verify `planeahead.app` (SPF, DKIM, DMARC) and move off the free tier (100 emails per UTC day) before any real beta.
- Apple: Team ID, bundle id, Sign in with Apple key (`.p8`) and key id; Google: three client ids (web, iOS, Android).

## Deferred to increment 8

Account deletion: Apple revoke in `user.deleteUser.beforeDelete` (Better Auth has no built-in revocation), and a decision between `session.freshAge` and `sendDeleteAccountVerification`, because a 30-day session with the 1-day default fresh age makes the plain delete path fail for nearly every real user.
