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
import { exports } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@planeahead/shared';
import { createApp } from '../../src/app';
import type { Env } from '../../src/env';
import { MIGRATION_HASH } from '../../src/generated/migration-hash';
import {
  ACCESS_CERTS_REFETCH_MS,
  ACCESS_JWT_HEADER,
  accessCertsUrl,
  type AccessCertsCache,
} from '../../src/middleware/access';
import { createAdminRoutes, environmentQueueNames } from '../../src/routes/admin';
import { DO_SCHEMA_VERSIONS } from '../../src/routes/health';
import { API_ORIGIN, testEnv } from './helpers/auth';
import { db } from './helpers/routes';

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
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    CF_ACCOUNT_ID: ACCOUNT_ID,
    CF_API_TOKEN: 'test-analytics-token',
    ...overrides,
  } as unknown as Env;
}

async function getAdmin(
  fake: FakeCloudflare,
  token: string | null,
  options: { env?: Env; cache?: AccessCertsCache; now?: () => number; path?: string } = {},
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
  const response = await app.fetch(
    new Request(`${API_ORIGIN}${options.path ?? '/admin'}`, {
      headers: token === null ? {} : { [ACCESS_JWT_HEADER]: token },
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
