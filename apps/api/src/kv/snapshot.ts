/**
 * The KV snapshot a FlightTracker publishes (increment 7): `flight:snapshot:{key}` in `CACHE`,
 * 180 seconds, read through by `GET /v1/flights/:id` (increment 8) so a detail page never
 * wakes the object for a read.
 *
 * KV allows one write a second per key and answers 429 above it. The tracker writes at most
 * once every `SNAPSHOT_KV_DEBOUNCE_MS` (stored state in its `kv_debounce` table, never a
 * `setTimeout`, which would keep the object from hibernating), off the alarm's critical path
 * (`ctx.waitUntil`), and a failed write, a 429 included, is logged and never fails the alarm:
 * the next flush writes again.
 */

import type { FlightStatus, FlightKey, TrackerHealthPhase } from '@planeahead/shared';
import { errorFields, type Logger } from '../observability/log';

export const SNAPSHOT_KV_TTL_SECONDS = 180;
export const SNAPSHOT_KV_DEBOUNCE_MS = 2_000;

export function snapshotKvKey(flightKey: FlightKey): string {
  return `flight:snapshot:${flightKey}`;
}

/** What the tracker writes; the route parses it with `SnapshotKvValue` in mind, loosely. */
export interface SnapshotKvValue {
  readonly rpcVersion: 1;
  readonly flightKey: FlightKey;
  readonly phase: TrackerHealthPhase;
  readonly version: number;
  readonly snapshot: FlightStatus | null;
  readonly nextRefreshAt: string | null;
  readonly writtenAt: string;
}

/** Writes the snapshot; returns whether KV accepted it. Never throws. */
export async function writeSnapshotKv(
  kv: Pick<KVNamespace, 'put'>,
  value: SnapshotKvValue,
  log: Logger,
): Promise<boolean> {
  try {
    await kv.put(snapshotKvKey(value.flightKey), JSON.stringify(value), {
      expirationTtl: SNAPSHOT_KV_TTL_SECONDS,
    });
    return true;
  } catch (error) {
    log.warn('flight_snapshot_kv_write_failed', errorFields(error));
    return false;
  }
}
