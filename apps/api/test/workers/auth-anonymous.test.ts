/**
 * Anonymous sign-in through the real Worker: a user row with `is_anonymous = true`, a session
 * cookie the auth middleware resolves, and the guard rails around it.
 */

import { eq } from 'drizzle-orm';
import { sessions, users, withDb } from '@planeahead/db';
import { describe, expect, it } from 'vitest';
import { REQUEST_ID_HEADER } from '../../src/middleware/request-id';
import {
  cookiesFrom,
  jsonRequest,
  sessionTokenOnly,
  signInAnonymously,
  testEnv,
  uniqueIp,
  worker,
} from './helpers/auth';

describe('POST /api/auth/sign-in/anonymous', () => {
  it('creates a user with is_anonymous = true and sets the session cookie', async () => {
    const response = await worker(
      jsonRequest('/api/auth/sign-in/anonymous', 'POST', {}, { origin: null }),
    );
    const body = await response.json<{
      token: string;
      user: { id: string; isAnonymous: boolean };
    }>();

    expect(response.status).toBe(200);
    expect(body.user.isAnonymous).toBe(true);
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/);
    const cookie = cookiesFrom(response);
    expect(cookie).toContain('better-auth.session_token=');
    expect(response.headers.get(REQUEST_ID_HEADER)).not.toBeNull();

    const row = await withDb(testEnv, (db) =>
      db
        .select({ isAnonymous: users.isAnonymous, email: users.email, id: users.id })
        .from(users)
        .where(eq(users.id, body.user.id))
        .limit(1),
    );
    expect(row[0]?.isAnonymous).toBe(true);
    // A UUIDv7 from our generator, not Better Auth's 32-character default id.
    expect(row[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('resolves the cookie into c.var.user on a /v1 route', async () => {
    const session = await signInAnonymously();
    const response = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: session.ip, cookie: session.cookie }),
    );
    const body = await response.json<{ user: { id: string; isAnonymous: boolean; email: null } }>();

    expect(response.status).toBe(200);
    expect(body.user.id).toBe(session.userId);
    expect(body.user.isAnonymous).toBe(true);
    expect(body.user.email).toBeNull();
  });

  it('refuses a second anonymous sign-in on a live anonymous session', async () => {
    const session = await signInAnonymously();
    const response = await worker(
      jsonRequest(
        '/api/auth/sign-in/anonymous',
        'POST',
        {},
        { ip: uniqueIp(), cookie: session.cookie },
      ),
    );

    expect(response.status).toBe(400);
  });

  it('reads the session row for every write; a GET may use the 300 s cookie cache (increment 12)', async () => {
    // `session.cookieCache.enabled` (spec) trades a database read per request for a revocation
    // lag of up to `maxAge` (300 s, the default). Increment 8 (ruling O5) refused that trade for
    // every /v1 request; increment 12 (ruling W2 step 8) takes it back for GET and HEAD only and
    // closes the hole that mattered with a KV tombstone per deleted account's session
    // (session-tombstone.test.ts, me.delete.test.ts). What the trade still allows, and the threat
    // model records: a session revoked WITHOUT an account deletion (the merge's revocation, a
    // sign-out elsewhere) keeps the read-only paths, never a write or the flight search (ruling
    // AA11, session-tombstone.test.ts), until its cache cookie expires.
    const anonymous = await signInAnonymously();
    expect(anonymous.cookie).toContain('session_data=');
    await withDb(testEnv, (db) => db.delete(sessions).where(eq(sessions.userId, anonymous.userId)));

    const cachedRead = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: anonymous.ip, cookie: anonymous.cookie }),
    );
    const cachedWrite = await worker(
      jsonRequest(
        '/v1/me/preferences',
        'PATCH',
        { distanceUnit: 'km' },
        { ip: anonymous.ip, cookie: anonymous.cookie },
      ),
    );
    const direct = await worker(
      jsonRequest('/v1/me', 'GET', undefined, {
        ip: anonymous.ip,
        cookie: sessionTokenOnly(anonymous.cookie),
      }),
    );

    expect(cachedRead.status).toBe(200);
    expect(cachedWrite.status).toBe(401);
    expect(direct.status).toBe(401);
  });

  it('treats a forged cookie as no session, not as an error', async () => {
    const response = await worker(
      jsonRequest('/v1/me', 'GET', undefined, {
        cookie: 'better-auth.session_token=forged.signature',
      }),
    );

    expect(response.status).toBe(401);
    expect((await response.json<{ error: string }>()).error).toBe('unauthenticated');
  });
});
