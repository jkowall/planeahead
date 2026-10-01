/**
 * The `push` queue consumer (increment 14, ruling P4), in the Workers pool with an injected
 * `fetch` and credential source behind the real transports: at most six requests in flight, the
 * retry delays per reason, drops past `expiresAt`, per-target acknowledgement (the job is
 * acknowledged, only retryable targets come back, each with its own delay and attempt count),
 * the hold of an unconfigured platform, and the outcome message it sends to `persist`.
 *
 * The review round: the liveness read before the first send (ruling R1), against the real
 * database for a sign-out and an account switch between a first send and its retry, and with an
 * injected read for its failure and its order; one `sendBatch` for a job's follow-ups (R2); the
 * ops alert of a production platform without usable credentials (R3). The other tests' targets
 * have no `push_tokens` row, so their read finds every target live (`everyTargetLive`).
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import {
  PushJobV1,
  PushOutcomeMessageV1,
  type PushJobV1Input,
  type PushTargetResultV1,
} from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { createLogger, type LogLine } from '../../src/observability/log';
import type { CaptureMessage } from '../../src/observability/ops-alert';
import { pushConfiguration, type PushConfiguration } from '../../src/push/config';
import { NOT_CONFIGURED_HOLD_SECONDS, type TransportOutcome } from '../../src/push/transport';
import {
  LIVENESS_RETRY_DELAY_SECONDS,
  MAX_QUEUE_DELAY_SECONDS,
  PUSH_MAX_IN_FLIGHT,
  PUSH_REQUEUE_FAILURE_DELAY_SECONDS,
  handlePushBatch,
  mapWithConcurrency,
  readLiveTokens,
  type PushConsumerDeps,
} from '../../src/queues/push';
import {
  FCM_ERROR_TYPE,
  apnsAnswer,
  capturingQueue,
  everyTargetLive,
  fakeCredentials,
  fakeFetch,
  fcmError,
  fcmTarget,
  jobInput,
  target,
  testEnv,
  type CapturingQueue,
  type RecordedRequest,
  type Responder,
} from '../unit/helpers/push';
import {
  jsonRequest,
  registerDevice,
  signInAnonymously,
  uniqueInstallId,
  worker,
  type AnonymousSession,
} from './helpers/auth';
import { db } from './helpers/routes';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const HOUR = 3_600_000;

interface Run {
  readonly requests: RecordedRequest[];
  readonly maxInFlight: number;
  readonly requeued: CapturingQueue['sent'];
  /** Every call on the push queue: one `sendBatch` per job with follow-ups (ruling R2). */
  readonly requeueCalls: CapturingQueue['calls'];
  readonly outcomes: PushOutcomeMessageV1[];
  readonly result: Awaited<ReturnType<typeof getQueueResult>>;
  readonly lines: LogLine[];
}

async function run(
  jobs: readonly unknown[],
  respond: Responder,
  options: {
    configuration?: PushConfiguration;
    failRequeue?: boolean;
    failPersist?: boolean;
    now?: number;
    env?: Env;
    /** The liveness read; every target live by default, `'database'` for the real read. */
    liveTokens?: PushConsumerDeps['liveTokens'] | 'database';
    capture?: CaptureMessage;
    transports?: PushConsumerDeps['transports'];
  } = {},
): Promise<Run> {
  const env = options.env ?? testEnv;
  const fake = fakeFetch(respond);
  const push = capturingQueue(options.failRequeue);
  const persist = capturingQueue(options.failPersist);
  const lines: LogLine[] = [];
  const batch = createMessageBatch(
    'planeahead-push-local',
    jobs.map((body, index) => ({
      id: `job-${String(index)}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  const liveTokens =
    options.liveTokens === 'database' ? undefined : (options.liveTokens ?? everyTargetLive(jobs));
  const deps: PushConsumerDeps = {
    fetch: fake.fetch,
    credentials: fakeCredentials(),
    now: () => options.now ?? NOW,
    pushQueue: push.queue,
    persistQueue: persist.queue,
    configuration: options.configuration ?? pushConfiguration(env),
    ...(liveTokens === undefined ? {} : { liveTokens }),
    ...(options.capture === undefined ? {} : { capture: options.capture }),
    ...(options.transports === undefined ? {} : { transports: options.transports }),
  };
  await handlePushBatch(
    batch,
    { env, ctx, log: createLogger({}, (line) => lines.push(line)) },
    deps,
  );
  return {
    requests: fake.requests,
    maxInFlight: fake.maxInFlight,
    requeued: push.sent,
    requeueCalls: push.calls,
    outcomes: persist.sent.map((entry) => PushOutcomeMessageV1.parse(entry.body)),
    result: await getQueueResult(batch, ctx),
    lines,
  };
}

function inOneHour(overrides: Partial<PushJobV1Input> = {}): PushJobV1Input {
  return jobInput({ expiresAt: new Date(NOW + HOUR).toISOString(), ...overrides });
}

/** The APNs host answers by the token in the path, an FCM token by its value in the body. */
function byToken(answers: Record<string, () => Response>): Responder {
  return (request) => {
    for (const [token, answer] of Object.entries(answers)) {
      if (request.url.includes(token) || request.body.includes(`"token":"${token}"`)) {
        return answer();
      }
    }
    return apnsAnswer(200);
  };
}

function hex(label: number): string {
  return label.toString(16).padStart(64, '0');
}

function resultFor(outcome: PushOutcomeMessageV1, pushTokenId: string): PushTargetResultV1 {
  const found = outcome.results.find((result) => result.pushTokenId === pushTokenId);
  if (found === undefined) {
    throw new Error(`no result for ${pushTokenId}`);
  }
  return found;
}

describe('mapWithConcurrency', () => {
  it('keeps the input order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([5, 1, 4, 2, 3, 6, 7, 8], 3, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, value));
      running -= 1;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 40, 20, 30, 60, 70, 80]);
    expect(peak).toBe(3);
  });
});

describe('the push consumer (ruling P4)', () => {
  it('sends at most six requests at once across the batch, and every target gets its answer', async () => {
    const targets = Array.from({ length: 20 }, (_value, index) =>
      target({ token: hex(index + 1) }),
    );
    const slow: Responder = () =>
      new Promise((resolve) => setTimeout(() => resolve(apnsAnswer(200)), 5));

    const outcome = await run(
      [
        inOneHour({ targets }),
        inOneHour({
          targets: targets.slice(0, 7).map((t) => ({ ...t, pushTokenId: crypto.randomUUID() })),
        }),
      ],
      slow,
    );

    expect(PUSH_MAX_IN_FLIGHT).toBe(6);
    expect(outcome.requests).toHaveLength(27);
    expect(outcome.maxInFlight).toBe(6);
    expect(outcome.outcomes).toHaveLength(2);
    expect(outcome.outcomes[0]?.results.every((result) => result.outcome === 'sent')).toBe(true);
    expect(outcome.result.explicitAcks).toEqual(['job-0', 'job-1']);
  });

  it('acknowledges the job and re-enqueues only the retryable targets, each with its own delay', async () => {
    const sent = target({ token: hex(1) });
    const throttled = target({ token: hex(2) });
    const apnsDown = target({ token: hex(3) });
    const dead = target({ token: hex(4) });
    const fcmQuota = fcmTarget({ token: 'fcm-quota-token-1234567890' });
    const fcmDown = fcmTarget({ token: 'fcm-down-token-1234567890' });
    const quotaDetail = [{ '@type': FCM_ERROR_TYPE, errorCode: 'QUOTA_EXCEEDED' }];
    const job = inOneHour({
      expiresAt: new Date(NOW + 2 * HOUR).toISOString(),
      targets: [sent, throttled, apnsDown, dead, fcmQuota, fcmDown],
    });

    const outcome = await run(
      [job],
      byToken({
        [hex(2)]: () => apnsAnswer(429, { reason: 'TooManyRequests' }),
        [hex(3)]: () => apnsAnswer(503, { reason: 'ServiceUnavailable' }),
        [hex(4)]: () => apnsAnswer(410, { reason: 'Unregistered', timestamp: NOW - HOUR }),
        'fcm-quota-token-1234567890': () =>
          fcmError(429, 'RESOURCE_EXHAUSTED', quotaDetail, { 'retry-after': '120' }),
        'fcm-down-token-1234567890': () => fcmError(503, 'UNAVAILABLE'),
      }),
    );

    // One acknowledgement, never a retry of the message: a sent target is never sent again.
    expect(outcome.result.explicitAcks).toEqual(['job-0']);
    expect(outcome.result.retryMessages).toEqual([]);
    // The four delay groups leave in one batch (ruling R2).
    expect(outcome.requeueCalls).toEqual([{ method: 'sendBatch', messages: 4 }]);
    const requeued = new Map(
      outcome.requeued.map((entry) => [entry.delaySeconds, PushJobV1.parse(entry.body)]),
    );
    expect([...requeued.keys()].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([10, 60, 120, 900]);
    expect(requeued.get(60)?.targets.map((t) => t.pushTokenId)).toEqual([throttled.pushTokenId]);
    expect(requeued.get(900)?.targets.map((t) => t.pushTokenId)).toEqual([apnsDown.pushTokenId]);
    expect(requeued.get(120)?.targets.map((t) => t.pushTokenId)).toEqual([fcmQuota.pushTokenId]);
    expect(requeued.get(10)?.targets.map((t) => t.pushTokenId)).toEqual([fcmDown.pushTokenId]);
    // The same job, with the attempt counted.
    for (const next of requeued.values()) {
      expect(next.jobId).toBe(job.jobId);
      expect(next.targets[0]?.attempt).toBe(1);
      expect(next.title).toBe(job.title);
    }

    const [recorded] = outcome.outcomes;
    expect(recorded?.results).toHaveLength(6);
    expect(resultFor(recorded!, sent.pushTokenId)).toMatchObject({
      outcome: 'sent',
      attempt: 1,
      requested: true,
    });
    expect(resultFor(recorded!, throttled.pushTokenId)).toMatchObject({
      outcome: 'retry',
      reason: 'TooManyRequests',
      retryDelaySeconds: 60,
      httpStatus: 429,
    });
    expect(resultFor(recorded!, dead.pushTokenId)).toMatchObject({
      outcome: 'invalid_token',
      reason: 'Unregistered',
      apnsTimestampMs: NOW - HOUR,
    });
  });

  it('drops a target past expiresAt unsent, and a retry that would land after it', async () => {
    const past = inOneHour({ expiresAt: new Date(NOW - 1000).toISOString() });
    const throttled = target({ token: hex(7) });
    const apnsDown = target({ token: hex(8) });
    const soon = inOneHour({
      expiresAt: new Date(NOW + 10 * 60_000).toISOString(),
      targets: [throttled, apnsDown],
    });

    const outcome = await run(
      [past, soon],
      byToken({
        [hex(7)]: () => apnsAnswer(429, { reason: 'TooManyRequests' }),
        [hex(8)]: () => apnsAnswer(500, { reason: 'InternalServerError' }),
      }),
    );

    // The first job sends nothing; the second's 15-minute retry would land past its window.
    expect(outcome.requests).toHaveLength(2);
    expect(outcome.outcomes[0]?.results[0]).toMatchObject({
      outcome: 'expired',
      reason: 'expired',
      requested: false,
      attempt: 0,
    });
    expect(resultFor(outcome.outcomes[1]!, apnsDown.pushTokenId)).toMatchObject({
      outcome: 'expired',
      reason: 'InternalServerError',
      requested: true,
      attempt: 1,
      retryDelaySeconds: null,
    });
    expect(outcome.requeued).toHaveLength(1);
    expect(outcome.requeued[0]?.delaySeconds).toBe(60);
    expect(PushJobV1.parse(outcome.requeued[0]?.body).targets.map((t) => t.pushTokenId)).toEqual([
      throttled.pushTokenId,
    ]);
    expect(outcome.result.explicitAcks).toEqual(['job-0', 'job-1']);
  });

  it('holds an unconfigured platform as not_configured, unsent, and still sends the other', async () => {
    const ios = target({ token: hex(9) });
    const android = fcmTarget();
    const configuration: PushConfiguration = {
      apns: { configured: false, problems: ['APNS_KEY_P8 is not set'] },
      fcm: { configured: true, problems: [], projectId: 'planeahead-test' },
    };

    const outcome = await run(
      [inOneHour({ targets: [ios, android] })],
      () => Response.json({ name: 'projects/planeahead-test/messages/1' }),
      { configuration },
    );

    expect(outcome.requests.map((request) => new URL(request.url).host)).toEqual([
      'fcm.googleapis.com',
    ]);
    expect(resultFor(outcome.outcomes[0]!, ios.pushTokenId)).toMatchObject({
      outcome: 'not_configured',
      reason: 'not_configured',
      requested: false,
      attempt: 0,
    });
    expect(outcome.requeued).toHaveLength(1);
    expect(outcome.requeued[0]?.delaySeconds).toBe(NOT_CONFIGURED_HOLD_SECONDS);
    const held = PushJobV1.parse(outcome.requeued[0]?.body);
    expect(held.targets.map((t) => [t.pushTokenId, t.attempt])).toEqual([[ios.pushTokenId, 0]]);

    // Held until the window ends: then it is dropped instead.
    const late = await run(
      [inOneHour({ expiresAt: new Date(NOW + 60_000).toISOString(), targets: [ios] })],
      () => apnsAnswer(200),
      {
        configuration,
      },
    );
    expect(late.requeued).toEqual([]);
    expect(late.outcomes[0]?.results[0]).toMatchObject({
      outcome: 'expired',
      reason: 'not_configured',
    });
  });

  it('caps a long Retry-After at the queue maximum', async () => {
    const android = fcmTarget();
    const quota = [{ '@type': FCM_ERROR_TYPE, errorCode: 'QUOTA_EXCEEDED' }];
    const outcome = await run(
      [inOneHour({ expiresAt: new Date(NOW + 48 * HOUR).toISOString(), targets: [android] })],
      () => fcmError(429, 'RESOURCE_EXHAUSTED', quota, { 'retry-after': String(30 * 3600) }),
    );

    expect(outcome.requeued[0]?.delaySeconds).toBe(MAX_QUEUE_DELAY_SECONDS);
  });

  it('acknowledges a job it cannot read without sending or recording anything', async () => {
    const outcome = await run([{ kind: 'push_job', jobId: 'not-a-uuid', targets: [] }], () =>
      apnsAnswer(200),
    );

    expect(outcome.requests).toEqual([]);
    expect(outcome.outcomes).toEqual([]);
    expect(outcome.result.explicitAcks).toEqual(['job-0']);
    const invalid = outcome.lines.find((line) => line.event === 'push_job_invalid');
    expect(invalid?.level).toBe('error');
    expect(JSON.stringify(outcome.lines)).not.toContain('not-a-uuid');
  });

  it('retries the whole message when its retries cannot be enqueued', async () => {
    const outcome = await run(
      [inOneHour({ targets: [target({ token: hex(10) })] })],
      () => apnsAnswer(429, { reason: 'TooManyRequests' }),
      { failRequeue: true },
    );

    expect(outcome.result.retryMessages.map((message) => message.msgId)).toEqual(['job-0']);
    expect(outcome.result.explicitAcks).toEqual([]);
    expect(outcome.outcomes).toEqual([]);
    expect(outcome.requeueCalls).toEqual([{ method: 'sendBatch', messages: 1 }]);
    expect(PUSH_REQUEUE_FAILURE_DELAY_SECONDS).toBeGreaterThan(0);
  });

  it('still acknowledges a job whose outcome message could not be sent, and says so', async () => {
    const outcome = await run([inOneHour()], () => apnsAnswer(200), { failPersist: true });

    expect(outcome.result.explicitAcks).toEqual(['job-0']);
    expect(outcome.lines.filter((line) => line.event === 'push_outcome_send_failed')).toHaveLength(
      2,
    );
    expect(outcome.lines.find((line) => line.event === 'push_job_done')?.['recorded']).toBe(false);
  });

  it('records a test job under its job id, never logging a device token', async () => {
    const testJob = inOneHour({
      test: true,
      notificationKind: 'system',
      flightKey: undefined,
      targets: [target({ token: hex(11), notificationId: undefined })],
    });

    const outcome = await run([testJob], () => apnsAnswer(200, null, 'apns-id-1'));

    expect(outcome.outcomes[0]).toMatchObject({
      kind: 'push_outcome',
      jobId: testJob.jobId,
      test: true,
    });
    expect(outcome.outcomes[0]?.results[0]?.notificationId).toBeUndefined();
    expect(outcome.outcomes[0]?.results[0]?.providerId).toBe('apns-id-1');
    expect(JSON.stringify(outcome.lines)).not.toContain(hex(11));
    expect(JSON.stringify(outcome.lines)).not.toContain('token-for-');
  });
});

/** A 64-hex APNs device token, as the app registers one. */
function hexToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

interface Registered {
  readonly pushTokenId: string;
  readonly token: string;
  readonly userId: string;
}

/** `POST /v1/devices` with a sandbox APNs token of the development app, through the Worker. */
async function registeredToken(
  session: AnonymousSession,
  installId: string,
  token: string = hexToken(),
): Promise<Registered> {
  const response = await registerDevice(session, installId, {
    pushTokenKind: 'apns',
    pushToken: token,
    pushEnvironment: 'sandbox',
    appId: 'app.planeahead.mobile.dev',
  });
  const body = await response.json<{ pushToken: { id: string } | null }>();
  if (body.pushToken === null) {
    throw new Error('the token was not registered');
  }
  return { pushTokenId: body.pushToken.id, token, userId: session.userId };
}

/** A job for a registered token, as notify will build it: the row's id and its owner. */
function jobFor(token: Registered): PushJobV1Input {
  return inOneHour({
    targets: [
      target({ pushTokenId: token.pushTokenId, subjectId: token.userId, token: token.token }),
    ],
  });
}

/** Where the first send of each liveness test ends: a 429, so the target comes back as a retry. */
const throttled = () => apnsAnswer(429, { reason: 'TooManyRequests' });

describe('token liveness before the first send (review ruling R1)', () => {
  it('sends nothing on the retry after a sign-out between the first send and the retry', async () => {
    const session = await signInAnonymously();
    const installId = uniqueInstallId('r1-sign-out');
    const token = await registeredToken(session, installId);

    const first = await run([jobFor(token)], throttled, { liveTokens: 'database' });
    const signOut = await worker(
      jsonRequest(
        '/v1/devices/current/invalidate',
        'POST',
        { installId },
        { ip: session.ip, cookie: session.cookie },
      ),
    );
    const retry = await run([first.requeued[0]?.body], () => apnsAnswer(200), {
      liveTokens: 'database',
    });

    // The first send went out, live; the retry after the sign-out does not.
    expect(first.requests).toHaveLength(1);
    expect(first.requeued.map((entry) => entry.delaySeconds)).toEqual([60]);
    expect(signOut.status).toBe(200);
    expect(retry.requests).toEqual([]);
    expect(retry.requeued).toEqual([]);
    expect(retry.outcomes[0]?.results[0]).toMatchObject({
      pushTokenId: token.pushTokenId,
      outcome: 'failed',
      reason: 'token_inactive',
      requested: false,
      attempt: 1,
      httpStatus: null,
    });
    expect(retry.result.explicitAcks).toEqual(['job-0']);
  });

  it('sends nothing on the retry after an account switch moved the row to another user', async () => {
    const before = await signInAnonymously();
    const installId = uniqueInstallId('r1-switch');
    const token = await registeredToken(before, installId);

    const first = await run([jobFor(token)], throttled, { liveTokens: 'database' });
    // The phone signs in as someone else and registers the same token from the same installation:
    // the row keeps its id, stays live, and now belongs to the second user.
    const after = await signInAnonymously();
    const moved = await registeredToken(after, installId, token.token);
    const [row] = await db().execute<{ user_id: string; invalidated_at: string | null }>(sql`
      select user_id::text as user_id, invalidated_at::text as invalidated_at
      from push_tokens where id = ${token.pushTokenId}::uuid
    `);
    const retry = await run([first.requeued[0]?.body], () => apnsAnswer(200), {
      liveTokens: 'database',
    });

    expect(first.requests).toHaveLength(1);
    expect(moved.pushTokenId).toBe(token.pushTokenId);
    expect(row).toEqual({ user_id: after.userId, invalidated_at: null });
    expect(retry.requests).toEqual([]);
    expect(retry.outcomes[0]?.results[0]).toMatchObject({
      outcome: 'failed',
      reason: 'token_inactive',
      requested: false,
      attempt: 1,
    });
  });

  it('reads once for the batch, and has its answer before the first send; a live token is sent', async () => {
    const session = await signInAnonymously();
    const live = [
      await registeredToken(session, uniqueInstallId('r1-live-a')),
      await registeredToken(session, uniqueInstallId('r1-live-b')),
    ];
    const events: string[] = [];
    const asked: (readonly string[])[] = [];
    const sent: TransportOutcome = {
      outcome: 'sent',
      requested: true,
      providerId: 'apns-id-r1',
      httpStatus: 200,
    };
    const configuration: PushConfiguration = {
      apns: { configured: true, problems: [] },
      fcm: {
        configured: false,
        problems: ['FCM_SERVICE_ACCOUNT_JSON is not set'],
        projectId: null,
      },
    };

    const outcome = await run(
      [
        inOneHour({
          targets: live.map((token) =>
            target({ pushTokenId: token.pushTokenId, subjectId: token.userId, token: token.token }),
          ),
        }),
        // Neither of these needs the read: one past its window, one held.
        inOneHour({ expiresAt: new Date(NOW - 1000).toISOString() }),
        inOneHour({ targets: [fcmTarget()] }),
      ],
      () => apnsAnswer(200),
      {
        configuration,
        // The real read on the real database, observed.
        liveTokens: async (ids, notificationIds) => {
          asked.push(ids);
          const found = await readLiveTokens(testEnv, ids, notificationIds);
          events.push('read');
          return found;
        },
        transports: {
          apns: {
            kind: 'apns',
            send: () => {
              events.push('send');
              return Promise.resolve(sent);
            },
          },
        },
      },
    );

    expect(asked).toHaveLength(1);
    expect([...(asked[0] ?? [])].sort()).toEqual(live.map((token) => token.pushTokenId).sort());
    expect(events).toEqual(['read', 'send', 'send']);
    expect(outcome.outcomes[0]?.results.map((result) => result.outcome)).toEqual(['sent', 'sent']);
    expect(outcome.outcomes[1]?.results[0]?.outcome).toBe('expired');
    expect(outcome.outcomes[2]?.results[0]?.outcome).toBe('not_configured');
  });

  it('sends nothing when the read fails: re-enqueued unsent after 60 s, or dropped past the window', async () => {
    const [first, second] = [target({ token: hex(21) }), target({ token: hex(22) })];
    const soon = target({ token: hex(23) });
    const android = fcmTarget();
    const configuration: PushConfiguration = {
      apns: { configured: true, problems: [] },
      fcm: {
        configured: false,
        problems: ['FCM_SERVICE_ACCOUNT_JSON is not set'],
        projectId: null,
      },
    };

    const outcome = await run(
      [
        inOneHour({ targets: [first, second] }),
        inOneHour({ expiresAt: new Date(NOW + 30_000).toISOString(), targets: [soon] }),
        inOneHour({ targets: [android] }),
      ],
      () => apnsAnswer(200),
      { configuration, liveTokens: () => Promise.reject(new Error('Hyperdrive unavailable')) },
    );

    expect(outcome.requests).toEqual([]);
    expect(outcome.lines.filter((line) => line.event === 'push_liveness_failed')).toMatchObject([
      { level: 'error', jobs: 3, targets: 3, delay_seconds: LIVENESS_RETRY_DELAY_SECONDS },
    ]);
    const unsentRetry = {
      outcome: 'retry',
      reason: 'liveness_unavailable',
      requested: false,
      attempt: 0,
      retryDelaySeconds: 60,
    };
    expect(outcome.outcomes[0]?.results).toMatchObject([unsentRetry, unsentRetry]);
    // Its retry would land past its window: dropped now.
    expect(outcome.outcomes[1]?.results[0]).toMatchObject({
      outcome: 'expired',
      reason: 'liveness_unavailable',
      requested: false,
      attempt: 0,
    });
    // A hold needs no answer from the read: decided as before.
    expect(outcome.outcomes[2]?.results[0]).toMatchObject({
      outcome: 'not_configured',
      reason: 'not_configured',
    });
    expect(
      outcome.requeued.map((entry) => [
        entry.delaySeconds,
        PushJobV1.parse(entry.body).targets.map((t) => [t.pushTokenId, t.attempt]),
      ]),
    ).toEqual([
      [
        60,
        [
          [first.pushTokenId, 0],
          [second.pushTokenId, 0],
        ],
      ],
      [NOT_CONFIGURED_HOLD_SECONDS, [[android.pushTokenId, 0]]],
    ]);
    expect(outcome.result.explicitAcks).toEqual(['job-0', 'job-1', 'job-2']);
  });
});

describe("a job's follow-ups (review ruling R2)", () => {
  it('sends its delay groups in one sendBatch, each entry with its own delay', async () => {
    const slow = target({ token: hex(31) });
    const down = target({ token: hex(32) });

    const outcome = await run(
      [inOneHour({ expiresAt: new Date(NOW + 2 * HOUR).toISOString(), targets: [slow, down] })],
      byToken({
        [hex(31)]: () => apnsAnswer(429, { reason: 'TooManyRequests' }),
        [hex(32)]: () => apnsAnswer(503, { reason: 'ServiceUnavailable' }),
      }),
    );

    expect(outcome.requeueCalls).toEqual([{ method: 'sendBatch', messages: 2 }]);
    expect(
      outcome.requeued
        .map((entry) => [entry.delaySeconds, PushJobV1.parse(entry.body).targets[0]?.pushTokenId])
        .sort((a, b) => Number(a[0]) - Number(b[0])),
    ).toEqual([
      [60, slow.pushTokenId],
      [900, down.pushTokenId],
    ]);
  });

  it('retries the message whole when the sendBatch throws, and sends nothing on its own', async () => {
    const outcome = await run(
      [
        inOneHour({
          expiresAt: new Date(NOW + 2 * HOUR).toISOString(),
          targets: [target({ token: hex(33) }), target({ token: hex(34) })],
        }),
      ],
      byToken({
        [hex(33)]: () => apnsAnswer(429, { reason: 'TooManyRequests' }),
        [hex(34)]: () => apnsAnswer(503, { reason: 'ServiceUnavailable' }),
      }),
      { failRequeue: true },
    );

    expect(outcome.requeueCalls).toEqual([{ method: 'sendBatch', messages: 2 }]);
    expect(outcome.requeued).toEqual([]);
    expect(outcome.result.retryMessages.map((message) => message.msgId)).toEqual(['job-0']);
    expect(outcome.result.explicitAcks).toEqual([]);
    expect(outcome.outcomes).toEqual([]);
    expect(outcome.lines.find((line) => line.event === 'push_requeue_failed')).toMatchObject({
      level: 'error',
      follow_ups: 2,
    });
  });
});

describe('a production platform without usable credentials (review ruling R3)', () => {
  const MALFORMED_KEY = 'not-a-key-R3-sentinel';
  const malformed = (environment: string) =>
    ({ ...testEnv, ENVIRONMENT: environment, APNS_KEY_P8: MALFORMED_KEY }) as Env;
  const jobs = () =>
    [51, 52, 53].map((label) =>
      inOneHour({ targets: [target({ token: hex(label) }), fcmTarget()] }),
    );
  const fcmSent = () => Response.json({ name: 'projects/planeahead-test/messages/1' });

  it('raises one ops alert, with one error line, for a batch of several jobs in production', async () => {
    const alerts: { message: string; tags: Record<string, string> }[] = [];
    const outcome = await run(jobs(), fcmSent, {
      env: malformed('production'),
      capture: (message, context) => {
        alerts.push({ message, tags: context.tags });
      },
    });

    const errors = outcome.lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      event: 'push_not_configured',
      ops_alert: 'push_not_configured',
      platform: 'apns',
      reason: 'APNS_KEY_P8 is not a PKCS8 PEM',
    });
    expect(alerts).toEqual([
      {
        message: 'push_not_configured',
        tags: {
          ops_alert: 'push_not_configured',
          platform: 'apns',
          reason: 'APNS_KEY_P8 is not a PKCS8 PEM',
        },
      },
    ]);
    expect(JSON.stringify(outcome.lines)).not.toContain(MALFORMED_KEY);
    // Still held as before, and the configured platform still sends.
    const results = outcome.outcomes.flatMap((message) => message.results);
    expect(results.filter((result) => result.outcome === 'not_configured')).toHaveLength(3);
    expect(results.filter((result) => result.outcome === 'sent')).toHaveLength(3);
  });

  it('holds quietly in staging: no error line and no alert', async () => {
    const alerts: string[] = [];
    const outcome = await run(jobs(), fcmSent, {
      env: malformed('staging'),
      capture: (message) => {
        alerts.push(message);
      },
    });

    expect(outcome.lines.filter((line) => line.level === 'error')).toEqual([]);
    expect(alerts).toEqual([]);
    expect(
      outcome.outcomes
        .flatMap((message) => message.results)
        .filter((result) => result.outcome === 'not_configured'),
    ).toHaveLength(3);
  });
});

/**
 * A `notifications` row of `userId` about `flightInstanceId`, created `agoMs` before now; with
 * `producedAt`, its `data` keeps the intent's production instant as notify writes it.
 */
async function plantNotification(
  userId: string,
  flightInstanceId: string,
  kind: string,
  agoMs: number,
  isTest = false,
  producedAt?: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const data = producedAt === undefined ? null : JSON.stringify({ v: 1, producedAt });
  await db().execute(sql`
    insert into notifications
      (id, user_id, flight_instance_id, kind, dedupe_key, title, body, is_test, data, created_at)
    values (${id}::uuid, ${userId}::uuid, ${flightInstanceId}::uuid, ${kind}, ${`q16:${id}`},
            'AA100', 'Gate B12', ${isTest}, ${data}::jsonb,
            now() - ${agoMs} * interval '1 millisecond')
  `);
  return id;
}

describe('a target superseded by a newer notification (increment 15 ruling Q16)', () => {
  it('drops a superseded target unsent and sends the newest row; a test push or a test row never supersedes', async () => {
    const session = await signInAnonymously();
    const token = await registeredToken(session, uniqueInstallId('q16'));
    const flight = crypto.randomUUID();
    const first = await plantNotification(session.userId, flight, 'gate_change', 60_000);
    const correction = await plantNotification(session.userId, flight, 'gate_change', 30_000);
    // Another kind, and another flight: neither is superseded by the gate correction.
    const delay = await plantNotification(session.userId, flight, 'delay', 90_000);
    const elsewhere = await plantNotification(
      session.userId,
      crypto.randomUUID(),
      'gate_change',
      90_000,
    );
    // A real cancellation, then an injected test one: the test row supersedes nothing.
    const real = await plantNotification(session.userId, flight, 'cancellation', 60_000);
    await plantNotification(session.userId, flight, 'cancellation', 30_000, true);
    const jobFor = (notificationId: string | undefined): PushJobV1Input => {
      const base = target({
        pushTokenId: token.pushTokenId,
        subjectId: token.userId,
        token: token.token,
      });
      if (notificationId !== undefined) {
        return inOneHour({ targets: [{ ...base, notificationId }] });
      }
      // The admin page's test push: a test job whose target names no notification.
      delete base.notificationId;
      return inOneHour({ test: true, targets: [base] });
    };
    const ids = [first, correction, delay, elsewhere, real, undefined];

    const outcome = await run(
      ids.map((id) => jobFor(id)),
      () => apnsAnswer(200),
      { liveTokens: 'database' },
    );

    const results = outcome.outcomes.map((message) => message.results[0]);
    expect(results.map((result) => [result?.outcome, result?.reason])).toEqual([
      ['failed', 'superseded'],
      ['sent', null],
      ['sent', null],
      ['sent', null],
      ['sent', null],
      ['sent', null],
    ]);
    expect(results[0]).toMatchObject({ requested: false, attempt: 0, notificationId: first });
    expect(outcome.requests).toHaveLength(5);
  });

  it('orders by the intent producedAt: an older intent inserted after a newer one never supersedes it', async () => {
    const session = await signInAnonymously();
    const token = await registeredToken(session, uniqueInstallId('q16-order'));
    const flight = crypto.randomUUID();
    // The newer intent (11:55) reached notify first; the older one (11:40) waited out an outage
    // in notify's retries and was inserted 30 s later.
    const newer = await plantNotification(
      session.userId,
      flight,
      'gate_change',
      60_000,
      false,
      '2026-10-02T11:55:00.000Z',
    );
    const older = await plantNotification(
      session.userId,
      flight,
      'gate_change',
      30_000,
      false,
      '2026-10-02T11:40:00.000Z',
    );
    const jobFor = (notificationId: string): PushJobV1Input => {
      const base = target({
        pushTokenId: token.pushTokenId,
        subjectId: token.userId,
        token: token.token,
      });
      return inOneHour({ targets: [{ ...base, notificationId }] });
    };

    const outcome = await run([jobFor(newer), jobFor(older)], () => apnsAnswer(200), {
      liveTokens: 'database',
    });

    const results = outcome.outcomes.map((message) => message.results[0]);
    expect(
      results.map((result) => [result?.notificationId, result?.outcome, result?.reason]),
    ).toEqual([
      [newer, 'sent', null],
      [older, 'failed', 'superseded'],
    ]);
    expect(outcome.requests).toHaveLength(1);
  });
});
