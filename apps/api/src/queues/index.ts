/**
 * Queue dispatch.
 *
 * One Worker consumes every queue, so `queue()` has to work out which one a batch came from.
 * `batch.queue` carries the deployed queue name, which is environment suffixed
 * (`planeahead-persist-staging`), because a Cloudflare queue accepts exactly one consumer Worker
 * and staging and production live in the same account.
 *
 * `queue()` never throws. An unroutable batch is acknowledged and logged at error level rather
 * than retried: retrying a batch nobody can handle just burns the retry budget and then fills a
 * dead letter queue with messages whose only problem is a name this Worker does not know.
 *
 * Consumers take a `QueueContext` rather than loose arguments, so the execution context is in
 * hand wherever a consumer needs `ctx.waitUntil`.
 *
 * Increment 7 adds the `reconcile` queue and the dead letter consumers: every `-dlq` queue is
 * dispatched to one handler that archives the raw message to R2, raises the ops alert and
 * acknowledges (src/queues/dlq.ts). Increment 12 adds the `housekeeping` queue (and its dead
 * letter queue), which the nightly cron fills with one message per step
 * (src/queues/housekeeping.ts).
 */

import type { Env } from '../env';
import { type Logger, createLogger, errorFields } from '../observability/log';
import { handleDeadLetterBatch } from './dlq';
import { handleHousekeepingBatch } from './housekeeping';
import { handleImportsBatch } from './imports';
import { handleNotifyBatch } from './notify';
import { handlePersistBatch } from './persist';
import { handleProviderEventsBatch } from './provider-events';
import { handleReconcileBatch } from './reconcile';

export type QueueKind =
  'persist' | 'notify' | 'provider-events' | 'imports' | 'reconcile' | 'housekeeping' | 'unknown';

export interface QueueRoute {
  readonly kind: QueueKind;
  /** True for a dead letter queue, handled by `handleDeadLetterBatch`. */
  readonly deadLetter: boolean;
}

export interface QueueContext {
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly log: Logger;
}

const NAME_PREFIX = 'planeahead-';
const ENVIRONMENT_SUFFIXES = ['-local', '-staging', '-production'] as const;
const KINDS: readonly QueueKind[] = [
  'persist',
  'notify',
  'provider-events',
  'imports',
  'reconcile',
  'housekeeping',
];

/** Turns `planeahead-provider-events-dlq-staging` into `{ kind, deadLetter }`. */
export function parseQueueName(queueName: string): QueueRoute {
  let base = queueName.startsWith(NAME_PREFIX) ? queueName.slice(NAME_PREFIX.length) : queueName;
  for (const suffix of ENVIRONMENT_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  const deadLetter = base.endsWith('-dlq');
  if (deadLetter) {
    base = base.slice(0, -'-dlq'.length);
  }
  const kind = KINDS.find((candidate) => candidate === base) ?? 'unknown';
  return { kind, deadLetter };
}

export async function queue(
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const route = parseQueueName(batch.queue);
  const log = createLogger({ queue: batch.queue, queue_kind: route.kind });
  const context: QueueContext = { env, ctx, log };

  try {
    if (route.deadLetter) {
      if (route.kind === 'unknown') {
        log.error('queue_unroutable', { size: batch.messages.length, dead_letter: true });
        batch.ackAll();
        return;
      }
      await handleDeadLetterBatch(batch, route.kind, context);
      return;
    }

    switch (route.kind) {
      case 'persist':
        await handlePersistBatch(batch, context);
        return;
      case 'reconcile':
        await handleReconcileBatch(batch, context);
        return;
      case 'housekeeping':
        await handleHousekeepingBatch(batch, context);
        return;
      case 'notify':
        await handleNotifyBatch(batch as MessageBatch<never>, context);
        return;
      case 'provider-events':
        await handleProviderEventsBatch(batch as MessageBatch<never>, context);
        return;
      case 'imports':
        await handleImportsBatch(batch as MessageBatch<never>, context);
        return;
      case 'unknown':
        log.error('queue_unroutable', { size: batch.messages.length });
        batch.ackAll();
        return;
    }
  } catch (error) {
    // Defence in depth. Each consumer already acknowledges per message, so reaching this means a
    // failure outside the message loop. Throwing here would retry every message in the batch.
    log.error('queue_batch_failed', { size: batch.messages.length, ...errorFields(error) });
  }
}
