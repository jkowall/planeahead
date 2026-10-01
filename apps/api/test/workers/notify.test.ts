/**
 * The `notify` consumer (increment 15, ruling N9) against the embedded Postgres 18, with the
 * `push` queue replaced by a recorder: subscription, mute, `push_enabled` and per-kind filtering;
 * pushes only to `live_tracked` subscriptions, rows for every subscriber; the production allow-list for test intents; idempotent `notifications` rows; the 50-target
 * split and the `sendBatch` limits; permission filtering; `subjectId`, `notificationId` and the
 * subscription per target; the channel per kind; and a `sendBatch` that fails part way.
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  devices,
  flightInstances,
  flightSubscriptions,
  notificationPreferences,
  notifications,
  pushTokens,
  userPreferences,
  users,
} from '@planeahead/db';
import {
  PushJobV1,
  pushCollapseId,
  uuidv7,
  type FlightKey,
  type NotifyIntentV1Input,
} from '@planeahead/shared';
import { createLogger } from '../../src/observability/log';
import { handleNotifyBatch } from '../../src/queues/notify';
import { testEnv, uniqueEmail, uniqueInstallId } from './helpers/auth';
import { db, seededFlightFor } from './helpers/routes';

const quietLog = createLogger({}, () => undefined);

async function plantFlight(): Promise<FlightKey> {
  const flight = seededFlightFor();
  const [row] = await db()
    .insert(flightInstances)
    .values({
      operatingCarrierIcao: 'AAL',
      flightNumber: flight.number,
      scheduledDepartureDate: flight.dateLocal,
      originIcao: 'KJFK',
      trackingState: 'tracking',
      version: 1,
    })
    .returning({ flightKey: flightInstances.flightKey });
  if (row === undefined) {
    throw new Error('no instance inserted');
  }
  return row.flightKey as FlightKey;
}

interface PlantOptions {
  readonly muted?: boolean;
  /** The subscription's `live_tracked` flag; true by default, as only those are pushed. */
  readonly liveTracked?: boolean;
  readonly unsubscribed?: boolean;
  readonly preferences?: { pushEnabled?: boolean; events?: Record<string, boolean> };
  readonly timeFormat?: '12h' | '24h';
}

/** A user following `flightKey`; returns the user id and the subscription id. */
async function plantFollower(
  flightKey: FlightKey,
  options: PlantOptions = {},
): Promise<{ userId: string; subscriptionId: string }> {
  const userId = uuidv7();
  await db()
    .insert(users)
    .values({ id: userId, name: '', email: uniqueEmail('notify') });
  const [instance] = await db()
    .select({ id: flightInstances.id })
    .from(flightInstances)
    .where(eq(flightInstances.flightKey, flightKey));
  const subscriptionId = uuidv7();
  await db()
    .insert(flightSubscriptions)
    .values({
      id: subscriptionId,
      userId,
      flightInstanceId: instance?.id ?? '',
      muted: options.muted ?? false,
      liveTracked: options.liveTracked ?? true,
      deletedAt: options.unsubscribed === true ? new Date().toISOString() : null,
    });
  if (options.preferences !== undefined) {
    const { pushEnabled = true, events = {} } = options.preferences;
    await db()
      .insert(notificationPreferences)
      .values({ id: uuidv7(), userId, pushEnabled, events });
  }
  if (options.timeFormat !== undefined) {
    await db()
      .insert(userPreferences)
      .values({ id: uuidv7(), userId, timeFormat: options.timeFormat });
  }
  return { userId, subscriptionId };
}

interface TokenOptions {
  readonly kind?: string;
  readonly permission?: string | null;
  readonly invalidated?: boolean;
  /** Characters per token (FCM tokens are opaque; long ones make large jobs). */
  readonly length?: number;
}

/** `count` tokens of one device of `userId`; returns their ids in insertion order. */
async function plantTokens(
  userId: string,
  count: number,
  options: TokenOptions = {},
): Promise<string[]> {
  const deviceId = uuidv7();
  await db()
    .insert(devices)
    .values({ id: deviceId, userId, installId: uniqueInstallId('notify'), platform: 'android' });
  const rows = Array.from({ length: count }, () => {
    const id = uuidv7();
    const token = `tok-${id}`.padEnd(options.length ?? 0, 'x');
    return {
      id,
      userId,
      deviceId,
      kind: options.kind ?? 'fcm',
      token,
      environment: 'production',
      permission: options.permission ?? null,
      invalidatedAt: options.invalidated === true ? new Date().toISOString() : null,
    };
  });
  await db().insert(pushTokens).values(rows);
  return rows.map((row) => row.id);
}

/** A gate change intent for `flightKey`, as the tracker writes it; fields may be replaced. */
function intentFor(
  flightKey: FlightKey,
  fields: Partial<NotifyIntentV1Input['intent']> = {},
  extra: Partial<NotifyIntentV1Input> = {},
): NotifyIntentV1Input {
  const intent = {
    kind: 'gate_change' as const,
    subject: 'origin' as const,
    value: 'B12',
    previousValue: 'A4',
    correction: false,
    firstAssignment: false,
    timeSensitive: true,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    dedupeValue: 'origin:B12',
    ...fields,
  };
  return {
    kind: 'notify_intent',
    flightKey,
    dedupeKey: `${flightKey}:${intent.kind}:${intent.dedupeValue}:7`,
    intent,
    flight: {
      operatingCarrierIcao: 'AAL',
      flightNumber: '100',
      origin: { icao: 'KJFK', iata: 'JFK', tz: 'America/New_York' },
      destination: { icao: 'KLAX', iata: 'LAX', tz: 'America/Los_Angeles' },
      status: 'scheduled',
      times: { scheduledOut: '2026-10-03T19:00:00.000Z', scheduledIn: '2026-10-04T01:10:00.000Z' },
      originGate: 'B12',
    },
    producedAt: new Date().toISOString(),
    ...extra,
  };
}

/** The `push` queue: records every `sendBatch`; `failCall` (1-based, counted over its life) throws. */
function recordingQueue(failCalls: readonly number[] = []) {
  const calls: { body: unknown; contentType?: string }[][] = [];
  let made = 0;
  const queue: Pick<Queue, 'sendBatch'> = {
    sendBatch: (messages) => {
      made += 1;
      if (failCalls.includes(made)) {
        return Promise.reject(new Error('queue unavailable'));
      }
      calls.push([...messages] as { body: unknown; contentType?: string }[]);
      return Promise.resolve() as unknown as ReturnType<Queue['sendBatch']>;
    },
  };
  /** Every job a successful call carried, validated as the push consumer reads it. */
  const jobs = () => calls.flat().map((message) => PushJobV1.parse(message.body));
  return { queue, calls, jobs, made: () => made };
}

let messageCounter = 0;

async function deliver(
  bodies: readonly NotifyIntentV1Input[],
  queue: Pick<Queue, 'sendBatch'>,
  env: typeof testEnv = testEnv,
): Promise<{ acked: string[]; retried: string[] }> {
  const batch = createMessageBatch(
    'planeahead-notify-local',
    bodies.map((body) => {
      messageCounter += 1;
      return { id: `notify-${String(messageCounter)}`, timestamp: new Date(), attempts: 1, body };
    }),
  );
  const ctx = createExecutionContext();
  await handleNotifyBatch(batch, { env, ctx, log: quietLog }, { pushQueue: queue });
  const result = await getQueueResult(batch, ctx);
  return {
    acked: result.explicitAcks,
    retried: result.retryMessages.map((message) => message.msgId),
  };
}

async function rowsFor(dedupeKey: string) {
  return db()
    .select({ id: notifications.id, userId: notifications.userId, isTest: notifications.isTest })
    .from(notifications)
    .where(eq(notifications.dedupeKey, dedupeKey));
}

const subjectsOf = (jobs: readonly PushJobV1[]) =>
  new Set(jobs.flatMap((job) => job.targets.map((target) => target.subjectId)));

describe('notify: who hears of an intent', () => {
  it('reaches live subscriptions, less the muted, push off and toggles off; a first gate needs its opt-in', async () => {
    const flightKey = await plantFlight();
    const plain = await plantFollower(flightKey);
    const muted = await plantFollower(flightKey, { muted: true });
    const pushOff = await plantFollower(flightKey, { preferences: { pushEnabled: false } });
    const gatesOff = await plantFollower(flightKey, {
      preferences: { events: { gate_change: false } },
    });
    const optedIn = await plantFollower(flightKey, {
      preferences: { events: { first_gate_assignment: true } },
    });
    const gone = await plantFollower(flightKey, { unsubscribed: true });
    for (const follower of [plain, muted, pushOff, gatesOff, optedIn, gone]) {
      await plantTokens(follower.userId, 1);
    }
    const recorder = recordingQueue();

    const change = intentFor(flightKey);
    const first = intentFor(
      flightKey,
      { value: 'C7', previousValue: null, firstAssignment: true, dedupeValue: 'origin:C7' },
      {},
    );
    const delivered = await deliver([change, first], recorder.queue);
    expect(delivered.retried).toEqual([]);
    expect(delivered.acked).toHaveLength(2);

    const [changeJob, firstJob] = recorder.jobs();
    expect(subjectsOf(changeJob === undefined ? [] : [changeJob])).toEqual(
      new Set([plain.userId, optedIn.userId]),
    );
    // Only the user who turned the first gate assignment on hears of it (off by default).
    expect(subjectsOf(firstJob === undefined ? [] : [firstJob])).toEqual(new Set([optedIn.userId]));
    expect(recorder.jobs()).toHaveLength(2);
    // Rows only for the users who heard: none for the muted, the push-off, the toggled-off or
    // the unsubscribed.
    expect(new Set((await rowsFor(change.dedupeKey)).map((row) => row.userId))).toEqual(
      new Set([plain.userId, optedIn.userId]),
    );
    expect((await rowsFor(first.dedupeKey)).map((row) => row.userId)).toEqual([optedIn.userId]);
  });

  it('pushes only live-tracked subscriptions; every subscriber who passes still gets the row', async () => {
    const flightKey = await plantFlight();
    const live = await plantFollower(flightKey);
    const notLive = await plantFollower(flightKey, { liveTracked: false });
    await plantTokens(live.userId, 1);
    await plantTokens(notLive.userId, 2);
    const recorder = recordingQueue();
    const intent = intentFor(flightKey);
    const delivered = await deliver([intent], recorder.queue);
    expect(delivered.retried).toEqual([]);
    expect(delivered.acked).toHaveLength(1);

    // One push, to the live-tracked subscriber only.
    const jobs = recorder.jobs();
    expect(jobs).toHaveLength(1);
    expect(jobs.flatMap((job) => job.targets.map((target) => target.subjectId))).toEqual([
      live.userId,
    ]);
    // Both rows: the inbox does not depend on the live-tracking slot.
    expect(new Set((await rowsFor(intent.dedupeKey)).map((row) => row.userId))).toEqual(
      new Set([live.userId, notLive.userId]),
    );

    // A flight whose only subscriber is not live-tracked: the row, and no `sendBatch` at all.
    const quietFlight = await plantFlight();
    const alone = await plantFollower(quietFlight, { liveTracked: false });
    await plantTokens(alone.userId, 1);
    const quiet = recordingQueue();
    const quietIntent = intentFor(quietFlight);
    expect((await deliver([quietIntent], quiet.queue)).retried).toEqual([]);
    expect(quiet.made()).toBe(0);
    expect((await rowsFor(quietIntent.dedupeKey)).map((row) => row.userId)).toEqual([alone.userId]);
  });
});

describe('notify: test intents (N11)', () => {
  it('on production reach only allow-listed users; on staging every subscriber; rows marked as tests', async () => {
    const flightKey = await plantFlight();
    const tester = await plantFollower(flightKey);
    const other = await plantFollower(flightKey);
    await plantTokens(tester.userId, 1);
    await plantTokens(other.userId, 1);
    const production = {
      ...testEnv,
      ENVIRONMENT: 'production',
      // Upper case and padded: the allow-list is read as the admin page reads it.
      PUSH_INJECT_ALLOWED_USER_IDS: ` ${tester.userId.toUpperCase()} ,not-a-uuid`,
    } as typeof testEnv;
    const staging = { ...testEnv, ENVIRONMENT: 'staging' } as typeof testEnv;
    const injected = (id: string) =>
      intentFor(
        flightKey,
        { dedupeValue: `origin:B12:${id}` },
        { test: true, injectionId: id, dedupeKey: `${flightKey}:gate_change:origin:B12:${id}` },
      );

    const onProduction = recordingQueue();
    expect((await deliver([injected('inj-prod')], onProduction.queue, production)).retried).toEqual(
      [],
    );
    expect(subjectsOf(onProduction.jobs())).toEqual(new Set([tester.userId]));
    expect(onProduction.jobs().every((job) => job.test)).toBe(true);
    expect(await rowsFor(injected('inj-prod').dedupeKey)).toEqual([
      expect.objectContaining({ userId: tester.userId, isTest: true }),
    ]);

    // A real intent on production is not restricted by the allow-list.
    const real = recordingQueue();
    await deliver([intentFor(flightKey)], real.queue, production);
    expect(subjectsOf(real.jobs())).toEqual(new Set([tester.userId, other.userId]));
    expect(real.jobs().every((job) => !job.test)).toBe(true);
    expect((await rowsFor(intentFor(flightKey).dedupeKey)).every((row) => !row.isTest)).toBe(true);

    const onStaging = recordingQueue();
    await deliver([injected('inj-staging')], onStaging.queue, staging);
    expect(subjectsOf(onStaging.jobs())).toEqual(new Set([tester.userId, other.userId]));
    const stagingRows = await rowsFor(injected('inj-staging').dedupeKey);
    expect(stagingRows).toHaveLength(2);
    expect(stagingRows.every((row) => row.isTest)).toBe(true);
  });
});

describe('notify: jobs and rows', () => {
  it('cuts 60 targets into jobs of 50 and 10, each target naming its user, row and subscription', async () => {
    const flightKey = await plantFlight();
    const a = await plantFollower(flightKey);
    const b = await plantFollower(flightKey);
    const tokensOf = new Map([
      [a.userId, await plantTokens(a.userId, 30)],
      [b.userId, await plantTokens(b.userId, 30)],
    ]);
    const intent = intentFor(flightKey);
    const recorder = recordingQueue();
    expect((await deliver([intent], recorder.queue)).retried).toEqual([]);

    const jobs = recorder.jobs();
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.every((message) => message.contentType === 'json')).toBe(true);
    expect(jobs.map((job) => job.targets.length)).toEqual([50, 10]);
    const rows = new Map((await rowsFor(intent.dedupeKey)).map((row) => [row.userId, row.id]));
    expect(rows.size).toBe(2);
    const subscriptions = new Map([
      [a.userId, a.subscriptionId],
      [b.userId, b.subscriptionId],
    ]);
    const targets = jobs.flatMap((job) => job.targets);
    expect(new Set(targets.map((target) => target.pushTokenId)).size).toBe(60);
    for (const target of targets) {
      expect(tokensOf.get(target.subjectId)).toContain(target.pushTokenId);
      expect(target.notificationId).toBe(rows.get(target.subjectId));
      expect(target.flightSubscriptionId).toBe(subscriptions.get(target.subjectId));
      expect(target.attempt).toBe(0);
    }
    expect(new Set(jobs.map((job) => job.jobId)).size).toBe(2);
  });

  it('a redelivered intent inserts no second row and sends to the same rows again', async () => {
    const flightKey = await plantFlight();
    const follower = await plantFollower(flightKey);
    await plantTokens(follower.userId, 2);
    const intent = intentFor(flightKey);
    const first = recordingQueue();
    const second = recordingQueue();
    await deliver([intent], first.queue);
    await deliver([intent], second.queue);

    const rows = await rowsFor(intent.dedupeKey);
    expect(rows).toHaveLength(1);
    const notificationIds = (recorder: ReturnType<typeof recordingQueue>) =>
      recorder.jobs().flatMap((job) => job.targets.map((target) => target.notificationId));
    expect(notificationIds(first)).toEqual([rows[0]?.id, rows[0]?.id]);
    expect(notificationIds(second)).toEqual(notificationIds(first));
  });
});

describe('notify: tokens and job fields', () => {
  it('sends to granted, provisional and unreported tokens only, never invalidated or non-device ones', async () => {
    const flightKey = await plantFlight();
    const follower = await plantFollower(flightKey);
    const sent = [
      ...(await plantTokens(follower.userId, 1, { permission: 'granted' })),
      ...(await plantTokens(follower.userId, 1, { permission: 'provisional' })),
      ...(await plantTokens(follower.userId, 1, { permission: null })),
      ...(await plantTokens(follower.userId, 1, { kind: 'apns', permission: 'granted' })),
    ];
    await plantTokens(follower.userId, 1, { permission: 'denied' });
    await plantTokens(follower.userId, 1, { permission: 'undetermined' });
    await plantTokens(follower.userId, 1, { invalidated: true });
    await plantTokens(follower.userId, 1, { kind: 'expo' });
    await plantTokens(follower.userId, 1, { kind: 'apns_live_activity_push_to_start' });
    const recorder = recordingQueue();
    await deliver([intentFor(flightKey)], recorder.queue);
    const targets = recorder.jobs().flatMap((job) => job.targets);
    expect(new Set(targets.map((target) => target.pushTokenId))).toEqual(new Set(sent));
    // A user without a single sendable token still gets the inbox row, and no job goes out.
    const silent = await plantFollower(flightKey);
    await plantTokens(silent.userId, 1, { permission: 'denied' });
    const intent = intentFor(flightKey, { value: 'D1', dedupeValue: 'origin:D1' });
    const quiet = recordingQueue();
    await deliver([intent], quiet.queue);
    expect(subjectsOf(quiet.jobs()).has(silent.userId)).toBe(false);
    expect((await rowsFor(intent.dedupeKey)).map((row) => row.userId)).toContain(silent.userId);
  });

  it('names the channel per kind, the window, the collapse key, and renders per time format', async () => {
    const flightKey = await plantFlight();
    const twelve = await plantFollower(flightKey);
    const twentyFour = await plantFollower(flightKey, { timeFormat: '24h' });
    await plantTokens(twelve.userId, 1);
    await plantTokens(twentyFour.userId, 1);
    const cases = [
      { kind: 'delay', subject: 'departure', value: '45', channel: 'flight_delays' },
      {
        kind: 'delay',
        subject: 'departure',
        value: '5',
        channel: 'flight_delays',
        correction: true,
      },
      { kind: 'gate_change', subject: 'origin', value: 'B12', channel: 'flight_changes' },
      { kind: 'cancellation', subject: 'flight', value: 'cancelled', channel: 'flight_changes' },
      { kind: 'diversion', subject: 'flight', value: 'KSFO', channel: 'flight_changes' },
    ] as const;
    for (const { channel, ...fields } of cases) {
      const intent = intentFor(flightKey, {
        ...fields,
        dedupeValue: `${fields.subject}:${fields.value}`,
      });
      const recorder = recordingQueue();
      await deliver([intent], recorder.queue);
      const jobs = recorder.jobs();
      expect(jobs).toHaveLength(2);
      for (const job of jobs) {
        expect(job).toMatchObject({
          notificationKind: fields.kind,
          channelId: channel,
          flightKey,
          timeSensitive: true,
          expiresAt: intent.intent.expiresAt,
          priority: 'high',
          test: false,
        });
        expect(pushCollapseId(job)).toBe(`${fields.kind}:${flightKey}`);
      }
      const bodies = new Map(jobs.map((job) => [job.targets[0]?.subjectId, job.body]));
      expect(bodies.get(twelve.userId)).toMatch(/\b\d{1,2}:\d{2} (AM|PM)\b|cancelled/);
      expect(bodies.get(twentyFour.userId)).not.toMatch(/\b(AM|PM)\b/);
    }
  });
});

describe('notify: sendBatch limits and failures', () => {
  it('packs by bytes, and a sendBatch failing part way retries the intent, which loses no target', async () => {
    const flightKey = await plantFlight();
    const followers = [
      await plantFollower(flightKey),
      await plantFollower(flightKey),
      await plantFollower(flightKey),
    ];
    // Long (2,000-character) tokens make each 50-target job about 110 KB: two fit one 256 KB
    // call, the third needs a second.
    const tokens: string[] = [];
    for (const follower of followers) {
      tokens.push(...(await plantTokens(follower.userId, 50, { length: 2_000 })));
    }
    const intent = intentFor(flightKey);
    // The second call throws on the first delivery; the redelivery's calls all succeed.
    const recorder = recordingQueue([2]);

    const failed = await deliver([intent], recorder.queue);
    expect(failed.acked).toEqual([]);
    expect(failed.retried).toHaveLength(1);
    expect(recorder.calls.map((call) => call.length)).toEqual([2]);
    const firstRows = await rowsFor(intent.dedupeKey);
    expect(firstRows).toHaveLength(3);

    const redelivered = await deliver([intent], recorder.queue);
    expect(redelivered.retried).toEqual([]);
    expect(redelivered.acked).toHaveLength(1);
    expect(recorder.made()).toBe(4);
    // The redelivery re-sent everything (two calls: two jobs, then one), on the same rows.
    const again = recorder.calls.slice(1);
    expect(again.map((call) => call.length)).toEqual([2, 1]);
    const resent = again.flat().map((message) => PushJobV1.parse(message.body));
    expect(new Set(resent.flatMap((job) => job.targets.map((t) => t.pushTokenId)))).toEqual(
      new Set(tokens),
    );
    expect(await rowsFor(intent.dedupeKey)).toEqual(expect.arrayContaining(firstRows));
    expect(await rowsFor(intent.dedupeKey)).toHaveLength(3);
    const ids = new Set(firstRows.map((row) => row.id));
    expect(resent.every((job) => job.targets.every((t) => ids.has(t.notificationId ?? '')))).toBe(
      true,
    );
  });

  it('acknowledges an intent this build cannot read, and sends nothing', async () => {
    const recorder = recordingQueue();
    const broken = { kind: 'notify_intent', flightKey: 'nope' } as unknown as NotifyIntentV1Input;
    const delivered = await deliver([broken], recorder.queue);
    expect(delivered.acked).toHaveLength(1);
    expect(delivered.retried).toEqual([]);
    expect(recorder.made()).toBe(0);
  });
});
