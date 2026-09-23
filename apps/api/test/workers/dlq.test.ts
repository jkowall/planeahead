/**
 * The dead letter consumer: every `-dlq` queue routes to one handler that archives the raw
 * message to R2 at `dlq/{queue}/{messageId}.json`, raises the ops alert once per batch, and
 * acknowledges each message; an archive failure is retried while `max_retries: 2` allows and
 * acknowledged, with the body on the log line, on the last attempt. An archived `persist` message
 * is confirmed to the tracker lifetime its envelope names, exactly as the persist consumer
 * confirms what it wrote; a message that was not archived is confirmed to no one.
 */

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_SCHEMA_VERSION, flightTrackerOrigin, type FlightKey } from '@planeahead/shared';
import { type LogLine, createLogger } from '../../src/observability/log';
import { handleDeadLetterBatch } from '../../src/queues/dlq';
import { queue } from '../../src/queues/index';
import type { ConfirmingTracker } from '../../src/queues/persist';
import { deadLetterArchiveKey } from '../../src/r2/archive';
import { drainTouched, testEnv, track } from './helpers/flights';

afterEach(drainTouched);

function capture(): { lines: LogLine[]; log: ReturnType<typeof createLogger> } {
  const lines: LogLine[] = [];
  return { lines, log: createLogger({}, (line) => lines.push(line)) };
}

describe('dead letter consumer', () => {
  it('archives each message to R2, alerts once, and acknowledges through the dispatcher', async () => {
    const id = `dlq-${crypto.randomUUID()}`;
    const batch = createMessageBatch('planeahead-persist-dlq-local', [
      {
        id,
        timestamp: new Date('2026-09-22T10:00:00Z'),
        attempts: 6,
        body: { kind: 'flight_instance', seq: 9, origin: 'flight_tracker:AAL-1-2100-01-01-KJFK@1' },
      },
    ]);
    // The archived message is confirmed to the tracker its origin names; that object holds no
    // flight, answers with `matched: false` and arms its own cleanup, drained by afterEach.
    track(testEnv.FLIGHT_TRACKER.getByName('AAL-1-2100-01-01-KJFK', { locationHint: 'enam' }));
    const ctx = createExecutionContext();

    await queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual([id]);
    expect(result.retryBatch.retry).toBe(false);
    const archived = await env.PRIVATE_BUCKET.get(deadLetterArchiveKey('persist', id));
    expect(archived).not.toBeNull();
    expect(await archived?.json()).toEqual({
      queue: 'planeahead-persist-dlq-local',
      kind: 'persist',
      messageId: id,
      timestamp: '2026-09-22T10:00:00.000Z',
      attempts: 6,
      body: { kind: 'flight_instance', seq: 9, origin: 'flight_tracker:AAL-1-2100-01-01-KJFK@1' },
    });
  });

  it('confirms an archived persist message to its tracker lifetime, and a non-tracker one to no one', async () => {
    const { lines, log } = capture();
    const confirmed: unknown[] = [];
    const trackerFor = (flightKey: FlightKey): ConfirmingTracker => ({
      confirmPersisted: (input) => {
        confirmed.push({ flightKey, input });
        return Promise.resolve({
          rpcVersion: RPC_SCHEMA_VERSION,
          deleted: 2,
          remaining: 0,
          matched: true,
        });
      },
    });
    const origin = flightTrackerOrigin('AAL-1-2100-01-01-KJFK' as FlightKey, 5);
    const ids = [
      `p-${crypto.randomUUID()}`,
      `q-${crypto.randomUUID()}`,
      `r-${crypto.randomUUID()}`,
    ];
    const batch = createMessageBatch('planeahead-persist-dlq-local', [
      {
        id: ids[0] ?? '',
        timestamp: new Date(),
        attempts: 6,
        body: { kind: 'flight_event', seq: 7, origin },
      },
      // Unreadable to the persist consumer too: the envelope is all the confirmation needs.
      {
        id: ids[1] ?? '',
        timestamp: new Date(),
        attempts: 6,
        body: { kind: 'no_such_kind', seq: 9, origin },
      },
      {
        id: ids[2] ?? '',
        timestamp: new Date(),
        attempts: 6,
        body: { kind: 'provider_budget_daily', seq: 1, origin: 'provider_budget:aerodatabox@1' },
      },
    ]);
    const ctx = createExecutionContext();

    await handleDeadLetterBatch(
      batch,
      'persist',
      { env, ctx, log },
      { trackerFor, capture: () => undefined },
    );
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual(ids);
    expect(confirmed).toEqual([
      {
        flightKey: 'AAL-1-2100-01-01-KJFK',
        input: { rpcVersion: RPC_SCHEMA_VERSION, epochMs: 5, seqs: [7, 9] },
      },
    ]);
    expect(lines.find((line) => line.event === 'persist_confirmed')?.['deleted']).toBe(2);
  });

  it('confirms nothing that was not archived, and logs a confirmation that throws', async () => {
    const { lines, log } = capture();
    let confirmAttempts = 0;
    const trackerFor = (): ConfirmingTracker => ({
      confirmPersisted: () => {
        confirmAttempts += 1;
        return Promise.reject(new Error('tracker unavailable'));
      },
    });
    const origin = flightTrackerOrigin('AAL-2-2100-01-01-KJFK' as FlightKey, 5);
    const message = (id: string, attempts: number) => ({
      id,
      timestamp: new Date(),
      attempts,
      body: { kind: 'flight_event', seq: 3, origin },
    });
    const failing = { put: () => Promise.reject(new Error('R2 unavailable')) } as unknown as Pick<
      R2Bucket,
      'put'
    >;

    // Archive failed on the last allowed attempt: acknowledged, not archived, not confirmed.
    const lost = createMessageBatch('planeahead-persist-dlq-local', [message('lost', 3)]);
    const lostCtx = createExecutionContext();
    await handleDeadLetterBatch(
      lost,
      'persist',
      { env, ctx: lostCtx, log },
      { trackerFor, bucket: failing, capture: () => undefined },
    );
    expect((await getQueueResult(lost, lostCtx)).explicitAcks).toEqual(['lost']);
    expect(confirmAttempts).toBe(0);

    // Archived, but the tracker is unreachable: logged, not retried, still acknowledged.
    const kept = createMessageBatch('planeahead-persist-dlq-local', [message('kept', 6)]);
    const keptCtx = createExecutionContext();
    await handleDeadLetterBatch(
      kept,
      'persist',
      { env, ctx: keptCtx, log },
      { trackerFor, capture: () => undefined },
    );
    expect((await getQueueResult(kept, keptCtx)).explicitAcks).toEqual(['kept']);
    expect(confirmAttempts).toBe(1);
    const failure = lines.find((line) => line.event === 'persist_confirm_failed');
    expect(failure?.level).toBe('error');
    expect(failure?.['flight_key']).toBe('AAL-2-2100-01-01-KJFK');
  });

  it('raises one fatal ops alert per batch naming the queue and the message ids', async () => {
    const { lines, log } = capture();
    const alerts: { message: string; context: unknown }[] = [];
    const ids = [`a-${crypto.randomUUID()}`, `b-${crypto.randomUUID()}`];
    const batch = createMessageBatch(
      'planeahead-reconcile-dlq-staging',
      ids.map((id) => ({
        id,
        timestamp: new Date(),
        attempts: 4,
        body: { kind: 'reconcile_flight' },
      })),
    );

    await handleDeadLetterBatch(
      batch,
      'reconcile',
      { env, ctx: createExecutionContext(), log },
      { capture: (message, context) => void alerts.push({ message, context }) },
    );

    expect(alerts).toEqual([
      {
        message: 'queue_dead_letter',
        context: {
          level: 'fatal',
          tags: { ops_alert: 'queue_dead_letter', queue: 'planeahead-reconcile-dlq-staging' },
          extra: {
            queue: 'planeahead-reconcile-dlq-staging',
            queue_kind: 'reconcile',
            messages: 2,
            archived: ids,
            archive_failed: [],
            archive_retried: [],
          },
        },
      },
    ]);
    // The alert itself logs under the same event name; the per-message lines carry the id.
    const perMessage = lines.filter(
      (line) => line.event === 'queue_dead_letter' && line['message_id'] !== undefined,
    );
    expect(perMessage).toHaveLength(2);
    expect(perMessage.every((line) => line.level === 'error')).toBe(true);
    expect(perMessage.map((line) => line['archive_key'])).toEqual(
      ids.map((id) => deadLetterArchiveKey('reconcile', id)),
    );
  });

  it('retries a failed archive write with backoff while max_retries allows', async () => {
    const { lines, log } = capture();
    const alerts: unknown[] = [];
    const id = `r-${crypto.randomUUID()}`;
    const batch = createMessageBatch('planeahead-notify-dlq-local', [
      { id, timestamp: new Date(), attempts: 1, body: { to: 'device' } },
    ]);
    const ctx = createExecutionContext();

    await handleDeadLetterBatch(
      batch,
      'notify',
      { env, ctx, log },
      {
        bucket: { put: () => Promise.reject(new Error('R2 unavailable')) } as unknown as Pick<
          R2Bucket,
          'put'
        >,
        capture: (message) => void alerts.push(message),
      },
    );
    const result = await getQueueResult(batch, ctx);

    // Not acknowledged, retried with the consumer's backoff, and no alert yet: the attempt that
    // settles the message raises it.
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual([id]);
    expect(alerts).toEqual([]);
    const retry = lines.find((line) => line.event === 'queue_dead_letter_archive_retry');
    expect(retry?.['delay_seconds']).toBe(2);
    expect(retry?.['body']).toBeUndefined();
  });

  it('acknowledges on the last attempt when the archive write still fails, and says so in the alert', async () => {
    const { lines, log } = capture();
    const alerts: { context: { extra: Record<string, unknown> } }[] = [];
    const id = `c-${crypto.randomUUID()}`;
    // attempts 3 is the last one max_retries: 2 allows.
    const batch = createMessageBatch('planeahead-notify-dlq-local', [
      { id, timestamp: new Date(), attempts: 3, body: { to: 'device' } },
    ]);
    const ctx = createExecutionContext();

    await handleDeadLetterBatch(
      batch,
      'notify',
      { env, ctx, log },
      {
        bucket: { put: () => Promise.reject(new Error('R2 unavailable')) } as unknown as Pick<
          R2Bucket,
          'put'
        >,
        capture: (_message, context) => void alerts.push({ context: context }),
      },
    );
    const result = await getQueueResult(batch, ctx);

    expect(result.explicitAcks).toEqual([id]);
    expect(alerts[0]?.context.extra['archive_failed']).toEqual([id]);
    const failure = lines.find((line) => line.event === 'queue_dead_letter_archive_failed');
    expect(failure?.level).toBe('error');
    // The body is on the log line, since the archive does not have it.
    expect(failure?.['body']).toEqual({ to: 'device' });
  });
});
