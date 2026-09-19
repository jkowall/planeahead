# Increment 5: auth, envelope encryption, devices

Status: spec (2026-09-19). Builder: Fable 5.1. Reviewers: two Opus 5 lenses (security, Better Auth integration correctness) plus orchestrator read.

## Goal

Sign-in on the API Worker via Better Auth 1.7.5 (anonymous, magic link, Google ID token, Expo client transport) plus a custom native Apple route that captures and encrypts Apple's refresh token, the envelope-encryption module every later secret column uses, device registration, `/v1/me`, the per-email magic-link limits, and the anonymous-to-account merge that re-keys rows. Sessions live in Postgres via the Drizzle adapter through `withDb`.

Acceptance (Workers tests via `SELF.fetch` against a Neon test branch): anonymous sign-in creates a user with `is_anonymous = true`; magic link request returns 200 whether or not the email exists and writes a hashed token; a 4th request for the same email within an hour still returns 200 but sends nothing and increments `usage_counters`; Google ID-token sign-in verifies `aud`, `iss`, `exp` and `nonce` against a test JWKS; Apple native sign-in without `rawNonce` is rejected with 400; with a valid nonce and a stubbed Apple token endpoint the refresh token lands in `accounts.refresh_token_enc` with `key_version = 1` and decrypts under the test KEK; upgrading an anonymous user via magic link re-keys `devices`, `user_preferences` and `usage_counters` rows to the new user id in one transaction and enqueues a `merge` job on the `persist` queue (the DO re-subscribe step is a no-op stub until increment 7); `POST /v1/devices` upserts on `(user_id, install_id)`; `GET /v1/me` returns the user and preferences; `DELETE`-style account deletion is deferred to increment 8.

## Design

- **Better Auth factory** `createAuth(env, db)` built per request (no module-scope instance; the ESLint rule applies to `drizzle(` and a second rule flags module-scope `betterAuth(`). Config: `baseURL` from `API_PUBLIC_URL`; `secret` from `BETTER_AUTH_SECRET`; `database: drizzleAdapter(db, { provider: 'pg', schema })`; `session: { expiresIn: 30 d, updateAge: 1 d, cookieCache: { enabled: true, strategy: 'compact', maxAge: 300 } }`; `rateLimit: { storage: 'database', customRules for /sign-in/magic-link and /sign-in/anonymous }` with `cf-connecting-ip`; `trustedOrigins` for the Expo scheme `planeahead://` and the web origins; plugins `anonymous({ onLinkAccount, disableDeleteAnonymousUser: true })`, `magicLink({ storeToken: 'hashed', expiresIn: 600, sendMagicLink: via MailSender })`, `expo()`; `socialProviders.google` with the three client ids (web, iOS, Android) so ID-token sign-in works from native; `socialProviders.apple` configured for web only (Services ID) since native uses the custom route.
- **Apple native route** `POST /api/auth/apple/native` body `{ identityToken, authorizationCode, rawNonce, fullName? }`: verify the identity token with `jose` against Apple JWKS (`iss` https://appleid.apple.com, `aud` = iOS bundle id, `nonce` = SHA-256(rawNonce), required); exchange `authorizationCode` at `https://appleid.apple.com/auth/token` with an ES256 client secret minted from `APPLE_SIWA_P8` (cached per isolate for 1 h) and `client_id` = bundle id; envelope-encrypt the refresh token; upsert `accounts` (`provider_id = 'apple'`, `account_id = sub`); create the Better Auth session using its internal API (document which API; do not hand-roll cookies). Apple private relay emails are stored as the user's email.
- **Envelope encryption** `src/crypto/envelope.ts`: `KeyProvider` interface `{ getKek(version): Promise<CryptoKey>; currentVersion: number }` with `WorkersSecretKeyProvider` reading `TOKEN_KEK_V{n}` secrets (base64, 32 bytes, imported as non-extractable AES-KW keys, memoised per isolate). Per-user DEK (32 random bytes) wrapped with AES-KW and stored in `user_keys (user_id, wrapped_dek, kek_version)`. `encrypt(userId, table, column, rowId, plaintext)` returns `{ ciphertext: bytes(iv || gcm), keyVersion }` with AES-256-GCM, 96-bit random IV, AAD = `${table}:${column}:${rowId}`; `decrypt` verifies AAD. `rotateKek(userId, toVersion)` re-wraps only. Tests: AAD mismatch fails, IV never repeats across 10k calls, wrong key version fails, round-trip.
- **MailSender** `src/mail/sender.ts` interface `{ send({ to, subject, text, html }) }` with `ResendSender` (REST, `RESEND_API_KEY`) and `CloudflareEmailSender` (binding, feature-flagged off); `NoopSender` in tests. Magic-link email is plain text plus minimal HTML; sender address `sign-in@planeahead.app` (owner verifies the domain in Resend before staging).
- **Per-email limits**: `usage_counters` rows `magic_link:{lower(email)}:hour` and `:day` with caps 3 and 10, checked before sending, always 200 to the caller.
- **Devices** `POST /v1/devices { installId, platform: 'ios'|'android'|'web', osVersion, appVersion, pushTokenKind?, pushToken? }` upserts `devices` and, when a token is present, `push_tokens` (kind check: `apns`, `fcm`, `expo`, `apns_live_activity_push_to_start`).
- **Merge** in `anonymous.onLinkAccount({ anonymousUser, newUser })`: one transaction re-keying `devices`, `push_tokens`, `user_preferences`, `usage_counters`, `flight_subscriptions`, `trips`, `notification_preferences`, `idempotency_keys`; then enqueue `{ kind: 'merge', from, to }` on `persist`; the anonymous row is deleted by the queue consumer after verifying zero remaining rows (increment 8 wires the consumer; here the enqueue is tested with `getQueueResult`).
- **Auth middleware** replaces the placeholder: resolves the session from the cookie or the Expo header, sets `c.var.user`; `requireUser` and `requireScope('user')` helpers; `principalLimiter` keyed by user id via `USER_RL`.

## Files
```
apps/api/src/auth/{create-auth.ts, apple-native.ts, apple-client-secret.ts, google-verify.ts, merge.ts}
apps/api/src/crypto/{envelope.ts, key-provider.ts}
apps/api/src/mail/{sender.ts, resend.ts, cloudflare-email.ts, noop.ts}
apps/api/src/routes/{auth.ts, apple-native.ts, devices.ts, me.ts}
apps/api/src/middleware/auth.ts (real)
apps/api/test/unit/{envelope.test.ts, apple-client-secret.test.ts, google-verify.test.ts}
apps/api/test/workers/{auth-anonymous.test.ts, auth-magic-link.test.ts, auth-apple-native.test.ts, auth-google.test.ts, merge.test.ts, devices.test.ts, me.test.ts}
docs/security/threat-model.md (first version: auth section only)
```

## Constraints
- New deps: better-auth (exact 1.7.5), @better-auth/expo server side if required by the docs, jose. Nothing else.
- Secrets in tests come from `.dev.vars.test` with generated dummy keys; a test asserts no secret value appears in any log line.
- No em dashes. ESM. Every route registered in Hono keeps `AppType` exported for the mobile client.
