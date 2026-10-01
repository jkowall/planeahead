/**
 * Ruling F5, both halves.
 *
 *   1. Every secret the Worker reads (`WORKER_SECRET_NAMES` in src/env.ts) is listed in
 *      `.dev.vars.example` (so `wrangler secret put` has a checklist) and in `.dev.vars.test` (so
 *      the suite exercises the real code path with a dummy value). The example file's key names
 *      arrive through the `TEST_DEV_VARS_EXAMPLE_KEYS` binding test/globalSetup.ts injects; the
 *      test file's values are the bindings themselves.
 *   2. No secret value reaches a log line. Every flow of the increment is driven through the real
 *      Worker while the console is captured (the Worker runs in this isolate), including the
 *      failure paths that log the most, and every captured line is searched for every secret:
 *      the configured ones, and the per-request ones (the magic-link token, the Apple refresh
 *      token, the identity tokens, the authorization code, the session cookies). Increment 14's
 *      review ruling R5 adds the dead letter consumer's last attempt, whose line carries a
 *      message body: a `push` job's device tokens never reach it.
 */

import {
  createExecutionContext,
  createMessageBatch,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { withDb } from '@planeahead/db';
import { PushJobV1, type PushCredentialName } from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { normalisePem } from '../../src/auth/apple-client-secret';
import type { PushAuth } from '../../src/do/push-auth';
import {
  OPTIONAL_SECRET_NAMES,
  PUSH_SECRET_NAMES,
  TEST_SEAM_NAMES,
  WORKER_SECRET_NAMES,
} from '../../src/env';
import { createLogger } from '../../src/observability/log';
import { durableCredentialSource } from '../../src/push/credentials';
import { createApnsTransport, createFcmTransport } from '../../src/push/transport';
import { DEAD_LETTER_MAX_RETRIES, handleDeadLetterBatch } from '../../src/queues/dlq';
import { handlePersistBatch } from '../../src/queues/persist';
import { handlePushBatch } from '../../src/queues/push';
import wranglerConfig from '../../wrangler.jsonc?raw';
import {
  apnsAnswer,
  capturingQueue,
  everyTargetLive,
  fakeFetch,
  fcmError,
  jobInput,
  target,
} from '../unit/helpers/push';
import {
  API_ORIGIN,
  appleNativeSignIn,
  captureLogs,
  cookiesFrom,
  googleNativeSignIn,
  jsonRequest,
  logEvents,
  magicLinkTokenFor,
  registerDevice,
  signInAnonymously,
  testEnv,
  uniqueEmail,
  uniqueInstallId,
  uniqueIp,
  worker,
} from './helpers/auth';

/** A PEM's base64 body without its armour, on one line. */
function pemBody(pem: string): string {
  return normalisePem(pem)
    .split('\n')
    .filter((line) => !line.startsWith('-----'))
    .join('');
}

/** A value that would ride in a failed statement's bound parameters if anything let it. */
const BODY_MARKER = `BODYMARKER_${crypto.randomUUID().replaceAll('-', '')}`;

const exampleKeys = new Set((testEnv.TEST_DEV_VARS_EXAMPLE_KEYS ?? '').split(',').filter(Boolean));

describe('.dev.vars.example and .dev.vars.test', () => {
  it('list every secret the Worker reads', () => {
    expect(exampleKeys.size).toBeGreaterThan(0);
    for (const name of [...WORKER_SECRET_NAMES, ...PUSH_SECRET_NAMES]) {
      expect(exampleKeys, `${name} in .dev.vars.example`).toContain(name);
      // The value is a binding under test; `SENTRY_DSN` is deliberately empty.
      expect(typeof testEnv[name], `${name} in .dev.vars.test`).toBe('string');
    }
    for (const name of TEST_SEAM_NAMES) {
      expect(exampleKeys, `${name} documented as an optional seam`).toContain(name);
    }
    for (const name of OPTIONAL_SECRET_NAMES) {
      expect(exampleKeys, `${name} documented as an optional secret`).toContain(name);
    }
  });

  it('gives every secret used by a flow a non-empty dummy value', () => {
    for (const name of [...WORKER_SECRET_NAMES, ...PUSH_SECRET_NAMES]) {
      if (name === 'SENTRY_DSN') {
        continue;
      }
      expect(testEnv[name]?.length ?? 0, name).toBeGreaterThan(8);
    }
  });
});

/**
 * The `"secrets": { "required": [...] }` blocks of wrangler.jsonc, in order of appearance, read
 * without a JSONC parser: the blocks hold nothing but quoted names.
 */
function requiredSecretBlocks(text: string): string[][] {
  return [...text.matchAll(/"secrets"\s*:\s*\{\s*"required"\s*:\s*\[([^\]]*)\]/g)].map((match) =>
    [...(match[1] ?? '').matchAll(/"([A-Z0-9_]+)"/g)].map((name) => name[1] ?? ''),
  );
}

describe('wrangler.jsonc secrets.required (ruling O11; increment 14, ruling P7)', () => {
  it('declares every secret the Worker reads in staging and in production, and nothing else', () => {
    const blocks = requiredSecretBlocks(wranglerConfig);
    // Staging and production only: the top level is the local and test environment, which reads
    // .dev.vars and .dev.vars.test and must not warn about a missing production secret.
    expect(blocks).toHaveLength(2);
    const staging = wranglerConfig.indexOf('"staging"');
    const production = wranglerConfig.indexOf('"production"');
    const positions = [...wranglerConfig.matchAll(/"secrets"\s*:/g)].map((match) => match.index);
    expect(positions[0]).toBeGreaterThan(staging);
    expect(positions[0]).toBeLessThan(production);
    expect(positions[1]).toBeGreaterThan(production);
    // Each block replaces .dev.vars inference, so it must be complete, in the same order. The
    // push credentials are required in production only: staging deploys before the Apple
    // account exists, and its consumer holds push jobs as not_configured meanwhile.
    expect(blocks[0]).toEqual([...WORKER_SECRET_NAMES]);
    expect(blocks[1]).toEqual([...WORKER_SECRET_NAMES, ...PUSH_SECRET_NAMES]);
  });
});

/**
 * The push transport's flows (increment 14): the three `PushAuth` objects mint for real (the APNs
 * provider token from APNS_KEY_P8, the FCM access token through the object's fetch seam), and the
 * push and persist consumers run a success and every failure path that logs, a refused provider
 * token and a refused access token included. Returns the per-flow secrets for the search.
 */
async function pushFlows(): Promise<string[]> {
  const secrets: string[] = [];
  const oauth = fakeFetch((request) => {
    secrets.push(new URLSearchParams(request.body).get('assertion') ?? '');
    const accessToken = `ya29.${crypto.randomUUID().replaceAll('-', '')}`;
    secrets.push(accessToken);
    return Response.json({ access_token: accessToken, expires_in: 3600 });
  });
  for (const name of ['apns:sandbox', 'apns:production', 'fcm'] as PushCredentialName[]) {
    await runInDurableObject(
      testEnv.PUSH_AUTH.getByName(name, { locationHint: 'enam' }),
      (instance: PushAuth, state) => {
        state.storage.sql.exec('DELETE FROM credential');
        state.storage.sql.exec('DELETE FROM mint_failure');
        instance.fetchImpl = oauth.fetch;
        instance._setClock(null);
      },
    );
  }
  const network = fakeFetch((request) => {
    secrets.push((request.headers['authorization'] ?? '').replace(/^bearer /i, ''));
    const failing = request.body.includes('"title":"Refused"');
    if (request.url.includes('push.apple.com')) {
      return failing
        ? apnsAnswer(403, { reason: 'ExpiredProviderToken' })
        : apnsAnswer(410, { reason: 'Unregistered', timestamp: Date.now() });
    }
    return failing
      ? fcmError(401, 'UNAUTHENTICATED')
      : Response.json({ name: 'projects/x/messages/1' });
  });
  const credentials = durableCredentialSource(testEnv, { cache: new Map() });
  const deviceTokens = [
    [...crypto.getRandomValues(new Uint8Array(32))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(''),
    `fcm-secret-${crypto.randomUUID()}`,
  ];
  secrets.push(...deviceTokens);
  const jobs = ['Delivered', 'Refused'].map((title) =>
    PushJobV1.parse(
      jobInput({
        title,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        targets: [
          target({ token: deviceTokens[0] ?? '' }),
          target({ kind: 'fcm', token: deviceTokens[1] ?? '', environment: 'production' }),
        ],
      }),
    ),
  );
  const persist = capturingQueue();
  const log = createLogger({});
  await handlePushBatch(
    createMessageBatch(
      'planeahead-push-local',
      jobs.map((body, index) => ({
        id: `logs-${String(index)}`,
        timestamp: new Date(),
        attempts: 1,
        body,
      })),
    ),
    { env: testEnv, ctx: createExecutionContext(), log },
    {
      transports: {
        apns: createApnsTransport({ fetch: network.fetch, credentials }),
        fcm: createFcmTransport({
          fetch: network.fetch,
          credentials,
          projectId: 'planeahead-test',
        }),
      },
      pushQueue: capturingQueue().queue,
      persistQueue: persist.queue,
      // The targets have no `push_tokens` rows; the liveness read (ruling R1) finds them live.
      liveTokens: everyTargetLive(jobs),
    },
  );
  await handlePersistBatch(
    createMessageBatch(
      'planeahead-persist-local',
      persist.sent.map(({ body }, index) => ({
        id: `logs-outcome-${String(index)}`,
        timestamp: new Date(),
        attempts: 1,
        body,
      })),
    ),
    { env: testEnv, ctx: createExecutionContext(), log },
  );
  expect(network.requests.length).toBe(4);
  expect(oauth.requests.length).toBeGreaterThan(0);
  return secrets.filter((secret) => secret !== '');
}

describe('no secret value reaches a log line', () => {
  it('across every flow, including the failure paths', async () => {
    const dynamicSecrets: string[] = [];
    const { lines } = await captureLogs(async () => {
      // Anonymous, then the account routes.
      const anonymous = await signInAnonymously();
      dynamicSecrets.push(anonymous.cookie);
      await registerDevice(anonymous, uniqueInstallId('logs'), {
        pushTokenKind: 'apns',
        pushToken: `apns-secret-${crypto.randomUUID()}`,
      });
      await worker(
        jsonRequest('/v1/me', 'GET', undefined, { ip: anonymous.ip, cookie: anonymous.cookie }),
      );

      // Magic link: request, cap overflow, verify with the anonymous cookie (merge path).
      const email = uniqueEmail('logs');
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await worker(
          jsonRequest(
            '/api/auth/sign-in/magic-link',
            'POST',
            { email },
            { ip: uniqueIp(), origin: null },
          ),
        );
      }
      const token = await magicLinkTokenFor(email);
      dynamicSecrets.push(token);
      const verified = await worker(
        jsonRequest(
          `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
          'GET',
          undefined,
          {
            ip: anonymous.ip,
            cookie: anonymous.cookie,
            origin: null,
          },
        ),
      );
      const verifiedCookie = cookiesFrom(verified);
      if (verifiedCookie !== null) {
        dynamicSecrets.push(verifiedCookie);
      }
      // A replay of a consumed token: the error path.
      await worker(
        jsonRequest(
          `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
          'GET',
          undefined,
          {
            ip: uniqueIp(),
            origin: null,
          },
        ),
      );

      // Apple: success, a rejected code, a nonce mismatch, a missing email.
      const apple = await appleNativeSignIn({ cookie: (await signInAnonymously()).cookie });
      dynamicSecrets.push(
        apple.identityToken,
        apple.authorizationCode,
        `rt_${apple.authorizationCode}_`,
      );
      const appleCookie = cookiesFrom(apple.response);
      if (appleCookie !== null) {
        dynamicSecrets.push(appleCookie);
      }
      const badCode = await appleNativeSignIn({ authorizationCode: 'invalid-code' });
      dynamicSecrets.push(badCode.identityToken);
      const badNonce = await appleNativeSignIn({ nonceClaim: 'wrong' });
      dynamicSecrets.push(badNonce.identityToken, badNonce.rawNonce);
      await appleNativeSignIn({ email: null });

      // Google: success with the merge path, and the two rejections.
      const google = await googleNativeSignIn({ cookie: (await signInAnonymously()).cookie });
      dynamicSecrets.push(google.identityToken, google.rawNonce);
      await googleNativeSignIn({ nonceClaim: null });
      await googleNativeSignIn({ audience: 'nobody' });

      // A rate-limited request and a forged cookie.
      const ip = uniqueIp();
      for (let attempt = 0; attempt < 7; attempt += 1) {
        await worker(jsonRequest('/api/auth/sign-in/anonymous', 'POST', {}, { ip, origin: null }));
      }
      await worker(
        jsonRequest('/v1/me', 'GET', undefined, { cookie: 'better-auth.session_token=forged.sig' }),
      );

      // U+0000 in every text input: refused at the boundary with 400, never a database error
      // whose bound parameters would carry the rest of the body into a log line.
      dynamicSecrets.push(BODY_MARKER);
      const nulDevice = await registerDevice(anonymous, uniqueInstallId('nul-logs'), {
        model: `${BODY_MARKER}\u0000X`,
      });
      expect(nulDevice.status).toBe(400);
      const nulLink = await worker(
        jsonRequest(
          '/api/auth/sign-in/magic-link',
          'POST',
          { email: uniqueEmail('nul-logs'), name: `${BODY_MARKER}\u0000` },
          { ip: uniqueIp(), origin: null },
        ),
      );
      expect(nulLink.status).toBe(400);
      const nulPreferences = await worker(
        jsonRequest(
          '/v1/me/preferences',
          'PATCH',
          { settings: { note: `${BODY_MARKER}\u0000` } },
          { ip: anonymous.ip, cookie: anonymous.cookie },
        ),
      );
      expect(nulPreferences.status).toBe(400);
      const nulUpdateUser = await worker(
        jsonRequest(
          '/api/auth/update-user',
          'POST',
          { name: `${BODY_MARKER}\u0000` },
          { ip: anonymous.ip, cookie: anonymous.cookie },
        ),
      );
      expect(nulUpdateUser.status).toBe(400);

      // Increment 14: the push transport, every path that logs.
      dynamicSecrets.push(...(await pushFlows()));
    });

    // The suite produced log lines (otherwise this test proves nothing), the push flows' among
    // them: the consumer's, the persist consumer's and the PushAuth objects' own.
    expect(lines.length).toBeGreaterThan(10);
    expect(logEvents(lines, 'push_job_done')).toHaveLength(2);
    expect(logEvents(lines, 'push_outcome_recorded')).toHaveLength(2);
    expect(logEvents(lines, 'push_auth_minted').length).toBeGreaterThanOrEqual(2);
    expect(logEvents(lines, 'push_auth_token_expired').length).toBeGreaterThanOrEqual(2);

    const configured: [string, string][] = [];
    for (const name of [...WORKER_SECRET_NAMES, ...PUSH_SECRET_NAMES]) {
      const value = testEnv[name];
      if (typeof value === 'string' && value !== '') {
        configured.push([name, value]);
        if (name === 'FCM_SERVICE_ACCOUNT_JSON') {
          // The service account's private key, as JSON carries it and as the key's body.
          const key = (JSON.parse(value) as { private_key: string }).private_key;
          configured.push([`${name} (private_key body)`, pemBody(key)]);
        }
        if (name === 'APPLE_SIWA_P8' || name === 'APNS_KEY_P8') {
          // The key body without the PEM armour, in both newline encodings.
          const body = normalisePem(value)
            .split('\n')
            .filter((line) => !line.startsWith('-----'))
            .join('');
          configured.push([`${name} (body)`, body]);
          configured.push([`${name} (escaped)`, normalisePem(value).replaceAll('\n', '\\n')]);
        }
      }
    }
    const joined = lines.join('\n');
    for (const [name, value] of configured) {
      expect(joined.includes(value), `${name} appears in a log line`).toBe(false);
    }
    for (const secret of dynamicSecrets) {
      // Cookie header values are `name=value; name=value`; check each value.
      const values =
        secret.includes('=') && secret.includes('session_token')
          ? secret.split(';').map((pair) => pair.split('=').slice(1).join('=').trim())
          : [secret];
      for (const value of values) {
        if (value.length < 8) {
          continue;
        }
        expect(
          joined.includes(value),
          `a per-request secret starting ${value.slice(0, 6)} appears in a log line`,
        ).toBe(false);
        expect(
          joined.includes(encodeURIComponent(value)),
          `a per-request secret (url-encoded) appears in a log line`,
        ).toBe(false);
      }
    }
    // The raw email address never appears either (the cap hashes it, the sender logs a domain).
    expect(joined.includes('@example.test')).toBe(false);
  });

  it('logs a dead-lettered push job whose archive failed for good without its device tokens (ruling R5)', async () => {
    const sentinel = `DEVICETOKENSENTINEL${crypto.randomUUID().replaceAll('-', '')}`;
    const apnsSentinel = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const job = PushJobV1.parse(
      jobInput({
        targets: [
          target({ token: apnsSentinel }),
          target({ kind: 'fcm', token: sentinel, environment: 'production' }),
        ],
      }),
    );
    const id = `dlq-push-${crypto.randomUUID()}`;
    const ctx = createExecutionContext();

    const { lines } = await captureLogs(() =>
      handleDeadLetterBatch(
        createMessageBatch('planeahead-push-dlq-local', [
          // The last attempt `max_retries: 2` allows: acknowledged with the body on the line.
          { id, timestamp: new Date(), attempts: DEAD_LETTER_MAX_RETRIES + 1, body: job },
        ]),
        'push',
        { env: testEnv, ctx, log: createLogger({}) },
        {
          bucket: { put: () => Promise.reject(new Error('R2 unavailable')) } as unknown as Pick<
            R2Bucket,
            'put'
          >,
          capture: () => undefined,
        },
      ),
    );
    const [failed] = logEvents(lines, 'queue_dead_letter_archive_failed');
    const joined = lines.join('\n');

    expect(failed?.['level']).toBe('error');
    // Still the message's trace: the job and its targets, each token only as its length.
    expect(failed?.['body']).toMatchObject({
      jobId: job.jobId,
      targets: [
        { pushTokenId: job.targets[0]?.pushTokenId, tokenLength: 64 },
        { pushTokenId: job.targets[1]?.pushTokenId, tokenLength: sentinel.length },
      ],
    });
    expect(joined).not.toContain(sentinel);
    expect(joined).not.toContain(apnsSentinel);
  });

  it('logs a failed statement without its bound parameters, through the real error handler', async () => {
    // drizzle-orm's DrizzleQueryError message is `Failed query: <sql>\nparams: <values>`, and
    // the values of a failed INSERT are the request. A route on the real chain runs a statement
    // Postgres refuses (a NUL inside a bound value) so the error reaches `handleError` exactly
    // as an unhandled route error would.
    const app = createApp();
    app.get('/boom', async (c) => {
      await withDb(c.env, (db) =>
        db.execute(sql`select ${`${BODY_MARKER}\u0000tail`}::text as value`),
      );
      return c.json({ ok: true });
    });
    const ctx = createExecutionContext();

    const { result: response, lines } = await captureLogs(async () => {
      const answered = await app.fetch(
        new Request(`${API_ORIGIN}/boom`, { headers: { 'cf-connecting-ip': uniqueIp() } }),
        testEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return answered;
    });
    const unhandled = logEvents(lines, 'unhandled_error');
    const joined = lines.join('\n');

    expect(response.status).toBe(500);
    expect(unhandled).toHaveLength(1);
    expect(String(unhandled[0]?.['error_message'])).toContain('Failed query');
    expect(unhandled[0]?.['cause_code']).toBe('22021');
    expect(joined).not.toContain(BODY_MARKER);
    expect(joined).not.toContain('params:');
    expect(joined).not.toContain('Failing row');
  });
});
