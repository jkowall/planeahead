import { z } from 'zod';
import { hours, MINUTE_MS } from './cadence';
import type { FlightStatus } from './flight-status';
import type { NotificationKind } from './push';

/**
 * The notification policy (increment 15, rulings N1 to N6): which flight changes become push
 * intents. Pure and provider-neutral: `evaluatePolicy` reads only two `FlightStatus` snapshots,
 * the tracker's persisted `PolicyState` and the instant the caller passes in. It never reads a
 * clock or a provider-specific field, so the same rules hold for any provider's answer and for an
 * injected snapshot. The tracker persists the returned state, writes the returned intents through
 * its outbox and acts on `wants` (a settle re-read for a delay, a confirming re-read for a
 * suspected cancellation or diversion). Every threshold the rulings name is a constant below.
 */

/** N2: the departure delay that first produces a delay intent (14 CFR 234.2). */
export const DELAY_THRESHOLD_MINUTES = 15;
/** N2: after a pushed delay, the estimate must move this much from the last pushed value. */
export const DELAY_STEP_MINUTES = 15;
/** N2: the settle re-read runs at most this long after the delay first reaches the line. */
export const DELAY_SETTLE_MINUTES = 5;
/** N2: never more than one delay intent per flight inside this window. */
export const DELAY_MIN_INTERVAL_MINUTES = 15;
/** N2: an arrival delay produces an intent only when it crosses a band of this width. */
export const ARRIVAL_DELAY_BAND_MINUTES = 15;
/** N3: origin gate changes count from this long before departure (T-6 h) to actual out. */
export const ORIGIN_GATE_WINDOW_MINUTES = hours(6);
/** N3: a return to the previous gate inside this window is a flap. */
export const GATE_FLAP_WINDOW_MINUTES = 10;
/** N4: the confirming re-read of a cancellation or diversion runs at most this long after. */
export const CONFIRM_REREAD_MINUTES = 5;
/** N5: an intent is time-sensitive inside this window before the departure's best estimate. */
export const TIME_SENSITIVE_WINDOW_MINUTES = 60;
/** N6: a cancellation stays relevant until scheduled departure plus this. */
export const CANCELLATION_RELEVANCE_MINUTES = hours(24);
/** N6: a diversion stays relevant until the arrival's best estimate plus this. */
export const DIVERSION_RELEVANCE_MINUTES = hours(6);

/** The `PolicyState` layout this build writes (see `readPolicyState`). */
export const POLICY_STATE_VERSION = 1;

const minutes = (n: number): number => n * MINUTE_MS;

const EpochMsSchema = z.number().int();

/** One side's gate memory (N3): the last gate observed, and the last gate intent with its time. */
const GateSideStateSchema = z.object({
  /** The last non-empty gate observed, pushed or not; null before any. */
  seen: z.string().nullable(),
  /** The last gate intent: its gate, the gate it replaced (null on a first assignment), when. */
  pushed: z
    .object({ gate: z.string(), previous: z.string().nullable(), at: EpochMsSchema })
    .nullable(),
});

/** N4: none, suspected (awaiting the confirming re-read), or confirmed and pushed. */
const DisruptionStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({ status: z.literal('suspect'), since: EpochMsSchema, value: z.string() }),
  z.object({ status: z.literal('pushed'), at: EpochMsSchema, value: z.string() }),
]);

/**
 * What the tracker persists between alarms (JSON). Instants are epoch milliseconds. `v` names the
 * layout; `readPolicyState` returns null for a layout this build cannot read, and the tracker then
 * seeds a fresh state from its current snapshot with `initialPolicyState`.
 */
export const PolicyStateSchema = z.object({
  v: z.literal(POLICY_STATE_VERSION),
  delay: z.object({
    /** The last departure delay pushed (minutes), or the creation baseline; null when none. */
    pushedMinutes: z.number().int().nullable(),
    /** When the last delay intent of either subject was produced (the N2 rate limit). */
    lastIntentAt: EpochMsSchema.nullable(),
    /** The arrival delay band the last delay intent implied (N2 arrival bands). */
    arrivalBand: z.number().int(),
    /**
     * A departure delay that reached the line and awaits its settle re-read at `settleAt`.
     * `settled` marks one the re-read confirmed but the rate limit held back.
     */
    pending: z
      .object({ since: EpochMsSchema, settleAt: EpochMsSchema, settled: z.boolean() })
      .nullable(),
  }),
  gates: z.object({ origin: GateSideStateSchema, destination: GateSideStateSchema }),
  cancellation: DisruptionStateSchema,
  diversion: DisruptionStateSchema,
});
export type PolicyState = z.infer<typeof PolicyStateSchema>;
export type DisruptionState = z.infer<typeof DisruptionStateSchema>;
export type GateSideState = z.infer<typeof GateSideStateSchema>;

/** The kinds the policy produces (N2 to N4). */
export type PolicyIntentKind = Extract<
  NotificationKind,
  'delay' | 'gate_change' | 'cancellation' | 'diversion'
>;
/** What an intent is about: a delay's end, a gate's side, or the whole flight. */
export type PolicyIntentSubject = 'departure' | 'arrival' | 'origin' | 'destination' | 'flight';

/** One push-worthy change (N1). The tracker writes it as a `notify_intent` outbox row (N7). */
export interface PolicyIntent {
  kind: PolicyIntentKind;
  subject: PolicyIntentSubject;
  /**
   * The value pushed: delay minutes (`'45'`), a gate, `cancelled` or `uncancelled`, or the
   * diversion airport's ICAO code (`diverted` when the snapshot names none).
   */
  value: string;
  /** The value it replaces: the last pushed delay, the previous gate; null when none. */
  previousValue: string | null;
  /** A delay back under the line, a gate flap reverted after its push, an un-cancellation. */
  correction: boolean;
  /** A gate on a side that had none (N3); `notify` sends it only to users who opted in. */
  firstAssignment: boolean;
  /** N5: the time-sensitive interruption level instead of active. */
  timeSensitive: boolean;
  /** N6: ISO instant past which the push path drops the intent's targets. */
  expiresAt: string;
  /**
   * Stable for this change (`departure:45`, `origin:B12`, `flight:cancelled`); the tracker adds
   * the flight, the kind and its change sequence to make the `notif_dedupe` key (N7).
   */
  dedupeValue: string;
}

/** Why the tracker must read the flight again before the cadence says so. */
export type PolicyRereadReason = 'settle' | 'cancellation' | 'diversion';

/**
 * What the tracker must do next: read the flight again no later than `at` (epoch ms) and pass
 * the result to `evaluateReread`. A `cancellation` or `diversion` reason asks for the confirming
 * read by designator through the provider router (N4). `at` can already be past when the state
 * is read back (an alarm that ran late); the tracker then re-reads at once.
 */
export interface PolicyWants {
  at: number;
  reasons: PolicyRereadReason[];
}

export interface PolicyContext {
  /** N11: an injected snapshot is confirmed by construction (no settle, no confirmation). */
  confirmed?: boolean | undefined;
}

export interface PolicyInput {
  /** The snapshot the tracker held before this observation. */
  previous: FlightStatus;
  /** The snapshot just observed (a poll, an alert merge, a re-read, an injection). */
  next: FlightStatus;
  state: PolicyState;
  /** Epoch milliseconds of the observation; the policy never reads a clock. */
  now: number;
  context?: PolicyContext | undefined;
}

export interface PolicyResult {
  intents: PolicyIntent[];
  state: PolicyState;
  /** Null when nothing is pending; otherwise the re-read the tracker owes. */
  wants: PolicyWants | null;
}

// ---------------------------------------------------------------------------------------------
// Snapshot readers. Provider-neutral: `FlightStatus` times and status only.
// ---------------------------------------------------------------------------------------------

function ms(instant: string | undefined): number | undefined {
  if (instant === undefined) {
    return undefined;
  }
  const value = Date.parse(instant);
  return Number.isNaN(value) ? undefined : value;
}

/** The departure's best estimate: actual out, else estimated out, else scheduled out. */
export function departureEstimateMs(status: FlightStatus): number | undefined {
  const { times } = status;
  return ms(times.actualOut) ?? ms(times.estimatedOut) ?? ms(times.scheduledOut);
}

/** The arrival's best estimate: actual in, else estimated in, else scheduled in. */
export function arrivalEstimateMs(status: FlightStatus): number | undefined {
  const { times } = status;
  return ms(times.actualIn) ?? ms(times.estimatedIn) ?? ms(times.scheduledIn);
}

/** N2: the best estimate of out against scheduled out, in whole minutes (negative when early). */
export function departureDelayMinutes(status: FlightStatus): number | undefined {
  const scheduled = ms(status.times.scheduledOut);
  const best = departureEstimateMs(status);
  return scheduled === undefined || best === undefined
    ? undefined
    : Math.round((best - scheduled) / MINUTE_MS);
}

/** N2: actual or estimated in against scheduled in, in whole minutes; undefined without both. */
export function arrivalDelayMinutes(status: FlightStatus): number | undefined {
  const scheduled = ms(status.times.scheduledIn);
  const best = ms(status.times.actualIn) ?? ms(status.times.estimatedIn);
  return scheduled === undefined || best === undefined
    ? undefined
    : Math.round((best - scheduled) / MINUTE_MS);
}

/** N2: the 15-minute arrival band a delay falls in; anything under the first band is band 0. */
export function arrivalDelayBand(delayMinutes: number): number {
  return Math.max(0, Math.floor(delayMinutes / ARRIVAL_DELAY_BAND_MINUTES));
}

const OUT_STATUSES: ReadonlySet<string> = new Set(['departed', 'en_route', 'landed', 'arrived']);
const OFF_STATUSES: ReadonlySet<string> = new Set(['en_route', 'landed', 'arrived']);

/** Out is observed: an actual out (or a later OOOI actual), or a status past the gate. */
function outObserved(status: FlightStatus): boolean {
  const { times } = status;
  const actual = times.actualOut ?? times.actualOff ?? times.actualOn ?? times.actualIn;
  return actual !== undefined || OUT_STATUSES.has(status.status);
}

function offObserved(status: FlightStatus): boolean {
  const { times } = status;
  const actual = times.actualOff ?? times.actualOn ?? times.actualIn;
  return actual !== undefined || OFF_STATUSES.has(status.status);
}

function inObserved(status: FlightStatus): boolean {
  return status.times.actualIn !== undefined || status.status === 'arrived';
}

/** N4: the diversion a snapshot shows (the airport it names, or `diverted`), else undefined. */
function diversionOf(status: FlightStatus): string | undefined {
  const actual = status.actualDestination?.icao;
  if (actual !== undefined && actual !== status.destination.icao) {
    return actual;
  }
  return status.status === 'diverted' ? 'diverted' : undefined;
}

// ---------------------------------------------------------------------------------------------
// State helpers.
// ---------------------------------------------------------------------------------------------

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

/**
 * The state for a tracker that has none yet (a new tracker, or one created before increment 15).
 * The snapshot counts as already known to its subscribers: its gates are seen, its delay is the
 * baseline the next delay intent is measured from, and its arrival band is implied. Nothing in
 * it is pushed, and a cancelled or diverted snapshot starts as `none` (the first evaluation that
 * still shows it suspects it).
 */
export function initialPolicyState(snapshot: FlightStatus): PolicyState {
  const delay = departureDelayMinutes(snapshot);
  const arrival = arrivalDelayMinutes(snapshot) ?? delay;
  return {
    v: POLICY_STATE_VERSION,
    delay: {
      pushedMinutes: delay ?? null,
      lastIntentAt: null,
      arrivalBand: arrival === undefined ? 0 : arrivalDelayBand(arrival),
      pending: null,
    },
    gates: {
      origin: { seen: nonEmpty(snapshot.originGate), pushed: null },
      destination: { seen: nonEmpty(snapshot.destinationGate), pushed: null },
    },
    cancellation: { status: 'none' },
    diversion: { status: 'none' },
  };
}

/** Parses a persisted state; null for anything this build cannot read (an older or newer `v`). */
export function readPolicyState(raw: unknown): PolicyState | null {
  const parsed = PolicyStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The re-read a state owes, if any: the earliest settle or confirmation instant and why. */
export function policyWants(state: PolicyState): PolicyWants | null {
  const due: { at: number; reason: PolicyRereadReason }[] = [];
  const { pending } = state.delay;
  if (pending !== null && !pending.settled) {
    due.push({ at: pending.settleAt, reason: 'settle' });
  }
  if (state.cancellation.status === 'suspect') {
    due.push({
      at: state.cancellation.since + minutes(CONFIRM_REREAD_MINUTES),
      reason: 'cancellation',
    });
  }
  if (state.diversion.status === 'suspect') {
    due.push({ at: state.diversion.since + minutes(CONFIRM_REREAD_MINUTES), reason: 'diversion' });
  }
  if (due.length === 0) {
    return null;
  }
  return { at: Math.min(...due.map((d) => d.at)), reasons: due.map((d) => d.reason) };
}

// ---------------------------------------------------------------------------------------------
// N5 and N6: what every intent carries.
// ---------------------------------------------------------------------------------------------

/**
 * An intent never expires sooner than this after it is produced. The N6 anchors are estimates; a
 * stale one already in the past (a flight held at the gate past its estimate) would otherwise make
 * the push path drop the intent before any target is tried.
 */
export const RELEVANCE_FLOOR_MINUTES = 15;

/** N5: produced within the hour before the departure's best estimate, and before out. */
export function isTimeSensitive(next: FlightStatus, now: number): boolean {
  const departure = departureEstimateMs(next);
  return (
    departure !== undefined &&
    !outObserved(next) &&
    now >= departure - minutes(TIME_SENSITIVE_WINDOW_MINUTES)
  );
}

/** N6: the end of an intent's relevance window, as epoch milliseconds. */
export function relevanceEndMs(
  kind: PolicyIntentKind,
  subject: PolicyIntentSubject,
  next: FlightStatus,
  now: number,
): number {
  let anchor: number | undefined;
  if (kind === 'gate_change' && subject === 'origin') {
    anchor = departureEstimateMs(next);
  } else if (kind === 'gate_change' || kind === 'delay') {
    anchor = arrivalEstimateMs(next);
  } else if (kind === 'cancellation') {
    const scheduled = ms(next.times.scheduledOut) ?? departureEstimateMs(next);
    anchor =
      scheduled === undefined ? undefined : scheduled + minutes(CANCELLATION_RELEVANCE_MINUTES);
  } else {
    const arrival = arrivalEstimateMs(next);
    anchor = arrival === undefined ? undefined : arrival + minutes(DIVERSION_RELEVANCE_MINUTES);
  }
  return Math.max(anchor ?? now, now + minutes(RELEVANCE_FLOOR_MINUTES));
}

type IntentFields = Pick<PolicyIntent, 'kind' | 'subject' | 'value' | 'previousValue'> &
  Partial<Pick<PolicyIntent, 'correction' | 'firstAssignment'>>;

function intent(fields: IntentFields, next: FlightStatus, now: number): PolicyIntent {
  const { kind, subject, value } = fields;
  return {
    kind,
    subject,
    value,
    previousValue: fields.previousValue,
    correction: fields.correction ?? false,
    firstAssignment: fields.firstAssignment ?? false,
    timeSensitive: isTimeSensitive(next, now),
    expiresAt: new Date(relevanceEndMs(kind, subject, next, now)).toISOString(),
    dedupeValue: `${subject}:${value}`,
  };
}

// ---------------------------------------------------------------------------------------------
// N2: delays.
// ---------------------------------------------------------------------------------------------

/** One evaluation in progress: a private copy of the state the rules update in place. */
interface Draft {
  readonly previous: FlightStatus;
  readonly next: FlightStatus;
  readonly now: number;
  /** This observation is the re-read a pending settle or suspicion asked for. */
  readonly reread: boolean;
  readonly confirmed: boolean;
  readonly state: PolicyState;
  readonly intents: PolicyIntent[];
}

function delayRateLimited(d: Draft): boolean {
  const last = d.state.delay.lastIntentAt;
  return last !== null && d.now - last < minutes(DELAY_MIN_INTERVAL_MINUTES);
}

function emitDelay(
  d: Draft,
  subject: 'departure' | 'arrival',
  value: number,
  previous: number | null,
  correction: boolean,
): void {
  const fields = { kind: 'delay', subject, value: String(value), correction } as const;
  const previousValue = previous === null ? null : String(previous);
  d.intents.push(intent({ ...fields, previousValue }, d.next, d.now));
  d.state.delay.lastIntentAt = d.now;
  const arrival = subject === 'arrival' ? value : (arrivalDelayMinutes(d.next) ?? value);
  d.state.delay.arrivalBand = arrivalDelayBand(arrival);
}

/**
 * The departure delay (N2): the line with its settle re-read, then 15-minute moves from the last
 * pushed value and the correction back under the line, at most one delay intent per 15 minutes.
 * The rules are level-based, so a change the rate limit held back is re-evaluated at the next
 * observation after the window.
 */
function applyDepartureDelay(d: Draft): void {
  const delay = d.state.delay;
  const current = departureDelayMinutes(d.next);
  if (current === undefined) {
    // A re-read that cannot measure the delay cannot confirm it, so the pending delay clears
    // (left pending, it would keep asking for a re-read that is already due).
    if (d.reread && delay.pending !== null) {
      delay.pending = null;
    }
    return;
  }
  const pushed = delay.pushedMinutes;
  const delayed = pushed !== null && pushed >= DELAY_THRESHOLD_MINUTES;
  if (delay.pending === null && !delayed && current >= DELAY_THRESHOLD_MINUTES) {
    const settleAt = d.now + minutes(DELAY_SETTLE_MINUTES);
    delay.pending = { since: d.now, settleAt, settled: false };
    if (!d.confirmed) {
      return;
    }
  } else if (delay.pending !== null && !(d.reread || d.confirmed || delay.pending.settled)) {
    return;
  }
  if (delay.pending !== null) {
    if (current < DELAY_THRESHOLD_MINUTES) {
      delay.pending = null;
    } else if (delayRateLimited(d)) {
      delay.pending.settled = true;
    } else {
      delay.pending = null;
      emitDelay(d, 'departure', current, pushed, false);
      delay.pushedMinutes = current;
    }
    return;
  }
  if (!delayed || delayRateLimited(d)) {
    return;
  }
  const backUnder = current < DELAY_THRESHOLD_MINUTES;
  if (backUnder || Math.abs(current - pushed) >= DELAY_STEP_MINUTES) {
    emitDelay(d, 'departure', current, pushed, backUnder);
    delay.pushedMinutes = current;
  }
}

/** N2 arrival bands: an intent only when the arrival delay leaves the band last implied. */
function applyArrivalDelay(d: Draft): void {
  const delay = d.state.delay;
  const arrival = arrivalDelayMinutes(d.next);
  if (delay.pending !== null || arrival === undefined || delayRateLimited(d)) {
    return;
  }
  const band = arrivalDelayBand(arrival);
  if (band !== delay.arrivalBand) {
    emitDelay(d, 'arrival', arrival, null, band === 0);
  }
}

// ---------------------------------------------------------------------------------------------
// N3: gates.
// ---------------------------------------------------------------------------------------------

type GateSide = 'origin' | 'destination';
const GATE_FIELD = { origin: 'originGate', destination: 'destinationGate' } as const;

/** Origin: from T-6 h (scheduled out) to out. Destination: from off to in. */
function gateWindowOpen(d: Draft, side: GateSide): boolean {
  if (side === 'destination') {
    return offObserved(d.next) && !inObserved(d.next);
  }
  const departure = ms(d.next.times.scheduledOut) ?? departureEstimateMs(d.next);
  return (
    departure !== undefined &&
    d.now >= departure - minutes(ORIGIN_GATE_WINDOW_MINUTES) &&
    !outObserved(d.next)
  );
}

/**
 * A gate change inside its window is an intent when observed. A return to the gate before the
 * last pushed change, within the flap window, is a correction (the collapse id replaces the
 * wrong gate on screen); a flap that reverts before any evaluation sees it never shows up as a
 * change, so both halves drop. A gate on a side that had none is a first assignment. Changes
 * outside the window update the memory and push nothing.
 */
function applyGate(d: Draft, side: GateSide): void {
  const memory = d.state.gates[side];
  const gate = nonEmpty(d.next[GATE_FIELD[side]]);
  const before = memory.seen ?? nonEmpty(d.previous[GATE_FIELD[side]]);
  if (gate === null) {
    return;
  }
  memory.seen = gate;
  if (gate === before || !gateWindowOpen(d, side)) {
    return;
  }
  const last = memory.pushed;
  const correction =
    last !== null &&
    before === last.gate &&
    gate === last.previous &&
    d.now - last.at <= minutes(GATE_FLAP_WINDOW_MINUTES);
  const fields = {
    kind: 'gate_change',
    subject: side,
    value: gate,
    previousValue: before,
  } as const;
  d.intents.push(
    intent({ ...fields, correction, firstAssignment: before === null }, d.next, d.now),
  );
  memory.pushed = { gate, previous: before, at: d.now };
}

// ---------------------------------------------------------------------------------------------
// N4: cancellation and diversion, confirm then push.
// ---------------------------------------------------------------------------------------------

/**
 * A snapshot turning `cancelled` makes the state `suspect` (no intent; the tracker must not
 * finish). The confirming re-read pushes the cancellation if it still says `cancelled` and
 * clears the suspicion otherwise. After a pushed cancellation, a snapshot that is neither
 * `cancelled` nor `unknown` pushes the un-cancellation as a correction.
 */
function applyCancellation(d: Draft): void {
  const current = d.state.cancellation;
  const cancelled = d.next.status === 'cancelled';
  const fields = { kind: 'cancellation', subject: 'flight' } as const;
  if (current.status === 'pushed') {
    if (!cancelled && d.next.status !== 'unknown') {
      const correction = { ...fields, value: 'uncancelled', previousValue: 'cancelled' };
      d.intents.push(intent({ ...correction, correction: true }, d.next, d.now));
      d.state.cancellation = { status: 'none' };
    }
    return;
  }
  if (current.status === 'suspect' && !d.reread && !d.confirmed) {
    return;
  }
  if (current.status === 'none' && cancelled && !d.confirmed) {
    d.state.cancellation = { status: 'suspect', since: d.now, value: 'cancelled' };
  } else if (cancelled) {
    d.intents.push(intent({ ...fields, value: 'cancelled', previousValue: null }, d.next, d.now));
    d.state.cancellation = { status: 'pushed', at: d.now, value: 'cancelled' };
  } else {
    d.state.cancellation = { status: 'none' };
  }
}

/**
 * The same shape for a diversion (status `diverted`, or an actual destination other than the
 * planned one), without finishing the tracker. A confirmed diversion to a different airport than
 * the one pushed (a re-diversion, or the airport named after a bare `diverted`) is pushed again.
 */
function applyDiversion(d: Draft): void {
  const current = d.state.diversion;
  const value = diversionOf(d.next);
  if (current.status === 'suspect') {
    if (!d.reread && !d.confirmed) {
      return;
    }
  } else if (value === undefined || (current.status === 'pushed' && current.value === value)) {
    return;
  } else if (!d.confirmed) {
    d.state.diversion = { status: 'suspect', since: d.now, value };
    return;
  }
  if (value === undefined) {
    d.state.diversion = { status: 'none' };
    return;
  }
  const fields = { kind: 'diversion', subject: 'flight', value } as const;
  d.intents.push(intent({ ...fields, previousValue: d.next.destination.icao }, d.next, d.now));
  d.state.diversion = { status: 'pushed', at: d.now, value };
}

// ---------------------------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------------------------

function run(input: PolicyInput, reread: boolean): PolicyResult {
  const state = JSON.parse(JSON.stringify(input.state)) as PolicyState;
  const { previous, next, now } = input;
  const confirmed = input.context?.confirmed === true;
  const d: Draft = { previous, next, now, reread, confirmed, state, intents: [] };
  applyCancellation(d);
  // A suspected or confirmed cancellation stops every other rule (its times and gates are noise);
  // they run again, from the same memory, once a re-read clears the suspicion.
  if (d.state.cancellation.status === 'none') {
    applyDiversion(d);
    const diverted = d.state.diversion.status !== 'none' || diversionOf(next) !== undefined;
    applyDepartureDelay(d);
    applyGate(d, 'origin');
    // The planned destination's gate and arrival estimate mean nothing to a diverted flight.
    if (!diverted) {
      applyArrivalDelay(d);
      applyGate(d, 'destination');
    }
  }
  return { intents: d.intents, state: d.state, wants: policyWants(d.state) };
}

/**
 * N1: classifies one observation (a poll, an alert merge, an injected snapshot) against the
 * snapshot before it. Returns the intents to write in the same transaction as the state, the
 * state to persist, and the re-read the tracker owes (`wants`; the next alarm moves to no later
 * than `wants.at`, whatever the cadence says). A pending settle or suspicion is left pending:
 * only `evaluateReread` resolves it.
 */
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  return run(input, false);
}

/**
 * The same classification for the re-read `wants` asked for, which also resolves what was
 * pending before it: the N2 settle (the intent with the re-read's value if the delay is still at
 * or over the line, else the pending delay clears) and the N4 confirmation (confirmed: the
 * intent; not cancelled or diverted any more: the suspicion clears, nothing is pushed). A change
 * the re-read itself shows for the first time starts its own settle or suspicion.
 */
export function evaluateReread(input: PolicyInput): PolicyResult {
  return run(input, true);
}
