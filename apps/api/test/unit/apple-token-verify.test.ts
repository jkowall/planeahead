import { describe, expect, it } from 'vitest';
import {
  APPLE_ISSUER,
  AppleExchangeError,
  exchangeAppleAuthorizationCode,
  parseBoolClaim,
  sanitizeFullName,
  verifyAppleIdentityToken,
} from '../../src/auth/apple-native';
import { localIdp, mintToken, sha256Hex } from '../workers/helpers/idp';

const audience = 'app.planeahead.test';

async function appleToken(
  idp: Awaited<ReturnType<typeof localIdp>>,
  claims: Record<string, unknown>,
  extra: { issuedAt?: number; lifetime?: number; audience?: string; issuer?: string } = {},
) {
  return mintToken(idp.privateKey, idp.kid, {
    issuer: extra.issuer ?? APPLE_ISSUER,
    audience: extra.audience ?? audience,
    subject: '001234.abcdef.5678',
    claims,
    ...(extra.issuedAt === undefined ? {} : { issuedAt: extra.issuedAt }),
    ...(extra.lifetime === undefined ? {} : { lifetime: extra.lifetime }),
  });
}

describe('verifyAppleIdentityToken', () => {
  it('accepts RS256 with the hashed nonce and parses string booleans', async () => {
    const idp = await localIdp();
    const token = await appleToken(idp, {
      nonce: await sha256Hex('raw-nonce-1'),
      email: 'Someone@PrivateRelay.AppleID.com',
      email_verified: 'true',
      is_private_email: 'true',
    });

    const claims = await verifyAppleIdentityToken(token, {
      getKey: idp.getKey,
      audience,
      rawNonce: 'raw-nonce-1',
    });

    expect(claims).toEqual({
      sub: '001234.abcdef.5678',
      email: 'someone@privaterelay.appleid.com',
      emailVerified: true,
      isPrivateEmail: true,
    });
  });

  it('accepts a token without an email (returning user or managed Apple ID)', async () => {
    const idp = await localIdp();
    const token = await appleToken(idp, { nonce: await sha256Hex('n'), email_verified: true });
    const claims = await verifyAppleIdentityToken(token, {
      getKey: idp.getKey,
      audience,
      rawNonce: 'n',
    });
    expect(claims.email).toBeNull();
    expect(claims.isPrivateEmail).toBe(false);
  });

  it('rejects a missing, raw (unhashed) or foreign nonce as nonce_mismatch', async () => {
    const idp = await localIdp();
    const options = { getKey: idp.getKey, audience, rawNonce: 'n' };
    const missing = await appleToken(idp, {});
    const unhashed = await appleToken(idp, { nonce: 'n' });
    const foreign = await appleToken(idp, { nonce: await sha256Hex('other') });

    for (const token of [missing, unhashed, foreign]) {
      await expect(verifyAppleIdentityToken(token, options)).rejects.toMatchObject({
        code: 'nonce_mismatch',
      });
    }
  });

  it('rejects a token older than an hour even when exp is still in the future', async () => {
    const idp = await localIdp();
    const issuedAt = Math.floor(Date.now() / 1000) - 3601;
    const token = await appleToken(
      idp,
      { nonce: await sha256Hex('n') },
      { issuedAt, lifetime: 24 * 3600 },
    );
    await expect(
      verifyAppleIdentityToken(token, { getKey: idp.getKey, audience, rawNonce: 'n' }),
    ).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('rejects a wrong audience, a wrong issuer and an unknown signing key', async () => {
    const idp = await localIdp();
    const other = await localIdp('other-kid');
    const nonce = await sha256Hex('n');
    const options = { getKey: idp.getKey, audience, rawNonce: 'n' };
    const cases = await Promise.all([
      appleToken(idp, { nonce }, { audience: 'app.other' }),
      appleToken(idp, { nonce }, { issuer: 'https://appleid.example' }),
      mintToken(other.privateKey, other.kid, {
        issuer: APPLE_ISSUER,
        audience,
        subject: 's',
        claims: { nonce },
      }),
    ]);
    for (const token of cases) {
      await expect(verifyAppleIdentityToken(token, options)).rejects.toMatchObject({
        code: 'invalid_token',
      });
    }
  });
});

describe('parseBoolClaim', () => {
  it('accepts booleans and the strings Apple sends', () => {
    expect(parseBoolClaim(true)).toBe(true);
    expect(parseBoolClaim('true')).toBe(true);
    expect(parseBoolClaim(false)).toBe(false);
    expect(parseBoolClaim('false')).toBe(false);
    expect(parseBoolClaim(undefined)).toBe(false);
    expect(parseBoolClaim('TRUE')).toBe(false);
  });
});

describe('sanitizeFullName', () => {
  it('joins the parts, trims, collapses whitespace and strips controls', () => {
    const nul = String.fromCharCode(0);
    expect(sanitizeFullName({ givenName: '  Ada ', familyName: `Lovelace${nul}` })).toBe(
      'Ada Lovelace',
    );
    expect(sanitizeFullName({ givenName: 'Ada', middleName: 'K', familyName: 'L' })).toBe(
      'Ada K L',
    );
    expect(sanitizeFullName('Line\nBreak\tTab')).toBe('Line Break Tab');
    const zeroWidth = String.fromCharCode(0x200b);
    const bidiOverride = String.fromCharCode(0x202e);
    expect(sanitizeFullName({ givenName: `A${zeroWidth}B${bidiOverride}C` })).toBe('ABC');
    expect(sanitizeFullName('Zoë Ñandú 李雷')).toBe('Zoë Ñandú 李雷');
  });

  it('returns null for nothing usable and caps at 100 characters', () => {
    expect(sanitizeFullName(undefined)).toBeNull();
    expect(sanitizeFullName({ givenName: null, familyName: '   ' })).toBeNull();
    expect(sanitizeFullName(String.fromCharCode(7, 8))).toBeNull();
    expect(sanitizeFullName('a'.repeat(250))).toHaveLength(100);
  });
});

describe('exchangeAppleAuthorizationCode', () => {
  it('posts the four form fields without redirect_uri and returns the refresh token', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const stub: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      seen = { url, init: init ?? {} };
      return Promise.resolve(
        new Response(
          JSON.stringify({ refresh_token: 'rt_1', access_token: 'at', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };

    const result = await exchangeAppleAuthorizationCode({
      code: 'c-1',
      clientId: audience,
      clientSecret: 'cs',
      tokenUrl: 'https://apple.test/auth/token',
      fetch: stub,
    });

    expect(result).toEqual({ refreshToken: 'rt_1', accessToken: 'at', expiresIn: 3600 });
    const request = seen as { url: string; init: RequestInit } | null;
    expect(request?.url).toBe('https://apple.test/auth/token');
    const rawBody = request?.init.body;
    const form = new URLSearchParams(typeof rawBody === 'string' ? rawBody : '');
    expect(Object.fromEntries(form)).toEqual({
      client_id: audience,
      client_secret: 'cs',
      code: 'c-1',
      grant_type: 'authorization_code',
    });
    expect(form.has('redirect_uri')).toBe(false);
  });

  it('turns an Apple error into AppleExchangeError with the status and the error code only', async () => {
    const stub: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'secret detail' }),
          { status: 400 },
        ),
      );
    const failure = exchangeAppleAuthorizationCode({
      code: 'c',
      clientId: audience,
      clientSecret: 'cs',
      fetch: stub,
    });
    await expect(failure).rejects.toBeInstanceOf(AppleExchangeError);
    await expect(failure).rejects.toMatchObject({ status: 400, reason: 'invalid_grant' });
    await expect(failure).rejects.not.toThrow(/secret detail/);
  });

  it('treats a 200 without a refresh token as a failure', async () => {
    const stub: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ access_token: 'only' }), { status: 200 }));
    await expect(
      exchangeAppleAuthorizationCode({
        code: 'c',
        clientId: audience,
        clientSecret: 'cs',
        fetch: stub,
      }),
    ).rejects.toMatchObject({ reason: 'no_refresh_token' });
  });
});
