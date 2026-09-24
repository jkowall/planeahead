/**
 * The KV session tombstone and the cookie cache re-enabled for GETs (increment 12, ruling W2
 * step 8), through the real Worker.
 *
 * A read-only GET may be answered from Better Auth's `session_data` cache cookie, without reading
 * the `sessions` row; whenever a GET resolves a session through that cacheable read, whatever the
 * cache cookie is called (the chunked `session_data.0` too, ruling AA14) or whether one was sent,
 * the auth middleware looks the session token's keyed hash up as a KV tombstone, which the account
 * deletion writes for every session it removes, and a hit answers 401 `account_deleted`. A write
 * never uses the cache, and neither does `GET /v1/flights/search` (ruling AA11). The second device
 * of a deleted account (me.delete.test.ts, increment 8) is the end-to-end case; this file pins the
 * mechanism.
 */

import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
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
import { db, seededFlightFor } from './helpers/routes';

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

    // The tombstone is consulted for every GET that took the cacheable read, whatever cache
    // cookie it sent (ruling AA14): the chunked name Better Auth also reads, and none at all.
    const chunked = session.cookie.replace('session_data=', 'session_data.0=');
    expect(chunked).toContain('session_data.0=');
    expect(chunked).not.toMatch(/session_data=/);
    for (const cookie of [chunked, sessionTokenOnly(session.cookie)]) {
      const response = await worker(
        jsonRequest('/v1/me', 'GET', undefined, { ip: session.ip, cookie }),
      );
      expect(response.status, cookie).toBe(401);
      expect((await response.json<{ error: string }>()).error).toBe('account_deleted');
    }
  });

  it('answers a chunked cache cookie from the cache while no tombstone exists', async () => {
    // The control for the case above: Better Auth resolves `session_data.0` on its own, so the
    // tombstone check is the only thing that turned it away.
    const session = await signInAnonymously();
    const chunked = session.cookie.replace('session_data=', 'session_data.0=');
    const response = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: session.ip, cookie: chunked }),
    );
    expect(response.status).toBe(200);
  });

  it('reads the row for a revoked session on the search path, where the cache still answers a read-only GET', async () => {
    const session = await signInAnonymously();
    expect(session.cookie).toContain('session_data=');
    // Revoked without an account deletion (a sign-out elsewhere, the merge's revocation): the row
    // is gone, no tombstone is written.
    await db().execute(sql`delete from sessions where user_id = ${session.userId}::uuid`);

    // The documented residual: a read-only path may still be answered from the cache cookie.
    const me = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: session.ip, cookie: session.cookie }),
    );
    expect(me.status).toBe(200);

    // The search takes caps and may spend a provider call: it reads the row and refuses.
    const flight = seededFlightFor();
    const search = await worker(
      jsonRequest(
        `/v1/flights/search?number=${flight.designator}&date=${flight.dateLocal}`,
        'GET',
        undefined,
        { ip: session.ip, cookie: session.cookie },
      ),
    );
    expect(search.status).toBe(401);
    expect((await search.json<{ error: string }>()).error).toBe('unauthenticated');
    const [counters] = await db().execute<{ n: number }>(sql`
      select count(*)::int as n from usage_counters where subject = ${session.userId}
    `);
    expect(counters?.n).toBe(0);
  });

  it('never lets a mutating request or the search use the cache, and lets other GETs and HEADs use it', () => {
    expect(bypassesCookieCache('GET', '/v1/me')).toBe(false);
    expect(bypassesCookieCache('HEAD', '/v1/sync')).toBe(false);
    expect(bypassesCookieCache('GET', '/v1/flights')).toBe(false);
    expect(bypassesCookieCache('GET', '/v1/flights/search')).toBe(true);
    expect(bypassesCookieCache('GET', '/v1/flights/search/')).toBe(true);
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
