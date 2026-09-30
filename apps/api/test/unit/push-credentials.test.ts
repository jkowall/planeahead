/**
 * Push credentials on the real runtime (increment 14, ruling P3): the APNs provider token's
 * signature format (WebCrypto's raw R||S, a standard JWS ES256), the FCM assertion and its
 * exchange with an injected `fetch`, the mint window as pure rules, the isolate cache in front of
 * the `PushAuth` objects, and the configuration check. `test/workers/push-auth.test.ts` drives the
 * object itself. The review round: the gap after a failed FCM exchange (ruling R8) and the key
 * fingerprint over DER bytes, the same for either newline form of one key (ruling R9).
 */

import { decodeProtectedHeader, importPKCS8, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { PushCredentialName } from '@planeahead/shared';
import type { Env } from '../../src/env';
import { normalisePem } from '../../src/auth/apple-client-secret';
import { apnsMaterial, fcmServiceAccount, pushConfiguration } from '../../src/push/config';
import {
  APNS_MAX_TOKEN_AGE_MS,
  APNS_MIN_MINT_GAP_MS,
  APNS_TOKEN_WINDOW_MS,
  FCM_ASSERTION_LIFETIME_SECONDS,
  FCM_EXPIRY_MARGIN_MS,
  FCM_MIN_EXCHANGE_GAP_MS,
  FCM_OAUTH_SCOPE,
  GOOGLE_OAUTH_TOKEN_URL,
  PushCredentialError,
  credentialDecision,
  credentialMaterial,
  durableCredentialSource,
  exchangeFcmAccessToken,
  materialFingerprint,
  mintApnsProviderToken,
  notAfterFor,
  remintAtMs,
  signFcmAssertion,
  withinFailureGap,
  type CachedCredential,
  type PushAuthStub,
  type PushCredentialResult,
  type StoredCredential,
} from '../../src/push/credentials';
import { fromBase64Url } from '../../src/push/jwt';
import { fakeFetch, publicKeyOf, testEnv, testServiceAccount } from './helpers/push';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const MINUTE = 60_000;

function decodePart(part: string | undefined): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(part ?? ''))) as Record<string, unknown>;
}

async function verifies(
  jwt: string,
  key: CryptoKey,
  params: Parameters<typeof crypto.subtle.verify>[0],
) {
  const [header = '', claims = '', signature = ''] = jwt.split('.');
  return crypto.subtle.verify(
    params,
    key,
    fromBase64Url(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );
}

describe('the APNs provider token', () => {
  const material = (() => {
    const result = apnsMaterial(testEnv);
    if (!result.ok) {
      throw new Error(`the suite's APNs secrets are not configured: ${result.problems.join('; ')}`);
    }
    return result.value;
  })();

  it('is ES256 with the key id, the team id as iss and iat, and nothing else', async () => {
    const token = await mintApnsProviderToken(material, NOW);
    const [header, claims] = token.split('.');

    expect(decodePart(header)).toEqual({ alg: 'ES256', kid: 'TESTAPNS01' });
    expect(decodePart(claims)).toEqual({ iss: 'TESTTEAM02', iat: NOW / 1000 });
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: 'TESTAPNS01' });
  });

  it('carries the raw 64-byte R||S signature WebCrypto makes, which verifies as a JWS', async () => {
    const token = await mintApnsProviderToken(material, NOW);
    const signature = fromBase64Url(token.split('.')[2] ?? '');

    // DER would be 70 to 72 bytes and start with 0x30; JWS ES256 is r and s, 32 bytes each.
    expect(signature).toHaveLength(64);
    const publicKey = await publicKeyOf(material.keyPem, 'ES256');
    expect(await verifies(token, publicKey, { name: 'ECDSA', hash: 'SHA-256' })).toBe(true);
    // And a standard JOSE library accepts it as ES256, the way APNs does.
    const { payload } = await jwtVerify(token, publicKey, { algorithms: ['ES256'] });
    expect(payload).toEqual({ iss: 'TESTTEAM02', iat: NOW / 1000 });
  });

  it('is a fresh signature each time (ECDSA is randomised), so only one object may mint', async () => {
    expect(await mintApnsProviderToken(material, NOW)).not.toBe(
      await mintApnsProviderToken(material, NOW),
    );
  });
});

describe('the FCM assertion and its exchange', () => {
  const account = (() => {
    const result = fcmServiceAccount(testEnv);
    if (!result.ok) {
      throw new Error(
        `the suite's service account is not configured: ${result.problems.join('; ')}`,
      );
    }
    return result.value;
  })();

  it('signs RS256 with iss, scope, aud, iat and a one-hour exp', async () => {
    const assertion = await signFcmAssertion(account, NOW);
    const [header, claims] = assertion.split('.');
    const iat = NOW / 1000;

    expect(decodePart(header)).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: testServiceAccount().private_key_id,
    });
    expect(decodePart(claims)).toEqual({
      iss: 'push-sender@planeahead-test.iam.gserviceaccount.com',
      scope: FCM_OAUTH_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat,
      exp: iat + FCM_ASSERTION_LIFETIME_SECONDS,
    });
    const publicKey = await publicKeyOf(account.privateKeyPem, 'RS256');
    expect(await verifies(assertion, publicKey, { name: 'RSASSA-PKCS1-v1_5' })).toBe(true);
    const imported = await importPKCS8(account.privateKeyPem, 'RS256');
    expect(imported.type).toBe('private');
  });

  it('exchanges the assertion at the token endpoint for an access token', async () => {
    const fake = fakeFetch(() =>
      Response.json({
        access_token: 'ya29.test-access-token',
        expires_in: 3599,
        token_type: 'Bearer',
      }),
    );

    const result = await exchangeFcmAccessToken(account, NOW, fake.fetch);

    expect(result).toEqual({
      ok: true,
      accessToken: 'ya29.test-access-token',
      expiresInSeconds: 3599,
    });
    const request = fake.requests[0];
    expect(request?.url).toBe('https://oauth2.googleapis.com/token');
    expect(request?.method).toBe('POST');
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    const form = new URLSearchParams(request?.body ?? '');
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = form.get('assertion') ?? '';
    const publicKey = await publicKeyOf(account.privateKeyPem, 'RS256');
    expect(await verifies(assertion, publicKey, { name: 'RSASSA-PKCS1-v1_5' })).toBe(true);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('calls a refused account rejected, and anything transient unavailable', async () => {
    let cancelled = false;
    const refusal = () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 400 },
      );
    const cases: [() => Response | Promise<Response>, string][] = [
      [refusal, 'credentials_rejected'],
      [
        () => new Response('{"error":"unauthorized_client"}', { status: 401 }),
        'credentials_rejected',
      ],
      [() => new Response('busy', { status: 503 }), 'exchange_unavailable'],
      [() => new Response('slow down', { status: 429 }), 'exchange_unavailable'],
      [() => Promise.reject(new TypeError('network lost')), 'exchange_unavailable'],
      [() => new Response('not json', { status: 200 }), 'exchange_unavailable'],
      [() => Response.json({ access_token: '', expires_in: 3600 }), 'exchange_unavailable'],
    ];
    for (const [respond, failure] of cases) {
      const result = await exchangeFcmAccessToken(account, NOW, fakeFetch(respond).fetch);
      expect(result).toMatchObject({ ok: false, failure });
    }
    expect(cancelled).toBe(true);
  });

  it('serves an access token until five minutes before it expires', () => {
    expect(notAfterFor('fcm', NOW, 3600)).toBe(NOW + 3600_000 - FCM_EXPIRY_MARGIN_MS);
    expect(notAfterFor('fcm', NOW, 300)).toBe(NOW + 150_000);
    expect(notAfterFor('apns', NOW)).toBe(NOW + APNS_TOKEN_WINDOW_MS);
  });
});

describe('the mint window (ruling P3)', () => {
  const row = (overrides: Partial<StoredCredential> = {}): StoredCredential => ({
    token: 'token',
    fingerprint: 'fp',
    mintedAtMs: NOW,
    notAfterMs: NOW + APNS_TOKEN_WINDOW_MS,
    mintCount: 1,
    ...overrides,
  });

  it('mints the first token, serves it for 30 minutes, then mints again', () => {
    expect(credentialDecision('apns:sandbox', null, 'fp', NOW)).toBe('mint');
    expect(credentialDecision('apns:sandbox', row(), 'fp', NOW + 29 * MINUTE)).toBe('serve');
    expect(credentialDecision('apns:sandbox', row(), 'fp', NOW + 30 * MINUTE)).toBe('mint');
  });

  it('never mints within 20 minutes of the last mint, even after a refusal pulled the window in', () => {
    const expired = row({ notAfterMs: NOW + 5 * MINUTE });
    expect(credentialDecision('apns:production', expired, 'fp', NOW + 6 * MINUTE)).toBe('serve');
    expect(credentialDecision('apns:production', expired, 'fp', NOW + 19 * MINUTE)).toBe('serve');
    expect(credentialDecision('apns:production', expired, 'fp', NOW + 20 * MINUTE)).toBe('mint');
    expect(remintAtMs('apns:production', NOW, NOW + 6 * MINUTE)).toBe(NOW + APNS_MIN_MINT_GAP_MS);
    expect(remintAtMs('apns:production', NOW, NOW + 25 * MINUTE)).toBe(NOW + 25 * MINUTE);
  });

  it('replaces a token signed by a key the Worker no longer holds at once', () => {
    expect(credentialDecision('apns:sandbox', row(), 'rotated', NOW + MINUTE)).toBe('mint');
  });

  it('holds FCM to its own, shorter floor', () => {
    const fcm = row({ notAfterMs: NOW });
    expect(credentialDecision('fcm', fcm, 'fp', NOW + 30_000)).toBe('serve');
    expect(credentialDecision('fcm', fcm, 'fp', NOW + FCM_MIN_EXCHANGE_GAP_MS)).toBe('mint');
  });

  it('over six hours of sends and refusals: mints at least 20 minutes apart, no token older than an hour', () => {
    let stored: StoredCredential | null = null;
    const mints: number[] = [];
    let maxAge = 0;
    for (let t = NOW; t < NOW + 6 * 60 * MINUTE; t += MINUTE) {
      if (credentialDecision('apns:sandbox', stored, 'fp', t) === 'mint') {
        stored = row({ token: `t${String(t)}`, mintedAtMs: t, notAfterMs: notAfterFor('apns', t) });
        mints.push(t);
      }
      maxAge = Math.max(maxAge, t - (stored?.mintedAtMs ?? t));
      // A provider refusal every 7 minutes pulls the window in, as `expire` does.
      if ((t - NOW) % (7 * MINUTE) === 0 && stored !== null) {
        stored = { ...stored, notAfterMs: Math.min(stored.notAfterMs, t) };
      }
    }
    const gaps = mints.slice(1).map((mint, index) => mint - (mints[index] ?? 0));
    expect(mints.length).toBeGreaterThan(6);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(APNS_MIN_MINT_GAP_MS);
    expect(maxAge).toBeLessThanOrEqual(APNS_TOKEN_WINDOW_MS);
    expect(maxAge).toBeLessThan(APNS_MAX_TOKEN_AGE_MS);
  });
});

describe('the isolate cache in front of PushAuth', () => {
  function fakeObjects(answer: (name: PushCredentialName) => PushCredentialResult) {
    const calls: { rpc: 'current' | 'expire'; name: string }[] = [];
    const stubFor = (name: PushCredentialName): PushAuthStub => ({
      current: () => {
        calls.push({ rpc: 'current', name });
        return Promise.resolve(answer(name));
      },
      expire: () => {
        calls.push({ rpc: 'expire', name });
        return Promise.resolve({ remintAtMs: NOW + 20 * MINUTE });
      },
    });
    return { calls, stubFor };
  }
  const ok = (name: PushCredentialName): PushCredentialResult => ({
    ok: true,
    token: `minted-${name}`,
    mintedAtMs: NOW,
    notAfterMs: NOW + APNS_TOKEN_WINDOW_MS,
    fingerprint: 'fp',
  });

  it('asks the object once, then serves its token until the window ends', async () => {
    let now = NOW;
    const objects = fakeObjects(ok);
    const cache = new Map<string, CachedCredential>();
    const source = durableCredentialSource(testEnv, {
      cache,
      now: () => now,
      stubFor: objects.stubFor,
    });

    expect(await source.token('apns:sandbox')).toBe('minted-apns:sandbox');
    now += 29 * MINUTE;
    expect(await source.token('apns:sandbox')).toBe('minted-apns:sandbox');
    expect(objects.calls).toEqual([{ rpc: 'current', name: 'apns:sandbox' }]);
    now += MINUTE;
    await source.token('apns:sandbox');
    expect(objects.calls).toHaveLength(2);
  });

  it('keys the cache by the key material, so a rotated secret misses', async () => {
    const objects = fakeObjects(ok);
    const cache = new Map<string, CachedCredential>();
    const first = durableCredentialSource(testEnv, {
      cache,
      now: () => NOW,
      stubFor: objects.stubFor,
    });
    await first.token('apns:sandbox');
    const rotatedEnv = { ...testEnv, APNS_KEY_ID: 'ROTATED001' } as Env;
    const rotated = durableCredentialSource(rotatedEnv, {
      cache,
      now: () => NOW,
      stubFor: objects.stubFor,
    });

    await rotated.token('apns:sandbox');
    expect(objects.calls).toHaveLength(2);
  });

  it('throws not_configured without asking the object when the secrets are absent', async () => {
    const objects = fakeObjects(ok);
    const bare = { ...testEnv, APNS_KEY_P8: '' } as Env;
    const source = durableCredentialSource(bare, { cache: new Map(), stubFor: objects.stubFor });

    await expect(source.token('apns:production')).rejects.toMatchObject({
      name: 'PushCredentialError',
      failure: 'not_configured',
    });
    expect(objects.calls).toEqual([]);
  });

  it("passes the object's failure on, and drops a refused token before asking the object to", async () => {
    const failing = fakeObjects(() => ({
      ok: false,
      failure: 'exchange_unavailable',
      retryable: true,
      problems: [],
    }));
    const source = durableCredentialSource(testEnv, { cache: new Map(), stubFor: failing.stubFor });
    await expect(source.token('fcm')).rejects.toBeInstanceOf(PushCredentialError);

    const objects = fakeObjects(ok);
    const cache = new Map<string, CachedCredential>();
    const cached = durableCredentialSource(testEnv, {
      cache,
      now: () => NOW,
      stubFor: objects.stubFor,
    });
    const token = await cached.token('fcm');
    expect(await cached.expire('fcm', token)).toBe(NOW + 20 * MINUTE);
    expect(cache.size).toBe(0);
    await cached.token('fcm');
    expect(objects.calls.map((call) => call.rpc)).toEqual(['current', 'expire', 'current']);
  });
});

describe('the configuration (ruling P7)', () => {
  it('is complete in the suite and names what is missing or malformed, never a value', () => {
    expect(pushConfiguration(testEnv)).toEqual({
      apns: { configured: true, problems: [] },
      fcm: { configured: true, problems: [], projectId: 'planeahead-test' },
    });
    const broken = {
      ...testEnv,
      APNS_KEY_P8: '',
      APNS_KEY_ID: 'short',
      APNS_TEAM_ID: undefined,
      FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"planeahead-test"',
    } as unknown as Env;
    const configuration = pushConfiguration(broken);
    expect(configuration.apns).toEqual({
      configured: false,
      problems: [
        'APNS_KEY_P8 is not set',
        'APNS_KEY_ID is not a 10-character key id',
        'APNS_TEAM_ID is not set',
      ],
    });
    expect(configuration.fcm).toEqual({
      configured: false,
      problems: ['FCM_SERVICE_ACCOUNT_JSON is not JSON'],
      projectId: null,
    });
    const noKey = {
      ...testEnv,
      FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"planeahead-test"}',
    } as Env;
    expect(pushConfiguration(noKey).fcm.problems[0]).toMatch(
      /^FCM_SERVICE_ACCOUNT_JSON has no valid /,
    );
    expect(JSON.stringify(pushConfiguration(broken))).not.toContain('short');
  });
});

describe('the gap after a failed FCM exchange (review ruling R8)', () => {
  it('holds an FCM failure for a minute, and never holds back an APNs mint', () => {
    expect(withinFailureGap('fcm', NOW, NOW)).toBe(true);
    expect(withinFailureGap('fcm', NOW, NOW + FCM_MIN_EXCHANGE_GAP_MS - 1)).toBe(true);
    expect(withinFailureGap('fcm', NOW, NOW + FCM_MIN_EXCHANGE_GAP_MS)).toBe(false);
    expect(withinFailureGap('apns:sandbox', NOW, NOW)).toBe(false);
    expect(withinFailureGap('apns:production', NOW, NOW + 1)).toBe(false);
  });
});

describe('the key fingerprint (review ruling R9)', () => {
  async function fingerprintOf(env: Env, name: PushCredentialName): Promise<string> {
    const material = credentialMaterial(env, name);
    if (!material.ok) {
      throw new Error(material.problems.join('; '));
    }
    return materialFingerprint(material.value);
  }
  /** The suite's APNs key with real newlines. */
  const pem = normalisePem(testEnv.APNS_KEY_P8 ?? '');
  const apnsEnv = (keyPem: string, overrides: Record<string, string> = {}) =>
    ({ ...testEnv, APNS_KEY_P8: keyPem, ...overrides }) as Env;

  /** A fresh P-256 key as a PKCS#8 PEM: another key of Apple's shape. */
  async function anotherP256Pem(): Promise<string> {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const der = new Uint8Array(
      (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
    );
    let binary = '';
    for (const byte of der) {
      binary += String.fromCharCode(byte);
    }
    const body =
      btoa(binary)
        .match(/.{1,64}/g)
        ?.join('\n') ?? '';
    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
  }

  it('is one fingerprint for one APNs key put with real newlines, with \\n escapes or with CRLF', async () => {
    const real = await fingerprintOf(apnsEnv(pem), 'apns:production');
    const escaped = await fingerprintOf(apnsEnv(pem.replaceAll('\n', '\\n')), 'apns:production');
    const crlf = await fingerprintOf(apnsEnv(pem.replaceAll('\n', '\r\n')), 'apns:production');

    expect(pem).toContain('\n');
    expect(escaped).toBe(real);
    expect(crlf).toBe(real);
    // So the same key put again in its other form is served, not minted within 20 minutes.
    const row: StoredCredential = {
      token: 'token',
      fingerprint: real,
      mintedAtMs: NOW,
      notAfterMs: NOW + APNS_TOKEN_WINDOW_MS,
      mintCount: 1,
    };
    expect(credentialDecision('apns:production', row, escaped, NOW + MINUTE)).toBe('serve');
  });

  it('is another fingerprint for another key id, team id or key', async () => {
    const base = await fingerprintOf(apnsEnv(pem), 'apns:sandbox');
    const keyId = await fingerprintOf(apnsEnv(pem, { APNS_KEY_ID: 'ROTATED001' }), 'apns:sandbox');
    const teamId = await fingerprintOf(
      apnsEnv(pem, { APNS_TEAM_ID: 'OTHERTEAM1' }),
      'apns:sandbox',
    );
    const key = await fingerprintOf(apnsEnv(await anotherP256Pem()), 'apns:sandbox');

    expect(new Set([base, keyId, teamId, key]).size).toBe(4);
    expect(base).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is one fingerprint for the service account key in either newline form, another for its email or project', async () => {
    const account = testServiceAccount();
    const fcmEnv = (overrides: Record<string, string>) =>
      ({
        ...testEnv,
        FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...account, ...overrides }),
      }) as Env;
    const real = await fingerprintOf(fcmEnv({}), 'fcm');
    const escaped = await fingerprintOf(
      fcmEnv({ private_key: normalisePem(account.private_key).replaceAll('\n', '\\n') }),
      'fcm',
    );
    const email = await fingerprintOf(
      fcmEnv({ client_email: 'other-sender@planeahead-test.iam.gserviceaccount.com' }),
      'fcm',
    );
    const project = await fingerprintOf(fcmEnv({ project_id: 'planeahead-other' }), 'fcm');

    expect(escaped).toBe(real);
    expect(new Set([real, email, project]).size).toBe(3);
  });

  it('still answers for a PEM whose body does not decode (its first mint fails instead)', async () => {
    const broken = '-----BEGIN PRIVATE KEY-----\n!!!! not base64 !!!!\n-----END PRIVATE KEY-----';
    const first = await fingerprintOf(apnsEnv(broken), 'apns:sandbox');

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(await fingerprintOf(apnsEnv(broken.replaceAll('\n', '\\n')), 'apns:sandbox')).toBe(
      first,
    );
    expect(first).not.toBe(await fingerprintOf(apnsEnv(pem), 'apns:sandbox'));
  });
});
