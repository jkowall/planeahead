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

  it('answers a revoked session from the cookie cache for up to 300 s, and from the database at once without it', async () => {
    // `session.cookieCache.enabled` (spec) trades a database read per request for a revocation
    // lag of up to `maxAge` (300 s, the default). The merge revokes the anonymous session in
    // the database; a client that keeps replaying the signed `session_data` cookie is still
    // answered from it until it expires. The real client replaces both cookies on upgrade; the
    // window matters only for a stolen cookie and is recorded in the threat model.
    const anonymous = await signInAnonymously();
    expect(anonymous.cookie).toContain('session_data=');
    await withDb(testEnv, (db) => db.delete(sessions).where(eq(sessions.userId, anonymous.userId)));

    const cached = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: anonymous.ip, cookie: anonymous.cookie }),
    );
    const direct = await worker(
      jsonRequest('/v1/me', 'GET', undefined, {
        ip: anonymous.ip,
        cookie: sessionTokenOnly(anonymous.cookie),
      }),
    );

    expect(cached.status).toBe(200);
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
