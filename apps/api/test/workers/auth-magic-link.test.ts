/**
 * Magic link through the real Worker, with the Resend endpoint served by the test run.
 *
 * What is pinned here: the request answers 200 whether or not the email exists, stores a HASHED
 * token and emails the non-consuming landing URL with a digest idempotency key; the gate in
 * front of Better Auth runs for every request (keyed or not), counts only what Better Auth would
 * accept, refuses the 4th request in an hour from the same requester with the same 200 and no
 * mail, keeps a stranger's requests off the address owner's budget, bounds what one inbox can
 * receive from every requester combined (an IPv6 /64 rotating addresses and install ids is one
 * requester and cannot get past that ceiling), answers 429 to one client address that asks too
 * often without locking a shared NAT egress out, and forwards `{ email }` alone; the verify
 * request, made the way the app makes it, answers JSON plus Set-Cookie on success and JSON 400
 * on failure; the anonymous merge runs only for the anonymous user who requested the link; and
 * the browser landing page never consumes the token while its consume route does, for the
 * headers a browser actually sends.
 */

import { and, eq, inArray, like } from 'drizzle-orm';
import { devices, rateLimits, usageCounters, users, verifications } from '@planeahead/db';
import { describe, expect, it } from 'vitest';
import { MAGIC_LINK_CONSUME_PATH, MAGIC_LINK_LANDING_PATH } from '../../src/auth/paths';
import {
  type CounterSubjects,
  MAGIC_LINK_ADDRESS_HOUR_CAP,
  MAGIC_LINK_COUNTER,
  MAGIC_LINK_HOUR_CAP,
  MAGIC_LINK_REQUESTER_HOUR_CAP,
  magicLinkSubjects,
  requestersOf,
  windowsAt,
} from '../../src/middleware/magic-link-cap';
import { IDEMPOTENCY_KEY_HEADER, INSTALL_ID_HEADER } from '../../src/middleware/idempotency';
import {
  MAGIC_LINK_ADDRESS_DAY_CAP,
  addressCeilingSubjects,
  canonicalMailbox,
} from '../../src/middleware/magic-link-ceiling';
import { normaliseClientIp } from '../../src/validation/client-ip';
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
// One client for the file: a `withDb` per helper call held a connection until the file ended.
import { withFileDb } from './helpers/routes';

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

/** The owner rows for one (address, requester) pair, as the gate keys them. */
async function addressCounters(email: string, headers: Record<string, string>) {
  const subjects = await magicLinkSubjects(email, requestersOf(new Headers(headers)));
  return withFileDb((db) =>
    db
      .select({ subject: usageCounters.subject, count: usageCounters.count })
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.scope, subjects.owner.scope),
          inArray(usageCounters.subject, [subjects.owner.hour, subjects.owner.day]),
          eq(usageCounters.counter, MAGIC_LINK_COUNTER),
        ),
      ),
  );
}

/** The gate's subjects for a client address alone (the requester brake ignores the email). */
function requesterSubjects(ip: string): Promise<CounterSubjects> {
  return magicLinkSubjects(
    'any@example.test',
    requestersOf(new Headers({ 'cf-connecting-ip': ip })),
  ).then((subjects) => subjects.requester);
}

/** Writes one counter row at `count`, as if that many requests had already been made. */
async function seedCounter(subject: CounterSubjects, window: 'hour' | 'day', count: number) {
  const windows = windowsAt(Date.now());
  await withFileDb((db) =>
    db
      .insert(usageCounters)
      .values({
        scope: subject.scope,
        subject: window === 'hour' ? subject.hour : subject.day,
        counter: MAGIC_LINK_COUNTER,
        windowStart: window === 'hour' ? windows.hourStart : windows.dayStart,
        count,
      })
      .onConflictDoUpdate({
        target: [
          usageCounters.scope,
          usageCounters.subject,
          usageCounters.counter,
          usageCounters.windowStart,
        ],
        set: { count },
      }),
  );
}

async function counterValue(subject: string): Promise<number | undefined> {
  const [row] = await withFileDb((db) =>
    db
      .select({ count: usageCounters.count })
      .from(usageCounters)
      .where(and(eq(usageCounters.subject, subject), eq(usageCounters.counter, MAGIC_LINK_COUNTER)))
      .limit(1),
  );
  return row?.count;
}

/**
 * Forgets Better Auth's own per-IP window (3 per 60 s, keyed by the /64) for one client, as if
 * a minute had passed, so what is measured is the gate and not Better Auth's limiter.
 */
async function resetBetterAuthLimiter(ip: string) {
  const key = normaliseClientIp(ip) ?? ip;
  await withFileDb((db) => db.delete(rateLimits).where(like(rateLimits.key, `${key}|%`)));
}

/** A fresh documentation-range /64 for one test, so parallel files never share it. */
function uniqueIpv6Subnet(): string {
  const group = () => Math.floor(Math.random() * 0x10000).toString(16);
  return `2001:db8:${group()}:${group()}`;
}

async function userStatus(userId: string): Promise<string | undefined> {
  const [row] = await withFileDb((db) =>
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
    const rows = await withFileDb((db) =>
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

  it('bounds what one inbox can receive: a /64 rotating addresses AND install ids gets silence, not 25 mails', async () => {
    // The re-review's probe: 25 requests for one victim address, each from a new /128 in one
    // /64 with a new install id, Better Auth's own window forgotten before each. The earlier
    // gate keyed the requester by the raw address and saw 25 requesters with a fresh budget
    // each (25 mails). Now the /64 is one requester and, whatever the requester, the address
    // ceiling ends the mail after MAGIC_LINK_ADDRESS_HOUR_CAP.
    const email = uniqueEmail('ipv6-victim');
    const subnet = uniqueIpv6Subnet();
    const statuses: number[] = [];
    for (let host = 1; host <= 25; host += 1) {
      const ip = `${subnet}::${host.toString(16)}`;
      await resetBetterAuthLimiter(ip);
      const response = await requestLink(email, { ip, installId: uniqueInstallId('rotating') });
      statuses.push(response.status);
    }

    expect(statuses).toEqual(Array<number>(25).fill(200));
    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_ADDRESS_HOUR_CAP);
    // The brake counted all 25 against ONE requester, the /64.
    const requester = await requesterSubjects(`${subnet}::ffff`);
    expect(await counterValue(requester.hour)).toBe(25);
  });

  it('counts the address ceiling by mail sent, not by request: 31 stranger requests (3 mails) do not lock the owner out', async () => {
    // The second re-review's probe: before this, every request bumped the ceiling before any
    // check, so a stranger locked an address out of email sign-in for the day with 31 requests
    // and zero mail. The ceiling is now bumped by the sender for accepted mail only.
    const email = uniqueEmail('ceiling-victim');
    const stranger = uniqueInstallId('stranger');
    for (let attempt = 0; attempt < MAGIC_LINK_ADDRESS_DAY_CAP + 1; attempt += 1) {
      expect((await requestLink(email, { installId: stranger })).status).toBe(200);
    }
    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_HOUR_CAP);
    const ceiling = await addressCeilingSubjects(email);
    expect(await counterValue(ceiling.hour)).toBe(MAGIC_LINK_HOUR_CAP);
    expect(await counterValue(ceiling.day)).toBe(MAGIC_LINK_HOUR_CAP);

    const own = await requestLink(email, { installId: uniqueInstallId('owner') });

    expect(own.status).toBe(200);
    expect(await sentEmails(email)).toHaveLength(MAGIC_LINK_HOUR_CAP + 1);
  });

  it('keys the ceiling by the canonical mailbox: plus-tags and Gmail dots share one inbox', async () => {
    expect(canonicalMailbox('Vic.Tim+news@GoogleMail.com')).toBe('victim@gmail.com');
    expect(canonicalMailbox('victim+a@example.test')).toBe('victim@example.test');
    expect(canonicalMailbox('vic.tim@example.test')).toBe('vic.tim@example.test');
    const base = uniqueEmail('plus');
    const [local, domain] = base.split('@') as [string, string];
    const tagged = (tag: string) => `${local}+${tag}@${domain.toUpperCase()}`;
    // Seed the inbox's ceiling at the cap under one tag; a request under another tag from a
    // fresh requester answers 200 and sends nothing.
    const ceiling = await addressCeilingSubjects(tagged('a'));
    expect(ceiling.hour).toBe((await addressCeilingSubjects(tagged('b'))).hour);
    await seedCounter(ceiling, 'hour', MAGIC_LINK_ADDRESS_HOUR_CAP);

    const response = await requestLink(tagged('b'), { installId: uniqueInstallId('tagged') });

    expect(response.status).toBe(200);
    expect(await sentEmails(tagged('b'))).toHaveLength(0);
  });

  it('answers 429 with Retry-After to one client address that asked too often, whatever the install id and the /128', async () => {
    // Keyed by the client address (not client-chosen), reduced to the /64 for IPv6; the
    // install id is rotated and does not help. The hour row is written at the cap directly:
    // the increment above is the same statement the owner-cap cases exercise, and a hundred
    // real requests would only measure the mail fake.
    const subnet = uniqueIpv6Subnet();
    const ipv4 = uniqueIp();
    await seedCounter(
      await requesterSubjects(`${subnet}::1`),
      'hour',
      MAGIC_LINK_REQUESTER_HOUR_CAP,
    );
    await seedCounter(await requesterSubjects(ipv4), 'hour', MAGIC_LINK_REQUESTER_HOUR_CAP);
    const sixEmail = uniqueEmail('braked-v6');
    const fourEmail = uniqueEmail('braked-v4');

    const six = await requestLink(sixEmail, {
      ip: `${subnet}:1:2:3:4`,
      installId: uniqueInstallId('rotating'),
    });
    const four = await requestLink(fourEmail, { ip: ipv4, installId: uniqueInstallId('rotating') });
    const body = await six.json<{ code?: string }>();

    expect(six.status).toBe(429);
    expect(body.code).toBe('TOO_MANY_REQUESTS');
    expect(six.headers.get('Retry-After')).toMatch(/^\d+$/);
    expect(Number(six.headers.get('Retry-After'))).toBeLessThanOrEqual(3600);
    expect(four.status).toBe(429);
    // Nothing was mailed for the addresses that tripped the gate.
    expect(await sentEmails(sixEmail)).toHaveLength(0);
    expect(await sentEmails(fourEmail)).toHaveLength(0);
  });

  it('does not lock a shared egress out: an address that asked 60 times today is still served', async () => {
    // Airport Wi-Fi, CGNAT, Private Relay: many users behind one IPv4. The earlier brake (20
    // per hour, 60 per day per address) answered every one of them 429 once one of them, or one
    // attacker among them, had used the budget. The brake is now NAT scale.
    const ip = uniqueIp();
    const requester = await requesterSubjects(ip);
    await seedCounter(requester, 'hour', 20);
    await seedCounter(requester, 'day', 60);
    const email = uniqueEmail('nat-neighbour');

    const response = await requestLink(email, { ip, installId: uniqueInstallId('neighbour') });

    expect(response.status).toBe(200);
    expect(await sentEmails(email)).toHaveLength(1);
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
    const row = await withFileDb((db) =>
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
    const [device] = await withFileDb((db) =>
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
    const [device] = await withFileDb((db) =>
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
    // strict-origin, not no-referrer: the latter made browsers send `Origin: null` on the form
    // post and the consume route refused the page's own button.
    expect(scanner.headers.get('referrer-policy')).toBe('strict-origin');
    expect(html).toContain('<meta name="referrer" content="strict-origin">');
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

  /** The form post, with exactly the request headers named (a browser adds its own). */
  function consume(token: string, headers: Record<string, string>): Promise<Response> {
    return worker(
      new Request(`${API_ORIGIN}${MAGIC_LINK_CONSUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'cf-connecting-ip': uniqueIp(),
          ...headers,
        },
        body: new URLSearchParams({ token }).toString(),
      }),
    );
  }

  /** What a current browser sends from the page under `strict-origin`. */
  const BROWSER_HEADERS = { origin: testEnv.API_PUBLIC_URL, 'sec-fetch-site': 'same-origin' };

  it('POST /api/auth/magic-link/consume verifies server side, sets the session cookie, and works once', async () => {
    const email = uniqueEmail('consume');
    await requestLink(email);
    const token = await magicLinkTokenFor(email);

    const first = await consume(token, BROWSER_HEADERS);
    const html = await first.text();
    const second = await consume(token, BROWSER_HEADERS);

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

  it('accepts Origin: null from the page itself (Sec-Fetch-Site same-origin), the headers no-referrer made browsers send', async () => {
    // The first landing page declared `no-referrer`, under which a browser sends `Origin: null`
    // on a non-GET request; the consume route then answered the page's own button 403. The
    // pair below was captured from Chromium against that page and must pass.
    const email = uniqueEmail('origin-null');
    await requestLink(email);
    const token = await magicLinkTokenFor(email);

    const response = await consume(token, { origin: 'null', 'sec-fetch-site': 'same-origin' });

    expect(response.status).toBe(200);
    expect(cookiesFrom(response)).toContain('better-auth.session_token=');
  });

  it('refuses a cross-site form post (403) whatever Origin says, and Origin: null without Sec-Fetch-Site, leaving the token intact', async () => {
    const email = uniqueEmail('csrf-consume');
    await requestLink(email);
    const token = await magicLinkTokenFor(email);

    const foreign = await consume(token, {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    const spoofed = await consume(token, {
      origin: testEnv.API_PUBLIC_URL ?? '',
      'sec-fetch-site': 'cross-site',
    });
    const sibling = await consume(token, {
      origin: 'https://www.planeahead.app',
      'sec-fetch-site': 'same-site',
    });
    const opaque = await consume(token, { origin: 'null' });
    const legacy = await consume(token, { origin: 'https://evil.example' });

    for (const refused of [foreign, spoofed, sibling, opaque, legacy]) {
      expect(refused.status).toBe(403);
      expect(cookiesFrom(refused)).toBeNull();
    }
    expect((await verifyMagicLink(token)).status).toBe(200);
  });
});
