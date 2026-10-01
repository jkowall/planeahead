/**
 * The transport soak (increment 16, ruling C9) in the Workers pool. Its admin page behind
 * Cloudflare Access (start and stop, each audited before the KV record changes, and the
 * refusals); its schedule (a tick inside the soak plans an injection that the real injector path
 * writes into the real FlightTracker and the pipeline turns into a push job; a tick outside plans
 * nothing; every twelfth tick adds the canary, whose two test pushes go through the real push
 * consumer and the real `PushAuth`, both asking it in the same instant past a warm isolate
 * cache); the staging-only guard (production refuses the start, its tick and its steps do
 * nothing, and wrangler.jsonc gives it no soak cron); and the counts by reason the page draws from
 * the delivery attempt logs, with the injector's 409s for an open suspicion counted.
 */

import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { and, eq, sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, devices, notificationDeliveries, pushTokens, users } from '@planeahead/db';
import {
  RPC_SCHEMA_VERSION,
  uuidv7,
  type FlightKey,
  type PushCredentialName,
  type PushOutcomeMessageV1,
} from '@planeahead/shared';
import { createApp } from '../../src/app';
import {
  CRON_HANDLERS,
  DAILY_CRON,
  PUSH_SOAK_CRON,
  RECONCILE_CRON,
  runCron,
} from '../../src/cron/index';
import type { Env } from '../../src/env';
import { ACCESS_JWT_HEADER, accessCertsUrl } from '../../src/middleware/access';
import { createLogger, type LogLine } from '../../src/observability/log';
import {
  durableCredentialSource,
  defaultPushAuthStub,
  type PushAuthStub,
} from '../../src/push/credentials';
import {
  PUSH_SOAK_KV_KEY,
  gateTogether,
  planPushSoak,
  pushSoakPosition,
  readPushSoak,
  writePushSoak,
  type PushSoakCanaryDeps,
  type PushSoakDeps,
  type PushSoakMessageV1,
  type PushSoakRecord,
} from '../../src/push/soak';
import { handleHousekeepingBatch } from '../../src/queues/housekeeping';
import { createAdminRoutes, type AdminRoutesOptions } from '../../src/routes/admin';
import type { InjectorTracker } from '../../src/routes/admin-inject';
import { ADMIN_SOAK_PATH, attemptsHtml, ticksDue } from '../../src/routes/admin-soak';
import wranglerConfig from '../../wrangler.jsonc?raw';
import { apnsAnswer, capturingQueue, fakeFetch } from '../unit/helpers/push';
import { API_ORIGIN, testEnv, uniqueEmail, uniqueInstallId } from './helpers/auth';
import {
  HOUR_MS,
  MINUTE_MS,
  adbOk,
  drainTouched,
  openBudgetFor,
  resolverHarness,
  scriptAdb,
  trackerHarness,
  uniqueFlight,
  type TestFlight,
  type TrackerHarness,
} from './helpers/flights';
import { persist, pipeline, plantFollower } from './helpers/pipeline';
import { db } from './helpers/routes';

afterEach(drainTouched);
// One soak record per environment: every test starts with none.
beforeEach(async () => {
  await testEnv.CONFIG.delete(PUSH_SOAK_KV_KEY);
});

const TEAM = 'planeahead-soak.cloudflareaccess.com';
const AUD = 'soak0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
const OPERATOR = 'owner@planeahead.app';
const keyPair = generateKeyPair('RS256', { extractable: true });

/** A valid Access assertion for the operator, and the certs endpoint that verifies it. */
async function accessToken(): Promise<{ token: string; fetch: typeof fetch }> {
  const { privateKey, publicKey } = await keyPair;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'soak-k1', alg: 'RS256', use: 'sig' };
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ email: OPERATOR, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: 'soak-k1' })
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

const PRODUCTION = adminEnv({ ENVIRONMENT: 'production' });

interface AdminCall {
  readonly path?: string;
  readonly form?: Record<string, string>;
  /** The `Origin` header; the API's own by default on a POST. */
  readonly origin?: string | null;
  readonly env?: Env;
  readonly options?: AdminRoutesOptions;
}

/** Calls `/admin` behind a valid Access assertion, as the operator's browser would. */
async function admin(call: AdminCall = {}): Promise<Response> {
  const access = await accessToken();
  const app = createApp();
  app.route(
    '/admin',
    createAdminRoutes({
      access: { fetch: access.fetch, cache: new Map() },
      fetch: access.fetch,
      ...call.options,
    }),
  );
  const post = call.form !== undefined;
  const headers: Record<string, string> = { [ACCESS_JWT_HEADER]: access.token };
  const origin = call.origin === undefined ? (post ? API_ORIGIN : null) : call.origin;
  if (origin !== null) {
    headers['origin'] = origin;
  }
  if (post) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }
  const ctx = createExecutionContext();
  const response = await app.fetch(
    new Request(`${API_ORIGIN}${call.path ?? ADMIN_SOAK_PATH}`, {
      method: post ? 'POST' : 'GET',
      headers,
      ...(post ? { body: new URLSearchParams(call.form).toString() } : {}),
    }),
    call.env ?? adminEnv(),
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}

/** A tracker created through the resolver at `clock`, Postgres holding the flight. */
async function trackedFlight(flight: TestFlight, clock: number): Promise<TrackerHarness> {
  await scriptAdb(flight, [adbOk(flight, { phase: 'expected', originGate: 'B10' })]);
  const tracker = await trackerHarness(flight.flightKey, clock);
  await openBudgetFor(flight, clock);
  const resolver = await resolverHarness(flight, clock);
  const resolved = await resolver.stub.resolve({
    rpcVersion: RPC_SCHEMA_VERSION,
    designator: flight.designator,
    dateLocal: flight.dateLocal,
  });
  expect(resolved.outcome).toBe('resolved');
  expect((await pipeline(tracker)).jobs).toEqual([]);
  await persist(resolver.outbox.sent.splice(0));
  return tracker;
}

interface CanaryToken {
  readonly userId: string;
  readonly pushTokenId: string;
  readonly token: string;
}

/** A registered sandbox APNs token (a development build's), the canary's target. */
async function canaryToken(): Promise<CanaryToken> {
  const userId = uuidv7();
  await db()
    .insert(users)
    .values({ id: userId, name: '', email: uniqueEmail('soak') });
  const deviceId = uuidv7();
  await db()
    .insert(devices)
    .values({ id: deviceId, userId, installId: uniqueInstallId('soak'), platform: 'ios' });
  const pushTokenId = uuidv7();
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  await db().insert(pushTokens).values({
    id: pushTokenId,
    userId,
    deviceId,
    kind: 'apns',
    token,
    environment: 'sandbox',
    appId: 'app.planeahead.mobile.dev',
  });
  return { userId, pushTokenId, token };
}

/** A running soak's record, written straight to KV (the route is tested on its own). */
async function soakRecord(
  overrides: Partial<PushSoakRecord> & Pick<PushSoakRecord, 'flightKey'>,
): Promise<PushSoakRecord> {
  const startedAt = overrides.startedAt ?? new Date(Date.now() - MINUTE_MS).toISOString();
  const record: PushSoakRecord = {
    v: 1,
    id: uuidv7(),
    hours: 24,
    startedAt,
    endsAt: new Date(Date.parse(startedAt) + 24 * HOUR_MS).toISOString(),
    stoppedAt: null,
    startedBy: { email: OPERATOR, subject: 'access-owner' },
    stoppedBy: null,
    canary: { pushTokenId: uuidv7(), kind: 'apns' },
    ...overrides,
  };
  await writePushSoak(testEnv.CONFIG, record);
  return record;
}

function capture(): { lines: LogLine[]; log: ReturnType<typeof createLogger> } {
  const lines: LogLine[] = [];
  return { lines, log: createLogger({}, (line) => lines.push(line)) };
}

/** One tick of the soak's cron at `at`, its steps captured instead of queued. */
async function tick(
  at: number,
  environment: Env = testEnv,
): Promise<{ steps: PushSoakMessageV1[]; events: string[] }> {
  const sink = capturingQueue();
  const { lines, log } = capture();
  await planPushSoak(
    { env: environment, ctx: createExecutionContext(), log, scheduledTime: at },
    { sink: sink.queue },
  );
  return {
    steps: sink.sent.map((entry) => entry.body as PushSoakMessageV1),
    events: lines.map((line) => line.event),
  };
}

/** One step through the housekeeping queue's consumer, as the queue delivers it. */
async function runStep(
  body: unknown,
  deps: PushSoakDeps = {},
  environment: Env = testEnv,
): Promise<{ acked: string[]; retried: string[]; events: string[] }> {
  const { lines, log } = capture();
  const batch = createMessageBatch('planeahead-housekeeping-local', [
    { id: `soak-${crypto.randomUUID()}`, timestamp: new Date(), attempts: 1, body },
  ]);
  const ctx = createExecutionContext();
  await handleHousekeepingBatch(
    batch,
    { env: environment, ctx, log },
    { db: db(), pushSoak: deps },
  );
  const result = await getQueueResult(batch, ctx);
  return {
    acked: result.explicitAcks,
    retried: result.retryMessages.map((retry) => retry.msgId),
    events: lines.map((line) => line.event),
  };
}

/** The audit rows of one action naming one soak, oldest first. */
async function auditFor(action: string, soakId: string) {
  return db()
    .select({
      details: auditLog.details,
      actorType: auditLog.actorType,
      targetId: auditLog.targetId,
      subjectId: auditLog.subjectId,
    })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), sql`${auditLog.details}->>'soak_id' = ${soakId}`))
    .orderBy(auditLog.createdAt);
}

/** The real tracker's state, and an injection call that answers `answer` and records its input. */
function answeringTracker(
  tracker: TrackerHarness,
  answer: Record<string, unknown>,
): { injectorFor: () => () => InjectorTracker; injections: unknown[] } {
  const injections: unknown[] = [];
  return {
    injections,
    injectorFor: () => () => ({
      getState: () => tracker.stub.getState(),
      injectPolicyEvent: (input: unknown) => {
        injections.push(input);
        return Promise.resolve({ rpcVersion: RPC_SCHEMA_VERSION, ...answer });
      },
    }),
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** The soak-start audit rows naming a flight (a start that failed has no record to name). */
async function startRowsFor(flightKey: FlightKey) {
  return db()
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'push.soak_started'),
        sql`${auditLog.details}->>'flight_key' = ${flightKey}`,
      ),
    );
}

describe('starting and stopping a soak (C9)', () => {
  it('serves its page behind Access with the start form, linked from /admin', async () => {
    const page = await admin();
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("form-action 'self'");
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const html = await page.text();
    expect(html).toContain('No soak has run here yet.');
    expect(html).toContain('<input type="hidden" name="action" value="start">');
    expect(html).not.toMatch(/<script/i);
    const operations = await (await admin({ path: '/admin' })).text();
    expect(operations).toContain('Transport soak (staging)');
    expect(operations).toContain(`href="${ADMIN_SOAK_PATH}"`);
  });

  it('starts a soak and stops it, each audited before the record changes', async () => {
    const flight = uniqueFlight();
    await trackedFlight(flight, flight.scheduledOut.getTime() - 30 * HOUR_MS);
    const canary = await canaryToken();
    const now = Date.now();
    const at = (minutes: number) => ({ now: () => now + minutes * MINUTE_MS });
    const form = {
      action: 'start',
      flight_key: flight.flightKey,
      hours: '36',
      token: canary.token,
      kind: 'apns',
    };
    const started = await admin({ form, options: at(0) });
    expect(started.status).toBe(303);
    expect(started.headers.get('location')).toBe(ADMIN_SOAK_PATH);
    const record = await readPushSoak(testEnv.CONFIG);
    expect(record).toMatchObject({
      flightKey: flight.flightKey,
      hours: 36,
      startedAt: iso(now),
      endsAt: iso(now + 36 * HOUR_MS),
      stoppedAt: null,
      startedBy: { email: OPERATOR, subject: 'access-owner' },
      canary: { pushTokenId: canary.pushTokenId, kind: 'apns' },
    });
    const id = record?.id ?? '';
    // The record names the token's row, never the device token.
    expect(JSON.stringify(record)).not.toContain(canary.token);
    expect(await auditFor('push.soak_started', id)).toMatchObject([
      {
        actorType: 'admin',
        targetId: id,
        subjectId: canary.userId,
        details: {
          outcome: 'written',
          flight_key: flight.flightKey,
          hours: 36,
          canary_push_token_id: canary.pushTokenId,
          operator_email: OPERATOR,
          operator_subject: 'access-owner',
        },
      },
    ]);

    // Running: shown with the stop form; a second start and a stale stop change nothing.
    const running = await (await admin({ options: at(1) })).text();
    expect(running).toContain('<td>running</td>');
    expect(running).toContain('<input type="hidden" name="action" value="stop">');
    expect((await admin({ form, options: at(1) })).status).toBe(409);
    const stale = await admin({ form: { action: 'stop', soak_id: uuidv7() }, options: at(1) });
    expect(stale.status).toBe(409);
    expect(await readPushSoak(testEnv.CONFIG)).toEqual(record);

    const stopped = await admin({ form: { action: 'stop', soak_id: id }, options: at(2) });
    expect(stopped.status).toBe(303);
    expect(await readPushSoak(testEnv.CONFIG)).toEqual({
      ...record,
      stoppedAt: iso(now + 2 * MINUTE_MS),
      stoppedBy: { email: OPERATOR, subject: 'access-owner' },
    });
    expect(await auditFor('push.soak_stopped', id)).toMatchObject([
      {
        actorType: 'admin',
        targetId: id,
        details: { outcome: 'written', operator_email: OPERATOR },
      },
    ]);
    const after = await (await admin({ options: at(3) })).text();
    expect(after).toContain('<td>stopped</td>');
    expect(after).toContain('<input type="hidden" name="action" value="start">');
    expect((await admin({ form: { action: 'stop', soak_id: id }, options: at(3) })).status).toBe(
      409,
    );
  });

  it('writes the audit row pending before the record, and settles it as error when KV fails', async () => {
    const flight = uniqueFlight();
    await trackedFlight(flight, flight.scheduledOut.getTime() - 30 * HOUR_MS);
    const canary = await canaryToken();
    const seen: unknown[] = [];
    const failingKv = {
      get: (key: string) => testEnv.CONFIG.get(key),
      put: async () => {
        seen.push(...(await startRowsFor(flight.flightKey)).map((row) => row.details));
        throw new Error('KV unavailable');
      },
    } as unknown as Pick<KVNamespace, 'get' | 'put'>;
    const form = {
      action: 'start',
      flight_key: flight.flightKey,
      hours: '24',
      token: canary.token,
      kind: 'apns',
    };
    const refused = await admin({ form, options: { soakKv: () => failingKv } });
    expect(refused.status).toBe(503);
    expect(await refused.text()).toContain('no soak started');
    expect(seen).toMatchObject([{ outcome: 'pending', flight_key: flight.flightKey }]);
    expect((await startRowsFor(flight.flightKey)).map((row) => row.details)).toMatchObject([
      { outcome: 'error', error_name: 'Error' },
    ]);
    expect(await readPushSoak(testEnv.CONFIG)).toBeNull();
  });

  it('refuses another origin, a malformed form, an unknown or invalidated token and an untracked flight', async () => {
    const flight = uniqueFlight();
    await trackedFlight(flight, flight.scheduledOut.getTime() - 30 * HOUR_MS);
    const canary = await canaryToken();
    const base = {
      action: 'start',
      flight_key: flight.flightKey,
      hours: '24',
      token: canary.token,
      kind: 'apns',
    };
    for (const origin of ['https://evil.example', null]) {
      expect((await admin({ form: base, origin })).status).toBe(403);
    }
    // A throw across the pool's RPC boundary is reported as an unhandled rejection of the run
    // (flight-tracker.outbox.test.ts), so the untracked flight's tracker is a fake.
    const absentTracker = () => () => ({
      getState: () => {
        const error = new Error('invalid_request: tracker is not seeded');
        error.name = 'RpcRequestError';
        return Promise.reject(error);
      },
      injectPolicyEvent: () => Promise.resolve({}),
    });
    const cases: [Record<string, string>, number, string, AdminRoutesOptions?][] = [
      [{ ...base, action: 'pause' }, 400, 'Choose start or stop.'],
      [{ ...base, flight_key: 'AA100' }, 400, 'That is not a flight key'],
      [{ ...base, hours: '0' }, 400, 'whole hours'],
      [{ ...base, hours: '73' }, 400, 'whole hours'],
      [{ ...base, hours: '1.5' }, 400, 'whole hours'],
      [{ ...base, kind: 'webpush' }, 400, 'Choose APNs or FCM.'],
      [{ ...base, token: 'short' }, 400, 'That is not a device token.'],
      [{ ...base, token: 'f'.repeat(64) }, 404, 'No registered token of that kind.'],
      [{ ...base, kind: 'fcm' }, 404, 'No registered token of that kind.'],
      [
        { ...base, flight_key: uniqueFlight().flightKey },
        404,
        'No tracker holds that flight',
        { injectorFor: absentTracker },
      ],
    ];
    for (const [form, status, message, options] of cases) {
      const refused = await admin({ form, ...(options === undefined ? {} : { options }) });
      expect(refused.status).toBe(status);
      expect(await refused.text()).toContain(message);
    }
    await db()
      .update(pushTokens)
      .set({ invalidatedAt: sql`now()` })
      .where(eq(pushTokens.id, canary.pushTokenId));
    const invalidated = await admin({ form: base });
    expect(invalidated.status).toBe(409);
    expect(await invalidated.text()).toContain('That token was invalidated at');
    expect(await readPushSoak(testEnv.CONFIG)).toBeNull();
    expect(await startRowsFor(flight.flightKey)).toEqual([]);
  });
});

describe('the schedule (C9)', () => {
  it('a tick inside the soak injects a departure delay into the test flight, end to end', async () => {
    const flight = uniqueFlight();
    const tracker = await trackedFlight(flight, flight.scheduledOut.getTime() - 30 * HOUR_MS);
    const live = (await plantFollower(flight.flightKey, { liveTracked: true })).userId;
    const start = Date.now() - 2 * MINUTE_MS;
    const record = await soakRecord({ flightKey: flight.flightKey, startedAt: iso(start) });

    // The first tick plans the injection and, an hour's first, the canary; nothing runs inline.
    const first = await tick(start + 3 * MINUTE_MS);
    expect(first.events).toEqual(['cron_push_soak_planned']);
    expect(first.steps.map((step) => step.step)).toEqual(['inject', 'canary']);
    const inject = first.steps[0];
    expect(inject).toMatchObject({ kind: 'push_soak', soakId: record.id, slot: 0 });
    expect(tracker.outbox.sent).toEqual([]);

    // Through the housekeeping consumer, the injector path writes into the real tracker, and
    // persist and notify make one test push job for the live-tracked follower.
    const ran = await runStep(inject);
    expect(ran).toMatchObject({
      retried: [],
      events: ['push_soak_injected', 'housekeeping_batch_done'],
    });
    expect(ran.acked).toHaveLength(1);
    const run = await pipeline(tracker);
    expect(run.jobs).toHaveLength(1);
    expect(run.jobs[0]).toMatchObject({
      test: true,
      notificationKind: 'delay',
      channelId: 'flight_delays',
    });
    expect(run.jobs[0]?.targets.map((target) => target.subjectId)).toEqual([live]);
    const injectionId = inject?.step === 'inject' ? inject.injectionId : '';
    expect(await auditFor('notify.injected', record.id)).toMatchObject([
      {
        actorType: 'system',
        details: {
          outcome: 'written',
          intents: 1,
          written: 1,
          injection_id: injectionId,
          event: { kind: 'departure_delay', minutes: 30 },
          soak_slot: 0,
          operator_email: OPERATOR,
        },
      },
    ]);

    // A redelivered step replays the tick's injection id: the tracker writes nothing more.
    await runStep(inject);
    expect((await pipeline(tracker)).jobs).toEqual([]);

    // The next tick: no canary, the next delay in turn, another push.
    const second = await tick(start + 8 * MINUTE_MS);
    expect(second.steps).toMatchObject([{ step: 'inject', slot: 1 }]);
    await runStep(second.steps[0]);
    expect((await pipeline(tracker)).jobs).toHaveLength(1);
    expect((await auditFor('notify.injected', record.id)).at(-1)).toMatchObject({
      details: { outcome: 'written', written: 1, soak_slot: 1, event: { minutes: 60 } },
    });
  });

  it('a tick outside the soak plans nothing, and a step of a stopped or replaced soak does nothing', async () => {
    expect(await tick(Date.now())).toEqual({ steps: [], events: ['cron_push_soak_idle'] });
    const flight = uniqueFlight();
    const start = Date.now();
    const record = await soakRecord({
      flightKey: flight.flightKey,
      startedAt: iso(start),
      hours: 1,
      endsAt: iso(start + HOUR_MS),
    });
    for (const at of [start - MINUTE_MS, start + HOUR_MS, start + 5 * HOUR_MS]) {
      expect(await tick(at)).toEqual({ steps: [], events: ['cron_push_soak_idle'] });
    }
    const inside = await tick(start + 10 * MINUTE_MS);
    expect(inside.steps).toMatchObject([{ step: 'inject', slot: 2 }]);

    const calls: string[] = [];
    const untouched: PushSoakDeps = {
      injectorFor: () => () => ({
        getState: () => {
          calls.push('getState');
          return Promise.reject(new Error('not expected'));
        },
        injectPolicyEvent: () => Promise.reject(new Error('not expected')),
      }),
    };
    const stopper = { email: OPERATOR, subject: 'access-owner' };
    await writePushSoak(testEnv.CONFIG, {
      ...record,
      stoppedAt: iso(start + 12 * MINUTE_MS),
      stoppedBy: stopper,
    });
    expect((await tick(start + 15 * MINUTE_MS)).steps).toEqual([]);
    const stopped = await runStep(inside.steps[0], untouched);
    expect(stopped.events).toContain('push_soak_skipped');
    expect(stopped.acked).toHaveLength(1);
    await soakRecord({ flightKey: flight.flightKey });
    const replaced = await runStep(inside.steps[0], untouched);
    expect(replaced.events).toContain('push_soak_skipped');
    expect(calls).toEqual([]);
    expect(await auditFor('notify.injected', record.id)).toEqual([]);
  });

  it('adds the canary to every twelfth tick from the start, the first included: once an hour', () => {
    const start = Date.parse('2026-10-01T10:03:27.000Z');
    const record = {
      startedAt: iso(start),
      endsAt: iso(start + 24 * HOUR_MS),
      stoppedAt: null,
    } as PushSoakRecord;
    const tickMs = 5 * MINUTE_MS;
    const canaries: (number | null)[] = [];
    for (let at = Math.ceil(start / tickMs) * tickMs; at < start + 24 * HOUR_MS; at += tickMs) {
      const position = pushSoakPosition(record, at);
      expect(position.state).toBe('running');
      if (position.canary) {
        canaries.push(position.slot);
      }
    }
    expect(canaries).toEqual(Array.from({ length: 24 }, (_, hour) => hour * 12));
    expect(ticksDue(record, start + 30 * HOUR_MS)).toEqual({ ticks: 288, canaries: 24 });
  });

  it('the canary sends two test pushes at once, both asking PushAuth in the same instant past a warm isolate cache', async () => {
    const canary = await canaryToken();
    const record = await soakRecord({
      flightKey: uniqueFlight().flightKey,
      canary: { pushTokenId: canary.pushTokenId, kind: 'apns' },
    });
    // This isolate already holds the sandbox token, as a busy push consumer's would.
    await durableCredentialSource(testEnv).token('apns:sandbox');
    const asks = { calls: 0, inFlight: 0, max: 0, tokens: new Set<string>() };
    const pushAuth = (name: PushCredentialName): PushAuthStub => {
      const stub = defaultPushAuthStub(testEnv)(name);
      return {
        current: async (input) => {
          asks.calls += 1;
          asks.inFlight += 1;
          asks.max = Math.max(asks.max, asks.inFlight);
          try {
            const result = await stub.current(input);
            if (result.ok) {
              asks.tokens.add(result.token);
            }
            return result;
          } finally {
            asks.inFlight -= 1;
          }
        },
        expire: (input) => stub.expire(input),
      };
    };
    // The two sends' liveness reads answer 80 ms apart: only the gate can make the asks meet.
    let reads = 0;
    const liveTokens = async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, reads === 1 ? 0 : 80));
      return {
        tokens: new Map([[canary.pushTokenId, canary.userId]]),
        superseded: new Set<string>(),
      };
    };
    const apns = fakeFetch(() => apnsAnswer(200));
    const persistQueue = capturingQueue();
    const pushQueue = capturingQueue();
    const deps: PushSoakCanaryDeps = {
      pushAuth,
      liveTokens,
      fetch: apns.fetch,
      persistQueue: persistQueue.queue,
      pushQueue: pushQueue.queue,
    };
    const jobIds = [uuidv7(), uuidv7()];
    const step: PushSoakMessageV1 = {
      kind: 'push_soak',
      step: 'canary',
      soakId: record.id,
      slot: 12,
      runId: iso(Date.now()),
      jobIds,
    };
    const ran = await runStep(step, { canary: deps });
    expect(ran.acked).toHaveLength(1);
    expect(ran.events).toContain('push_soak_canary_sent');

    // Both sends asked PushAuth, at the same time, and were given the one token.
    expect(asks).toMatchObject({ calls: 2, max: 2 });
    expect(asks.tokens.size).toBe(1);
    const [token] = [...asks.tokens];
    expect(apns.requests.map((request) => request.headers['authorization'])).toEqual([
      `bearer ${String(token)}`,
      `bearer ${String(token)}`,
    ]);
    expect(
      apns.requests.every((request) => request.url.endsWith(`/3/device/${canary.token}`)),
    ).toBe(true);
    // Each job's outcome went to persist as a test, so each has its delivery row; no retry.
    const outcomes = persistQueue.sent.map((entry) => entry.body as PushOutcomeMessageV1);
    expect(outcomes.map((outcome) => outcome.jobId).sort()).toEqual([...jobIds].sort());
    expect(outcomes.every((outcome) => outcome.test)).toBe(true);
    expect(outcomes.map((outcome) => outcome.results[0]?.outcome)).toEqual(['sent', 'sent']);
    expect(pushQueue.sent).toEqual([]);
    const sent = { outcome: 'sent', reason: null, http_status: 200, settled: 'acked' };
    expect(await auditFor('push.soak_canary', record.id)).toMatchObject([
      {
        actorType: 'system',
        targetId: canary.pushTokenId,
        subjectId: canary.userId,
        details: { outcome: 'sent', soak_slot: 12, job_ids: jobIds, sends: [sent, sent] },
      },
    ]);
  });

  it('records a canary refused when its token was invalidated since the start, and sends nothing', async () => {
    const canary = await canaryToken();
    const record = await soakRecord({
      flightKey: uniqueFlight().flightKey,
      canary: { pushTokenId: canary.pushTokenId, kind: 'apns' },
    });
    await db()
      .update(pushTokens)
      .set({ invalidatedAt: sql`now()` })
      .where(eq(pushTokens.id, canary.pushTokenId));
    const apns = fakeFetch(() => apnsAnswer(200));
    const step: PushSoakMessageV1 = {
      kind: 'push_soak',
      step: 'canary',
      soakId: record.id,
      slot: 0,
      runId: iso(Date.now()),
      jobIds: [uuidv7(), uuidv7()],
    };
    const ran = await runStep(step, { canary: { fetch: apns.fetch } });
    expect(ran.events).toContain('push_soak_canary_refused');
    expect(apns.requests).toEqual([]);
    expect(await auditFor('push.soak_canary', record.id)).toMatchObject([
      { details: { outcome: 'refused', refusal: 'token_invalidated' } },
    ]);
  });

  it("lets a canary send ask alone once the gate's wait ends", async () => {
    await expect(gateTogether(2, 10)()).resolves.toBeUndefined();
  });
});

/** JSONC as data: comments outside strings dropped, then trailing commas. */
function parseJsonc(text: string): unknown {
  let json = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      json += ch;
      if (ch === '\\') {
        json += text.charAt(i + 1);
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '/' && text.charAt(i + 1) === '/') {
      while (i < text.length && text.charAt(i) !== '\n') {
        i += 1;
      }
      json += '\n';
    } else {
      inString = ch === '"';
      json += ch;
    }
  }
  return JSON.parse(json.replace(/,(\s*[}\]])/g, '$1'));
}

interface Triggers {
  readonly triggers?: { readonly crons: readonly string[] };
}

describe('staging only (C9)', () => {
  it('production refuses to start a soak; its page has no form, its tick and its steps do nothing', async () => {
    const flight = uniqueFlight();
    await trackedFlight(flight, flight.scheduledOut.getTime() - 30 * HOUR_MS);
    const canary = await canaryToken();
    const form = {
      action: 'start',
      flight_key: flight.flightKey,
      hours: '24',
      token: canary.token,
      kind: 'apns',
    };
    const refused = await admin({ form, env: PRODUCTION });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('runs on staging only');
    expect(await readPushSoak(testEnv.CONFIG)).toBeNull();
    expect(await startRowsFor(flight.flightKey)).toEqual([]);
    const page = await (await admin({ env: PRODUCTION })).text();
    expect(page).toContain('runs on staging only');
    expect(page).not.toContain('<form');
    expect(await (await admin({ path: '/admin', env: PRODUCTION })).text()).toContain(
      'Staging only: production refuses to start a soak.',
    );

    // A record cannot come from production; were one there, its tick and its steps still refuse.
    const record = await soakRecord({ flightKey: flight.flightKey });
    expect(await tick(Date.now(), PRODUCTION)).toEqual({
      steps: [],
      events: ['cron_push_soak_refused'],
    });
    const calls: string[] = [];
    const ran = await runStep(
      {
        kind: 'push_soak',
        step: 'inject',
        soakId: record.id,
        slot: 0,
        runId: iso(Date.now()),
        injectionId: uuidv7(),
      },
      {
        injectorFor: () => () => {
          calls.push('tracker');
          return {
            getState: () => Promise.reject(new Error('x')),
            injectPolicyEvent: () => Promise.reject(new Error('x')),
          };
        },
      },
      PRODUCTION,
    );
    expect(ran.events).toContain('push_soak_refused');
    expect(calls).toEqual([]);
    expect(await auditFor('notify.injected', record.id)).toEqual([]);
  });

  it("wrangler.jsonc gives staging alone the soak's tick, and every expression is routed", async () => {
    const config = parseJsonc(wranglerConfig) as Triggers & {
      readonly env: { readonly staging: Triggers; readonly production: Triggers };
    };
    expect(PUSH_SOAK_CRON).toBe('*/5 * * * *');
    expect(config.triggers?.crons).toEqual([RECONCILE_CRON, DAILY_CRON]);
    expect(config.env.staging.triggers?.crons).toEqual([
      RECONCILE_CRON,
      DAILY_CRON,
      PUSH_SOAK_CRON,
    ]);
    // `triggers` is inheritable: production, with no block of its own, keeps the top level's two.
    expect(config.env.production.triggers).toBeUndefined();
    for (const cron of config.env.staging.triggers?.crons ?? []) {
      expect(CRON_HANDLERS[cron]).toBeDefined();
    }
    const { lines, log } = capture();
    await runCron(PUSH_SOAK_CRON, { env: testEnv, ctx: createExecutionContext(), log });
    expect(lines.map((line) => line.event)).toEqual(['cron_push_soak_idle']);
  });
});

/** A delivery whose attempt log holds one entry, as persist merges an outcome into it. */
async function plantAttempt(entry: {
  readonly channel: 'apns' | 'fcm';
  readonly outcome: string;
  readonly reason: string | null;
  readonly status: number | null;
  readonly at: string;
  readonly createdAt?: string;
}): Promise<void> {
  await db()
    .insert(notificationDeliveries)
    .values({
      notificationId: uuidv7(),
      subjectId: uuidv7(),
      channel: entry.channel,
      pushTokenId: uuidv7(),
      status: entry.outcome === 'retry' ? 'queued' : entry.outcome,
      attempts: 0,
      attemptLog: {
        [`0:${entry.outcome}`]: { r: entry.reason, s: entry.status, p: null, at: entry.at },
      },
      createdAt: entry.createdAt ?? entry.at,
    });
}

/** The body rows of the first table after `heading`, as text cells. */
function tableAfter(html: string, heading: string): string[][] {
  const from = html.indexOf(heading);
  expect(from).toBeGreaterThanOrEqual(0);
  const start = html.indexOf('<tbody>', from);
  const body = html.slice(start, html.indexOf('</tbody>', start));
  return [...body.matchAll(/<tr>(.*?)<\/tr>/g)].map((row) =>
    [...(row[1] ?? '').matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => cell[1] ?? ''),
  );
}

const sorted = (rows: string[][]): string[][] =>
  [...rows].sort((a, b) => a.join('|').localeCompare(b.join('|')));

describe('the counts by reason (C9)', () => {
  it("counts every 403 and 429 reason, edge 52x answers and the sends inside the soak's window, and its 409s", async () => {
    // A soak in 2001: a window no other file's deliveries or audit rows fall in.
    const start = Date.parse('2001-03-04T05:00:00.000Z');
    const at = (minutes: number) => iso(start + minutes * MINUTE_MS);
    const flight = uniqueFlight();
    const tracker = await trackedFlight(flight, flight.scheduledOut.getTime() - 30 * HOUR_MS);
    const record = await soakRecord({
      flightKey: flight.flightKey,
      startedAt: at(0),
      hours: 1,
      endsAt: at(60),
    });
    const attempt = (outcome: string, reason: string | null, status: number | null) => ({
      outcome,
      reason,
      status,
    });
    const planted: [number, 'apns' | 'fcm', ReturnType<typeof attempt>, string?][] = [
      [5, 'apns', attempt('sent', null, 200)],
      [6, 'apns', attempt('sent', null, 200)],
      [7, 'fcm', attempt('sent', null, 200)],
      [8, 'apns', attempt('retry', 'UnrelatedKeyIdInToken', 403)],
      [9, 'apns', attempt('retry', 'TooManyProviderTokenUpdates', 429)],
      [10, 'apns', attempt('retry', 'TooManyProviderTokenUpdates', 429)],
      [11, 'apns', attempt('retry', 'edge_520', 520)],
      [12, 'apns', attempt('retry', 'edge_403', 403)],
      [13, 'apns', attempt('invalid_token', 'Unregistered', 410)],
      [14, 'fcm', attempt('retry', 'QUOTA_EXCEEDED', 429)],
      // A delivery created the day before, its retry inside the window: counted.
      [30, 'apns', attempt('retry', 'TooManyProviderTokenUpdates', 429), at(-20 * 60)],
      // Before the start and after the end: not counted.
      [-1, 'apns', attempt('retry', 'UnrelatedKeyIdInToken', 403)],
      [-2, 'apns', attempt('retry', 'UnrelatedKeyIdInToken', 403)],
      [61, 'apns', attempt('retry', 'TooManyProviderTokenUpdates', 429)],
      [62, 'apns', attempt('retry', 'edge_521', 521)],
    ];
    for (const [minute, channel, entry, createdAt] of planted) {
      await plantAttempt({
        channel,
        ...entry,
        at: at(minute),
        ...(createdAt === undefined ? {} : { createdAt }),
      });
    }

    // Three ticks: written by the real tracker, the tracker's 409 for an open suspicion, and no
    // tracker at all.
    const step = (slot: number): PushSoakMessageV1 => ({
      kind: 'push_soak',
      step: 'inject',
      soakId: record.id,
      slot,
      runId: at(slot * 5),
      injectionId: uuidv7(),
    });
    await runStep(step(0));
    const suspected = answeringTracker(tracker, {
      outcome: 'ignored',
      reason: 'suspected',
      intents: [],
    });
    await runStep(step(1), { injectorFor: suspected.injectorFor });
    expect(suspected.injections).toHaveLength(1);
    const absent = () => () => ({
      getState: () => {
        const error = new Error('invalid_request: tracker is not seeded');
        error.name = 'RpcRequestError';
        return Promise.reject(error);
      },
      injectPolicyEvent: () => Promise.reject(new Error('not expected')),
    });
    await runStep(step(2), { injectorFor: absent });

    const page = await admin({ options: { now: () => start + 2 * HOUR_MS } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<td>ended</td>');
    expect(html).toContain('Ticks so far: 12');
    expect(html).toContain(`from ${at(0)} until ${at(60)}`);
    expect(sorted(tableAfter(html, '<h3>Sent</h3>'))).toEqual([
      ['apns', '2'],
      ['fcm', '1'],
    ]);
    expect(sorted(tableAfter(html, '<h3>403 and 429 answers, by reason</h3>'))).toEqual(
      sorted([
        ['429', 'apns', 'TooManyProviderTokenUpdates', '3'],
        ['403', 'apns', 'UnrelatedKeyIdInToken', '1'],
        ['403', 'apns', 'edge_403', '1'],
        ['429', 'fcm', 'QUOTA_EXCEEDED', '1'],
      ]),
    );
    expect(tableAfter(html, '<h3>Edge 52x answers without an apns-id</h3>')).toEqual([
      ['apns', 'edge_520', '1'],
    ]);
    expect(tableAfter(html, '<h3>Every attempt</h3>')).toContainEqual([
      'apns',
      'no',
      'invalid_token',
      '410',
      'Unregistered',
      '1',
    ]);
    // One row per tick; the 409 is counted as the tracker gave it.
    expect(sorted(tableAfter(html, '<h2>Injections</h2>'))).toEqual(
      sorted([
        ['written', '', '1'],
        ['ignored', 'suspected', '1'],
        ['refused', 'absent', '1'],
      ]),
    );
  });

  it('draws the named answers out of the attempt rows', () => {
    const row = (outcome: string, reason: string, status: string, n: number, channel = 'apns') => ({
      channel,
      is_test: true,
      outcome,
      reason,
      http_status: status,
      n,
    });
    const html = attemptsHtml([
      row('retry', 'TooManyProviderTokenUpdates', '429', 2),
      row('retry', 'edge_522', '522', 1),
      row('retry', 'edge_502', '502', 4),
      row('retry', 'InternalServerError', '500', 1),
      row('sent', '', '200', 7),
    ]);
    expect(tableAfter(html, '<h3>Edge 52x answers without an apns-id</h3>')).toEqual([
      ['apns', 'edge_522', '1'],
    ]);
    expect(tableAfter(html, '<h3>403 and 429 answers, by reason</h3>')).toEqual([
      ['429', 'apns', 'TooManyProviderTokenUpdates', '2'],
    ]);
    expect(tableAfter(html, '<h3>Sent</h3>')).toEqual([['apns', '7']]);
  });
});
