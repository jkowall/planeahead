import { describe, expect, it } from 'vitest';
import {
  GOOGLE_ISSUERS,
  GoogleTokenError,
  verifyGoogleIdToken,
} from '../../src/auth/google-verify';
import { localIdp, mintToken } from '../workers/helpers/idp';

const audiences = ['web.apps.googleusercontent.com', 'ios.apps.googleusercontent.com', 'android.x'];
const WEB = audiences[0] ?? '';
const ANDROID = audiences[2] ?? '';

describe('verifyGoogleIdToken', () => {
  it('accepts a token with either issuer form, any of the three client ids and the nonce', async () => {
    const idp = await localIdp();
    for (const issuer of GOOGLE_ISSUERS) {
      for (const audience of audiences) {
        const token = await mintToken(idp.privateKey, idp.kid, {
          issuer,
          audience,
          subject: '1234567890',
          claims: { email: 'Person@Example.com', email_verified: true, nonce: 'n-1', name: 'P' },
        });
        const claims = await verifyGoogleIdToken(token, {
          getKey: idp.getKey,
          audiences,
          rawNonce: 'n-1',
        });
        expect(claims).toMatchObject({
          sub: '1234567890',
          email: 'person@example.com',
          emailVerified: true,
          name: 'P',
          picture: null,
          aud: audience,
          jti: null,
        });
        expect(claims.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
      }
    }
  });

  it('rejects a token with no nonce and one with a wrong nonce, with distinct codes', async () => {
    const idp = await localIdp();
    const base = { issuer: GOOGLE_ISSUERS[0], audience: WEB, subject: 's' };
    const noNonce = await mintToken(idp.privateKey, idp.kid, {
      ...base,
      claims: { email: 'a@b.c', email_verified: true },
    });
    const wrongNonce = await mintToken(idp.privateKey, idp.kid, {
      ...base,
      claims: { email: 'a@b.c', email_verified: true, nonce: 'other' },
    });
    const options = { getKey: idp.getKey, audiences, rawNonce: 'n-1' };

    await expect(verifyGoogleIdToken(noNonce, options)).rejects.toMatchObject({
      code: 'nonce_required',
    });
    await expect(verifyGoogleIdToken(wrongNonce, options)).rejects.toMatchObject({
      code: 'nonce_mismatch',
    });
  });

  it('rejects a foreign audience, a foreign issuer, an unknown key and an expired token', async () => {
    const idp = await localIdp();
    const other = await localIdp('other');
    const good = { email: 'a@b.c', email_verified: true, nonce: 'n' };
    const options = { getKey: idp.getKey, audiences, rawNonce: 'n' };
    const cases = [
      mintToken(idp.privateKey, idp.kid, {
        issuer: GOOGLE_ISSUERS[0],
        audience: 'someone-else',
        subject: 's',
        claims: good,
      }),
      mintToken(idp.privateKey, idp.kid, {
        issuer: 'https://accounts.google.example',
        audience: WEB,
        subject: 's',
        claims: good,
      }),
      mintToken(other.privateKey, other.kid, {
        issuer: GOOGLE_ISSUERS[0],
        audience: WEB,
        subject: 's',
        claims: good,
      }),
      mintToken(idp.privateKey, idp.kid, {
        issuer: GOOGLE_ISSUERS[0],
        audience: WEB,
        subject: 's',
        claims: good,
        issuedAt: Math.floor(Date.now() / 1000) - 7200,
        lifetime: 3600,
      }),
    ];
    for (const token of await Promise.all(cases)) {
      await expect(verifyGoogleIdToken(token, options)).rejects.toMatchObject({
        code: 'invalid_token',
      });
    }
  });

  it('requires azp on a multi-audience token and requires azp, when present, to be ours', async () => {
    const idp = await localIdp();
    const good = { email: 'a@b.c', email_verified: true, nonce: 'n' };
    const options = { getKey: idp.getKey, audiences, rawNonce: 'n' };
    const mint = (audience: string | string[], claims: Record<string, unknown>) =>
      mintToken(idp.privateKey, idp.kid, {
        issuer: GOOGLE_ISSUERS[0],
        audience,
        subject: 's',
        claims: { ...good, ...claims },
      });

    // Android: aud is the web client id, azp the Android client id, both ours.
    const android = await verifyGoogleIdToken(await mint(WEB, { azp: ANDROID }), options);
    expect(android.aud).toBe(WEB);
    // Several audiences including ours, azp ours: accepted, and `aud` reports ours.
    const multi = await verifyGoogleIdToken(
      await mint(['other-app.apps.googleusercontent.com', WEB], { azp: WEB }),
      options,
    );
    expect(multi.aud).toBe(WEB);

    // Several audiences, no azp: refused even though one of them is ours.
    await expect(
      verifyGoogleIdToken(await mint(['other-app.apps.googleusercontent.com', WEB], {}), options),
    ).rejects.toMatchObject({ code: 'azp_required' });
    // azp names another client: refused, single or multiple audiences alike.
    await expect(
      verifyGoogleIdToken(
        await mint(['other-app.apps.googleusercontent.com', WEB], { azp: 'other-app' }),
        options,
      ),
    ).rejects.toMatchObject({ code: 'azp_mismatch' });
    await expect(
      verifyGoogleIdToken(await mint(WEB, { azp: 'other-app' }), options),
    ).rejects.toMatchObject({ code: 'azp_mismatch' });
  });

  it('rejects an unverified email with its own code, so no account is created for it', async () => {
    const idp = await localIdp();
    const options = { getKey: idp.getKey, audiences, rawNonce: 'n' };
    for (const emailVerified of [false, 'true', undefined]) {
      const token = await mintToken(idp.privateKey, idp.kid, {
        issuer: GOOGLE_ISSUERS[0],
        audience: WEB,
        subject: 's',
        claims: { email: 'a@b.c', nonce: 'n', email_verified: emailVerified },
      });
      await expect(verifyGoogleIdToken(token, options)).rejects.toMatchObject({
        code: 'email_not_verified',
      });
    }
  });

  it('requires an email and a configured audience list', async () => {
    const idp = await localIdp();
    const token = await mintToken(idp.privateKey, idp.kid, {
      issuer: GOOGLE_ISSUERS[0],
      audience: WEB,
      subject: 's',
      claims: { nonce: 'n' },
    });
    await expect(
      verifyGoogleIdToken(token, { getKey: idp.getKey, audiences, rawNonce: 'n' }),
    ).rejects.toMatchObject({ code: 'email_required' });
    await expect(
      verifyGoogleIdToken(token, { getKey: idp.getKey, audiences: [], rawNonce: 'n' }),
    ).rejects.toBeInstanceOf(GoogleTokenError);
  });
});
