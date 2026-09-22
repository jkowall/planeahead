/**
 * Magic link through the real Worker, with the Resend endpoint served by the test run.
 *
 * What is pinned here: the request answers 200 whether or not the email exists and stores a
 * HASHED token; the per-email cap refuses the 4th request in an hour with the same 200 and no
 * mail; the verify request, made the way the app makes it (no `callbackURL`), answers JSON plus
 * Set-Cookie rather than a redirect; and an anonymous user who verifies with their cookie
 * attached is merged exactly once.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { usageCounters, users, verifications, withDb } from '@planeahead/db';
import { describe, expect, it } from 'vitest';
import {
  MAGIC_LINK_COUNTER,
  MAGIC_LINK_HOUR_CAP,
  MAGIC_LINK_SCOPE,
  magicLinkSubjects,
} from '../../src/middleware/magic-link-cap';
import {
  jsonRequest,
  magicLinkTokenFor,
  sentEmails,
  sessionTokenOnly,
  signInAnonymously,
  signInWithMagicLink,
  testEnv,
  uniqueEmail,
  uniqueIp,
  worker,
} from './helpers/auth';

async function requestLink(email: string, ip: string = uniqueIp()): Promise<Response> {
  return worker(
    jsonRequest('/api/auth/sign-in/magic-link', 'POST', { email }, { ip, origin: null }),
  );
}

describe('POST /api/auth/sign-in/magic-link', () => {
  it('answers 200 for an unknown email, sends through Resend with an idempotency key, stores a hash', async () => {
    const email = uniqueEmail('new');
    const response = await requestLink(email);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });

    const [sent] = await sentEmails(email);
    expect(sent?.authorization).toBe(`Bearer ${testEnv.RESEND_API_KEY ?? ''}`);
    expect(sent?.idempotencyKey).toMatch(/^magic-link\/[A-Za-z]{8}$/);
    expect(sent?.body.to).toEqual([email]);
    const token = await magicLinkTokenFor(email);
    expect(token).toHaveLength(32);
    // No callbackURL in the link: verification returns JSON, never a redirect.
    expect(sent?.body.text).toContain(
      `${testEnv.API_PUBLIC_URL}/api/auth/magic-link/verify?token=`,
    );
    expect(sent?.body.text).not.toContain('callbackURL');

    // The token itself is nowhere in the database; only its hash is.
    const rows = await withDb(testEnv, (db) =>
      db.select({ identifier: verifications.identifier }).from(verifications),
    );
    expect(rows.some((row) => row.identifier === token)).toBe(false);
    expect(rows.some((row) => row.identifier.length > 20 && row.identifier !== token)).toBe(true);
  });

  it('answers the same 200 for an email that already has an account', async () => {
    const email = uniqueEmail('existing');
    await signInWithMagicLink(email);

    const response = await requestLink(email);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(await sentEmails(email)).toHaveLength(2);
  });

  it('refuses the 4th request in an hour with 200, no mail, and a bumped counter', async () => {
    const email = uniqueEmail('capped');
    for (let attempt = 0; attempt < MAGIC_LINK_HOUR_CAP; attempt += 1) {
      expect((await requestLink(email)).status).toBe(200);
    }
    const fourth = await requestLink(email);

    expect(fourth.status).toBe(200);
    expect(await fourth.json()).toEqual({ status: true });
    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_HOUR_CAP);

    const subjects = await magicLinkSubjects(email);
    const counters = await withDb(testEnv, (db) =>
      db
        .select({ subject: usageCounters.subject, count: usageCounters.count })
        .from(usageCounters)
        .where(
          and(
            eq(usageCounters.scope, MAGIC_LINK_SCOPE),
            inArray(usageCounters.subject, [subjects.hour, subjects.day]),
            eq(usageCounters.counter, MAGIC_LINK_COUNTER),
          ),
        ),
    );
    // One hour row and one day row, both at 4, and neither carries the address itself.
    expect(counters.map((row) => row.count).sort()).toEqual([4, 4]);
    expect(counters.every((row) => !row.subject.includes('@'))).toBe(true);
  });

  it('caps by address, not by capitalisation', async () => {
    const email = uniqueEmail('case');
    for (let attempt = 0; attempt < MAGIC_LINK_HOUR_CAP; attempt += 1) {
      await requestLink(email);
    }
    await requestLink(email.toUpperCase());

    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_HOUR_CAP);
    expect(await sentEmails(email.toUpperCase())).toHaveLength(0);
  });
});

describe('GET /api/auth/magic-link/verify', () => {
  it('answers JSON plus Set-Cookie when called without a callbackURL, the way the app does', async () => {
    const email = uniqueEmail('verify');
    const { response, cookie, userId } = await signInWithMagicLink(email);

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('location')).toBeNull();
    expect(cookie).toContain('better-auth.session_token=');
    const row = await withDb(testEnv, (db) =>
      db
        .select({
          email: users.email,
          emailVerified: users.emailVerified,
          isAnonymous: users.isAnonymous,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    );
    expect(row[0]).toEqual({ email, emailVerified: true, isAnonymous: false });
  });

  it('consumes the token: a second verify is refused', async () => {
    const email = uniqueEmail('once');
    const ip = uniqueIp();
    await requestLink(email, ip);
    const token = await magicLinkTokenFor(email);
    const path = `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;

    const first = await worker(jsonRequest(path, 'GET', undefined, { ip, origin: null }));
    const second = await worker(jsonRequest(path, 'GET', undefined, { ip, origin: null }));

    expect(first.status).toBe(200);
    // With no callbackURL Better Auth redirects the error to the base URL; either way, no
    // session and no JSON success body.
    expect(second.status).not.toBe(200);
    expect(
      second.headers
        .getSetCookie()
        .some((line) => line.includes('session_token=') && !line.includes('session_token=;')),
    ).toBe(false);
  });

  it('upgrades an anonymous user: rows re-keyed, anonymous row marked, sessions revoked, once', async () => {
    const anonymous = await signInAnonymously();
    const email = uniqueEmail('upgrade');

    // Give the anonymous user something to carry over.
    const registered = await worker(
      jsonRequest(
        '/v1/devices',
        'POST',
        { installId: `upgrade-${crypto.randomUUID()}`, platform: 'ios' },
        { ip: anonymous.ip, cookie: anonymous.cookie },
      ),
    );
    expect(registered.status).toBe(200);

    const upgraded = await signInWithMagicLink(email, {
      ip: anonymous.ip,
      cookie: anonymous.cookie,
    });
    expect(upgraded.userId).not.toBe(anonymous.userId);

    const [fromRow] = await withDb(testEnv, (db) =>
      db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, anonymous.userId))
        .limit(1),
    );
    expect(fromRow?.status).toBe('deleting');

    // The device followed the user and the old cookie no longer resolves.
    const me = await worker(jsonRequest('/v1/me', 'GET', undefined, { cookie: upgraded.cookie }));
    expect((await me.json<{ user: { id: string } }>()).user.id).toBe(upgraded.userId);
    const stale = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { cookie: sessionTokenOnly(anonymous.cookie) }),
    );
    expect(stale.status).toBe(401);
  });
});
