/**
 * `mergeUsers` against the real database: the eight tables re-keyed in one transaction with the
 * documented conflict policy, the queue message sent once, the anonymous row marked and its
 * sessions revoked, and a replay that is a no-op.
 *
 * The rows are planted directly so the conflicts exist: an install id both users registered
 * (the loser device's push token follows the winner), a preferences row on each side (newer
 * wins), the same counter window on each side (summed), the same idempotency key on each side
 * (`to` keeps its own). The end-to-end
 * upgrades (magic link, Apple, Google) are in their own files; this one is the function.
 */

import { and, eq, inArray } from 'drizzle-orm';
import {
  devices,
  idempotencyKeys,
  notificationPreferences,
  openDb,
  pushTokens,
  sessions,
  trips,
  usageCounters,
  userPreferences,
  users,
} from '@planeahead/db';
import { uuidv7 } from '@planeahead/shared';
import { describe, expect, it } from 'vitest';
import { type MergeJobMessage, mergeUsers } from '../../src/auth/merge';
import { createLogger } from '../../src/observability/log';
import { testEnv, uniqueEmail, uniqueInstallId } from './helpers/auth';

const db = openDb(testEnv);
const log = createLogger({}, () => undefined);

function countingQueue(): {
  readonly sent: MergeJobMessage[];
  send(m: MergeJobMessage): Promise<void>;
} {
  const sent: MergeJobMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
}

async function plantUser(anonymous: boolean): Promise<string> {
  const id = uuidv7();
  await db.insert(users).values({
    id,
    name: '',
    email: anonymous ? `temp-${id}@anonymous.planeahead.app` : uniqueEmail('merge'),
    isAnonymous: anonymous,
  });
  return id;
}

const OLDER = new Date(Date.now() - 3_600_000).toISOString();
const NEWER = new Date().toISOString();

interface Planted {
  readonly from: string;
  readonly to: string;
  readonly sharedInstallId: string;
  /** The anonymous side's row for the shared install: newer, so it must survive. */
  readonly fromSharedDeviceId: string;
  readonly fromOnlyInstallId: string;
  readonly sharedToken: string;
  readonly fromOnlyToken: string;
  readonly sharedKey: string;
  readonly fromOnlyKey: string;
  readonly windowStart: string;
}

async function plant(): Promise<Planted> {
  const from = await plantUser(true);
  const to = await plantUser(false);
  const sharedInstallId = uniqueInstallId('merge-shared');
  const fromOnlyInstallId = uniqueInstallId('merge-from');
  const sharedToken = `tok-shared-${crypto.randomUUID()}`;
  const fromOnlyToken = `tok-from-${crypto.randomUUID()}`;
  const windowStart = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString();

  // Devices: the shared install is NEWER on the anonymous side, so `from`'s row wins.
  const fromShared = uuidv7();
  const toShared = uuidv7();
  const fromOnly = uuidv7();
  await db.insert(devices).values([
    { id: fromShared, userId: from, installId: sharedInstallId, platform: 'ios', updatedAt: NEWER },
    { id: toShared, userId: to, installId: sharedInstallId, platform: 'ios', updatedAt: OLDER },
    { id: fromOnly, userId: from, installId: fromOnlyInstallId, platform: 'android' },
  ]);
  // Push tokens: `(kind, token)` is unique across users, so no token can be held twice. The
  // winning (anonymous) shared device holds one, the losing device holds another that has to
  // follow the winner, and the from-only device holds a third that is simply re-keyed.
  await db.insert(pushTokens).values([
    { id: uuidv7(), userId: from, deviceId: fromShared, kind: 'apns', token: sharedToken },
    {
      id: uuidv7(),
      userId: to,
      deviceId: toShared,
      kind: 'fcm',
      token: `tok-loser-${crypto.randomUUID()}`,
    },
    { id: uuidv7(), userId: from, deviceId: fromOnly, kind: 'expo', token: fromOnlyToken },
  ]);
  // Preferences: `to` is older, so `from`'s values survive.
  await db.insert(userPreferences).values([
    { id: uuidv7(), userId: from, distanceUnit: 'km', updatedAt: NEWER },
    { id: uuidv7(), userId: to, distanceUnit: 'mi', updatedAt: OLDER },
  ]);
  await db
    .insert(notificationPreferences)
    .values({ id: uuidv7(), userId: from, pushEnabled: false });
  await db.insert(usageCounters).values([
    { scope: 'user', subject: from, counter: 'refreshes', windowStart, count: 2 },
    { scope: 'user', subject: to, counter: 'refreshes', windowStart, count: 3 },
    { scope: 'user', subject: from, counter: 'instances_created', windowStart, count: 1 },
  ]);
  await db.insert(trips).values({ id: uuidv7(), userId: from, name: 'Anonymous trip' });
  const sharedKey = `key-shared-${crypto.randomUUID()}`;
  const fromOnlyKey = `key-from-${crypto.randomUUID()}`;
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  await db.insert(idempotencyKeys).values([
    {
      userId: from,
      key: sharedKey,
      requestHash: new Uint8Array(32),
      responseStatus: 200,
      responseBody: { side: 'from' },
      expiresAt,
    },
    {
      userId: to,
      key: sharedKey,
      requestHash: new Uint8Array(32),
      responseStatus: 200,
      responseBody: { side: 'to' },
      expiresAt,
    },
    {
      userId: from,
      key: fromOnlyKey,
      requestHash: new Uint8Array(32),
      responseStatus: 201,
      responseBody: {},
      expiresAt,
    },
  ]);
  await db.insert(sessions).values({
    id: uuidv7(),
    token: `session-${crypto.randomUUID()}`,
    userId: from,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return {
    from,
    to,
    sharedInstallId,
    fromSharedDeviceId: fromShared,
    fromOnlyInstallId,
    sharedToken,
    fromOnlyToken,
    sharedKey,
    fromOnlyKey,
    windowStart,
  };
}

describe('mergeUsers', () => {
  it('re-keys the eight tables in one transaction with the conflict policy, then enqueues once', async () => {
    const planted = await plant();
    const queue = countingQueue();

    const outcome = await mergeUsers(db, { from: planted.from, to: planted.to }, { queue, log });

    expect(outcome).toEqual({
      merged: true,
      moved: {
        devices: 2,
        push_tokens: 2,
        user_preferences: 1,
        usage_counters: 1,
        flight_subscriptions: 0,
        trips: 1,
        notification_preferences: 1,
        idempotency_keys: 1,
      },
    });
    // No subscription was planted, so there is no tracker to re-point (ruling O2).
    expect(queue.sent).toEqual([
      { kind: 'merge', from: planted.from, to: planted.to, moved: [], tombstoned: [] },
    ]);

    // Devices: both installs on `to`, exactly one row per install, the newer shared row kept.
    const deviceRows = await db
      .select({ id: devices.id, userId: devices.userId, installId: devices.installId })
      .from(devices)
      .where(inArray(devices.installId, [planted.sharedInstallId, planted.fromOnlyInstallId]));
    expect(deviceRows).toHaveLength(2);
    expect(deviceRows.every((row) => row.userId === planted.to)).toBe(true);
    // The newer (anonymous) row survived the conflict; `updated_at` itself moves on re-key
    // because the set_updated_at trigger fires on the UPDATE, so identity is what to check.
    const survivor = deviceRows.find((row) => row.installId === planted.sharedInstallId);
    expect(survivor?.id).toBe(planted.fromSharedDeviceId);

    // Push tokens: three survive (the loser device's fcm re-pointed at the winner, the other two
    // re-keyed), all on `to`, all pointing at devices that still exist.
    const tokenRows = await db
      .select({ userId: pushTokens.userId, deviceId: pushTokens.deviceId, kind: pushTokens.kind })
      .from(pushTokens)
      .innerJoin(devices, eq(devices.id, pushTokens.deviceId))
      .where(inArray(devices.installId, [planted.sharedInstallId, planted.fromOnlyInstallId]));
    expect(tokenRows).toHaveLength(3);
    expect(tokenRows.every((row) => row.userId === planted.to)).toBe(true);
    expect(tokenRows.map((row) => row.kind).sort()).toEqual(['apns', 'expo', 'fcm']);

    // Preferences: one row, the newer (anonymous) values.
    const prefRows = await db
      .select({ userId: userPreferences.userId, distanceUnit: userPreferences.distanceUnit })
      .from(userPreferences)
      .where(inArray(userPreferences.userId, [planted.from, planted.to]));
    expect(prefRows).toEqual([{ userId: planted.to, distanceUnit: 'km' }]);
    const notif = await db
      .select({
        userId: notificationPreferences.userId,
        pushEnabled: notificationPreferences.pushEnabled,
      })
      .from(notificationPreferences)
      .where(inArray(notificationPreferences.userId, [planted.from, planted.to]));
    expect(notif).toEqual([{ userId: planted.to, pushEnabled: false }]);

    // Counters: the shared window summed, the other re-keyed, nothing left on `from`.
    const counters = await db
      .select({
        subject: usageCounters.subject,
        counter: usageCounters.counter,
        count: usageCounters.count,
      })
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.scope, 'user'),
          inArray(usageCounters.subject, [planted.from, planted.to]),
        ),
      );
    expect(counters.map((row) => [row.subject, row.counter, row.count]).sort()).toEqual(
      [
        [planted.to, 'instances_created', 1],
        [planted.to, 'refreshes', 5],
      ].sort(),
    );

    const tripRows = await db
      .select({ userId: trips.userId })
      .from(trips)
      .where(eq(trips.userId, planted.to));
    expect(tripRows).toHaveLength(1);

    // Idempotency keys: `to` keeps its own copy of the shared key, the other moved.
    const keyRows = await db
      .select({
        userId: idempotencyKeys.userId,
        key: idempotencyKeys.key,
        body: idempotencyKeys.responseBody,
      })
      .from(idempotencyKeys)
      .where(inArray(idempotencyKeys.key, [planted.sharedKey, planted.fromOnlyKey]));
    expect(keyRows).toHaveLength(2);
    expect(keyRows.every((row) => row.userId === planted.to)).toBe(true);
    expect(keyRows.find((row) => row.key === planted.sharedKey)?.body).toEqual({ side: 'to' });

    // The anonymous row is marked and its sessions are gone.
    const [fromUser] = await db
      .select({ status: users.status, deletionRequestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.id, planted.from))
      .limit(1);
    expect(fromUser?.status).toBe('deleting');
    expect(fromUser?.deletionRequestedAt).toBeInstanceOf(Date);
    expect(
      await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, planted.from)),
    ).toHaveLength(0);
  });

  it('is a no-op on replay: nothing moves again and nothing is enqueued again', async () => {
    const planted = await plant();
    const queue = countingQueue();
    await mergeUsers(db, { from: planted.from, to: planted.to }, { queue, log });
    const tripsBefore = await db
      .select({ id: trips.id })
      .from(trips)
      .where(eq(trips.userId, planted.to));

    const replay = await mergeUsers(db, { from: planted.from, to: planted.to }, { queue, log });
    const third = await mergeUsers(db, { from: planted.from, to: planted.to }, { queue, log });

    expect(replay).toEqual({ merged: false, reason: 'already_merged' });
    expect(third).toEqual({ merged: false, reason: 'already_merged' });
    expect(queue.sent).toHaveLength(1);
    expect(
      await db.select({ id: trips.id }).from(trips).where(eq(trips.userId, planted.to)),
    ).toEqual(tripsBefore);
  });

  it('refuses the degenerate inputs without touching anything', async () => {
    const real = await plantUser(false);
    const other = await plantUser(false);
    const queue = countingQueue();

    expect(await mergeUsers(db, { from: real, to: real }, { queue, log })).toEqual({
      merged: false,
      reason: 'same_user',
    });
    expect(await mergeUsers(db, { from: uuidv7(), to: other }, { queue, log })).toEqual({
      merged: false,
      reason: 'from_missing',
    });
    expect(await mergeUsers(db, { from: real, to: other }, { queue, log })).toEqual({
      merged: false,
      reason: 'from_not_anonymous',
    });
    expect(queue.sent).toHaveLength(0);
    const [row] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, real))
      .limit(1);
    expect(row?.status).toBe('active');
  });

  it('still commits the rows when the queue send fails, and says so', async () => {
    const planted = await plant();
    const lines: string[] = [];
    const failingQueue = { send: () => Promise.reject(new Error('queue down')) };
    const capturing = createLogger({}, (line) => {
      lines.push(line.event);
    });

    const outcome = await mergeUsers(
      db,
      { from: planted.from, to: planted.to },
      { queue: failingQueue, log: capturing },
    );

    expect(outcome.merged).toBe(true);
    expect(lines).toContain('merge_committed');
    expect(lines).toContain('merge_enqueue_failed');
    const [fromUser] = await db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, planted.from))
      .limit(1);
    expect(fromUser?.status).toBe('deleting');
  });
});
