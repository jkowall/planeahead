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
 *
 * SEMANTICS OF A LIMIT. Neither provider says whether "N per second" is a fixed or a rolling
 * window, so the bucket assumes the stricter: at most N grants in ANY one-second window. A bucket
 * of burst `b` refilled at `r` per second grants at most `b + r` in one second (the full bucket,
 * then a second of refill), so `bucketForLimit` splits the limit between the two: `b` is half the
 * limit rounded down, `r` the rest. A limit below 2 cannot be split with whole tokens; it gets a
 * burst of 1 and a rate of at most 1, which also stays within one grant per second. The earlier
 * `burst = rate` handed out up to `2N - 1` in a second (9 at 5 per second).
 *
 * WHY HALF THE LIMIT GOES TO THE BURST (increment 6 re-review, orchestrator decision). The
 * sustained rate of this bucket is `r` alone, so the split leaves the paid limit half used under
 * steady load (5 a second sustained against AeroDataBox Growth's 10). A burst of one token with
 * `r = N - 1` would nearly double that, and it was rejected on purpose: a refusal here is not a
 * wait. The provider layer has no timers (a pending `setTimeout` pins a Durable Object awake), so
 * `http.ts` turns a `provider_rate_limit` denial into a zero-cost `rate_limited` record and the
 * caller's poll slot is lost. Debits arrive as independent FlightTracker alarms, a Poisson stream
 * of about 3.4 a second on average at 100,000 flights a month; with a burst of one and 9 a
 * second, roughly a third of them would land inside the 111 ms an earlier grant blocks and lose
 * their slot, while a burst of five absorbs that clustering and 5 a second still clears the mean.
 * The sustained rate only has to beat the average debit rate; the burst is what keeps clustered
 * alarms from failing. Revisit (a larger plan, or the sharding hatch) when the mean debit rate
 * approaches half the plan limit, not when the peak does.
 *
 * That reasoning counts tracker debits only. Since increment 18 the `board` and `route_search`
 * calls draw from the same bucket, and a cold board open takes several tokens at once, which
 * would spend the burst the clustered alarms need (review A's MA1: two cold opens on Growth
 * emptied it and the next tracker alarm lost its slot). So a board call takes a token only while
 * the bucket keeps `keep` more (`take`'s floor, sized by `boardTokenFloor` in `boards-budget.ts`,
 * ruling R2): board traffic alone never takes the bucket below the floor, and a tracker alarm
 * finds at least that many tokens unless other trackers spent them (2 of Growth's burst of 5).
 *
 * Sharding caveat: the burst cannot go below one token, so eight shards of one provider each keep
 * a burst of 1 and can release 8 grants in the same instant against a limit of 5. The sharding
 * escape hatch (src/do/provider-budget.ts) must route the per-second limit through one object or
 * accept that edge.
 */

export interface TokenBucketConfig {
  /** Tokens added per second. */
  readonly ratePerSecond: number;
  /** The most tokens the bucket holds. */
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
  /** 0 when allowed; otherwise the wait until a token (and the floor, if any) is available. */
  readonly retryAfterMs: number;
  /** True for a refusal that only the `keep` floor caused: the bucket held the cost itself. */
  readonly floored: boolean;
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

/**
 * The bucket for a provider limit of `limit` requests per second: at most `limit` grants in any
 * one-second window (see the module comment), and never less than one grant a second.
 */
export function bucketForLimit(limit: number): TokenBucketConfig {
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new RangeError(`per-second limit must be positive, got ${String(limit)}`);
  }
  if (limit < 2) {
    return bucketConfig(Math.min(limit, 1), 1);
  }
  const burst = Math.floor(limit / 2);
  return bucketConfig(limit - burst, burst);
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

/**
 * Takes `cost` tokens if the bucket has them and is not blocked. `keep` is a floor the take may
 * not cross (ruling R2): the bucket must hold `cost + keep`, and a refusal waits for that much. It
 * is capped at `burst - cost`, so a full bucket always serves the call and a floor can only delay
 * it, never starve it.
 */
export function take(
  state: TokenBucketState,
  config: TokenBucketConfig,
  nowMs: number,
  cost = 1,
  keep = 0,
): TakeResult {
  const refilled = refill(state, config, nowMs);
  if (nowMs < refilled.blockedUntilMs) {
    return {
      allowed: false,
      state: refilled,
      retryAfterMs: refilled.blockedUntilMs - nowMs,
      floored: false,
    };
  }
  const needed = cost + Math.max(0, Math.min(keep, config.burst - cost));
  if (refilled.tokens + EPSILON >= needed) {
    return {
      allowed: true,
      state: { ...refilled, tokens: Math.max(0, refilled.tokens - cost) },
      retryAfterMs: 0,
      floored: false,
    };
  }
  const missing = needed - refilled.tokens;
  return {
    allowed: false,
    state: refilled,
    retryAfterMs: Math.max(1, Math.ceil((missing * 1_000) / config.ratePerSecond)),
    floored: refilled.tokens + EPSILON >= cost,
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
