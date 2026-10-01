/**
 * The `sendBatch` packing of the `notify` consumer (increment 15, ruling N9): as few calls as
 * Queues' limits allow, 100 messages and 256 KB a call, in order.
 */

import { describe, expect, it } from 'vitest';
import {
  SEND_BATCH_MAX_BYTES,
  SEND_BATCH_MAX_MESSAGES,
  SEND_BATCH_MESSAGE_OVERHEAD_BYTES,
  chunk,
  packSendBatches,
  sendBatchBytes,
} from '../../src/notify/jobs';

describe('packSendBatches', () => {
  it('cuts at 100 messages', () => {
    const jobs = Array.from({ length: 250 }, (_, index) => index);
    const calls = packSendBatches(jobs, () => 1_000);
    expect(SEND_BATCH_MAX_MESSAGES).toBe(100);
    expect(calls.map((call) => call.length)).toEqual([100, 100, 50]);
    expect(calls.flat()).toEqual(jobs);
  });

  it('cuts at 256 KB, and sends a job too large for any call alone', () => {
    expect(SEND_BATCH_MAX_BYTES).toBe(256_000);
    const sizes = [100_000, 100_000, 100_000, 300_000, 56_000, 200_000];
    const calls = packSendBatches(sizes, (size) => size);
    expect(calls).toEqual([[100_000, 100_000], [100_000], [300_000], [56_000, 200_000]]);
    expect(packSendBatches([], () => 1)).toEqual([]);
  });

  it('measures a job as its JSON bytes plus the per-message overhead', () => {
    const job = { title: 'Gate \u00e9', n: 1 };
    const json = new TextEncoder().encode(JSON.stringify(job)).byteLength;
    expect(sendBatchBytes(job)).toBe(json + SEND_BATCH_MESSAGE_OVERHEAD_BYTES);
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
