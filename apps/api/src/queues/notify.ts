/**
 * `notify` queue consumer.
 *
 * Push notifications, Live Activity updates and the magic-link mail fan-out land here. Phase 1
 * owns the senders: an APNs HTTP/2 adapter for Live Activities (Expo's push service cannot start
 * or update one), an FCM v1 adapter for Android and the Expo adapter for plain notifications.
 *
 * Increment 4 ships the shape and sends nothing. Two constraints are already known and recorded
 * here so the Phase 1 builder does not rediscover them: Workers to APNs over HTTP/2 does not work
 * in local workerd on macOS, so the delivery path needs a staging smoke job rather than a local
 * test; and notification de-duplication lives in the FlightTracker's `notif_dedupe` table, not
 * here, because only the tracker knows what it already told a user.
 *
 * `consumeBatch` acknowledges per message inside its own try/catch, so a poison message never
 * retries the rest of the batch and nothing throws out of the handler.
 */

import { consumeBatch } from './consume';
import type { QueueContext } from './index';

export interface NotifyMessage {
  readonly kind: string;
  readonly userId?: string;
  readonly payload?: unknown;
}

export async function handleNotifyBatch(
  batch: MessageBatch<NotifyMessage>,
  { log }: QueueContext,
): Promise<void> {
  const outcome = await consumeBatch(
    batch,
    (message) => {
      log.debug('notify_message_received', {
        message_id: message.id,
        kind: message.body.kind,
        attempts: message.attempts,
      });
    },
    log,
  );

  log.info('notify_batch_done', {
    queue: batch.queue,
    size: batch.messages.length,
    ...outcome,
  });
}
