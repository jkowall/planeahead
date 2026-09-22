/**
 * The sliding session refresh reaches the client through `/v1` (ruling G7).
 *
 * `auth.api.getSession` extends `sessions.expires_at` once a day and re-issues the
 * `session_token` cookie with a fresh Max-Age. The auth middleware used to make that call
 * without `returnHeaders`, so the row was extended and the cookie was not, and a day on which
 * the app's first request was a `/v1` call (background sync) lost that day's cookie refresh: the
 * Expo client expires the cookie by its Max-Age, and thirty days after sign-in the user was
 * signed out despite daily use. The session is aged by hand (two days old, 28 left) and the
 * `/v1/me` response is expected to carry the re-issued cookie.
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

describe('a /v1 request on a session due for refresh', () => {
  it('extends the row AND forwards the re-issued session_token cookie', async () => {
    const anonymous = await signInAnonymously();
    // Older than `updateAge`: expires_at minus (expiresIn - updateAge) is in the past.
    const agedExpiry = new Date(Date.now() + SESSION_EXPIRES_IN_SECONDS * 1000 - 2 * DAY_MS);
    await withDb(testEnv, (db) =>
      db
        .update(sessions)
        .set({ expiresAt: agedExpiry, updatedAt: new Date(Date.now() - 2 * DAY_MS) })
        .where(eq(sessions.userId, anonymous.userId)),
    );
    expect(SESSION_UPDATE_AGE_SECONDS * 1000).toBeLessThan(2 * DAY_MS);

    // The token alone, the way a client whose 300 s cache cookie has expired sends it.
    const response = await worker(
      jsonRequest('/v1/me', 'GET', undefined, {
        ip: anonymous.ip,
        cookie: sessionTokenOnly(anonymous.cookie),
      }),
    );
    const setCookies = response.headers.getSetCookie();
    const tokenCookie = setCookies.find((line) => line.startsWith('better-auth.session_token='));

    expect(response.status).toBe(200);
    expect(tokenCookie).toBeDefined();
    expect(tokenCookie).toContain(`Max-Age=${SESSION_EXPIRES_IN_SECONDS}`);
    const refreshed = await expiryOf(anonymous.userId);
    expect(refreshed.getTime()).toBeGreaterThan(agedExpiry.getTime() + DAY_MS);

    // The re-issued cookie is the one the client should keep: it still resolves.
    const cookie = setCookies.map((line) => line.split(';')[0] ?? '').join('; ');
    const again = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: anonymous.ip, cookie }),
    );
    expect(again.status).toBe(200);
  });

  it('forwards nothing when the session is fresh (no spurious Set-Cookie on every call)', async () => {
    const anonymous = await signInAnonymously();
    const response = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: anonymous.ip, cookie: anonymous.cookie }),
    );

    expect(response.status).toBe(200);
    expect(
      response.headers.getSetCookie().some((line) => line.startsWith('better-auth.session_token=')),
    ).toBe(false);
  });
});
