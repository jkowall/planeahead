# PlaneAhead threat model

Status: complete for Phase 0 (increment 12, 2026-09-23); first version 2026-09-22 (increment 5).
Increment 5 added authentication, the envelope-encryption module and the account routes;
increment 6 the provider webhook receivers (section 3.1); increment 8 account deletion (section 5);
increment 12 the anonymous events endpoint (3.2), the admin page behind Cloudflare Access (3.3),
the public account-deletion page (3.4), the operational surface (section 6), the share-link and
MCP threats as documentation only (section 7) and the KEK rotation runbook (section 8). Everything
below refers to the code as built in `apps/api`; where a fact came from research rather than from
running code it cites the facts sheet (`docs/increments/05-auth.facts.md` and its siblings).

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
  environment's bundle ids (increment 12: `APPLE_BUNDLE_IDS`, defaulting to the variants the
  association files name, production and preview against production and the development build
  against staging, plus `APPLE_BUNDLE_ID`), `maxTokenAge: '1h'`. The code exchange uses the
  bundle id the token names as its `client_id` and as the client secret's subject, because the code
  belongs to the app that signed in; a token for any other bundle id is refused before the exchange. `rawNonce` is REQUIRED in the body (400 `NONCE_REQUIRED`) and
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
  option (section 9).
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
  the old token answers 401 afterwards) for every WRITE. The signed `session_data` cookie cache
  (`session.cookieCache`, 300 s): increment 8 (ruling O5) resolved every `/v1` request with the
  cache disabled, at one indexed `sessions` read per request; increment 12 (ruling W2 step 8)
  re-enabled it for GET and HEAD and closed the hole that mattered with a KV tombstone per
  deleted account's session (`tombstone:session:{HMAC}` in `CACHE`, the keyed hash
  `deleted_subjects` stores): the deletion writes one for every session it removes, after its
  transaction commits and before it answers, the housekeeping re-writes any that is missing, and
  the auth middleware looks it up for EVERY request that resolved its session through the
  cacheable read, whatever the cache cookie is called (Better Auth also reads it in chunks,
  `session_data.0`, `.1`, ...; review ruling AA14: one KV read per cacheable GET), answering 401
  `account_deleted`. A mutating request never uses the cache, and neither does
  `GET /v1/flights/search` (ruling AA11): it takes creation caps and may spend a provider call
  through the DesignatorResolver, so it reads the session row like a write. When the tombstone
  cannot be checked (no `DELETED_SUBJECT_HMAC_KEY`, or the KV read fails) the request reads the
  row. Accepted residuals, both bounded: a session revoked WITHOUT an account deletion (this
  merge's revocation, a sign-out on another device) can still use the read-only paths for up to
  300 s from a cached cookie (never a write, never the search); and KV's propagation (a write is
  visible in its own location at once, elsewhere within about 60 s, and a location that read the
  key recently may serve its cached miss for up to 60 s) lets a deleted account's other device use
  the read-only paths for up to about a minute after the deletion. `auth-anonymous.test.ts`,
  `session-tombstone.test.ts` and `me.delete.test.ts` pin the behaviour.
- **The `?cookie=` redirect.** The Expo server plugin's after-hook appends the raw `Set-Cookie`
  value as a `cookie` query parameter to any non-http redirect it trusts, which would put the
  session cookie into a URL (logs, referrers, the OS's URL history). PlaneAhead makes the branch
  unreachable: the magic-link email links to the landing page `GET /auth/magic-link?token=...`
  (section 1.3), the app extracts the token from the universal link and calls
  `GET /api/auth/magic-link/verify` over its own fetch with NO `callbackURL`, Better Auth then
  answers JSON plus `Set-Cookie`, and the wrapper in `src/routes/auth.ts` refuses the three
  callback query parameters with 400 (`auth-magic-link.test.ts` asserts the JSON-plus-cookie
  shape, the absence of a `Location` header and the refusal). Increment 9's
  `apps/mobile/__tests__/auth-transport.test.tsx` runs the real Better Auth Expo client over an
  in-memory SecureStore and a recorded fetch and asserts that the verify request carries the
  anonymous cookie and no `callbackURL`; a device run against a deployed API is the owner's
  acceptance step (apps/mobile/README.md).
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
  (`merge_skipped`, reason `requester_mismatch`). Both cases are tested.
- **The app's half of the binding (increment 9, built).** The server-side requester binding is
  the backstop, not the whole answer: a login-CSRF link still signs the phone in. The app
  (`apps/mobile/src/lib/magic-link.ts`, `src/app/auth/magic-link.tsx`) therefore:
  - verifies a link WITHOUT asking only when this install requested a magic link in the last
    fifteen minutes AND the link arrived as a universal link: an `https` URL on the one host the
    build claims (`runtimeConfig().universalLinkHosts`), on `/auth/magic-link`, carrying the
    token on screen. How it arrived is the router's own record of the delivered URL
    (`src/app/+native-intent.tsx`, `src/lib/delivered-url.ts`), never `Linking.getLinkingURL()`,
    which on iOS keeps the first URL the process received and would report a later universal
    link as, say, the development client's launch URL. The custom scheme
    `planeahead://auth/magic-link?token=...` routes to the same screen and any app on the device,
    or a tapped web link, can open it without the user asking, so such a delivery, like a link
    this install never requested, waits for an explicit "Sign in" tap;
  - whenever this install has a pending request, compares the verified account's email,
    case-insensitively, with the addresses it requested; on a mismatch it signs that session out
    (revoking it server-side) and puts the pre-verify cookie map back, so the phone is the
    anonymous user it was and nothing added afterwards lands in the other account;
  - holds the outbox (the apply gate) while the verify and the check run, so no queued mutation
    is sent under a session about to be undone.

  `apps/mobile/__tests__/sign-in.test.tsx` pins it ("asks first for a link delivered on the
  custom scheme ...", "verifies a requested universal link that follows an earlier custom-scheme
  URL in the same process", "signs out of an account another address owns and restores the
  anonymous session", "checks the address after a confirmed tap too ...").
  Residual: an attacker link that arrives as a genuine universal link while the user waits for
  theirs is verified at once and then undone by the email check, so the phone is briefly signed
  in to the attacker's account (a pull of the attacker's rows may land and is wiped when the
  session returns). The complete binding, the emailed URL carrying a per-request tag the app
  matches before verifying, needs the server; it was not built in increment 12 and is a Phase 1
  item (`docs/open-decisions.md`).

- **A crash between the two callers.** Both are safe to replay: the marker is set inside the
  transaction, so a retry sees `already_merged`.
- **A lost queue message.** The rows are moved and the marker is set before the send; if the send
  fails the failure is logged (`merge_enqueue_failed`). The nightly tracker subscriber
  reconciliation (increment 12, section 6) repairs what the message would have done: a tracker
  entry that names the anonymous user for a subscription now live under the account is
  re-pointed, and entries of the `deleting` user are unsubscribed; the anonymous `users` row is
  deleted by the same pass once its merge is an hour old (every table referencing it cascades).

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
account's flight alerts to a phone it had signed out of (what the re-point stops, and what it
cannot, is at the end of this section); and a cross-device magic link whose
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

Increment 14 (ruling P6) adds the token's lifecycle. A registration invalidates the device's other
live rows of the same kind, so a rotated token stops receiving pushes; a skipped registration
(`owned_by_another_user`) rotates nothing. `POST /v1/devices/current/invalidate` needs a session
and invalidates only the rows on the CALLER's device row for the named installation: the install id
is not a secret, so a caller who names another user's installation reaches nothing of theirs. The
push path invalidates a token only on the provider answers ruling P5 lists, and an APNs answer only
when it was about the row's own app id and environment, so a request that names a wrong topic
cannot be used to kill someone else's registration. Device tokens never reach a log line: the
`push` consumer logs push token ids and counts, and refuses an unreadable job without its body;
the dead letter consumer logs a push job whose archive failed with each token replaced by its
length (review ruling R5).

What a sign-out or a re-point guarantees (increment 14's review ruling R1): the `push` consumer
reads every target's token row once per batch, before the batch's first send (first attempts
included), and sends only to a live row still owned by the job's user, so nothing from a batch
whose read starts after the invalidation or the re-point commits reaches the phone. A batch
already past its read can still finish its sends, usually within seconds and at most about seven
minutes (five jobs of 50 targets, six in flight, a 10-second timeout each; the re-review's probe
showed a second job of the same batch sent after a mid-batch sign-out). Two windows no server
check closes: a push APNs or FCM had already accepted,
which the provider holds until the job's `expiresAt` and delivers to a phone that was offline at
sign-out; and a sign-out made offline, until the app's invalidate call succeeds, which increment
16 builds with its retry (`docs/open-decisions.md`, section 5, decision 1).

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
  configured until every `user_keys` row has moved (the nightly `kek_rewrap` housekeeping step,
  increment 12; the runbook is section 8). The
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
- The provider webhook receivers are the one exception to `PUBLIC_RL` (section 3.1).
- Per-route brakes on top: `EVENTS_RL` (section 3.2), and `BOARD_RL` and `BOARD_IP_RL` on the
  board routes (section 3.5).

### 3.1 Provider webhook receivers (increment 6)

`POST /v1/webhooks/aerodatabox/{token}` and `POST /v1/webhooks/aeroapi/{token}`
(`src/routes/webhooks.ts`). Neither provider signs a delivery, so the credential is a 256-bit
token per provider and per environment in the path, compared in constant time after a length
check; a wrong token is the ordinary 404, never 401 or 403. A valid delivery is validated strictly
and only ENQUEUED on `provider-events`; it never fetches, opens Postgres or touches a Durable
Object, and its body is a hint the tracker merges or re-reads, never trusted to create or rename
an instance (ADR 0010). The AeroDataBox receiver is shut while `ADB_ALERTS_ENABLED` is false.

**No IP limit, by decision (orchestrator ruling I2).** The receivers are exempt from `PUBLIC_RL`
(`ipLimiter` skips `/v1/webhooks/`) and get no per-route limiter in Phase 0.

- Why: a provider delivers from a small, shared set of addresses. A per-IP brake of 120 per
  10 s would throttle a burst of real deliveries (an AeroDataBox notification per flight, AeroAPI
  alerts around a bank of departures) before it ever slowed an attacker, and a throttled
  delivery is a missed gate change. A guesser gains nothing from volume: the token space is
  2^256, and a wrong guess costs one cheap 404 with no body read.
- What bounds a caller WITH the token (a leak): the `provider-events` queue's own backpressure
  (a full or failing queue answers 503, which the provider retries and an attacker gains nothing
  from), the 256 KB body limit, strict schema validation, and the fact that a delivery can only
  make a tracker merge a plausible patch or re-read the flight, each re-read inside the
  per-flight and provider-wide budgets. The provider-wide `ProviderBudget` cap, not the route,
  bounds what a flood of forged hints can cost.
- Accepted residual: a leaked token lets its holder fill the queue until rotation; the
  consumer's per-flight budget and the daily provider cap keep the spend bounded, and the
  token is rotated by a secret change (plus, for AeroAPI, re-registering live alerts with the new
  `target_url`). Revisit with a per-token rate limit binding when deliveries are live (Phase 1).

**The token stays out of logs and Sentry.** The route never logs a path and answers every
unexpected failure itself, so nothing reaches `app.onError` (which logs the path). The Sentry
scrubber redacts `/v1/webhooks/{provider}/{token}` from every string in an event, span attributes
such as `url.path` included; `webhooks.test.ts` drives a real delivery through the real chain
and asserts the serialised envelopes. Residual, recorded in ADR 0010: Cloudflare's own invocation
logs keep request URLs.

### 3.2 `POST /v1/events` (increment 12)

The first-party analytics endpoint is anonymous by design (ADR 0005): the app sends its
install-scoped analytics id, never a session cookie or the install id, so no event can be joined
to an account on the server. What bounds it: `PUBLIC_RL` per IP, then `EVENTS_RL` (300 batches
per 60 s, ruling AA4) keyed by the client IP, never by the analytics id (a value the client chooses
and rotates cannot key a brake, increment 5's rule); a 256 KiB body limit (413); a strict envelope (a UUID
analytics id, 1 to 100 events) and per-event validation (a name from `PRODUCT_EVENT_NAMES`, an ISO
time, a flat props bag of at most 16 keys and 1 KiB). Nothing is written to Postgres, only
Analytics Engine points through the invocation's 200-point budget. Accepted: a forger can write
plausible events under any analytics id (analytics integrity, not security; no decision reads
them), and a future client could put personal data in the props bag (the schema allows only
snake_case keys and short scalars; review what the app sends before adding an event name).
Residual of keying by IP: carrier-grade NAT puts many installs behind one address, which is why the
limit is 300 batches a minute and not 60; one abusive install behind a shared address can still
spend that address's allowance and drop the others' events for the rest of the minute (analytics
loss only, nothing the app depends on).

### 3.3 The admin page behind Cloudflare Access (increment 12)

`GET /admin` (and every path below it) is read-only except two actions (below), server-rendered
HTML with no script under a CSP of `default-src 'none'` plus one hashed stylesheet, `no-store`,
`frame-ancestors 'none'`.
Cloudflare Access sits in front of the path, and the Worker validates the
`Cf-Access-Jwt-Assertion` itself (`src/middleware/access.ts`), because a request can reach the
Worker without passing Access (a misconfigured policy, a route added later, the workers.dev host):
RS256 against the team's certs (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`,
fetched and cached per isolate, refetched at most every 30 s for an unknown key id), the issuer
must be the team domain, the audience must contain `ACCESS_AUD`. The team domain must be a
`*.cloudflareaccess.com` host, so a mistaken var can never make the Worker fetch keys from
somewhere else. Anything missing or wrong is a 403 with an empty body; the reason goes to the log
only. With `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` empty (every environment until the owner creates
the Access application) the page answers 403 to everyone. What the page shows is operational
(call counts per flight key and per provider, never a user), and the Cloudflare API token behind
two of its sections is read-only and optional.

The first write action (review ruling AA9) is the operator account deletion for a request that
reached the support inbox: `GET /admin/accounts/delete?user_id=` shows the account's status and
creation date (no email), and `POST /admin/accounts/delete` with the id typed a second time runs
the same `deleteAccount` as `POST /v1/me/delete` (trackers, the Apple revocation, the one
transaction, the `deleted_subjects` hashes, the KV tombstones), whose one audit row carries actor
`admin` and the Access assertion's email and subject. Its CSRF defence: the POST must carry an
`Origin` equal to `API_PUBLIC_URL`'s origin (a cross-site form still carries the Access cookie, so
Access alone is not enough), no cookie of the API authorises it, and a confirmation that does not
match the id changes nothing. Only that page's CSP allows `form-action 'self'`. The social
engineering risk of an emailed request stays a procedure (section 3.4).

The second write action (increment 14, ruling P8) is "Send a test push": `POST /admin/push/test`
with the same `Origin` rule and form-action allowance, which puts one test job for a REGISTERED
token (by kind and token) on the push queue and writes an audit row naming the operator. In
production it accepts only a token whose user id is in `PUSH_INJECT_ALLOWED_USER_IDS` (unset
refuses every token), so an Access session cannot push to arbitrary users there. The page shows
the push configuration by secret name only, the `PushAuth` objects' mint times and never a token,
and every attempt's outcome counts.

### 3.4 The public account-deletion page (increment 12)

`GET /account/delete` is static: no session, no script, no form, the same strict CSP, cached for
an hour. It names the in-app path and a support inbox (`SUPPORT_EMAIL`, created and tested by the
runbook before the Play listing); the out-of-app process it describes (a reply to the account's
address before anything is deleted) is a person following a procedure, because a request by email
is also the obvious social-engineering path to deleting someone else's account. The operator
carries it out with the admin page's deletion action (section 3.3), never with SQL, so the
trackers, the Apple revocation, the hashes and the tombstones happen as they do in the app.

### 3.5 Airport boards and the route search (increment 18)

`GET /v1/airports/{code}/board` and `GET /v1/airports/{origin}/flights/to/{destination}`
(`src/routes/airports.ts`, `src/boards/access.ts`) spend a shared provider budget for any
session, anonymous ones included, so their gates, brakes and caps are the surface:

- **Off until licensed.** Both answer 404 `boards_disabled` unless `BOARDS_ENABLED` is `"true"`
  (locally and on staging); production says `"false"` until AeroDataBox's written End Use answer
  and the per-user limits below exist (review ruling R8). The check runs before the route's
  session checks, brakes and lookups.
- **Who.** A session principal with the user scope (`requireSession`: an API token, once those
  exist, is refused whatever its scopes, ruling R15). An anonymous account opens only the boards
  of airports on its live subscriptions, and searches routes within the `route_searches` caps
  (30 per user per UTC day, and 30 per salted IP for anonymous accounts).
- **Brakes.** `BOARD_RL` (30 per 60 s per user) and `BOARD_IP_RL` (300 per 60 s per client
  address reduced to its /64 by `normaliseClientIp`, so rotating addresses within one /64 gains
  nothing, while a NAT of real installs gets `EVENTS_RL`'s larger allowance; ruling R11). Both
  are per colo and fail open: abuse brakes, not quotas. A 403 `cap_exceeded` names its `scope`.
- **Spend.** No request calls AeroDataBox itself: `AirportState` coalesces misses, and
  `ProviderBudget` holds board calls to 35 percent of the day's units, 60 distinct airports an
  hour and a floor of per-second tokens left to the trackers; a board window ends at most 72
  hours ahead (ruling R3). Accepted until the per-user limits exist (`docs/open-decisions.md`
  section 9, required before production): one signed-in account rotating airports can still
  drain the day's boards share in about 2 hours and fill the hour's airport cap, leaving every
  board stale and new airports' boards answering 503 until the hour or the day turns; trackers
  keep their own units and tokens.
- **Caches.** Board answers are `no-store`, like every answer the `/v1` chain produces (section 5),
  and a bucket lives only in its airport's `AirportState` and its `board:v2` KV copy, both purged at
  the sooner of 48 hours after the bucket ends and 7 days after its fetch.

## 4. Encryption and tokens, in one view

Two encryption schemes exist and one is used (section 2): PlaneAhead's AES-KW-wrapped per-user DEK
with AES-256-GCM values bound by AAD to their cell, keyed by `TOKEN_KEK_V{n}`; Better Auth's
`encryptOAuthTokens` is off and has nothing to encrypt. Tokens a client presents are stored as
hashes (magic links hashed by the plugin, identity-token replay markers as digests, the sessions
of deleted accounts as HMACs); the live session token is Better Auth's plaintext lookup key, the
documented exception (docs/schema-review.md section 12). The webhook path tokens are 256-bit
secrets compared in constant time (section 3.1). Every hop is TLS, and no secret is ever a query
parameter.

## 5. Account deletion and the disclosure (increment 8, completed in increment 12)

`POST /v1/me/delete` is synchronous and accepts an anonymous session (Apple 5.1.1(v) requires
guest accounts to be deletable). Order: read outside a transaction (subscriptions, the Apple
refresh token decrypted while its DEK exists, provider subjects, session tokens); unsubscribe every
tracker; revoke at Apple, best effort (TN3194: deletion completes without a usable token); one short
transaction that locks the user row, deletes every user-owned row leaf to root, writes the
`deleted_subjects` rows and the audit row, and deletes the user; then (increment 12) the KV session
tombstones; then an unsubscribe of any subscription that committed while the deletion ran.

- Another device of the deleted account is told 401 `account_deleted` (wipe the store) on its next
  request: a dead cookie whose token's HMAC is in `deleted_subjects`, a cached cookie whose token
  is tombstoned in KV (section 1.5), or (increment 12) a request that authenticated just before the
  deletion committed and then failed a `users` foreign key (SQLSTATE 23503 on a `*_user_id` key):
  the global error handler re-reads `users` for the principal and answers the same 401 instead of
  a 500 (`error-handler.test.ts` drives it through the idempotency lease insert).
- **The phone's HTTP cache** (increment 18, review ruling R1). Every answer the `/v1` chain
  produces carries `Cache-Control: no-store` unless its route names its own
  (`src/middleware/no-store.ts`); one given before the chain runs (the per-IP limiter's 429, an
  error the root chain's middleware raises) carries none and holds no user data.
  `expo/fetch`'s platform caches (OkHttp's disk cache on Android, the shared `URLCache` on iOS)
  had stored `/v1` GET answers, the sync feed's pages included, and the wipe on sign-out or
  deletion (`forgetAccount`) clears SQLite and the query cache, not that cache, so the copies
  outlived both. Residual: entries an earlier build wrote stay on a device until the app's data
  is cleared, which the verification record asks for on every development device
  (`docs/increments/18-verification.md`). On iOS such an entry may also hold the request, with
  the session Cookie header the app sets by hand (unverified); under `no-store` no new entry is
  written.
- **What survives, pseudonymously** (GDPR Art. 17(3)(b) and (e)): `audit_log` (two years),
  `notification_deliveries` (90 days), `revenuecat_events` and `subscriptions` (the finance
  ledger), `provider_calls` and `provider_call_daily` (about flights, no user linkage), and
  `deleted_subjects` (HMAC-SHA-256 under a Workers secret of the Apple and Google subjects for 400
  days and of the session tokens for 31 days, purged nightly at `expires_at`).
- **The disclosure**: deleted immediately from the live database; the encrypted change history
  (Neon's history window, set to 1 day explicitly) is retained up to 24 hours. It is on the public
  page (`/account/delete`) and in docs/schema-review.md section 7. Per-user DEKs are not
  crypto-shredding while the wrapped DEK sits in the history window (section 2).
- Accepted: an Apple account whose refresh token was never stored (section 1.6), or whose token
  belongs to another bundle id (a preview build, `docs/open-decisions.md`), is not revoked at
  Apple; the user can revoke from their Apple ID settings, and the deletion completes.

## 6. The operational surface (increment 12)

- **Crons plan, queues work.** The crons only page or plan and enqueue (ruling W1); the housekeeping
  consumer runs one message at a time within a 30 s wall budget and writes an audit row per message.
  A failed step is retried by the queue and dead-lettered to R2 with an ops alert, never looped by
  the cron.
- **The subscriber reconciliation never removes a fresh entry.** An entry or a row younger than
  10 minutes is left alone, because a subscribe route calls the tracker before its transaction
  commits; a wrong unsubscribe loses a real subscription, a stray costs nothing in Phase 0
  (increment 8, ruling O13).
- **The counter repair never races a request.** A counter is repaired only when it and the user's
  subscriptions have been quiet for 10 minutes, and the UPDATE re-checks the value it read.
- **The dead-letter replay cannot loop.** Only the archives whose sender keeps no copy (the
  DesignatorResolver, the ProviderBudget) are replayed, at most three times each (`replayCount` on
  the body); after that one is parked under `dlq/persist-parked/` with an error log. A
  FlightTracker's archive is never replayed (the tracker re-sends its own copy, so a replay would
  multiply a poison row's dead-letterings), and the lifecycle rule expires `dlq/` after 30 days.
- **The ledger is never purged against a bad rollup.** A rollup sum that is not a number fails the
  message loudly instead of becoming a 0 row, and a day of `provider_calls` is deleted only when
  its rollup is above zero and within 20 percent of the day's `count(*)` as the rollup itself
  recorded it (`ledger_calls`, rulings AA13 and AB3), never the live count once one is recorded,
  so a purge that deleted part of a day and was retried judges the day by the same figure and
  cannot strand the rest of it.
- **The Cloudflare API token** the Worker may hold (`CF_API_TOKEN`) is scoped to Account Analytics
  Read and Queues Read: it can read call counts and queue depths, nothing else. The deploy token
  lives only in GitHub environment secrets, with the scopes docs/runbooks/first-deploy.md lists.
- **The deploy.** Production deploys only from a manual run on a `v*` tag with the tag typed back
  (until GitHub Pro allows a required-reviewer gate), migrates before it deploys, and smokes
  `/health` against the build's own migration hash and Durable Object versions; secrets are set out
  of band, never by the workflow.

## 7. Share links and MCP (documented only; Phases 5 and 6)

Neither exists in Phase 0; the tables are reserved (`share_links`, `share_link_views`, and
`api_tokens` with `pa_<kind>_<base64url32>` tokens stored as SHA-256 plus a prefix). The threats
and the mitigations those phases must ship:

- **Share links.** Token guessing: 256-bit tokens, hashed at rest, looked up by hash, per-IP
  limits on the share host. Cache poisoning and a revoked link served from cache: the share page on
  its own hostname, `share:page:{sha256(token)[0:32]}` in KV for 60 s only, revocation deletes the
  key and the page answers `no-store` afterwards. Open Graph image enumeration: images keyed by an
  unguessable id, never by the flight key. Scraping: the page shows the flight, never the user or
  the trip; views counted in `share_link_views` and kept 30 days.
- **MCP.** Token theft: short-lived scoped tokens in `api_tokens`, revocable, never in URLs. The
  confused deputy under the 2026-07-28 MCP authorization spec: audience-bound tokens and no token
  passthrough to providers. Prompt injection in tool output: provider and user text returned as
  data, never as instructions, with a length cap. Write actions: a two-step confirmation and an
  audit row for every write. Rate abuse: a per-token limiter and the same provider budgets as the
  app. A separate hostname (plan section 19 item 14).
- **App Attest and Play Integrity** are deferred; `devices.attestation` is reserved.

## 8. KEK rotation runbook

Rotation is a re-wrap: each user's DEK is re-wrapped under the new KEK and no ciphertext changes
(section 2). The nightly `kek_rewrap` housekeeping step does the re-wrap in the background.

1. Generate the new key and keep an offline copy: `openssl rand -base64 32` (standard padded
   base64, 32 bytes; base64url is refused with a message saying so).
2. `pnpm exec wrangler secret put TOKEN_KEK_V2 --env <env>` (the next unused version). Nothing
   else is deployed: the next request imports it, `currentVersion` becomes 2, and every NEW DEK is
   wrapped under V2 at once. V1 stays configured, so every existing value still decrypts.
3. Wait for the next 03:00 UTC run: the `kek_rewrap` step re-wraps every `user_keys` row whose
   `kek_version` is not the current one, 100 per message with continuations, one audit row per
   message (`housekeeping.kek_rewrap` with `rewrapped`, `superseded` and `failed`). Each new wrap
   is proven before it is written (unwrapped under the new KEK back to the same DEK, byte for
   byte; a failure leaves the row untouched and counts as failed), and the UPDATE is conditional
   on the `kek_version` it read, so a redelivered message or a concurrent run can never overwrite
   a newer wrap (`superseded`).
4. Check: `select kek_version, count(*) from user_keys group by 1` shows only 2, and the admin
   page's last `housekeeping.kek_rewrap` rows show `failed: 0`. A failed row is logged with its
   user id (`kek_rewrap_failed`): a row wrapped under a version the Worker no longer holds, which a
   person resolves before going on.
5. Only then retire V1. `TOKEN_KEK_V1` is in `secrets.required` and `WORKER_SECRET_NAMES`, so
   retiring it is a reviewed change that removes it from both (and from `.dev.vars.example`),
   deployed, followed by `pnpm exec wrangler secret delete TOKEN_KEK_V1 --env <env>`. A value still
   carrying `key_version` 1 then fails loudly (`UnknownKeyVersionError`) rather than silently.
6. Suspected compromise of a KEK: do steps 1 and 2 at once, run the housekeeping early rather than
   waiting for the night, and treat every DEK the old KEK wrapped as exposed to whoever holds it:
   the per-user secrets (today only Apple refresh tokens) should be revoked or re-obtained. The
   Neon history window (1 day) keeps the old wrapped DEKs for a day.

`BETTER_AUTH_SECRET` rotates separately (every session and cookie signed with the old one is
invalidated unless Better Auth is given both). `DELETED_SUBJECT_HMAC_KEY` and `IP_SALT_SECRET`
must NOT be rotated casually: a new HMAC key orphans every `deleted_subjects` hash (a deleted
account's other device then sees `unauthenticated` instead of `account_deleted`), and a new salt
root restarts the anonymous per-IP caps.

## 9. Open items

- The anonymous cookie on `GET /magic-link/verify`: proven on the real client in Jest by
  increment 9 (section 1.5); the device run is the owner's acceptance step once an API is
  reachable. The app-side binding is built (section 1.5); a per-request tag in the emailed URL
  that the app matches before verifying is the remaining step (Phase 1, `docs/open-decisions.md`).
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
- Account deletion: built in increment 8 as PlaneAhead's own route (section 5); `freshAge` stays
  at Better Auth's default and `deleteUser` stays disabled.
- The Vitest Workers pool does NOT enforce the global-scope entropy restriction (a module-scope
  `crypto.getRandomValues` call succeeded in the pool during this increment), so a regression of
  that kind passes CI and fails on deploy. The staging smoke test is the backstop; an ESLint rule
  is still a candidate (not built in increment 12).
- The residual windows of the re-enabled cookie cache (section 1.5): a revoked session keeps the
  read-only paths for up to 300 s; tombstoning revoked sessions too, not only deleted accounts',
  would close it (`docs/open-decisions.md`).
- Share-link and MCP threats (Phases 5 and 6), App Attest and Play Integrity (columns reserved).
