/**
 * Google native sign-in through the real Worker against the fake Google JWKS the test run serves.
 *
 * What is pinned: `iss` in both forms, `aud` in any of the three client ids, `exp`, and the nonce
 * REQUIRED and compared exactly (a token without a nonce is 400); no provider token is written to
 * `accounts`; an anonymous session that signs in with Google is merged exactly once, with the
 * anonymous after-hook proven to fire for this plugin endpoint over HTTP.
 */

import { eq } from 'drizzle-orm';
import { accounts, users, withDb } from '@planeahead/db';
import { describe, expect, it } from 'vitest';
import { GOOGLE_ISSUERS } from '../../src/auth/google-verify';
import {
  appleNativeSignIn,
  captureLogs,
  cookiesFrom,
  googleNativeSignIn,
  jsonRequest,
  logEvents,
  signInAnonymously,
  testEnv,
  uniqueEmail,
  uniqueIp,
  worker,
} from './helpers/auth';

interface SignInBody {
  readonly user?: { id: string; email: string; name: string; isAnonymous: boolean };
  readonly isRegister?: boolean;
  readonly code?: string;
}

describe('POST /api/auth/sign-in/google-native', () => {
  it('rejects a token without a nonce claim, and a body without rawNonce, with 400', async () => {
    const noClaim = await googleNativeSignIn({ nonceClaim: null });
    const noBody = await googleNativeSignIn({ sendRawNonce: false });

    expect(noClaim.response.status).toBe(400);
    expect((await noClaim.response.json<SignInBody>()).code).toBe('NONCE_REQUIRED');
    expect(noBody.response.status).toBe(400);
    expect((await noBody.response.json<SignInBody>()).code).toBe('NONCE_REQUIRED');
  });

  it('rejects a nonce that differs from rawNonce with 401', async () => {
    const { response } = await googleNativeSignIn({ nonceClaim: 'someone-elses-nonce' });

    expect(response.status).toBe(401);
    expect((await response.json<SignInBody>()).code).toBe('NONCE_MISMATCH');
  });

  it('accepts both issuer forms and each of the three client ids', async () => {
    const audiences = [
      testEnv.GOOGLE_CLIENT_ID_WEB,
      testEnv.GOOGLE_CLIENT_ID_IOS,
      testEnv.GOOGLE_CLIENT_ID_ANDROID,
    ];
    for (const issuer of GOOGLE_ISSUERS) {
      for (const audience of audiences) {
        const { response } = await googleNativeSignIn({ issuer, audience: audience ?? '' });
        expect(response.status, `${issuer} ${audience ?? ''}`).toBe(200);
      }
    }
  });

  it('rejects a foreign audience, a foreign issuer and an expired token with 401', async () => {
    const audience = await googleNativeSignIn({ audience: 'other.apps.googleusercontent.com' });
    const issuer = await googleNativeSignIn({ issuer: 'https://accounts.google.example' });
    const expired = await googleNativeSignIn({
      issuedAt: Math.floor(Date.now() / 1000) - 7200,
      lifetime: 3600,
    });

    for (const { response } of [audience, issuer, expired]) {
      expect(response.status).toBe(401);
      expect((await response.json<SignInBody>()).code).toBe('INVALID_IDENTITY_TOKEN');
    }
  });

  it('signs a new user in with a lower-cased email, a cookie, and no provider token stored', async () => {
    const sub = `1${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const email = `Mixed-${crypto.randomUUID()}@Example.Test`;
    const { response } = await googleNativeSignIn({ sub, email });
    const body = await response.json<SignInBody>();

    expect(response.status).toBe(200);
    expect(body.isRegister).toBe(true);
    expect(body.user?.email).toBe(email.toLowerCase());
    expect(body.user?.name).toBe('Google Person');
    expect(cookiesFrom(response)).toContain('better-auth.session_token=');

    const [account] = await withDb(testEnv, (db) =>
      db
        .select({
          providerId: accounts.providerId,
          accessToken: accounts.accessToken,
          refreshToken: accounts.refreshToken,
          idToken: accounts.idToken,
          refreshTokenEnc: accounts.refreshTokenEnc,
        })
        .from(accounts)
        .where(eq(accounts.accountId, sub))
        .limit(1),
    );
    expect(account?.providerId).toBe('google');
    expect(account?.accessToken).toBeNull();
    expect(account?.refreshToken).toBeNull();
    expect(account?.idToken).toBeNull();
    expect(account?.refreshTokenEnc).toBeNull();

    const again = await googleNativeSignIn({ sub, email });
    const againBody = await again.response.json<SignInBody>();
    expect(again.response.status).toBe(200);
    expect(againBody.isRegister).toBe(false);
    expect(againBody.user?.id).toBe(body.user?.id);
  });

  it('upgrades an anonymous user: merged exactly once, and the anonymous after-hook fired too', async () => {
    const anonymous = await signInAnonymously();

    const { result, lines } = await captureLogs(() =>
      googleNativeSignIn({ cookie: anonymous.cookie, ip: anonymous.ip }),
    );
    const body = await result.response.json<SignInBody>();

    expect(result.response.status).toBe(200);
    expect(body.user?.id).not.toBe(anonymous.userId);
    const requested = logEvents(lines, 'merge_requested');
    expect(requested.map((line) => line['source']).sort()).toEqual(
      ['anonymous_hook', 'google_native'].sort(),
    );
    expect(logEvents(lines, 'merge_committed')).toHaveLength(1);

    const [fromRow] = await withDb(testEnv, (db) =>
      db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, anonymous.userId))
        .limit(1),
    );
    expect(fromRow?.status).toBe('deleting');
  });

  it('accepts a multi-audience token only with an azp that is ours, and never one issued to another client', async () => {
    const ours = testEnv.GOOGLE_CLIENT_ID_IOS ?? '';
    const android = testEnv.GOOGLE_CLIENT_ID_ANDROID ?? '';
    const foreign = 'other-app.apps.googleusercontent.com';

    const androidShape = await googleNativeSignIn({
      audience: testEnv.GOOGLE_CLIENT_ID_WEB ?? '',
      claims: { azp: android },
    });
    const multiOurs = await googleNativeSignIn({
      audience: [foreign, ours],
      claims: { azp: ours },
    });
    const multiNoAzp = await googleNativeSignIn({ audience: [foreign, ours] });
    const foreignAzp = await googleNativeSignIn({
      audience: [foreign, ours],
      claims: { azp: foreign },
    });

    expect(androidShape.response.status).toBe(200);
    expect(multiOurs.response.status).toBe(200);
    expect(multiNoAzp.response.status).toBe(401);
    expect((await multiNoAzp.response.json<SignInBody>()).code).toBe('INVALID_IDENTITY_TOKEN');
    expect(foreignAzp.response.status).toBe(401);
    expect(cookiesFrom(foreignAzp.response)).toBeNull();
  });

  it('refuses email_verified=false with 403 and creates no user, so the address owner is not blocked', async () => {
    const sub = `1${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const email = uniqueEmail('unverified');
    const { response } = await googleNativeSignIn({
      sub,
      email,
      claims: { email_verified: false },
    });
    const body = await response.json<SignInBody>();

    expect(response.status).toBe(403);
    expect(body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(cookiesFrom(response)).toBeNull();
    const rows = await withDb(testEnv, (db) =>
      db.select({ id: users.id }).from(users).where(eq(users.email, email)),
    );
    expect(rows).toHaveLength(0);

    // The address owner signs in with Apple afterwards without an ACCOUNT_NOT_LINKED refusal.
    const apple = await appleNativeSignIn({ email });
    expect(apple.response.status).toBe(200);
  });

  it('refuses the same identity token a second time (replay), from any address', async () => {
    const first = await googleNativeSignIn();
    expect(first.response.status).toBe(200);

    const replay = await worker(
      jsonRequest(
        '/api/auth/sign-in/google-native',
        'POST',
        { identityToken: first.identityToken, rawNonce: first.rawNonce },
        { ip: uniqueIp(), cookie: null },
      ),
    );
    const body = await replay.json<SignInBody>();

    expect(replay.status).toBe(401);
    expect(body.code).toBe('IDENTITY_TOKEN_REPLAYED');
    expect(cookiesFrom(replay)).toBeNull();
    // The marker lives in the CACHE namespace under a digest, never the token itself.
    const keys = await testEnv.CACHE.list({ prefix: 'used_id_tokens:google:' });
    expect(keys.keys.length).toBeGreaterThan(0);
    expect(keys.keys.every((key) => !key.name.includes(first.identityToken))).toBe(true);
  });
});
