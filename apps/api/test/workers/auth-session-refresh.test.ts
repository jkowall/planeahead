/**
 * Where the sliding session refresh happens (ruling G7, settled in the second review round).
 *
 * Better Auth's `getSession` extends `sessions.expires_at` once a day AND re-issues the
 * `session_token` cookie with a fresh Max-Age, and the two must reach the client together: the
 * Expo client expires its SecureStore cookie by that Max-Age and stores cookies only from
 * responses to requests it made itself (`/api/auth/*`). The increment 9 `/v1` client keeps
 * nothing from a `/v1` response. So a `/v1` request that refreshed the row would throw the
 * cookie away and leave `/get-session` seeing a recently updated row for the rest of the day;
 * thirty days after sign-in the app would be signed out despite daily use.
 *
 * The auth middleware therefore reads the session with `disableRefresh` and emits no
 * `Set-Cookie` at all, and the refresh happens on `GET /api/auth/get-session`, which the app's
 * session gate calls on every launch and foreground. The session is aged by hand (two days old,
 * 28 left) and both halves of the contract are asserted.
 */

import { eq } from 'drizzle-orm';
import { sessions, withDb } from '@planeahead/db';
import { describe, expect, it } from 'vitest';
import { SESSION_EXPIRES_IN_SECONDS, SESSION_UPDATE_AGE_SECONDS } from '../../src/auth/create-auth';
import { jsonRequest, sessionTokenOnly, signInAnonymously, testEnv, worker } from './helpers/auth';

const DAY_MS = 24 * 60 * 60 * 1000;

async function expiryOf(userId: string): Promise<Date> {
  const [row] = await withDb(testEnv, (db) =>
    db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(eq(sessions.userId, userId))
      .limit(1),
  );
  if (row === undefined) {
    throw new Error('no session row');
  }
  return row.expiresAt;
}

async function ageSession(userId: string): Promise<Date> {
  // Older than `updateAge`: expires_at minus (expiresIn - updateAge) is in the past.
  const agedExpiry = new Date(Date.now() + SESSION_EXPIRES_IN_SECONDS * 1000 - 2 * DAY_MS);
  await withDb(testEnv, (db) =>
    db
      .update(sessions)
      .set({ expiresAt: agedExpiry, updatedAt: new Date(Date.now() - 2 * DAY_MS) })
      .where(eq(sessions.userId, userId)),
  );
  expect(SESSION_UPDATE_AGE_SECONDS * 1000).toBeLessThan(2 * DAY_MS);
  return agedExpiry;
}

describe('a session due for refresh', () => {
  it('is NOT refreshed by a /v1 request, which also sets no cookie', async () => {
    const anonymous = await signInAnonymously();
    const agedExpiry = await ageSession(anonymous.userId);

    // The token alone, the way a client whose 300 s cache cookie has expired sends it.
    const response = await worker(
      jsonRequest('/v1/me', 'GET', undefined, {
        ip: anonymous.ip,
        cookie: sessionTokenOnly(anonymous.cookie),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await expiryOf(anonymous.userId)).getTime()).toBe(agedExpiry.getTime());
  });

  it('is refreshed by GET /api/auth/get-session, the path whose cookies the Expo client stores', async () => {
    const anonymous = await signInAnonymously();
    const agedExpiry = await ageSession(anonymous.userId);
    // A day of /v1 traffic first: none of it may pre-empt the refresh below.
    for (let call = 0; call < 3; call += 1) {
      const me = await worker(
        jsonRequest('/v1/me', 'GET', undefined, {
          ip: anonymous.ip,
          cookie: sessionTokenOnly(anonymous.cookie),
        }),
      );
      expect(me.status).toBe(200);
    }

    const session = await worker(
      jsonRequest('/api/auth/get-session', 'GET', undefined, {
        ip: anonymous.ip,
        cookie: sessionTokenOnly(anonymous.cookie),
        origin: null,
      }),
    );
    const setCookies = session.headers.getSetCookie();
    const tokenCookie = setCookies.find((line) => line.startsWith('better-auth.session_token='));

    expect(session.status).toBe(200);
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie).toContain(`Max-Age=${SESSION_EXPIRES_IN_SECONDS}`);
    const refreshed = await expiryOf(anonymous.userId);
    expect(refreshed.getTime()).toBeGreaterThan(agedExpiry.getTime() + DAY_MS);

    // The re-issued cookie is the one the client keeps: it still resolves on /v1.
    const cookie = setCookies.map((line) => line.split(';')[0] ?? '').join('; ');
    const again = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: anonymous.ip, cookie }),
    );
    expect(again.status).toBe(200);
  });

  it('a stale anonymous cookie on /v1 after an upgrade answers 401 and deletes nothing', async () => {
    // With the refresh off, /v1 never forwards Better Auth's cookie deletions either: a /v1
    // request that raced the upgrade cannot tell the client to drop the NEW session's cookie.
    const anonymous = await signInAnonymously();
    await withDb(testEnv, (db) => db.delete(sessions).where(eq(sessions.userId, anonymous.userId)));

    const response = await worker(
      jsonRequest('/v1/me', 'GET', undefined, {
        ip: anonymous.ip,
        cookie: sessionTokenOnly(anonymous.cookie),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});
