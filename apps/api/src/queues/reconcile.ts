/**
 * `reconcile` queue consumer (increment 7, ruling J10). The cron (src/cron/reconcile.ts) pages
 * `flight_instances` for active rows whose refresh is more than twenty minutes overdue and fans
 * the keys out here, one message each, because a sub-hourly cron has 30 seconds of CPU and the
 * Durable Object round trips belong in a consumer with retries.
 *
 * Per message: `health()` on the tracker, and when the phase is not `finished` and `alarmAt` is
 * null, `forceRefresh('reconcile')`, which polls once and re-arms the cadence. The phase is
 * checked before the alarm because a running alarm handler also reports a null alarm; a tracker
 * that answers `absent` (finished and deleted, or never seeded) is left alone and logged.
 */

import {
  RPC_SCHEMA_VERSION,
  ReconcileMessageV1,
  type Exact,
  type FlightKey,
  type ForceRefreshResponseV1,
  type HealthResponseV1,
} from '@planeahead/shared';
import { consumeBatch } from './consume';
import type { QueueContext } from './index';

/** The tracker RPCs the consumer needs, narrowed so a test can hand in a fake. */
export interface ReconcilingTracker {
  health(): Promise<Exact<HealthResponseV1>>;
  forceRefresh(input: unknown): Promise<Exact<ForceRefreshResponseV1>>;
}

export interface ReconcileDeps {
  readonly trackerFor?: ((flightKey: FlightKey) => ReconcilingTracker) | undefined;
}

export type ReconcileOutcome = 'rearmed' | 'alarm_present' | 'finished' | 'absent' | 'inflight';

/** One key: the decision and what was done. Exported so a test can drive it without a batch. */
export async function reconcileFlight(
  tracker: ReconcilingTracker,
  flightKey: FlightKey,
): Promise<ReconcileOutcome> {
  const health = await tracker.health();
  if (health.phase === 'absent') {
    return 'absent';
  }
  if (health.phase === 'finished') {
    return 'finished';
  }
  if (health.inflight) {
    return 'inflight';
  }
  if (health.alarmAt !== null) {
    return 'alarm_present';
  }
  await tracker.forceRefresh({ rpcVersion: RPC_SCHEMA_VERSION, reason: 'reconcile' });
  void flightKey;
  return 'rearmed';
}

export async function handleReconcileBatch(
  batch: MessageBatch<unknown>,
  { env, log }: QueueContext,
  deps: ReconcileDeps = {},
): Promise<void> {
  const trackerFor =
    deps.trackerFor ??
    ((flightKey: FlightKey): ReconcilingTracker =>
      env.FLIGHT_TRACKER.getByName(flightKey, { locationHint: 'enam' }));
  const counts: Record<ReconcileOutcome, number> = {
    rearmed: 0,
    alarm_present: 0,
    finished: 0,
    absent: 0,
    inflight: 0,
  };
  const outcome = await consumeBatch(
    batch,
    async (message) => {
      const parsed = ReconcileMessageV1.safeParse(message.body);
      if (!parsed.success) {
        log.error('reconcile_message_invalid', {
          message_id: message.id,
          issue: parsed.error.issues[0]?.message,
        });
        return;
      }
      const result = await reconcileFlight(
        trackerFor(parsed.data.flightKey),
        parsed.data.flightKey,
      );
      counts[result] += 1;
      log.info('reconcile_flight', {
        flight_key: parsed.data.flightKey,
        outcome: result,
        next_refresh_at: parsed.data.nextRefreshAt,
      });
    },
    log,
  );
  log.info('reconcile_batch_done', {
    queue: batch.queue,
    size: batch.messages.length,
    ...counts,
    ...outcome,
  });
}
