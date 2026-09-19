import { costUnits, listPriceUsdMicros, pollEquivalents } from './cost';
import type { AlertEvent, FlightStatusValue } from './flight-status';

/**
 * Refresh cadence (plan section 8). A cadence is an ordered list of windows. Each window
 * covers a span of the flight's life, names the provider that serves it, and says how polls
 * are placed inside it:
 *
 * - Interval windows place polls on a grid. Start-anchored windows (everything inside 48 h)
 *   put slot k at `start + k x interval` and yield `round(duration / interval)` slots, so a
 *   trailing partial slot earns a poll only when it is at least half an interval long. The
 *   pre-48 h windows are end-anchored (they count back from T-48 h so the daily grid lands on
 *   T-3 d, T-4 d, ...) and yield `floor(duration / interval)` slots, so no slot can precede
 *   the window start. The boundary instant between two windows belongs to the later window.
 * - Fixed-slot windows (cadence B) list explicit offsets.
 * - `finalPoll` adds one poll at the window's end; only the last window may use it.
 *
 * `refreshIntervalFor` is the function the FlightTracker alarm calls; `expectedCalls`
 * simulates a flight by calling that same function in a loop, so the per-window counts in
 * `docs/architecture.md` and the constants the lifecycle test imports fall out of the
 * definitions instead of being typed by hand. Nothing here reads the wall clock.
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
  finalPoll?: boolean;
}

export interface FixedSlot {
  edge: 'from' | 'to' | 'scheduledOut';
  offsetMinutes: number;
}

export interface FixedSlotWindow extends CadenceWindowBase {
  slots: readonly FixedSlot[];
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

/** Which SLO windows a cadence tier overlaps, for the relaxation report in the docs. */
export const TIER_SLO_WINDOWS: Readonly<Record<CadenceTier, readonly SloWindow[]>> = {
  pre48h_far: ['beyond_7d'],
  pre48h_near: ['7d_to_48h'],
  hourly: ['48h_to_6h'],
  pre_boarding: ['6h_to_3h', '3h_to_arrival'],
  in_flight: ['3h_to_arrival'],
  post_arrival: ['post_arrival'],
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

/** Polls only, no alerts: the automatic fallback when alerts go silent. */
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
      intervalMinutes: 30,
      finalPoll: true,
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
 * so a late flight keeps its in-flight cadence until `in` is seen or the lifetime ends.
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
    let end = resolveEdge(window.to, bounds);
    if (extendInFlight && window.to === 'arrival') {
      end = Number.POSITIVE_INFINITY;
      windows.push({ window, start, end });
      break;
    }
    if (end <= start) {
      continue;
    }
    windows.push({ window, start, end });
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
  return window.anchor === 'end' ? Math.floor(ratio) : Math.round(ratio);
}

function resolveFixedSlot(slot: FixedSlot, resolved: ResolvedWindow, bounds: Bounds): number {
  const base =
    slot.edge === 'from' ? resolved.start : slot.edge === 'to' ? resolved.end : bounds.scheduledOut;
  return base + slot.offsetMinutes * MINUTE_MS;
}

function nextSlotInWindow(resolved: ResolvedWindow, bounds: Bounds, now: number): number | null {
  const { window, start, end } = resolved;
  if (!isIntervalWindow(window)) {
    let best: number | null = null;
    for (const slot of window.slots) {
      const at = resolveFixedSlot(slot, resolved, bounds);
      if (at > now && at >= start && at <= end && (best === null || at < best)) {
        best = at;
      }
    }
    return best;
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
  if (k < count) {
    return start + k * interval;
  }
  if (window.finalPoll === true && Number.isFinite(end) && end > now) {
    return end;
  }
  return null;
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

export interface ExpectedCallsParams {
  /** Days before scheduled departure at which the tracker is created. */
  leadTimeDays: number;
  blockMinutes?: number;
  boardingMinutesBefore?: number;
  postArrivalStopMinutes?: number;
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
}

const SIMULATION_SCHEDULED_OUT_MS = Date.UTC(2026, 8, 19, 12, 0, 0);
const MAX_SIMULATED_POLLS = 100_000;

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
  const blockMinutes = params.blockMinutes ?? 180;
  const cadenceParams: CadenceParams = {
    boardingMinutesBefore:
      params.boardingMinutesBefore ?? DEFAULT_CADENCE_PARAMS.boardingMinutesBefore,
    postArrivalStopMinutes:
      params.postArrivalStopMinutes ?? DEFAULT_CADENCE_PARAMS.postArrivalStopMinutes,
  };
  const scheduledOut = new Date(SIMULATION_SCHEDULED_OUT_MS);
  const scheduledIn = new Date(SIMULATION_SCHEDULED_OUT_MS + blockMinutes * MINUTE_MS);
  const boardingMs = SIMULATION_SCHEDULED_OUT_MS - cadenceParams.boardingMinutesBefore * MINUTE_MS;

  const counts = new Map<CadenceWindow, number>();
  const bump = (window: CadenceWindow): void => {
    counts.set(window, (counts.get(window) ?? 0) + 1);
  };

  let t = SIMULATION_SCHEDULED_OUT_MS - params.leadTimeDays * DAY_MS;
  const creation = windowAt(
    cadence,
    onTimeContext(t, scheduledOut, scheduledIn, boardingMs),
    cadenceParams,
  );
  if (creation !== null) {
    bump(creation);
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
    bump(window);
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
  };
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
