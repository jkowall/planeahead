# PlaneAhead threat model

Status: first version (2026-09-22, increment 5). This document grows one section per increment
that adds an attack surface. Increment 5 adds authentication, the envelope-encryption module and
the account routes; the share-link and MCP sections named in `docs/plans/phase0-plan.md` section
10 arrive with the phases that ship those features. Everything below refers to the code as built
in `apps/api`; where a fact came from research rather than from running code it cites
`docs/increments/05-auth.facts.md`.

## 1. Authentication (increment 5)

### 1.1 What is protected

- The session cookie (`better-auth.session_token`, `__Secure-` prefixed over https), signed by
  `BETTER_AUTH_SECRET`, 30-day lifetime, refreshed daily, with a 300 s compact cookie cache.
- Magic-link tokens: 32 characters, stored HASHED in `verifications` (`storeToken: 'hashed'`),
  10-minute lifetime, single use.
- Apple refresh tokens: the one provider secret PlaneAhead keeps, envelope-encrypted in
  `accounts.refresh_token_enc` (section 2). Nothing else from a provider is stored: the plugin
  endpoints hand Better Auth the profile and the account key only, so `accounts.access_token`,
  `refresh_token` and `id_token` are always NULL (tested in `auth-apple-native.test.ts` and
  `auth-google-native.test.ts`).
- The identity of an anonymous user across the upgrade to a real account (section 1.5).

### 1.2 Fail-closed configuration

Better Auth keys three defaults on `NODE_ENV === 'production'`, which a Worker never sets. Each
is overridden in `src/auth/create-auth.ts` and asserted by `auth-config.test.ts`:

| Default on Workers                               | Consequence if left                                                                    | What the code does                                                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rateLimit.enabled` resolves false               | no per-IP limit on sign-in                                                             | `enabled: true`, `storage: 'database'`, custom rules for `/sign-in/magic-link` (3 per 60 s) and `/sign-in/anonymous` (5 per 60 s); `rate-limit-buckets.test.ts` proves the 429 |
| missing secret falls back to a published default | every cookie forgeable by anyone who reads the source                                  | `assertBetterAuthSecret` throws on missing, blank, short (under 32) or the published value, before `betterAuth()` runs                                                         |
| client IP read from `x-forwarded-for`            | every request in one shared `no-trusted-ip` bucket, which a client can fill on purpose | `advanced.ipAddress.ipAddressHeaders: ['cf-connecting-ip']`                                                                                                                    |

`trustedOrigins` lists `planeahead://`, the two localhost origins and `API_PUBLIC_URL`, plus
`exp://` only when `ENVIRONMENT === 'local'` (the Expo plugin adds it only under
`NODE_ENV=development`). A cookie-bearing POST from any other origin fails Better Auth's CSRF
check.

### 1.3 Routes that exist but must not be reachable

- **`GET /api/auth/expo-authorization-proxy`** is registered by the `expo()` server plugin for
  browser-based OAuth flows PlaneAhead does not use (the Expo client sets `x-skip-oauth-proxy`).
  Its source restricts the redirect to `https:` targets on another origin and carries a FIXME
  about redirecting to unrelated hosts. `src/routes/auth.ts` answers 404 for it ahead of the
  Better Auth handler; `auth-config.test.ts` asserts no `Location` header comes back.
- **`POST /api/auth/sign-in/social` with an `idToken` body.** The built-in ID-token path skips
  the nonce check when the claim is absent and writes the raw ID token into `accounts.id_token`.
  A before-hook rejects any such body with 400 `ID_TOKEN_SIGN_IN_DISABLED` (tested). Native
  Google and Apple sign-in go through PlaneAhead's own endpoints under `/sign-in/*` so the nonce
  is required on both and the anonymous merge applies to both.
- **`POST /api/auth/sign-in/magic-link` beyond the per-address cap** is answered `{ status: true }`
  by `src/middleware/magic-link-cap.ts` without invoking Better Auth (which would otherwise write
  a verification row and send mail on every call). The caps are 3 per hour and 10 per UTC day
  per address, counted in `usage_counters` under a SHA-256 of the lower-cased address, never the
  address itself. The response is the same 200 either way, so neither the cap nor a mail-provider
  outage reveals whether an address has an account.

### 1.4 Nonces and identity tokens

- Apple: `jose.jwtVerify` with `algorithms: ['RS256']` (the live JWKS serves RSA keys; ES256 is
  only the client secret PlaneAhead mints), `issuer` `https://appleid.apple.com`, `audience` the
  bundle id, `maxTokenAge: '1h'`. `rawNonce` is REQUIRED in the body (400 `NONCE_REQUIRED`) and
  the token's `nonce` must equal the lowercase SHA-256 hex of it (401 `NONCE_MISMATCH`, also for
  a token with no nonce claim). The comparison is over SHA-256 digests with
  `crypto.subtle.timingSafeEqual` after a length check (the primitive throws on unequal lengths).
- Google: PlaneAhead's own verifier (`src/auth/google-verify.ts`), RS256, `iss` in the two
  documented forms, `aud` in the three client ids, and the `nonce` claim REQUIRED and compared
  exactly (400 when absent, 401 on mismatch). Better Auth's stock provider was not used because it
  hardcodes the JWKS URL, refetches on every verification and skips the nonce check when the
  claim is absent.
- JWKS resolvers are `createRemoteJWKSet` instances memoised per isolate (`src/auth/jwks.ts`):
  no I/O at construction, jose's own 10-minute cache with a 30 s refetch cooldown. They are never
  put in KV, so a key rotation at the provider is seen by a refetch rather than served stale from
  a shared store.
- The body key for both native endpoints is `identityToken`, never `idToken`: the Expo client
  strips the stored session cookie from any request whose body has an `idToken` key, and the
  anonymous merge needs that cookie.
- `fullName` from Apple never rides in the token. It is attacker-controlled request input:
  trimmed, non-printable characters (controls, format characters, bidi overrides, zero-width
  family) stripped, whitespace collapsed, capped at 100 characters, and stored only when the user
  has no name yet (a returning user cannot rename themselves through a second sign-in).
- Private relay addresses are detected by the `is_private_email` claim, never by domain (Apple
  uses three relay domains and is moving to a fourth).

### 1.5 The anonymous-to-account merge

`mergeUsers` (`src/auth/merge.ts`) moves `devices`, `push_tokens`, `user_preferences`,
`usage_counters`, `flight_subscriptions`, `trips`, `notification_preferences` and
`idempotency_keys` in ONE transaction, revokes the anonymous user's sessions in the same
transaction, marks the anonymous row `status = 'deleting'`, then enqueues `{ kind: 'merge' }` on
the `persist` queue. It is idempotent: the marker on the anonymous row makes a second call a
no-op that enqueues nothing (`merge.test.ts`). It is called from two places for the same
upgrade, because Better Auth's `anonymous.onLinkAccount` is an after-hook outside any
transaction whose firing for plugin endpoints was unverified: the native endpoints resolve the
anonymous session from the request cookie themselves and call it directly, and the after-hook
calls it too. A per-request dedupe makes the second caller a no-op; the two `merge_requested`
log lines (sources `anonymous_hook` and `apple_native` or `google_native`) plus exactly one
`merge_committed` are asserted in the Apple and Google tests, which settles the unverified item:
the hook DOES fire for a plugin endpoint reached over HTTP.

Threats considered:

- **Cookie theft during the upgrade.** The anonymous session is revoked in the merge
  transaction, so a stolen session token stops working the moment its owner upgrades (tested:
  the old token answers 401 afterwards). The signed `session_data` cookie cache
  (`session.cookieCache`, 300 s) is the exception: a request that still carries it is answered
  from it without a database read until it expires, so a stolen pair keeps working for at most
  300 s after revocation. That is the trade the spec makes for one fewer read per request; the
  real client replaces both cookies on upgrade, and `auth-anonymous.test.ts` pins the window.
- **The `?cookie=` redirect.** The Expo server plugin's after-hook appends the raw `Set-Cookie`
  value as a `cookie` query parameter to any non-http redirect it trusts, which would put the
  session cookie into a URL (logs, referrers, the OS's URL history). PlaneAhead avoids the branch
  entirely: the magic-link email links to `GET /api/auth/magic-link/verify?token=...` with NO
  `callbackURL`, the app extracts the token from the universal link and calls verify over its own
  fetch, and with no `callbackURL` Better Auth answers JSON plus `Set-Cookie` instead of a
  redirect (`auth-magic-link.test.ts` asserts the JSON-plus-cookie shape and the absence of a
  `Location` header). Whether the anonymous cookie reaches that request on a real device is
  still an open item for increment 9 (the Workers test attaches it by hand).
- **A crash between the two callers.** Both are safe to replay: the marker is set inside the
  transaction, so a retry sees `already_merged`.
- **A lost queue message.** The rows are moved and the marker is set before the send; if the send
  fails the failure is logged (`merge_enqueue_failed`) and increment 8's housekeeping sweep of
  `status = 'deleting'` anonymous users re-enqueues. The anonymous row itself is deleted only by
  the queue consumer after it verifies nothing points at it any more (increment 8).

### 1.6 The non-atomic refresh-token write

`handleOAuthUserInfo` runs the find-or-create user, link-or-create account and session creation
inside Better Auth's own transaction, which takes no caller-supplied transaction handle. The
Apple refresh token is therefore envelope-encrypted and written to
`accounts.refresh_token_enc` AFTER that transaction commits, in a second statement. A crash in
that window leaves an Apple account with a live session and a NULL `refresh_token_enc`, which
means there is no token to revoke at account deletion. Increment 8's deletion treats NULL as
"nothing to revoke" and logs it at warn level; the user can still delete the account, and Apple
lets them revoke the app's access from their Apple ID settings. The authorization code is
exchanged BEFORE the sign-in transaction (it is single use and valid for five minutes), so a
rejected code never leaves a half-made account.

### 1.7 Logging

No secret value reaches a log line: `secrets-in-logs.test.ts` drives every flow (including the
failure paths that log the most) with the console captured and searches every line for every
configured secret, the PEM body in both newline encodings, the magic-link token, the Apple
refresh token, the identity tokens, the authorization code, the session cookies and the raw
email address. Better Auth's own logger is routed through PlaneAhead's structured logger at
`warn` level and forwards only the message and a thrown error's name and message, never the
request context it also passes.

## 2. Envelope encryption

Two independent key schemes exist on the `accounts` table and both are named here so a rotation
drill covers the right one:

1. **PlaneAhead's envelope** (`src/crypto/envelope.ts`, `src/crypto/key-provider.ts`), the only
   one in use. `TOKEN_KEK_V{n}` Workers Secrets hold 32-byte KEKs as standard padded base64
   (base64url is rejected with a message that says so: `atob` does not accept it and the failure
   would otherwise surface deep inside `importKey`). Each user has one 256-bit DEK, generated
   inside a handler (the CSPRNG throws at global scope on Workers), wrapped with AES-KW under the
   current KEK to exactly 40 bytes (asserted) and stored in `user_keys`. Values are AES-256-GCM
   with a fresh 12-byte IV and the AAD `table:column:row_id`, stored as `iv || ciphertext || tag`;
   decryption enforces the 12-byte IV and the 28-byte minimum before touching WebCrypto and
   fails uniformly on a wrong key, a wrong AAD or a modified byte. The KEK is imported once per
   isolate as a non-extractable key (the documented module-scope exception: a `CryptoKey` is not
   an I/O object and holds no request state); a DEK is unwrapped per request as non-extractable
   and never memoised. The write path imports the freshly generated DEK `extractable: true`
   because AES-KW exports the key before wrapping and workerd throws otherwise.
2. **Better Auth's `account.encryptOAuthTokens`**, deliberately OFF. It is XChaCha20-Poly1305
   keyed on a SHA-256 of `BETTER_AUTH_SECRET` with its own `$ba$` envelope and rotation through
   `BETTER_AUTH_SECRETS`. It never has anything to encrypt because the plugin endpoints hand no
   tokens to Better Auth; turning it on would add a second rotation drill for empty columns.

Design choices written down rather than left implicit:

- **KEK rotation is a re-wrap.** `rotateKek(userId, toVersion)` unwraps the DEK under the old
  KEK and wraps it under the new; ciphertexts never change. Old `TOKEN_KEK_V{n}` secrets stay
  configured until every `user_keys` row has moved (a housekeeping job, increment 12). The
  `key_version` column beside each secret records which KEK wrapped the owner's DEK when the
  value was written, and decryption refuses a version the Worker no longer knows, so a rotation
  that was not finished fails loudly rather than silently.
- **The AAD excludes the key version** on purpose. Including it would bind a ciphertext to a KEK
  generation and break the re-wrap-only rotation. The cost is that the AAD cannot detect a
  version-downgrade attempt on the DEK; the wrapped DEK's own integrity (AES-KW) and the
  `key_version` check cover that.
- **DEK bytes in the isolate heap.** The 32 raw bytes exist in JavaScript memory between
  `getRandomValues` and `importKey`; WebCrypto and Workers offer no zeroisation primitive. The
  window is one synchronous call and the buffer is unreachable after import. Accepted.
- **Deletion is not crypto-shredding.** The wrapped DEK sits inside Neon's PITR window; effective
  deletion latency equals the production history retention (plan section 10 recommends 1 day and
  disclosing it).

## 3. Rate limiting and quotas

Three layers, each honest about what it is:

- `PUBLIC_RL` and `USER_RL` (Cloudflare rate limit bindings) are per-colo, eventually consistent
  and documented as "not an accurate accounting system". They are abuse dampers in front of
  everything (`ipLimiter` in the global chain, `principalLimiter` keyed by user id under `/v1`).
- Better Auth's limiter on `database` storage is exact but costs one read and one write on
  `rate_limits` per auth request. Accepted for Phase 0; a Durable Object `customStorage` is the
  Phase 1 hardening item.
- Exact quotas (the magic-link caps now; per-user flight caps later) live in `usage_counters`.

## 4. Open items carried to later increments

- Whether the anonymous cookie reaches `GET /magic-link/verify` on a real device (increment 9).
- Account deletion: Apple revoke in `user.deleteUser.beforeDelete`, and the `freshAge` question
  (increment 8).
- The Vitest Workers pool does NOT enforce the global-scope entropy restriction (a module-scope
  `crypto.getRandomValues` call succeeded in the pool during this increment), so a regression of
  that kind passes CI and fails on deploy. The staging smoke test is the backstop; an ESLint rule
  is a candidate for increment 12.
- KEK rotation runbook (increment 12, with the housekeeping job that drives `rotateKek`).
- Share-link and MCP threats (Phases 5 and 6), App Attest and Play Integrity (columns reserved).
