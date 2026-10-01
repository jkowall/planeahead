/**
 * The `merge` message on the `persist` queue (increment 8, ruling O2): the FlightTracker half of
 * an anonymous-to-account upgrade.
 *
 * `mergeUsers` (src/auth/merge.ts) re-keys the anonymous user's subscriptions to the account in
 * Postgres and writes their change rows, but a tracker's subscriber list keys each subscriber by
 * the subscription id and still names the ANONYMOUS user id for every moved row. This consumer
 * makes the lists follow Postgres, using only the tracker's existing RPCs:
 *
 *   - every `moved` subscription that is still live under `to`: `unsubscribe` (drops the entry
 *     that names `from`) then `subscribe` under `to` with the row's current preferences;
 *   - every `tombstoned` conflict loser that is still tombstoned: `unsubscribe`.
 *
 * Idempotent: a replayed message re-reads Postgres and lands on the same lists (a moved row that
 * `to` deleted since is skipped, and its unsubscribe route already told the tracker). Best effort
 * per item: a failure is logged, the rest still run, and the message then throws so
 * `consumeBatch` retries it with backoff; a tracker that holds no flight any more (finished and
 * purged) is not a failure, there is nothing to re-point.
 */

import { eq } from 'drizzle-orm';
import { flightSubscriptions, type Db } from '@planeahead/db';
import { DO_CALL_DEADLINE_MS, FlightKeySchema, type FlightKey } from '@planeahead/shared';
import * as z from 'zod';
import type { MergeJobMessage } from '../auth/merge';
import { callWithDeadline } from '../lib/deadline';
import {
  isAbsentTrackerError,
  storedOverrides,
  subscribeTracker,
  unsubscribeTracker,
  type TrackerFor,
} from '../lib/trackers';
import { errorFields, type Logger } from '../observability/log';

const MergedSubscriptionSchema = z.object({ id: z.uuid(), flightKey: FlightKeySchema });

/** The wire shape of `MergeJobMessage`; an older message without the lists re-points nothing. */
export const MergeJobMessageSchema = z.object({
  kind: z.literal('merge'),
  from: z.uuid(),
  to: z.uuid(),
  moved: z.array(MergedSubscriptionSchema).default([]),
  tombstoned: z.array(MergedSubscriptionSchema).default([]),
});

export function isMergeMessage(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { kind?: unknown }).kind === 'merge';
}

export class MergeRepointError extends Error {
  override readonly name = 'MergeRepointError';
}

export interface MergeConsumerDeps {
  readonly db: Db;
  readonly trackerFor: TrackerFor;
  readonly log: Logger;
  readonly deadlineMs?: number;
}

export interface MergeRepointReport {
  readonly repointed: number;
  readonly unsubscribed: number;
  readonly skipped: number;
}

async function currentRow(db: Db, id: string) {
  const [row] = await db
    .select({
      userId: flightSubscriptions.userId,
      deletedAt: flightSubscriptions.deletedAt,
      muted: flightSubscriptions.muted,
      notificationOverrides: flightSubscriptions.notificationOverrides,
    })
    .from(flightSubscriptions)
    .where(eq(flightSubscriptions.id, id))
    .limit(1);
  return row ?? null;
}

/** Re-points the trackers of one merge; throws `MergeRepointError` when any item failed. */
export async function handleMergeMessage(
  body: unknown,
  deps: MergeConsumerDeps,
): Promise<MergeRepointReport> {
  const message: MergeJobMessage = MergeJobMessageSchema.parse(body);
  const deadlineMs = deps.deadlineMs ?? DO_CALL_DEADLINE_MS;
  const log = deps.log.child({ merge_from: message.from, merge_to: message.to });
  let repointed = 0;
  let unsubscribed = 0;
  let skipped = 0;
  let failed = 0;
  const call = async <T>(label: string, flightKey: FlightKey, promise: Promise<T>) => {
    try {
      await callWithDeadline(label, promise, deadlineMs);
      return true;
    } catch (error) {
      if (isAbsentTrackerError(error)) {
        return true;
      }
      failed += 1;
      log.error('merge_repoint_failed', {
        flight_key: flightKey,
        call: label,
        ...errorFields(error),
      });
      return false;
    }
  };

  for (const moved of message.moved) {
    const row = await currentRow(deps.db, moved.id);
    if (row === null || row.userId !== message.to || row.deletedAt !== null) {
      skipped += 1;
      continue;
    }
    const tracker = deps.trackerFor(moved.flightKey);
    if (
      !(await call(
        'unsubscribe',
        moved.flightKey,
        unsubscribeTracker(tracker, { subscriptionId: moved.id }),
      ))
    ) {
      continue;
    }
    const overrides = storedOverrides(row.notificationOverrides);
    const ok = await call(
      'subscribe',
      moved.flightKey,
      subscribeTracker(tracker, {
        subscriptionId: moved.id,
        userId: message.to,
        muted: row.muted,
        ...(overrides === undefined ? {} : { overrides }),
      }),
    );
    if (ok) {
      repointed += 1;
    }
  }
  for (const loser of message.tombstoned) {
    const row = await currentRow(deps.db, loser.id);
    if (row !== null && row.deletedAt === null) {
      // Restored since the merge: its subscriber is wanted.
      skipped += 1;
      continue;
    }
    const tracker = deps.trackerFor(loser.flightKey);
    if (
      await call(
        'unsubscribe',
        loser.flightKey,
        unsubscribeTracker(tracker, { subscriptionId: loser.id }),
      )
    ) {
      unsubscribed += 1;
    }
  }
  const report = { repointed, unsubscribed, skipped };
  if (failed > 0) {
    throw new MergeRepointError(
      `merge re-pointing failed for ${String(failed)} tracker call(s); the message is retried`,
    );
  }
  log.info('merge_repointed', { ...report });
  return report;
}
