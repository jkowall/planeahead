import { costUnits, listPriceUsdMicros, pollEquivalents } from './cost';
import type { AlertEvent, FlightStatusValue } from './flight-status';

/**
 * Refresh cadence (plan section 8). A cadence is an ordered list of windows. Each window
 * covers a span of the flight's life, names the provider that serves it, and says how polls
 * are placed inside it:
 *
 * - Interval windows place polls on a grid. Start-anchored windows (everything inside 48 h)
 *   put slot k at `start + k x interval` and yield `ceil(duration / interval)` slots, so a
 *   trailing partial slot always earns a poll and no window ends with a gap longer than its
 *   own interval (a `round` rule left a 20-minute hole before boarding on a 15-minute grid). The
 *   pre-48 h windows are end-anchored (they count back from T-48 h so the daily grid lands on
 *   T-3 d, T-4 d, ...) and yield `floor(duration / interval)` slots, so no slot can precede
 *   the window start. The boundary instant between two windows belongs to the later window.
 * - Fixed-slot windows (the A1 post-arrival tail, every cadence B window) list explicit offsets
 *   from the window's edges or from scheduled departure. A fixed-slot in-flight window names a
 *   `lateIntervalMinutes` for a flight that passes its planned arrival without `in`
 *   (see `resolveWindows`).
 *
 * `refreshIntervalFor` is the function the FlightTracker alarm calls; `expectedCalls`
 * simulates a flight by calling that same function in a loop, so the per-window counts in
 * `docs/architecture.md` and the constants the lifecycle test imports fall out of the
 * definitions instead of being typed by hand. `sloRelaxations` measures the poll sequence of
 * that same simulation against the SLO table. Nothing here reads the wall clock.
 */

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** Minutes helpers so window definitions read as the plan writes them. */
export function hours(n: number): number {
  return n * 60;
}
export function days(n: number): number {
  return n * 1_440;
}

export type CadenceId = 'literal' | 'A1' | 'A2' | 'B';
export type CadenceSource = 'aerodatabox' | 'aeroapi';
export type CadenceTier =
  'pre48h_far' | 'pre48h_near' | 'hourly' | 'pre_boarding' | 'in_flight' | 'post_arrival';

/**
 * A window edge: minutes before scheduled departure (`Infinity` = unbounded past), or a
 * named anchor resolved from the tracker context.
 */
export type CadenceEdge = number | 'boarding' | 'arrival' | 'stop';

interface CadenceWindowBase {
  tier: CadenceTier;
  from: CadenceEdge;
  /** Exclusive. */
  to: CadenceEdge;
  source: CadenceSource;
  /** Whether AeroAPI alert registrations are expected to be active during the window. */
  alerts: boolean;
}

export interface IntervalWindow extends CadenceWindowBase {
  intervalMinutes: number;
  anchor?: 'start' | 'end';
}

export interface FixedSlot {
  edge: 'from' | 'to' | 'scheduledOut';
  offsetMinutes: number;
}

export interface FixedSlotWindow extends CadenceWindowBase {
  slots: readonly FixedSlot[];
  /**
   * Required on an in-flight window (`to: 'arrival'`): once the planned arrival has passed
   * without `in`, poll every this many minutes from the planned arrival until `in` is seen or
   * the lifetime ends. Interval windows simply continue their grid instead.
   */
  lateIntervalMinutes?: number;
}

export type CadenceWindow = IntervalWindow | FixedSlotWindow;

export function isIntervalWindow(window: CadenceWindow): window is IntervalWindow {
  return 'intervalMinutes' in window;
}

export interface CadenceDefinition {
  id: CadenceId;
  label: string;
  windows: readonly CadenceWindow[];
  aeroapiAlerts: { events: readonly AlertEvent[]; assumedDeliveriesPerFlight: number } | null;
  aerodataboxAlerts: { assumedItemsPerFlight: number } | null;
}

export class CadenceError extends Error {
  override readonly name = 'CadenceError';
}

// ---------------------------------------------------------------------------------------------
// SLO table (dossier section 7). Minutes of maximum detection latency per event and window.
// ---------------------------------------------------------------------------------------------

export const SLO_WINDOWS = [
  'beyond_7d',
  '7d_to_48h',
  '48h_to_6h',
  '6h_to_3h',
  '3h_to_arrival',
  'post_arrival',
] as const;
export type SloWindow = (typeof SLO_WINDOWS)[number];

export const SLO_EVENTS = ['schedule_change', 'gate_change', 'eta_change', 'oooi'] as const;
export type SloEvent = (typeof SLO_EVENTS)[number];

export interface SloTarget {
  /** Detection latency target when polling, in minutes; `null` when not applicable. */
  pollMinutes: number | null;
  /** Tighter target that only alerts can meet, in minutes. */
  alertMinutes?: number;
}

export const SLO_TABLE: Readonly<Record<SloEvent, Readonly<Record<SloWindow, SloTarget>>>> = {
  schedule_change: {
    beyond_7d: { pollMinutes: hours(48) },
    '7d_to_48h': { pollMinutes: hours(24) },
    '48h_to_6h': { pollMinutes: 60 },
    '6h_to_3h': { pollMinutes: 15 },
    '3h_to_arrival': { pollMinutes: 15 },
    post_arrival: { pollMinutes: null },
  },
  gate_change: {
    beyond_7d: { pollMinutes: null },
    '7d_to_48h': { pollMinutes: null },
    '48h_to_6h': { pollMinutes: 60 },
    '6h_to_3h': { pollMinutes: 15 },
    '3h_to_arrival': { pollMinutes: 15 },
    post_arrival: { pollMinutes: null },
  },
  eta_change: {
    beyond_7d: { pollMinutes: null },
    '7d_to_48h': { pollMinutes: null },
    '48h_to_6h': { pollMinutes: 60 },
    '6h_to_3h': { pollMinutes: 15 },
    '3h_to_arrival': { pollMinutes: 15, alertMinutes: 2 },
    post_arrival: { pollMinutes: 15 },
  },
  oooi: {
    beyond_7d: { pollMinutes: null },
    '7d_to_48h': { pollMinutes: null },
    '48h_to_6h': { pollMinutes: null },
    '6h_to_3h': { pollMinutes: null },
    '3h_to_arrival': { pollMinutes: 15, alertMinutes: 2 },
    post_arrival: { pollMinutes: 15 },
  },
};

/** The tightest poll target across all events for a window, or `null` if none applies. */
export function strictestPollSlo(window: SloWindow): number | null {
  let strictest: number | null = null;
  for (const event of SLO_EVENTS) {
    const target = SLO_TABLE[event][window].pollMinutes;
    if (target !== null && (strictest === null || target < strictest)) {
      strictest = target;
    }
  }
  return strictest;
}

/**
 * The span of each SLO window as cadence edges. `sloRelaxations` measures the simulated polls
 * inside each of these spans, so a poll grid that runs across two SLO windows (the literal
 * brief's hourly window runs to T-3 h) is held to the stricter target rather than to its tier's
 * name, and a gap that crosses a boundary is charged to both sides.
 */
export const SLO_WINDOW_BOUNDS: Readonly<
  Record<SloWindow, { from: CadenceEdge; to: CadenceEdge }>
> = {
  beyond_7d: { from: Number.POSITIVE_INFINITY, to: days(7) },
  '7d_to_48h': { from: days(7), to: hours(48) },
  '48h_to_6h': { from: hours(48), to: hours(6) },
  '6h_to_3h': { from: hours(6), to: hours(3) },
  '3h_to_arrival': { from: hours(3), to: 'arrival' },
  post_arrival: { from: 'arrival', to: 'stop' },
};

// ---------------------------------------------------------------------------------------------
// Cadence definitions.
// ---------------------------------------------------------------------------------------------

/** UNVERIFIED: average AeroAPI alert deliveries per flight on cadence A2 (plan section 19). */
export const ASSUMED_ALERTS_PER_FLIGHT = 12;
/** UNVERIFIED: AeroAPI OOOI, cancelled and diverted deliveries per flight on cadence B. */
export const ASSUMED_B_AEROAPI_ALERTS_PER_FLIGHT = 8;
/** UNVERIFIED: AeroDataBox Flight Alert items per flight on cadence B. */
export const ASSUMED_B_ADB_ALERT_ITEMS_PER_FLIGHT = 15;

export const A2_ALERT_EVENTS: readonly AlertEvent[] = [
  'filed',
  'departure',
  'arrival',
  'cancelled',
  'diverted',
  'out',
  'off',
  'on',
  'in',
];
export const B_ALERT_EVENTS: readonly AlertEvent[] = [
  'cancelled',
  'diverted',
  'out',
  'off',
  'on',
  'in',
];

/**
 * Pre-48 h rules shared by every cadence: AeroDataBox daily inside 14 days, every 2 days
 * beyond, counted back from T-48 h. These are the SLO-derived intervals for `7d_to_48h`
 * (24 h) and `beyond_7d` (48 h). Zero AeroAPI calls before T-48 h.
 */
export const PRE_48H_WINDOWS: readonly IntervalWindow[] = [
  {
    tier: 'pre48h_far',
    from: Number.POSITIVE_INFINITY,
    to: days(14),
    intervalMinutes: days(2),
    anchor: 'end',
    source: 'aerodatabox',
    alerts: false,
  },
  {
    tier: 'pre48h_near',
    from: days(14),
    to: hours(48),
    intervalMinutes: days(1),
    anchor: 'end',
    source: 'aerodatabox',
    alerts: false,
  },
];

/** The brief as written: hourly to T-3 h, 10-min to boarding, 2-min to arrival, 10-min tail. */
export const CADENCE_LITERAL: CadenceDefinition = {
  id: 'literal',
  label: 'Literal brief',
  windows: [
    ...PRE_48H_WINDOWS,
    {
      tier: 'hourly',
      from: hours(48),
      to: hours(3),
      intervalMinutes: 60,
      source: 'aeroapi',
      alerts: false,
    },
    {
      tier: 'pre_boarding',
      from: hours(3),
      to: 'boarding',
      intervalMinutes: 10,
      source: 'aeroapi',
      alerts: false,
    },
    {
      tier: 'in_flight',
      from: 'boarding',
      to: 'arrival',
      intervalMinutes: 2,
      source: 'aeroapi',
      alerts: false,
    },
    {
      tier: 'post_arrival',
      from: 'arrival',
      to: 'stop',
      intervalMinutes: 10,
      source: 'aeroapi',
      alerts: false,
    },
  ],
  aeroapiAlerts: null,
  aerodataboxAlerts: null,
};

/**
 * Polls only, no alerts: the automatic fallback when alerts go silent. The tail is fixed slots
 * at in+0, in+15, in+30 and in+45 and a final poll at in+120 (ruling R2, revised). The in-flight
 * grid's last slot lands at in-10, so the poll at in+0 keeps the hole across the landing
 * instant to 10 minutes; the 15-minute post-arrival SLO then holds for the first 45 minutes and
 * only the in+45 to in+120 leg is relaxed.
 */
export const CADENCE_A1: CadenceDefinition = {
  id: 'A1',
  label: 'A1 polls only',
  windows: [
    ...PRE_48H_WINDOWS,
    {
      tier: 'hourly',
      from: hours(48),
      to: hours(6),
      intervalMinutes: 60,
      source: 'aeroapi',
      alerts: false,
    },
    {
      tier: 'pre_boarding',
      from: hours(6),
      to: 'boarding',
      intervalMinutes: 15,
      source: 'aeroapi',
      alerts: false,
    },
    {
      tier: 'in_flight',
      from: 'boarding',
      to: 'arrival',
      intervalMinutes: 15,
      source: 'aeroapi',
      alerts: false,
    },
    {
      tier: 'post_arrival',
      from: 'arrival',
      to: 'stop',
      slots: [
        { edge: 'from', offsetMinutes: 0 },
        { edge: 'from', offsetMinutes: 15 },
        { edge: 'from', offsetMinutes: 30 },
        { edge: 'from', offsetMinutes: 45 },
        { edge: 'to', offsetMinutes: 0 },
      ],
      source: 'aeroapi',
      alerts: false,
    },
  ],
  aeroapiAlerts: null,
  aerodataboxAlerts: null,
};

/** Phase 0 constant: polls plus AeroAPI alerts. In-flight polls only need to catch gates. */
export const CADENCE_A2: CadenceDefinition = {
  id: 'A2',
  label: 'A2 polls + alerts',
  windows: [
    ...PRE_48H_WINDOWS,
    {
      tier: 'hourly',
      from: hours(48),
      to: hours(6),
      intervalMinutes: 60,
      source: 'aeroapi',
      alerts: true,
    },
    {
      tier: 'pre_boarding',
      from: hours(6),
      to: 'boarding',
      intervalMinutes: 15,
      source: 'aeroapi',
      alerts: true,
    },
    {
      tier: 'in_flight',
      from: 'boarding',
      to: 'arrival',
      intervalMinutes: 30,
      source: 'aeroapi',
      alerts: true,
    },
    {
      tier: 'post_arrival',
      from: 'arrival',
      to: 'stop',
      intervalMinutes: 60,
      source: 'aeroapi',
      alerts: true,
    },
  ],
  aeroapiAlerts: { events: A2_ALERT_EVENTS, assumedDeliveriesPerFlight: ASSUMED_ALERTS_PER_FLIGHT },
  aerodataboxAlerts: null,
};

/**
 * Phase 1 target, UNVERIFIED: AeroDataBox webhooks carry gates and times, AeroAPI alerts carry
 * OOOI. Five fixed polls: bracketed fetch at T-48 h, T-3 h, scheduled out + 15 (the plan says
 * scheduled off + 15; there is no taxi model, so out stands in for off), arrival + 15, final.
 * A flight that passes its planned arrival without `in` is polled every 15 minutes (the
 * post-arrival OOOI poll SLO) until `in` or the lifetime, since the alerts that should carry
 * `in` are unverified.
 */
export const CADENCE_B: CadenceDefinition = {
  id: 'B',
  label: 'B ADB webhooks + AeroAPI OOOI alerts',
  windows: [
    ...PRE_48H_WINDOWS,
    {
      tier: 'hourly',
      from: hours(48),
      to: hours(6),
      slots: [{ edge: 'from', offsetMinutes: 0 }],
      source: 'aeroapi',
      alerts: true,
    },
    {
      tier: 'pre_boarding',
      from: hours(6),
      to: 'boarding',
      slots: [{ edge: 'from', offsetMinutes: hours(3) }],
      source: 'aeroapi',
      alerts: true,
    },
    {
      tier: 'in_flight',
      from: 'boarding',
      to: 'arrival',
      slots: [{ edge: 'scheduledOut', offsetMinutes: 15 }],
      lateIntervalMinutes: 15,
      source: 'aeroapi',
      alerts: true,
    },
    {
      tier: 'post_arrival',
      from: 'arrival',
      to: 'stop',
      slots: [
        { edge: 'from', offsetMinutes: 15 },
        { edge: 'to', offsetMinutes: 0 },
      ],
      source: 'aeroapi',
      alerts: true,
    },
  ],
  aeroapiAlerts: {
    events: B_ALERT_EVENTS,
    assumedDeliveriesPerFlight: ASSUMED_B_AEROAPI_ALERTS_PER_FLIGHT,
  },
  aerodataboxAlerts: { assumedItemsPerFlight: ASSUMED_B_ADB_ALERT_ITEMS_PER_FLIGHT },
};

export const CADENCES: readonly CadenceDefinition[] = [
  CADENCE_LITERAL,
  CADENCE_A1,
  CADENCE_A2,
  CADENCE_B,
];

// ---------------------------------------------------------------------------------------------
// Tracker-facing API.
// ---------------------------------------------------------------------------------------------

export type TrackerPhase = FlightStatusValue | 'finished';

export interface CadenceContext {
  now: Date;
  scheduledOut: Date;
  scheduledIn: Date;
  /** Latest provider estimate; moves the planned arrival anchor when known. */
  estimatedIn?: Date | undefined;
  actualOff?: Date | undefined;
  actualOn?: Date | undefined;
  actualIn?: Date | undefined;
  phase: TrackerPhase;
}

export interface CadenceParams {
  boardingMinutesBefore: number;
  postArrivalStopMinutes: number;
}

export const DEFAULT_CADENCE_PARAMS: Readonly<CadenceParams> = Object.freeze({
  boardingMinutesBefore: 40,
  postArrivalStopMinutes: 120,
});

export interface RefreshDecision {
  nextRefreshAt: Date;
  /** Milliseconds from `ctx.now` to the next slot. */
  intervalMs: number;
  /** The window's nominal interval, `null` for fixed-slot windows. */
  nominalIntervalMinutes: number | null;
  source: CadenceSource;
  tier: CadenceTier;
  alerts: boolean;
}

interface Bounds {
  scheduledOut: number;
  boarding: number;
  arrival: number;
  stop: number;
}

export interface ResolvedWindow {
  window: CadenceWindow;
  start: number;
  end: number;
  /** True for the in-flight window of a flight past its planned arrival without `in`. */
  extended: boolean;
}

function resolveEdge(edge: CadenceEdge, bounds: Bounds): number {
  if (typeof edge === 'number') {
    return edge === Number.POSITIVE_INFINITY
      ? Number.NEGATIVE_INFINITY
      : bounds.scheduledOut - edge * MINUTE_MS;
  }
  switch (edge) {
    case 'boarding':
      return bounds.boarding;
    case 'arrival':
      return bounds.arrival;
    case 'stop':
      return bounds.stop;
  }
}

function boundsOf(ctx: CadenceContext, params: CadenceParams): Bounds {
  const scheduledOut = ctx.scheduledOut.getTime();
  const arrival = (ctx.actualIn ?? ctx.estimatedIn ?? ctx.scheduledIn).getTime();
  return {
    scheduledOut,
    boarding: scheduledOut - params.boardingMinutesBefore * MINUTE_MS,
    arrival,
    stop: arrival + params.postArrivalStopMinutes * MINUTE_MS,
  };
}

/**
 * The windows of a cadence resolved to absolute milliseconds for one tracker context. A
 * cancelled or finished flight has none. While arrival has not been observed and the planned
 * arrival has passed, the in-flight window is extended without end and the tail is dropped,
 * so a late flight keeps polling until `in` is seen or the lifetime ends: an interval window
 * continues its grid, a fixed-slot window polls every `lateIntervalMinutes` from the planned
 * arrival (ruling R6).
 */
export function resolveWindows(
  cadence: CadenceDefinition,
  ctx: CadenceContext,
  params: CadenceParams = DEFAULT_CADENCE_PARAMS,
): { windows: ResolvedWindow[]; bounds: Bounds } {
  const bounds = boundsOf(ctx, params);
  const windows: ResolvedWindow[] = [];
  if (ctx.phase === 'cancelled' || ctx.phase === 'finished') {
    return { windows, bounds };
  }
  const now = ctx.now.getTime();
  const arrivalObserved = ctx.actualIn !== undefined || ctx.phase === 'arrived';
  const extendInFlight = !arrivalObserved && now >= bounds.arrival;
  for (const window of cadence.windows) {
    const start = resolveEdge(window.from, bounds);
    const end = resolveEdge(window.to, bounds);
    if (extendInFlight && window.to === 'arrival') {
      windows.push({ window, start, end: Number.POSITIVE_INFINITY, extended: true });
      break;
    }
    if (end <= start) {
      continue;
    }
    windows.push({ window, start, end, extended: false });
  }
  return { windows, bounds };
}

/** Number of grid slots an interval window yields (see the module comment for the rule). */
export function slotCount(window: IntervalWindow, start: number, end: number): number {
  const duration = end - start;
  if (!Number.isFinite(duration)) {
    return Number.POSITIVE_INFINITY;
  }
  const ratio = duration / (window.intervalMinutes * MINUTE_MS);
  // The epsilon guards an exact multiple against floating-point noise (42.000000001 must be 42).
  return window.anchor === 'end' ? Math.floor(ratio + 1e-9) : Math.ceil(ratio - 1e-9);
}

function resolveFixedSlot(slot: FixedSlot, resolved: ResolvedWindow, bounds: Bounds): number {
  const base =
    slot.edge === 'from' ? resolved.start : slot.edge === 'to' ? resolved.end : bounds.scheduledOut;
  return base + slot.offsetMinutes * MINUTE_MS;
}

/** The finite slots of a fixed-slot window that fall inside it, in definition order. */
function fixedSlotsOf(resolved: ResolvedWindow, bounds: Bounds): number[] {
  const { window, start, end } = resolved;
  if (isIntervalWindow(window)) {
    return [];
  }
  return window.slots
    .map((slot) => resolveFixedSlot(slot, resolved, bounds))
    .filter((at) => Number.isFinite(at) && at >= start && at <= end);
}

function nextSlotInWindow(resolved: ResolvedWindow, bounds: Bounds, now: number): number | null {
  const { window, start, end } = resolved;
  if (!isIntervalWindow(window)) {
    const candidates = fixedSlotsOf(resolved, bounds).filter((at) => at > now);
    if (resolved.extended) {
      if (window.lateIntervalMinutes === undefined) {
        throw new CadenceError(
          `window ${window.tier} is extended past the planned arrival but has no lateIntervalMinutes`,
        );
      }
      const interval = window.lateIntervalMinutes * MINUTE_MS;
      const k = Math.floor((now - bounds.arrival) / interval) + 1;
      candidates.push(bounds.arrival + k * interval);
    }
    return candidates.length === 0 ? null : Math.min(...candidates);
  }
  const interval = window.intervalMinutes * MINUTE_MS;
  const count = slotCount(window, start, end);
  if (window.anchor === 'end') {
    if (!Number.isFinite(end)) {
      throw new CadenceError(`window ${window.tier} is end-anchored but has no finite end`);
    }
    if (count < 1) {
      return null;
    }
    let k = Math.ceil((end - now) / interval) - 1;
    if (k < 1) {
      return null;
    }
    if (k > count) {
      k = count;
    }
    return end - k * interval;
  }
  if (!Number.isFinite(start)) {
    throw new CadenceError(`window ${window.tier} is start-anchored but has no finite start`);
  }
  const k = now < start ? 0 : Math.floor((now - start) / interval) + 1;
  return k < count ? start + k * interval : null;
}

export interface NextSlot {
  at: number;
  window: CadenceWindow;
}

/** The first poll slot strictly after `ctx.now`, or `null` when the schedule is exhausted. */
export function nextSlot(
  cadence: CadenceDefinition,
  ctx: CadenceContext,
  params: CadenceParams = DEFAULT_CADENCE_PARAMS,
): NextSlot | null {
  const now = ctx.now.getTime();
  const { windows, bounds } = resolveWindows(cadence, ctx, params);
  for (const resolved of windows) {
    if (resolved.end <= now) {
      continue;
    }
    const at = nextSlotInWindow(resolved, bounds, now);
    if (at !== null) {
      return { at, window: resolved.window };
    }
  }
  return null;
}

/** The window that contains `ctx.now` (the last window also owns its closing instant). */
export function windowAt(
  cadence: CadenceDefinition,
  ctx: CadenceContext,
  params: CadenceParams = DEFAULT_CADENCE_PARAMS,
): CadenceWindow | null {
  const now = ctx.now.getTime();
  const { windows } = resolveWindows(cadence, ctx, params);
  for (const resolved of windows) {
    if (now >= resolved.start && now < resolved.end) {
      return resolved.window;
    }
  }
  const last = windows[windows.length - 1];
  return last !== undefined && now === last.end ? last.window : null;
}

function blockMinutesOf(ctx: CadenceContext): number {
  return (ctx.scheduledIn.getTime() - ctx.scheduledOut.getTime()) / MINUTE_MS;
}

export const LIFETIME_AFTER_SCHEDULED_IN_MINUTES = hours(6);

/**
 * Hard lifetime of a tracker: `min(scheduledIn + 6 h, actualOff + 2 x block)`. A flight that
 * never reports `in` is finished here regardless of cadence.
 */
export function maxLifetime(
  scheduledIn: Date,
  actualOff: Date | undefined,
  blockMinutes: number,
): Date {
  const byScheduledIn = scheduledIn.getTime() + LIFETIME_AFTER_SCHEDULED_IN_MINUTES * MINUTE_MS;
  if (actualOff === undefined) {
    return new Date(byScheduledIn);
  }
  const byActualOff = actualOff.getTime() + 2 * blockMinutes * MINUTE_MS;
  return new Date(Math.min(byScheduledIn, byActualOff));
}

/** Alias with the name the plan uses. */
export const MAX_LIFETIME = maxLifetime;

/**
 * What the FlightTracker alarm asks after every poll: when is the next slot, from which
 * provider, in which tier. `null` means there is nothing left to schedule (the cadence is
 * exhausted, the flight is cancelled or finished, or the next slot lies beyond the hard
 * lifetime); the tracker then finishes.
 */
export function refreshIntervalFor(
  cadence: CadenceDefinition,
  ctx: CadenceContext,
  params: CadenceParams = DEFAULT_CADENCE_PARAMS,
): RefreshDecision | null {
  const next = nextSlot(cadence, ctx, params);
  if (next === null) {
    return null;
  }
  const lifetime = maxLifetime(ctx.scheduledIn, ctx.actualOff, blockMinutesOf(ctx)).getTime();
  if (next.at > lifetime) {
    return null;
  }
  const { window } = next;
  return {
    nextRefreshAt: new Date(next.at),
    intervalMs: next.at - ctx.now.getTime(),
    nominalIntervalMinutes: isIntervalWindow(window) ? window.intervalMinutes : null,
    source: window.source,
    tier: window.tier,
    alerts: window.alerts,
  };
}

// ---------------------------------------------------------------------------------------------
// Simulation: the same function, driven through an on-time flight.
// ---------------------------------------------------------------------------------------------

/** The on-time flight every simulation walks; defaults are the plan's assumptions. */
export interface SimulationParams {
  blockMinutes?: number | undefined;
  boardingMinutesBefore?: number | undefined;
  postArrivalStopMinutes?: number | undefined;
}

export interface ExpectedCallsParams extends SimulationParams {
  /** Days before scheduled departure at which the tracker is created. */
  leadTimeDays: number;
}

export interface WindowCallCount {
  tier: CadenceTier;
  source: CadenceSource;
  polls: number;
  intervalMinutes: number | null;
}

export interface ExpectedCalls {
  /** AeroAPI status polls inside 48 h (what the lifecycle test counts). */
  polls: number;
  /** Assumed AeroAPI alert deliveries. */
  alerts: number;
  /** AeroDataBox status calls before T-48 h, including the creation fetch. */
  adbCalls: number;
  /** `adbCalls` x units per call. */
  adbUnits: number;
  /** Assumed AeroDataBox Flight Alert items (cadence B). */
  adbAlertItems: number;
  pollEquivalents: number;
  listCostUsdMicros: number;
  byWindow: WindowCallCount[];
  /**
   * Every simulated poll in order, the creation fetch first, as minutes after scheduled
   * departure (negative before it). `sloRelaxations` measures the gaps of this sequence.
   */
  pollInstants: number[];
}

const SIMULATION_SCHEDULED_OUT_MS = Date.UTC(2026, 8, 19, 12, 0, 0);
const SIMULATION_BLOCK_MINUTES = 180;
const MAX_SIMULATED_POLLS = 100_000;

interface Simulation {
  scheduledOut: Date;
  scheduledIn: Date;
  boardingMs: number;
  cadenceParams: CadenceParams;
}

function simulationOf(params: SimulationParams): Simulation {
  const blockMinutes = params.blockMinutes ?? SIMULATION_BLOCK_MINUTES;
  const cadenceParams: CadenceParams = {
    boardingMinutesBefore:
      params.boardingMinutesBefore ?? DEFAULT_CADENCE_PARAMS.boardingMinutesBefore,
    postArrivalStopMinutes:
      params.postArrivalStopMinutes ?? DEFAULT_CADENCE_PARAMS.postArrivalStopMinutes,
  };
  return {
    scheduledOut: new Date(SIMULATION_SCHEDULED_OUT_MS),
    scheduledIn: new Date(SIMULATION_SCHEDULED_OUT_MS + blockMinutes * MINUTE_MS),
    boardingMs: SIMULATION_SCHEDULED_OUT_MS - cadenceParams.boardingMinutesBefore * MINUTE_MS,
    cadenceParams,
  };
}

function onTimeContext(
  t: number,
  scheduledOut: Date,
  scheduledIn: Date,
  boardingMs: number,
): CadenceContext {
  const out = scheduledOut.getTime();
  const inAt = scheduledIn.getTime();
  const phase: TrackerPhase =
    t < boardingMs ? 'scheduled' : t < out ? 'boarding' : t < inAt ? 'en_route' : 'arrived';
  const ctx: CadenceContext = { now: new Date(t), scheduledOut, scheduledIn, phase };
  if (t >= out) {
    ctx.actualOff = scheduledOut;
  }
  if (t >= inAt) {
    ctx.actualIn = scheduledIn;
  }
  return ctx;
}

/**
 * Simulates an on-time flight created `leadTimeDays` before departure: one creation fetch,
 * then `refreshIntervalFor` in a loop until it returns `null`. Costs come from `cost.ts`.
 */
export function expectedCalls(
  cadence: CadenceDefinition,
  params: ExpectedCallsParams,
): ExpectedCalls {
  const { scheduledOut, scheduledIn, boardingMs, cadenceParams } = simulationOf(params);

  const counts = new Map<CadenceWindow, number>();
  const pollInstants: number[] = [];
  const bump = (window: CadenceWindow, at: number): void => {
    counts.set(window, (counts.get(window) ?? 0) + 1);
    pollInstants.push((at - SIMULATION_SCHEDULED_OUT_MS) / MINUTE_MS);
  };

  let t = SIMULATION_SCHEDULED_OUT_MS - params.leadTimeDays * DAY_MS;
  const creation = windowAt(
    cadence,
    onTimeContext(t, scheduledOut, scheduledIn, boardingMs),
    cadenceParams,
  );
  if (creation !== null) {
    bump(creation, t);
  }
  for (let i = 0; i < MAX_SIMULATED_POLLS; i += 1) {
    const ctx = onTimeContext(t, scheduledOut, scheduledIn, boardingMs);
    const decision = refreshIntervalFor(cadence, ctx, cadenceParams);
    if (decision === null) {
      break;
    }
    t += decision.intervalMs;
    const window = windowAt(
      cadence,
      onTimeContext(t, scheduledOut, scheduledIn, boardingMs),
      cadenceParams,
    );
    if (window === null) {
      throw new CadenceError(`slot at ${new Date(t).toISOString()} belongs to no window`);
    }
    bump(window, t);
    if (i === MAX_SIMULATED_POLLS - 1) {
      throw new CadenceError('simulation did not terminate');
    }
  }

  const byWindow: WindowCallCount[] = cadence.windows.map((window) => ({
    tier: window.tier,
    source: window.source,
    polls: counts.get(window) ?? 0,
    intervalMinutes: isIntervalWindow(window) ? window.intervalMinutes : null,
  }));
  let polls = 0;
  let adbCalls = 0;
  for (const row of byWindow) {
    if (row.source === 'aeroapi') {
      polls += row.polls;
    } else {
      adbCalls += row.polls;
    }
  }
  const alerts = cadence.aeroapiAlerts?.assumedDeliveriesPerFlight ?? 0;
  const adbAlertItems = cadence.aerodataboxAlerts?.assumedItemsPerFlight ?? 0;
  const adbUnits =
    adbCalls * costUnits('aerodatabox', 'flight_status') +
    adbAlertItems * costUnits('aerodatabox', 'alert_item');
  const pe =
    polls * pollEquivalents('aeroapi', 'flight_by_id') +
    alerts * pollEquivalents('aeroapi', 'alert_delivery') +
    adbCalls * pollEquivalents('aerodatabox', 'flight_status') +
    adbAlertItems * pollEquivalents('aerodatabox', 'alert_item');
  const listCostUsdMicros =
    polls * listPriceUsdMicros('aeroapi', 'flight_by_id') +
    alerts * listPriceUsdMicros('aeroapi', 'alert_delivery') +
    adbCalls * listPriceUsdMicros('aerodatabox', 'flight_status') +
    adbAlertItems * listPriceUsdMicros('aerodatabox', 'alert_item');
  return {
    polls,
    alerts,
    adbCalls,
    adbUnits,
    adbAlertItems,
    pollEquivalents: pe,
    listCostUsdMicros,
    byWindow,
    pollInstants,
  };
}

// ---------------------------------------------------------------------------------------------
// SLO relaxation report: the simulated poll sequence measured against the SLO table.
// ---------------------------------------------------------------------------------------------

/** A stretch between two consecutive simulated polls, as minutes after scheduled departure. */
export interface RelaxedLeg {
  /** Minutes after scheduled departure; negative before it. */
  fromMinutes: number;
  toMinutes: number;
}

/** The gaps between consecutive instants of an ordered poll sequence. */
export function pollGaps(pollInstants: readonly number[]): RelaxedLeg[] {
  const gaps: RelaxedLeg[] = [];
  for (let i = 1; i < pollInstants.length; i += 1) {
    const fromMinutes = pollInstants[i - 1];
    const toMinutes = pollInstants[i];
    if (fromMinutes !== undefined && toMinutes !== undefined) {
      gaps.push({ fromMinutes, toMinutes });
    }
  }
  return gaps;
}

/**
 * The gap of a poll sequence that spans `minutesAfterOut`: from the last poll before that
 * instant to the first poll at or after it, `null` when no poll lies on one of the sides. Asked
 * at the planned arrival it is the hole across the landing instant that ruling R2 closes.
 */
export function gapAcross(
  pollInstants: readonly number[],
  minutesAfterOut: number,
): RelaxedLeg | null {
  return (
    pollGaps(pollInstants).find(
      (gap) => gap.fromMinutes < minutesAfterOut && gap.toMinutes >= minutesAfterOut,
    ) ?? null
  );
}

export interface SloRelaxation {
  cadence: CadenceId;
  sloWindow: SloWindow;
  /** The cadence windows that overlap the SLO window on the simulated flight. */
  tiers: CadenceTier[];
  /** True when alert registrations are active in every overlapping cadence window. */
  alerts: boolean;
  strictestSloMinutes: number;
  /** The widest gap between consecutive polls that lies inside or crosses the SLO window. */
  maxGapMinutes: number;
  /** Every gap longer than the SLO, in poll order. */
  relaxedLegs: RelaxedLeg[];
}

export interface SloRelaxationParams extends SimulationParams {
  /** Days before scheduled departure at which the simulated tracker is created. */
  leadTimeDays?: number | undefined;
}

/** Lead time of the report's simulated flight: long enough to walk every pre-48 h window. */
export const SLO_REPORT_LEAD_TIME_DAYS = 30;

/**
 * Where a cadence polls slower than the SLO table, measured from the simulated poll sequence
 * (ruling R10): `expectedCalls` walks the flight, and every SLO window is charged the widest gap
 * between consecutive polls that lies inside it or crosses one of its edges. A gap that crosses
 * a boundary therefore counts against both windows, which is how the hole across the landing
 * instant reaches the post-arrival row; a gap that ends on the boundary belongs to the earlier
 * window only, since the poll on the boundary sees every event from that instant on. The tail
 * stop closes the last gap: nothing after it is polled. A row appears when the widest gap
 * exceeds the strictest poll target of the window. Rendered into `docs/architecture.md`.
 */
export function sloRelaxations(
  cadence: CadenceDefinition,
  params: SloRelaxationParams = {},
): SloRelaxation[] {
  const leadTimeDays = params.leadTimeDays ?? SLO_REPORT_LEAD_TIME_DAYS;
  const { scheduledOut, scheduledIn, boardingMs, cadenceParams } = simulationOf(params);
  const creation = onTimeContext(
    SIMULATION_SCHEDULED_OUT_MS - leadTimeDays * DAY_MS,
    scheduledOut,
    scheduledIn,
    boardingMs,
  );
  const { windows, bounds } = resolveWindows(cadence, creation, cadenceParams);
  const minutesAfterOut = (ms: number): number => (ms - bounds.scheduledOut) / MINUTE_MS;
  const { pollInstants } = expectedCalls(cadence, { ...params, leadTimeDays });
  const stop = minutesAfterOut(bounds.stop);
  const last = pollInstants[pollInstants.length - 1];
  const gaps = pollGaps(last !== undefined && last < stop ? [...pollInstants, stop] : pollInstants);
  const rows: SloRelaxation[] = [];
  for (const sloWindow of SLO_WINDOWS) {
    const strictestSloMinutes = strictestPollSlo(sloWindow);
    if (strictestSloMinutes === null) {
      continue;
    }
    const sloStart = resolveEdge(SLO_WINDOW_BOUNDS[sloWindow].from, bounds);
    const sloEnd = resolveEdge(SLO_WINDOW_BOUNDS[sloWindow].to, bounds);
    const startMinutes = minutesAfterOut(sloStart);
    const endMinutes = minutesAfterOut(sloEnd);
    const inside = gaps.filter(
      (gap) => gap.fromMinutes < endMinutes && gap.toMinutes > startMinutes,
    );
    const maxGapMinutes = inside.reduce(
      (max, gap) => Math.max(max, gap.toMinutes - gap.fromMinutes),
      0,
    );
    if (maxGapMinutes <= strictestSloMinutes) {
      continue;
    }
    const overlapping = windows.filter(
      (resolved) => Math.min(resolved.end, sloEnd) > Math.max(resolved.start, sloStart),
    );
    rows.push({
      cadence: cadence.id,
      sloWindow,
      tiers: overlapping.map((resolved) => resolved.window.tier),
      alerts: overlapping.every((resolved) => resolved.window.alerts),
      strictestSloMinutes,
      maxGapMinutes,
      relaxedLegs: inside.filter((gap) => gap.toMinutes - gap.fromMinutes > strictestSloMinutes),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Constants the rest of Phase 0 imports. Computed, not typed. Lead time 2 days means the
// tracker is created at T-48 h, so these are the inside-48 h figures with no AeroDataBox share.
// ---------------------------------------------------------------------------------------------

const INSIDE_48H_LEAD = { leadTimeDays: 2 } as const;
const a2 = expectedCalls(CADENCE_A2, INSIDE_48H_LEAD);

export const A2_EXPECTED_POLLS = a2.polls;
export const A2_EXPECTED_ALERTS = a2.alerts;
export const A2_EXPECTED_PE = a2.pollEquivalents;
export const A2_SOFT_CAP_PE = A2_EXPECTED_PE * 2;
export const A2_HARD_CAP_PE = A2_EXPECTED_PE * 4;
export const A1_EXPECTED_POLLS = expectedCalls(CADENCE_A1, INSIDE_48H_LEAD).polls;
export const LITERAL_EXPECTED_POLLS = expectedCalls(CADENCE_LITERAL, INSIDE_48H_LEAD).polls;
export const B_EXPECTED_POLLS = expectedCalls(CADENCE_B, INSIDE_48H_LEAD).polls;
