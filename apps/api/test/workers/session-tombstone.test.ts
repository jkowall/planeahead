/**
 * The KV session tombstone and the cookie cache re-enabled for GETs (increment 12, ruling W2
 * step 8), through the real Worker.
 *
 * A GET that presents Better Auth's `session_data` cache cookie may be answered from it, without
 * reading the `sessions` row; the auth middleware then looks the session token's keyed hash up
 * as a KV tombstone, which the account deletion writes for every session it removes, and a hit
 * answers 401 `account_deleted`. A write never uses the cache. The second device of a deleted
 * account (me.delete.test.ts, increment 8) is the end-to-end case; this file pins the mechanism.
 */

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { deletedSubjectHash } from '../../src/lib/hmac';
import {
  sessionTombstoneKey,
  tombstoneTtlSeconds,
  writeSessionTombstones,
  KV_MIN_TTL_SECONDS,
} from '../../src/lib/session-tombstone';
import { bypassesCookieCache, sessionTokenFromCookie } from '../../src/middleware/auth';
import { createLogger } from '../../src/observability/log';
import { jsonRequest, sessionTokenOnly, signInAnonymously, testEnv, worker } from './helpers/auth';

const quietLog = createLogger({}, () => undefined);

async function tombstoneFor(cookie: string): Promise<string> {
  const token = sessionTokenFromCookie(cookie);
  if (token === null) {
    throw new Error('no session token in the cookie');
  }
  return deletedSubjectHash(testEnv.DELETED_SUBJECT_HMAC_KEY ?? '', 'session', token);
}

describe('the cookie cache for GETs, checked against the KV tombstone', () => {
  it('answers a cached GET 401 account_deleted once its session is tombstoned; writes and uncached reads use the row', async () => {
    const session = await signInAnonymously();
    expect(session.cookie).toContain('session_data=');
    const before = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: session.ip, cookie: session.cookie }),
    );
    expect(before.status).toBe(200);

    const hash = await tombstoneFor(session.cookie);
    await writeSessionTombstones(
      env.CACHE,
      [{ hash, expiresAtMs: Date.now() + 86_400_000 }],
      Date.now(),
      quietLog,
    );
    expect(await env.CACHE.get(sessionTombstoneKey(hash))).toBe('1');

    const cached = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: session.ip, cookie: session.cookie }),
    );
    expect(cached.status).toBe(401);
    expect((await cached.json<{ error: string }>()).error).toBe('account_deleted');

    // Without the cache cookie the row answers (the session is alive in Postgres): the
    // tombstone is consulted only where the cache could have answered.
    const direct = await worker(
      jsonRequest('/v1/me', 'GET', undefined, {
        ip: session.ip,
        cookie: sessionTokenOnly(session.cookie),
      }),
    );
    expect(direct.status).toBe(200);
  });

  it('never lets a mutating request use the cache, and lets GET and HEAD use it', () => {
    expect(bypassesCookieCache('GET', '/v1/me')).toBe(false);
    expect(bypassesCookieCache('HEAD', '/v1/sync')).toBe(false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(bypassesCookieCache(method, '/v1/flights')).toBe(true);
    }
  });

  it('keeps a tombstone for as long as its deleted_subjects row, never below KV floor', () => {
    const now = Date.UTC(2026, 8, 23);
    expect(tombstoneTtlSeconds(now + 31 * 86_400_000, now)).toBe(31 * 86_400);
    expect(tombstoneTtlSeconds(now + 5_000, now)).toBe(KV_MIN_TTL_SECONDS);
    expect(tombstoneTtlSeconds(now - 5_000, now)).toBe(KV_MIN_TTL_SECONDS);
  });

  it('reports a failed tombstone write without throwing', async () => {
    const failing = {
      put: () => Promise.reject(new Error('kv down')),
    } as unknown as Pick<KVNamespace, 'put'>;
    const result = await writeSessionTombstones(
      failing,
      [{ hash: 'session:x', expiresAtMs: Date.now() + 1_000 }],
      Date.now(),
      quietLog,
    );
    expect(result).toEqual({ written: 0, failed: 1 });
  });
});
