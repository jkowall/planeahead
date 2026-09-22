/**
 * The per-provider token bucket, as pure functions over a stored state (increment 6).
 *
 * AeroDataBox enforces 5, 10 or 20 requests per second by plan and AeroAPI Standard 5 result
 * sets per second (facts sheet section 5), and neither documents what a breach returns. The
 * bucket keeps us under the limit rather than finding it.
 *
 * There is no timer anywhere. The state (`tokens`, `updatedAtMs`, `blockedUntilMs`) lives in the
 * ProviderBudget object's SQLite storage, never in an isolate global, and every read refills it
 * from the elapsed time: `tokens + elapsed x rate`, capped at `burst`. A pending `setTimeout`
 * would make the object permanently non-hibernateable and billable while idle (facts sheet
 * section 5), and a module-level bucket would be one per isolate rather than one per provider.
 *
 * `backoff` is how a provider's push-back (a 429, a 503, a Cloudflare HTML page) reaches the
 * bucket: it empties the bucket and blocks it until the given instant, so the next reservations
 * wait instead of retrying into the same wall.
 */

export interface TokenBucketConfig {
  /** Tokens added per second; the provider's per-second limit. */
  readonly ratePerSecond: number;
  /** The most tokens the bucket holds; one second's worth by default. */
  readonly burst: number;
}

export interface TokenBucketState {
  readonly tokens: number;
  /** The instant `tokens` was last brought up to date. */
  readonly updatedAtMs: number;
  /** No token is handed out before this instant (0 when not blocked). */
  readonly blockedUntilMs: number;
}

export interface TakeResult {
  readonly allowed: boolean;
  /** The state to store, whether or not the take succeeded (it carries the refill). */
  readonly state: TokenBucketState;
  /** 0 when allowed; otherwise the wait until a token is available. */
  readonly retryAfterMs: number;
}

/** Float noise guard: 4.999999999 tokens is 5. */
const EPSILON = 1e-9;

export function bucketConfig(
  perSecondLimit: number,
  burst: number = perSecondLimit,
): TokenBucketConfig {
  if (!Number.isFinite(perSecondLimit) || perSecondLimit <= 0) {
    throw new RangeError(`token bucket rate must be positive, got ${String(perSecondLimit)}`);
  }
  if (!Number.isFinite(burst) || burst < 1) {
    throw new RangeError(`token bucket burst must be at least 1, got ${String(burst)}`);
  }
  return { ratePerSecond: perSecondLimit, burst };
}

/** A full bucket at `nowMs`. */
export function initialBucket(config: TokenBucketConfig, nowMs: number): TokenBucketState {
  return { tokens: config.burst, updatedAtMs: nowMs, blockedUntilMs: 0 };
}

/**
 * The state brought up to `nowMs`. A clock that runs backwards (another colo, a test clock) adds
 * nothing and does not move `updatedAtMs` back, so a skew can never mint tokens.
 */
export function refill(
  state: TokenBucketState,
  config: TokenBucketConfig,
  nowMs: number,
): TokenBucketState {
  const elapsedMs = Math.max(0, nowMs - state.updatedAtMs);
  const tokens = Math.min(config.burst, state.tokens + (elapsedMs * config.ratePerSecond) / 1_000);
  return {
    tokens,
    updatedAtMs: Math.max(state.updatedAtMs, nowMs),
    blockedUntilMs: state.blockedUntilMs,
  };
}

/** Takes `cost` tokens if the bucket has them and is not blocked. */
export function take(
  state: TokenBucketState,
  config: TokenBucketConfig,
  nowMs: number,
  cost = 1,
): TakeResult {
  const refilled = refill(state, config, nowMs);
  if (nowMs < refilled.blockedUntilMs) {
    return { allowed: false, state: refilled, retryAfterMs: refilled.blockedUntilMs - nowMs };
  }
  if (refilled.tokens + EPSILON >= cost) {
    return {
      allowed: true,
      state: { ...refilled, tokens: Math.max(0, refilled.tokens - cost) },
      retryAfterMs: 0,
    };
  }
  const missing = cost - refilled.tokens;
  return {
    allowed: false,
    state: refilled,
    retryAfterMs: Math.max(1, Math.ceil((missing * 1_000) / config.ratePerSecond)),
  };
}

/** Empties the bucket and blocks it for `retryAfterMs` from `nowMs` (never shortens a block). */
export function backoff(
  state: TokenBucketState,
  config: TokenBucketConfig,
  nowMs: number,
  retryAfterMs: number,
): TokenBucketState {
  const refilled = refill(state, config, nowMs);
  return {
    tokens: 0,
    updatedAtMs: refilled.updatedAtMs,
    blockedUntilMs: Math.max(refilled.blockedUntilMs, nowMs + Math.max(0, retryAfterMs)),
  };
}
