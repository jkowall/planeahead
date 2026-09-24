/**
 * Replay of dead-lettered persist messages (increment 12, housekeeping step 7; ADR 0011).
 *
 * The dead-letter consumer archives every `persist` message that exhausted its retries under
 * `dlq/persist/{messageId}.json` in `PRIVATE_BUCKET` (src/queues/dlq.ts). A FlightTracker keeps
 * its own copy of such a row and re-sends it on a doubling spacing, but the DesignatorResolver
 * deletes its provider-call records on send, so for those the R2 object is the only copy left: the
 * accepted Phase 0 residual ADR 0011 records, closed here. Every archived message at least
 * `DLQ_REPLAY_MIN_AGE_MS` old is sent back to the persist queue and its object deleted once the
 * send is accepted (the persist consumer's writes are idempotent, so a message that reaches it
 * twice, from here and from its tracker, is stored once). Paged with R2's list cursor, one page
 * per queue message.
 *
 * One addition to the ruling, so a poison message cannot loop for ever: every replay stamps
 * `replayCount` on the body (the persist schemas are loose objects, so the field passes through
 * untouched), and a message dead-lettered again after `DLQ_REPLAY_MAX` replays is moved to
 * `dlq/persist-parked/` with an error log instead of being replayed a fourth time. A body that is
 * not a JSON object is parked the same way.
 */

import { errorFields, type Logger } from '../observability/log';
import type { WallBudget } from './batched-delete';

export const DLQ_PERSIST_PREFIX = 'dlq/persist/';
export const DLQ_PARKED_PREFIX = 'dlq/persist-parked/';
/** An archive younger than this is left for the next run (a message just dead-lettered). */
export const DLQ_REPLAY_MIN_AGE_MS = 60 * 60_000;
/** Replays per message before it is parked. */
export const DLQ_REPLAY_MAX = 3;
/** Objects listed per page (R2's own maximum is 1,000). */
export const DLQ_REPLAY_PAGE = 100;

export interface DlqReplayDeps {
  readonly bucket: Pick<R2Bucket, 'list' | 'get' | 'put' | 'delete'>;
  readonly sink: Pick<Queue, 'send'>;
  readonly log: Logger;
  readonly now: () => number;
  readonly budget: WallBudget;
  readonly pageSize?: number | undefined;
}

export interface DlqReplayCounts {
  listed: number;
  replayed: number;
  young: number;
  parked: number;
  failed: number;
}

export interface DlqReplayResult {
  readonly counts: DlqReplayCounts;
  /** R2's list cursor when more objects remain; null when the prefix is done. */
  readonly next: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function replayDeadLetteredPersist(
  deps: DlqReplayDeps,
  cursor: string | null,
): Promise<DlqReplayResult> {
  const counts: DlqReplayCounts = { listed: 0, replayed: 0, young: 0, parked: 0, failed: 0 };
  const listing = await deps.bucket.list({
    prefix: DLQ_PERSIST_PREFIX,
    limit: deps.pageSize ?? DLQ_REPLAY_PAGE,
    ...(cursor === null ? {} : { cursor }),
  });
  let stoppedEarly = false;
  for (const object of listing.objects) {
    if (deps.budget.spent) {
      stoppedEarly = true;
      break;
    }
    counts.listed += 1;
    if (deps.now() - object.uploaded.getTime() < DLQ_REPLAY_MIN_AGE_MS) {
      counts.young += 1;
      continue;
    }
    try {
      const stored = await deps.bucket.get(object.key);
      if (stored === null) {
        continue;
      }
      const text = await stored.text();
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        record = null;
      }
      const body = isObject(record) ? record['body'] : undefined;
      const replays =
        isObject(body) && typeof body['replayCount'] === 'number' ? body['replayCount'] : 0;
      if (!isObject(body) || replays >= DLQ_REPLAY_MAX) {
        const parkedKey = `${DLQ_PARKED_PREFIX}${object.key.slice(DLQ_PERSIST_PREFIX.length)}`;
        await deps.bucket.put(parkedKey, text, {
          httpMetadata: { contentType: 'application/json' },
        });
        await deps.bucket.delete(object.key);
        counts.parked += 1;
        deps.log.error('dlq_replay_parked', {
          key: object.key,
          parked_key: parkedKey,
          replays,
          reason: isObject(body) ? 'replay_limit' : 'unreadable',
        });
        continue;
      }
      await deps.sink.send({ ...body, replayCount: replays + 1 });
      await deps.bucket.delete(object.key);
      counts.replayed += 1;
    } catch (error) {
      counts.failed += 1;
      deps.log.warn('dlq_replay_failed', { key: object.key, ...errorFields(error) });
    }
  }
  if (stoppedEarly) {
    // The objects not reached are still there; a fresh listing from the same cursor finds them
    // (replayed ones are gone, so nothing is sent twice by the continuation).
    return { counts, next: cursor ?? '' };
  }
  return { counts, next: listing.truncated ? listing.cursor : null };
}
