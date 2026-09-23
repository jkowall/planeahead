/**
 * The anonymous-to-account merge.
 *
 * A user who signs in anonymously and later upgrades (magic link, native Google, native Apple)
 * gets a NEW user row from Better Auth, because the upgrade finds or creates the account by
 * email or provider subject. Everything the anonymous user did has to follow them: devices,
 * push tokens, preferences, counters, subscriptions, trips, notification preferences and the
 * idempotency replay store. `mergeUsers` moves those eight tables in ONE transaction and then
 * enqueues a `merge` job on the `persist` queue for the parts of the system that are not in
 * Postgres (the FlightTracker subscriber lists, and the deletion of the anonymous row itself,
 * which increment 8's consumer performs after verifying nothing points at it any more).
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
 * resets on sign-in is a quota that does not exist. Push tokens follow their device; a token
 * whose device lost the conflict is re-pointed at the surviving device, or dropped when the
 * survivor already holds the same token.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  type Db,
  devices,
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

/** The persist-queue message. The consumer arrives in increment 8. */
export interface MergeJobMessage {
  readonly kind: 'merge';
  readonly from: string;
  readonly to: string;
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

/** One-row-per-user tables with a plain unique index on user_id: newer wins, loser is deleted. */
async function mergeSingleton(
  tx: Tx,
  table: typeof userPreferences | typeof notificationPreferences,
  from: string,
  to: string,
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
      await tx.delete(table).where(eq(table.id, fromRow.id));
      return 0;
    }
    await tx.delete(table).where(eq(table.id, toRow.id));
  }
  await tx.update(table).set({ userId: to }).where(eq(table.id, fromRow.id));
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

async function mergeFlightSubscriptions(tx: Tx, from: string, to: string): Promise<number> {
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
  const now = new Date().toISOString();
  for (const conflict of conflicts) {
    const loser = fromWins(conflict.fromUpdatedAt, conflict.toUpdatedAt)
      ? conflict.toId
      : conflict.fromId;
    await tx
      .update(flightSubscriptions)
      .set({ deletedAt: now })
      .where(eq(flightSubscriptions.id, loser));
  }
  const moved = await tx
    .update(flightSubscriptions)
    .set({ userId: to })
    .where(eq(flightSubscriptions.userId, from))
    .returning({ id: flightSubscriptions.id });
  return moved.length;
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

    const moved: Record<MergeTable, number> = {
      devices: await mergeDevices(tx, from, to),
      push_tokens: await mergePushTokens(tx, from, to),
      user_preferences: await mergeSingleton(tx, userPreferences, from, to),
      usage_counters: await mergeUsageCounters(tx, from, to),
      flight_subscriptions: await mergeFlightSubscriptions(tx, from, to),
      trips: await mergeTrips(tx, from, to),
      notification_preferences: await mergeSingleton(tx, notificationPreferences, from, to),
      idempotency_keys: await mergeIdempotencyKeys(tx, from, to),
    };

    await tx.delete(sessions).where(eq(sessions.userId, from));
    await tx
      .update(users)
      .set({ status: 'deleting', deletionRequestedAt: new Date() })
      .where(and(eq(users.id, from), inArray(users.status, ['active', 'suspended'])));

    return { merged: true, moved } as const;
  });

  if (!outcome.merged) {
    log.info('merge_skipped', { reason: outcome.reason });
    return outcome;
  }

  log.info('merge_committed', { ...outcome.moved });
  try {
    await deps.queue.send({ kind: 'merge', from, to });
  } catch (error) {
    // The rows are moved and the marker is set; only the queue message is lost. The
    // housekeeping sweep of `status = 'deleting'` anonymous users (increment 8) re-enqueues.
    log.error('merge_enqueue_failed', {
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
  return outcome;
}
