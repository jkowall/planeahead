import type { CarrierRef } from './carriers';
import type { FlightKey } from './flight-key';
import type {
  AircraftPosition,
  AlertEvent,
  BoardRow,
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
 * them. Two rules are encoded in the types rather than in prose:
 *
 * 1. Every call returns `ProviderResult<T>`, which carries the `ProviderCallRecord` for that
 *    call. A call whose cost is not recorded does not type-check.
 * 2. `ProviderCallContext.now` is the only clock an adapter may read. Nothing in this package
 *    reads the wall clock except the `uuidv7` default clock in `ids.ts`, so tests can drive time.
 */

export interface FlightLookup {
  carrier: CarrierRef;
  /** Digits without leading zeros, optional single-letter suffix (`100`, `100A`). */
  flightNumber: string;
  /** `YYYY-MM-DD` at the origin. */
  dateLocal: string;
  originIcao?: string;
  /** Provider-side id after the first fetch (AeroAPI `fa_flight_id`). */
  providerRef?: { provider: ProviderId; id: string };
  /** Bracketed first fetch: `scheduled_out` plus or minus one day, ISO instants. */
  window?: { start: string; end: string };
}

export interface ProviderCapabilities {
  alerts: boolean;
  /** Which fields the provider's alert payloads are known to carry. Measured, not assumed. */
  alertFields: ReadonlyArray<'status' | 'times' | 'gate' | 'unknown'>;
  boards: boolean;
  /** How far ahead a status lookup can see. AeroAPI: 2. AeroDataBox: measured in increment 6. */
  maxDaysAhead: number;
  /** Whether the provider links the inbound aircraft rotation. */
  inboundLink: boolean;
}

export type BudgetDenialReason =
  | 'per_flight_hard_cap'
  | 'provider_daily_cap'
  | 'provider_kill_switch'
  | 'user_refresh_cap'
  | 'routing_rule';

export type BudgetDecision =
  | {
      allowed: true;
      /** Poll-equivalents granted, which may exceed the request when a lease is handed out. */
      granted: number;
      /** Which rung of the 70 / 90 / 100 percent ladder the provider is on right now. */
      ladder: 'normal' | 'warn' | 'degraded';
    }
  | { allowed: false; reason: BudgetDenialReason };

export interface BudgetRequest {
  provider: ProviderId;
  operation: string;
  pollEquivalents: number;
  trigger: ProviderCallTrigger;
  flightKey?: FlightKey;
}

/**
 * Gate in front of every billable call. Implementations: the per-flight ledger inside the
 * FlightTracker and the per-provider daily counter in the ProviderBudget object.
 */
export interface BudgetGuard {
  reserve(request: BudgetRequest): Promise<BudgetDecision>;
  /** Returns unused poll-equivalents from a reservation (a call that was never made). */
  release?(request: BudgetRequest, unusedPollEquivalents: number): Promise<void>;
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
  flightKey?: FlightKey;
  airportIcao?: string;
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
  /** AeroAPI `max_weekly`; the external backstop against runaway deliveries. */
  maxWeekly: number;
}

export interface FlightDataProvider {
  readonly id: ProviderId;
  readonly capabilities: ProviderCapabilities;
  getFlight(
    lookup: FlightLookup,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<FlightStatus[]>>;
  getBoard?(
    airportIcao: string,
    direction: 'dep' | 'arr',
    window: { from: string; to: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<BoardRow[]>>;
  registerAlert?(
    key: FlightKey,
    options: AlertRegistrationOptions,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ alertId: string }>>;
  deleteAlert?(alertId: string, ctx: ProviderCallContext): Promise<ProviderResult<void>>;
  /** Verifies and normalises a webhook; enqueue only, never fetch. */
  parseWebhook?(raw: Request): Promise<ProviderEvent[]>;
}

export interface AircraftPositionQuery {
  icaoHexes?: readonly string[];
  callsigns?: readonly string[];
}

export interface AircraftPositionProvider {
  readonly id: ProviderId;
  /** Measured at startup against the live feed, never assumed. */
  readonly maxIdsPerRequest: number;
  getPositions(
    query: AircraftPositionQuery,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<AircraftPosition[]>>;
}
