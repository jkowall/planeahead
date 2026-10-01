import type { CarrierRef } from './carriers';
import type { FlightKey } from './flight-key';
import type {
  AircraftPosition,
  AlertEvent,
  BoardRow,
  Exact,
  FlightStatus,
  ProviderCallRecord,
  ProviderCallTrigger,
  ProviderEvent,
  ProviderId,
} from './flight-status';

export { ALERT_EVENTS, AlertEventSchema } from './flight-status';
export type { AlertEvent } from './flight-status';

/**
 * Provider interfaces (plan section 7). Adapters live in `apps/api/src/providers`; this module
 * only fixes the shapes so the FlightTracker, the DesignatorResolver and the tests agree on
 * them. Three rules are encoded in the types rather than in prose:
 *
 * 1. Every call returns `ProviderResult<T>`, which carries the `ProviderCallRecord` for that
 *    call. A call whose cost is not recorded does not type-check.
 * 2. `ProviderCallContext.now` is the only clock an adapter may read. Nothing in this package
 *    reads the wall clock except the `uuidv7` default clock in `ids.ts`, so tests can drive time.
 * 3. Adapters hand-map provider JSON into the shared shapes, so they return `Exact<...>` types:
 *    a misspelled field is a compile error rather than a gate that never renders.
 * 4. Every record is written exactly once. The caller records `result.call` through its
 *    `CostLogger`; an adapter that makes more than one HTTP call for one operation (the
 *    AeroDataBox plus or minus one day retry) records every attempt it does NOT return through
 *    `ctx.log` itself, so a retried miss is billed in the ledger like any other call.
 *
 * Optional properties are declared `T | undefined` so a caller holding an optional value can
 * pass it straight through under `exactOptionalPropertyTypes`.
 */

export interface FlightLookup {
  carrier: CarrierRef;
  /** Digits without leading zeros, optional single-letter suffix (`100`, `100A`). */
  flightNumber: string;
  /** `YYYY-MM-DD` at the origin. */
  dateLocal: string;
  originIcao?: string | undefined;
  /** Provider-side id after the first fetch (AeroAPI `fa_flight_id`). */
  providerRef?: { provider: ProviderId; id: string } | undefined;
  /**
   * The instance's `scheduled_out` once known (an ISO instant, from the tracker's snapshot).
   * AeroAPI brackets its first fetch around it and answers with the instance nearest to it;
   * AeroDataBox, which asks by the origin-local date, ignores it.
   */
  scheduledOut?: string | undefined;
  /**
   * An explicit bracket, `scheduled_out` plus or minus one day as ISO instants, UNCLAMPED: its
   * midpoint is read as `scheduled_out`. Prefer `scheduledOut`; `window` is for a caller that
   * holds only the bracket.
   */
  window?: { start: string; end: string } | undefined;
}

/**
 * A board (FIDS) window: airport-LOCAL wall-clock times `YYYY-MM-DDTHH:mm` at the airport the
 * board is for, plus that airport's IANA zone. AeroDataBox asks in local time and uses `from` and
 * `to` as they are; `tz` lets a caller turn the window into instants. Which flights a window
 * selects is the provider's: AeroDataBox FIDS returns flights "scheduled, planned or commenced"
 * within the range, and its spec does not say whether the scheduled or the revised time decides
 * membership (R3 F9; unverified, R3 U1). Boards are AeroDataBox only (Phase 1 plan section 3).
 */
export interface BoardWindow {
  from: string;
  to: string;
  tz: string;
}

export interface ProviderCapabilities {
  alerts: boolean;
  /** Which fields the provider's alert payloads are known to carry. Measured, not assumed. */
  alertFields: ReadonlyArray<'status' | 'times' | 'gate' | 'unknown'>;
  boards: boolean;
  /**
   * How far ahead a status lookup can see, in days. A PLAN attribute supplied by configuration,
   * never a provider constant: AeroDataBox 180 / 365 / 365 on Starter / Growth / Scale (the
   * pricing page; the real lookahead is measured with a key and recorded in the build log),
   * AeroAPI 2 (the `/flights/{ident}` window).
   */
  maxDaysAhead: number;
  /**
   * The widest board (FIDS) window one call may ask for, in hours. Also a plan attribute:
   * AeroDataBox 12 / 24 / 48 on Starter / Growth / Scale.
   */
  fidsWindowHours: number;
  /** Whether the provider links the inbound aircraft rotation. */
  inboundLink: boolean;
}

export type BudgetDenialReason =
  | 'per_flight_hard_cap'
  | 'provider_daily_cap'
  | 'provider_kill_switch'
  | 'provider_rate_limit'
  | 'user_refresh_cap'
  | 'routing_rule'
  // Increment 18 (ruling B5), for the `board` and `route_search` triggers only: the boards
  // share of the day's AeroDataBox cap is spent, or the hour's distinct-airport cap is reached.
  | 'boards_share'
  | 'board_airports_per_hour';

export type BudgetDecision =
  | {
      allowed: true;
      /** Poll-equivalents granted, which may exceed the request when a lease is handed out. */
      granted: number;
      /** Which rung of the 70 / 90 / 100 percent ladder the provider is on right now. */
      ladder: 'normal' | 'warn' | 'degraded';
      /**
       * Board triggers only (increment 18): the fraction of the boards share spent after this
       * reservation, 0 to 1. `AirportState` degrades its freshness ladder from it.
       */
      boardsShareSpent?: number | undefined;
    }
  | {
      allowed: false;
      reason: BudgetDenialReason;
      /** For `provider_rate_limit`: when the per-second token bucket next has a token. */
      retryAfterMs?: number | undefined;
      /** Board triggers only: the fraction of the boards share spent, 0 to 1. */
      boardsShareSpent?: number | undefined;
    };

export interface BudgetRequest {
  provider: ProviderId;
  operation: string;
  pollEquivalents: number;
  trigger: ProviderCallTrigger;
  flightKey?: FlightKey | undefined;
  /**
   * The airport a board or route-search call is for (increment 18): the key of the hourly cap
   * on distinct airports refreshed. Absent on every other call.
   */
  airportIcao?: string | undefined;
  /**
   * The UTC day (`YYYY-MM-DD`) whose provider-wide budget this reservation debits, decided once
   * when the request is built. `release` refunds that same day even after midnight, where a
   * clock read at release time would refund the next day for a debit it never saw.
   */
  utcDate?: string | undefined;
}

/**
 * Gate in front of every billable call. Implementations: the per-flight ledger inside the
 * FlightTracker and the per-provider daily counter in the ProviderBudget object.
 */
export interface BudgetGuard {
  reserve(request: BudgetRequest): Promise<BudgetDecision>;
  /**
   * Returns unused poll-equivalents from a reservation: a call that was never made, or one the
   * provider did not bill (AeroDataBox 429, 503 or a non-JSON body).
   */
  release?(request: BudgetRequest, unusedPollEquivalents: number): Promise<void>;
  /**
   * Tells the per-second token bucket that the provider pushed back (a 429, a 503, a Cloudflare
   * HTML page), so the next reservations wait `retryAfterMs` instead of retrying straight away.
   */
  backoff?(provider: ProviderId, retryAfterMs: number): Promise<void>;
}

/**
 * Sink for `ProviderCallRecord`s. Inside a Durable Object it appends to the outbox; in a
 * Worker it writes directly. The persist consumer turns each record into a `provider_calls`
 * row and one Analytics Engine point.
 */
export interface CostLogger {
  record(call: ProviderCallRecord): void | Promise<void>;
}

export interface ProviderCallContext {
  trigger: ProviderCallTrigger;
  flightKey?: FlightKey | undefined;
  airportIcao?: string | undefined;
  requestId: string;
  budget: BudgetGuard;
  log: CostLogger;
  /** Injectable clock. Adapters must not read `Date.now()`. */
  now: () => Date;
}

export interface ProviderResult<T> {
  data: T;
  call: ProviderCallRecord;
}

export interface AlertRegistrationOptions {
  events: readonly AlertEvent[];
  /**
   * AeroAPI `max_weekly`. A CREATION-TIME rejection threshold (the alert is refused when its
   * estimated weekly deliveries exceed it), write-only, and explicitly NOT a spend cap: it does
   * not stop deliveries once the alert exists. The budget guard counts deliveries in our own
   * ledger and deletes the alert (facts sheet section 2).
   */
  maxWeekly: number;
}

export interface FlightDataProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  /**
   * Every flight the provider returns for the lookup, as an array: AeroDataBox answers a
   * designator and date with every matching operation, and AeroAPI answers a diverted flight
   * with the original leg plus each diversion under one `fa_flight_id`. Empty on a miss.
   *
   * One HTTP call per lookup, except for a person-supplied date (`ctx.trigger` `user_search` or
   * `import`), where AeroDataBox retries the day before and the day after on a miss. A tracker's
   * own triggers (`alarm`, `reconcile`, `user_refresh`, `provider_alert`) never pay for a retry:
   * the key's date is canonical.
   */
  getFlight(
    lookup: FlightLookup,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<Exact<FlightStatus>[]>>;
  /**
   * One board call for an airport and a window, both directions in one response (R3 D2): the
   * departures and the arrivals as `BoardRow`s, each carrying its `direction`. An item that
   * cannot be keyed is skipped and counted on the call record's `error`.
   */
  getAirportBoard?(
    airportIcao: string,
    window: BoardWindow,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<Exact<BoardRow>[]>>;
  registerAlert?(
    key: FlightKey,
    options: AlertRegistrationOptions,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ alertId: string }>>;
  deleteAlert?(alertId: string, ctx: ProviderCallContext): Promise<ProviderResult<void>>;
  /** Verifies and normalises a webhook; enqueue only, never fetch. */
  parseWebhook?(raw: Request): Promise<Exact<ProviderEvent>[]>;
}

export interface AircraftPositionQuery {
  icaoHexes?: readonly string[] | undefined;
  callsigns?: readonly string[] | undefined;
}

export interface AircraftPositionProvider {
  readonly id: ProviderId;
  /** Measured at startup against the live feed, never assumed. */
  readonly maxIdsPerRequest: number;
  getPositions(
    query: AircraftPositionQuery,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<Exact<AircraftPosition>[]>>;
}
