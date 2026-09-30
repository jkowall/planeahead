import { describe, expect, it } from 'vitest';
import {
  APP_ID_RE,
  COLLAPSE_ID_MAX_BYTES,
  NOTIFICATION_KINDS,
  PUSH_FLIGHT_KEY_MAX_LENGTH,
  PUSH_JOB_MAX_TARGETS,
  PushCredentialExpireRequestV1,
  PushCredentialRequestV1,
  PushDataV1,
  PushJobV1,
  PushOutcomeMessageV1,
  PushTargetResultV1,
  SECRET_PATTERNS,
  findSecretPatterns,
  pushCollapseId,
  pushCredentialName,
  type FlightKey,
  type PushJobV1Input,
  type PushTargetV1Input,
} from '../src/index';
import * as push from '../src/push';

/**
 * The push contracts (increment 14): the job the `push` queue carries, the outcome message it
 * sends to `persist`, the app data, the collapse identifier and the `PushAuth` RPC payloads.
 */

function target(overrides: Partial<PushTargetV1Input> = {}): PushTargetV1Input {
  return {
    pushTokenId: crypto.randomUUID(),
    subjectId: crypto.randomUUID(),
    kind: 'apns',
    token: 'a'.repeat(64),
    environment: 'sandbox',
    appId: 'app.planeahead.mobile.dev',
    notificationId: crypto.randomUUID(),
    ...overrides,
  };
}

/** A flight key as a test spells it; the schema is what decides whether it is one. */
function key(value: string): FlightKey {
  return value as FlightKey;
}

function job(overrides: Partial<PushJobV1Input> = {}): PushJobV1Input {
  return {
    kind: 'push_job',
    jobId: crypto.randomUUID(),
    notificationKind: 'gate_change',
    flightKey: key('AAL-100-2026-10-02-KJFK'),
    title: 'Gate change',
    body: 'AA100 now departs from B31',
    channelId: 'flight_gate',
    expiresAt: '2026-10-02T14:00:00Z',
    targets: [target()],
    ...overrides,
  };
}

describe('PushJobV1', () => {
  it('parses a job and fills the defaults a producer may leave out', () => {
    const parsed = PushJobV1.parse(job());
    expect(parsed.pushVersion).toBe(1);
    expect(parsed.test).toBe(false);
    expect(parsed.priority).toBe('high');
    expect(parsed.timeSensitive).toBe(false);
    expect(parsed.targets[0]?.attempt).toBe(0);
  });

  it('keeps fields it does not know (a newer producer)', () => {
    const parsed = PushJobV1.parse({ ...job(), futureField: 1 });
    expect((parsed as Record<string, unknown>)['futureField']).toBe(1);
  });

  it('refuses a target without a notification id unless the job is a test', () => {
    const untargeted = target({ notificationId: undefined });
    expect(PushJobV1.safeParse(job({ targets: [untargeted] })).success).toBe(false);
    expect(PushJobV1.safeParse(job({ test: true, targets: [untargeted] })).success).toBe(true);
  });

  it('names each push token once and carries 1 to 50 targets', () => {
    const one = target();
    expect(PushJobV1.safeParse(job({ targets: [one, { ...one }] })).success).toBe(false);
    expect(PushJobV1.safeParse(job({ targets: [] })).success).toBe(false);
    const full = Array.from({ length: PUSH_JOB_MAX_TARGETS }, () => target());
    expect(PushJobV1.safeParse(job({ targets: full })).success).toBe(true);
    expect(PushJobV1.safeParse(job({ targets: [...full, target()] })).success).toBe(false);
  });

  it('bounds the text, the flight key, the channel and the app id', () => {
    expect(PushJobV1.safeParse(job({ title: 'x'.repeat(101) })).success).toBe(false);
    expect(PushJobV1.safeParse(job({ body: 'x'.repeat(401) })).success).toBe(false);
    expect(PushJobV1.safeParse(job({ title: '' })).success).toBe(false);
    expect(PushJobV1.safeParse(job({ channelId: 'Flight Gate' })).success).toBe(false);
    expect(PushJobV1.safeParse(job({ flightKey: key('AAL-100-2026-10-02-KJFK-L2') })).success).toBe(
      true,
    );
    const longest = `AAL-9999A-2026-12-31-KJFK-L${'9'.repeat(PUSH_FLIGHT_KEY_MAX_LENGTH - 27)}`;
    expect(longest).toHaveLength(PUSH_FLIGHT_KEY_MAX_LENGTH);
    expect(PushJobV1.safeParse(job({ flightKey: key(longest) })).success).toBe(true);
    expect(PushJobV1.safeParse(job({ flightKey: key(`${longest}9`) })).success).toBe(false);
    for (const appId of ['app', 'app.', '.app', 'app..x', 'app planeahead', 'app/../x']) {
      expect(PushJobV1.safeParse(job({ targets: [target({ appId })] })).success, appId).toBe(false);
    }
    expect(APP_ID_RE.test('app.planeahead.mobile')).toBe(true);
    expect(APP_ID_RE.test('com.example.my_app-2')).toBe(true);
  });

  it('accepts only the device-token kinds and both APNs environments', () => {
    expect(
      PushJobV1.safeParse(
        job({ targets: [target({ kind: 'apns_live_activity_push_to_start' as 'apns' })] }),
      ).success,
    ).toBe(false);
    expect(PushJobV1.safeParse(job({ targets: [target({ kind: 'fcm' })] })).success).toBe(true);
    expect(
      PushJobV1.safeParse(job({ targets: [target({ environment: 'development' as 'sandbox' })] }))
        .success,
    ).toBe(false);
  });
});

describe('pushCollapseId', () => {
  it('is {kind}:{flightKey}, or the job id for a job that names no flight', () => {
    const jobId = crypto.randomUUID();
    expect(
      pushCollapseId({ notificationKind: 'delay', flightKey: 'AAL-100-2026-10-02-KJFK', jobId }),
    ).toBe('delay:AAL-100-2026-10-02-KJFK');
    expect(pushCollapseId({ notificationKind: 'system', jobId })).toBe(`system:${jobId}`);
  });

  it('fits the 64 bytes APNs allows for the longest kind and the longest flight key', () => {
    const longestKind = [...NOTIFICATION_KINDS].sort((a, b) => b.length - a.length)[0] ?? '';
    const longestKey = `AAL-9999A-2026-12-31-KJFK-L${'9'.repeat(PUSH_FLIGHT_KEY_MAX_LENGTH - 27)}`;
    const id = pushCollapseId({
      notificationKind: longestKind as (typeof NOTIFICATION_KINDS)[number],
      flightKey: longestKey,
      jobId: crypto.randomUUID(),
    });
    expect(new TextEncoder().encode(id).length).toBeLessThanOrEqual(COLLAPSE_ID_MAX_BYTES);
    const test = pushCollapseId({
      notificationKind: longestKind as (typeof NOTIFICATION_KINDS)[number],
      jobId: crypto.randomUUID(),
    });
    expect(new TextEncoder().encode(test).length).toBeLessThanOrEqual(COLLAPSE_ID_MAX_BYTES);
  });
});

describe('PushOutcomeMessageV1', () => {
  const result = {
    pushTokenId: crypto.randomUUID(),
    subjectId: crypto.randomUUID(),
    kind: 'apns',
    environment: 'production',
    appId: 'app.planeahead.mobile',
    notificationId: crypto.randomUUID(),
    attempt: 1,
    requested: true,
    outcome: 'invalid_token',
    reason: 'Unregistered',
    httpStatus: 410,
    providerId: null,
    apnsTimestampMs: 1_790_000_000_000,
    fcmErrorDetail: null,
    retryDelaySeconds: null,
    at: '2026-10-02T12:00:00Z',
  } as const;

  it('parses an outcome and defaults its version', () => {
    const parsed = PushOutcomeMessageV1.parse({
      kind: 'push_outcome',
      jobId: crypto.randomUUID(),
      test: false,
      results: [result],
    });
    expect(parsed.pushVersion).toBe(1);
    expect(parsed.results[0]?.outcome).toBe('invalid_token');
  });

  it('refuses an unknown outcome and a reason that is not a plain identifier', () => {
    expect(PushTargetResultV1.safeParse({ ...result, outcome: 'delivered' }).success).toBe(false);
    for (const reason of ['', 'has space', '<script>', 'x'.repeat(65), '1starts_with_digit']) {
      expect(PushTargetResultV1.safeParse({ ...result, reason }).success, reason).toBe(false);
    }
    expect(PushTargetResultV1.safeParse({ ...result, reason: 'edge_502' }).success).toBe(true);
    expect(PushTargetResultV1.safeParse({ ...result, reason: null }).success).toBe(true);
  });
});

describe('PushDataV1', () => {
  it('is flat strings with no body key', () => {
    const data = PushDataV1.parse({
      v: '1',
      kind: 'gate_change',
      flightSubscriptionId: crypto.randomUUID(),
      tag: 'gate_change:AAL-100-2026-10-02-KJFK',
      channelId: 'flight_gate',
    });
    expect(Object.values(data).every((value) => typeof value === 'string')).toBe(true);
    expect('body' in data).toBe(false);
    expect(PushDataV1.safeParse({ v: 1, kind: 'gate_change' }).success).toBe(false);
  });
});

describe('PushAuth RPC payloads', () => {
  it('names one of the three credentials, and maps a target to its credential', () => {
    expect(PushCredentialRequestV1.parse({ name: 'apns:sandbox' }).rpcVersion).toBe(1);
    expect(PushCredentialRequestV1.safeParse({ name: 'apns:development' }).success).toBe(false);
    expect(PushCredentialExpireRequestV1.safeParse({ name: 'fcm', token: '' }).success).toBe(false);
    expect(pushCredentialName('apns', 'sandbox')).toBe('apns:sandbox');
    expect(pushCredentialName('apns', 'production')).toBe('apns:production');
    expect(pushCredentialName('fcm', 'sandbox')).toBe('fcm');
  });
});

describe('the client bundle rule', () => {
  it('exports no name the SECRET_PATTERNS bundle grep would flag', () => {
    // This package ships inside the app, and `SECRET_PATTERNS` flags the APNs and FCM env-var
    // prefixes in a client bundle, where export names survive minification.
    expect(findSecretPatterns(Object.keys(push).join('\n'))).toEqual([]);
    expect(SECRET_PATTERNS.length).toBeGreaterThan(0);
  });
});
