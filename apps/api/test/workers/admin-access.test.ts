/**
 * `/admin` behind Cloudflare Access (increment 12, ruling W5).
 *
 * The assertion (`Cf-Access-Jwt-Assertion`) is validated against the team's certs, fetched
 * through the injected `fetch` (no network: the fetch below answers the certs URL, the Analytics
 * Engine SQL API and the Queues API) and cached; every failure is 403 with an empty body. The
 * deployed Worker, whose `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are empty in every environment until
 * the owner creates the Access application, answers 403 to everyone. A valid assertion gets the
 * server-rendered page: provider calls per flight key and per provider per day (the rollup rows
 * summed, the ProviderBudget object's own row apart), today's figures from the SQL API, the
 * Durable Object schema versions, the sync watermark lag, the queue depths, the horizon and the
 * epoch, and the last housekeeping audit rows, under a strict CSP with no script.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env as workerEnv, exports } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { uuidv7 } from '@planeahead/shared';
import { createApp } from '../../src/app';
import type { Env } from '../../src/env';
import { MIGRATION_HASH } from '../../src/generated/migration-hash';
import { deletedSubjectHash } from '../../src/lib/hmac';
import { sessionTombstoneKey } from '../../src/lib/session-tombstone';
import {
  ACCESS_CERTS_REFETCH_MS,
  ACCESS_JWT_HEADER,
  accessCertsUrl,
  type AccessCertsCache,
} from '../../src/middleware/access';
import { sessionTokenFromCookie } from '../../src/middleware/auth';
import {
  ADMIN_ACCOUNT_DELETE_PATH,
  PARTIAL_STATS_NOTICE,
  createAdminRoutes,
  environmentQueueNames,
  watermarkHtml,
} from '../../src/routes/admin';
import { DO_SCHEMA_VERSIONS } from '../../src/routes/health';
import { API_ORIGIN, jsonRequest, signInAnonymously, testEnv, worker } from './helpers/auth';
import { drainTouched } from './helpers/flights';
import { db, seedTracker, seededFlightFor, subscribe, subscriberCount } from './helpers/routes';

afterEach(drainTouched);

const TEAM = 'planeahead-test.cloudflareaccess.com';
const AUD = 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1';
const ACCOUNT_ID = '0123456789abcdef0123456789abcdef';

async function signingKey(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwk, kid };
}

type Key = Awaited<ReturnType<typeof signingKey>>;

function assertion(
  key: Key,
  overrides: { iss?: string; aud?: string; expSeconds?: number; sub?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: 'owner@planeahead.app', type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(overrides.iss ?? `https://${TEAM}`)
    .setAudience([overrides.aud ?? AUD])
    .setSubject(overrides.sub ?? 'access-user-1')
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (overrides.expSeconds ?? 600))
    .sign(key.privateKey);
}

interface FakeCloudflare {
  readonly fetch: typeof fetch;
  certsFetches: number;
  published: Key[];
  readonly sqlStatements: string[];
}

function fakeCloudflare(published: Key[]): FakeCloudflare {
  const fake: FakeCloudflare = {
    certsFetches: 0,
    published,
    sqlStatements: [],
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === accessCertsUrl(TEAM)) {
        fake.certsFetches += 1;
        return Promise.resolve(Response.json({ keys: fake.published.map((key) => key.jwk) }));
      }
      if (url.endsWith(`/accounts/${ACCOUNT_ID}/analytics_engine/sql`)) {
        fake.sqlStatements.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(
          Response.json({
            meta: [],
            data: [
              { provider: 'aerodatabox', calls: '42', cost_units: 84, cost_usd_micros: 21_000 },
            ],
            rows: 1,
          }),
        );
      }
      if (url.includes(`/accounts/${ACCOUNT_ID}/queues/`) && url.endsWith('/metrics')) {
        return Promise.resolve(
          Response.json({
            success: true,
            result: {
              backlog_count: 7,
              backlog_bytes: 1_234,
              oldest_message_timestamp_ms: Date.UTC(2026, 8, 23, 3, 0, 0),
            },
          }),
        );
      }
      if (url.includes(`/accounts/${ACCOUNT_ID}/queues`)) {
        return Promise.resolve(
          Response.json({
            success: true,
            result: environmentQueueNames('local').map((name, index) => ({
              queue_id: `q${String(index)}`,
              queue_name: name,
            })),
          }),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    },
  };
  return fake;
}

function adminEnv(overrides: Partial<Record<string, string>> = {}): Env {
  return {
    ...testEnv,
    API_PUBLIC_URL: API_ORIGIN,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    CF_ACCOUNT_ID: ACCOUNT_ID,
    CF_API_TOKEN: 'test-analytics-token',
    ...overrides,
  } as unknown as Env;
}

interface AdminRequestOptions {
  readonly env?: Env;
  readonly cache?: AccessCertsCache;
  readonly now?: () => number;
  readonly path?: string;
  readonly method?: 'GET' | 'POST';
  /** A form body (`application/x-www-form-urlencoded`). */
  readonly form?: Record<string, string>;
  readonly origin?: string;
}

async function getAdmin(
  fake: FakeCloudflare,
  token: string | null,
  options: AdminRequestOptions = {},
): Promise<Response> {
  const app = createApp();
  app.route(
    '/admin',
    createAdminRoutes({
      access: { fetch: fake.fetch, cache: options.cache ?? new Map(), now: options.now },
      fetch: fake.fetch,
    }),
  );
  const ctx = createExecutionContext();
  const headers: Record<string, string> = token === null ? {} : { [ACCESS_JWT_HEADER]: token };
  if (options.origin !== undefined) {
    headers['origin'] = options.origin;
  }
  if (options.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const response = await app.fetch(
    new Request(`${API_ORIGIN}${options.path ?? '/admin'}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.form === undefined ? {} : { body: new URLSearchParams(options.form).toString() }),
    }),
    options.env ?? adminEnv(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

async function expectForbidden(response: Response): Promise<void> {
  expect(response.status).toBe(403);
  expect(await response.text()).toBe('');
  expect(response.headers.get('cache-control')).toBe('no-store');
}

/**
 * The `Origin` a browser sends on a same-origin form POST from a page served with the given
 * `Referrer-Policy` (the Fetch standard's "append a request Origin header" step): `null` under
 * `no-referrer`, the page's own origin under every other policy. The deletion POSTs below carry
 * this instead of a hand-set constant, so a page whose policy makes a real browser send `null`
 * fails here the way it failed the operator (re-review finding rr-ops-1).
 */
function originImpliedBy(page: Response, pageUrl: string): string {
  return page.headers.get('referrer-policy') === 'no-referrer' ? 'null' : new URL(pageUrl).origin;
}

describe('/admin in the deployed Worker', () => {
  it('answers 403 with no body while Access is not configured, assertion or not', async () => {
    const key = await signingKey('k1');
    await expectForbidden(await exports.default.fetch(`${API_ORIGIN}/admin`));
    await expectForbidden(
      await exports.default.fetch(`${API_ORIGIN}/admin`, {
        headers: { [ACCESS_JWT_HEADER]: await assertion(key) },
      }),
    );
    await expectForbidden(await exports.default.fetch(`${API_ORIGIN}/admin/anything`));
  });
});

describe('the Access assertion', () => {
  it('refuses a missing, forged, expired, mis-issued or mis-addressed assertion with 403', async () => {
    const key = await signingKey('k1');
    const stranger = await signingKey('k1');
    const fake = fakeCloudflare([key]);

    await expectForbidden(await getAdmin(fake, null));
    await expectForbidden(await getAdmin(fake, 'not.a.jwt'));
    await expectForbidden(await getAdmin(fake, await assertion(stranger)));
    await expectForbidden(await getAdmin(fake, await assertion(key, { expSeconds: -60 })));
    await expectForbidden(
      await getAdmin(fake, await assertion(key, { iss: 'https://evil.cloudflareaccess.com' })),
    );
    await expectForbidden(await getAdmin(fake, await assertion(key, { aud: 'another-app' })));
    // A team domain that is not a cloudflareaccess.com host is never fetched from.
    await expectForbidden(
      await getAdmin(fake, await assertion(key), {
        env: adminEnv({ ACCESS_TEAM_DOMAIN: 'evil.test' }),
      }),
    );
    await expectForbidden(
      await getAdmin(fake, await assertion(key), { env: adminEnv({ ACCESS_AUD: '' }) }),
    );
  });

  it('caches the certs, and refetches once for a key it does not hold (rotation)', async () => {
    const first = await signingKey('k1');
    const rotated = await signingKey('k2');
    const fake = fakeCloudflare([first]);
    const cache: AccessCertsCache = new Map();
    let now = Date.now();
    const clock = () => now;

    expect((await getAdmin(fake, await assertion(first), { cache, now: clock })).status).toBe(200);
    expect((await getAdmin(fake, await assertion(first), { cache, now: clock })).status).toBe(200);
    expect(fake.certsFetches).toBe(1);

    // Access rotates: the new key is published, the cache is older than the refetch floor.
    fake.published = [first, rotated];
    now += ACCESS_CERTS_REFETCH_MS + 1;
    expect((await getAdmin(fake, await assertion(rotated), { cache, now: clock })).status).toBe(
      200,
    );
    expect(fake.certsFetches).toBe(2);

    // An unknown key inside the refetch floor does not hammer the certs endpoint.
    const unknown = await signingKey('k3');
    await expectForbidden(await getAdmin(fake, await assertion(unknown), { cache, now: clock }));
    expect(fake.certsFetches).toBe(2);
  });
});

describe('the page', () => {
  it('renders every section from Postgres, the SQL API and the Queues API, read-only, no script', async () => {
    const key = await signingKey('k1');
    const fake = fakeCloudflare([key]);
    const handle = db();
    const flightKey = `AAL-${String(1 + Math.floor(Math.random() * 9_000))}-2100-02-03-KJFK`;
    await handle.execute(sql`
      insert into provider_calls (id, provider, operation, trigger, result, cost_units,
                                  cost_usd_micros, flight_key, request_id)
      values (${uuidv7()}::uuid, 'aerodatabox', 'flight_status', 'user_search', 'ok', 2, 500,
              ${flightKey}, 'admin-test')
    `);
    // A provider and a day no other file writes: the page sums per (day, provider).
    const day = new Date(Date.now() - 13 * 86_400_000).toISOString().slice(0, 10);
    await handle.execute(sql`
      insert into provider_call_daily (day, provider, operation, result, calls, cost_units,
                                       cost_usd_micros)
      values (${day}::date, 'faa_nas', 'status', 'ok', 31, 31, 155000),
             (${day}::date, 'faa_nas', 'budget_daily', 'ok', 29, 29, 145000)
      on conflict (day, provider, operation, result) do update
        set calls = excluded.calls, cost_units = excluded.cost_units,
            cost_usd_micros = excluded.cost_usd_micros
    `);
    const runId = `admin-${crypto.randomUUID()}`;
    await handle.execute(sql`
      insert into audit_log (actor_type, action, target_type, request_id, details)
      values ('system', 'housekeeping.sync_purge', 'housekeeping', ${`housekeeping:${runId}`},
              ${JSON.stringify({ run_id: runId, horizon: '17' })}::jsonb)
    `);

    const response = await getAdmin(fake, await assertion(key));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    // Every admin page but the account pages keeps `no-referrer` (ruling AB1).
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<form/i);
    expect(html).toContain('owner@planeahead.app');
    // Per flight key, the resolver's search record included (it now carries the key).
    expect(html).toContain(flightKey);
    // Per provider per day: the rollup row, and the ProviderBudget row apart from it.
    expect(html).toContain(
      `<td>${day}</td><td>faa_nas</td><td>31</td><td>31</td><td>$0.1550</td><td>29</td><td>29</td>`,
    );
    // Today from the SQL API, weighted by the sample interval.
    expect(
      fake.sqlStatements.some((statement) => statement.includes('SUM(_sample_interval)')),
    ).toBe(true);
    expect(html).toContain('<td>aerodatabox</td><td>42</td>');
    // The versions /health answers.
    expect(html).toContain(MIGRATION_HASH);
    expect(html).toContain(
      `<td>FlightTracker schema version</td><td>${String(DO_SCHEMA_VERSIONS.FlightTracker)}</td>`,
    );
    // Watermark, queues, horizon and epoch, housekeeping.
    expect(html).toContain('Watermark (pg_snapshot_xmin)');
    expect(html).toContain('<td>planeahead-housekeeping-local</td><td>7</td><td>1234</td>');
    expect(html).toContain('sync_epoch');
    expect(html).toContain('housekeeping.sync_purge');
    expect(html).not.toContain('class="unavailable"');
    // The suite's role is a superuser, so the watermark is complete; the one write action is a
    // link to its own page, and this page carries no form.
    expect(html).not.toContain(PARTIAL_STATS_NOTICE);
    expect(html).toContain(`href="${ADMIN_ACCOUNT_DELETE_PATH}"`);
    expect(csp).toContain("form-action 'none'");
  });

  it('marks the watermark lag partial when the role lacks pg_read_all_stats (ruling AA5)', () => {
    const row = {
      watermark: '1234',
      lag_seconds: '2.5',
      writers: 1,
      oldest_start: '2026-09-23 03:00:00+00',
    };
    expect(watermarkHtml({ ...row, full_stats: false })).toContain(PARTIAL_STATS_NOTICE);
    expect(watermarkHtml({ ...row, full_stats: true })).not.toContain(PARTIAL_STATS_NOTICE);
    expect(watermarkHtml({ ...row, full_stats: true })).toContain('<td>2.5 s</td>');
  });

  it('shows the Cloudflare API figures as unavailable without the token, and still renders', async () => {
    const key = await signingKey('k1');
    const fake = fakeCloudflare([key]);
    const response = await getAdmin(fake, await assertion(key), {
      env: adminEnv({ CF_API_TOKEN: '' }),
    });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html.match(/CF_ACCOUNT_ID or CF_API_TOKEN is not set/g)).toHaveLength(2);
    expect(fake.sqlStatements).toHaveLength(0);
    expect(html).toContain('Watermark (pg_snapshot_xmin)');
  });

  it('answers 404 behind Access for a path it does not serve, and 403 in front of it', async () => {
    const key = await signingKey('k1');
    const fake = fakeCloudflare([key]);
    expect((await getAdmin(fake, await assertion(key), { path: '/admin/users' })).status).toBe(404);
    await expectForbidden(await getAdmin(fake, null, { path: '/admin/users' }));
  });
});

describe('operator account deletion (ruling AA9)', () => {
  async function auditRows(userId: string) {
    return db().execute<{
      actor_type: string;
      actor_id: string | null;
      target_id: string | null;
      details: Record<string, unknown>;
    }>(sql`
      select actor_type, actor_id::text as actor_id, target_id::text as target_id, details
      from audit_log where subject_id = ${userId}::uuid and action = 'account.deleted'
    `);
  }

  const userExists = async (userId: string) => {
    const [row] = await db().execute<{ n: number }>(
      sql`select count(*)::int as n from users where id = ${userId}::uuid`,
    );
    return row?.n === 1;
  };

  it('shows the account, refuses a wrong confirmation or another origin, then deletes it as the app would', async () => {
    const key = await signingKey('k1');
    const fake = fakeCloudflare([key]);
    const token = await assertion(key);
    const session = await signInAnonymously();
    const flight = seededFlightFor();
    await seedTracker(flight);
    expect((await subscribe(session, { flightKey: flight.flightKey })).status).toBe(201);
    expect(await subscriberCount(flight.flightKey)).toBe(1);

    // The lookup: status and creation date, and a form that posts the id typed a second time.
    const empty = await getAdmin(fake, token, { path: ADMIN_ACCOUNT_DELETE_PATH });
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain('<form method="get"');
    const lookupPath = `${ADMIN_ACCOUNT_DELETE_PATH}?user_id=${session.userId}`;
    const lookup = await getAdmin(fake, token, { path: lookupPath });
    const page = await lookup.text();
    expect(lookup.status).toBe(200);
    expect(page).toContain(`<td>${session.userId}</td><td>active</td>`);
    expect(page).toContain(`<form method="post" action="${ADMIN_ACCOUNT_DELETE_PATH}">`);
    expect(page).not.toMatch(/<script/i);
    expect(lookup.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(lookup.headers.get('cache-control')).toBe('no-store');
    // The page must let the browser send its origin on the form's POST: under `no-referrer`
    // Chromium sends `Origin: null` and the route refuses the page's own button (rr-ops-1). The
    // header and the document's meta agree, and every POST below carries the origin the served
    // policy implies rather than a constant, so a regression to `no-referrer` fails the deletion.
    expect(lookup.headers.get('referrer-policy')).not.toBe('no-referrer');
    expect(lookup.headers.get('referrer-policy')).toBe('same-origin');
    expect(page).toContain('<meta name="referrer" content="same-origin">');
    const origin = originImpliedBy(lookup, `${API_ORIGIN}${lookupPath}`);

    // A confirmation that does not match changes nothing.
    const wrong = await getAdmin(fake, token, {
      method: 'POST',
      path: ADMIN_ACCOUNT_DELETE_PATH,
      origin,
      form: { user_id: session.userId, confirm_user_id: crypto.randomUUID() },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('Nothing was deleted');
    // Nor does a POST from another origin, one whose Origin is `null` (a cross-site form, or a
    // page under `no-referrer`), one without an Origin, or one without Access.
    const confirmed = { user_id: session.userId, confirm_user_id: session.userId.toUpperCase() };
    for (const sent of ['https://evil.test', 'null', undefined]) {
      const refused = await getAdmin(fake, token, {
        method: 'POST',
        path: ADMIN_ACCOUNT_DELETE_PATH,
        form: confirmed,
        ...(sent === undefined ? {} : { origin: sent }),
      });
      expect(refused.status, String(sent)).toBe(403);
      expect(await refused.text()).toBe('');
    }
    expect(
      (
        await getAdmin(fake, null, {
          method: 'POST',
          path: ADMIN_ACCOUNT_DELETE_PATH,
          origin,
          form: confirmed,
        })
      ).status,
    ).toBe(403);
    expect(await userExists(session.userId)).toBe(true);
    expect(await subscriberCount(flight.flightKey)).toBe(1);
    expect(await auditRows(session.userId)).toEqual([]);

    const deleted = await getAdmin(fake, token, {
      method: 'POST',
      path: ADMIN_ACCOUNT_DELETE_PATH,
      origin,
      form: confirmed,
    });

    expect(deleted.status).toBe(200);
    expect(await deleted.text()).toContain(`Account ${session.userId} was deleted.`);
    // Exactly the self-service path: the rows, the tracker, the deleted_subjects hash and the KV
    // tombstone of every session, and one audit row, here naming the operator.
    expect(await userExists(session.userId)).toBe(false);
    expect(await subscriberCount(flight.flightKey)).toBe(0);
    const sessionToken = sessionTokenFromCookie(session.cookie) ?? '';
    const hash = await deletedSubjectHash(
      testEnv.DELETED_SUBJECT_HMAC_KEY ?? '',
      'session',
      sessionToken,
    );
    const [subject] = await db().execute<{ n: number }>(sql`
      select count(*)::int as n from deleted_subjects
      where subject_id = ${session.userId}::uuid and provider_subject_hash = ${hash}
    `);
    expect(subject?.n).toBe(1);
    expect(await workerEnv.CACHE.get(sessionTombstoneKey(hash))).toBe('1');
    const audits = await auditRows(session.userId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_type: 'admin',
      actor_id: null,
      target_id: session.userId,
      details: {
        operator_email: 'owner@planeahead.app',
        operator_subject: 'access-user-1',
        subscriptions: 1,
        trackers_unsubscribed: 1,
        trackers_failed: 0,
      },
    });
    // The device that still holds the account's cookie is told to wipe its store.
    const other = await worker(
      jsonRequest('/v1/me', 'GET', undefined, { ip: session.ip, cookie: session.cookie }),
    );
    expect(other.status).toBe(401);
    expect((await other.json<{ error: string }>()).error).toBe('account_deleted');

    // A second confirmation finds nothing to delete; the result page keeps the same policy.
    expect(deleted.headers.get('referrer-policy')).toBe('same-origin');
    const again = await getAdmin(fake, token, {
      method: 'POST',
      path: ADMIN_ACCOUNT_DELETE_PATH,
      origin,
      form: confirmed,
    });
    expect(again.status).toBe(404);
  });

  it('refuses a lookup that is not a user id, and says when no account has the id', async () => {
    const key = await signingKey('k1');
    const fake = fakeCloudflare([key]);
    const token = await assertion(key);
    const bad = await getAdmin(fake, token, {
      path: `${ADMIN_ACCOUNT_DELETE_PATH}?user_id=${encodeURIComponent('<b>x</b>')}`,
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('<b>x</b>');
    const missing = await getAdmin(fake, token, {
      path: `${ADMIN_ACCOUNT_DELETE_PATH}?user_id=${crypto.randomUUID()}`,
    });
    expect(missing.status).toBe(404);
  });
});
