/**
 * The token bucket as pure functions over stored state: refilled from the elapsed time on every
 * read, never by a timer.
 */

import { describe, expect, it } from 'vitest';
import providerBudgetSource from '../../src/do/provider-budget.ts?raw';
import aeroapiSource from '../../src/providers/aeroapi.mock.ts?raw';
import adapterSource from '../../src/providers/aerodatabox.adapter.ts?raw';
import budgetSource from '../../src/providers/budget.ts?raw';
import configSource from '../../src/providers/config.ts?raw';
import costLogSource from '../../src/providers/cost-log.ts?raw';
import httpSource from '../../src/providers/http.ts?raw';
import routerSource from '../../src/providers/router.ts?raw';
import bucketSource from '../../src/providers/token-bucket.ts?raw';
import {
  backoff,
  bucketConfig,
  initialBucket,
  refill,
  take,
  type TokenBucketState,
} from '../../src/providers/token-bucket';

const T0 = Date.parse('2026-09-22T12:00:00Z');
const FIVE = bucketConfig(5);

describe('token bucket', () => {
  it('starts full at one second of burst', () => {
    expect(initialBucket(FIVE, T0)).toEqual({ tokens: 5, updatedAtMs: T0, blockedUntilMs: 0 });
    expect(bucketConfig(10)).toEqual({ ratePerSecond: 10, burst: 10 });
    expect(bucketConfig(0.625, 1)).toEqual({ ratePerSecond: 0.625, burst: 1 });
  });

  it('allows the burst in one instant, then refuses with the wait for the next token', () => {
    let state: TokenBucketState = initialBucket(FIVE, T0);
    for (let i = 0; i < 5; i += 1) {
      const result = take(state, FIVE, T0);
      expect(result.allowed).toBe(true);
      state = result.state;
    }
    const refused = take(state, FIVE, T0);
    expect(refused).toMatchObject({ allowed: false, retryAfterMs: 200 });
    // 200 ms later exactly one token has been refilled.
    const next = take(refused.state, FIVE, T0 + 200);
    expect(next.allowed).toBe(true);
    expect(take(next.state, FIVE, T0 + 200).allowed).toBe(false);
  });

  it('refills from elapsed time and caps at the burst', () => {
    const empty: TokenBucketState = { tokens: 0, updatedAtMs: T0, blockedUntilMs: 0 };
    expect(refill(empty, FIVE, T0 + 100).tokens).toBeCloseTo(0.5, 10);
    expect(refill(empty, FIVE, T0 + 60_000).tokens).toBe(5);
  });

  it('never mints tokens when the clock runs backwards', () => {
    const empty: TokenBucketState = { tokens: 1, updatedAtMs: T0, blockedUntilMs: 0 };
    expect(refill(empty, FIVE, T0 - 10_000)).toEqual(empty);
  });

  it('holds exactly the per-second rate over a long run', () => {
    let state = initialBucket(FIVE, T0);
    let allowed = 0;
    // One attempt every 10 ms for 10 seconds.
    for (let ms = 0; ms < 10_000; ms += 10) {
      const result = take(state, FIVE, T0 + ms);
      state = result.state;
      allowed += result.allowed ? 1 : 0;
    }
    // The initial burst plus five a second.
    expect(allowed).toBe(5 + 50 - 1);
  });

  it('backoff empties the bucket and blocks it; a later backoff never shortens the block', () => {
    const blocked = backoff(initialBucket(FIVE, T0), FIVE, T0, 3_000);
    expect(blocked).toEqual({ tokens: 0, updatedAtMs: T0, blockedUntilMs: T0 + 3_000 });
    expect(take(blocked, FIVE, T0 + 2_999)).toMatchObject({ allowed: false, retryAfterMs: 1 });
    expect(take(blocked, FIVE, T0 + 3_000).allowed).toBe(true);
    expect(backoff(blocked, FIVE, T0 + 1_000, 500).blockedUntilMs).toBe(T0 + 3_000);
  });

  it('rejects a non-positive rate and a burst below one token', () => {
    expect(() => bucketConfig(0)).toThrow(RangeError);
    expect(() => bucketConfig(-1)).toThrow(RangeError);
    expect(() => bucketConfig(5, 0.5)).toThrow(RangeError);
    expect(() => bucketConfig(Number.NaN)).toThrow(RangeError);
  });
});

describe('no timers in the provider layer', () => {
  it('src/providers and the ProviderBudget object never schedule a setTimeout or setInterval', () => {
    // A pending timer keeps a Durable Object from hibernating (billed while idle), and the bucket
    // is refilled on read precisely so that none is needed.
    const sources: Record<string, string> = {
      'providers/aerodatabox.adapter.ts': adapterSource,
      'providers/aeroapi.mock.ts': aeroapiSource,
      'providers/budget.ts': budgetSource,
      'providers/config.ts': configSource,
      'providers/cost-log.ts': costLogSource,
      'providers/http.ts': httpSource,
      'providers/router.ts': routerSource,
      'providers/token-bucket.ts': bucketSource,
      'do/provider-budget.ts': providerBudgetSource,
    };
    for (const [path, source] of Object.entries(sources)) {
      expect(source.length, path).toBeGreaterThan(500);
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, path).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
    }
  });
});
