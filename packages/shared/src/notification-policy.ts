import { z } from 'zod';
import { hours, MINUTE_MS } from './cadence';
import { ProviderIdSchema, type FlightStatus, type ProviderId } from './flight-status';
import type { NotificationKind } from './push';

/**
 * The notification policy (increment 15, rulings N1 to N6): which flight changes become push
 * intents. Pure and provider-neutral: `evaluatePolicy` reads only two `FlightStatus` snapshots,
 * the tracker's persisted `PolicyState` and the instant the caller passes in. It never reads a
 * clock or a provider-specific field, so the same rules hold for any provider's answer and for an
 * injected snapshot. The tracker persists the returned state, writes the returned intents through
 * its outbox and acts on `wants` (a settle re-read for a delay, a confirming re-read for a
 * suspected cancellation or diversion). Every threshold the rulings name is a constant below.
 *
 * The tracker's calls (increment 15 and its review rulings Q3 and Q11): `evaluatePolicy` for an
 * observation that is not a due re-read (an alert merge, a seed, a read before `wants.from`),
 * `evaluateReread` for a provider read by designator from `wants.from` on, and
 * `evaluateFailedReread` when that read produced no snapshot. A suspicion records the provider
 * that raised it (`context.provider`, else `next.source`) and only that provider's conclusive
 * answer on a due re-read decides it, so an alert merge never confirms (Q11 (6)), and an answer
 * from another provider, `unknown`, `statusUncertain` or a failed read keeps it. A snapshot
 * that shows only a suspected change (`showsSuspectedChange`) is evidence, not state: the
 * tracker stores the returned policy state and keeps its last confirmed snapshot (Q11 (1)).
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
/** Q11: a suspicion's fast re-reads, `CONFIRM_REREAD_MINUTES` apart, before the slow ones. */
export const CONFIRM_FAST_REREADS = 3;
/**
 * Q11: once a suspicion's fast re-reads are spent, its next re-read is due at most this long
 * after the last one; the tracker reads at its own cadence slot when that is sooner.
 */
export const CONFIRM_SLOW_REREAD_MINUTES = 60;
/** Q11 (5): the fast re-reads one flight may spend on suspicions in all. */
export const CONFIRM_FAST_REREAD_BUDGET = 6;
/** Q3: consecutive failed settle re-reads retried `DELAY_SETTLE_MINUTES` apart. */
export const SETTLE_FAILED_REREADS = 2;
/** Q9: an arrival delay leaves band b downwards only below 15b minus this. */
export const ARRIVAL_CORRECTION_MARGIN_MINUTES = 5;
/** Q13: the N2 rate limit's tolerance, so a move at the next slot is not held a slot more. */
export const DELAY_RATE_LIMIT_TOLERANCE_SECONDS = 60;
/**
 * How early a read may come and still be the re-read a rule owes (the tracker's early-alarm
 * tolerance): each rule resolves on `evaluateReread` only from its own instant minus this.
 */
export const REREAD_TOLERANCE_MS = 5_000;
/** N5: an intent is time-sensitive inside this window before the departure's best estimate. */
export const TIME_SENSITIVE_WINDOW_MINUTES = 60;
/** N6: a cancellation stays relevant until scheduled departure plus this. */
export const CANCELLATION_RELEVANCE_MINUTES = hours(24);
/** N6: a diversion stays relevant until the arrival's best estimate plus this. */
export const DIVERSION_RELEVANCE_MINUTES = hours(6);

/** The `PolicyState` layout this build writes (see `readPolicyState`, which migrates layout 1). */
export const POLICY_STATE_VERSION = 2;

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

/**
 * N4 and Q11: a suspicion is evidence, not state. It names the provider whose answer raised it
 * (only that provider's conclusive answer decides) and the schedule of its re-reads. A suspected
 * un-cancellation (`uncancelled`) or un-diversion (`undiverted`) keeps the push it would undo in
 * `pushedAt` and `pushedValue`, so a re-read that does not confirm it restores that push.
 */
const SuspicionSchema = z.object({
  status: z.literal('suspect'),
  since: EpochMsSchema,
  value: z.string(),
  /** The provider whose answer raised it (`context.provider`, else the snapshot's `source`). */
  provider: ProviderIdSchema,
  /** Re-reads made so far that did not decide (inconclusive answers and failed reads). */
  reads: z.number().int().min(0),
  /** Fast re-reads still owed, `CONFIRM_REREAD_MINUTES` apart; then slow ones. */
  fastLeft: z.number().int().min(0),
  /** The last re-read that did not decide (`since` before the first): the next counts from it. */
  lastReadAt: EpochMsSchema,
  pushedAt: EpochMsSchema.optional(),
  pushedValue: z.string().optional(),
});

/** N4: none, suspected (awaiting a conclusive re-read), or confirmed and pushed. */
const DisruptionStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  SuspicionSchema,
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
     * `settled` marks one the re-read confirmed but the rate limit held back; `failedReads`
     * counts the consecutive settle re-reads that produced no snapshot (Q3).
     */
    pending: z
      .object({
        since: EpochMsSchema,
        settleAt: EpochMsSchema,
        settled: z.boolean(),
        failedReads: z.number().int().min(0),
      })
      .nullable(),
  }),
  gates: z.object({ origin: GateSideStateSchema, destination: GateSideStateSchema }),
  cancellation: DisruptionStateSchema,
  diversion: DisruptionStateSchema,
  /** Q11 (5): fast re-reads this flight may still spend on suspicions. */
  fastRereadsLeft: z.number().int().min(0),
});
export type PolicyState = z.infer<typeof PolicyStateSchema>;

/** Layout 1 (increment 15 before its review), read only to migrate it (`readPolicyState`). */
const DisruptionV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({
    status: z.literal('suspect'),
    since: EpochMsSchema,
    value: z.string(),
    pushedAt: EpochMsSchema.optional(),
  }),
  z.object({ status: z.literal('pushed'), at: EpochMsSchema, value: z.string() }),
]);
const PolicyStateV1Schema = z.object({
  v: z.literal(1),
  delay: z.object({
    pushedMinutes: z.number().int().nullable(),
    lastIntentAt: EpochMsSchema.nullable(),
    arrivalBand: z.number().int(),
    pending: z
      .object({ since: EpochMsSchema, settleAt: EpochMsSchema, settled: z.boolean() })
      .nullable(),
  }),
  gates: z.object({ origin: GateSideStateSchema, destination: GateSideStateSchema }),
  cancellation: DisruptionV1Schema,
  diversion: DisruptionV1Schema,
});
export type DisruptionState = z.infer<typeof DisruptionStateSchema>;
export type SuspicionState = z.infer<typeof SuspicionSchema>;
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
   * The value pushed: delay minutes (`'45'`), a gate, `cancelled` or `uncancelled`, the
   * diversion airport's ICAO code (`diverted` when the snapshot names none), or `undiverted`.
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
 * What the tracker must do next (epoch ms). Read the flight again no later than `at` (its next
 * alarm is the sooner of its cadence slot and `at`; at once when `at` has passed, an alarm that
 * ran late). A provider read by designator made at or after `from` (within
 * `REREAD_TOLERANCE_MS`) is the re-read: pass its snapshot to `evaluateReread`, or the state to
 * `evaluateFailedReread` when it produced none. Before `from`, a read is an ordinary
 * observation (`evaluatePolicy`). `from` equals `at` for a settle and for a fast confirming
 * re-read; once a suspicion's fast re-reads are spent, `from` stays 5 minutes after the last
 * re-read and `at` moves to 60 minutes after it, so the cadence slot between them is the re-read
 * (Q11 (3)). A `cancellation` or `diversion` reason asks for the read by designator through the
 * window's own provider (N4, Q11 (1)).
 */
export interface PolicyWants {
  at: number;
  from: number;
  reasons: PolicyRereadReason[];
}

export interface PolicyContext {
  /** N11: an injected snapshot is confirmed by construction (no settle, no confirmation). */
  confirmed?: boolean | undefined;
  /**
   * Q11: the provider that answered this observation; defaults to `next.source`. Only the
   * raising provider's conclusive answer decides a suspicion, so an alert merge passes the
   * alert's provider when its merged snapshot keeps another `source`.
   */
  provider?: ProviderId | undefined;
}

/** A due re-read that produced no snapshot: an error, a rate limit or `not_found` (Q3, Q11). */
export interface FailedRereadInput {
  state: PolicyState;
  /** Epoch milliseconds of the failed read. */
  now: number;
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

/**
 * N2: actual or estimated out against scheduled out, in whole minutes (negative when early);
 * undefined without both. Review ruling Q10: an unknown delay is unknown, not zero, so a
 * snapshot without an estimate never reads as on time (`departureEstimateMs` keeps its scheduled
 * fallback for N5, N6 and the origin gate window). Residual assumption: a provider that signals
 * on time by dropping the estimate gets no correction until out.
 */
export function departureDelayMinutes(status: FlightStatus): number | undefined {
  const scheduled = ms(status.times.scheduledOut);
  const best = ms(status.times.actualOut) ?? ms(status.times.estimatedOut);
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

/** Q17: two gates are the same gate whatever their case and whitespace (`b 12` is `B12`). */
function sameGate(a: string | null, b: string | null): boolean {
  const key = (gate: string | null): string | null =>
    gate === null ? null : gate.replace(/\s+/g, '').toUpperCase();
  return key(a) === key(b);
}

/**
 * The state for a tracker that has none yet (a new tracker, or one created before increment 15).
 * The snapshot counts as already known to its subscribers: its gates are seen, its delay is the
 * baseline the next delay intent is measured from, and its arrival band is implied. Nothing in
 * it is pushed, and a cancelled or diverted snapshot starts as `none` (the first evaluation that
 * still shows it suspects it).
 */
export function initialPolicyState(snapshot: FlightStatus): PolicyState {
  // The schedule is the baseline when the seed carries no estimate: nothing was announced, so
  // the first delay intent replaces "on time" (its `previousValue` is 0).
  const scheduled = ms(snapshot.times.scheduledOut) === undefined ? undefined : 0;
  const delay = departureDelayMinutes(snapshot) ?? scheduled;
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
    fastRereadsLeft: CONFIRM_FAST_REREAD_BUDGET,
  };
}

/**
 * Layout 1 to 2 (review ruling Q11). A layout-1 suspicion names no raising provider, and a
 * suspicion is evidence, not state: it is dropped (an un-cancellation's restores its push), and
 * the next observation that still shows the change raises it again with its provider.
 */
function migrateV1(v1: z.infer<typeof PolicyStateV1Schema>): PolicyState {
  const disruption = (old: z.infer<typeof DisruptionV1Schema>): DisruptionState => {
    if (old.status !== 'suspect') {
      return old;
    }
    return old.pushedAt === undefined
      ? { status: 'none' }
      : { status: 'pushed', at: old.pushedAt, value: 'cancelled' };
  };
  const { pending } = v1.delay;
  return {
    v: POLICY_STATE_VERSION,
    delay: { ...v1.delay, pending: pending === null ? null : { ...pending, failedReads: 0 } },
    gates: v1.gates,
    cancellation: disruption(v1.cancellation),
    diversion: disruption(v1.diversion),
    fastRereadsLeft: CONFIRM_FAST_REREAD_BUDGET,
  };
}

/**
 * Parses a persisted state, migrating layout 1; null for anything this build cannot read (a
 * newer `v`, or a malformed state), and the tracker then seeds a fresh one.
 */
export function readPolicyState(raw: unknown): PolicyState | null {
  const parsed = PolicyStateSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  const v1 = PolicyStateV1Schema.safeParse(raw);
  return v1.success ? migrateV1(v1.data) : null;
}

/**
 * Q11 (3): when a suspicion's next re-read is due. Fast re-reads are `CONFIRM_REREAD_MINUTES`
 * apart; once they are spent (or the flight's budget is), the next is due from 5 minutes after
 * the last and no later than `CONFIRM_SLOW_REREAD_MINUTES` after it.
 */
function suspicionWindow(s: SuspicionState): { from: number; at: number } {
  const from = s.lastReadAt + minutes(CONFIRM_REREAD_MINUTES);
  const at = s.fastLeft > 0 ? from : s.lastReadAt + minutes(CONFIRM_SLOW_REREAD_MINUTES);
  return { from, at };
}

/**
 * Q3: when a pending settle's re-read is due. After `SETTLE_FAILED_REREADS` consecutive failed
 * re-reads it stays due (`from` passed) and the tracker's next cadence slot is the re-read; `at`
 * bounds it as a slow confirming re-read is bounded.
 */
function settleWindow(pending: NonNullable<PolicyState['delay']['pending']>): {
  from: number;
  at: number;
} {
  const slow = pending.failedReads >= SETTLE_FAILED_REREADS;
  const at = slow ? pending.settleAt + minutes(CONFIRM_SLOW_REREAD_MINUTES) : pending.settleAt;
  return { from: pending.settleAt, at };
}

/**
 * The re-read a state owes, if any: the earliest instants and why. A pending settle is left out
 * while a cancellation is suspected or pushed (no delay rule runs then; it resumes with the
 * re-read that clears the suspicion).
 */
export function policyWants(state: PolicyState): PolicyWants | null {
  const due: { from: number; at: number; reason: PolicyRereadReason }[] = [];
  const { pending } = state.delay;
  if (pending !== null && !pending.settled && state.cancellation.status === 'none') {
    due.push({ ...settleWindow(pending), reason: 'settle' });
  }
  if (state.cancellation.status === 'suspect') {
    due.push({ ...suspicionWindow(state.cancellation), reason: 'cancellation' });
  }
  if (state.diversion.status === 'suspect') {
    due.push({ ...suspicionWindow(state.diversion), reason: 'diversion' });
  }
  if (due.length === 0) {
    return null;
  }
  return {
    at: Math.min(...due.map((d) => d.at)),
    from: Math.min(...due.map((d) => d.from)),
    reasons: due.map((d) => d.reason),
  };
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
  /** Q11: the provider that answered (`context.provider`, else `next.source`). */
  readonly provider: ProviderId;
  readonly state: PolicyState;
  readonly intents: PolicyIntent[];
}

/** N2 with Q13's tolerance: a move at the next slot is not held a whole slot by seconds. */
function delayRateLimited(d: Draft): boolean {
  const last = d.state.delay.lastIntentAt;
  const window = minutes(DELAY_MIN_INTERVAL_MINUTES) - DELAY_RATE_LIMIT_TOLERANCE_SECONDS * 1000;
  return last !== null && d.now - last < window;
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
 * observation after the window. Q12: the rule stops once out is observed (the arrival rule takes
 * over), and a pending delay is dropped then.
 */
function applyDepartureDelay(d: Draft): void {
  const delay = d.state.delay;
  if (outObserved(d.next)) {
    delay.pending = null;
    return;
  }
  const current = departureDelayMinutes(d.next);
  if (current === undefined) {
    // Q10: an unknown delay skips the rules. A re-read that cannot measure the delay cannot
    // confirm it, and a settled pending cannot be pushed from it: either clears the pending
    // delay (left, the first would keep asking for a re-read already due, the second would hold
    // the arrival rule for the rest of the flight).
    if (delay.pending !== null && (d.reread || delay.pending.settled)) {
      delay.pending = null;
    }
    return;
  }
  const pushed = delay.pushedMinutes;
  const delayed = pushed !== null && pushed >= DELAY_THRESHOLD_MINUTES;
  if (delay.pending === null && !delayed && current >= DELAY_THRESHOLD_MINUTES) {
    const settleAt = d.now + minutes(DELAY_SETTLE_MINUTES);
    delay.pending = { since: d.now, settleAt, settled: false, failedReads: 0 };
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

/**
 * N2 arrival bands, with review ruling Q9's hysteresis on the way down: an intent when the
 * arrival delay rises into a higher band (at once), or falls below the band last implied by
 * more than `ARRIVAL_CORRECTION_MARGIN_MINUTES` (band b is left below 15b - 5), so a wobble
 * across a band edge pushes once. Arrival delays are clamped at 0 (early to on time is silent);
 * back in band 0 is the correction, and a later rise into band 1 is a new delay, as at the
 * departure line.
 */
function applyArrivalDelay(d: Draft): void {
  const delay = d.state.delay;
  const measured = arrivalDelayMinutes(d.next);
  if (delay.pending !== null || measured === undefined || delayRateLimited(d)) {
    return;
  }
  const arrival = Math.max(0, measured);
  const band = arrivalDelayBand(arrival);
  const floor = delay.arrivalBand * ARRIVAL_DELAY_BAND_MINUTES - ARRIVAL_CORRECTION_MARGIN_MINUTES;
  if (band > delay.arrivalBand || arrival < floor) {
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
  // Q17: compared after normalising case and whitespace, so a provider's respelling of the same
  // gate is no change.
  if (sameGate(gate, before) || !gateWindowOpen(d, side)) {
    return;
  }
  const last = memory.pushed;
  const correction =
    last !== null &&
    sameGate(before, last.gate) &&
    sameGate(gate, last.previous) &&
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
 * Q11 (2): an answer that positively shows the flight operating: not `cancelled`, not `unknown`,
 * and not marked uncertain by its provider. The one predicate that clears a suspected
 * cancellation and suspects (then confirms) an un-cancellation or an un-diversion.
 */
function positivelyOperating(status: FlightStatus): boolean {
  return (
    status.statusUncertain !== true && status.status !== 'cancelled' && status.status !== 'unknown'
  );
}

/** A new suspicion of `value` raised by this observation's provider (Q11 (1)). */
function suspect(d: Draft, value: string, pushed?: { at: number; value: string }): SuspicionState {
  return {
    status: 'suspect',
    since: d.now,
    value,
    provider: d.provider,
    reads: 0,
    fastLeft: Math.min(CONFIRM_FAST_REREADS, d.state.fastRereadsLeft),
    lastReadAt: d.now,
    ...(pushed === undefined ? {} : { pushedAt: pushed.at, pushedValue: pushed.value }),
  };
}

/**
 * Whether this observation is the re-read a suspicion owes: an injection (confirmed by
 * construction), or a provider read the tracker made as the re-read, from the suspicion's own
 * `from` on. An alert merge or a seed (`evaluatePolicy`) never is, so neither ever decides.
 */
function suspicionDue(d: Draft, s: SuspicionState): boolean {
  return d.confirmed || (d.reread && d.now >= suspicionWindow(s).from - REREAD_TOLERANCE_MS);
}

/**
 * Q11 (2): whether a due re-read decides: an answer from the raising provider that is neither
 * `unknown` nor marked uncertain. Anything else (another provider, `unknown`, an uncertain
 * status; a failed read never gets here) keeps the suspicion.
 */
function conclusive(d: Draft, s: SuspicionState): boolean {
  return (
    d.confirmed ||
    (d.provider === s.provider && d.next.statusUncertain !== true && d.next.status !== 'unknown')
  );
}

/**
 * A due re-read that did not decide (inconclusive, or failed): one fast re-read spent from the
 * suspicion and from the flight's budget (Q11 (5)), the next counted from now.
 */
function inconclusiveRead(state: PolicyState, s: SuspicionState, now: number): SuspicionState {
  const fast = s.fastLeft > 0;
  if (fast) {
    state.fastRereadsLeft = Math.max(0, state.fastRereadsLeft - 1);
  }
  const fastLeft = Math.min(Math.max(0, s.fastLeft - 1), state.fastRereadsLeft);
  return { ...s, reads: s.reads + 1, fastLeft, lastReadAt: now };
}

/** A due re-read that decides spends its fast re-read from the flight's budget too. */
function spendDecidingRead(d: Draft, s: SuspicionState): void {
  if (!d.confirmed && s.fastLeft > 0) {
    d.state.fastRereadsLeft = Math.max(0, d.state.fastRereadsLeft - 1);
  }
}

/** The confirmed un-cancellation: the correction, and the cancellation rule starts over. */
function uncancel(d: Draft): void {
  const fields = { kind: 'cancellation', subject: 'flight', value: 'uncancelled' } as const;
  d.intents.push(
    intent({ ...fields, previousValue: 'cancelled', correction: true }, d.next, d.now),
  );
  d.state.cancellation = { status: 'none' };
}

/**
 * N4 and Q11: a `cancelled` answer raises a suspicion and nothing else (no intent; the tracker
 * keeps its last confirmed snapshot and its cadence). Only a due re-read answered conclusively
 * by the raising provider decides: `cancelled` confirms (the intent, and the tracker finishes),
 * a positively operating answer clears it. After a pushed cancellation, a positively operating
 * answer suspects an un-cancellation the same way (research R4 D2: a false "your flight is back
 * on" is as harmful as a false cancellation); its confirmation is the correction, a conclusive
 * `cancelled` restores the push. An injection is confirmed by construction.
 */
function applyCancellation(d: Draft): void {
  const current = d.state.cancellation;
  if (current.status === 'suspect') {
    resolveCancellation(d, current);
    return;
  }
  if (current.status === 'pushed') {
    if (!positivelyOperating(d.next)) {
      return;
    }
    if (d.confirmed) {
      uncancel(d);
    } else {
      d.state.cancellation = suspect(d, 'uncancelled', { at: current.at, value: current.value });
    }
    return;
  }
  if (d.next.status !== 'cancelled') {
    return;
  }
  if (d.confirmed) {
    const fields = { kind: 'cancellation', subject: 'flight', value: 'cancelled' } as const;
    d.intents.push(intent({ ...fields, previousValue: null }, d.next, d.now));
    d.state.cancellation = { status: 'pushed', at: d.now, value: 'cancelled' };
  } else {
    d.state.cancellation = suspect(d, 'cancelled');
  }
}

function resolveCancellation(d: Draft, s: SuspicionState): void {
  if (!suspicionDue(d, s)) {
    return;
  }
  if (!conclusive(d, s)) {
    d.state.cancellation = inconclusiveRead(d.state, s, d.now);
    return;
  }
  const cancelled = d.next.status === 'cancelled';
  if (!cancelled && !positivelyOperating(d.next)) {
    // Only an injection gets here (`unknown` or uncertain, confirmed): it decides nothing.
    return;
  }
  spendDecidingRead(d, s);
  if (s.value === 'uncancelled') {
    if (cancelled) {
      const value = s.pushedValue ?? 'cancelled';
      d.state.cancellation = { status: 'pushed', at: s.pushedAt ?? s.since, value };
    } else {
      uncancel(d);
    }
  } else if (cancelled) {
    const fields = { kind: 'cancellation', subject: 'flight', value: 'cancelled' } as const;
    d.intents.push(intent({ ...fields, previousValue: null }, d.next, d.now));
    d.state.cancellation = { status: 'pushed', at: d.now, value: 'cancelled' };
  } else {
    d.state.cancellation = { status: 'none' };
  }
}

function divert(d: Draft, value: string): void {
  const fields = { kind: 'diversion', subject: 'flight', value } as const;
  d.intents.push(intent({ ...fields, previousValue: d.next.destination.icao }, d.next, d.now));
  d.state.diversion = { status: 'pushed', at: d.now, value };
}

/** Q14: the confirmed un-diversion, a correction; the destination rules resume. */
function undivert(d: Draft, pushedValue: string): void {
  const fields = { kind: 'diversion', subject: 'flight', value: 'undiverted' } as const;
  d.intents.push(
    intent({ ...fields, previousValue: pushedValue, correction: true }, d.next, d.now),
  );
  d.state.diversion = { status: 'none' };
}

/**
 * The same evidence-not-state shape for a diversion (status `diverted`, or an actual destination
 * other than the planned one), without finishing the tracker. A confirmed diversion to another
 * airport than the one pushed (a re-diversion, or the airport named after a bare `diverted`) is
 * pushed again; a bare `diverted` after a pushed one is the same diversion. Q14: after a pushed
 * diversion, a positively operating answer that shows none suspects an un-diversion, confirmed
 * by a re-read like an un-cancellation: the correction, and the destination rules resume.
 */
function applyDiversion(d: Draft): void {
  const current = d.state.diversion;
  const value = diversionOf(d.next);
  if (current.status === 'suspect') {
    resolveDiversion(d, current, value);
    return;
  }
  if (current.status === 'pushed') {
    const pushed = { at: current.at, value: current.value };
    const changed =
      value === undefined
        ? positivelyOperating(d.next)
        : value !== current.value && value !== 'diverted';
    if (!changed) {
      return;
    }
    if (!d.confirmed) {
      d.state.diversion = suspect(d, value ?? 'undiverted', pushed);
    } else if (value === undefined) {
      undivert(d, current.value);
    } else {
      divert(d, value);
    }
    return;
  }
  if (value !== undefined && d.confirmed) {
    divert(d, value);
  } else if (value !== undefined) {
    d.state.diversion = suspect(d, value);
  }
}

function resolveDiversion(d: Draft, s: SuspicionState, value: string | undefined): void {
  if (!suspicionDue(d, s)) {
    return;
  }
  if (!conclusive(d, s)) {
    d.state.diversion = inconclusiveRead(d.state, s, d.now);
    return;
  }
  if (value === undefined && !positivelyOperating(d.next)) {
    // Only an injection gets here (`unknown` or uncertain, confirmed): it decides nothing.
    return;
  }
  spendDecidingRead(d, s);
  const pushedValue = s.pushedValue;
  if (value === undefined) {
    if (pushedValue === undefined) {
      d.state.diversion = { status: 'none' };
    } else {
      undivert(d, pushedValue);
    }
  } else if (pushedValue !== undefined && (value === pushedValue || value === 'diverted')) {
    d.state.diversion = { status: 'pushed', at: s.pushedAt ?? s.since, value: pushedValue };
  } else {
    divert(d, value);
  }
}

/**
 * Q11 (1): whether `next` shows the change `state` holds only as a suspicion: `cancelled` while
 * a cancellation is suspected, a positively operating flight while an un-cancellation is, a
 * diversion while one is suspected, or none while an un-diversion is. Such a snapshot is
 * evidence, not state: the tracker stores the policy state and keeps its last confirmed
 * snapshot, phase and cadence, so the app never shows an unconfirmed change. Pass the state
 * the evaluation of `next` returned.
 */
export function showsSuspectedChange(state: PolicyState, next: FlightStatus): boolean {
  const { cancellation, diversion } = state;
  if (cancellation.status === 'suspect') {
    const shown =
      cancellation.value === 'uncancelled'
        ? positivelyOperating(next)
        : next.status === 'cancelled';
    if (shown) {
      return true;
    }
  }
  if (diversion.status === 'suspect') {
    const diverted = diversionOf(next) !== undefined;
    return diversion.value === 'undiverted' ? !diverted : diverted;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------------------------

function run(input: PolicyInput, reread: boolean): PolicyResult {
  const state = JSON.parse(JSON.stringify(input.state)) as PolicyState;
  const { previous, next, now } = input;
  const confirmed = input.context?.confirmed === true;
  const provider = input.context?.provider ?? next.source;
  const d: Draft = { previous, next, now, reread, confirmed, provider, state, intents: [] };
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
 * only `evaluateReread` resolves it, so an alert merge never confirms (Q11 (6): a `cancelled`
 * alert on a stale `fa_flight_id` is the same artefact as the polled flag) though it may raise.
 */
export function evaluatePolicy(input: PolicyInput): PolicyResult {
  return run(input, false);
}

/**
 * The same classification for the re-read `wants` asked for (a provider read by designator made
 * from `wants.from` on), which also resolves what was pending before it: the N2 settle (the
 * intent with the re-read's value if the delay is still at or over the line, else the pending
 * delay clears) and an N4 suspicion due by its own `from` (Q11: the raising provider's
 * `cancelled` or diversion confirms, its positively operating answer clears; an answer from
 * another provider, `unknown` or `statusUncertain` is inconclusive and spends one re-read). A
 * change the re-read itself shows for the first time starts its own settle or suspicion.
 */
export function evaluateReread(input: PolicyInput): PolicyResult {
  return run(input, true);
}

/**
 * The re-read `wants` asked for produced no snapshot (an error, a rate limit, `not_found`).
 * Inconclusive by definition (Q11): each suspicion due at `now` keeps, spending one re-read
 * (its next is 5 minutes later while fast re-reads are left, else up to 60), and a pending
 * settle due at `now` counts one failed read (Q3: after `SETTLE_FAILED_REREADS` in a row it
 * stays due and the tracker's next cadence slot is the re-read). Never an intent.
 */
export function evaluateFailedReread(input: FailedRereadInput): PolicyResult {
  const state = JSON.parse(JSON.stringify(input.state)) as PolicyState;
  const { now } = input;
  const { pending } = state.delay;
  const settling = pending !== null && !pending.settled && state.cancellation.status === 'none';
  if (settling && now >= pending.settleAt - REREAD_TOLERANCE_MS) {
    pending.failedReads += 1;
    const retry = pending.failedReads < SETTLE_FAILED_REREADS;
    pending.settleAt = retry ? now + minutes(DELAY_SETTLE_MINUTES) : now;
  }
  for (const key of ['cancellation', 'diversion'] as const) {
    const s = state[key];
    if (s.status === 'suspect' && now >= suspicionWindow(s).from - REREAD_TOLERANCE_MS) {
      state[key] = inconclusiveRead(state, s, now);
    }
  }
  return { intents: [], state, wants: policyWants(state) };
}
