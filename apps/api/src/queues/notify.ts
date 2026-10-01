/**
 * `notify` queue consumer.
 *
 * Stage 1 of the push path (docs/plans/phase1-plan.md section 4): from increment 15 it resolves a
 * flight event's subscribers, preferences and live tokens, writes the `notifications` rows, and
 * sends `push` jobs (`PushJobV1`, up to 50 targets each). It sends nothing itself: the `push`
 * consumer (increment 14, src/queues/push.ts) holds the transport, APNs direct and FCM HTTP v1
 * with raw device tokens behind `PushTransport`; Expo's push service is only the last fallback
 * the transport's comment designs.
 *
 * Increment 4 ships the shape and sends nothing. Two constraints are recorded here so the Phase 1
 * builder does not rediscover them: workerd has no HTTP/2 client on any OS, so APNs is proven by
 * the staging send (the admin page's test push, increment 14) and every local test injects
 * `fetch`; and notification de-duplication lives in the FlightTracker's `notif_dedupe` table, not
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
