/**
 * `persist` queue consumer.
 *
 * This is the only path from a Durable Object to Postgres (ADR 0007): a tracker appends outbox
 * rows, flushes them here, and this consumer writes `flight_instances`, `flight_events` and
 * `provider_calls` and emits the matching Analytics Engine points.
 *
 * Increment 4 ships the shape and writes nothing. What is already fixed here:
 *
 *   - one `AnalyticsBudget` per invocation, so the 200-point budget is counted across the whole
 *     batch rather than per message;
 *   - `consumeBatch` acknowledges per message, so one bad row never retries a good one;
 *   - `max_batch_size` is 100 and `max_retries` is 5 in wrangler.jsonc.
 *
 * Increment 7 adds the writes, the `version` monotonic upsert, the `flight_key + seq` idempotency
 * key, the `persist-ack` reply to the originating tracker and `max_concurrency: 10` (the Neon
 * connection budget, not a throughput choice).
 */

import { AnalyticsBudget } from './analytics';
import { consumeBatch } from './consume';
import type { QueueContext } from './index';

/** Envelope every outbox row carries. Increment 7 replaces `payload` with a discriminated union. */
export interface PersistMessage {
  readonly kind: string;
  readonly flightKey?: string;
  readonly seq?: number;
  readonly payload?: unknown;
}

export async function handlePersistBatch(
  batch: MessageBatch<PersistMessage>,
  { env, log }: QueueContext,
): Promise<void> {
  const analytics = new AnalyticsBudget(env.PROVIDER_CALLS, log);

  const outcome = await consumeBatch(
    batch,
    (message) => {
      // Increment 7: withDb upserts here, then one Analytics Engine point per provider call.
      // Nothing is written yet, so every message is acknowledged after being counted.
      log.debug('persist_message_received', {
        message_id: message.id,
        kind: message.body.kind,
        attempts: message.attempts,
      });
    },
    log,
  );

  analytics.report('persist_analytics');
  log.info('persist_batch_done', {
    queue: batch.queue,
    size: batch.messages.length,
    ...outcome,
  });
}
