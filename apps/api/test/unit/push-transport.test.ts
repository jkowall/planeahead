/**
 * `PushTransport` with an injected `fetch` (increment 14, acceptance: request path and headers per
 * platform, payload under 4,096 bytes, collapse id under 64 bytes, every mapped APNs and FCM reason
 * to its outcome, the 410 timestamp carried through, the FCM `INVALID_ARGUMENT` detail rule; the
 * review round: FCM's exponential 429 backoff, ruling R10, and Apple's `apns-unique-id` kept from
 * a sandbox answer, ruling R11). Nothing here reaches a network: every request goes to the fake
 * `fetch`.
 */

import {
  COLLAPSE_ID_MAX_BYTES,
  NOTIFICATION_KINDS,
  PUSH_FLIGHT_KEY_MAX_LENGTH,
  PUSH_PAYLOAD_LIMIT_BYTES,
  PushDataV1,
  PushJobV1,
  pushCollapseId,
} from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import { PushCredentialError } from '../../src/push/credentials';
import {
  APNS_HOSTS,
  FCM_MAX_TTL_SECONDS,
  apnsPayload,
  buildApnsRequest,
  buildFcmRequest,
  fcmMessage,
} from '../../src/push/payload';
import {
  APNS_SERVER_ERROR_DELAY_SECONDS,
  APNS_THROTTLED_DELAY_SECONDS,
  APNS_TRANSIENT_DELAY_SECONDS,
  FCM_MAX_BACKOFF_SECONDS,
  FCM_MIN_RETRY_DELAY_SECONDS,
  NOT_CONFIGURED_HOLD_SECONDS,
  PUSH_REQUEST_TIMEOUT_MS,
  createApnsTransport,
  createFcmTransport,
  fcmBackoffSeconds,
  fcmQuotaBackoffSeconds,
  mapFcmResponse,
  retryAfterSeconds,
  type TransportOutcome,
} from '../../src/push/transport';
import {
  APNS_TOKEN,
  BAD_REQUEST_TYPE,
  FCM_ERROR_TYPE,
  FCM_TOKEN,
  apnsAnswer,
  fakeCredentials,
  fakeFetch,
  fcmError,
  fcmTarget,
  flightKey,
  job,
  target,
} from './helpers/push';

const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
const now = () => NOW;
const bytes = (text: string) => new TextEncoder().encode(text).length;

function apns(respond: Parameters<typeof fakeFetch>[0], credentials = fakeCredentials()) {
  const fake = fakeFetch(respond);
  return {
    fake,
    credentials,
    transport: createApnsTransport({ fetch: fake.fetch, credentials, now }),
  };
}

/** `random` is the 429 backoff's jitter source: 0 (no jitter) unless a test asks. */
function fcm(
  respond: Parameters<typeof fakeFetch>[0],
  credentials = fakeCredentials(),
  random: () => number = () => 0,
) {
  const fake = fakeFetch(respond);
  return {
    fake,
    credentials,
    transport: createFcmTransport({
      fetch: fake.fetch,
      credentials,
      now,
      projectId: 'planeahead-test',
      random,
    }),
  };
}

describe('APNs request (ruling P1)', () => {
  it('posts to /3/device/{token} on the host of the token environment, with the documented headers', async () => {
    const sandbox = job();
    const { fake, transport } = apns(() => apnsAnswer(200));

    await transport.send(sandbox, sandbox.targets[0]!);
    const production = job({
      targets: [target({ environment: 'production', appId: 'app.planeahead.mobile' })],
    });
    await transport.send(production, production.targets[0]!);

    const [first, second] = fake.requests;
    expect(first?.method).toBe('POST');
    expect(first?.url).toBe(`https://${APNS_HOSTS.sandbox}/3/device/${APNS_TOKEN}`);
    expect(APNS_HOSTS.sandbox).toBe('api.sandbox.push.apple.com');
    expect(second?.url).toBe(`https://api.push.apple.com/3/device/${APNS_TOKEN}`);
    expect(first?.headers).toEqual({
      authorization: 'bearer token-for-apns:sandbox',
      'apns-topic': 'app.planeahead.mobile.dev',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Date.UTC(2026, 9, 2, 14, 0, 0) / 1000),
      'apns-collapse-id': 'gate_change:AAL-100-2026-10-02-KJFK',
      'content-type': 'application/json',
    });
    expect(second?.headers['authorization']).toBe('bearer token-for-apns:production');
    expect(second?.headers['apns-topic']).toBe('app.planeahead.mobile');
    expect(first?.signal).toBeInstanceOf(AbortSignal);
  });

  it('puts app data in a top-level body dictionary beside aps, never as peers of aps', () => {
    const built = job({ timeSensitive: true, priority: 'normal' });
    const payload = apnsPayload(built, built.targets[0]!);

    expect(Object.keys(payload).sort()).toEqual(['aps', 'body']);
    expect(payload['aps']).toEqual({
      alert: { title: 'Gate change', body: 'AA100 now departs from B31' },
      sound: 'default',
      'thread-id': 'AAL-100-2026-10-02-KJFK',
      'interruption-level': 'time-sensitive',
    });
    const data = PushDataV1.parse(payload['body']);
    expect(data).toEqual({
      v: '1',
      kind: 'gate_change',
      flightSubscriptionId: built.targets[0]?.flightSubscriptionId,
    });
    expect(buildApnsRequest(built, built.targets[0]!).headers['apns-priority']).toBe('5');
    // Not time-sensitive unless the job says so (decision 6).
    const plain = job();
    expect(
      (apnsPayload(plain, plain.targets[0]!)['aps'] as Record<string, unknown>)[
        'interruption-level'
      ],
    ).toBe('active');
  });

  it('collapses a job without a flight on its job id and leaves out the thread', () => {
    const test = job({
      test: true,
      notificationKind: 'system',
      flightKey: undefined,
      targets: [target({ notificationId: undefined, flightSubscriptionId: undefined })],
    });
    const request = buildApnsRequest(test, test.targets[0]!);
    const payload = JSON.parse(request.body) as {
      aps: Record<string, unknown>;
      body: Record<string, unknown>;
    };

    expect(request.headers['apns-collapse-id']).toBe(`system:${test.jobId}`);
    expect(payload.aps['thread-id']).toBeUndefined();
    expect(payload.body).toEqual({ v: '1', kind: 'system' });
  });
});

describe('FCM request (ruling P1)', () => {
  it('posts messages:send with a bearer token, notification plus flat string data, and the Android options', async () => {
    const built = job({
      targets: [fcmTarget()],
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });
    const { fake, transport } = fcm(() =>
      Response.json({ name: 'projects/planeahead-test/messages/0:1' }),
    );

    const outcome = await transport.send(built, built.targets[0]!);

    expect(outcome).toEqual({
      outcome: 'sent',
      requested: true,
      providerId: 'projects/planeahead-test/messages/0:1',
      httpStatus: 200,
    });
    const request = fake.requests[0];
    expect(request?.url).toBe(
      'https://fcm.googleapis.com/v1/projects/planeahead-test/messages:send',
    );
    expect(request?.method).toBe('POST');
    expect(request?.headers['authorization']).toBe('Bearer token-for-fcm');
    expect(request?.headers['content-type']).toBe('application/json');
    const body = JSON.parse(request?.body ?? '{}') as { message: Record<string, unknown> };
    expect(body.message).toEqual({
      token: FCM_TOKEN,
      notification: { title: 'Gate change', body: 'AA100 now departs from B31' },
      data: {
        v: '1',
        kind: 'gate_change',
        flightSubscriptionId: built.targets[0]?.flightSubscriptionId,
        tag: 'gate_change:AAL-100-2026-10-02-KJFK',
        channelId: 'flight_gate',
      },
      android: {
        priority: 'high',
        ttl: '3600s',
        notification: { channel_id: 'flight_gate', tag: 'gate_change:AAL-100-2026-10-02-KJFK' },
      },
    });
    const data = body.message['data'] as Record<string, unknown>;
    expect(Object.values(data).every((value) => typeof value === 'string')).toBe(true);
    expect('body' in data).toBe(false);
  });

  it('runs the ttl to expiresAt, never below zero or past four weeks', () => {
    const late = job({ targets: [fcmTarget()], expiresAt: new Date(NOW - 5000).toISOString() });
    const far = job({
      targets: [fcmTarget()],
      expiresAt: new Date(NOW + 60 * 86_400_000).toISOString(),
    });
    const ttl = (built: PushJobV1) =>
      (fcmMessage(built, built.targets[0]!, NOW)['message'] as { android: { ttl: string } }).android
        .ttl;

    expect(ttl(late)).toBe('0s');
    expect(ttl(far)).toBe(`${String(FCM_MAX_TTL_SECONDS)}s`);
  });
});

describe('payload and collapse id bounds', () => {
  // Every character JSON-escapes to six bytes (`\u0001`), the worst the schema admits.
  const worst = job({
    notificationKind: 'schedule_change',
    flightKey: flightKey(
      `AAL-9999A-2026-12-31-KJFK-L${'9'.repeat(PUSH_FLIGHT_KEY_MAX_LENGTH - 27)}`,
    ),
    title: '\u0001'.repeat(100),
    body: '\u0001'.repeat(400),
    channelId: `c${'x'.repeat(39)}`,
    timeSensitive: true,
  });

  it('keeps the worst-case payload under 4,096 bytes on both platforms', () => {
    const apnsRequest = buildApnsRequest(worst, worst.targets[0]!);
    const fcmRequest = buildFcmRequest(
      worst,
      PushJobV1.parse({ ...worst, targets: [fcmTarget()] }).targets[0]!,
      'planeahead-test',
      NOW,
    );

    expect(apnsRequest.payloadBytes).toBe(bytes(apnsRequest.body));
    expect(apnsRequest.payloadBytes).toBeLessThan(PUSH_PAYLOAD_LIMIT_BYTES);
    expect(fcmRequest.payloadBytes).toBeLessThan(PUSH_PAYLOAD_LIMIT_BYTES);
    // The whole FCM request body too, with a real-length registration token.
    expect(bytes(fcmRequest.body)).toBeLessThan(PUSH_PAYLOAD_LIMIT_BYTES);
    expect(apnsRequest.payloadBytes).toBeGreaterThan(3000);
  });

  it('keeps every collapse id at or under 64 bytes, for every kind and the longest flight key', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const id = pushCollapseId({ ...worst, notificationKind: kind });
      expect(bytes(id), kind).toBeLessThanOrEqual(COLLAPSE_ID_MAX_BYTES);
      expect(id).toBe(`${kind}:${worst.flightKey ?? ''}`);
    }
    expect(buildApnsRequest(worst, worst.targets[0]!).headers['apns-collapse-id']).toBe(
      pushCollapseId(worst),
    );
  });

  it('refuses a payload over the limit without sending it', async () => {
    // Past the schema's bounds, as a job built by hand could be.
    const oversize = { ...worst, body: '\u0001'.repeat(700) } as PushJobV1;
    const apnsSide = apns(() => apnsAnswer(200));
    const fcmSide = fcm(() => Response.json({ name: 'x' }));

    expect(await apnsSide.transport.send(oversize, oversize.targets[0]!)).toMatchObject({
      outcome: 'failed',
      requested: false,
      reason: 'PayloadTooLarge',
    });
    expect(
      await fcmSide.transport.send(
        oversize,
        PushJobV1.parse({ ...worst, targets: [fcmTarget()] }).targets[0]!,
      ),
    ).toMatchObject({ outcome: 'failed', requested: false, reason: 'PayloadTooLarge' });
    expect(apnsSide.fake.requests).toHaveLength(0);
    expect(fcmSide.fake.requests).toHaveLength(0);
  });
});

describe('APNs responses: every mapped reason to its outcome', () => {
  const timestamp = Date.UTC(2026, 9, 1, 9, 30, 0);
  const cases: readonly [number, string, Partial<TransportOutcome>][] = [
    [410, 'Unregistered', { outcome: 'invalid_token', apnsTimestampMs: timestamp }],
    [410, 'ExpiredToken', { outcome: 'invalid_token', apnsTimestampMs: timestamp }],
    [400, 'BadDeviceToken', { outcome: 'invalid_token', apnsTimestampMs: null }],
    [400, 'DeviceTokenNotForTopic', { outcome: 'invalid_token', apnsTimestampMs: null }],
    [429, 'TooManyRequests', { outcome: 'retry', delaySeconds: APNS_THROTTLED_DELAY_SECONDS }],
    [429, 'TooManyProviderTokenUpdates', { outcome: 'retry', delaySeconds: 60 }],
    [
      500,
      'InternalServerError',
      { outcome: 'retry', delaySeconds: APNS_SERVER_ERROR_DELAY_SECONDS },
    ],
    [503, 'ServiceUnavailable', { outcome: 'retry', delaySeconds: 900 }],
    [503, 'Shutdown', { outcome: 'retry', delaySeconds: 900 }],
    [502, 'SomethingNew', { outcome: 'retry', delaySeconds: 900 }],
    [400, 'IdleTimeout', { outcome: 'retry', delaySeconds: APNS_TRANSIENT_DELAY_SECONDS }],
    [403, 'UnrelatedKeyIdInToken', { outcome: 'retry', delaySeconds: 60 }],
    [400, 'BadCollapseId', { outcome: 'failed' }],
    [400, 'BadExpirationDate', { outcome: 'failed' }],
    [400, 'BadMessageId', { outcome: 'failed' }],
    [400, 'BadPriority', { outcome: 'failed' }],
    [400, 'BadTopic', { outcome: 'failed' }],
    [400, 'DuplicateHeaders', { outcome: 'failed' }],
    [400, 'InvalidPushType', { outcome: 'failed' }],
    [400, 'MissingDeviceToken', { outcome: 'failed' }],
    [400, 'MissingTopic', { outcome: 'failed' }],
    [400, 'PayloadEmpty', { outcome: 'failed' }],
    [400, 'TopicDisallowed', { outcome: 'failed' }],
    [403, 'BadEnvironmentKeyIdInToken', { outcome: 'failed' }],
    [403, 'Forbidden', { outcome: 'failed' }],
    [403, 'InvalidProviderToken', { outcome: 'failed' }],
    [403, 'MissingProviderToken', { outcome: 'failed' }],
    [404, 'BadPath', { outcome: 'failed' }],
    [405, 'MethodNotAllowed', { outcome: 'failed' }],
    [413, 'PayloadTooLarge', { outcome: 'failed' }],
  ];

  it.each(cases)('%i %s', async (status, reason, expected) => {
    const built = job();
    const { transport, credentials } = apns(() =>
      apnsAnswer(status, { reason, ...(status === 410 ? { timestamp } : {}) }),
    );

    const outcome = await transport.send(built, built.targets[0]!);

    expect(outcome).toMatchObject({ ...expected, reason, httpStatus: status, requested: true });
    // Only ExpiredProviderToken asks PushAuth for a new token; a 429 never does.
    expect(credentials.expired).toEqual([]);
  });

  it('answers sent with the apns-id', async () => {
    const built = job();
    const apnsId = crypto.randomUUID();
    const { transport } = apns(() => apnsAnswer(200, null, apnsId));

    expect(await transport.send(built, built.targets[0]!)).toEqual({
      outcome: 'sent',
      requested: true,
      providerId: apnsId,
      httpStatus: 200,
    });
  });

  it('carries no timestamp on a 410 that sent none', async () => {
    const built = job();
    const { transport } = apns(() => apnsAnswer(410, { reason: 'Unregistered' }));

    expect(await transport.send(built, built.targets[0]!)).toMatchObject({
      outcome: 'invalid_token',
      apnsTimestampMs: null,
    });
  });

  it('expires the provider token on ExpiredProviderToken and waits until PushAuth may mint', async () => {
    const built = job();
    const credentials = fakeCredentials({ remintAtMs: NOW + 5 * 60_000 });
    const { transport } = apns(
      () => apnsAnswer(403, { reason: 'ExpiredProviderToken' }),
      credentials,
    );

    const outcome = await transport.send(built, built.targets[0]!);

    expect(outcome).toMatchObject({
      outcome: 'retry',
      reason: 'ExpiredProviderToken',
      delaySeconds: 300,
    });
    expect(credentials.expired).toEqual([
      { name: 'apns:sandbox', token: 'token-for-apns:sandbox' },
    ]);
  });

  it('retries an answer without an apns-id as an edge error, and cancels its body', async () => {
    const built = job();
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const { transport } = apns(() => new Response(body, { status: 522 }));

    expect(await transport.send(built, built.targets[0]!)).toEqual({
      outcome: 'retry',
      requested: true,
      reason: 'edge_522',
      delaySeconds: APNS_TRANSIENT_DELAY_SECONDS,
      httpStatus: 522,
    });
    expect(cancelled).toBe(true);
  });

  it('cancels the body of a 200 it does not read', async () => {
    const built = job();
    let cancelled = false;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
    });
    const { transport } = apns(
      () => new Response(body, { status: 200, headers: { 'apns-id': 'id-1' } }),
    );

    await transport.send(built, built.targets[0]!);
    expect(cancelled).toBe(true);
  });

  it('keeps a reason that is not a plain identifier out of the outcome', async () => {
    const built = job();
    const { transport } = apns(() => apnsAnswer(400, { reason: '<b>odd reason</b>' }));

    expect(await transport.send(built, built.targets[0]!)).toMatchObject({
      outcome: 'failed',
      reason: 'http_400',
    });
  });

  it('refuses a token that is not hex without a request (BadDeviceToken, never sent)', async () => {
    const built = job({ targets: [target({ token: 'not-hex-at-all' })] });
    const { transport, fake } = apns(() => apnsAnswer(200));

    expect(await transport.send(built, built.targets[0]!)).toMatchObject({
      outcome: 'invalid_token',
      requested: false,
      reason: 'BadDeviceToken',
      httpStatus: null,
    });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('FCM responses: every mapped code to its outcome', () => {
  const fcmCase = (code: string) => [{ '@type': FCM_ERROR_TYPE, errorCode: code }];
  const cases: readonly [string, () => Response, Partial<TransportOutcome>][] = [
    [
      '404 UNREGISTERED',
      () => fcmError(404, 'NOT_FOUND', fcmCase('UNREGISTERED')),
      { outcome: 'invalid_token', reason: 'UNREGISTERED', fcmErrorDetail: 'FcmError' },
    ],
    [
      '403 SENDER_ID_MISMATCH',
      () => fcmError(403, 'PERMISSION_DENIED', fcmCase('SENDER_ID_MISMATCH')),
      { outcome: 'invalid_token', reason: 'SENDER_ID_MISMATCH' },
    ],
    [
      '400 INVALID_ARGUMENT with an FcmError',
      () => fcmError(400, 'INVALID_ARGUMENT', fcmCase('INVALID_ARGUMENT')),
      { outcome: 'invalid_token', reason: 'INVALID_ARGUMENT', fcmErrorDetail: 'FcmError' },
    ],
    [
      '400 INVALID_ARGUMENT with a BadRequest',
      () =>
        fcmError(400, 'INVALID_ARGUMENT', [
          { '@type': BAD_REQUEST_TYPE, fieldViolations: [{ field: 'message.android.ttl' }] },
        ]),
      { outcome: 'failed', reason: 'INVALID_ARGUMENT', fcmErrorDetail: 'BadRequest' },
    ],
    [
      '400 INVALID_ARGUMENT with both',
      () =>
        fcmError(400, 'INVALID_ARGUMENT', [
          ...fcmCase('INVALID_ARGUMENT'),
          { '@type': BAD_REQUEST_TYPE },
        ]),
      { outcome: 'failed', reason: 'INVALID_ARGUMENT' },
    ],
    [
      '400 INVALID_ARGUMENT without details',
      () => fcmError(400, 'INVALID_ARGUMENT'),
      { outcome: 'failed', reason: 'INVALID_ARGUMENT', fcmErrorDetail: null },
    ],
    [
      '429 QUOTA_EXCEEDED with Retry-After',
      () =>
        fcmError(429, 'RESOURCE_EXHAUSTED', fcmCase('QUOTA_EXCEEDED'), { 'retry-after': '120' }),
      { outcome: 'retry', reason: 'QUOTA_EXCEEDED', delaySeconds: 120 },
    ],
    [
      '429 QUOTA_EXCEEDED without Retry-After',
      () => fcmError(429, 'RESOURCE_EXHAUSTED', fcmCase('QUOTA_EXCEEDED')),
      { outcome: 'retry', delaySeconds: 60 },
    ],
    [
      '429 with a Retry-After under the floor',
      () => fcmError(429, 'RESOURCE_EXHAUSTED', fcmCase('QUOTA_EXCEEDED'), { 'retry-after': '2' }),
      { outcome: 'retry', delaySeconds: FCM_MIN_RETRY_DELAY_SECONDS },
    ],
    [
      '503 UNAVAILABLE with Retry-After',
      () => fcmError(503, 'UNAVAILABLE', fcmCase('UNAVAILABLE'), { 'retry-after': '30' }),
      { outcome: 'retry', reason: 'UNAVAILABLE', delaySeconds: 30 },
    ],
    [
      '503 UNAVAILABLE without Retry-After',
      () => fcmError(503, 'UNAVAILABLE', fcmCase('UNAVAILABLE')),
      { outcome: 'retry', delaySeconds: 10 },
    ],
    [
      '500 INTERNAL',
      () => fcmError(500, 'INTERNAL', fcmCase('INTERNAL')),
      { outcome: 'retry', reason: 'INTERNAL', delaySeconds: 10 },
    ],
    [
      '502 not JSON',
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      { outcome: 'retry', reason: 'http_502', delaySeconds: 10 },
    ],
    [
      '401 THIRD_PARTY_AUTH_ERROR',
      () => fcmError(401, 'UNAUTHENTICATED', fcmCase('THIRD_PARTY_AUTH_ERROR')),
      { outcome: 'failed', reason: 'THIRD_PARTY_AUTH_ERROR' },
    ],
    [
      '403 PERMISSION_DENIED without an FcmError',
      () => fcmError(403, 'PERMISSION_DENIED'),
      { outcome: 'failed', reason: 'PERMISSION_DENIED' },
    ],
    [
      '404 NOT_FOUND without an FcmError',
      () => fcmError(404, 'NOT_FOUND'),
      { outcome: 'failed', reason: 'NOT_FOUND' },
    ],
  ];

  it.each(cases)('%s', async (_label, respond, expected) => {
    const built = job({ targets: [fcmTarget()] });
    const { transport, credentials } = fcm(respond);

    expect(await transport.send(built, built.targets[0]!)).toMatchObject({
      ...expected,
      requested: true,
    });
    expect(credentials.expired).toEqual([]);
  });

  it('never retries sooner than 10 s and backs off on repeated 5xx', async () => {
    const third = job({ targets: [fcmTarget({ attempt: 2 })] });
    const { transport } = fcm(() => fcmError(503, 'UNAVAILABLE', fcmCase('UNAVAILABLE')));

    expect(await transport.send(third, third.targets[0]!)).toMatchObject({ delaySeconds: 40 });
    expect(fcmBackoffSeconds(0)).toBe(10);
    expect(fcmBackoffSeconds(1)).toBe(20);
    expect(fcmBackoffSeconds(50)).toBe(900);
  });

  it('expires the access token on 401 UNAUTHENTICATED and retries', async () => {
    const built = job({ targets: [fcmTarget()] });
    const credentials = fakeCredentials({ remintAtMs: NOW });
    const { transport } = fcm(() => fcmError(401, 'UNAUTHENTICATED'), credentials);

    expect(await transport.send(built, built.targets[0]!)).toMatchObject({
      outcome: 'retry',
      reason: 'UNAUTHENTICATED',
      delaySeconds: FCM_MIN_RETRY_DELAY_SECONDS,
    });
    expect(credentials.expired).toEqual([{ name: 'fcm', token: 'token-for-fcm' }]);
  });

  it('reads Retry-After as seconds or as an HTTP date', () => {
    expect(retryAfterSeconds(null, NOW)).toBeNull();
    expect(retryAfterSeconds('45', NOW)).toBe(45);
    expect(retryAfterSeconds(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90);
    expect(retryAfterSeconds(new Date(NOW - 90_000).toUTCString(), NOW)).toBe(0);
    expect(retryAfterSeconds('soon', NOW)).toBeNull();
  });
});

describe('failures without an answer', () => {
  it('retries a request that timed out, with the 10-second timeout by default', async () => {
    expect(PUSH_REQUEST_TIMEOUT_MS).toBe(10_000);
    const built = job();
    const fake = fakeFetch(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => {
            const reason: unknown = request.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('aborted'));
          });
        }),
    );
    const transport = createApnsTransport({
      fetch: fake.fetch,
      credentials: fakeCredentials(),
      now,
      timeoutMs: 25,
    });

    expect(await transport.send(built, built.targets[0]!)).toEqual({
      outcome: 'retry',
      requested: true,
      reason: 'timeout',
      delaySeconds: APNS_TRANSIENT_DELAY_SECONDS,
      httpStatus: null,
    });
  });

  it('retries a network failure on both platforms', async () => {
    const built = job();
    const android = job({ targets: [fcmTarget()] });
    const failing = () => Promise.reject(new TypeError('network connection lost'));

    expect(await apns(failing).transport.send(built, built.targets[0]!)).toMatchObject({
      outcome: 'retry',
      reason: 'network_error',
    });
    expect(await fcm(failing).transport.send(android, android.targets[0]!)).toMatchObject({
      outcome: 'retry',
      reason: 'network_error',
      delaySeconds: FCM_MIN_RETRY_DELAY_SECONDS,
    });
  });

  it('maps a missing credential without sending: rejected fails, unavailable and unconfigured retry', async () => {
    const built = job();
    const send = async (error: Error) => {
      const { transport, fake } = apns(() => apnsAnswer(200), fakeCredentials({ fail: error }));
      const outcome = await transport.send(built, built.targets[0]!);
      expect(fake.requests).toHaveLength(0);
      return outcome;
    };

    expect(await send(new PushCredentialError('credentials_rejected', false))).toMatchObject({
      outcome: 'failed',
      requested: false,
      reason: 'credentials_rejected',
    });
    expect(await send(new PushCredentialError('exchange_unavailable', true))).toMatchObject({
      outcome: 'retry',
      requested: false,
      reason: 'exchange_unavailable',
      delaySeconds: 60,
    });
    expect(await send(new PushCredentialError('not_configured', false))).toMatchObject({
      outcome: 'retry',
      requested: false,
      reason: 'not_configured',
      delaySeconds: NOT_CONFIGURED_HOLD_SECONDS,
    });
  });
});

describe('FCM 429 without Retry-After: exponential backoff (review ruling R10)', () => {
  const quota = () =>
    fcmError(429, 'RESOURCE_EXHAUSTED', [{ '@type': FCM_ERROR_TYPE, errorCode: 'QUOTA_EXCEEDED' }]);

  /** The delay a quota refusal earns a target with `sendsBefore` sends, jitter `r`. */
  async function delayAfter(
    sendsBefore: number,
    r: number,
    respond: () => Response = quota,
  ): Promise<number | null> {
    const built = job({ targets: [fcmTarget({ attempt: sendsBefore })] });
    const outcome = await fcm(respond, fakeCredentials(), () => r).transport.send(
      built,
      built.targets[0]!,
    );
    expect(outcome).toMatchObject({ outcome: 'retry', requested: true, httpStatus: 429 });
    return outcome.outcome === 'retry' ? outcome.delaySeconds : null;
  }

  it('n = 0: starts at the one-minute minimum and adds up to 20 percent, never less', async () => {
    expect(await delayAfter(0, 0)).toBe(60);
    expect(await delayAfter(0, 0.5)).toBe(66);
    expect(await delayAfter(0, 0.9999)).toBe(72);
  });

  it('n = 1: doubles', async () => {
    expect(await delayAfter(1, 0)).toBe(120);
    expect(await delayAfter(1, 0.5)).toBe(132);
  });

  it('n = 4: 60 * 16 is past the cap, so 15 minutes whatever the jitter', async () => {
    expect(await delayAfter(4, 0)).toBe(FCM_MAX_BACKOFF_SECONDS);
    expect(await delayAfter(4, 0.9999)).toBe(900);
    // One step short of it, the jitter still shows.
    expect(await delayAfter(3, 0)).toBe(480);
    expect(await delayAfter(3, 0.99)).toBe(575);
  });

  it('the cap: any number of sends, and a jitter source out of range, stay at 15 minutes', () => {
    expect(fcmQuotaBackoffSeconds(50, () => 0.5)).toBe(FCM_MAX_BACKOFF_SECONDS);
    expect(fcmQuotaBackoffSeconds(1000, () => 1)).toBe(900);
    expect(fcmQuotaBackoffSeconds(0, () => 7)).toBe(72);
    expect(fcmQuotaBackoffSeconds(0, () => -1)).toBe(60);
    expect(fcmQuotaBackoffSeconds(-3, () => 0)).toBe(60);
  });

  it('with Retry-After, keeps it (at least 10 s) whatever n; the consumer caps it at the queue maximum', async () => {
    const after = (value: string) => () =>
      fcmError(
        429,
        'RESOURCE_EXHAUSTED',
        [{ '@type': FCM_ERROR_TYPE, errorCode: 'QUOTA_EXCEEDED' }],
        { 'retry-after': value },
      );
    expect(await delayAfter(4, 0.5, after('120'))).toBe(120);
    expect(await delayAfter(0, 0.5, after('2'))).toBe(FCM_MIN_RETRY_DELAY_SECONDS);
    expect(await delayAfter(0, 0.5, after(String(30 * 3600)))).toBe(30 * 3600);
    expect(mapFcmResponse(429, null, 45, 9, () => 0.5)).toMatchObject({ delaySeconds: 45 });
  });

  it('leaves APNs TooManyRequests at 60 s on every attempt (Apple states no backoff)', async () => {
    const late = job({ targets: [target({ attempt: 4 })] });
    const { transport } = apns(() => apnsAnswer(429, { reason: 'TooManyRequests' }));

    expect(await transport.send(late, late.targets[0]!)).toMatchObject({
      outcome: 'retry',
      delaySeconds: APNS_THROTTLED_DELAY_SECONDS,
    });
  });
});

describe("Apple's apns-unique-id (review ruling R11)", () => {
  const uniqueId = crypto.randomUUID();
  const withUniqueId = (status: number, body: Record<string, unknown> | null = null) =>
    apnsAnswer(status, body, crypto.randomUUID(), { 'apns-unique-id': uniqueId });

  it('keeps it from a sandbox answer, sent or refused', async () => {
    const sandbox = job();
    const sent = await apns(() => withUniqueId(200)).transport.send(sandbox, sandbox.targets[0]!);
    const refused = await apns(() =>
      withUniqueId(400, { reason: 'BadDeviceToken' }),
    ).transport.send(sandbox, sandbox.targets[0]!);

    expect(sent).toMatchObject({ outcome: 'sent', apnsUniqueId: uniqueId });
    expect(refused).toMatchObject({ outcome: 'invalid_token', apnsUniqueId: uniqueId });
  });

  it('has none from a production answer, which carries none', async () => {
    const production = job({
      targets: [target({ environment: 'production', appId: 'app.planeahead.mobile' })],
    });
    const outcome = await apns(() => apnsAnswer(200)).transport.send(
      production,
      production.targets[0]!,
    );

    expect(outcome.outcome).toBe('sent');
    expect(outcome).not.toHaveProperty('apnsUniqueId');
  });

  it('reads it for the sandbox only, and never from an FCM answer', async () => {
    const production = job({
      targets: [target({ environment: 'production', appId: 'app.planeahead.mobile' })],
    });
    const android = job({ targets: [fcmTarget()] });

    const apnsOutcome = await apns(() => withUniqueId(200)).transport.send(
      production,
      production.targets[0]!,
    );
    const fcmOutcome = await fcm(
      () =>
        new Response(JSON.stringify({ name: 'projects/x/messages/1' }), {
          headers: { 'apns-unique-id': uniqueId },
        }),
    ).transport.send(android, android.targets[0]!);

    expect(apnsOutcome).not.toHaveProperty('apnsUniqueId');
    expect(fcmOutcome).not.toHaveProperty('apnsUniqueId');
  });
});
