/**
 * The `PushAuth` Durable Object (increment 14, ruling P3), on the real runtime: it mints the APNs
 * provider token at most every 30 minutes and never within 20 minutes of the last mint (a provider
 * refusal included), keeps `minted_at_ms` and the token in SQLite so a restart serves rather than
 * mints, shares one mint between concurrent callers, exchanges the FCM assertion for an access
 * token through its `fetchImpl` seam and caches it until shortly before expiry, and says why when
 * it has no token. The objects are the three production names; each test clears their storage.
 * The review round: an FCM exchange that failed is not repeated within a minute of the failure
 * (ruling R8), whatever Google answered, and an APNs mint is never held back that way.
 */

import { runInDurableObject } from 'cloudflare:test';
import { RPC_SCHEMA_VERSION, type PushCredentialName } from '@planeahead/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PushAuth } from '../../src/do/push-auth';
import type { Env } from '../../src/env';
import {
  APNS_MIN_MINT_GAP_MS,
  APNS_TOKEN_WINDOW_MS,
  FCM_EXPIRY_MARGIN_MS,
  FCM_MIN_EXCHANGE_GAP_MS,
  GOOGLE_OAUTH_TOKEN_URL,
  type PushCredentialResult,
} from '../../src/push/credentials';
import { fromBase64Url } from '../../src/push/jwt';
import { fakeFetch, publicKeyOf, testEnv, type FakeFetch } from '../unit/helpers/push';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const MINUTE = 60_000;

function stub(name: PushCredentialName) {
  return testEnv.PUSH_AUTH.getByName(name, { locationHint: 'enam' });
}

async function reset(name: PushCredentialName, clockMs: number, fetch?: FakeFetch): Promise<void> {
  await runInDurableObject(stub(name), (instance: PushAuth, state) => {
    state.storage.sql.exec('DELETE FROM credential');
    state.storage.sql.exec('DELETE FROM mint_failure');
    instance._setClock(clockMs);
    if (fetch !== undefined) {
      instance.fetchImpl = fetch.fetch;
    }
  });
}

async function setClock(name: PushCredentialName, clockMs: number): Promise<void> {
  await runInDurableObject(stub(name), (instance: PushAuth) => {
    instance._setClock(clockMs);
  });
}

async function current(name: PushCredentialName): Promise<PushCredentialResult> {
  return stub(name).current({ rpcVersion: RPC_SCHEMA_VERSION, name });
}

function token(result: PushCredentialResult): string {
  if (!result.ok) {
    throw new Error(`no token: ${result.failure}`);
  }
  return result.token;
}

function iatOf(jwt: string): number {
  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(jwt.split('.')[1] ?? ''))) as {
    iat: number;
  };
  return claims.iat * 1000;
}

beforeEach(async () => {
  for (const name of ['apns:sandbox', 'apns:production', 'fcm'] as const) {
    await reset(name, NOW);
  }
});

describe('APNs provider tokens', () => {
  it('mints once and serves the same token for 30 minutes, then mints a new one', async () => {
    const first = await current('apns:sandbox');
    await setClock('apns:sandbox', NOW + 29 * MINUTE);
    const again = await current('apns:sandbox');
    await setClock('apns:sandbox', NOW + 30 * MINUTE);
    const next = await current('apns:sandbox');

    expect(first).toMatchObject({
      ok: true,
      mintedAtMs: NOW,
      notAfterMs: NOW + APNS_TOKEN_WINDOW_MS,
    });
    expect(token(again)).toBe(token(first));
    expect(token(next)).not.toBe(token(first));
    expect(iatOf(token(next))).toBe(NOW + 30 * MINUTE);
    const publicKey = await publicKeyOf(testEnv.APNS_KEY_P8 ?? '', 'ES256');
    const [header = '', claims = '', signature = ''] = token(next).split('.');
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        fromBase64Url(signature),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);
  });

  it('keeps one token per APNs environment, from the same key', async () => {
    const sandbox = token(await current('apns:sandbox'));
    const production = token(await current('apns:production'));

    expect(sandbox).not.toBe(production);
    expect(iatOf(sandbox)).toBe(NOW);
  });

  it('shares one mint between concurrent callers', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => current('apns:production')));

    expect(new Set(results.map(token)).size).toBe(1);
    const status = await stub('apns:production').status({ name: 'apns:production' });
    expect(status.mintCount).toBe(1);
  });

  it('never mints within 20 minutes of the last mint after a refusal, and says when it may', async () => {
    const minted = token(await current('apns:sandbox'));
    await setClock('apns:sandbox', NOW + 5 * MINUTE);

    const expired = await stub('apns:sandbox').expire({ name: 'apns:sandbox', token: minted });
    const served = await current('apns:sandbox');
    await setClock('apns:sandbox', NOW + 20 * MINUTE);
    const reminted = await current('apns:sandbox');

    expect(expired.remintAtMs).toBe(NOW + APNS_MIN_MINT_GAP_MS);
    expect(token(served)).toBe(minted);
    expect(token(reminted)).not.toBe(minted);
    // A report about a token that was already replaced changes nothing.
    const stale = await stub('apns:sandbox').expire({ name: 'apns:sandbox', token: minted });
    expect(stale.remintAtMs).toBe(NOW + 20 * MINUTE);
    expect(token(await current('apns:sandbox'))).toBe(token(reminted));
  });

  it('walks three hours of sends and refusals: mints 20 minutes apart at least, no token older than an hour', async () => {
    const mints = new Set<number>();
    let oldest = 0;
    let last = '';
    for (let t = NOW; t <= NOW + 3 * 60 * MINUTE; t += 4 * MINUTE) {
      await setClock('apns:sandbox', t);
      const served = token(await current('apns:sandbox'));
      mints.add(iatOf(served));
      oldest = Math.max(oldest, t - iatOf(served));
      if ((t - NOW) % (12 * MINUTE) === 0) {
        await stub('apns:sandbox').expire({ name: 'apns:sandbox', token: served });
      }
      last = served;
    }
    const sorted = [...mints].sort((a, b) => a - b);
    const gaps = sorted.slice(1).map((mint, index) => mint - (sorted[index] ?? 0));

    expect(last).not.toBe('');
    expect(sorted.length).toBeGreaterThan(5);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(APNS_MIN_MINT_GAP_MS);
    expect(oldest).toBeLessThanOrEqual(APNS_TOKEN_WINDOW_MS);
    expect(oldest).toBeLessThan(60 * MINUTE);
  });

  it('reads the last mint from storage, so a restarted object serves instead of minting early', async () => {
    const minted = token(await current('apns:production'));
    // What a restart keeps: the row. Its window already pulled in (a refusal), minted 10 minutes
    // ago; the object holds no token in memory, so the answer comes from this row alone.
    await runInDurableObject(stub('apns:production'), (instance: PushAuth, state) => {
      state.storage.sql.exec(
        'UPDATE credential SET minted_at_ms = ?, not_after_ms = ?',
        NOW - 10 * MINUTE,
        NOW - 1,
      );
      instance._setClock(NOW);
    });
    const rows = await runInDurableObject(stub('apns:production'), (_instance, state) =>
      state.storage.sql.exec('SELECT name, minted_at_ms, mint_count FROM credential').toArray(),
    );

    expect(token(await current('apns:production'))).toBe(minted);
    expect(rows).toEqual([
      { name: 'apns:production', minted_at_ms: NOW - 10 * MINUTE, mint_count: 1 },
    ]);
    await setClock('apns:production', NOW + 10 * MINUTE);
    expect(token(await current('apns:production'))).not.toBe(minted);
  });

  it('replaces a token at once when the key changes', async () => {
    const minted = token(await current('apns:sandbox'));
    await runInDurableObject(stub('apns:sandbox'), (instance: PushAuth) => {
      (instance as unknown as { env: Env }).env = { ...testEnv, APNS_KEY_ID: 'ROTATED001' };
      instance._setClock(NOW + MINUTE);
    });

    const rotated = await current('apns:sandbox');
    await runInDurableObject(stub('apns:sandbox'), (instance: PushAuth) => {
      (instance as unknown as { env: Env }).env = testEnv;
    });

    expect(token(rotated)).not.toBe(minted);
    const header = JSON.parse(
      new TextDecoder().decode(fromBase64Url(token(rotated).split('.')[0] ?? '')),
    ) as { kid: string };
    expect(header.kid).toBe('ROTATED001');
  });

  it('answers not_configured, naming what is missing, without a token', async () => {
    await runInDurableObject(stub('apns:production'), (instance: PushAuth) => {
      (instance as unknown as { env: Env }).env = { ...testEnv, APNS_TEAM_ID: '' };
    });
    const result = await current('apns:production');
    await runInDurableObject(stub('apns:production'), (instance: PushAuth) => {
      (instance as unknown as { env: Env }).env = testEnv;
    });

    expect(result).toEqual({
      ok: false,
      failure: 'not_configured',
      retryable: false,
      problems: ['APNS_TEAM_ID is not set'],
    });
  });

  it('holds one credential per object, and refuses an rpcVersion it does not speak', async () => {
    // Called on the instance: a throw across the pool's RPC boundary is also reported as an
    // unhandled rejection of the run, which is the plugin's doing, not the object's.
    const attempt = (name: PushCredentialName, input: unknown) =>
      runInDurableObject(stub(name), (instance: PushAuth) => instance.current(input));
    await expect(attempt('apns:sandbox', { name: 'fcm' })).rejects.toThrow(
      /^invalid_request: this object holds apns:sandbox, not fcm/,
    );
    await expect(attempt('fcm', { rpcVersion: 2, name: 'fcm' })).rejects.toThrow(
      /^unsupported_rpc_version: /,
    );
  });
});

describe('FCM access tokens', () => {
  function oauth(): FakeFetch {
    let issued = 0;
    return fakeFetch(() => {
      issued += 1;
      return Response.json({ access_token: `ya29.access-${String(issued)}`, expires_in: 3600 });
    });
  }

  it('exchanges once, serves the token until five minutes before expiry, then exchanges again', async () => {
    const google = oauth();
    await reset('fcm', NOW, google);

    const first = await current('fcm');
    await setClock('fcm', NOW + 54 * MINUTE);
    const cached = await current('fcm');
    await setClock('fcm', NOW + 60 * MINUTE - FCM_EXPIRY_MARGIN_MS);
    const next = await current('fcm');

    expect(first).toMatchObject({
      ok: true,
      token: 'ya29.access-1',
      notAfterMs: NOW + 55 * MINUTE,
    });
    expect(token(cached)).toBe('ya29.access-1');
    expect(token(next)).toBe('ya29.access-2');
    expect(google.requests).toHaveLength(2);
    expect(google.requests[0]?.url).toBe('https://oauth2.googleapis.com/token');
  });

  it('re-exchanges a refused token, but not within a minute of the last exchange', async () => {
    const google = oauth();
    await reset('fcm', NOW, google);
    const refused = token(await current('fcm'));

    const answer = await stub('fcm').expire({ name: 'fcm', token: refused });
    await setClock('fcm', NOW + 30_000);
    const early = await current('fcm');
    await setClock('fcm', NOW + FCM_MIN_EXCHANGE_GAP_MS);
    const later = await current('fcm');

    expect(answer.remintAtMs).toBe(NOW + FCM_MIN_EXCHANGE_GAP_MS);
    expect(token(early)).toBe(refused);
    expect(token(later)).toBe('ya29.access-2');
  });

  it('records a failed exchange for the admin page and says whether to retry', async () => {
    await reset(
      'fcm',
      NOW,
      fakeFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 })),
    );
    const rejected = await current('fcm');
    const status = await stub('fcm').status({ name: 'fcm' });

    expect(rejected).toEqual({
      ok: false,
      failure: 'credentials_rejected',
      retryable: false,
      problems: [],
    });
    expect(status).toEqual({
      name: 'fcm',
      mintedAtMs: null,
      notAfterMs: null,
      mintCount: 0,
      lastFailure: { failure: 'credentials_rejected', atMs: NOW },
    });

    await reset(
      'fcm',
      NOW,
      fakeFetch(() => new Response('busy', { status: 503 })),
    );
    expect(await current('fcm')).toMatchObject({
      ok: false,
      failure: 'exchange_unavailable',
      retryable: true,
    });
  });

  it('never hands the token out through status', async () => {
    await reset('fcm', NOW, oauth());
    await current('fcm');
    const status = await stub('fcm').status({ name: 'fcm' });

    expect(JSON.stringify(status)).not.toContain('ya29');
    expect(status).toMatchObject({ mintedAtMs: NOW, mintCount: 1, lastFailure: null });
  });
});

describe('a failed FCM exchange (review ruling R8)', () => {
  const failures: readonly [string, () => Response | Promise<Response>, string][] = [
    ['a 503', () => new Response('busy', { status: 503 }), 'exchange_unavailable'],
    ['a 429', () => new Response('slow down', { status: 429 }), 'exchange_unavailable'],
    [
      'a 400 invalid_grant',
      () => new Response('{"error":"invalid_grant"}', { status: 400 }),
      'credentials_rejected',
    ],
    [
      'a network error',
      () => Promise.reject(new TypeError('network connection lost')),
      'exchange_unavailable',
    ],
  ];

  it.each(failures)(
    'after %s, answers the stored failure for a minute without asking Google, then asks again',
    async (_label, respond, failure) => {
      const google = fakeFetch(respond);
      await reset('fcm', NOW, google);

      const sequential: PushCredentialResult[] = [];
      for (let call = 0; call < 5; call += 1) {
        sequential.push(await current('fcm'));
      }
      const concurrent = await Promise.all(Array.from({ length: 3 }, () => current('fcm')));
      const requestsAtOneInstant = google.requests.length;
      await setClock('fcm', NOW + FCM_MIN_EXCHANGE_GAP_MS - 1);
      await current('fcm');
      const requestsJustInside = google.requests.length;
      await setClock('fcm', NOW + FCM_MIN_EXCHANGE_GAP_MS);
      await current('fcm');

      expect(requestsAtOneInstant).toBe(1);
      for (const answer of [...sequential, ...concurrent]) {
        expect(answer).toEqual({
          ok: false,
          failure,
          retryable: failure === 'exchange_unavailable',
          problems: [],
        });
      }
      expect(requestsJustInside).toBe(1);
      expect(google.requests).toHaveLength(2);
      expect(google.requests.every((request) => request.url === GOOGLE_OAUTH_TOKEN_URL)).toBe(true);
    },
  );

  it('takes a token once Google answers again after the gap, and clears the stored failure', async () => {
    let healthy = false;
    const google = fakeFetch(() =>
      healthy
        ? Response.json({ access_token: 'ya29.after-the-gap', expires_in: 3600 })
        : new Response('busy', { status: 503 }),
    );
    await reset('fcm', NOW, google);

    const failed = await current('fcm');
    healthy = true;
    const stillStored = await current('fcm');
    await setClock('fcm', NOW + FCM_MIN_EXCHANGE_GAP_MS);
    const recovered = await current('fcm');
    const status = await stub('fcm').status({ name: 'fcm' });

    expect(failed).toMatchObject({ ok: false, failure: 'exchange_unavailable' });
    expect(stillStored).toMatchObject({ ok: false, failure: 'exchange_unavailable' });
    expect(token(recovered)).toBe('ya29.after-the-gap');
    expect(google.requests).toHaveLength(2);
    expect(status.lastFailure).toBeNull();
  });

  it('never holds back an APNs mint after a failed one: the mint is local', async () => {
    const unusable = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
    await runInDurableObject(stub('apns:sandbox'), (instance: PushAuth) => {
      (instance as unknown as { env: Env }).env = { ...testEnv, APNS_KEY_P8: unusable };
    });
    const rejected = await current('apns:sandbox');
    await runInDurableObject(stub('apns:sandbox'), (instance: PushAuth) => {
      (instance as unknown as { env: Env }).env = testEnv;
    });
    const minted = await current('apns:sandbox');

    expect(rejected).toMatchObject({ ok: false, failure: 'credentials_rejected' });
    expect(minted).toMatchObject({ ok: true, mintedAtMs: NOW });
  });
});
