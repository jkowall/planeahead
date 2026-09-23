/**
 * `provider-events` queue consumer.
 *
 * Webhook deliveries from AeroDataBox and AeroAPI arrive on the `/v1/webhooks/*` routes, which
 * verify the path token, parse and validate, and enqueue only (increment 6,
 * src/routes/webhooks.ts); they are processed here. The route never does the work inline: a
 * provider that times out on its own webhook retries it, and a slow database write would turn one
 * delivery into several.
 *
 * Increment 7 adds the routing to the owning FlightTracker. The body is treated as a hint, never
 * as data: an AeroDataBox delivery triggers a re-read (its subscriptions carry no secret and no
 * HMAC), and an AeroAPI delivery is a patch merged onto the tracker's last snapshot (it has no
 * timezone and no status).
 *
 * `consumeBatch` acknowledges per message inside its own try/catch, so a poison message never
 * retries the rest of the batch and nothing throws out of the handler.
 */

import type { ProviderEventV1 } from '@planeahead/shared';
import { consumeBatch } from './consume';
import type { QueueContext } from './index';

/**
 * One message per provider event, exactly as the webhook route validated and enqueued it
 * (`ProviderEventV1`, versioned like every other cross-boundary payload). Increment 7 parses it
 * again on the way in, because a message can outlive the deploy that wrote it.
 */
export type ProviderEventMessage = ProviderEventV1;

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
        kind: message.body.kind,
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
