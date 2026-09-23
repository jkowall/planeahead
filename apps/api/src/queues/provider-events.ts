/**
 * `provider-events` queue consumer.
 *
 * Webhook deliveries from AeroDataBox and AeroAPI arrive on the `/v1/webhooks/*` routes, which
 * verify and enqueue only, and are processed here. The route never does the work inline: a
 * provider that times out on its own webhook retries it, and a slow database write would turn one
 * delivery into several.
 *
 * Increment 6 adds the parsing and the routing to the owning FlightTracker. The body is treated
 * as a hint that triggers a re-read, never as data: AeroDataBox subscriptions carry no secret and
 * no HMAC, and AeroAPI's alert payload has no timezone and no status.
 *
 * `consumeBatch` acknowledges per message inside its own try/catch, so a poison message never
 * retries the rest of the batch and nothing throws out of the handler.
 */

import { consumeBatch } from './consume';
import type { QueueContext } from './index';

export interface ProviderEventMessage {
  readonly provider: string;
  readonly receivedAt?: string;
  readonly payload?: unknown;
}

export async function handleProviderEventsBatch(
  batch: MessageBatch<ProviderEventMessage>,
  { log }: QueueContext,
): Promise<void> {
  const outcome = await consumeBatch(
    batch,
    (message) => {
      log.debug('provider_event_received', {
        message_id: message.id,
        provider: message.body.provider,
        attempts: message.attempts,
      });
    },
    log,
  );

  log.info('provider_events_batch_done', {
    queue: batch.queue,
    size: batch.messages.length,
    ...outcome,
  });
}
