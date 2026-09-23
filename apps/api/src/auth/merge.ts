/**
 * The anonymous-to-account merge.
 *
 * A user who signs in anonymously and later upgrades (magic link, native Google, native Apple)
 * gets a NEW user row from Better Auth, because the upgrade finds or creates the account by
 * email or provider subject. Everything the anonymous user did has to follow them: devices,
 * push tokens, preferences, counters, subscriptions, trips, notification preferences and the
 * idempotency replay store. `mergeUsers` moves those eight tables in ONE transaction and then
 * enqueues a `merge` job on the `persist` queue for the part of the system that is not in
 * Postgres: the FlightTracker subscriber lists (src/queues/merge.ts, increment 8 ruling O2, which
 * re-subscribes every moved subscription under `to` and unsubscribes every tombstoned loser). The
 * anonymous row itself stays, marked `deleting`; its deletion and a sweep that re-enqueues a lost
 * message are increment 12 housekeeping tasks.
 *
 * The sync feed (increment 8, ruling O2): everything the merge changes in a sync entity is written
 * to `user_sync_changes` under `to`, in this same transaction, so `to`'s other devices pull it from
 * the cursors they already hold: an upsert for every subscription moved to `to` (live after the
 * conflict step), a delete for every subscription tombstoned as a conflict loser, and an upsert
 * for a singleton winner (`user_preferences`, `notification_preferences`) with a delete for its
 * loser. The anonymous user's own feed gets nothing: no session of it survives this transaction,
 * and the device that upgraded holds a cursor bound to the anonymous user, which answers 410
 * `resync_required` under the new session (ruling O12) and re-snapshots.
 *
 * It is idempotent. It is reached from two places for the same upgrade (Better Auth's
 * `anonymous.onLinkAccount` after-hook, and the native endpoints directly, because that hook is
 * outside any transaction and its firing for a plugin endpoint was unverified) and it may be
 * replayed after a crash. The marker is the anonymous user's own row: the transaction sets
 * `users.status = 'deleting'` on `from`, and a second call sees the marker and does nothing,
 * enqueues nothing. Sessions of `from` are revoked in the same transaction so the anonymous
 * cookie cannot keep acting after the upgrade.
 *
 * Conflict policy where `to` already holds a row with the same unique key (a user who upgraded
 * on two phones, or who had an account before going anonymous on a new install): the NEWER row
 * wins by `updated_at`, the loser is deleted (soft-deleted for sync entities, so the tombstone
 * reaches the app), and `usage_counters` are SUMMED rather than picked, because a quota that
 * resets on sign-in is a quota that does not exist; a tombstoned subscription loser then gives its
 * `active_subscriptions` slot (and its `live_tracked` slot, when it held one) back, so the summed
 * counters match the live rows. Push tokens follow their device; a token whose device lost the
 * conflict is re-pointed at the surviving device, or dropped when the survivor already holds the
 * same token.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type Db,
  devices,
  flightInstances,
  flightSubscriptions,
  idempotencyKeys,
  notificationPreferences,
  pushTokens,
  sessions,
  trips,
  usageCounters,
  userPreferences,
  users,
} from '@planeahead/db';
import type { FlightKey } from '@planeahead/shared';
import { releaseCap, userCap } from '../lib/caps';
import {
  appendUserChange,
  notificationPreferencesSyncRow,
  preferencesSyncRow,
  subscriptionSyncRow,
} from '../lib/sync-rows';
import type { Logger } from '../observability/log';

export const MERGE_TABLES = [
  'devices',
  'push_tokens',
  'user_preferences',
  'usage_counters',
  'flight_subscriptions',
  'trips',
  'notification_preferences',
  'idempotency_keys',
] as const;

export type MergeTable = (typeof MERGE_TABLES)[number];

/** Which code path asked for a merge; every request logs one `merge_requested` line per caller. */
export type MergeSource = 'anonymous_hook' | 'apple_native' | 'google_native';

/** A subscription the merge touched, as the tracker knows it (by id, on its flight). */
export interface MergedSubscription {
  readonly id: string;
  readonly flightKey: FlightKey;
}

/**
 * The persist-queue message, consumed by src/queues/merge.ts (increment 8, ruling O2). `moved`
 * are the subscriptions now live under `to` that were `from`'s (their tracker entry still names
 * `from`); `tombstoned` are the conflict losers, whichever side they came from.
 */
export interface MergeJobMessage {
  readonly kind: 'merge';
  readonly from: string;
  readonly to: string;
  readonly moved: readonly MergedSubscription[];
  readonly tombstoned: readonly MergedSubscription[];
}

/** `env.PERSIST_QUEUE` satisfies this; the binding's `send` resolves to a response object. */
export interface MergeQueue {
  send(message: MergeJobMessage): Promise<unknown>;
}

export type MergeOutcome =
  | { readonly merged: true; readonly moved: Readonly<Record<MergeTable, number>> }
  | {
      readonly merged: false;
      readonly reason: 'same_user' | 'already_merged' | 'from_missing' | 'from_not_anonymous';
    };

export interface MergeUsersInput {
  readonly from: string;
  readonly to: string;
}

export interface MergeDeps {
  readonly queue: MergeQueue;
  readonly log: Logger;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The winner of a same-key conflict is the row updated most recently; ties go to `to`. */
function fromWins(fromUpdatedAt: string, toUpdatedAt: string): boolean {
  return new Date(fromUpdatedAt).getTime() > new Date(toUpdatedAt).getTime();
}

async function mergeDevices(tx: Tx, from: string, to: string): Promise<number> {
  // A Drizzle alias rather than raw SQL for the self join, so `updated_at` comes back through
  // the `instant` column's own mapping (ISO UTC) on both sides of the comparison.
  const theirs = alias(devices, 'theirs');
  const conflicts = await tx
    .select({
      fromId: devices.id,
      fromUpdatedAt: devices.updatedAt,
      toId: theirs.id,
      toUpdatedAt: theirs.updatedAt,
    })
    .from(devices)
    .innerJoin(theirs, and(eq(theirs.installId, devices.installId), eq(theirs.userId, to)))
    .where(eq(devices.userId, from));

  for (const conflict of conflicts) {
    const winner = fromWins(conflict.fromUpdatedAt, conflict.toUpdatedAt)
      ? conflict.fromId
      : conflict.toId;
    const loser = winner === conflict.fromId ? conflict.toId : conflict.fromId;
    // Tokens the winner already has are dropped from the loser; the rest follow the winner.
    await tx.execute(sql`
      delete from ${pushTokens} p
      where p.device_id = ${loser}
        and exists (
          select 1 from ${pushTokens} q
          where q.device_id = ${winner} and q.kind = p.kind and q.token = p.token
        )
    `);
    await tx.update(pushTokens).set({ deviceId: winner }).where(eq(pushTokens.deviceId, loser));
    await tx.delete(devices).where(eq(devices.id, loser));
  }

  const moved = await tx
    .update(devices)
    .set({ userId: to })
    .where(eq(devices.userId, from))
    .returning({ id: devices.id });
  return moved.length;
}

async function mergePushTokens(tx: Tx, from: string, to: string): Promise<number> {
  // (kind, token) is unique across users. A token both users hold (the same phone registered
  // under both) keeps the row that belongs to `to` and drops the other.
  await tx.execute(sql`
    delete from ${pushTokens} p
    where p.user_id = ${from}
      and exists (
        select 1 from ${pushTokens} q
        where q.user_id = ${to} and q.kind = p.kind and q.token = p.token
      )
  `);
  const moved = await tx
    .update(pushTokens)
    .set({ userId: to })
    .where(eq(pushTokens.userId, from))
    .returning({ id: pushTokens.id });
  return moved.length;
}

/** The change row a singleton writes: the entity name and its client shape. */
type SingletonTable = typeof userPreferences | typeof notificationPreferences;

async function appendSingletonChange(
  tx: Tx,
  table: SingletonTable,
  to: string,
  op: 'upsert' | 'delete',
  id: string,
  deletedAt: string | null,
): Promise<void> {
  if (table === userPreferences) {
    const [row] = await tx.select().from(userPreferences).where(eq(userPreferences.id, id));
    if (row !== undefined) {
      await appendUserChange(tx, {
        userId: to,
        entity: 'user_preferences',
        entityId: id,
        op,
        row: preferencesSyncRow({ ...row, deletedAt: deletedAt ?? row.deletedAt }),
      });
    }
    return;
  }
  const [row] = await tx
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.id, id));
  if (row !== undefined) {
    await appendUserChange(tx, {
      userId: to,
      entity: 'notification_preferences',
      entityId: id,
      op,
      row: notificationPreferencesSyncRow({ ...row, deletedAt: deletedAt ?? row.deletedAt }),
    });
  }
}

/**
 * One-row-per-user tables with a plain unique index on user_id: newer wins, loser is deleted.
 * Both outcomes reach `to`'s feed: an upsert for the winner, a delete (the tombstone built from
 * the row as it was) for the loser, each written before the row is removed so it can be read.
 */
async function mergeSingleton(
  tx: Tx,
  table: SingletonTable,
  from: string,
  to: string,
  now: string,
): Promise<number> {
  const [fromRow] = await tx
    .select({ id: table.id, updatedAt: table.updatedAt })
    .from(table)
    .where(eq(table.userId, from))
    .limit(1);
  if (fromRow === undefined) {
    return 0;
  }
  const [toRow] = await tx
    .select({ id: table.id, updatedAt: table.updatedAt })
    .from(table)
    .where(eq(table.userId, to))
    .limit(1);
  if (toRow !== undefined) {
    if (!fromWins(fromRow.updatedAt, toRow.updatedAt)) {
      await appendSingletonChange(tx, table, to, 'delete', fromRow.id, now);
      await appendSingletonChange(tx, table, to, 'upsert', toRow.id, null);
      await tx.delete(table).where(eq(table.id, fromRow.id));
      return 0;
    }
    await appendSingletonChange(tx, table, to, 'delete', toRow.id, now);
    await tx.delete(table).where(eq(table.id, toRow.id));
  }
  await tx.update(table).set({ userId: to }).where(eq(table.id, fromRow.id));
  await appendSingletonChange(tx, table, to, 'upsert', fromRow.id, null);
  return 1;
}

async function mergeUsageCounters(tx: Tx, from: string, to: string): Promise<number> {
  // Same (scope, counter, window_start) on both sides: add the counts into `to`'s row, then
  // drop `from`'s. Anything left is re-keyed.
  await tx.execute(sql`
    update ${usageCounters} t
    set count = t.count + f.count
    from ${usageCounters} f
    where t.scope = 'user' and t.subject = ${to}
      and f.scope = 'user' and f.subject = ${from}
      and f.counter = t.counter and f.window_start = t.window_start
  `);
  await tx.execute(sql`
    delete from ${usageCounters} f
    where f.scope = 'user' and f.subject = ${from}
      and exists (
        select 1 from ${usageCounters} t
        where t.scope = 'user' and t.subject = ${to}
          and t.counter = f.counter and t.window_start = f.window_start
      )
  `);
  const moved = await tx
    .update(usageCounters)
    .set({ subject: to })
    .where(and(eq(usageCounters.scope, 'user'), eq(usageCounters.subject, from)))
    .returning({ id: usageCounters.id });
  return moved.length;
}

interface SubscriptionMerge {
  readonly moved: number;
  readonly movedLive: MergedSubscription[];
  readonly tombstoned: MergedSubscription[];
}

/** Rows of `flight_subscriptions` with their flight key, for change rows and the queue message. */
async function subscriptionsWithKeys(tx: Tx, ids: readonly string[]) {
  if (ids.length === 0) {
    return [];
  }
  return tx
    .select({ row: flightSubscriptions, flightKey: flightInstances.flightKey })
    .from(flightSubscriptions)
    .innerJoin(flightInstances, eq(flightInstances.id, flightSubscriptions.flightInstanceId))
    .where(inArray(flightSubscriptions.id, [...ids]));
}

async function mergeFlightSubscriptions(
  tx: Tx,
  from: string,
  to: string,
  now: string,
): Promise<SubscriptionMerge> {
  // The unique key is partial: (user_id, flight_instance_id) where deleted_at is null. Two live
  // rows for the same flight: the newer stays live, the other is tombstoned so the app replays
  // the delete, then everything (including tombstones) is re-keyed.
  const theirs = alias(flightSubscriptions, 'theirs');
  const conflicts = await tx
    .select({
      fromId: flightSubscriptions.id,
      fromUpdatedAt: flightSubscriptions.updatedAt,
      toId: theirs.id,
      toUpdatedAt: theirs.updatedAt,
    })
    .from(flightSubscriptions)
    .innerJoin(
      theirs,
      and(
        eq(theirs.flightInstanceId, flightSubscriptions.flightInstanceId),
        eq(theirs.userId, to),
        isNull(theirs.deletedAt),
      ),
    )
    .where(and(eq(flightSubscriptions.userId, from), isNull(flightSubscriptions.deletedAt)));
  const losers: string[] = [];
  for (const conflict of conflicts) {
    const loser = fromWins(conflict.fromUpdatedAt, conflict.toUpdatedAt)
      ? conflict.toId
      : conflict.fromId;
    losers.push(loser);
    const [before] = await tx
      .select({ liveTracked: flightSubscriptions.liveTracked })
      .from(flightSubscriptions)
      .where(eq(flightSubscriptions.id, loser));
    await tx
      .update(flightSubscriptions)
      .set({ deletedAt: now, liveTracked: false })
      .where(eq(flightSubscriptions.id, loser));
    // The loser's slots go back to `to`, whose counters already hold both users' sums (the
    // counters are merged before the subscriptions), and the flag goes with its slot so nothing
    // releases the same live-tracked slot twice.
    const at = new Date(now);
    await releaseCap(tx, userCap('active_subscriptions', to, at));
    if (before?.liveTracked === true) {
      await releaseCap(tx, userCap('live_tracked', to, at));
    }
  }
  const moved = await tx
    .update(flightSubscriptions)
    .set({ userId: to })
    .where(eq(flightSubscriptions.userId, from))
    .returning({ id: flightSubscriptions.id, deletedAt: flightSubscriptions.deletedAt });

  const movedLive = moved.filter((row) => row.deletedAt === null).map((row) => row.id);
  const tombstoned: MergedSubscription[] = [];
  for (const { row, flightKey } of await subscriptionsWithKeys(tx, losers)) {
    const key = flightKey as FlightKey;
    tombstoned.push({ id: row.id, flightKey: key });
    await appendUserChange(tx, {
      userId: to,
      entity: 'flight_subscriptions',
      entityId: row.id,
      op: 'delete',
      row: subscriptionSyncRow(row, key),
    });
  }
  const live: MergedSubscription[] = [];
  for (const { row, flightKey } of await subscriptionsWithKeys(tx, movedLive)) {
    const key = flightKey as FlightKey;
    live.push({ id: row.id, flightKey: key });
    await appendUserChange(tx, {
      userId: to,
      entity: 'flight_subscriptions',
      entityId: row.id,
      op: 'upsert',
      row: subscriptionSyncRow(row, key),
    });
  }
  return { moved: moved.length, movedLive: live, tombstoned };
}

async function mergeTrips(tx: Tx, from: string, to: string): Promise<number> {
  const moved = await tx
    .update(trips)
    .set({ userId: to })
    .where(eq(trips.userId, from))
    .returning({ id: trips.id });
  return moved.length;
}

async function mergeIdempotencyKeys(tx: Tx, from: string, to: string): Promise<number> {
  await tx.execute(sql`
    delete from ${idempotencyKeys} f
    where f.user_id = ${from}
      and exists (select 1 from ${idempotencyKeys} t where t.user_id = ${to} and t.key = f.key)
  `);
  const moved = await tx
    .update(idempotencyKeys)
    .set({ userId: to })
    .where(eq(idempotencyKeys.userId, from))
    .returning({ key: idempotencyKeys.key });
  return moved.length;
}

export async function mergeUsers(
  db: Db,
  input: MergeUsersInput,
  deps: MergeDeps,
): Promise<MergeOutcome> {
  const { from, to } = input;
  const log = deps.log.child({ merge_from: from, merge_to: to });
  if (from === to) {
    return { merged: false, reason: 'same_user' };
  }

  const outcome = await db.transaction(async (tx) => {
    // Lock the anonymous row for the duration: two concurrent upgrades of the same anonymous
    // user (two taps) serialise here, and the second sees the marker the first wrote.
    const [fromUser] = await tx
      .select({ status: users.status, isAnonymous: users.isAnonymous })
      .from(users)
      .where(eq(users.id, from))
      .for('update')
      .limit(1);
    if (fromUser === undefined) {
      return { merged: false, reason: 'from_missing' } as const;
    }
    if (fromUser.isAnonymous !== true) {
      return { merged: false, reason: 'from_not_anonymous' } as const;
    }
    if (fromUser.status === 'deleting' || fromUser.status === 'deleted') {
      return { merged: false, reason: 'already_merged' } as const;
    }

    const now = new Date().toISOString();
    // In this order: the counters are summed into `to` before a subscription loser gives its
    // slot back.
    const devicesMoved = await mergeDevices(tx, from, to);
    const pushTokensMoved = await mergePushTokens(tx, from, to);
    const preferencesMoved = await mergeSingleton(tx, userPreferences, from, to, now);
    const countersMoved = await mergeUsageCounters(tx, from, to);
    const subscriptions = await mergeFlightSubscriptions(tx, from, to, now);
    const moved: Record<MergeTable, number> = {
      devices: devicesMoved,
      push_tokens: pushTokensMoved,
      user_preferences: preferencesMoved,
      usage_counters: countersMoved,
      flight_subscriptions: subscriptions.moved,
      trips: await mergeTrips(tx, from, to),
      notification_preferences: await mergeSingleton(tx, notificationPreferences, from, to, now),
      idempotency_keys: await mergeIdempotencyKeys(tx, from, to),
    };

    await tx.delete(sessions).where(eq(sessions.userId, from));
    await tx
      .update(users)
      .set({ status: 'deleting', deletionRequestedAt: new Date() })
      .where(and(eq(users.id, from), inArray(users.status, ['active', 'suspended'])));

    return {
      merged: true,
      moved,
      trackers: { moved: subscriptions.movedLive, tombstoned: subscriptions.tombstoned },
    } as const;
  });

  if (!outcome.merged) {
    log.info('merge_skipped', { reason: outcome.reason });
    return outcome;
  }

  log.info('merge_committed', { ...outcome.moved });
  try {
    await deps.queue.send({
      kind: 'merge',
      from,
      to,
      moved: outcome.trackers.moved,
      tombstoned: outcome.trackers.tombstoned,
    });
  } catch (error) {
    // The rows are moved and the marker is set; only the queue message is lost, and with it the
    // tracker re-pointing (the trackers keep naming `from` for the moved subscriptions until the
    // increment 12 housekeeping sweep of `status = 'deleting'` anonymous users re-enqueues it).
    log.error('merge_enqueue_failed', {
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
  return { merged: true, moved: outcome.moved };
}
