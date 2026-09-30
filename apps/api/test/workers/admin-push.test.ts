/**
 * The push transport on the admin page (increment 14, rulings P8 and P9), end to end in the
 * Workers pool with a stubbed network: the section on `/admin` (configuration, credentials, the
 * outcomes of the last 24 hours), and "Send a test push": the form, its refusals (another origin,
 * no Access, an unregistered token, production without the allow list), then the whole path. The
 * POST puts one job on the push queue (captured here, because the pool would hand a real send to
 * the consumer with no stub in it); the real consumer sends it with the real `PushAuth` object's
 * token through the real APNs transport, whose `fetch` is the stub; the real persist consumer
 * records the outcome; and the result page shows the status and the `apns-id`, or the reason.
 */

import {
  createExecutionContext,
  createMessageBatch,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { PushJobV1 } from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import type { Env } from '../../src/env';
import { createLogger } from '../../src/observability/log';
import { ACCESS_JWT_HEADER, accessCertsUrl } from '../../src/middleware/access';
import { durableCredentialSource } from '../../src/push/credentials';
import { createApnsTransport } from '../../src/push/transport';
import { handlePersistBatch } from '../../src/queues/persist';
import { handlePushBatch } from '../../src/queues/push';
import { createAdminRoutes } from '../../src/routes/admin';
import {
  ADMIN_PUSH_RESULT_PATH,
  ADMIN_PUSH_TEST_PATH,
  TEST_PUSH_TTL_MS,
} from '../../src/routes/admin-push';
import { fromBase64Url } from '../../src/push/jwt';
import {
  apnsAnswer,
  capturingQueue,
  fakeFetch,
  publicKeyOf,
  type Responder,
} from '../unit/helpers/push';
import {
  API_ORIGIN,
  registerDevice,
  signInAnonymously,
  testEnv,
  uniqueInstallId,
} from './helpers/auth';
import { db } from './helpers/routes';

const TEAM = 'planeahead-push.cloudflareaccess.com';
const AUD = 'push0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1';

const keyPair = generateKeyPair('RS256', { extractable: true });

async function accessToken(): Promise<{ token: string; fetch: typeof fetch }> {
  const { privateKey, publicKey } = await keyPair;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'push-k1', alg: 'RS256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: 'owner@planeahead.app', type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'push-k1' })
    .setIssuer(`https://${TEAM}`)
    .setAudience([AUD])
    .setSubject('access-owner')
    .setIssuedAt(now - 10)
    .setExpirationTime(now + 600)
    .sign(privateKey);
  const certs: typeof fetch = (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return Promise.resolve(
      url === accessCertsUrl(TEAM)
        ? Response.json({ keys: [jwk] })
        : new Response('not found', { status: 404 }),
    );
  };
  return { token, fetch: certs };
}

function adminEnv(overrides: Partial<Record<string, string>> = {}): Env {
  return {
    ...testEnv,
    API_PUBLIC_URL: API_ORIGIN,
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    CF_ACCOUNT_ID: '',
    CF_API_TOKEN: '',
    ...overrides,
  } as unknown as Env;
}

interface AdminCall {
  readonly path: string;
  readonly method?: 'GET' | 'POST';
  readonly form?: Record<string, string>;
  readonly origin?: string;
  readonly env?: Env;
  readonly access?: boolean;
}

/** Calls `/admin` behind a valid Access assertion; the test job lands in `queued`. */
async function admin(call: AdminCall, queued: unknown[] = []): Promise<Response> {
  const access = await accessToken();
  const app = createApp();
  app.route(
    '/admin',
    createAdminRoutes({
      access: { fetch: access.fetch, cache: new Map() },
      fetch: access.fetch,
      pushQueue: () =>
        ({
          send: (body: unknown) => {
            queued.push(body);
            return Promise.resolve();
          },
        }) as unknown as Pick<Queue, 'send'>,
    }),
  );
  const headers: Record<string, string> = {};
  if (call.access !== false) {
    headers[ACCESS_JWT_HEADER] = access.token;
  }
  if (call.origin !== undefined) {
    headers['origin'] = call.origin;
  }
  if (call.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`${API_ORIGIN}${call.path}`, {
      method: call.method ?? 'GET',
      headers,
      ...(call.form === undefined ? {} : { body: new URLSearchParams(call.form).toString() }),
    }),
    call.env ?? adminEnv(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

interface RegisteredToken {
  readonly userId: string;
  readonly token: string;
  readonly pushTokenId: string;
}

async function registeredApnsToken(appId?: string): Promise<RegisteredToken> {
  const session = await signInAnonymously();
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const response = await registerDevice(session, uniqueInstallId('admin-push'), {
    pushTokenKind: 'apns',
    pushToken: token,
    pushEnvironment: 'sandbox',
    ...(appId === undefined ? {} : { appId }),
  });
  const body = await response.json<{ pushToken: { id: string } }>();
  return { userId: session.userId, token, pushTokenId: body.pushToken.id };
}

/** Runs the captured job through the real push consumer, then its outcome through persist. */
async function deliver(job: unknown, respond: Responder, env: Env = testEnv) {
  const network = fakeFetch(respond);
  const persistCapture = capturingQueue();
  const outcomes = persistCapture.sent;
  const pushBatch = createMessageBatch('planeahead-push-local', [
    { id: `push-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body: job },
  ]);
  const quiet = createLogger({}, () => undefined);
  const credentials = durableCredentialSource(env, { cache: new Map() });
  await handlePushBatch(
    pushBatch,
    { env, ctx: createExecutionContext(), log: quiet },
    {
      transports: { apns: createApnsTransport({ fetch: network.fetch, credentials }) },
      pushQueue: capturingQueue().queue,
      persistQueue: persistCapture.queue,
    },
  );
  const persistBatch = createMessageBatch(
    'planeahead-persist-local',
    outcomes.map((entry, index) => ({
      id: `outcome-${String(index)}`,
      timestamp: new Date(),
      attempts: 1,
      body: entry.body,
    })),
  );
  await handlePersistBatch(
    persistBatch,
    { env, ctx: createExecutionContext(), log: quiet },
    { db: db() },
  );
  return network;
}

async function sendTest(
  form: Record<string, string>,
  env: Env = adminEnv(),
): Promise<{ response: Response; job: PushJobV1 | null }> {
  const queued: unknown[] = [];
  const response = await admin(
    { path: ADMIN_PUSH_TEST_PATH, method: 'POST', origin: API_ORIGIN, form, env },
    queued,
  );
  return { response, job: queued.length === 0 ? null : PushJobV1.parse(queued[0]) };
}

describe('the push section of /admin (ruling P9)', () => {
  it('shows the configuration, the three credentials and the outcome counts, with a link to the test', async () => {
    const response = await admin({ path: '/admin' });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<h2>Push transport</h2>');
    expect(html).toContain('<td>APNs</td><td>yes</td><td></td>');
    expect(html).toContain('project planeahead-test');
    for (const name of ['apns:sandbox', 'apns:production', 'fcm']) {
      expect(html).toContain(`<td>${name}</td>`);
    }
    expect(html).toContain("Every attempt's outcome by reason");
    expect(html).toContain(`href="${ADMIN_PUSH_TEST_PATH}"`);
    // Still no form and no script on the operations page itself.
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/<script/i);
  });

  it('says which secret is missing when a platform is not configured, never a value', async () => {
    const response = await admin({
      path: '/admin',
      env: adminEnv({ APNS_KEY_P8: '', FCM_SERVICE_ACCOUNT_JSON: 'not json' }),
    });
    const html = await response.text();

    expect(html).toContain('<td>APNs</td><td>no</td><td>APNS_KEY_P8 is not set</td>');
    expect(html).toContain('FCM_SERVICE_ACCOUNT_JSON is not JSON');
    expect(html).toContain('not_configured');
    expect(html).not.toContain(testEnv.APNS_KEY_ID ?? 'unset');
  });
});

describe('Send a test push (ruling P8)', () => {
  it('serves a form that posts to this origin', async () => {
    const response = await admin({ path: ADMIN_PUSH_TEST_PATH });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`<form method="post" action="${ADMIN_PUSH_TEST_PATH}">`);
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('refuses another origin, a request without Access, an unknown token and a bad form', async () => {
    const token = await registeredApnsToken();
    const form = { token: token.token, kind: 'apns', app_id: '' };
    const queued: unknown[] = [];

    const crossSite = await admin(
      { path: ADMIN_PUSH_TEST_PATH, method: 'POST', origin: 'https://evil.test', form },
      queued,
    );
    const noAccess = await admin(
      { path: ADMIN_PUSH_TEST_PATH, method: 'POST', origin: API_ORIGIN, form, access: false },
      queued,
    );
    const unknown = await sendTest({ ...form, token: 'ab'.repeat(32) });
    const wrongKind = await sendTest({ ...form, kind: 'fcm' });
    const badKind = await sendTest({ ...form, kind: 'expo' });
    const badAppId = await sendTest({ ...form, app_id: 'no dots here' });

    expect(crossSite.status).toBe(403);
    expect(noAccess.status).toBe(403);
    expect(unknown.response.status).toBe(404);
    expect(await unknown.response.text()).toContain('No registered token of that kind');
    expect(wrongKind.response.status).toBe(404);
    expect(badKind.response.status).toBe(400);
    expect(badAppId.response.status).toBe(400);
    expect(queued).toEqual([]);
    expect([unknown, wrongKind, badKind, badAppId].every((sent) => sent.job === null)).toBe(true);
  });

  it('in production, accepts only a token of an allow-listed user id', async () => {
    const token = await registeredApnsToken();
    const form = { token: token.token, kind: 'apns', app_id: '' };

    const refused = await sendTest(form, adminEnv({ ENVIRONMENT: 'production' }));
    const allowed = await sendTest(
      form,
      adminEnv({
        ENVIRONMENT: 'production',
        PUSH_INJECT_ALLOWED_USER_IDS: ` ${crypto.randomUUID()}, ${token.userId.toUpperCase()} `,
      }),
    );

    expect(refused.response.status).toBe(403);
    expect(refused.job).toBeNull();
    expect(allowed.response.status).toBe(303);
    expect(allowed.job?.targets[0]?.environment).toBe('sandbox');
  });

  it('sends through the real queue consumer, PushAuth and transport, and shows the apns-id', async () => {
    // An old client's registration: no app id, so the row says the production app.
    const token = await registeredApnsToken();
    const before = Date.now();

    const { response, job } = await sendTest({
      token: token.token,
      kind: 'apns',
      app_id: 'app.planeahead.mobile.dev',
    });

    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    expect(location).toBe(`${ADMIN_PUSH_RESULT_PATH}?job=${job?.jobId ?? ''}`);
    expect(job).toMatchObject({
      kind: 'push_job',
      test: true,
      notificationKind: 'system',
      title: 'PlaneAhead test push',
      targets: [
        {
          pushTokenId: token.pushTokenId,
          subjectId: token.userId,
          kind: 'apns',
          token: token.token,
          environment: 'sandbox',
          appId: 'app.planeahead.mobile.dev',
          attempt: 0,
        },
      ],
    });
    expect(job?.flightKey).toBeUndefined();
    expect(job?.targets[0]?.notificationId).toBeUndefined();
    const ttl = Date.parse(job?.expiresAt ?? '') - before;
    expect(ttl).toBeGreaterThan(TEST_PUSH_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(TEST_PUSH_TTL_MS + 5_000);
    const [audit] = await db().execute<{
      actor_type: string;
      details: Record<string, unknown>;
    }>(sql`
      select actor_type, details from audit_log
      where action = 'push.test_sent' and target_id = ${token.pushTokenId}::uuid
    `);
    expect(audit).toMatchObject({
      actor_type: 'admin',
      details: {
        job_id: job?.jobId,
        kind: 'apns',
        app_id: 'app.planeahead.mobile.dev',
        operator_email: 'owner@planeahead.app',
      },
    });

    // Before the consumer reports: queued, and the page reloads itself.
    const pending = await admin({ path: location });
    expect(await pending.text()).toContain('is queued');
    expect(await admin({ path: location }).then((page) => page.text())).toContain(
      '<meta http-equiv="refresh" content="3">',
    );

    const apnsId = crypto.randomUUID();
    const network = await deliver(job, () => apnsAnswer(200, null, apnsId));

    const request = network.requests[0];
    expect(request?.url).toBe(`https://api.sandbox.push.apple.com/3/device/${token.token}`);
    expect(request?.headers['apns-topic']).toBe('app.planeahead.mobile.dev');
    expect(request?.headers['apns-collapse-id']).toBe(`system:${job?.jobId ?? ''}`);
    // The bearer token is the sandbox object's ES256 provider token, signed with the test key.
    const bearer = (request?.headers['authorization'] ?? '').replace(/^bearer /, '');
    const [header = '', claims = '', signature = ''] = bearer.split('.');
    const publicKey = await publicKeyOf(testEnv.APNS_KEY_P8 ?? '', 'ES256');
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        fromBase64Url(signature),
        new TextEncoder().encode(`${header}.${claims}`),
      ),
    ).toBe(true);

    const result = await admin({ path: location });
    const html = await result.text();
    expect(result.status).toBe(200);
    expect(html).toContain(
      `<td>${job?.jobId ?? ''}</td><td>apns</td><td>sent</td><td>${apnsId}</td>`,
    );
    expect(html).toContain('<td>1</td><td>sent</td>');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("shows the reason, and invalidates only when sent with the row's own app id", async () => {
    const token = await registeredApnsToken('app.planeahead.mobile.dev');
    const invalidated = async () => {
      const [row] = await db().execute<{ invalidated_at: string | null }>(sql`
        select invalidated_at::text as invalidated_at from push_tokens
        where id = ${token.pushTokenId}::uuid
      `);
      return row?.invalidated_at ?? null;
    };

    // A hand-typed app id APNs refuses: the answer is about another topic than the row's.
    const wrongTopic = await sendTest({
      token: token.token,
      kind: 'apns',
      app_id: 'app.other.topic',
    });
    await deliver(wrongTopic.job, () => apnsAnswer(400, { reason: 'DeviceTokenNotForTopic' }));
    const page = await (
      await admin({ path: wrongTopic.response.headers.get('location') ?? '' })
    ).text();

    expect(page).toContain('<td>invalid_token</td><td></td><td>DeviceTokenNotForTopic</td>');
    expect(await invalidated()).toBeNull();

    // The registered app id, and a dead token: invalidated like any send.
    const own = await sendTest({ token: token.token, kind: 'apns', app_id: '' });
    expect(own.job?.targets[0]?.appId).toBe('app.planeahead.mobile.dev');
    await deliver(own.job, () => apnsAnswer(400, { reason: 'BadDeviceToken' }));
    expect(await invalidated()).not.toBeNull();
  });

  it('holds the job as not_configured without the APNs secrets, and the page says so', async () => {
    const token = await registeredApnsToken();
    const bare = adminEnv({ APNS_KEY_P8: '', APNS_KEY_ID: '', APNS_TEAM_ID: '' });

    const form = await (await admin({ path: ADMIN_PUSH_TEST_PATH, env: bare })).text();
    const { job, response } = await sendTest(
      { token: token.token, kind: 'apns', app_id: '' },
      bare,
    );
    const network = await deliver(job, () => apnsAnswer(200), bare);
    const result = await (await admin({ path: response.headers.get('location') ?? '' })).text();

    expect(form).toContain('APNs is not configured here');
    expect(network.requests).toEqual([]);
    expect(result).toContain('<td>queued</td><td></td><td>not_configured</td>');
    expect(result).toContain('<td>0</td><td>not_configured</td><td>not_configured</td>');
    expect(result).toContain('http-equiv="refresh"');
  });

  it('refuses a result lookup that is not a job id', async () => {
    const response = await admin({
      path: `${ADMIN_PUSH_RESULT_PATH}?job=${encodeURIComponent('<b>')}`,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('<b>');
  });
});
