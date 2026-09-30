/**
 * The `push` queue consumer (increment 14, ruling P4), in the Workers pool with an injected
 * `fetch` and credential source behind the real transports: at most six requests in flight, the
 * retry delays per reason, drops past `expiresAt`, per-target acknowledgement (the job is
 * acknowledged, only retryable targets come back, each with its own delay and attempt count),
 * the hold of an unconfigured platform, and the outcome message it sends to `persist`.
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import {
  PushJobV1,
  PushOutcomeMessageV1,
  type PushJobV1Input,
  type PushTargetResultV1,
} from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import { createLogger, type LogLine } from '../../src/observability/log';
import { pushConfiguration, type PushConfiguration } from '../../src/push/config';
import { NOT_CONFIGURED_HOLD_SECONDS } from '../../src/push/transport';
import {
  MAX_QUEUE_DELAY_SECONDS,
  PUSH_MAX_IN_FLIGHT,
  PUSH_REQUEUE_FAILURE_DELAY_SECONDS,
  handlePushBatch,
  mapWithConcurrency,
  type PushConsumerDeps,
} from '../../src/queues/push';
import {
  FCM_ERROR_TYPE,
  apnsAnswer,
  capturingQueue,
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

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const HOUR = 3_600_000;

interface Run {
  readonly requests: RecordedRequest[];
  readonly maxInFlight: number;
  readonly requeued: CapturingQueue['sent'];
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
  } = {},
): Promise<Run> {
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
  const deps: PushConsumerDeps = {
    fetch: fake.fetch,
    credentials: fakeCredentials(),
    now: () => options.now ?? NOW,
    pushQueue: push.queue,
    persistQueue: persist.queue,
    configuration: options.configuration ?? pushConfiguration(testEnv),
  };
  await handlePushBatch(
    batch,
    { env: testEnv, ctx, log: createLogger({}, (line) => lines.push(line)) },
    deps,
  );
  return {
    requests: fake.requests,
    maxInFlight: fake.maxInFlight,
    requeued: push.sent,
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
