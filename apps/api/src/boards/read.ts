/**
 * The Worker's read path for one board bucket (increment 18, ruling B3): KV first, with a 30 s
 * edge cache, and the `AirportState` object only on a miss or once the copy is past its
 * `freshUntil`. N viewers therefore cost one provider call per bucket per freshness window (the
 * object coalesces the misses). When the object cannot be reached, a KV copy is served stale
 * rather than nothing. The routes (part 2 of the increment) filter and group what this returns;
 * the airport has already been resolved (`resolveBoardAirportCached`), so an unknown code never
 * reaches here.
 */

import {
  BoardBucketResponseV1,
  type BoardBucketRequestV1,
  type BoardBucketResponseV1 as BoardBucketAnswer,
} from '@planeahead/shared';
import { createLogger, errorFields, type Logger } from '../observability/log';
import { readBoardKv } from './cache';

/** What the object answers, plus where this answer came from. */
export type BoardBucketRead = BoardBucketAnswer & { readonly source: 'kv' | 'object' };

/** The `AirportState` surface this path uses; narrowed so a test can hand in a fake. */
export interface AirportStateRpc {
  getBucket(input: unknown): Promise<unknown>;
}

export interface BoardReadEnv {
  readonly CACHE: Pick<KVNamespace, 'getWithMetadata'>;
  readonly AIRPORT_STATE: { getByName(name: string): AirportStateRpc };
}

export async function readBoardBucket(
  env: BoardReadEnv,
  request: BoardBucketRequestV1,
  nowMs: number = Date.now(),
  log: Logger = createLogger(),
): Promise<BoardBucketRead> {
  const copy = await readBoardKv(env.CACHE, request.airportIcao, request.bucketStartLocal);
  const fromCopy = (stale: boolean, reason?: string): BoardBucketRead | null =>
    copy === null
      ? null
      : {
          rpcVersion: 1,
          airportIcao: copy.meta.airportIcao,
          bucketStartLocal: copy.meta.bucketStartLocal,
          state: 'ok',
          coverage: copy.meta.coverage,
          rows: copy.rows,
          fetchedAt: copy.meta.fetchedAt,
          freshUntil: copy.meta.freshUntil,
          staleUntil: copy.meta.staleUntil,
          stale,
          ...(reason === undefined ? {} : { reason }),
          source: 'kv',
        };
  if (copy !== null && nowMs < Date.parse(copy.meta.freshUntil)) {
    return fromCopy(false) as BoardBucketRead;
  }
  try {
    const answer = await env.AIRPORT_STATE.getByName(request.airportIcao).getBucket(request);
    return { ...BoardBucketResponseV1.parse(answer), source: 'object' };
  } catch (error) {
    const fallback = fromCopy(true, 'object_unreachable');
    log.error('board_object_unreachable', {
      airport_icao: request.airportIcao,
      bucket: request.bucketStartLocal,
      served_kv_copy: fallback !== null,
      ...errorFields(error),
    });
    if (fallback === null) {
      throw error;
    }
    return fallback;
  }
}
