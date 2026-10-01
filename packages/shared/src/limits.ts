/**
 * Free-tier limits and the constants of the sync and idempotency contracts (increment 8, ruling
 * K3). One module, so the API routes, the FlightTracker's own refresh cap and the mobile client's
 * copy of the rules read the same numbers.
 *
 * Every cap here is enforced in Postgres (`usage_counters`, one `INSERT ... ON CONFLICT DO UPDATE
 * ... WHERE count < cap RETURNING` statement per take), never with the Cloudflare rate limit
 * binding, which is per colo and documented as not an accounting system.
 */

export const FREE_TIER_LIMITS = Object.freeze({
  /** Live (not tombstoned) `flight_subscriptions` rows per user. */
  activeSubscriptions: 5,
  /**
   * Of those, how many may be live-tracked at once (ruling O3): a slot is taken where the flight
   * enters its live window (`isInLiveWindow`), at subscribe for a flight already inside it or by
   * the persist consumer on the first row that puts it there, and released where it is over
   * (arrived, cancelled, finished) or unsubscribed. A subscription the cap refuses stays tracked,
   * flagged not live-tracked.
   */
  liveTracked: 2,
  /** Trackers a user's requests may create per UTC day (the provider spend). */
  instancesCreatedPerDay: 20,
  /** Trackers anonymous callers may create per UTC day per salted client IP. */
  anonymousTrackerCreationsPerDayPerIp: 10,
  /** User refreshes per flight per UTC day; the FlightTracker enforces the same number. */
  refreshesPerFlightPerDay: 10,
  /**
   * Route searches (`GET /v1/airports/{origin}/flights/to/{destination}`, increment 18, ruling
   * B9) per user per UTC day. Open to anonymous accounts, because route search is the onboarding
   * path; every search reads the origin's board buckets, so it is capped like a creation.
   */
  routeSearchesPerDay: 30,
  /** Route searches anonymous callers may make per UTC day per salted client IP. */
  anonymousRouteSearchesPerDayPerIp: 30,
} as const);

export type FreeTierLimits = typeof FREE_TIER_LIMITS;

/**
 * The counter names in `usage_counters.counter`. `refresh` is stored per flight as
 * `refresh:{flightKey}` (ruling K2); the others are stored as named.
 */
export const CAP_NAMES = [
  'active_subscriptions',
  'live_tracked',
  'instances_created',
  'tracker_creations',
  'refresh',
  'route_searches',
] as const;
export type CapName = (typeof CAP_NAMES)[number];

/** The limit a cap enforces for a free account. */
export function freeTierLimit(cap: CapName): number {
  switch (cap) {
    case 'active_subscriptions':
      return FREE_TIER_LIMITS.activeSubscriptions;
    case 'live_tracked':
      return FREE_TIER_LIMITS.liveTracked;
    case 'instances_created':
      return FREE_TIER_LIMITS.instancesCreatedPerDay;
    case 'tracker_creations':
      return FREE_TIER_LIMITS.anonymousTrackerCreationsPerDayPerIp;
    case 'refresh':
      return FREE_TIER_LIMITS.refreshesPerFlightPerDay;
    case 'route_searches':
      return FREE_TIER_LIMITS.routeSearchesPerDay;
  }
}

/** The most rows one `GET /v1/sync` page returns; the server fetches one more for `hasMore`. */
export const SYNC_PAGE_SIZE = 200;

/** How long the change tables keep a row; an older cursor answers 410 `resync_required`. */
export const SYNC_RETENTION_DAYS = 30;

/** How long an `Idempotency-Key` stays replayable. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** How long a `deleted_subjects` row for a provider subject is kept before housekeeping purges it. */
export const DELETED_SUBJECT_RETENTION_DAYS = 400;

/**
 * How long a `deleted_subjects` row for a deleted account's SESSION is kept: the longest a Better
 * Auth session can outlive its last use (30 days) plus a day, after which no device can still
 * present the cookie and the `account_deleted` answer has nothing left to explain.
 */
export const DELETED_SESSION_RETENTION_DAYS = 31;

/** The route's own deadline on a Durable Object call (ruling K6; no platform timeout exists). */
export const DO_CALL_DEADLINE_MS = 8_000;

/**
 * A flight is live-tracked from this long before its scheduled departure until it is over. The
 * 48 h lead is where the cadence leaves the weekly pre-48 h tier and where AeroAPI may be asked
 * about the flight at all, i.e. where the provider spend a free account is capped on starts.
 */
export const LIVE_TRACKING_LEAD_MS = 48 * 60 * 60_000;

/** Phases after which a flight is no longer tracked live. */
const OVER_PHASES: ReadonlySet<string> = new Set(['arrived', 'cancelled', 'finished']);

export interface LiveWindowInput {
  /** The tracker phase (`getState().phase`) or the flight status. */
  readonly phase: string;
  /** Scheduled departure, ISO-8601; unknown means "not provably outside the window". */
  readonly scheduledOut?: string | null | undefined;
}

/**
 * Whether a flight is inside its live window at `nowMs`: not over, and departing within
 * `LIVE_TRACKING_LEAD_MS` (or already departed). A flight whose scheduled departure is unknown is
 * treated as live, which is the conservative side of a cap.
 */
export function isInLiveWindow(input: LiveWindowInput, nowMs: number): boolean {
  if (OVER_PHASES.has(input.phase)) {
    return false;
  }
  if (input.scheduledOut === undefined || input.scheduledOut === null) {
    return true;
  }
  const out = Date.parse(input.scheduledOut);
  if (Number.isNaN(out)) {
    return true;
  }
  return out - nowMs <= LIVE_TRACKING_LEAD_MS;
}
