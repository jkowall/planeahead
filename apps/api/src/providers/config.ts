/**
 * Provider plans and runtime settings (increment 6).
 *
 * The per-second limits, the status lookahead and the FIDS window are PLAN attributes, not
 * provider constants (facts sheet section 1): AeroDataBox sells Starter, Growth and Scale with
 * 5, 10 and 20 requests per second, 180, 365 and 365 days of lookahead and 12, 24 and 48 hour
 * FIDS windows (https://aerodatabox.com/pricing/). AeroAPI Standard allows 5 result sets per
 * second and carries a $100 monthly minimum (https://www.flightaware.com/commercial/aeroapi/).
 * Everything here is read from configuration with a conservative default, so a missing or
 * mistyped setting slows the Worker down rather than overrunning a plan.
 *
 * The real AeroDataBox lookahead and its p50 and p95 latency are measured with a key and
 * recorded in the build log; until a key exists the pricing page values stand (pending).
 */

import type { ProviderId } from '@planeahead/shared';

export interface AdbPlan {
  readonly name: AdbPlanName;
  /** Units included per month; the daily cap below is derived from it. */
  readonly monthlyUnits: number;
  /** Requests per second the gateway enforces. */
  readonly perSecondLimit: number;
  /** How many days ahead a flight status lookup may ask for. */
  readonly maxDaysAhead: number;
  /** The widest FIDS window one call may ask for, in hours. */
  readonly fidsWindowHours: number;
}

export const ADB_PLANS = {
  starter: {
    name: 'starter',
    monthlyUnits: 40_000,
    perSecondLimit: 5,
    maxDaysAhead: 180,
    fidsWindowHours: 12,
  },
  growth: {
    name: 'growth',
    monthlyUnits: 400_000,
    perSecondLimit: 10,
    maxDaysAhead: 365,
    fidsWindowHours: 24,
  },
  scale: {
    name: 'scale',
    monthlyUnits: 4_000_000,
    perSecondLimit: 20,
    maxDaysAhead: 365,
    fidsWindowHours: 48,
  },
} as const satisfies Record<string, AdbPlan>;
export type AdbPlanName = 'starter' | 'growth' | 'scale';

/**
 * The boards share (increment 18, ruling B5; plan section 4, R3 D9): the fraction of the day's
 * AeroDataBox unit cap that the `board` and `route_search` triggers may spend together. A board
 * reservation beyond it is refused (`boards_share`), so boards and route search can never
 * starve the flight trackers, whose reservations never see this limit. A constant until the
 * budget becomes settable (increment 17).
 */
export const ADB_BOARDS_SHARE = 0.35;

/**
 * The global cap on DISTINCT airports whose boards are refreshed in one UTC hour (increment 18,
 * ruling B5), keyed by the airport each board reservation names, so no traffic pattern sweeps
 * airports the way the AeroDataBox Terms 8.2 forbid (R3 F17). An airport already refreshed in
 * the hour costs nothing more against it. Settable with the rest of the budget (increment 17).
 */
export const ADB_BOARD_AIRPORTS_PER_HOUR = 60;

/** AeroAPI Standard: 5 result sets per second, 2 days of lookahead on `/flights/{ident}`. */
export const AEROAPI_STANDARD = {
  perSecondLimit: 5,
  maxDaysAhead: 2,
  /** `start`/`end` may reach 10 days into the past. */
  maxDaysBehind: 10,
  /** Board windows are bounded by the same 2 days ahead. */
  fidsWindowHours: 48,
  /**
   * How far BEFORE the 2-day horizon a flight's `scheduled_out` must sit for AeroAPI to be asked
   * about it: the `end` bound is exclusive and clamped to the horizon, so a flight exactly at the
   * horizon lies outside every window AeroAPI accepts (the T-48 h slot). The router's T-48 h
   * guard and the bracket both use it, so the two can never disagree.
   */
  horizonMarginMs: 5 * 60_000,
  /**
   * How far INSIDE the 10-day limit a `start` is kept. The request reaches FlightAware later than
   * `now` (latency), and a start past the limit is a billed 400.
   */
  pastLimitMarginMs: 60_000,
} as const;

/**
 * PROVISIONAL daily cap for AeroAPI result sets: 10,000 is $50 a day at the status price. There
 * is no plan quota to derive it from; an admin sets the real value through `configure()` on the
 * ProviderBudget object (increment 12).
 */
export const AEROAPI_DEFAULT_DAILY_UNIT_CAP = 10_000;

/** Days per month the monthly AeroDataBox quota is spread over for the daily cap. */
const DAYS_PER_MONTH = 30;

/** `AEROAPI_MODE`: `mock` routes every window to AeroDataBox and never calls AeroAPI. */
export type AeroApiMode = 'mock' | 'live';

/** The settings the provider layer reads. Strings because bindings are strings. */
export interface ProviderSettingsEnv {
  readonly AEROAPI_MODE?: string | undefined;
  readonly ADB_PLAN?: string | undefined;
  readonly ADB_ALERTS_ENABLED?: string | undefined;
}

export interface ProviderSettings {
  readonly aeroapiMode: AeroApiMode;
  readonly adbPlan: AdbPlan;
  readonly adbAlertsEnabled: boolean;
}

function isAdbPlanName(value: string): value is AdbPlanName {
  return value === 'starter' || value === 'growth' || value === 'scale';
}

/**
 * Parses the settings. Unset or unrecognised values fall back to the cautious side: AeroAPI in
 * `mock` mode (no AeroAPI spend), the Starter plan (the lowest rate and lookahead) and
 * AeroDataBox alerts off. Only the exact strings `live` and `true` turn the first and last on.
 */
export function providerSettings(env: ProviderSettingsEnv): ProviderSettings {
  const mode = env.AEROAPI_MODE?.trim().toLowerCase();
  const plan = env.ADB_PLAN?.trim().toLowerCase() ?? '';
  return {
    aeroapiMode: mode === 'live' ? 'live' : 'mock',
    adbPlan: ADB_PLANS[isAdbPlanName(plan) ? plan : 'starter'],
    adbAlertsEnabled: env.ADB_ALERTS_ENABLED?.trim().toLowerCase() === 'true',
  };
}

/** The providers that have a ProviderBudget object. */
export type BudgetProvider = Extract<ProviderId, 'aerodatabox' | 'aeroapi'>;

export function isBudgetProvider(value: string): value is BudgetProvider {
  return value === 'aerodatabox' || value === 'aeroapi';
}

export interface BudgetDefaults {
  readonly dailyUnitCap: number;
  readonly perSecondLimit: number;
}

/** The starting cap and rate for a provider's daily ProviderBudget object. */
export function budgetDefaults(
  provider: BudgetProvider,
  settings: ProviderSettings,
): BudgetDefaults {
  if (provider === 'aerodatabox') {
    return {
      dailyUnitCap: Math.floor(settings.adbPlan.monthlyUnits / DAYS_PER_MONTH),
      perSecondLimit: settings.adbPlan.perSecondLimit,
    };
  }
  return {
    dailyUnitCap: AEROAPI_DEFAULT_DAILY_UNIT_CAP,
    perSecondLimit: AEROAPI_STANDARD.perSecondLimit,
  };
}
