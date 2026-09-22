/**
 * Magic link through the real Worker, with the Resend endpoint served by the test run.
 *
 * What is pinned here: the request answers 200 whether or not the email exists, stores a HASHED
 * token and emails the non-consuming landing URL with a digest idempotency key; the gate in
 * front of Better Auth runs for every request (keyed or not), counts only what Better Auth would
 * accept, refuses the 4th request in an hour from the same requester with the same 200 and no
 * mail, keeps a stranger's requests off the address owner's budget, answers 429 to a requester
 * that asks too often, and forwards `{ email }` alone; the verify request, made the way the app
 * makes it, answers JSON plus Set-Cookie on success and JSON 400 on failure; the anonymous merge
 * runs only for the anonymous user who requested the link; and the browser landing page never
 * consumes the token while its consume route does.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { devices, usageCounters, users, verifications, withDb } from '@planeahead/db';
import { describe, expect, it } from 'vitest';
import { MAGIC_LINK_CONSUME_PATH, MAGIC_LINK_LANDING_PATH } from '../../src/auth/paths';
import {
  MAGIC_LINK_COUNTER,
  MAGIC_LINK_HOUR_CAP,
  MAGIC_LINK_REQUESTER_HOUR_CAP,
  magicLinkSubjects,
  requestersOf,
} from '../../src/middleware/magic-link-cap';
import { IDEMPOTENCY_KEY_HEADER, INSTALL_ID_HEADER } from '../../src/middleware/idempotency';
import {
  API_ORIGIN,
  APP_ORIGIN,
  captureLogs,
  cookiesFrom,
  jsonRequest,
  logEvents,
  magicLinkTokenFor,
  magicLinkUrlFor,
  registerDevice,
  sentEmails,
  sessionTokenOnly,
  signInAnonymously,
  signInWithMagicLink,
  testEnv,
  uniqueEmail,
  uniqueInstallId,
  uniqueIp,
  verifyMagicLink,
  worker,
} from './helpers/auth';

interface LinkOptions {
  readonly ip?: string;
  readonly installId?: string;
  readonly headers?: Record<string, string>;
  readonly cookie?: string | null;
  /** Replaces the `{ email }` body. */
  readonly body?: unknown;
}

function requestLink(email: string, options: LinkOptions = {}): Promise<Response> {
  const headers = { ...options.headers };
  if (options.installId !== undefined) {
    headers[INSTALL_ID_HEADER] = options.installId;
  }
  const cookie = options.cookie ?? null;
  return worker(
    jsonRequest('/api/auth/sign-in/magic-link', 'POST', options.body ?? { email }, {
      ip: options.ip ?? uniqueIp(),
      headers,
      cookie,
      origin: cookie === null ? null : APP_ORIGIN,
    }),
  );
}

/** The address rows for one (address, requester) pair, as the gate keys them. */
async function addressCounters(email: string, headers: Record<string, string>) {
  const subjects = await magicLinkSubjects(email, requestersOf(new Headers(headers)));
  return withDb(testEnv, (db) =>
    db
      .select({ subject: usageCounters.subject, count: usageCounters.count })
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.scope, subjects.address.scope),
          inArray(usageCounters.subject, [subjects.address.hour, subjects.address.day]),
          eq(usageCounters.counter, MAGIC_LINK_COUNTER),
        ),
      ),
  );
}

async function userStatus(userId: string): Promise<string | undefined> {
  const [row] = await withDb(testEnv, (db) =>
    db.select({ status: users.status }).from(users).where(eq(users.id, userId)).limit(1),
  );
  return row?.status;
}

describe('POST /api/auth/sign-in/magic-link', () => {
  it('answers 200 for an unknown email, sends the landing link through Resend with a digest key, stores a hash', async () => {
    const email = uniqueEmail('new');
    const response = await requestLink(email);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });

    const [sent] = await sentEmails(email);
    expect(sent?.authorization).toBe(`Bearer ${testEnv.RESEND_API_KEY ?? ''}`);
    expect(sent?.body.to).toEqual([email]);
    const token = await magicLinkTokenFor(email);
    expect(token).toHaveLength(32);
    // The idempotency key is a digest, so a header the provider retains carries no token.
    expect(sent?.idempotencyKey).toMatch(/^magic-link\/[0-9a-f]{32}$/);
    expect(sent?.idempotencyKey).not.toContain(token.slice(0, 8));
    // The link is the non-consuming landing page, never the verify endpoint, no callbackURL.
    expect(sent?.body.text).toContain(`${testEnv.API_PUBLIC_URL}${MAGIC_LINK_LANDING_PATH}?token=`);
    expect(sent?.body.text).not.toContain('/magic-link/verify');
    expect(sent?.body.text).not.toContain('callbackURL');

    // The token itself is nowhere in the database; only hashes of it are.
    const rows = await withDb(testEnv, (db) =>
      db.select({ identifier: verifications.identifier }).from(verifications),
    );
    expect(rows.some((row) => row.identifier.includes(token))).toBe(false);
  });

  it('answers the same 200 for an email that already has an account', async () => {
    const email = uniqueEmail('existing');
    await signInWithMagicLink(email);

    const response = await requestLink(email);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(await sentEmails(email)).toHaveLength(2);
  });

  it('refuses the 4th request in an hour from the same requester with 200, no mail, and a bumped counter', async () => {
    const email = uniqueEmail('capped');
    const installId = uniqueInstallId('capped');
    for (let attempt = 0; attempt < MAGIC_LINK_HOUR_CAP; attempt += 1) {
      expect((await requestLink(email, { installId })).status).toBe(200);
    }
    const fourth = await requestLink(email, { installId });

    expect(fourth.status).toBe(200);
    expect(await fourth.json()).toEqual({ status: true });
    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_HOUR_CAP);

    const counters = await addressCounters(email, { [INSTALL_ID_HEADER]: installId });
    // One hour row and one day row, both at 4, and neither carries the address or the install.
    expect(counters.map((row) => row.count).sort()).toEqual([4, 4]);
    expect(counters.every((row) => !row.subject.includes('@'))).toBe(true);
    expect(counters.every((row) => !row.subject.includes(installId))).toBe(true);
  });

  it('counts a keyed request (Idempotency-Key plus X-Install-Id) like any other', async () => {
    // The mobile client sends both headers on every mutating request. An earlier build let the
    // idempotency middleware consume the body first, the cap failed open, and every keyed
    // request was mailed and never counted.
    const email = uniqueEmail('keyed');
    const installId = uniqueInstallId('keyed');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < MAGIC_LINK_HOUR_CAP + 2; attempt += 1) {
      const response = await requestLink(email, {
        installId,
        headers: { [IDEMPOTENCY_KEY_HEADER]: `magic-${crypto.randomUUID()}` },
      });
      statuses.push(response.status);
      expect(response.headers.get('Idempotency-Replayed')).toBeNull();
    }

    expect(statuses).toEqual(Array<number>(MAGIC_LINK_HOUR_CAP + 2).fill(200));
    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_HOUR_CAP);
    const counters = await addressCounters(email, { [INSTALL_ID_HEADER]: installId });
    expect(counters.map((row) => row.count).sort()).toEqual([5, 5]);
  });

  it('caps by address, not by capitalisation', async () => {
    const email = uniqueEmail('case');
    const installId = uniqueInstallId('case');
    for (let attempt = 0; attempt < MAGIC_LINK_HOUR_CAP; attempt += 1) {
      await requestLink(email, { installId });
    }
    await requestLink(email.toUpperCase(), { installId });

    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_HOUR_CAP);
    expect(await sentEmails(email.toUpperCase())).toHaveLength(0);
  });

  it("keeps a stranger's requests off the address owner's own budget", async () => {
    const email = uniqueEmail('victim');
    const stranger = uniqueInstallId('stranger');
    const owner = uniqueInstallId('owner');
    for (let attempt = 0; attempt < MAGIC_LINK_HOUR_CAP + 1; attempt += 1) {
      expect((await requestLink(email, { installId: stranger })).status).toBe(200);
    }
    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_HOUR_CAP);

    // The owner's device has its own (address, requester) budget, so their link still goes out.
    const own = await requestLink(email, { installId: owner });

    expect(own.status).toBe(200);
    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_HOUR_CAP + 1);
  });

  it('answers 429 with Retry-After to one client asking for too many links across addresses', async () => {
    // Keyed by IP (not client-chosen): the install id is rotated on every request and does
    // not help. Better Auth's own per-IP rule answers 429 from the 4th request on; the gate
    // keeps counting those, and from the 21st on it answers before Better Auth is reached.
    const ip = uniqueIp();
    const sent: string[] = [];
    let last: Response | null = null;
    for (let attempt = 0; attempt < MAGIC_LINK_REQUESTER_HOUR_CAP + 1; attempt += 1) {
      const email = uniqueEmail('prober');
      sent.push(email);
      last = await requestLink(email, { ip, installId: uniqueInstallId('rotating') });
    }
    const body = await last?.json<{ code?: string }>();

    expect(last?.status).toBe(429);
    expect(body?.code).toBe('TOO_MANY_REQUESTS');
    expect(last?.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(Number(last?.headers.get('Retry-After'))).toBeLessThanOrEqual(3600);
    // Nothing was mailed for the address that tripped the gate.
    expect(await sentEmails(sent.at(-1) ?? '')).toHaveLength(0);
  });

  it('does not count a request Better Auth would refuse: text/plain is 415 and burns nothing', async () => {
    const email = uniqueEmail('media');
    const installId = uniqueInstallId('media');
    for (let attempt = 0; attempt < MAGIC_LINK_HOUR_CAP; attempt += 1) {
      const response = await worker(
        new Request(`${API_ORIGIN}/api/auth/sign-in/magic-link`, {
          method: 'POST',
          headers: {
            'content-type': 'text/plain',
            'cf-connecting-ip': uniqueIp(),
            [INSTALL_ID_HEADER]: installId,
          },
          body: JSON.stringify({ email }),
        }),
      );
      expect(response.status).toBe(415);
    }
    expect(await sentEmails(email)).toHaveLength(0);
    expect(await addressCounters(email, { [INSTALL_ID_HEADER]: installId })).toHaveLength(0);

    // The owner's three real requests all go out afterwards.
    for (let attempt = 0; attempt < MAGIC_LINK_HOUR_CAP; attempt += 1) {
      expect((await requestLink(email, { installId })).status).toBe(200);
    }
    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_HOUR_CAP);
  });

  it('strips name and the callback URLs, so the requester cannot pick the new account name', async () => {
    const email = uniqueEmail('named');
    const response = await requestLink(email, {
      body: {
        email,
        name: `Mallory ${'x'.repeat(500)}`,
        callbackURL: 'https://evil.example/',
        newUserCallbackURL: 'https://evil.example/new',
      },
    });
    expect(response.status).toBe(200);
    expect((await sentEmails(email)).at(-1)?.body.text).not.toContain('evil.example');

    const verified = await verifyMagicLink(await magicLinkTokenFor(email));
    const body = await verified.json<{ user: { id: string; name: string } }>();
    expect(verified.status).toBe(200);
    expect(body.user.name).toBe('');
  });

  it('answers 400 to a NUL anywhere in the body and counts nothing', async () => {
    const email = uniqueEmail('nul');
    const installId = uniqueInstallId('nul');
    const escaped = await requestLink(email, {
      installId,
      body: { email, name: 'bad\u0000name' },
    });
    const inEmail = await requestLink(email, { installId, body: { email: `${email}\u0000` } });

    expect(escaped.status).toBe(400);
    expect((await escaped.json<{ code: string }>()).code).toBe('INVALID_BODY');
    expect(inEmail.status).toBe(400);
    expect(await sentEmails(email)).toHaveLength(0);
    expect(await addressCounters(email, { [INSTALL_ID_HEADER]: installId })).toHaveLength(0);
  });

  it('lets Better Auth answer an invalid email or a body without one, uncounted', async () => {
    const noEmail = await requestLink('', { body: { name: 'x' } });
    const badEmail = await requestLink('', { body: { email: 'not-an-email' } });

    expect(noEmail.status).toBe(400);
    expect(badEmail.status).toBe(400);
    expect(noEmail.headers.get('content-type')).toContain('application/json');
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

  it('consumes the token: a second verify is a 400 JSON body with a code, not a redirect', async () => {
    const email = uniqueEmail('once');
    await requestLink(email);
    const token = await magicLinkTokenFor(email);

    const first = await verifyMagicLink(token);
    const second = await verifyMagicLink(token);
    const body = await second.json<{ code: string; requestId: string }>();

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(second.headers.get('location')).toBeNull();
    expect(second.headers.get('content-type')).toContain('application/json');
    expect(body.code).toBe('INVALID_TOKEN');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      second.headers
        .getSetCookie()
        .some((line) => line.includes('session_token=') && !line.includes('session_token=;')),
    ).toBe(false);
  });

  it('refuses callback URLs with 400 (no redirect can ever carry the cookie) and a malformed token without touching the link', async () => {
    const email = uniqueEmail('callback');
    await requestLink(email);
    const token = await magicLinkTokenFor(email);

    const withCallback = await worker(
      jsonRequest(
        `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=%2F`,
        'GET',
        undefined,
        { origin: null },
      ),
    );
    const malformed = await verifyMagicLink('<script>alert(1)</script>');
    const stillValid = await verifyMagicLink(token);

    expect(withCallback.status).toBe(400);
    expect((await withCallback.json<{ code: string }>()).code).toBe('CALLBACK_URL_NOT_SUPPORTED');
    expect(malformed.status).toBe(400);
    expect((await malformed.json<{ code: string }>()).code).toBe('INVALID_TOKEN');
    expect(stillValid.status).toBe(200);
  });

  it('upgrades an anonymous user who requested the link: rows re-keyed, anonymous row marked, sessions revoked, once', async () => {
    const anonymous = await signInAnonymously();
    const email = uniqueEmail('upgrade');
    const installId = uniqueInstallId('upgrade');
    expect((await registerDevice(anonymous, installId)).status).toBe(200);

    const { result: upgraded, lines } = await captureLogs(() =>
      signInWithMagicLink(email, { ip: anonymous.ip, cookie: anonymous.cookie }),
    );
    expect(upgraded.userId).not.toBe(anonymous.userId);
    expect(logEvents(lines, 'merge_committed')).toHaveLength(1);
    expect(logEvents(lines, 'merge_skipped')).toHaveLength(0);
    expect(await userStatus(anonymous.userId)).toBe('deleting');

    // The device followed the user and the old cookie no longer resolves.
    const [device] = await withDb(testEnv, (db) =>
      db.select({ userId: devices.userId }).from(devices).where(eq(devices.installId, installId)),
    );
    expect(device?.userId).toBe(upgraded.userId);
    const me = await worker(jsonRequest('/v1/me', 'GET', undefined, { cookie: upgraded.cookie }));
    expect((await me.json<{ user: { id: string } }>()).user.id).toBe(upgraded.userId);
    const stale = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { cookie: sessionTokenOnly(anonymous.cookie) }),
    );
    expect(stale.status).toBe(401);
  });

  it('signs a victim in but merges nothing when they verify a link someone else requested (login CSRF)', async () => {
    // The attacker requests a link for THEIR address with no session, takes the token from
    // their inbox and gets the victim to open it. The victim's app verifies with the victim's
    // anonymous cookie attached.
    const attackerEmail = uniqueEmail('attacker');
    const attacker = await signInWithMagicLink(attackerEmail);
    const victim = await signInAnonymously();
    const installId = uniqueInstallId('victim');
    expect(
      (
        await registerDevice(victim, installId, {
          pushTokenKind: 'apns',
          pushToken: `apns-${crypto.randomUUID()}`,
        })
      ).status,
    ).toBe(200);
    await requestLink(attackerEmail);
    const token = await magicLinkTokenFor(attackerEmail);

    const { result: verified, lines } = await captureLogs(() =>
      verifyMagicLink(token, { ip: victim.ip, cookie: victim.cookie }),
    );
    const body = await verified.json<{ user: { id: string } }>();

    // The sign-in itself succeeds (it is the attacker's own valid link) ...
    expect(verified.status).toBe(200);
    expect(body.user.id).toBe(attacker.userId);
    // ... but nothing of the victim's moved, and the victim's anonymous account is untouched.
    const skipped = logEvents(lines, 'merge_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.['reason']).toBe('requester_mismatch');
    expect(logEvents(lines, 'merge_committed')).toHaveLength(0);
    const [device] = await withDb(testEnv, (db) =>
      db.select({ userId: devices.userId }).from(devices).where(eq(devices.installId, installId)),
    );
    expect(device?.userId).toBe(victim.userId);
    expect(await userStatus(victim.userId)).toBe('active');
    const stillAnonymous = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { cookie: sessionTokenOnly(victim.cookie) }),
    );
    expect(stillAnonymous.status).toBe(200);
  });

  it('merges only for the anonymous user who requested: another anonymous verifier is signed in, not merged', async () => {
    const requester = await signInAnonymously();
    const other = await signInAnonymously();
    const email = uniqueEmail('other-verifier');
    expect((await requestLink(email, { ip: requester.ip, cookie: requester.cookie })).status).toBe(
      200,
    );
    const token = await magicLinkTokenFor(email);

    const { result: verified, lines } = await captureLogs(() =>
      verifyMagicLink(token, { ip: other.ip, cookie: other.cookie }),
    );

    expect(verified.status).toBe(200);
    expect(logEvents(lines, 'merge_skipped').map((line) => line['reason'])).toEqual([
      'requester_mismatch',
    ]);
    expect(await userStatus(other.userId)).toBe('active');
    expect(await userStatus(requester.userId)).toBe('active');
  });
});

describe('the emailed landing page and the browser consume route', () => {
  it('GET /auth/magic-link never consumes the token: a scanner gets a page, the app still verifies', async () => {
    const anonymous = await signInAnonymously();
    const email = uniqueEmail('landing');
    await requestLink(email, { ip: anonymous.ip, cookie: anonymous.cookie });
    const url = await magicLinkUrlFor(email);
    const path = new URL(url).pathname + new URL(url).search;

    const scanner = await worker(
      new Request(`${API_ORIGIN}${path}`, {
        method: 'GET',
        headers: { 'cf-connecting-ip': uniqueIp(), 'user-agent': 'Mozilla/5.0 (SafeLinks)' },
      }),
    );
    const html = await scanner.text();

    expect(new URL(url).pathname).toBe(MAGIC_LINK_LANDING_PATH);
    expect(scanner.status).toBe(200);
    expect(scanner.headers.get('content-type')).toContain('text/html');
    expect(scanner.headers.get('cache-control')).toBe('no-store');
    expect(scanner.headers.get('referrer-policy')).toBe('no-referrer');
    expect(scanner.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(scanner.headers.getSetCookie()).toHaveLength(0);
    expect(html).toContain(`action="${MAGIC_LINK_CONSUME_PATH}"`);
    expect(html).toContain('type="hidden" name="token"');
    expect(html).not.toContain('<script');

    // The token is intact: the app's verify with the anonymous cookie signs in and merges.
    const { result: verified, lines } = await captureLogs(async () =>
      verifyMagicLink(await magicLinkTokenFor(email), {
        ip: anonymous.ip,
        cookie: anonymous.cookie,
      }),
    );
    expect(verified.status).toBe(200);
    expect(logEvents(lines, 'merge_committed')).toHaveLength(1);
    expect(await userStatus(anonymous.userId)).toBe('deleting');
  });

  it('answers a 400 page for a missing or malformed token', async () => {
    const missing = await worker(
      new Request(`${API_ORIGIN}${MAGIC_LINK_LANDING_PATH}`, {
        headers: { 'cf-connecting-ip': uniqueIp() },
      }),
    );
    const malformed = await worker(
      new Request(`${API_ORIGIN}${MAGIC_LINK_LANDING_PATH}?token=%3Cscript%3E`, {
        headers: { 'cf-connecting-ip': uniqueIp() },
      }),
    );

    expect(missing.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain('<script>');
  });

  it('POST /api/auth/magic-link/consume verifies server side, sets the session cookie, and works once', async () => {
    const email = uniqueEmail('consume');
    await requestLink(email);
    const token = await magicLinkTokenFor(email);
    const consume = (origin: string | null) =>
      worker(
        new Request(`${API_ORIGIN}${MAGIC_LINK_CONSUME_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'cf-connecting-ip': uniqueIp(),
            ...(origin === null ? {} : { origin }),
          },
          body: new URLSearchParams({ token }).toString(),
        }),
      );

    const first = await consume(testEnv.API_PUBLIC_URL);
    const html = await first.text();
    const second = await consume(testEnv.API_PUBLIC_URL);

    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('signed in');
    expect(cookiesFrom(first)).toContain('better-auth.session_token=');
    const me = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { cookie: cookiesFrom(first) }),
    );
    expect((await me.json<{ user: { email: string } }>()).user.email).toBe(email);
    expect(second.status).toBe(400);
    expect(cookiesFrom(second)).toBeNull();
  });

  it('refuses a consume POST from a foreign origin with 403 and leaves the token intact', async () => {
    const email = uniqueEmail('csrf-consume');
    await requestLink(email);
    const token = await magicLinkTokenFor(email);

    const foreign = await worker(
      new Request(`${API_ORIGIN}${MAGIC_LINK_CONSUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-connecting-ip': uniqueIp(),
          origin: 'https://evil.example',
        },
        body: new URLSearchParams({ token }).toString(),
      }),
    );

    expect(foreign.status).toBe(403);
    expect(cookiesFrom(foreign)).toBeNull();
    expect((await verifyMagicLink(token)).status).toBe(200);
  });
});
