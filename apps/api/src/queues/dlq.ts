/**
 * Dead letter consumer (increment 7, ruling J11). One handler for every dead letter queue,
 * dispatched by the `deadLetter` flag `parseQueueName` sets.
 *
 * A message lands here after its queue's retries are spent. Without a consumer Queues deletes it
 * after four days, silently; a thrice-failed outbox row would be gone with no trace. So each
 * message is written raw to `PRIVATE_BUCKET` at `dlq/{queue}/{messageId}.json`, logged at error
 * level, and acknowledged; the batch raises one ops alert (a `fatal` Sentry event) naming the
 * queue and the message ids. A failed archive write is retried with backoff while the
 * `max_retries: 2` every `-dlq` consumer declares in wrangler.jsonc allows (a transient R2
 * failure must not discard the only copy), and acknowledged on the last attempt with the body on
 * the log line: a dead letter message must never loop.
 *
 * A `persist` message archived here is REPORTED to the FlightTracker lifetime that sent it, by
 * `origin` and `seq` (`confirmPersisted` with `deadLettered: true`), and never confirmed: a
 * message dead-letters after five consumer retries spanning about a minute, which a transient
 * Postgres or Hyperdrive outage exceeds as easily as a poison row does, and a confirmed row is
 * deleted by its tracker (the increment 7 re-review found the outbox had stopped healing itself).
 * The tracker stamps the row and keeps it, re-sending it after a spacing that doubles per
 * dead-lettering (an hour, capped at a day), so a transient outage heals on the first re-send
 * after recovery and a poison row is a bounded, decaying stream of these events that settles at
 * one a day, under the tracker's own stuck alert. The raw message under `dlq/persist/` remains
 * the durable record. The tracker ignores a notice for a row or a lifetime it does not hold; a
 * notice that fails here is logged, not retried.
 */

import { PersistMessageIdentityV1, type FlightKey } from '@planeahead/shared';
import { deadLetterArchiveKey, putJsonArchive } from '../r2/archive';
import { raiseOpsAlert, type CaptureMessage } from '../observability/ops-alert';
import { errorFields } from '../observability/log';
import { backoffSeconds } from './consume';
import type { QueueContext, QueueKind } from './index';
import {
  confirmPersistedSeqs,
  defaultTrackerFor,
  noteConfirmation,
  type ConfirmingTracker,
  type Confirmations,
} from './persist';

/** `max_retries` on every `-dlq` consumer in wrangler.jsonc; the last attempt is one past it. */
export const DEAD_LETTER_MAX_RETRIES = 2;

export interface DeadLetterDeps {
  readonly capture?: CaptureMessage | undefined;
  /** Where the raw messages go; the default is `PRIVATE_BUCKET`. */
  readonly bucket?: Pick<R2Bucket, 'put'> | undefined;
  /** Resolves a flight key to its tracker; the default is `FLIGHT_TRACKER.getByName`. */
  readonly trackerFor?: ((flightKey: FlightKey) => ConfirmingTracker) | undefined;
}

export interface DeadLetterRecord {
  readonly queue: string;
  readonly kind: QueueKind;
  readonly messageId: string;
  readonly timestamp: string;
  readonly attempts: number;
  readonly body: unknown;
}

export async function handleDeadLetterBatch(
  batch: MessageBatch<unknown>,
  kind: QueueKind,
  { env, log }: QueueContext,
  deps: DeadLetterDeps = {},
): Promise<void> {
  const bucket = deps.bucket ?? env.PRIVATE_BUCKET;
  const archived: string[] = [];
  const failed: string[] = [];
  const retried: string[] = [];
  const deadLettered: Confirmations = new Map();
  for (const message of batch.messages) {
    const key = deadLetterArchiveKey(kind, message.id);
    const record: DeadLetterRecord = {
      queue: batch.queue,
      kind,
      messageId: message.id,
      timestamp: message.timestamp.toISOString(),
      attempts: message.attempts,
      body: message.body,
    };
    try {
      await putJsonArchive(bucket, key, record);
      archived.push(message.id);
      log.error('queue_dead_letter', {
        queue: batch.queue,
        queue_kind: kind,
        message_id: message.id,
        attempts: message.attempts,
        archive_key: key,
      });
      if (kind === 'persist') {
        const identity = PersistMessageIdentityV1.safeParse(message.body);
        if (identity.success) {
          noteConfirmation(deadLettered, identity.data.origin, identity.data.seq);
        }
      }
    } catch (error) {
      if (message.attempts <= DEAD_LETTER_MAX_RETRIES) {
        const delaySeconds = backoffSeconds(message.attempts);
        retried.push(message.id);
        log.warn('queue_dead_letter_archive_retry', {
          queue: batch.queue,
          queue_kind: kind,
          message_id: message.id,
          attempts: message.attempts,
          delay_seconds: delaySeconds,
          ...errorFields(error),
        });
        message.retry({ delaySeconds });
        continue;
      }
      failed.push(message.id);
      log.error('queue_dead_letter_archive_failed', {
        queue: batch.queue,
        queue_kind: kind,
        message_id: message.id,
        attempts: message.attempts,
        body: record.body,
        ...errorFields(error),
      });
    }
    message.ack();
  }
  // Only archived persist messages are noted above, so the tracker hears of nothing that is not
  // in R2; a message whose archive failed is re-sent by its tracker's ordinary grace rule.
  await confirmPersistedSeqs(deadLettered, deps.trackerFor ?? defaultTrackerFor(env), log, true);
  if (archived.length === 0 && failed.length === 0) {
    // Every message is coming back: the alert belongs to the attempt that settles them.
    return;
  }
  raiseOpsAlert(
    'queue_dead_letter',
    {
      queue: batch.queue,
      queue_kind: kind,
      messages: batch.messages.length,
      archived,
      archive_failed: failed,
      archive_retried: retried,
    },
    log,
    deps.capture,
  );
}
