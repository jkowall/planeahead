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

`trustedOrigins` lists `planeahead://` and `API_PUBLIC_URL` everywhere, plus the two localhost
dev origins and `exp://` only when `ENVIRONMENT === 'local'` (the Expo plugin adds `exp://` only
under `NODE_ENV=development`; a deployed Worker that trusted `http://localhost:8081` would let any
local server on a victim's machine make credentialed requests). The CORS allow list is the same
list. A cookie-bearing POST from any other origin fails Better Auth's CSRF check.

Two more settings fail closed and are asserted by `auth-config.test.ts`: `transaction: true` on
the Drizzle adapter (section 1.6) and `onAPIError: { throw: true }` (section 1.7).

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
- **`POST /api/auth/sign-in/magic-link` beyond the caps.** The gate in
  `src/middleware/magic-link-cap.ts` runs for every request to the route (the idempotency
  middleware skips the auth mount, so a replayed `Idempotency-Key` cannot answer ahead of it),
  reads the body through Hono's cache and fails closed (415 for a non-JSON media type, 400 for
  non-JSON or a NUL), forwards `{ email }` alone (Better Auth's schema also accepts `name`, which
  it would write unsanitised into `users.name` at verify time, and three callback URLs) and counts
  only a request Better Auth would accept. Three counters in `usage_counters`, subjects SHA-256
  hex, never an address, an install id or an IP. The client address is reduced first
  (`src/validation/client-ip.ts`: IPv6 to its /64, IPv4-mapped to IPv4, exactly as Better Auth's
  own limiter does), because the second review's probe showed a /64 rotating /128s was a new
  requester on every request. Per REQUESTER (the reduced client address, else the install id;
  100 per hour, 300 per UTC day across addresses) answered 429 with `Retry-After`: NAT scale on
  purpose, since the earlier 20-per-hour brake let one heavy user, or one attacker, on an airport
  or hotel network, a corporate NAT, carrier CGNAT or a Private Relay egress lock everyone behind
  that address out of email sign-in until 00:00 UTC; the burst bound behind one address is Better
  Auth's 3 per 60 s, this brake bounds the day. Per ADDRESS (every requester combined; 10 per
  hour, 30 per UTC day) answered `{ status: true }` silently without invoking Better Auth: the
  bound on what one inbox can receive from this route whatever the attacker's address supply (a
  botnet, a /48 of /64s), which no per-requester rule can give. Per ADDRESS AND REQUESTER (the
  valid `X-Install-Id`, else the reduced client address; 3 per hour, 10 per UTC day) answered the
  same silent 200, so a stranger's first requests land on their own rows and do not silence the
  owner. The 200 is the same either way, so neither the cap nor a mail-provider outage reveals
  whether an address has an account. Residuals, both deliberate: a stranger who spends an
  address's 30 links locks its owner out of EMAIL sign-in (native sign-in is unaffected) for the
  rest of the UTC day, at the cost of 30 mails to the inbox they are attacking, which is the trade
  against an unbounded mail bomb (the ceiling sits three times above the owner's budget for that
  reason); and everyone behind one shared egress address shares 300 links a day, plus Better
  Auth's own 3 per minute, which was already the tighter shared-egress rule. The Resend
  idempotency key is a digest of the token, never a prefix of it.
- **`GET /auth/magic-link` (the emailed landing page) never consumes the token.** Mail security
  gateways (Safe Links, Mimecast, Proofpoint) fetch every link in inbound mail before the user
  sees it; an earlier design emailed the consuming verify URL, which a scanner would burn while
  signing itself in. The page carries no script and no external resource, is served `no-store`
  and `Referrer-Policy: strict-origin` under a CSP that allows only same-origin form posts, and
  its one button POSTs the token to `POST /api/auth/magic-link/consume`, which verifies server
  side and forwards the session cookie. `strict-origin`, not `no-referrer`: under `no-referrer` a
  browser sends `Origin: null` on the form post, and the consume route's Origin check answered
  the page's own button 403 (found by the second review in a real browser). `consumePostAllowed`
  (`src/routes/auth.ts`) refuses `Sec-Fetch-Site` cross-site or same-site whatever `Origin` says,
  accepts a listed `Origin`, accepts `Origin: null` only with `Sec-Fetch-Site: same-origin`, and
  accepts no `Origin` at all (a non-browser client, presenting the same secret the app presents to
  verify); the check runs before the token is touched, so a refusal burns nothing. What the page
  is for: the universal-link target and a scanner-safe landing, plus a browser sign-in whose
  session is inert in Phase 0 (no web surface uses it; the page says so and tells the user the app
  needs its own link). It is NOT a hand-off to the app: a `planeahead://` link carrying the token
  would deliver it to any app that squats the custom scheme on Android (verified App Links cannot
  be squatted, custom schemes can), so a phone on which the universal link did not fire is told to
  request a new link from the app. `GET /api/auth/magic-link/verify` refuses the callback query
  parameters (400), so Better Auth's redirect branch, which the Expo plugin decorates with the
  raw cookie, is unreachable, and its failure redirect is turned into a 400 JSON code.
- **`POST /api/auth/unlink-account` for an Apple row** is answered 400 `UNLINK_NOT_SUPPORTED` by
  a before-hook: the built-in unlink deletes the row holding `refresh_token_enc` with no
  revocation at Apple, and increment 8 wires the revocation. Google rows may still be unlinked.
  `revokeUnprovenAccountAccess` (run by magic-link verify for a user whose `emailVerified` is
  false) deletes every account row the same way; the Google path refuses `email_verified: false`,
  so it can reach an Apple row only for a user whose Apple token carried `email_verified: false`.
  Recorded as a second account-row deletion path for increment 8's revocation to cover.

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
  claim is absent. Two OIDC rules on top: a token with several audiences must carry `azp`, and
  `azp`, whenever present, must be one of the three client ids (jose's audience check passes when
  ANY entry matches, which alone would accept a token minted for another client that lists ours
  too); and `email_verified` must be `true`, or the sign-in is 403 `EMAIL_NOT_VERIFIED` with no
  user row (an unverified row would make the address owner's own Apple and Google sign-ins answer
  403 ACCOUNT_NOT_LINKED for good).
- **The Apple code exchange is bound to the identity token.** The `id_token` Apple returns with
  the authorization-code exchange is verified with the same JWKS, issuer and audience, and its
  `sub` (and `nonce`, when Apple includes one) must equal the identity token's. Without that
  check a captured identity token plus the attacker's own fresh code signed the attacker in as
  the victim and wrote the attacker's refresh token onto the victim's account row (so increment
  8's deletion would have revoked the wrong grant). A mismatch is 401 `CODE_EXCHANGE_FAILED`
  before any sign-in, and the refresh token is never stored.
- **Identity tokens are single use.** The nonce binds a token to its request and nothing more:
  a captured request body could be replayed for the token's lifetime (about an hour) and mint a
  session each time. Both endpoints record a presented token in the `CACHE` KV namespace
  (`src/auth/used-tokens.ts`) under `used_id_tokens:<provider>:<jti or sha256hex(token)>` for
  its remaining lifetime (minimum 60 s, KV's floor) and refuse a second presentation with 401
  `IDENTITY_TOKEN_REPLAYED`. Best effort by design: KV is eventually consistent and two
  presentations racing through different colos can both pass; a KV failure is logged and does not
  block the sign-in, because the signature, issuer, audience, expiry and nonce checks are the
  authentication and the marker is a brake. A server-issued nonce is the stronger long-term
  option (section 4).
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

- **The sliding session refresh and the `/v1` path.** Better Auth's `getSession` extends
  `sessions.expires_at` once a day AND re-issues the `session_token` cookie with a fresh
  `Max-Age`; the Expo client expires its SecureStore cookie by that `Max-Age` and stores cookies
  only from responses to requests it made itself (`/api/auth/*`), and the increment 9 `/v1`
  client keeps nothing from a `/v1` response. A `/v1` request that refreshed the row would throw
  the cookie away and leave `/get-session` seeing a recently updated row for the rest of the day:
  thirty days after sign-in the app would be signed out despite daily use, for an anonymous user
  for good. The first fix forwarded the refreshed cookie on `/v1`, which the specified client
  does not store, and would also have forwarded cookie DELETIONS, so a stale anonymous `/v1`
  request finishing after an upgrade could tell the client to drop the NEW session. The auth
  middleware now reads the session with `disableRefresh` and `/v1` never emits `Set-Cookie`; the
  refresh happens on `GET /api/auth/get-session`, which the session gate calls on every launch
  and foreground (increment 9). `auth-session-refresh.test.ts` pins both halves.
- **Cookie theft during the upgrade.** The anonymous session is revoked in the merge
  transaction, so a stolen session token stops working the moment its owner upgrades (tested:
  the old token answers 401 afterwards). The signed `session_data` cookie cache
  (`session.cookieCache`, 300 s) is the exception: a request that still carries it is answered
  from it without a database read until it expires, so a stolen pair keeps working for at most
  300 s after revocation. That is the trade the spec makes for one fewer read per request; the
  real client replaces both cookies on upgrade, and `auth-anonymous.test.ts` pins the window.
- **The `?cookie=` redirect.** The Expo server plugin's after-hook appends the raw `Set-Cookie`
  value as a `cookie` query parameter to any non-http redirect it trusts, which would put the
  session cookie into a URL (logs, referrers, the OS's URL history). PlaneAhead makes the branch
  unreachable: the magic-link email links to the landing page `GET /auth/magic-link?token=...`
  (section 1.3), the app extracts the token from the universal link and calls
  `GET /api/auth/magic-link/verify` over its own fetch with NO `callbackURL`, Better Auth then
  answers JSON plus `Set-Cookie`, and the wrapper in `src/routes/auth.ts` refuses the three
  callback query parameters with 400 (`auth-magic-link.test.ts` asserts the JSON-plus-cookie
  shape, the absence of a `Location` header and the refusal). Whether the anonymous cookie
  reaches that request on a real device is still an open item for increment 9 (the Workers test
  attaches it by hand).
- **Login CSRF through a forwarded link (the requester binding).** A verified link signs the
  verifier in as the address owner and the after-hook then merged the VERIFIER'S anonymous
  account into that owner. An attacker who requested a link for their own address and got the
  victim's app to open it (the app auto-verifies universal links with its anonymous cookie
  attached) therefore took over the victim's devices, push tokens, trips and subscriptions, and
  everything the victim added afterwards. `sendMagicLink` now records the anonymous user whose
  cookie rode on the request (or none) in a `verifications` row keyed by a hash of the token
  (`src/auth/magic-link-requester.ts`), and `onLinkAccount` on `/magic-link/verify` merges only
  when the verifying anonymous user is that requester. Otherwise the sign-in still succeeds (it
  is a valid link for the address it was sent to), nothing is merged, and the skip is logged
  (`merge_skipped`, reason `requester_mismatch`). Both cases are tested. Increment 9 should also
  auto-verify only links requested on the same install.
- **A crash between the two callers.** Both are safe to replay: the marker is set inside the
  transaction, so a retry sees `already_merged`.
- **A lost queue message.** The rows are moved and the marker is set before the send; if the send
  fails the failure is logged (`merge_enqueue_failed`) and increment 8's housekeeping sweep of
  `status = 'deleting'` anonymous users re-enqueues. The anonymous row itself is deleted only by
  the queue consumer after it verifies nothing points at it any more (increment 8).

### 1.6 The sign-in transaction and the non-atomic refresh-token write

`handleOAuthUserInfo` creates the user and the account of a new native sign-in inside Better
Auth's `runWithTransaction`. That is a REAL transaction only because the Drizzle adapter is
configured with `transaction: true` (its default is off, and the core then substitutes a
pass-through): as first built, the two INSERTs autocommitted separately, and a failure between
them left a user row with the provider's email and no account, which made every retry take the
implicit-link path and answer 403 ACCOUNT_NOT_LINKED for good. `auth-transaction.test.ts` injects
that failure and proves the rollback; `auth-config.test.ts` proves the adapter rolls back at all.

`runWithTransaction` takes no caller-supplied handle, so the Apple refresh token is
envelope-encrypted and written to `accounts.refresh_token_enc` AFTER that transaction commits,
in a second statement. A crash in that window leaves an Apple account with a live session and a
NULL `refresh_token_enc`, which means there is no token to revoke at account deletion. Increment
8's deletion treats NULL as "nothing to revoke" and logs it at warn level; the user can still
delete the account, and Apple lets them revoke the app's access from their Apple ID settings. The
authorization code is exchanged BEFORE the sign-in transaction (it is single use and valid for
five minutes) and bound to the identity token (section 1.4), so a rejected or foreign code never
leaves a half-made account and never lands on someone else's row.

### 1.7 Logging

No secret value reaches a log line: `secrets-in-logs.test.ts` drives every flow (including the
failure paths that log the most) with the console captured and searches every line for every
configured secret, the PEM body in both newline encodings, the magic-link token, the Apple
refresh token, the identity tokens, the authorization code, the session cookies and the raw
email address. Better Auth's own logger is routed through PlaneAhead's structured logger at
`warn` level and forwards only the message and a thrown error's sanitised fields, never the
request context it also passes.

**Bound query parameters never reach a log line or Sentry.** drizzle-orm wraps every failed
statement in a `DrizzleQueryError` whose message is `Failed query: <sql>\nparams: <every bound
value>`, and the bound values of an INSERT are the request (an email, a session token, a push
token, a device model). Three things close it: `errorFields` (`src/observability/log.ts`), the
one way an error reaches a line, cuts the message at the `params:` marker, caps it at 200
characters, keeps the stack FRAMES only (the stack's first line repeats the message), copies a
driver `code` and the same three fields of a `cause`, and copies nothing else off the error
(postgres.js attaches `detail` with "Failing row contains (...)", `query` and `parameters`);
`onAPIError: { throw: true }` on Better Auth, without which better-call answered a thrown
database error with `console.error('# SERVER_ERROR: ', error)` of the whole object; and the
Sentry scrubber applies the same cut to `exception.values[].value` and to console breadcrumb
messages. U+0000 is refused at every JSON boundary (400), so the statement that used to fail on
demand (Postgres rejects a NUL in any text or jsonb value) no longer runs at all.
`secrets-in-logs.test.ts` and `sentry-scrub.test.ts` each force a real failed statement through
the real error handler and assert the marker value is absent from the lines and the envelope.

### 1.8 Push tokens

`POST /v1/devices` upserts `push_tokens` on `(kind, token)`. A token already registered to
another user's device moves to the caller ONLY when the request comes from the same installation
the token currently points at (the `install_id` of the token's `devices` row equals the body's
`installId`, checked inside the upsert's `ON CONFLICT ... WHERE`). That is the phone itself in
the two flows the merge and increment 8's deletion do not cover: an account switch on one install
(sign out, sign in as someone else), where a token left on the first account kept sending that
account's flight alerts to a phone it had signed out of; and a cross-device magic link whose
merge was withheld (section 1.5), where the token stayed on an orphaned anonymous user and the
signed-in user's own registration was refused. From a DIFFERENT installation the token is not
re-pointed: there is no proof of possession in the request, anonymous principals are free to
create, and re-pointing let anyone who learned a token redirect its owner's alerts to themselves.
The device row is still written, the token is skipped, `push_token_conflict` is logged (without
the token) and the response says `pushTokenSkipped: 'owned_by_another_user'`. The install id is
client-chosen, so the rule is only as strong as the token itself: a caller who knows both a
token and the install id of the device holding it can take the token over, which is the same
caller who could register the device row under that install id anyway. The orphaned anonymous
user of the cross-device flow stays `active` with an empty device row until increment 8's
housekeeping sweeps it. A silent-push possession challenge is the Phase 1 hardening item.

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

- Whether the anonymous cookie reaches `GET /magic-link/verify` on a real device (increment 9),
  and the increment 9 rule that the app auto-verifies only links requested on the same install
  (the server-side requester binding in section 1.5 is the backstop, not the whole answer).
- The session gate's `getSession()` call on launch and foreground (section 1.5): the `/v1`
  path no longer refreshes, so if increment 9 ships without that call a session that only ever
  syncs in the background expires after 30 days. A Jest test in increment 9 asserts the call.
- A paste-the-link affordance on the app's sign-in screen for a phone on which the universal
  link did not fire (section 1.3 explains why the landing page offers no custom-scheme hand-off).
- A server-issued nonce for the native sign-ins (increment 9 fixes the client contract). The KV
  replay markers in section 1.4 are best effort; a nonce the server minted and can consume
  exactly once is the stronger design, and deciding it before the client ships avoids a second
  contract change.
- Mail scanners and the landing page: the two-step page in section 1.3 answers the scanner
  prefetch risk raised in `docs/increments/09-11-mobile.facts.md`; the universal-link prefix the
  app claims is `/auth/magic-link`, on the API host.
- Account deletion: Apple revoke in `user.deleteUser.beforeDelete`, and the `freshAge` question
  (increment 8).
- The Vitest Workers pool does NOT enforce the global-scope entropy restriction (a module-scope
  `crypto.getRandomValues` call succeeded in the pool during this increment), so a regression of
  that kind passes CI and fails on deploy. The staging smoke test is the backstop; an ESLint rule
  is a candidate for increment 12.
- KEK rotation runbook (increment 12, with the housekeeping job that drives `rotateKek`).
- Share-link and MCP threats (Phases 5 and 6), App Attest and Play Integrity (columns reserved).
