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
import { HOUSEKEEPING_CRON, RECONCILE_CRON, runCron } from '../../src/cron/index';
import { type LogLine, createLogger } from '../../src/observability/log';
import { backoffSeconds, consumeBatch } from '../../src/queues/consume';
import { parseQueueName, queue } from '../../src/queues/index';

function capture(): { lines: LogLine[]; log: ReturnType<typeof createLogger> } {
  const lines: LogLine[] = [];
  return { lines, log: createLogger({}, (line) => lines.push(line)) };
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
    ['planeahead-persist-dlq-staging', 'persist', true],
    ['planeahead-provider-events-dlq-production', 'provider-events', true],
    ['something-else', 'unknown', false],
  ])('routes %s', (queueName, kind, deadLetter) => {
    expect(parseQueueName(queueName)).toEqual({ kind, deadLetter });
  });
});

describe('queue()', () => {
  it('acknowledges every message on a persist batch', async () => {
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
  ])('acknowledges every message on %s', async (queueName) => {
    const result = await runQueue(queueName, [{ kind: 'x', provider: 'aerodatabox' }]);

    expect(result.explicitAcks).toEqual(['message-0']);
    expect(result.retryBatch.retry).toBe(false);
  });

  it('acknowledges a dead letter batch rather than looping it', async () => {
    const result = await runQueue('planeahead-persist-dlq-local', [{ kind: 'flight_upsert' }]);

    expect(result.ackAll).toBe(true);
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
    [RECONCILE_CRON, 'cron_reconcile'],
    [HOUSEKEEPING_CRON, 'cron_housekeeping'],
  ])('routes %s', (cron, event) => {
    const { lines, log } = capture();

    runCron(cron, { env, ctx: createExecutionContext(), log });

    expect(lines.map((line) => line.event)).toEqual([event]);
  });

  it('logs rather than throws for an expression nothing handles', () => {
    const { lines, log } = capture();

    runCron('0 0 1 1 *', { env, ctx: createExecutionContext(), log });

    expect(lines.map((line) => line.event)).toEqual(['cron_unrouted']);
  });

  it('uses exactly the expressions wrangler.jsonc declares', () => {
    // Five fields. `*/15` and `0 3` are not valid cron expressions and would be rejected at
    // deploy time, so the constants and the config have to agree literally.
    expect(RECONCILE_CRON).toBe('*/15 * * * *');
    expect(HOUSEKEEPING_CRON).toBe('0 3 * * *');
  });
});
