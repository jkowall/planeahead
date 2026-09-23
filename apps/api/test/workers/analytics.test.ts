/**
 * The Analytics Engine budget and the point clamp.
 *
 * Ruling E7 fixes three properties of this helper, and all three live in code that no other test
 * touches: at most 200 points per invocation against the documented 250 cap, every
 * `writeDataPoint` in its own try/catch because it throws SYNCHRONOUSLY on an oversized point,
 * and no `await` or `waitUntil` anywhere near it. The counter is the piece that matters, because
 * it is the only thing between increment 7's persist consumer and a synchronous throw that fails
 * a whole batch of a hundred messages.
 *
 * `AnalyticsBudget` is a pure class over an injectable dataset, so none of this needs a binding.
 */

import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_POINTS_PER_INVOCATION,
  AnalyticsBudget,
  MAX_BLOBS,
  MAX_DOUBLES,
  MAX_INDEXES,
  MAX_INDEX_BYTES,
  MAX_TOTAL_BLOB_BYTES,
  clampPoint,
  truncateToBytes,
} from '../../src/queues/analytics';
import { type LogLine, createLogger } from '../../src/observability/log';

const encoder = new TextEncoder();

/**
 * Size of one blob or index value in UTF-8 bytes. The platform type allows an ArrayBuffer as well
 * as a string, and `clampPoint` only ever produces strings, so this is both the assertion and the
 * proof that it does.
 */
function valueBytes(value: ArrayBuffer | string | null | undefined): number {
  if (typeof value === 'string') {
    return encoder.encode(value).length;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength;
  }
  return 0;
}

function capture(): { lines: LogLine[]; log: ReturnType<typeof createLogger> } {
  const lines: LogLine[] = [];
  return { lines, log: createLogger({}, (line) => lines.push(line)) };
}

/** A dataset that records what it was handed, or throws on demand. */
function fakeDataset(onWrite?: (point: AnalyticsEngineDataPoint) => void): {
  dataset: AnalyticsEngineDataset;
  points: AnalyticsEngineDataPoint[];
} {
  const points: AnalyticsEngineDataPoint[] = [];
  const dataset: AnalyticsEngineDataset = {
    writeDataPoint(point?: AnalyticsEngineDataPoint): void {
      const value = point ?? {};
      onWrite?.(value);
      points.push(value);
    },
  };
  return { dataset, points };
}

describe('truncateToBytes', () => {
  it('leaves a string that already fits alone', () => {
    expect(truncateToBytes('AA100', 96)).toBe('AA100');
  });

  it('never returns more bytes than the budget, even mid-codepoint', () => {
    // The bug this covers: slicing the UTF-8 bytes and decoding puts U+FFFD where the cut landed,
    // and U+FFFD re-encodes to THREE bytes, so the "truncated" value came back LARGER than the
    // budget it was asked to respect. Increment 6 puts provider names and flight designators in
    // these fields and both can carry non-ASCII.
    for (const prefix of ['', 'a', 'ab', 'abc']) {
      const value = `${prefix}${'\u20ac'.repeat(64)}`;
      const trimmed = truncateToBytes(value, MAX_INDEX_BYTES);

      expect(encoder.encode(trimmed).length).toBeLessThanOrEqual(MAX_INDEX_BYTES);
    }
  });

  it('cuts on a codepoint boundary rather than inventing a replacement character', () => {
    const trimmed = truncateToBytes('\u20ac'.repeat(10), 8);

    // 8 bytes is two whole euro signs (3 bytes each) with 2 bytes to spare, and the spare bytes
    // are dropped rather than decoded into U+FFFD.
    expect(trimmed).toBe('\u20ac\u20ac');
    expect(trimmed).not.toContain('\ufffd');
  });

  it('returns an empty string for a budget of zero or less', () => {
    expect(truncateToBytes('anything', 0)).toBe('');
    expect(truncateToBytes('anything', -5)).toBe('');
  });
});

describe('clampPoint', () => {
  it('trims to one index, 20 doubles and 20 blobs', () => {
    const point = clampPoint({
      indexes: ['a', 'b', 'c'],
      doubles: Array.from({ length: 40 }, (_unused, index) => index),
      blobs: Array.from({ length: 40 }, (_unused, index) => `blob-${index}`),
    });

    expect(point.indexes).toHaveLength(MAX_INDEXES);
    expect(point.doubles).toHaveLength(MAX_DOUBLES);
    expect(point.blobs).toHaveLength(MAX_BLOBS);
  });

  it('holds the index under 96 bytes', () => {
    const point = clampPoint({ indexes: ['x'.repeat(500)] });

    expect(valueBytes(point.indexes?.[0])).toBe(MAX_INDEX_BYTES);
  });

  it('holds the cumulative blob payload under 16000 bytes', () => {
    const point = clampPoint({ blobs: Array.from({ length: 20 }, () => 'y'.repeat(4000)) });
    const total = (point.blobs ?? []).reduce((sum, blob) => sum + valueBytes(blob), 0);

    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BLOB_BYTES);
  });

  it('holds the cumulative blob payload under the cap with multi-byte blobs too', () => {
    const point = clampPoint({ blobs: Array.from({ length: 20 }, () => '\u20ac'.repeat(4000)) });
    const total = (point.blobs ?? []).reduce((sum, blob) => sum + valueBytes(blob), 0);

    expect(total).toBeLessThanOrEqual(MAX_TOTAL_BLOB_BYTES);
  });

  it('produces empty arrays rather than undefined for an empty point', () => {
    expect(clampPoint({})).toEqual({ indexes: [], doubles: [], blobs: [] });
  });
});

describe('AnalyticsBudget', () => {
  it('writes up to the per-invocation budget and then overflows', () => {
    const { log } = capture();
    const { dataset, points } = fakeDataset();
    const budget = new AnalyticsBudget(dataset, log);

    const results: boolean[] = [];
    for (let index = 0; index < ANALYTICS_POINTS_PER_INVOCATION + 1; index += 1) {
      results.push(budget.write({ indexes: [`point-${index}`] }));
    }

    expect(points).toHaveLength(ANALYTICS_POINTS_PER_INVOCATION);
    expect(results[ANALYTICS_POINTS_PER_INVOCATION - 1]).toBe(true);
    expect(results[ANALYTICS_POINTS_PER_INVOCATION]).toBe(false);
    expect(budget.stats).toEqual({
      written: ANALYTICS_POINTS_PER_INVOCATION,
      overflowed: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it('stays under the documented 250 point platform cap', () => {
    expect(ANALYTICS_POINTS_PER_INVOCATION).toBeLessThanOrEqual(250);
  });

  it('swallows a synchronous throw from the dataset instead of failing the batch', () => {
    // `writeDataPoint` throws synchronously when a point breaks a platform limit. A throw out of
    // a queue consumer retries the WHOLE batch, so this is the guard that keeps one bad point
    // from replaying ninety-nine good messages.
    const { lines, log } = capture();
    const { dataset } = fakeDataset(() => {
      throw new Error('too many blobs');
    });
    const budget = new AnalyticsBudget(dataset, log);

    expect(() => budget.write({ blobs: ['x'] })).not.toThrow();
    expect(budget.write({ blobs: ['x'] })).toBe(false);
    expect(budget.stats).toEqual({ written: 0, overflowed: 0, failed: 2, skipped: 0 });
    expect(lines.filter((line) => line.event === 'analytics_write_failed')).toHaveLength(2);
  });

  it('names a missing binding once, and does not report it as a write failure', () => {
    // A missing `analytics_engine_datasets` block in an env block is a wrangler.jsonc mistake,
    // not a payload problem, and `analytics_engine_datasets` is one of the keys that is NOT
    // inheritable. Counting 100 skipped points as `failed: 100` made a configuration error read
    // exactly like a hundred points that each broke a platform limit.
    const { lines, log } = capture();
    const budget = new AnalyticsBudget(undefined, log);

    for (let index = 0; index < 100; index += 1) {
      expect(budget.write({ indexes: [`point-${index}`] })).toBe(false);
    }

    expect(budget.stats).toEqual({ written: 0, overflowed: 0, failed: 0, skipped: 100 });
    const missing = lines.filter((line) => line.event === 'analytics_dataset_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.level).toBe('warn');
  });

  it('never throws out of write(), whatever the dataset does', () => {
    const { log } = capture();
    const { dataset } = fakeDataset(() => {
      throw new Error('boom');
    });

    expect(() => new AnalyticsBudget(dataset, log).write({ indexes: ['a'] })).not.toThrow();
    expect(() => new AnalyticsBudget(undefined, log).write({ indexes: ['a'] })).not.toThrow();
  });

  it('clamps the point on the way to the dataset', () => {
    const { log } = capture();
    const { dataset, points } = fakeDataset();

    new AnalyticsBudget(dataset, log).write({ indexes: ['a', 'b'], doubles: [1, 2, 3] });

    expect(points[0]?.indexes).toEqual(['a']);
    expect(points[0]?.doubles).toEqual([1, 2, 3]);
  });

  it('reports at debug when the invocation was clean and at warn when it was not', () => {
    const clean = capture();
    const { dataset } = fakeDataset();
    new AnalyticsBudget(dataset, clean.log, 1).write({ indexes: ['a'] });
    new AnalyticsBudget(dataset, clean.log, 1).report('persist_analytics');

    const dirty = capture();
    const overflowing = new AnalyticsBudget(dataset, dirty.log, 1);
    overflowing.write({ indexes: ['a'] });
    overflowing.write({ indexes: ['b'] });
    overflowing.report('persist_analytics');

    const missing = capture();
    const absent = new AnalyticsBudget(undefined, missing.log);
    absent.write({ indexes: ['a'] });
    absent.report('persist_analytics');

    expect(clean.lines.find((line) => line.event === 'persist_analytics')?.level).toBe('debug');
    expect(dirty.lines.find((line) => line.event === 'persist_analytics')?.level).toBe('warn');
    expect(missing.lines.find((line) => line.event === 'persist_analytics')?.level).toBe('warn');
  });

  it('counts per instance, so one budget per invocation really is one budget', () => {
    // The class must never be held at module scope: the counter would leak across invocations in
    // the same isolate and a warm isolate would stop writing points altogether.
    const { log } = capture();
    const { dataset } = fakeDataset();

    const first = new AnalyticsBudget(dataset, log, 1);
    first.write({ indexes: ['a'] });
    const second = new AnalyticsBudget(dataset, log, 1);

    expect(first.write({ indexes: ['b'] })).toBe(false);
    expect(second.write({ indexes: ['c'] })).toBe(true);
  });
});
