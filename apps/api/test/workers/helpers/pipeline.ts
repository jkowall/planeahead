/**
 * The production path after a FlightTracker, for the end-to-end tests of increment 15's review
 * ruling Q1: its flushed outbox through the real persist consumer (the WHOLE flush, the intent and
 * the instance rows that release the live-tracking slot, as one persist batch takes them), the
 * forwarded intents through the real notify consumer, and its jobs through the real push consumer,
 * whose outcomes persist records as `notification_deliveries` rows.
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { devices, flightInstances, flightSubscriptions, pushTokens, users } from '@planeahead/db';
import { PushJobV1, uuidv7, type FlightKey, type PersistMessageV1 } from '@planeahead/shared';
import { createLogger } from '../../../src/observability/log';
import { handleNotifyBatch } from '../../../src/queues/notify';
import { handlePersistBatch } from '../../../src/queues/persist';
import { handlePushBatch } from '../../../src/queues/push';
import type { TransportOutcome } from '../../../src/push/transport';
import { uniqueEmail, uniqueInstallId } from './auth';
import { testEnv, type TrackerHarness } from './flights';
import { db } from './routes';

const quietLog = createLogger({}, () => undefined);

/** Runs messages through the real persist consumer, 100 a batch; returns what it forwarded. */
export async function persist(messages: readonly unknown[]): Promise<unknown[]> {
  const forwarded: unknown[] = [];
  const notifyQueue = {
    send: (body: unknown): Promise<void> => {
      forwarded.push(body);
      return Promise.resolve();
    },
  };
  for (let i = 0; i < messages.length; i += 100) {
    const batch = createMessageBatch(
      'planeahead-persist-local',
      messages.slice(i, i + 100).map((body, index) => ({
        id: `p-${String(i + index)}-${crypto.randomUUID()}`,
        timestamp: new Date(),
        attempts: 1,
        body,
      })),
    );
    const ctx = createExecutionContext();
    await handlePersistBatch(
      batch,
      { env: testEnv, ctx, log: quietLog },
      { db: db(), notifyQueue },
    );
    expect((await getQueueResult(batch, ctx)).retryMessages).toEqual([]);
  }
  return forwarded;
}

/** Runs intents through the real notify consumer; returns the push jobs it queued. */
export async function notify(intents: readonly unknown[]): Promise<PushJobV1[]> {
  if (intents.length === 0) {
    return [];
  }
  const sent: unknown[] = [];
  const pushQueue: Pick<Queue, 'sendBatch'> = {
    sendBatch: (messages) => {
      sent.push(...[...messages].map((message) => message.body));
      return Promise.resolve() as unknown as ReturnType<Queue['sendBatch']>;
    },
  };
  const batch = createMessageBatch(
    'planeahead-notify-local',
    intents.map((body, index) => ({
      id: `n-${String(index)}-${crypto.randomUUID()}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  // The file's handle, as `persist` passes: a client per call would live until the file ends.
  await handleNotifyBatch(batch, { env: testEnv, ctx, log: quietLog }, { db: db(), pushQueue });
  expect((await getQueueResult(batch, ctx)).retryMessages).toEqual([]);
  return sent.map((body) => PushJobV1.parse(body));
}

/** What one step of the pipeline after the tracker came to. */
export interface PipelineRun {
  readonly persisted: PersistMessageV1[];
  readonly forwarded: unknown[];
  readonly jobs: PushJobV1[];
}

/** The tracker's flushed messages since the last run: ALL through persist, then notify. */
export async function pipeline(tracker: TrackerHarness): Promise<PipelineRun> {
  const persisted = tracker.outbox.sent.splice(0);
  const forwarded = await persist(persisted);
  return { persisted, forwarded, jobs: await notify(forwarded) };
}

const SENT: TransportOutcome = {
  outcome: 'sent',
  requested: true,
  providerId: 'fcm-message-q1',
  httpStatus: 200,
};

/**
 * Sends the jobs through the real push consumer (an FCM transport that answers `sent`, the
 * liveness read on the test database) and records its outcomes through persist.
 */
export async function pushAndRecord(jobs: readonly PushJobV1[]): Promise<void> {
  const outcomes: unknown[] = [];
  const batch = createMessageBatch(
    'planeahead-push-local',
    jobs.map((body, index) => ({
      id: `push-${String(index)}-${crypto.randomUUID()}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  await handlePushBatch(
    batch,
    { env: testEnv, ctx, log: quietLog },
    {
      configuration: {
        apns: { configured: false, problems: ['not used here'] },
        fcm: { configured: true, problems: [], projectId: 'planeahead-test' },
      },
      transports: { fcm: { kind: 'fcm', send: () => Promise.resolve(SENT) } },
      persistQueue: {
        send: (body: unknown) => {
          outcomes.push(body);
          return Promise.resolve() as unknown as ReturnType<Queue['send']>;
        },
      },
    },
  );
  expect((await getQueueResult(batch, ctx)).retryMessages).toEqual([]);
  expect(outcomes).toHaveLength(jobs.length);
  await persist(outcomes);
}

export interface Follower {
  readonly userId: string;
  readonly subscriptionId: string;
}

/**
 * A user following the flight with one sendable FCM token. `liveTracked` is the subscription's
 * flag; `releasedAt` a release persist recorded earlier (ruling Q1); neither: the cap refused it.
 */
export async function plantFollower(
  flightKey: FlightKey,
  options: { liveTracked: boolean; releasedAt?: string },
): Promise<Follower> {
  const userId = uuidv7();
  await db()
    .insert(users)
    .values({ id: userId, name: '', email: uniqueEmail('pipeline') });
  const [instance] = await db()
    .select({ id: flightInstances.id })
    .from(flightInstances)
    .where(eq(flightInstances.flightKey, flightKey));
  expect(instance).toBeDefined();
  const subscriptionId = uuidv7();
  await db()
    .insert(flightSubscriptions)
    .values({
      id: subscriptionId,
      userId,
      flightInstanceId: instance?.id ?? '',
      liveTracked: options.liveTracked,
      liveTrackedReleasedAt: options.releasedAt ?? null,
    });
  const deviceId = uuidv7();
  await db()
    .insert(devices)
    .values({ id: deviceId, userId, installId: uniqueInstallId('pipeline'), platform: 'android' });
  await db()
    .insert(pushTokens)
    .values({
      id: uuidv7(),
      userId,
      deviceId,
      kind: 'fcm',
      token: `tok-${userId}`,
      environment: 'production',
    });
  return { userId, subscriptionId };
}

/** A subscription's flag and release stamp. */
export async function subscriptionState(
  follower: Follower,
): Promise<{ live: boolean; releasedAt: string | null }> {
  const [row] = await db()
    .select({
      live: flightSubscriptions.liveTracked,
      releasedAt: flightSubscriptions.liveTrackedReleasedAt,
    })
    .from(flightSubscriptions)
    .where(eq(flightSubscriptions.id, follower.subscriptionId));
  expect(row).toBeDefined();
  return row ?? { live: false, releasedAt: null };
}

/** The users a set of jobs reaches. */
export const subjectsOf = (jobs: readonly PushJobV1[]): string[] =>
  jobs.flatMap((job) => job.targets.map((target) => target.subjectId));
