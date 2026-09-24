/**
 * Replay of dead-lettered persist messages (increment 12, housekeeping step 7; ADR 0011).
 *
 * The dead-letter consumer archives every `persist` message that exhausted its retries under
 * `dlq/persist/{messageId}.json` in `PRIVATE_BUCKET` (src/queues/dlq.ts). Which archives are
 * replayed depends on who sent them (ruling AA16):
 *
 *   - The DesignatorResolver (`designator_resolver:` origins) deletes its provider-call records on
 *     send, and the ProviderBudget object (`provider_budget:` origins) marks its rows sent and
 *     deletes its whole storage at the end of its day, so for those the R2 object is the only copy
 *     left: the accepted Phase 0 residual ADR 0011 records, closed here. Every such archive at
 *     least `DLQ_REPLAY_MIN_AGE_MS` old is sent back to the persist queue and its object deleted
 *     once the send is accepted (the persist consumer's writes are idempotent).
 *   - Every other origin keeps its own copy or is not an outbox row: a FlightTracker keeps every
 *     dead-lettered row and re-sends it itself on a spacing that doubles to a day, so replaying its
 *     archive would only multiply the dead-letterings (and the ops alerts) of a poison row, each
 *     tracker re-send arriving here as a fresh archive. Those archives are left in place as the
 *     record (`kept`), for a person and for the bucket's 30-day lifecycle rule.
 *
 * Paged with R2's list cursor, one page per queue message. So a poison message of the two
 * replayed origins cannot loop for ever, every replay stamps `replayCount` on the body (the
 * persist schemas are loose objects, so the field passes through untouched), and one dead-lettered
 * again after `DLQ_REPLAY_MAX` replays is moved to `dlq/persist-parked/` with an error log instead
 * of being replayed a fourth time. A body that is not a JSON object is parked the same way.
 */

import { DESIGNATOR_RESOLVER_ORIGIN_PREFIX } from '@planeahead/shared';
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

/**
 * The ProviderBudget object's outbox origin prefix; the whole origin is
 * `provider_budget:{provider}:{utcDate}[:{shard}]@{epoch}` (built in `#flushOutbox`,
 * src/do/provider-budget.ts).
 */
export const PROVIDER_BUDGET_ORIGIN_PREFIX = 'provider_budget:';

/** The origins whose archive is the only copy left, and so the only ones replayed (AA16). */
export const REPLAYED_ORIGIN_PREFIXES: readonly string[] = [
  DESIGNATOR_RESOLVER_ORIGIN_PREFIX,
  PROVIDER_BUDGET_ORIGIN_PREFIX,
];

/** Whether an archived body's sender keeps no copy of it, so the archive must be replayed. */
export function isReplayedOrigin(origin: unknown): boolean {
  return (
    typeof origin === 'string' &&
    REPLAYED_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix))
  );
}

export interface DlqReplayCounts {
  listed: number;
  replayed: number;
  young: number;
  /** Archives of an origin that keeps its own copy (a FlightTracker), left in place. */
  kept: number;
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
  const counts: DlqReplayCounts = {
    listed: 0,
    replayed: 0,
    young: 0,
    kept: 0,
    parked: 0,
    failed: 0,
  };
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
      if (isObject(body) && !isReplayedOrigin(body['origin'])) {
        // The sender re-sends its own copy (or it is not an outbox row): the archive is the record.
        counts.kept += 1;
        continue;
      }
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
