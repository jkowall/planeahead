/**
 * Analytics Engine writes, with the per-invocation budget made explicit.
 *
 * `writeDataPoint()` is synchronous. It must never be awaited and never wrapped in
 * `ctx.waitUntil()`, and it throws synchronously when a point breaks a limit (too many blobs,
 * too many doubles, more than one index, an oversized index or oversized cumulative blobs).
 * A thrown limit error inside a queue consumer would fail the whole batch, so every write gets
 * its own try/catch and a failed point is logged and dropped.
 *
 * The documented cap is 250 data points per Worker invocation. Whether that cap also applies to
 * a `queue()` or `alarm()` invocation is not stated anywhere in Cloudflare's documentation, so
 * the budget here is 200 with an explicit counter: safe under either reading, and a batch that
 * wants more than 200 points logs the overflow instead of silently losing it.
 */

import type { Logger } from '../observability/log';

/** Points written per Worker invocation. The platform cap is 250. */
export const ANALYTICS_POINTS_PER_INVOCATION = 200;

export const MAX_BLOBS = 20;
export const MAX_DOUBLES = 20;
export const MAX_INDEXES = 1;
/** Index key limit, in bytes. */
export const MAX_INDEX_BYTES = 96;
/** Cumulative blob budget for one data point, in bytes. */
export const MAX_TOTAL_BLOB_BYTES = 16_000;

export interface AnalyticsPoint {
  readonly indexes?: readonly string[];
  readonly doubles?: readonly number[];
  readonly blobs?: readonly string[];
}

export interface AnalyticsStats {
  /** Points handed to the dataset. */
  readonly written: number;
  /** Points refused because the per-invocation budget was already spent. */
  readonly overflowed: number;
  /** Points the dataset threw on. A payload problem: the point broke a platform limit. */
  readonly failed: number;
  /** Points dropped because the binding is absent. A configuration problem, not a payload one. */
  readonly skipped: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Trims a string to at most `budget` UTF-8 bytes, cutting on a codepoint boundary.
 *
 * Slicing the byte array and decoding is not enough on its own. A cut inside a multi-byte
 * sequence decodes to U+FFFD, which re-encodes to THREE bytes, so a naive
 * `decode(bytes.subarray(0, budget))` can return a string that is larger than the budget it was
 * asked to respect, and the platform limit it exists to enforce is broken by the enforcement.
 * Walking back off the continuation bytes (`0b10xxxxxx`) puts the cut on a boundary, so the
 * result is always at or under the budget and no replacement character is ever introduced.
 */
export function truncateToBytes(value: string, budget: number): string {
  if (budget <= 0) {
    return '';
  }
  const bytes = encoder.encode(value);
  if (bytes.length <= budget) {
    return value;
  }
  let end = budget;
  while (end > 0 && ((bytes[end] ?? 0) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return decoder.decode(bytes.subarray(0, end));
}

/**
 * Trims a point to the documented shape so the common causes of a synchronous throw are gone
 * before the write. It is a belt, not a substitute for the braces: `write()` still catches.
 */
export function clampPoint(point: AnalyticsPoint): AnalyticsEngineDataPoint {
  const indexes: string[] = (point.indexes ?? [])
    .slice(0, MAX_INDEXES)
    .map((value) => truncateToBytes(value, MAX_INDEX_BYTES));
  const doubles: number[] = [...(point.doubles ?? []).slice(0, MAX_DOUBLES)];

  const blobs: string[] = [];
  let blobBytes = 0;
  for (const blob of (point.blobs ?? []).slice(0, MAX_BLOBS)) {
    const trimmed = truncateToBytes(blob, MAX_TOTAL_BLOB_BYTES - blobBytes);
    blobBytes += encoder.encode(trimmed).length;
    blobs.push(trimmed);
  }

  return { indexes, doubles, blobs };
}

/**
 * One budget per Worker invocation. Construct it at the top of `queue()`, `scheduled()` or
 * `alarm()` and pass it down; never hold one at module scope, where the counter would leak
 * across invocations in the same isolate.
 */
export class AnalyticsBudget {
  readonly #dataset: AnalyticsEngineDataset | undefined;
  readonly #log: Logger;
  readonly #limit: number;
  #written = 0;
  #overflowed = 0;
  #failed = 0;
  #skipped = 0;
  #missingLogged = false;

  constructor(
    dataset: AnalyticsEngineDataset | undefined,
    log: Logger,
    limit: number = ANALYTICS_POINTS_PER_INVOCATION,
  ) {
    this.#dataset = dataset;
    this.#log = log;
    this.#limit = limit;
  }

  /** Returns true when the point was handed to the dataset. Never throws. */
  write(point: AnalyticsPoint): boolean {
    if (this.#dataset === undefined) {
      // A missing binding is a wrangler.jsonc mistake, not a payload problem, and counting it as
      // a write failure makes a 100-message batch report `failed: 100` in exactly the shape a
      // batch of oversized points reports. The two want opposite responses, so they get separate
      // counters and this one names the cause once per invocation rather than per point.
      if (!this.#missingLogged) {
        this.#missingLogged = true;
        this.#log.warn('analytics_dataset_missing', {
          hint: 'analytics_engine_datasets is not inheritable; check the env block in wrangler.jsonc',
        });
      }
      this.#skipped += 1;
      return false;
    }
    if (this.#written >= this.#limit) {
      this.#overflowed += 1;
      return false;
    }
    try {
      // Synchronous by design. Do not await, do not waitUntil.
      this.#dataset.writeDataPoint(clampPoint(point));
      this.#written += 1;
      return true;
    } catch (error) {
      this.#failed += 1;
      this.#log.error('analytics_write_failed', {
        error_message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  get stats(): AnalyticsStats {
    return {
      written: this.#written,
      overflowed: this.#overflowed,
      failed: this.#failed,
      skipped: this.#skipped,
    };
  }

  /** Logs the invocation's totals. Call once, at the end of the invocation. */
  report(event: string): void {
    if (this.#overflowed > 0 || this.#failed > 0 || this.#skipped > 0) {
      this.#log.warn(event, { ...this.stats });
      return;
    }
    this.#log.debug(event, { ...this.stats });
  }
}
