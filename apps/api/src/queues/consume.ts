/**
 * The per-message loop every queue consumer uses.
 *
 * A thrown handler retries the WHOLE batch, including the messages that already succeeded, so a
 * single poison message can pin a hundred good ones in a retry loop. Every consumer therefore
 * acknowledges per message inside its own try/catch, and `consumeBatch` never throws.
 *
 * Retries carry an explicit backoff. `max_retries` is 5 in wrangler.jsonc, after which the
 * message goes to that queue's dead letter queue. The dead letter consumers arrive in increment
 * 7; until then a message that fails six times is retained by Queues and then dropped.
 */

import type { Logger } from '../observability/log';
import { errorFields } from '../observability/log';

/** Delay before the next attempt, in seconds. Doubling, capped well under the platform maximum. */
export function backoffSeconds(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 8));
  return Math.min(2 ** exponent, 300);
}

export type MessageHandler<Body> = (message: Message<Body>) => Promise<void> | void;

export interface BatchOutcome {
  readonly acked: number;
  readonly retried: number;
}

export async function consumeBatch<Body>(
  batch: MessageBatch<Body>,
  handler: MessageHandler<Body>,
  log: Logger,
): Promise<BatchOutcome> {
  let acked = 0;
  let retried = 0;

  for (const message of batch.messages) {
    try {
      await handler(message);
      message.ack();
      acked += 1;
    } catch (error) {
      const delaySeconds = backoffSeconds(message.attempts);
      retried += 1;
      log.error('queue_message_failed', {
        queue: batch.queue,
        message_id: message.id,
        attempts: message.attempts,
        delay_seconds: delaySeconds,
        ...errorFields(error),
      });
      message.retry({ delaySeconds });
    }
  }

  return { acked, retried };
}
