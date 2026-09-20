/**
 * `imports` queue consumer.
 *
 * Long running imports: the mailbox scan that finds itineraries (Phase 3, gated on Google's
 * restricted-scope verification), calendar imports and the BTS on-time statistics load.
 *
 * Increment 4 ships the shape and imports nothing. Anything that lands here is expected to be
 * slow and resumable, so the message carries a cursor rather than a whole payload.
 *
 * `consumeBatch` acknowledges per message inside its own try/catch, so a poison message never
 * retries the rest of the batch and nothing throws out of the handler.
 */

import { consumeBatch } from './consume';
import type { QueueContext } from './index';

export interface ImportMessage {
  readonly kind: string;
  readonly cursor?: string;
  readonly payload?: unknown;
}

export async function handleImportsBatch(
  batch: MessageBatch<ImportMessage>,
  { log }: QueueContext,
): Promise<void> {
  const outcome = await consumeBatch(
    batch,
    (message) => {
      log.debug('import_message_received', {
        message_id: message.id,
        kind: message.body.kind,
        attempts: message.attempts,
      });
    },
    log,
  );

  log.info('imports_batch_done', {
    queue: batch.queue,
    size: batch.messages.length,
    ...outcome,
  });
}
