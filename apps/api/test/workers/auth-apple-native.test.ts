/**
 * Sign in with Apple, native flow, through the real Worker against the fake Apple JWKS and token
 * endpoint the test run serves.
 *
 * What is pinned: `rawNonce` is required (400) and must hash to the token's `nonce` (401); the
 * authorization code is exchanged with an ES256 client secret minted from the test `.p8` and the
 * refresh token lands envelope-encrypted in `accounts.refresh_token_enc` under key version 1,
 * decryptable with the test KEK, while `access_token`, `refresh_token` and `id_token` stay NULL;
 * a returning user's token carries no email and still signs in; a brand-new subject without an
 * email is refused; `fullName` is sanitised and stored only once; an anonymous session that
 * signs in with Apple is merged exactly once, and the anonymous after-hook is proven to fire for
 * this plugin endpoint over HTTP (docs/increments/05-auth.facts.md section 2 had it unverified).
 */

import { eq } from 'drizzle-orm';
import { accounts, devices, openDb, userKeys, users, withDb } from '@planeahead/db';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import { Envelope } from '../../src/crypto/envelope';
import { createWorkersSecretKeyProvider, readKekSecrets } from '../../src/crypto/key-provider';
import {
  appleNativeSignIn,
  captureLogs,
  cookiesFrom,
  jsonRequest,
  logEvents,
  registerDevice,
  sessionTokenOnly,
  signInAnonymously,
  testEnv,
  uniqueInstallId,
  uniqueIp,
  worker,
} from './helpers/auth';

interface SignInBody {
  readonly token?: string;
  readonly user?: { id: string; email: string; name: string; isAnonymous: boolean };
  readonly isRegister?: boolean;
  readonly code?: string;
  readonly message?: string;
}

interface RecordedTokenRequest {
  readonly form: Record<string, string>;
  readonly contentType: string | null;
}

async function tokenRequests(): Promise<RecordedTokenRequest[]> {
  const origin = testEnv.TEST_FAKE_PROVIDERS_ORIGIN ?? '';
  const response = await fetch(`${origin}/apple/token/requests`);
  return response.json<RecordedTokenRequest[]>();
}

async function accountFor(sub: string) {
  const [row] = await withDb(testEnv, (db) =>
    db
      .select({
        id: accounts.id,
        userId: accounts.userId,
        accessToken: accounts.accessToken,
        refreshToken: accounts.refreshToken,
        idToken: accounts.idToken,
        refreshTokenEnc: accounts.refreshTokenEnc,
        refreshTokenKeyVersion: accounts.refreshTokenKeyVersion,
      })
      .from(accounts)
      .where(eq(accounts.accountId, sub))
      .limit(1),
  );
  return row ?? null;
}

describe('POST /api/auth/sign-in/apple-native', () => {
  it('rejects a body without rawNonce with 400 nonce_required, before any provider call', async () => {
    const before = (await tokenRequests()).length;
    const { response } = await appleNativeSignIn({ sendRawNonce: false });
    const body = await response.json<SignInBody>();

    expect(response.status).toBe(400);
    expect(body.code).toBe('NONCE_REQUIRED');
    expect((await tokenRequests()).length).toBe(before);
  });

  it('rejects a nonce that does not hash to the claim, and a token with no nonce claim, with 401', async () => {
    const mismatch = await appleNativeSignIn({ nonceClaim: 'not-the-hash' });
    const missing = await appleNativeSignIn({ nonceClaim: null });

    expect(mismatch.response.status).toBe(401);
    expect((await mismatch.response.json<SignInBody>()).code).toBe('NONCE_MISMATCH');
    expect(missing.response.status).toBe(401);
    expect((await missing.response.json<SignInBody>()).code).toBe('NONCE_MISMATCH');
  });

  it('rejects a token for another bundle id and an expired token with 401', async () => {
    const wrongAudience = await appleNativeSignIn({ audience: 'app.someone.else' });
    // Older than maxTokenAge (1 h) while `exp` is still in the future.
    const stale = await appleNativeSignIn({
      issuedAt: Math.floor(Date.now() / 1000) - 7200,
      lifetime: 7200 + 60,
    });

    expect(wrongAudience.response.status).toBe(401);
    expect(stale.response.status).toBe(401);
    expect((await stale.response.json<SignInBody>()).code).toBe('INVALID_IDENTITY_TOKEN');
  });

  it('signs a new user in, exchanges the code with an ES256 client secret and stores only the encrypted refresh token', async () => {
    const sub = `00${crypto.randomUUID().replaceAll('-', '')}.first`;
    const email = `Apple-${crypto.randomUUID()}@PrivateRelay.AppleID.com`;
    const { response, authorizationCode } = await appleNativeSignIn({
      sub,
      email,
      claims: { is_private_email: 'true' },
      fullName: { givenName: '  Ada ', familyName: 'Lovelace\u0000' },
    });
    const body = await response.json<SignInBody>();

    expect(response.status).toBe(200);
    expect(body.isRegister).toBe(true);
    expect(body.user?.email).toBe(email.toLowerCase());
    expect(body.user?.name).toBe('Ada Lovelace');
    expect(body.user?.isAnonymous).toBe(false);
    expect(cookiesFrom(response)).toContain('better-auth.session_token=');

    // The exchange: four form fields, no redirect_uri, and a client secret that is an ES256 JWT
    // with the key id, minted from the test .p8 (imported as pkcs8 on workerd).
    const exchange = (await tokenRequests()).find(
      (entry) => entry.form['code'] === authorizationCode,
    );
    expect(exchange?.contentType).toContain('application/x-www-form-urlencoded');
    expect(Object.keys(exchange?.form ?? {}).sort()).toEqual(
      ['client_id', 'client_secret', 'code', 'grant_type'].sort(),
    );
    expect(exchange?.form['client_id']).toBe(testEnv.APPLE_BUNDLE_ID);
    expect(exchange?.form['grant_type']).toBe('authorization_code');
    const clientSecret = exchange?.form['client_secret'] ?? '';
    expect(decodeProtectedHeader(clientSecret)).toEqual({
      alg: 'ES256',
      kid: testEnv.APPLE_SIWA_KEY_ID,
    });
    const claims = decodeJwt(clientSecret);
    expect(claims.iss).toBe(testEnv.APPLE_SIWA_TEAM_ID);
    expect(claims.sub).toBe(testEnv.APPLE_BUNDLE_ID);
    expect(claims.aud).toBe('https://appleid.apple.com');

    // The account row: the Better Auth-owned token columns are NULL, ours is encrypted.
    const account = await accountFor(sub);
    expect(account).not.toBeNull();
    expect(account?.accessToken).toBeNull();
    expect(account?.refreshToken).toBeNull();
    expect(account?.idToken).toBeNull();
    expect(account?.refreshTokenKeyVersion).toBe(1);
    expect(account?.refreshTokenEnc).not.toBeNull();
    // iv(12) || ct || tag(16), so at least 28 bytes plus the token.
    expect(account?.refreshTokenEnc?.byteLength ?? 0).toBeGreaterThan(28 + 10);

    // Decrypts under the test KEK with the AAD the write used, and the DEK row exists.
    const db = openDb(testEnv);
    const envelope = new Envelope(db, createWorkersSecretKeyProvider(readKekSecrets(testEnv)));
    const plaintext = await envelope.decrypt(
      account?.userId ?? '',
      'accounts',
      'refresh_token',
      account?.id ?? '',
      { ciphertext: account?.refreshTokenEnc ?? new Uint8Array(), keyVersion: 1 },
    );
    expect(new TextDecoder().decode(plaintext)).toMatch(
      new RegExp(`^rt_${authorizationCode}_[0-9a-f-]{36}$`),
    );
    const [keyRow] = await db
      .select({ kekVersion: userKeys.kekVersion, wrappedDek: userKeys.wrappedDek })
      .from(userKeys)
      .where(eq(userKeys.userId, account?.userId ?? ''))
      .limit(1);
    expect(keyRow?.kekVersion).toBe(1);
    expect(keyRow?.wrappedDek.byteLength).toBe(40);

    // A wrong AAD (another column) fails: the value is bound to its cell.
    await expect(
      envelope.decrypt(account?.userId ?? '', 'accounts', 'access_token', account?.id ?? '', {
        ciphertext: account?.refreshTokenEnc ?? new Uint8Array(),
        keyVersion: 1,
      }),
    ).rejects.toThrow(/decryption failed/);
  });

  it('signs a returning user in from a token with no email and keeps the stored name', async () => {
    const sub = `00${crypto.randomUUID().replaceAll('-', '')}.returning`;
    const first = await appleNativeSignIn({ sub, fullName: { givenName: 'Grace' } });
    const firstBody = await first.response.json<SignInBody>();
    expect(first.response.status).toBe(200);

    const second = await appleNativeSignIn({
      sub,
      email: null,
      fullName: { givenName: 'Impostor' },
    });
    const secondBody = await second.response.json<SignInBody>();

    expect(second.response.status).toBe(200);
    expect(secondBody.isRegister).toBe(false);
    expect(secondBody.user?.id).toBe(firstBody.user?.id);
    expect(secondBody.user?.name).toBe('Grace');
    expect(secondBody.user?.email).toBe(firstBody.user?.email);
  });

  it('refuses a brand-new subject whose token carries no email with 400 email_required', async () => {
    const sub = `00${crypto.randomUUID().replaceAll('-', '')}.managed`;
    const { response } = await appleNativeSignIn({ sub, email: null });
    const body = await response.json<SignInBody>();

    expect(response.status).toBe(400);
    expect(body.code).toBe('EMAIL_REQUIRED');
    expect(await accountFor(sub)).toBeNull();
  });

  it('answers 401 code_exchange_failed when Apple rejects the code, and creates nothing', async () => {
    const sub = `00${crypto.randomUUID().replaceAll('-', '')}.badcode`;
    const { response } = await appleNativeSignIn({ sub, authorizationCode: 'invalid-code' });
    const body = await response.json<SignInBody>();

    expect(response.status).toBe(401);
    expect(body.code).toBe('CODE_EXCHANGE_FAILED');
    expect(await accountFor(sub)).toBeNull();
    expect(cookiesFrom(response)).toBeNull();
  });

  it('caps and sanitises fullName rather than storing what the client sent', async () => {
    const { response } = await appleNativeSignIn({
      fullName: { givenName: `‮${'a'.repeat(150)}`, familyName: 'b​' },
    });
    const body = await response.json<SignInBody>();

    expect(response.status).toBe(200);
    expect(body.user?.name).toHaveLength(100);
    expect(body.user?.name).not.toContain('‮');
  });

  it('upgrades an anonymous user: merged exactly once, and the anonymous after-hook fired too', async () => {
    const anonymous = await signInAnonymously();
    const installId = uniqueInstallId('apple-upgrade');
    expect((await registerDevice(anonymous, installId)).status).toBe(200);

    const { result, lines } = await captureLogs(() =>
      appleNativeSignIn({ cookie: anonymous.cookie, ip: anonymous.ip }),
    );
    const body = await result.response.json<SignInBody>();

    expect(result.response.status).toBe(200);
    expect(body.user?.id).not.toBe(anonymous.userId);

    // Both callers asked; the merge ran once; the queue message went out once.
    const requested = logEvents(lines, 'merge_requested');
    expect(requested.map((line) => line['source']).sort()).toEqual(
      ['anonymous_hook', 'apple_native'].sort(),
    );
    expect(requested.every((line) => line['merge_from'] === anonymous.userId)).toBe(true);
    expect(logEvents(lines, 'merge_committed')).toHaveLength(1);
    expect(logEvents(lines, 'merge_enqueue_failed')).toHaveLength(0);

    const [device] = await withDb(testEnv, (db) =>
      db
        .select({ userId: devices.userId })
        .from(devices)
        .where(eq(devices.installId, installId))
        .limit(1),
    );
    expect(device?.userId).toBe(body.user?.id);
    const [fromRow] = await withDb(testEnv, (db) =>
      db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, anonymous.userId))
        .limit(1),
    );
    expect(fromRow?.status).toBe('deleting');

    // The old session is revoked (the token alone hits the database; the cache cookie would
    // answer for up to 300 s, see auth-anonymous.test.ts), the new cookie works.
    const stale = await worker(
      jsonRequest('/v1/me', 'GET', undefined, {
        ip: uniqueIp(),
        cookie: sessionTokenOnly(anonymous.cookie),
      }),
    );
    expect(stale.status).toBe(401);
    const fresh = await worker(
      jsonRequest('/v1/me', 'GET', undefined, {
        ip: uniqueIp(),
        cookie: cookiesFrom(result.response),
      }),
    );
    expect((await fresh.json<{ user: { id: string } }>()).user.id).toBe(body.user?.id);
  });
});
