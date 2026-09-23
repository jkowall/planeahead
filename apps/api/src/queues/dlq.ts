/**
 * Dead letter consumer (increment 7, ruling J11). One handler for every dead letter queue,
 * dispatched by the `deadLetter` flag `parseQueueName` sets.
 *
 * A message lands here after its queue's retries are spent. Without a consumer Queues deletes it
 * after four days, silently; a thrice-failed outbox row would be gone with no trace. So each
 * message is written raw to `PRIVATE_BUCKET` at `dlq/{queue}/{messageId}.json`, logged at error
 * level, and acknowledged; the batch raises one ops alert (a `fatal` Sentry event) naming the
 * queue and the message ids. Acknowledged even when the archive write fails: a dead letter
 * message must never loop, and the log line carries what the archive would have.
 */

import { deadLetterArchiveKey, putJsonArchive } from '../r2/archive';
import { raiseOpsAlert, type CaptureMessage } from '../observability/ops-alert';
import { errorFields } from '../observability/log';
import type { QueueContext, QueueKind } from './index';

export interface DeadLetterDeps {
  readonly capture?: CaptureMessage | undefined;
  /** Where the raw messages go; the default is `PRIVATE_BUCKET`. */
  readonly bucket?: Pick<R2Bucket, 'put'> | undefined;
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
    } catch (error) {
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
  raiseOpsAlert(
    'queue_dead_letter',
    {
      queue: batch.queue,
      queue_kind: kind,
      messages: batch.messages.length,
      archived,
      archive_failed: failed,
    },
    log,
    deps.capture,
  );
}
