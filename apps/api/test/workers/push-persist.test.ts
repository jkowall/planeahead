/**
 * The `push_outcome` message on the `persist` queue (increment 14, ruling P5), against the real
 * database: one delivery row per notification and token, a redelivered outcome a no-op (not even a
 * new row version), the newest attempt winning whatever the arrival order, the test marker, and
 * every dead-token rule: APNs 410 only when the token was registered at or before Apple's
 * timestamp, BadDeviceToken and DeviceTokenNotForTopic always, FCM UNREGISTERED and
 * SENDER_ID_MISMATCH always, INVALID_ARGUMENT only with an FcmError detail, and never an answer
 * about a topic or environment the row does not have.
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import type { PushOutcomeMessageV1, PushTargetResultV1 } from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import { createLogger, type LogLine } from '../../src/observability/log';
import { handlePersistBatch } from '../../src/queues/persist';
import { invalidationRule } from '../../src/queues/push-outcomes';
import { registerDevice, signInAnonymously, testEnv, uniqueInstallId } from './helpers/auth';
import { db as fileDb } from './helpers/routes';

/** One client for the file (the helper's), like every other Postgres-backed file. */
const db = fileDb();

const HOUR = 3_600_000;
const REGISTERED_AT = Date.UTC(2026, 9, 1, 12, 0, 0);

interface Registered {
  readonly pushTokenId: string;
  readonly userId: string;
  readonly kind: 'apns' | 'fcm';
  readonly appId: string;
  readonly environment: 'sandbox' | 'production';
}

async function registered(
  kind: 'apns' | 'fcm' = 'apns',
  appId = 'app.planeahead.mobile.dev',
): Promise<Registered> {
  const session = await signInAnonymously();
  const response = await registerDevice(session, uniqueInstallId('persist-push'), {
    pushTokenKind: kind,
    pushToken: `${kind}${crypto.randomUUID().replaceAll('-', '')}`,
    ...(kind === 'apns' ? { pushEnvironment: 'sandbox' } : {}),
    appId,
  });
  const body = await response.json<{ pushToken: { id: string } }>();
  await db.execute(sql`
    update push_tokens set registered_at = ${new Date(REGISTERED_AT).toISOString()}::timestamptz
    where id = ${body.pushToken.id}::uuid
  `);
  return {
    pushTokenId: body.pushToken.id,
    userId: session.userId,
    kind,
    appId,
    environment: kind === 'apns' ? 'sandbox' : 'production',
  };
}

function result(
  token: Registered,
  overrides: Partial<PushTargetResultV1> = {},
): PushTargetResultV1 {
  return {
    pushTokenId: token.pushTokenId,
    subjectId: token.userId,
    kind: token.kind,
    environment: token.environment,
    appId: token.appId,
    notificationId: crypto.randomUUID(),
    attempt: 1,
    requested: true,
    outcome: 'sent',
    reason: null,
    httpStatus: 200,
    providerId: crypto.randomUUID(),
    apnsTimestampMs: null,
    fcmErrorDetail: null,
    retryDelaySeconds: null,
    at: '2026-10-02T12:00:00.000Z',
    ...overrides,
  };
}

function outcome(
  results: readonly PushTargetResultV1[],
  overrides: Partial<PushOutcomeMessageV1> = {},
): PushOutcomeMessageV1 {
  return {
    pushVersion: 1,
    kind: 'push_outcome',
    jobId: crypto.randomUUID(),
    test: false,
    results: [...results],
    ...overrides,
  };
}

async function persist(...bodies: unknown[]): Promise<{
  result: Awaited<ReturnType<typeof getQueueResult>>;
  lines: LogLine[];
}> {
  const lines: LogLine[] = [];
  const batch = createMessageBatch(
    'planeahead-persist-local',
    bodies.map((body, index) => ({
      id: `outcome-${String(index)}-${crypto.randomUUID()}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  await handlePersistBatch(
    batch,
    { env: testEnv, ctx, log: createLogger({}, (line) => lines.push(line)) },
    { db },
  );
  return { result: await getQueueResult(batch, ctx), lines };
}

interface DeliveryRow extends Record<string, unknown> {
  readonly status: string;
  readonly attempts: number;
  readonly provider_message_id: string | null;
  readonly error: string | null;
  readonly sent_at: string | null;
  readonly is_test: boolean;
  readonly attempt_log: Record<string, { r: string | null; s: number | null }>;
  readonly subject_id: string;
  readonly channel: string;
  readonly version: string;
}

async function deliveries(notificationId: string): Promise<DeliveryRow[]> {
  return db.execute<DeliveryRow>(sql`
    select status, attempts::int as attempts, provider_message_id, error, sent_at::text as sent_at,
           is_test, attempt_log, subject_id::text as subject_id, channel, xmin::text as version
    from notification_deliveries where notification_id = ${notificationId}::uuid
  `);
}

async function tokenState(pushTokenId: string) {
  const [row] = await db.execute<{
    invalidated_at: string | null;
    last_used_at: string | null;
  }>(sql`
    select invalidated_at::text as invalidated_at, last_used_at::text as last_used_at
    from push_tokens where id = ${pushTokenId}::uuid
  `);
  return row;
}

describe('delivery rows', () => {
  it('writes one row per notification and token, and a redelivery changes nothing', async () => {
    const token = await registered();
    const sent = result(token);
    const message = outcome([sent]);

    await persist(message);
    const [first] = await deliveries(sent.notificationId ?? '');
    await persist(message, message);
    const rows = await deliveries(sent.notificationId ?? '');

    expect(rows).toHaveLength(1);
    expect(first).toMatchObject({
      status: 'sent',
      attempts: 1,
      provider_message_id: sent.providerId,
      error: null,
      sent_at: '2026-10-02 12:00:00+00',
      is_test: false,
      subject_id: token.userId,
      channel: 'apns',
      attempt_log: { '1:sent': { r: null, s: 200 } },
    });
    // Not even a new row version: the upsert's WHERE found nothing to change.
    expect(rows[0]?.version).toBe(first?.version);
  });

  it('follows the newest attempt whatever the order, keeps every attempt, and never undoes sent', async () => {
    const token = await registered();
    const notificationId = crypto.randomUUID();
    const retry = result(token, {
      notificationId,
      outcome: 'retry',
      reason: 'TooManyRequests',
      httpStatus: 429,
      providerId: null,
      retryDelaySeconds: 60,
    });
    const sent = result(token, { notificationId, attempt: 2, at: '2026-10-02T12:01:00.000Z' });

    await persist(outcome([retry]));
    expect((await deliveries(notificationId))[0]).toMatchObject({
      status: 'queued',
      error: 'TooManyRequests',
      attempts: 1,
    });
    await persist(outcome([sent]));
    // A late redelivery of attempt 1, and a duplicate later attempt that failed.
    await persist(outcome([retry]));
    await persist(
      outcome([
        result(token, {
          notificationId,
          attempt: 3,
          outcome: 'failed',
          reason: 'BadTopic',
          providerId: null,
          httpStatus: 400,
        }),
      ]),
    );

    const [row] = await deliveries(notificationId);
    expect(row).toMatchObject({
      status: 'sent',
      attempts: 3,
      provider_message_id: sent.providerId,
      error: null,
    });
    expect(Object.keys(row?.attempt_log ?? {}).sort()).toEqual(['1:retry', '2:sent', '3:failed']);
  });

  it('puts a final status in place of a queued one at the same attempt, not the other way round', async () => {
    const token = await registered();
    const notificationId = crypto.randomUUID();
    const held = result(token, {
      notificationId,
      attempt: 0,
      requested: false,
      outcome: 'not_configured',
      reason: 'not_configured',
      httpStatus: null,
      providerId: null,
    });
    const expired = { ...held, outcome: 'expired' as const, at: '2026-10-02T12:10:00.000Z' };

    await persist(outcome([held]));
    await persist(outcome([expired]));
    await persist(outcome([held]));

    expect((await deliveries(notificationId))[0]).toMatchObject({
      status: 'failed',
      error: 'not_configured',
      attempts: 0,
    });
  });

  it('records a test job under its job id with the test marker', async () => {
    const token = await registered();
    const jobId = crypto.randomUUID();
    const withoutNotification: PushTargetResultV1 = { ...result(token) };
    delete withoutNotification.notificationId;

    await persist(outcome([withoutNotification], { jobId, test: true }));

    expect(await deliveries(jobId)).toMatchObject([{ status: 'sent', is_test: true }]);
  });

  it('stamps last_used_at with the send, never moving it back', async () => {
    const token = await registered();

    await persist(outcome([result(token, { at: '2026-10-02T12:05:00.000Z' })]));
    await persist(outcome([result(token, { at: '2026-10-02T12:01:00.000Z' })]));

    expect((await tokenState(token.pushTokenId))?.last_used_at).toBe('2026-10-02 12:05:00+00');
  });

  it('acknowledges an outcome message it cannot read, and logs it without its body', async () => {
    const { result: queueResult, lines } = await persist({
      kind: 'push_outcome',
      jobId: crypto.randomUUID(),
      test: false,
      results: [{ pushTokenId: 'nope' }],
    });

    expect(queueResult.retryMessages).toEqual([]);
    expect(queueResult.explicitAcks).toHaveLength(1);
    expect(lines.find((line) => line.event === 'push_outcome_invalid')?.level).toBe('error');
  });
});

describe('dead tokens (ruling P5)', () => {
  const invalid = (token: Registered, overrides: Partial<PushTargetResultV1>) =>
    result(token, {
      outcome: 'invalid_token',
      providerId: null,
      httpStatus: 400,
      ...overrides,
    });

  async function invalidatedBy(
    make: (token: Registered) => PushTargetResultV1,
    kind: 'apns' | 'fcm' = 'apns',
  ): Promise<boolean> {
    const token = await registered(kind);
    await persist(outcome([make(token)]));
    return (await tokenState(token.pushTokenId))?.invalidated_at !== null;
  }

  it('invalidates on an APNs 410 only when the token was registered at or before Apple saw it die', async () => {
    const at = (offset: number) => REGISTERED_AT + offset;
    for (const reason of ['Unregistered', 'ExpiredToken']) {
      expect(
        await invalidatedBy((token) =>
          invalid(token, { reason, httpStatus: 410, apnsTimestampMs: at(HOUR) }),
        ),
        `${reason} after registration`,
      ).toBe(true);
      expect(
        await invalidatedBy((token) =>
          invalid(token, { reason, httpStatus: 410, apnsTimestampMs: at(0) }),
        ),
        `${reason} at registration`,
      ).toBe(true);
      expect(
        await invalidatedBy((token) =>
          invalid(token, { reason, httpStatus: 410, apnsTimestampMs: at(-HOUR) }),
        ),
        `${reason} before a newer registration`,
      ).toBe(false);
      expect(
        await invalidatedBy((token) => invalid(token, { reason, httpStatus: 410 })),
        `${reason} without a timestamp`,
      ).toBe(false);
    }
  });

  it('invalidates on BadDeviceToken and DeviceTokenNotForTopic always', async () => {
    for (const reason of ['BadDeviceToken', 'DeviceTokenNotForTopic']) {
      expect(await invalidatedBy((token) => invalid(token, { reason })), reason).toBe(true);
    }
  });

  it('never invalidates on an answer about another topic or environment than the row has', async () => {
    expect(
      await invalidatedBy((token) =>
        invalid(token, { reason: 'DeviceTokenNotForTopic', appId: 'app.planeahead.mobile' }),
      ),
    ).toBe(false);
    expect(
      await invalidatedBy((token) =>
        invalid(token, { reason: 'BadDeviceToken', environment: 'production' }),
      ),
    ).toBe(false);
  });

  it('invalidates on FCM UNREGISTERED and SENDER_ID_MISMATCH, and INVALID_ARGUMENT only with an FcmError', async () => {
    const fcm = (overrides: Partial<PushTargetResultV1>) => (token: Registered) =>
      invalid(token, { fcmErrorDetail: 'FcmError', ...overrides });
    expect(await invalidatedBy(fcm({ reason: 'UNREGISTERED', httpStatus: 404 }), 'fcm')).toBe(true);
    expect(await invalidatedBy(fcm({ reason: 'SENDER_ID_MISMATCH', httpStatus: 403 }), 'fcm')).toBe(
      true,
    );
    expect(await invalidatedBy(fcm({ reason: 'INVALID_ARGUMENT' }), 'fcm')).toBe(true);
    expect(
      await invalidatedBy(fcm({ reason: 'INVALID_ARGUMENT', fcmErrorDetail: 'BadRequest' }), 'fcm'),
    ).toBe(false);
    expect(
      await invalidatedBy(fcm({ reason: 'INVALID_ARGUMENT', fcmErrorDetail: null }), 'fcm'),
    ).toBe(false);
  });

  it('leaves a token alone for every other outcome, and invalidates once', async () => {
    expect(
      await invalidatedBy((token) =>
        result(token, { outcome: 'failed', reason: 'BadDeviceToken', providerId: null }),
      ),
    ).toBe(false);
    expect(
      await invalidatedBy((token) =>
        result(token, { outcome: 'retry', reason: 'TooManyRequests', providerId: null }),
      ),
    ).toBe(false);

    const token = await registered();
    const dead = invalid(token, { reason: 'BadDeviceToken' });
    await persist(outcome([dead]));
    const first = (await tokenState(token.pushTokenId))?.invalidated_at;
    await persist(outcome([{ ...dead, notificationId: crypto.randomUUID() }]));
    expect(first).not.toBeNull();
    expect((await tokenState(token.pushTokenId))?.invalidated_at).toBe(first);
  });

  it('decides with the rule table the header documents', () => {
    const base = result({
      pushTokenId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      kind: 'apns',
      appId: 'app.planeahead.mobile',
      environment: 'production',
    });
    const rule = (overrides: Partial<PushTargetResultV1>) =>
      invalidationRule({ ...base, outcome: 'invalid_token', ...overrides });
    expect(rule({ reason: 'Unregistered', apnsTimestampMs: 1 })).toBe('guarded');
    expect(rule({ reason: 'Unregistered', apnsTimestampMs: null })).toBe('none');
    expect(rule({ reason: 'BadDeviceToken' })).toBe('always');
    expect(rule({ reason: 'BadTopic' })).toBe('none');
    expect(rule({ kind: 'fcm', reason: 'UNREGISTERED' })).toBe('always');
    expect(rule({ kind: 'fcm', reason: 'INVALID_ARGUMENT', fcmErrorDetail: 'FcmError' })).toBe(
      'always',
    );
    expect(rule({ kind: 'fcm', reason: 'INVALID_ARGUMENT', fcmErrorDetail: 'BadRequest' })).toBe(
      'none',
    );
    expect(invalidationRule({ ...base, outcome: 'sent' })).toBe('none');
  });
});
