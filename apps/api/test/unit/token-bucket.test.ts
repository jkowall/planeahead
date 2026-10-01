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
import webhookTokenSource from '../../src/providers/webhook-token.ts?raw';
import { boardTokenFloor } from '../../src/providers/boards-budget';
import { ADB_PLANS } from '../../src/providers/config';
import {
  backoff,
  bucketConfig,
  bucketForLimit,
  initialBucket,
  refill,
  take,
  type TokenBucketConfig,
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

/**
 * Drives a bucket with `attempt(ms)` deciding when a caller tries (every millisecond by default)
 * and returns the instants it granted.
 */
function grants(
  config: TokenBucketConfig,
  durationMs: number,
  attempt: (ms: number) => boolean = () => true,
): number[] {
  let state = initialBucket(config, T0);
  const granted: number[] = [];
  for (let ms = 0; ms < durationMs; ms += 1) {
    if (!attempt(ms)) {
      continue;
    }
    const result = take(state, config, T0 + ms);
    state = result.state;
    if (result.allowed) {
      granted.push(ms);
    }
  }
  return granted;
}

/** The most grants inside any window of `windowMs`, closed at both ends when `closed`. */
function maxInWindow(granted: readonly number[], windowMs: number, closed: boolean): number {
  let most = 0;
  for (let i = 0; i < granted.length; i += 1) {
    const from = granted[i] ?? 0;
    const count = granted.filter((ms) =>
      closed ? ms >= from && ms <= from + windowMs : ms >= from && ms < from + windowMs,
    ).length;
    most = Math.max(most, count);
  }
  return most;
}

describe('bucketForLimit: a provider limit held in ANY one-second window', () => {
  it('splits the limit between burst and rate so burst + rate never exceeds it', () => {
    expect(bucketForLimit(5)).toEqual({ ratePerSecond: 3, burst: 2 });
    expect(bucketForLimit(10)).toEqual({ ratePerSecond: 5, burst: 5 });
    expect(bucketForLimit(20)).toEqual({ ratePerSecond: 10, burst: 10 });
    expect(bucketForLimit(1)).toEqual({ ratePerSecond: 1, burst: 1 });
    // A shard's eighth of AeroAPI's 5 per second: one token, refilled slowly.
    expect(bucketForLimit(0.625)).toEqual({ ratePerSecond: 0.625, burst: 1 });
    expect(() => bucketForLimit(0)).toThrow(RangeError);
    expect(() => bucketForLimit(Number.NaN)).toThrow(RangeError);
  });

  it.each([5, 10, 20])(
    'at %i per second, no rolling second ever holds more grants than the limit',
    (limit) => {
      const config = bucketForLimit(limit);
      // Greedy: a caller at every millisecond. Then bursty: idle long enough to refill fully,
      // then hammer, repeatedly, which is the pattern that broke burst = rate.
      const greedy = grants(config, 5_000);
      const bursty = grants(config, 10_000, (ms) => ms % 2_500 < 1_200);
      for (const granted of [greedy, bursty]) {
        expect(maxInWindow(granted, 1_000, true)).toBeLessThanOrEqual(limit);
      }
      // The old sizing (burst equal to the rate) granted almost twice the limit in one second.
      const old = grants(bucketConfig(limit, limit), 2_000);
      expect(maxInWindow(old, 1_000, false)).toBe(2 * limit - 1);
    },
  );

  it.each([1, 1.25, 0.625])(
    'below 2 per second (%d) it grants at most one in any second',
    (limit) => {
      const granted = grants(bucketForLimit(limit), 6_000);
      expect(granted.length).toBeGreaterThan(1);
      expect(maxInWindow(granted, 1_000, false)).toBe(1);
    },
  );
});

describe('the floor a board call leaves for the trackers (ruling R2)', () => {
  const GROWTH = bucketForLimit(10); // a burst of 5, refilled at 5 a second

  it('takes only while the bucket keeps the floor, waits for it, and says when it alone refused', () => {
    let state = initialBucket(GROWTH, T0);
    const allowed: boolean[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = take(state, GROWTH, T0, 1, 2);
      allowed.push(result.allowed);
      state = result.state;
    }
    expect(allowed).toEqual([true, true, true, false]);
    // Two tokens left: enough for the call, not for the call and the floor; 200 ms refills one.
    expect(take(state, GROWTH, T0, 1, 2)).toMatchObject({
      allowed: false,
      floored: true,
      retryAfterMs: 200,
    });
    expect(take(state, GROWTH, T0 + 200, 1, 2).allowed).toBe(true);
    // A tracker (no floor) still finds both tokens.
    const first = take(state, GROWTH, T0);
    const second = take(first.state, GROWTH, T0);
    expect([first, second].map((r) => [r.allowed, r.floored])).toEqual([
      [true, false],
      [true, false],
    ]);
    // Empty, a board call meets the rate itself: not the floor's refusal; the wait covers both.
    expect(take(second.state, GROWTH, T0, 1, 2)).toMatchObject({
      allowed: false,
      floored: false,
      retryAfterMs: 600,
    });
  });

  it('never takes the bucket below the floor, however hard board calls press', () => {
    let state = initialBucket(GROWTH, T0);
    let granted = 0;
    for (let ms = 0; ms < 3_000; ms += 1) {
      const result = take(state, GROWTH, T0 + ms, 1, 2);
      state = result.state;
      if (result.allowed) {
        granted += 1;
        expect(state.tokens).toBeGreaterThanOrEqual(2 - 1e-9);
      }
    }
    // Three tokens above the floor, then the refill: the rate is unchanged, only the burst shrinks.
    expect(granted).toBe(3 + 15 - 1);
  });

  it('caps the floor below the burst, so a full bucket always serves the call', () => {
    const starter = bucketForLimit(5); // a burst of 2
    expect(take(initialBucket(starter, T0), starter, T0, 1, 5).allowed).toBe(true);
    const one = bucketForLimit(1);
    expect(take(initialBucket(one, T0), one, T0, 1, 1).allowed).toBe(true);
    // A blocked bucket is a rate refusal, never the floor's.
    const blocked = backoff(initialBucket(starter, T0), starter, T0, 1_000);
    expect(take(blocked, starter, T0, 1, 1)).toMatchObject({ allowed: false, floored: false });
  });

  it.each([
    ['starter', 1],
    ['growth', 2],
    ['scale', 5],
  ] as const)('%s keeps %i token(s): half its burst, rounded down', (plan, floor) => {
    expect(boardTokenFloor(bucketForLimit(ADB_PLANS[plan].perSecondLimit))).toBe(floor);
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
      'providers/webhook-token.ts': webhookTokenSource,
      'do/provider-budget.ts': providerBudgetSource,
    };
    for (const [path, source] of Object.entries(sources)) {
      expect(source.length, path).toBeGreaterThan(500);
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, path).not.toMatch(/\bsetTimeout\b|\bsetInterval\b/);
    }
  });
});
