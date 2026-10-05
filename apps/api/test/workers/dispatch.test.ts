/**
 * Queue and cron dispatch.
 *
 * Not in the increment 4 spec's test list, but the two rules these handlers exist to enforce are
 * exactly the kind that rot silently once real work lands on top of them:
 *
 *   - a thrown queue handler retries the WHOLE batch, so every consumer acknowledges per message
 *     inside its own try/catch and `queue()` never throws;
 *   - `scheduled()` routes on the five-field cron expression from wrangler.jsonc, so a one-word
 *     edit to `triggers.crons` that does not also change `src/cron/index.ts` must fail here
 *     rather than in production at 03:00 UTC.
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  CRON_HANDLERS,
  type CronHandlers,
  HOUSEKEEPING_CRON,
  PUSH_SOAK_CRON,
  RECONCILE_CRON,
  runCron,
  scheduled,
} from '../../src/cron/index';
import { type LogLine, createLogger } from '../../src/observability/log';
import { backoffSeconds, consumeBatch } from '../../src/queues/consume';
import { parseQueueName, queue } from '../../src/queues/index';

function capture(): { lines: LogLine[]; log: ReturnType<typeof createLogger> } {
  const lines: LogLine[] = [];
  return { lines, log: createLogger({}, (line) => lines.push(line)) };
}

/**
 * The Worker's env with capturing queue producers: the daily cron plans onto the housekeeping
 * queue, and a real send would hand the whole shared test database to the housekeeping consumer
 * running in the pool (crons.test.ts drives the steps with their test seams instead).
 */
function envWithCapturedQueues(): { env: typeof env; sent: unknown[] } {
  const sent: unknown[] = [];
  const sink = {
    send: (body: unknown) => {
      sent.push(body);
      return Promise.resolve();
    },
    sendBatch: (messages: Iterable<MessageSendRequest<unknown>>) => {
      for (const message of messages) {
        sent.push(message.body);
      }
      return Promise.resolve();
    },
  };
  return {
    env: { ...env, HOUSEKEEPING_QUEUE: sink, RECONCILE_QUEUE: sink } as unknown as typeof env,
    sent,
  };
}

async function runQueue(queueName: string, bodies: readonly unknown[]) {
  const batch = createMessageBatch(
    queueName,
    bodies.map((body, index) => ({
      id: `message-${index}`,
      timestamp: new Date(),
      attempts: 1,
      body,
    })),
  );
  const ctx = createExecutionContext();
  await queue(batch, env, ctx);
  return getQueueResult(batch, ctx);
}

describe('parseQueueName', () => {
  it.each([
    ['planeahead-persist-local', 'persist', false],
    ['planeahead-notify-staging', 'notify', false],
    ['planeahead-provider-events-production', 'provider-events', false],
    ['planeahead-imports-staging', 'imports', false],
    ['planeahead-reconcile-local', 'reconcile', false],
    ['planeahead-persist-dlq-staging', 'persist', true],
    ['planeahead-provider-events-dlq-production', 'provider-events', true],
    ['planeahead-reconcile-dlq', 'reconcile', true],
    ['planeahead-housekeeping-local', 'housekeeping', false],
    ['planeahead-housekeeping', 'housekeeping', false],
    ['planeahead-housekeeping-dlq-staging', 'housekeeping', true],
    // Increment 14: the push transport's queue and its dead letter queue.
    ['planeahead-push-local', 'push', false],
    ['planeahead-push', 'push', false],
    ['planeahead-push-dlq-staging', 'push', true],
    ['something-else', 'unknown', false],
  ])('routes %s', (queueName, kind, deadLetter) => {
    expect(parseQueueName(queueName)).toEqual({ kind, deadLetter });
  });
});

describe('queue()', () => {
  it('acknowledges every message on a persist batch, unreadable ones included', async () => {
    // Neither message is a valid PersistMessageV1 (increment 7): a message this build cannot
    // read can never succeed on retry, so it is logged at error level and acknowledged.
    const result = await runQueue('planeahead-persist-local', [
      { kind: 'flight_upsert', flightKey: 'AAL-100-2026-09-20-KJFK', seq: 1 },
      { kind: 'flight_event', flightKey: 'AAL-100-2026-09-20-KJFK', seq: 2 },
    ]);

    expect(result.explicitAcks).toEqual(['message-0', 'message-1']);
    expect(result.retryMessages).toEqual([]);
    expect(result.retryBatch.retry).toBe(false);
  });

  it.each([
    'planeahead-notify-local',
    'planeahead-provider-events-local',
    'planeahead-imports-local',
    // Increment 14: a body that is not a push job is acknowledged, never sent or retried.
    'planeahead-push-local',
  ])('acknowledges every message on %s', async (queueName) => {
    const result = await runQueue(queueName, [{ kind: 'x', provider: 'aerodatabox' }]);

    expect(result.explicitAcks).toEqual(['message-0']);
    expect(result.retryBatch.retry).toBe(false);
  });

  it('acknowledges a dead letter batch per message rather than looping it', async () => {
    // Increment 7: the dead letter consumer archives each message to R2 and acknowledges it.
    const result = await runQueue('planeahead-persist-dlq-local', [{ kind: 'flight_upsert' }]);

    expect(result.explicitAcks).toEqual(['message-0']);
    expect(result.retryBatch.retry).toBe(false);
  });

  it('acknowledges an unroutable batch rather than burning its retries', async () => {
    const result = await runQueue('some-other-teams-queue', [{ kind: 'mystery' }]);

    expect(result.ackAll).toBe(true);
    expect(result.retryBatch.retry).toBe(false);
  });
});

describe('consumeBatch', () => {
  it('retries only the message that threw', async () => {
    const { lines, log } = capture();
    const batch = createMessageBatch('planeahead-persist-local', [
      { id: 'good-1', timestamp: new Date(), attempts: 1, body: { ok: true } },
      { id: 'poison', timestamp: new Date(), attempts: 3, body: { ok: false } },
      { id: 'good-2', timestamp: new Date(), attempts: 1, body: { ok: true } },
    ]);
    const ctx = createExecutionContext();

    const outcome = await consumeBatch<{ ok: boolean }>(
      batch,
      (message) => {
        if (!message.body.ok) {
          throw new Error('poison message');
        }
      },
      log,
    );
    const result = await getQueueResult(batch, ctx);

    expect(outcome).toEqual({ acked: 2, retried: 1 });
    expect(result.explicitAcks).toEqual(['good-1', 'good-2']);
    // Only the message id is asserted: `getQueueResult` in @cloudflare/vitest-plugin 1.1.13 does
    // not surface the `delaySeconds` passed to a per-message `retry()`, even though it does for a
    // whole-batch retry. `backoffSeconds` is tested directly below instead.
    expect(result.retryMessages.map((message) => message.msgId)).toEqual(['poison']);
    expect(result.retryBatch.retry).toBe(false);
    // The delay the middleware chose for attempt 3, recorded on the log line rather than on the
    // queue result.
    const failure = lines.find((line) => line.event === 'queue_message_failed');
    expect(failure?.['delay_seconds']).toBe(8);
  });

  it('backs off exponentially and then flattens', () => {
    expect(backoffSeconds(0)).toBe(1);
    expect(backoffSeconds(1)).toBe(2);
    expect(backoffSeconds(5)).toBe(32);
    expect(backoffSeconds(50)).toBe(256);
  });
});

describe('runCron()', () => {
  it.each([
    [RECONCILE_CRON, ['cron_reconcile']],
    [HOUSEKEEPING_CRON, ['cron_housekeeping_planned', 'cron_ae_rollup_planned']],
    // Staging only (increment 16): with no soak started it reads its record and plans nothing.
    [PUSH_SOAK_CRON, ['cron_push_soak_idle']],
  ])('routes %s', async (cron, events) => {
    const { lines, log } = capture();
    const captured = envWithCapturedQueues();

    await runCron(cron, { env: captured.env, ctx: createExecutionContext(), log });

    expect(lines.map((line) => line.event)).toEqual(events);
  });

  it('logs rather than throws for an expression nothing handles', async () => {
    const { lines, log } = capture();

    await runCron('0 0 1 1 *', { env, ctx: createExecutionContext(), log });

    expect(lines.map((line) => line.event)).toEqual(['cron_unrouted']);
  });

  it('uses exactly the expressions wrangler.jsonc declares', () => {
    // Five fields. `*/15` and `0 3` are not valid cron expressions and would be rejected at
    // deploy time, so the constants and the config have to agree literally.
    expect(RECONCILE_CRON).toBe('*/15 * * * *');
    expect(HOUSEKEEPING_CRON).toBe('0 3 * * *');
  });

  it('waits for an async handler to finish before it returns', async () => {
    // The seam is async so increment 7's reconcile can page `flight_instances` and fan out to a
    // queue, both of which are awaited work. A `void` seam offered two bad ways to express that:
    // change all four signatures later, or reach for `ctx.waitUntil` on work that should be
    // awaited and lose the cron's error reporting with it. A promise a `void` `scheduled()`
    // starts is also simply abandoned when the invocation returns.
    const { lines, log } = capture();
    let finished = false;
    const handlers: CronHandlers = {
      [RECONCILE_CRON]: async ({ log: handlerLog }) => {
        await Promise.resolve();
        finished = true;
        handlerLog.info('slow_work_done', {});
      },
    };

    await runCron(RECONCILE_CRON, { env, ctx: createExecutionContext(), log }, handlers);

    expect(finished).toBe(true);
    expect(lines.map((line) => line.event)).toEqual(['slow_work_done']);
  });

  it('logs a rejected async handler as cron_failed instead of leaking it', async () => {
    // If `runCron` stopped awaiting, this rejection would become an unhandled rejection that no
    // log line and no Sentry event would mention.
    const { lines, log } = capture();
    const handlers: CronHandlers = {
      [RECONCILE_CRON]: async () => {
        await Promise.resolve();
        throw new Error('reconcile exploded');
      },
    };

    await runCron(RECONCILE_CRON, { env, ctx: createExecutionContext(), log }, handlers);

    const failure = lines.find((line) => line.event === 'cron_failed');
    expect(failure?.['error_message']).toBe('reconcile exploded');
    expect(failure?.level).toBe('error');
  });

  it('logs a synchronously thrown handler the same way', async () => {
    const { lines, log } = capture();
    const handlers: CronHandlers = {
      [HOUSEKEEPING_CRON]: () => {
        throw new Error('housekeeping exploded');
      },
    };

    await runCron(HOUSEKEEPING_CRON, { env, ctx: createExecutionContext(), log }, handlers);

    expect(lines.map((line) => line.event)).toEqual(['cron_failed']);
  });

  it('routes through the table the Worker itself uses', () => {
    expect(Object.keys(CRON_HANDLERS).sort()).toEqual(
      [HOUSEKEEPING_CRON, RECONCILE_CRON, PUSH_SOAK_CRON].sort(),
    );
  });
});

describe('scheduled()', () => {
  it('returns a promise, so workerd keeps the invocation alive until the work finishes', async () => {
    const controller = {
      cron: HOUSEKEEPING_CRON,
      scheduledTime: Date.now(),
      noRetry: () => undefined,
    } as unknown as ScheduledController;

    const captured = envWithCapturedQueues();
    const returned = scheduled(controller, captured.env, createExecutionContext());

    expect(returned).toBeInstanceOf(Promise);
    await expect(returned).resolves.toBeUndefined();
    // Planned, not done: nine housekeeping steps and two rollup days, nothing run inline.
    expect(captured.sent).toHaveLength(11);
  });
});
