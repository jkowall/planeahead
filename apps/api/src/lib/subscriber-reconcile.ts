/**
 * Tracker subscriber reconciliation (increment 12, housekeeping step 6).
 *
 * Postgres is the record of who follows a flight; a FlightTracker's `subscribers` table only ever
 * follows it (increment 8, ruling O13). The two drift in known ways, each a stray the routes leave
 * on purpose because a wrong unsubscribe loses a real subscription while a stray costs nothing in
 * Phase 0: a subscribe whose 8 s deadline was lost lands in the tracker after the route answered;
 * a deletion that commits after its late check leaves the deleted user's entry; a merge message
 * that never reached the persist queue leaves the moved subscription's entry naming the anonymous
 * user it came from. This pass is the safety net all of them rely on.
 *
 * For each ACTIVE `flight_instances` row (a page per queue message, keyset by id), it reads the
 * tracker's list through the new `listSubscribers` RPC and the instance's live rows, where live
 * means not tombstoned AND owned by a user who is not `deleting` (the anonymous user an increment 8
 * merge marks and keeps). Then, for each tracker entry:
 *
 *   - a live row with the same id and the same user: kept;
 *   - a live row with the same id under ANOTHER user (a merge whose message was lost): re-pointed,
 *     `unsubscribe` then `subscribe` under the row's user with its preferences, what the merge
 *     consumer would have done (the lost-message sweep merge.ts leaves to increment 12);
 *   - no live row: unsubscribed, the anonymous `deleting` users' entries included.
 *
 * An entry younger than `SUBSCRIBER_GRACE_MS` by the tracker's own clock is left alone: a subscribe
 * route calls the tracker before its transaction, so a fresh entry may belong to a row about to
 * commit. A live row with no entry (a tracker that lost it) is subscribed again once the row has
 * been quiet for the same grace, so the list follows Postgres in both directions.
 *
 * After the last page, the anonymous `deleting` users whose merge is older than
 * `ANONYMOUS_DELETION_GRACE_MS` are deleted: their stray live rows (a request authenticated just
 * before the merge revoked the session) are unsubscribed first, then the `users` row goes, and
 * every table that references it cascades. A merge replayed after that finds `from_missing` and
 * does nothing.
 *
 * Every tracker call runs under the route deadline (`DO_CALL_DEADLINE_MS`) at `locationHint`
 * `enam`; a failed call is counted and the rest of the page still runs (the message is not
 * retried for it: the next night's pass repairs what this one could not).
 */

import { and, asc, eq, gt, inArray, isNull, lt, type SQL } from 'drizzle-orm';
import {
  ACTIVE_TRACKING_STATES,
  flightInstances,
  flightSubscriptions,
  users,
  type Db,
} from '@planeahead/db';
import { DO_CALL_DEADLINE_MS, type FlightKey } from '@planeahead/shared';
import { errorFields, type Logger } from '../observability/log';
import type { WallBudget } from './batched-delete';
import { callWithDeadline } from './deadline';
import {
  isAbsentTrackerError,
  listTrackerSubscribers,
  subscribeTracker,
  unsubscribeTracker,
  type SubscriberListingTracker,
} from './trackers';

/** Instances per queue message. */
export const SUBSCRIBER_RECONCILE_PAGE = 50;
/** An entry or a row younger than this is not touched: its route may still be running. */
export const SUBSCRIBER_GRACE_MS = 10 * 60_000;
/** A merged anonymous user is deleted this long after its merge (the merge consumer had its go). */
export const ANONYMOUS_DELETION_GRACE_MS = 60 * 60_000;
/** Anonymous users deleted per run; the rest wait for the next night. */
export const ANONYMOUS_DELETIONS_PER_RUN = 100;

export interface SubscriberReconcileDeps {
  readonly db: Db;
  readonly trackerFor: (flightKey: FlightKey) => SubscriberListingTracker;
  readonly log: Logger;
  readonly now: () => number;
  readonly budget: WallBudget;
  readonly pageSize?: number | undefined;
  /** Test seam: an extra condition on the instances paged (the suite's own rows only). */
  readonly instanceScope?: SQL | undefined;
  readonly deadlineMs?: number | undefined;
}

export interface SubscriberReconcileCounts {
  instances: number;
  kept: number;
  unsubscribed: number;
  repointed: number;
  resubscribed: number;
  young: number;
  skippedTrackers: number;
  failedCalls: number;
  /** Live subscriptions of merged anonymous users unsubscribed just before the users went. */
  anonymousStraysUnsubscribed: number;
  anonymousUsersDeleted: number;
}

export interface SubscriberReconcileResult {
  readonly counts: SubscriberReconcileCounts;
  /** The last instance id handled when more remain; null when the pass is complete. */
  readonly next: string | null;
  readonly anonymousUserIds: readonly string[];
}

interface LiveRow {
  readonly id: string;
  readonly userId: string;
  readonly muted: boolean;
  readonly notificationOverrides: unknown;
  readonly updatedAt: string;
}

function overridesOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function liveRowsFor(db: Db, instanceId: string): Promise<LiveRow[]> {
  return db
    .select({
      id: flightSubscriptions.id,
      userId: flightSubscriptions.userId,
      muted: flightSubscriptions.muted,
      notificationOverrides: flightSubscriptions.notificationOverrides,
      updatedAt: flightSubscriptions.updatedAt,
    })
    .from(flightSubscriptions)
    .innerJoin(users, eq(users.id, flightSubscriptions.userId))
    .where(
      and(
        eq(flightSubscriptions.flightInstanceId, instanceId),
        isNull(flightSubscriptions.deletedAt),
        inArray(users.status, ['active', 'suspended']),
      ),
    );
}

/** One page of the pass; returns the counts and where the next page starts. */
export async function reconcileTrackerSubscribers(
  deps: SubscriberReconcileDeps,
  afterId: string | null,
): Promise<SubscriberReconcileResult> {
  const pageSize = deps.pageSize ?? SUBSCRIBER_RECONCILE_PAGE;
  const deadlineMs = deps.deadlineMs ?? DO_CALL_DEADLINE_MS;
  const counts: SubscriberReconcileCounts = {
    instances: 0,
    kept: 0,
    unsubscribed: 0,
    repointed: 0,
    resubscribed: 0,
    young: 0,
    skippedTrackers: 0,
    failedCalls: 0,
    anonymousStraysUnsubscribed: 0,
    anonymousUsersDeleted: 0,
  };
  const conditions: SQL[] = [inArray(flightInstances.trackingState, [...ACTIVE_TRACKING_STATES])];
  if (afterId !== null) {
    conditions.push(gt(flightInstances.id, afterId));
  }
  if (deps.instanceScope !== undefined) {
    conditions.push(deps.instanceScope);
  }
  const page = await deps.db
    .select({ id: flightInstances.id, flightKey: flightInstances.flightKey })
    .from(flightInstances)
    .where(and(...conditions))
    .orderBy(asc(flightInstances.id))
    .limit(pageSize);

  const call = async (label: string, flightKey: string, promise: Promise<unknown>) => {
    try {
      await callWithDeadline(label, promise, deadlineMs);
      return true;
    } catch (error) {
      if (isAbsentTrackerError(error)) {
        return true;
      }
      counts.failedCalls += 1;
      deps.log.warn('housekeeping_tracker_call_failed', {
        flight_key: flightKey,
        call: label,
        ...errorFields(error),
      });
      return false;
    }
  };

  let lastId: string | null = null;
  for (const instance of page) {
    if (deps.budget.spent) {
      break;
    }
    lastId = instance.id;
    counts.instances += 1;
    const flightKey = instance.flightKey as FlightKey;
    const tracker = deps.trackerFor(flightKey);
    let listed;
    try {
      listed = await callWithDeadline(
        'listSubscribers',
        listTrackerSubscribers(tracker),
        deadlineMs,
      );
    } catch (error) {
      counts.failedCalls += 1;
      deps.log.warn('housekeeping_tracker_call_failed', {
        flight_key: flightKey,
        call: 'listSubscribers',
        ...errorFields(error),
      });
      continue;
    }
    if (listed.phase === 'absent' || listed.phase === 'finished' || listed.phase === 'unknown') {
      counts.skippedTrackers += 1;
      continue;
    }
    const now = deps.now();
    const live = await liveRowsFor(deps.db, instance.id);
    const liveById = new Map(live.map((row) => [row.id, row]));
    const listedIds = new Set(listed.subscribers.map((entry) => entry.subscriptionId));

    for (const entry of listed.subscribers) {
      const row = liveById.get(entry.subscriptionId);
      if (row !== undefined && row.userId === entry.userId) {
        counts.kept += 1;
        continue;
      }
      if (now - entry.createdAtMs < SUBSCRIBER_GRACE_MS) {
        counts.young += 1;
        continue;
      }
      const unsubscribed = await call(
        'unsubscribe',
        flightKey,
        unsubscribeTracker(tracker, { subscriptionId: entry.subscriptionId }),
      );
      if (!unsubscribed) {
        continue;
      }
      if (row === undefined) {
        counts.unsubscribed += 1;
        deps.log.info('housekeeping_subscriber_removed', {
          flight_key: flightKey,
          subscription_id: entry.subscriptionId,
        });
        continue;
      }
      const overrides = overridesOf(row.notificationOverrides);
      if (
        await call(
          'subscribe',
          flightKey,
          subscribeTracker(tracker, {
            subscriptionId: row.id,
            userId: row.userId,
            muted: row.muted,
            ...(overrides === undefined ? {} : { overrides }),
          }),
        )
      ) {
        counts.repointed += 1;
        deps.log.info('housekeeping_subscriber_repointed', {
          flight_key: flightKey,
          subscription_id: row.id,
        });
      }
    }

    for (const row of live) {
      if (listedIds.has(row.id)) {
        continue;
      }
      if (now - Date.parse(row.updatedAt) < SUBSCRIBER_GRACE_MS) {
        counts.young += 1;
        continue;
      }
      const overrides = overridesOf(row.notificationOverrides);
      if (
        await call(
          'subscribe',
          flightKey,
          subscribeTracker(tracker, {
            subscriptionId: row.id,
            userId: row.userId,
            muted: row.muted,
            ...(overrides === undefined ? {} : { overrides }),
          }),
        )
      ) {
        counts.resubscribed += 1;
        deps.log.info('housekeeping_subscriber_restored', {
          flight_key: flightKey,
          subscription_id: row.id,
        });
      }
    }
  }

  // More to do when the budget stopped the loop early, or when the page was full (the next page
  // starts after the last instance handled).
  const processedAll = counts.instances === page.length;
  if (!processedAll || page.length === pageSize) {
    return { counts, next: lastId ?? afterId ?? '', anonymousUserIds: [] };
  }
  const anonymousUserIds = await deleteMergedAnonymousUsers(deps, counts, call);
  counts.anonymousUsersDeleted = anonymousUserIds.length;
  return { counts, next: null, anonymousUserIds };
}

/**
 * The anonymous users an increment 8 merge marked `deleting`, once the merge is old enough: their
 * stray live subscriptions are unsubscribed from their trackers, then the rows are deleted (the
 * status is re-checked in the DELETE, so a row that changed since the read is left alone).
 */
async function deleteMergedAnonymousUsers(
  deps: SubscriberReconcileDeps,
  counts: SubscriberReconcileCounts,
  call: (label: string, flightKey: string, promise: Promise<unknown>) => Promise<boolean>,
): Promise<string[]> {
  const cutoff = new Date(deps.now() - ANONYMOUS_DELETION_GRACE_MS);
  const candidates = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.status, 'deleting'),
        eq(users.isAnonymous, true),
        lt(users.deletionRequestedAt, cutoff),
      ),
    )
    .orderBy(asc(users.id))
    .limit(ANONYMOUS_DELETIONS_PER_RUN);
  if (candidates.length === 0) {
    return [];
  }
  const ids = candidates.map((row) => row.id);
  const strays = await deps.db
    .select({ id: flightSubscriptions.id, flightKey: flightInstances.flightKey })
    .from(flightSubscriptions)
    .innerJoin(flightInstances, eq(flightInstances.id, flightSubscriptions.flightInstanceId))
    .where(and(inArray(flightSubscriptions.userId, ids), isNull(flightSubscriptions.deletedAt)));
  for (const stray of strays) {
    if (
      await call(
        'unsubscribe',
        stray.flightKey,
        unsubscribeTracker(deps.trackerFor(stray.flightKey as FlightKey), {
          subscriptionId: stray.id,
        }),
      )
    ) {
      counts.anonymousStraysUnsubscribed += 1;
    }
  }
  const deleted = await deps.db
    .delete(users)
    .where(
      and(
        inArray(users.id, ids),
        eq(users.status, 'deleting'),
        eq(users.isAnonymous, true),
        lt(users.deletionRequestedAt, cutoff),
      ),
    )
    .returning({ id: users.id });
  return deleted.map((row) => row.id);
}
