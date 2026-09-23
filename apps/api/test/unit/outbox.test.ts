/**
 * The outbox send protocol's limits (increment 7 review, outbox-and-data-flow-11): 100 messages
 * and 240 KB per batch, 120 KB per message, `seq` order preserved, and a partial send reporting
 * exactly the rows of the chunks the queue accepted.
 */

import { describe, expect, it } from 'vitest';
import {
  OUTBOX_BATCH_LIMIT_BYTES,
  OUTBOX_BATCH_LIMIT_MESSAGES,
  OUTBOX_SINGLE_MESSAGE_LIMIT_BYTES,
  chunkOutbox,
  messageBytes,
  sendOutboxChunks,
} from '../../src/do/outbox';
import { createLogger } from '../../src/observability/log';

const quietLog = createLogger({}, () => undefined);

function rows(count: number, bytesEach = 0): { seq: number; payload: string }[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    payload: 'x'.repeat(bytesEach),
  }));
}

describe('chunkOutbox', () => {
  it('splits at 100 messages', () => {
    const { chunks, oversize } = chunkOutbox(rows(150), (row) => ({ seq: row.seq }));
    expect(oversize).toEqual([]);
    expect(chunks.map((chunk) => chunk.seqs.length)).toEqual([100, 50]);
    expect(chunks[0]?.seqs[0]).toBe(1);
    expect(chunks[1]?.seqs.at(-1)).toBe(150);
    expect(OUTBOX_BATCH_LIMIT_MESSAGES).toBe(100);
  });

  it('splits at 240 KB of JSON before it splits at 100 messages', () => {
    const { chunks } = chunkOutbox(rows(5, 100 * 1024), (row) => row);
    // Two 100 KB rows fit; a third would pass 240 KB.
    expect(chunks.map((chunk) => chunk.seqs.length)).toEqual([2, 2, 1]);
    for (const chunk of chunks) {
      expect(chunk.bytes).toBeLessThanOrEqual(OUTBOX_BATCH_LIMIT_BYTES);
      expect(chunk.bytes).toBe(
        chunk.bodies.reduce((sum: number, body) => sum + messageBytes(body), 0),
      );
    }
  });

  it('hands back a row over 120 KB as oversize and never puts it in a chunk', () => {
    const input = [
      ...rows(1, 10),
      { seq: 2, payload: 'y'.repeat(OUTBOX_SINGLE_MESSAGE_LIMIT_BYTES + 1) },
      { seq: 3, payload: 'z'.repeat(10) },
    ];
    const { chunks, oversize } = chunkOutbox(input, (row) => row);
    expect(oversize.map((row) => row.seq)).toEqual([2]);
    expect(chunks.map((chunk) => chunk.seqs)).toEqual([[1, 3]]);
  });

  it('measures UTF-8 bytes, not UTF-16 units', () => {
    const body = { text: 'é'.repeat(1_000) };
    expect(messageBytes(body)).toBeGreaterThan(JSON.stringify(body).length);
  });
});

describe('sendOutboxChunks', () => {
  it('stops at the first failed send and reports only the accepted chunks as sent', async () => {
    const { chunks } = chunkOutbox(rows(250), (row) => ({ seq: row.seq }));
    expect(chunks).toHaveLength(3);
    let calls = 0;
    const sink = {
      sendBatch: () => {
        calls += 1;
        return calls === 2 ? Promise.reject(new Error('queue unavailable')) : Promise.resolve();
      },
    } as unknown as Pick<Queue, 'sendBatch'>;

    const outcome = await sendOutboxChunks(sink, chunks, quietLog);

    expect(calls).toBe(2);
    expect(outcome.sentSeqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(outcome.batches).toEqual([{ messages: 100, bytes: chunks[0]?.bytes }]);
    expect(outcome.error).toBeInstanceOf(Error);
  });

  it('reports every seq and no error when every chunk goes', async () => {
    const { chunks } = chunkOutbox(rows(7), (row) => ({ seq: row.seq }));
    const outcome = await sendOutboxChunks(
      { sendBatch: () => Promise.resolve() } as unknown as Pick<Queue, 'sendBatch'>,
      chunks,
      quietLog,
    );
    expect(outcome).toEqual({
      sentSeqs: [1, 2, 3, 4, 5, 6, 7],
      batches: [{ messages: 7, bytes: chunks[0]?.bytes }],
      error: null,
    });
  });
});
