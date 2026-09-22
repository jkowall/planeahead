/**
 * The Apple client secret, on the real runtime. The first test is the one the facts sheet asked
 * for before any of this was written: workerd's `importKey('pkcs8', ...)` for ECDSA P-256, which
 * the runtime's supported-algorithms table does not enumerate by curve or format.
 */

import { env } from 'cloudflare:workers';
import { decodeProtectedHeader, importPKCS8, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import {
  APPLE_AUDIENCE,
  AppleKeyError,
  CLIENT_SECRET_CACHE_SECONDS,
  CLIENT_SECRET_LIFETIME_SECONDS,
  createAppleClientSecretCache,
  importApplePrivateKey,
  mintAppleClientSecret,
  normalisePem,
} from '../../src/auth/apple-client-secret';

const config = {
  teamId: 'TESTTEAM01',
  keyId: 'TESTKEY001',
  clientId: 'app.planeahead.test',
  privateKeyPem: (env as Env).APPLE_SIWA_P8 ?? '',
};

describe('importApplePrivateKey', () => {
  it('imports the escaped PKCS8 PEM from .dev.vars.test as an ES256 key on workerd', async () => {
    expect(config.privateKeyPem).toContain('\\n');
    const key = await importApplePrivateKey(config.privateKeyPem);

    expect(key.type).toBe('private');
    expect(key.algorithm).toMatchObject({ name: 'ECDSA', namedCurve: 'P-256' });
    expect(key.usages).toContain('sign');
  });

  it('rejects a PEM that is not PKCS8 with its own error', async () => {
    await expect(
      importApplePrivateKey('-----BEGIN EC PRIVATE KEY-----\nabc\n-----END'),
    ).rejects.toBeInstanceOf(AppleKeyError);
    await expect(
      importApplePrivateKey('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'),
    ).rejects.toBeInstanceOf(AppleKeyError);
  });

  it('normalises the backslash-n escapes a secret store flattens the key to', () => {
    expect(normalisePem('a\\nb\\n')).toBe('a\nb');
    expect(normalisePem('a\nb')).toBe('a\nb');
  });
});

describe('mintAppleClientSecret', () => {
  it('signs ES256 with the key id and the documented claims', async () => {
    const now = Date.UTC(2026, 8, 21, 12, 0, 0);
    const secret = await mintAppleClientSecret(config, now);

    expect(decodeProtectedHeader(secret)).toEqual({ alg: 'ES256', kid: 'TESTKEY001' });
    // The Worker's own import is deliberately non-extractable; the test re-imports the PEM
    // extractable to derive the public half and verify the signature against it.
    const extractable = await importPKCS8(normalisePem(config.privateKeyPem), 'ES256', {
      extractable: true,
    });
    const exported = (await crypto.subtle.exportKey('jwk', extractable)) as JsonWebKey;
    const publicJwk: JsonWebKey = { ...exported };
    delete publicJwk.d;
    const verifyKey = await crypto.subtle.importKey(
      'jwk',
      { ...publicJwk, key_ops: ['verify'] },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const { payload } = await jwtVerify(secret, verifyKey, {
      issuer: 'TESTTEAM01',
      audience: APPLE_AUDIENCE,
      subject: 'app.planeahead.test',
      currentDate: new Date(now),
    });
    expect(payload.iat).toBe(Math.floor(now / 1000));
    expect(payload.exp).toBe(Math.floor(now / 1000) + CLIENT_SECRET_LIFETIME_SECONDS);
  });
});

describe('the client secret cache', () => {
  it('serves one secret for 55 minutes and mints a new one after', async () => {
    const cache = createAppleClientSecretCache();
    const t0 = Date.UTC(2026, 8, 21, 12, 0, 0);

    const first = await cache.get(config, t0);
    const withinWindow = await cache.get(config, t0 + (CLIENT_SECRET_CACHE_SECONDS - 1) * 1000);
    const afterWindow = await cache.get(config, t0 + (CLIENT_SECRET_CACHE_SECONDS + 1) * 1000);

    expect(withinWindow).toBe(first);
    expect(afterWindow).not.toBe(first);
  });

  it('keys the cache by the whole configuration', async () => {
    const cache = createAppleClientSecretCache();
    const t0 = Date.UTC(2026, 8, 21, 12, 0, 0);
    const a = await cache.get(config, t0);
    const b = await cache.get({ ...config, keyId: 'OTHERKEY02' }, t0);
    expect(a).not.toBe(b);
  });
});
