/**
 * FlightTracker Durable Object (increment 7).
 *
 * One object per canonical flight key (ADR 0003), for example `AAL-100-2026-09-19-KJFK`. This is
 * where the shared-flight invariant becomes structural: every subscriber to a flight talks to
 * this one object, so a refresh costs one provider call no matter how many users are watching.
 * A refresh already in flight is joined by every caller, the alarm included (`#inflight`), and a
 * user refresh inside `USER_REFRESH_FRESHNESS_MS` of the last answer is served from the stored
 * snapshot without a call.
 *
 * The alarm handler is five steps, in this order, and the order is the design (ADR 0011):
 *
 *   0. Join whatever is in flight: a fetch (`#inflight`) or the finish path (`#finishing`), so
 *      step 1 reads a settled row and nothing fetches or writes events after the archive.
 *   1. ONE `transactionSync` before any I/O: read `alarmInfo?.retryCount`, find the slot this
 *      alarm is for, and decide. On a platform retry the COMMITTED SCHEDULE decides, never the
 *      age of the last attempt: the first delivery's step 1 advanced `next_refresh_at_ms` past
 *      now (or to NULL for the last slot), so a retry that finds it there skips the provider I/O
 *      (`skip_io`) and only resumes the committed plan (re-asserts the alarm, or runs the finish
 *      path when the plan had no next slot); a retry that finds the due slot still due knows step
 *      1 rolled back and polls it. A slot whose `last_refreshed_at_ms` lies within its tier
 *      interval (a user refresh just answered) is satisfied without a call. Otherwise: insert
 *      the attempt, debit the per-flight budget (`perFlightLedgerDecision`: the soft cap logs and
 *      stretches the cadence one tier, the hard cap stops polling and schedules one
 *      reconciliation poll at scheduled arrival), append the outbox intent row and
 *      `setAlarm(next)` without awaiting it. The commit makes attempt, debit, outbox row and
 *      alarm atomic (spike 1: `setAlarm` inside `transactionSync` is covered by the rollback,
 *      and inside a handler a rolled-back `setAlarm` must never be swallowed: rethrow).
 *   2. `retryCount >= 5`: `setAlarm(now + 30 s)` and return, never set-then-throw, and never
 *      touching the committed schedule: when that alarm fires, the schedule decides again. The
 *      ladder applies to every plan kind, the finish and cleanup alarms included. The reconcile
 *      cron is the backstop, not the primary recovery.
 *   3. Fetch through the router behind `#inflight`, an explicit promise handle: input gates do
 *      not cover an `await` on `fetch`, so a `subscribe` or `forceRefresh` arriving mid-fetch
 *      awaits the same promise. The adapter is resolved INSIDE the try, so a configuration
 *      error is a zero-cost error record and one ops alert, not a failed alarm; every provider
 *      request carries `AbortSignal.timeout(PROVIDER_FETCH_TIMEOUT_MS)`, so the handle lives at
 *      most about 30 seconds. Every provider error becomes an error `ProviderCallRecord` at zero
 *      cost; only a storage error throws (and is retried by the platform).
 *   4. A second `transactionSync` applies the result: `reconcileFlightKey` (drift is an event,
 *      never a rename; `different_flight` stops polling), the snapshot with a monotonically
 *      increasing `version`, the events rows, the outbox rows, and (increment 15) the
 *      notification policy's state with one `notify_intent` outbox row per intent, each guarded
 *      by `notif_dedupe`. A re-read the policy owes (a delay's settle, a cancellation's or a
 *      diversion's confirmation) moves the next alarm to at most 5 minutes out, and a suspected
 *      cancellation never finishes the tracker before its re-read confirms it (rulings N2, N4,
 *      N7; `#policySchedule`).
 *   5. After the commit: send the outbox to the `persist` queue in byte-chunked batches, and
 *      write the debounced KV snapshot off the critical path. A write the debounce suppressed is
 *      marked pending and performed by the next entry point once the gap has passed.
 *
 * Every path that learns the flight is done (the alarm, a user refresh, a reconcile poll, a
 * merged alert, a re-seed) runs the same finish path: flush, archive the events to R2 under a
 * per-lifetime key (`events/{key}@{epochMs}.json`, never overwritten), set phase `finished`,
 * write the final KV snapshot itself, and arm one alarm 22 hours out. That alarm calls
 * `deleteAll()` ONLY once the outbox is empty, every row confirmed; while rows remain it re-arms
 * hourly, bounded by nothing but the rows draining, and raises the ops alert once after the sixth
 * deferral. Every message the persist consumer acknowledges is confirmed, an unreadable one
 * included (by origin and seq); the dead-letter consumer confirms nothing and instead reports a
 * dead-lettered row (`confirmPersisted` with `deadLettered`), which is stamped, kept and re-sent
 * after a spacing that doubles per dead-lettering (an hour, capped at a day), so a persist outage
 * longer than the queue's retry window heals on the first re-send after recovery while a poison
 * row is a decaying stream of dead-letter events under the same stuck alert. The hourly retry
 * therefore covers rows that never reached the queue and rows the queue could not deliver. The
 * finish alarm's due time is derived (the finish
 * instant plus 22 hours plus an hour per deferral): a delivery that arrives before it, such as
 * the cadence alarm already in flight while a user refresh finished the flight, re-asserts that
 * time and counts nothing. A finish reason of `arrived` means the cadence's tail poll after
 * arrival ran (the cadence module is normative); a hard-capped flight finishes with `hard_cap`
 * unless its one reconciliation poll saw it in.
 *
 * Rows written are a budgeted number (ruling J5): every statement runs through `#exec`, which
 * sums the cursor's `rowsRead` and `rowsWritten`; each `setAlarm` adds one; the migration DDL an
 * object pays for at creation is added from the runner; the totals are stored on the alarm's
 * `attempts` row and the lifecycle test asserts a full A2 walk stays under
 * `ROWS_WRITTEN_BUDGET_PER_FLIGHT`. Persist confirmations are charged to the tracker: they are
 * its rows.
 *
 * Outbox rows are deleted only when the persist consumer confirms them (`confirmPersisted`);
 * there is no `confirmed_at` column, deletion IS the confirmation, a sent row unconfirmed for
 * longer than `OUTBOX_RESEND_GRACE_MS` is re-sent by the next flush, and a row the dead-letter
 * consumer stamped waits `deadLetterResendSpacingMs` of its count instead (migration 002). A row
 * over the single-message limit is never sent: it is dropped with an `outbox_oversize` event.
 * `deleteAll()` is never called inside a transaction, there is no `setAlarm` in the constructor,
 * no timer of any kind in this module (the one in-request wait is `scheduler.wait` in the finish
 * path, bounded by the KV per-key gap), no `blockConcurrencyWhile` outside the migration run. An
 * object that exists but holds no flight (probed, or finished and deleted) answers `absent` and
 * arms a 60 s cleanup.
 *
 * Test seams (`outboxSink`, `kv`, `bucket`, `providerDeps`, `caps`, `providerFetchTimeoutMs`,
 * `capture`, `flushStats`, the row meters) are public fields set through `runInDurableObject`,
 * never over RPC; production never touches them.
 *
 * Never opens Postgres (ADR 0007). Every write leaves through the outbox.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  A2_HARD_CAP_PE,
  A2_SOFT_CAP_PE,
  CADENCES,
  CONFIRM_REREAD_MINUTES,
  ConfirmPersistedRequestV1,
  ForceRefreshRequestV1,
  FlightStatusSchema,
  FREE_TIER_LIMITS,
  INFLIGHT_STALE_MS,
  InjectPolicyEventRequestV1,
  ListSubscribersRequestV1,
  ProviderEventV1,
  RPC_SCHEMA_VERSION,
  RpcRequestError,
  SeedRequestV1,
  SubscribeRequestV1,
  USER_REFRESH_FRESHNESS_MS,
  UnsubscribeRequestV1,
  deadLetterResendSpacingMs,
  evaluatePolicy,
  evaluateReread,
  flightTrackerOrigin,
  initialPolicyState,
  isIntervalWindow,
  parseDesignator,
  parseFlightKey,
  parseRpcRequest,
  policyWants,
  pollEquivalents,
  readPolicyState,
  reconcileFlightKey,
  refreshIntervalFor,
  windowAt,
  type CadenceContext,
  type CadenceDefinition,
  type CadenceSource,
  type ConfirmPersistedResponseV1,
  type Exact,
  type FlightEventOutboxPayloadV1,
  type FlightInstanceOutboxPayloadV1,
  type FlightKey,
  type FlightStatus,
  type FlightTrackingState,
  type ForceRefreshResponseV1,
  type GetCostLedgerResponseV1,
  type GetStateResponseV1,
  type HealthResponseV1,
  type IngestProviderEventResponseV1,
  type InjectPolicyEventResponseV1,
  type ListSubscribersResponseV1,
  type NotifyFlightSummaryV1,
  type NotifyIntentV1Input,
  type PolicyIntent,
  type PolicyResult,
  type PolicyState,
  type ProviderCallContext,
  type ProviderCallRecord,
  type ProviderCallTrigger,
  type ProviderId,
  type SeedResponseV1,
  type SubscribeResponseV1,
  type TrackerHealthPhase,
  type TrackerPhase,
  type UnsubscribeResponseV1,
} from '@planeahead/shared';
import type { Env } from '../env';
import {
  writeSnapshotKv,
  SNAPSHOT_KV_DEBOUNCE_MS,
  SNAPSHOT_KV_MIN_GAP_MS,
  type SnapshotKvValue,
} from '../kv/snapshot';
import { createLogger, errorFields, type Logger } from '../observability/log';
import { raiseOpsAlert, type CaptureMessage } from '../observability/ops-alert';
import { mergeAeroApiAlert, type AeroApiAlertPatch } from '../providers/aeroapi.mock';
import { perFlightLedgerDecision } from '../providers/budget';
import { providerSettings } from '../providers/config';
import { DurableObjectCostLogger, PROVIDER_CALL_OUTBOX_KIND } from '../providers/cost-log';
import { callRecord, type ProviderFetch } from '../providers/http';
import {
  ProviderConfigError,
  aeroApiAllowedAt,
  budgetGuardFor,
  providerFor,
  type RouterDeps,
  type RoutingInstant,
} from '../providers/router';
import { eventsArchiveKey, putJsonArchiveIfAbsent } from '../r2/archive';
import { type DurableObjectPing, blockOnMigrations } from './base';
import { cadenceContextFor, FIXED_SLOT_TIER_MS_DEFAULT } from './cadence-context';
import {
  EMPTY_MIGRATION_RESULT,
  type MigrationResult,
  type SqlMigrations,
  runSqlMigrations,
} from './migrate';
import { FLIGHT_TRACKER_MIGRATION_001 } from './migrations/flight-tracker/001';
import { FLIGHT_TRACKER_MIGRATION_002 } from './migrations/flight-tracker/002';
import { FLIGHT_TRACKER_MIGRATION_003 } from './migrations/flight-tracker/003';
import { chunkOutbox, forEachBindChunk, markOutboxSent, sendOutboxChunks } from './outbox';

// ---------------------------------------------------------------------------------------------
// Constants. Every one is a design number from the spec, the facts sheet or a review ruling.
// ---------------------------------------------------------------------------------------------

/**
 * Rows written over one flight's life (creation to `deleteAll()`), the budget the lifecycle
 * test holds a full A2 walk under. Measured on 2026-09-23 after the final re-review round
 * (test/workers/flight-tracker.lifecycle, printed as `[lifecycle] ... rows_written_lifetime=`):
 * 1,203 rows for the whole life of an on-time flight created at T-48 h, everything included (the
 * schema DDL at creation, the seed, two subscribes, 74 alarms at 13 rows each when nothing
 * changed, the persist confirmations, which are charged to the tracker because they are its
 * rows, the finish path with its final KV write and the +22 h deletion; 16.3 rows per alarm on
 * average once everything else is spread over them; the same walk measured 1,200 before
 * migration 002's two `ALTER TABLE` statements and its id row, and 1,173 before the DDL was
 * counted at all). The budget is that with about a third of headroom for a delayed flight's extra
 * events (two rows each), and it moves only deliberately: rows written are 70 to 85 percent of
 * the per-flight Durable Object cost. Increment 15 measured 1,205 for the same walk: migration
 * 003's `ALTER TABLE` and its id row; the policy state rides on the flight row's existing writes,
 * so an alarm writes no more rows than before, and a notify intent costs three (its
 * `notif_dedupe` row, its outbox row and the confirmation that deletes it).
 */
export const ROWS_WRITTEN_BUDGET_PER_FLIGHT = 1_600;

/** At this many platform retries the handler re-arms and returns (ruling J2 step 2, L16). */
export const RETRY_LADDER_MAX = 5;
export const RETRY_BACKSTOP_MS = 30_000;
/** The finished object's last alarm, which calls `deleteAll()` once the outbox is empty. */
export const FINISH_ALARM_MS = 22 * 60 * 60_000;
/** A finished object whose outbox has not drained re-arms this often, without bound (L2). */
export const FINISH_RETRY_MS = 60 * 60_000;
/** The deferral after which the finished object raises the ops alert, once (L2). */
export const FINISH_ALERT_AFTER_ATTEMPTS = 6;
/** An alarm that fires more than this early is a duplicate delivery and only re-arms. */
const EARLY_ALARM_TOLERANCE_MS = 5_000;
/**
 * A sent row is re-sent by the next flush when it has been unconfirmed this long. Confirmation
 * normally lands within seconds; the grace keeps a burst of coalesced user refreshes from
 * re-sending rows whose acknowledgement is still in flight. A row the dead-letter consumer
 * stamped is not on this rule: it waits `deadLetterResendSpacingMs` of its count
 * (`deadLetterResendDue`).
 */
export const OUTBOX_RESEND_GRACE_MS = 10_000;
/**
 * Per user, per flight, per UTC day (ruling J8). Charged only when a provider call is made. The
 * number is the shared free-tier limit (increment 8, ruling K3), the same one the refresh route's
 * `usage_counters` sub-budget enforces in front of the object.
 */
export const USER_REFRESH_DAILY_CAP = FREE_TIER_LIMITS.refreshesPerFlightPerDay;
/**
 * Every provider request the tracker makes carries this timeout (ruling L3): a timer scoped to
 * one request inside a running alarm, not a pending object timer. A timed-out fetch is the
 * adapter's transport record (billed, reservation kept, as increment 6 rules).
 */
export const PROVIDER_FETCH_TIMEOUT_MS = 30_000;
/** An object that exists but holds no flight (probed, or finished and deleted) cleans up. */
const ABSENT_CLEANUP_MS = 60_000;
/** The tier interval assumed for a fixed-slot window when deciding whether a slot is fresh. */
const FIXED_SLOT_TIER_MS = FIXED_SLOT_TIER_MS_DEFAULT;
/**
 * A due policy re-read (N2 settle, N4 confirmation) whose read failed is tried again this much
 * later: the policy's own confirmation spacing, never at once.
 */
export const POLICY_REREAD_RETRY_MS = CONFIRM_REREAD_MINUTES * 60_000;

// ---------------------------------------------------------------------------------------------
// Row shapes.
// ---------------------------------------------------------------------------------------------

type Row = Record<string, string | number | ArrayBuffer | null>;

interface FlightRow extends Row {
  key: string;
  cadence: string;
  phase: string;
  version: number;
  snapshot: string;
  search_designator: string | null;
  scheduled_out_ms: number | null;
  scheduled_in_ms: number | null;
  estimated_in_ms: number | null;
  actual_off_ms: number | null;
  actual_on_ms: number | null;
  actual_in_ms: number | null;
  next_refresh_at_ms: number | null;
  attempt_slot_ms: number | null;
  operator_source: string | null;
  polling_stopped: number;
  stop_reason: string | null;
  reconcile_poll_done: number;
  provider_call_count: number;
  provider_cost_units: number;
  last_refreshed_at_ms: number | null;
  finished_at_ms: number | null;
  finish_reason: string | null;
  finish_alarm_attempts: number;
  events_r2_key: string | null;
  created_at_ms: number;
  /** The notification policy's `PolicyState` as JSON (migration 003); NULL before it. */
  policy_state: string | null;
}

interface BudgetRow extends Row {
  scheduled_pe: number;
  user_refresh_pe: number;
  calls: number;
  soft_cap_pe: number;
  hard_cap_pe: number;
  stretched: number;
  hard_cap_hit: number;
  by_trigger: string;
}

interface OutboxRow extends Row {
  seq: number;
  payload: string;
  sent_at_ms: number | null;
  /** Times the persist queue dead-lettered the row (migration 002). */
  dead_letter_count: number;
  last_dead_lettered_at_ms: number | null;
}

interface EventRow extends Row {
  seq: number;
  occurred_at_ms: number;
  type: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  source: string;
  provider_call_id: string | null;
}

interface CountRow extends Row {
  n: number;
}

interface SubscriberListRow extends Row {
  subscription_id: string;
  user_id: string;
  created_at_ms: number;
}

interface DebounceRow extends Row {
  last_write_at_ms: number;
  pending: number;
}

/** What one alarm or refresh writes and reads, summed by `#exec`. */
export interface RowCounters {
  read: number;
  written: number;
}

/** What the last flush sent, for the tests that record the observed chunk sizes. */
export interface FlushStats {
  readonly batches: number;
  readonly messages: number;
  readonly maxMessagesPerBatch: number;
  readonly maxBytesPerBatch: number;
  readonly maxMessageBytes: number;
}

const NO_FLUSH: FlushStats = Object.freeze({
  batches: 0,
  messages: 0,
  maxMessagesPerBatch: 0,
  maxBytesPerBatch: 0,
  maxMessageBytes: 0,
});

/** The per-flight caps, in poll equivalents (ruling L4); a test seam lowers them. */
export interface PerFlightCaps {
  readonly softCapPe: number;
  readonly hardCapPe: number;
}

/** An outbox row before `seq` and `origin` are added at send time. */
type OutboxDraft =
  | { kind: 'flight_instance'; flightKey: FlightKey; payload: FlightInstanceOutboxPayloadV1 }
  | { kind: 'flight_event'; flightKey: FlightKey; payload: FlightEventOutboxPayloadV1 }
  | { kind: typeof PROVIDER_CALL_OUTBOX_KIND; flightKey: FlightKey; payload: ProviderCallRecord }
  | { kind: 'notify_intent'; flightKey: FlightKey; payload: NotifyIntentV1Input };

/** Where a stored observation came from: the tracker's own provider read, an alert merge, a seed. */
type ObservationSource = 'read' | 'merge' | 'seed';

/** One intent as written (or, for a replayed key, not written) through the outbox (N7). */
interface WrittenIntent {
  readonly intent: PolicyIntent;
  readonly dedupeKey: string;
  readonly written: boolean;
}

/** The optional `FlightStatus` fields a push renders (`NotifyFlightSummaryV1`). */
const SUMMARY_OPTIONAL_FIELDS = [
  'marketingCarrierIcao',
  'marketingFlightNumber',
  'actualDestination',
  'originTerminal',
  'originGate',
  'destinationTerminal',
  'destinationGate',
  'baggageClaim',
] as const;

/** The flight as an intent's push renders it: the observed snapshot, trimmed (N9). */
function flightSummary(status: FlightStatus): NotifyFlightSummaryV1 {
  const summary: Record<string, unknown> = {
    operatingCarrierIcao: status.operatingCarrierIcao,
    flightNumber: status.flightNumber,
    origin: status.origin,
    destination: status.destination,
    status: status.status,
    times: status.times,
  };
  for (const field of SUMMARY_OPTIONAL_FIELDS) {
    if (status[field] !== undefined) {
      summary[field] = status[field];
    }
  }
  return summary as NotifyFlightSummaryV1;
}

interface EventDraft {
  readonly type: string;
  readonly field?: string | undefined;
  readonly oldValue?: unknown;
  readonly newValue?: unknown;
  readonly source: string;
  readonly providerCallId?: string | undefined;
}

type FinishReason =
  'arrived' | 'cancelled' | 'lifetime' | 'key_drift' | 'hard_cap' | 'unschedulable' | 'exhausted';

/** The call step 1 expects to make: the cadence source, who answers it, and what it costs. */
interface ExpectedCall {
  readonly source: CadenceSource;
  readonly provider: ProviderId;
  readonly expectedPe: number;
}

/** What step 1 decided; the rest of the alarm only executes it. */
type AlarmPlan =
  | { readonly kind: 'cleanup' }
  | { readonly kind: 'finish_alarm' }
  /** The retry ladder in a finish or cleanup path: re-armed `FINISH_RETRY_MS` out. */
  | { readonly kind: 'deferred'; readonly path: 'cleanup' | 'finish_alarm' }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'rearm'; readonly at: number }
  /** A retry after a committed step 1: resend the outbox and resume the committed plan. */
  | { readonly kind: 'skip_io'; readonly slot: number }
  /** A slot a recent refresh already answered: rescheduled without a call (L14). */
  | { readonly kind: 'satisfied'; readonly slot: number }
  | { readonly kind: 'stopped'; readonly slot: number }
  | { readonly kind: 'finish'; readonly reason: FinishReason }
  | {
      readonly kind: 'poll';
      readonly slot: number;
      readonly trigger: ProviderCallTrigger;
      readonly call: ExpectedCall;
      /** True when no slot follows this one: finish after applying the result. */
      readonly finishAfter: boolean;
    };

interface FetchResult {
  /** The status that names this flight, or null on a miss or an error. */
  readonly status: Exact<FlightStatus> | null;
  /** Every record the call produced (the adapter's own attempts plus the returned one). */
  readonly records: ProviderCallRecord[];
  readonly expectedPe: number;
  readonly trigger: ProviderCallTrigger;
}

interface ApplyOutcome {
  readonly version: number;
  readonly changed: boolean;
  readonly finish: FinishReason | null;
}

const SNAPSHOT_FIELDS = [
  'originGate',
  'destinationGate',
  'originTerminal',
  'destinationTerminal',
  'baggageClaim',
  'registration',
  'aircraftTypeIcao',
] as const;

const EVENT_TYPE_BY_FIELD: Readonly<Record<(typeof SNAPSHOT_FIELDS)[number], string>> = {
  originGate: 'gate_changed',
  destinationGate: 'gate_changed',
  originTerminal: 'terminal_changed',
  destinationTerminal: 'terminal_changed',
  baggageClaim: 'baggage_changed',
  registration: 'aircraft_changed',
  aircraftTypeIcao: 'aircraft_changed',
};

const TIME_FIELDS_WATCHED = [
  'scheduledOut',
  'estimatedOut',
  'actualOut',
  'scheduledOff',
  'estimatedOff',
  'actualOff',
  'scheduledOn',
  'estimatedOn',
  'actualOn',
  'scheduledIn',
  'estimatedIn',
  'actualIn',
] as const;

function cadenceById(id: string): CadenceDefinition {
  const found = CADENCES.find((cadence) => cadence.id === id);
  if (found === undefined) {
    throw new Error(`unknown cadence ${id}`);
  }
  return found;
}

function ms(instant: string | undefined): number | null {
  if (instant === undefined) {
    return null;
  }
  const value = Date.parse(instant);
  return Number.isNaN(value) ? null : value;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * Whether a row the dead-letter consumer stamped is due for a re-send: its spacing
 * (`deadLetterResendSpacingMs`, doubling per dead-lettering) has passed since the later of its
 * last dead-lettering and its last send. The send term keeps a flush inside the consumer's retry
 * window (the minute between a re-send and its next dead-lettering) from sending the row twice.
 */
function deadLetterResendDue(row: OutboxRow, now: number): boolean {
  const since = Math.max(row.sent_at_ms ?? 0, row.last_dead_lettered_at_ms ?? 0);
  return now - since >= deadLetterResendSpacingMs(row.dead_letter_count);
}

/** JSON with object keys sorted at every level, so key order never reads as a change. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The snapshot, canonically serialised with `fetchedAt` removed, for the "did anything change"
 * comparison: a stored snapshot comes back from the schema in the schema's key order, a fresh
 * one in the adapter's, and `fetchedAt` moves on every poll.
 */
function withoutFetchedAt(status: FlightStatus): string {
  const rest: Record<string, unknown> = { ...status };
  delete rest['fetchedAt'];
  return canonicalJson(rest);
}

function trackingStateFor(phase: string): FlightTrackingState {
  switch (phase) {
    case 'finished':
      return 'finished';
    case 'departed':
    case 'en_route':
    case 'diverted':
      return 'airborne';
    case 'landed':
    case 'arrived':
      return 'landed';
    default:
      return 'tracking';
  }
}

function operationFor(provider: ProviderId): string {
  return provider === 'aeroapi' ? 'flight_by_id' : 'flight_status';
}

/**
 * Who the router WILL answer a window with, computed without constructing an adapter: the
 * router's two rules (AeroDataBox answers everything in `mock` mode; zero AeroAPI calls before
 * T-48 h) restated so step 1 can price the call before step 3 resolves the adapter inside its
 * try (ruling L17). `#adjustDebit` reconciles the expected cost with the recorded one.
 */
function expectedProviderFor(source: CadenceSource, env: Env, at: RoutingInstant): ProviderId {
  if (source === 'aerodatabox' || providerSettings(env).aeroapiMode === 'mock') {
    return 'aerodatabox';
  }
  return aeroApiAllowedAt(at) ? 'aeroapi' : 'aerodatabox';
}

/** Field-level differences between two snapshots, as event drafts. */
function diffSnapshots(
  previous: FlightStatus,
  next: FlightStatus,
  source: string,
  providerCallId: string | undefined,
): EventDraft[] {
  const drafts: EventDraft[] = [];
  const push = (type: string, field: string, oldValue: unknown, newValue: unknown): void => {
    if (oldValue !== newValue) {
      drafts.push({ type, field, oldValue, newValue, source, providerCallId });
    }
  };
  push('status_changed', 'status', previous.status, next.status);
  for (const field of TIME_FIELDS_WATCHED) {
    push('time_changed', field, previous.times[field], next.times[field]);
  }
  for (const field of SNAPSHOT_FIELDS) {
    push(EVENT_TYPE_BY_FIELD[field], field, previous[field], next[field]);
  }
  push('destination_changed', 'destination', previous.destination.icao, next.destination.icao);
  push(
    'destination_changed',
    'actualDestination',
    previous.actualDestination?.icao,
    next.actualDestination?.icao,
  );
  return drafts;
}

/** The marketing designator a lookup is made with (`AA100`), from the seed or the snapshot. */
function lookupDesignator(
  row: FlightRow,
  snapshot: FlightStatus,
): { code: string; number: string } {
  if (row.search_designator !== null) {
    try {
      const parsed = parseDesignator(row.search_designator);
      const code = parsed.carrier.iata ?? parsed.carrier.icao;
      if (code !== undefined) {
        return { code, number: `${parsed.number}${parsed.suffix ?? ''}` };
      }
    } catch {
      // fall through to the snapshot's own designator
    }
  }
  return {
    code: snapshot.marketingCarrierIcao ?? snapshot.operatingCarrierIcao,
    number: snapshot.marketingFlightNumber ?? snapshot.flightNumber,
  };
}

export class FlightTracker extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 3;

  /** Append only, in order. Index 0 is migration id 1. */
  static readonly MIGRATIONS: SqlMigrations = [
    FLIGHT_TRACKER_MIGRATION_001,
    FLIGHT_TRACKER_MIGRATION_002,
    FLIGHT_TRACKER_MIGRATION_003,
  ];

  /**
   * Test seams, set through `runInDurableObject` and never over RPC: where the outbox is sent,
   * where the KV snapshot and the R2 archive go, the router's adapter overrides (a throwing
   * provider, for the retries test), the per-flight caps, the provider fetch timeout and the
   * Sentry capture behind the ops alert. Production never touches them.
   */
  outboxSink: Pick<Queue, 'sendBatch'>;
  kv: Pick<KVNamespace, 'put'>;
  bucket: Pick<R2Bucket, 'put'>;
  providerDeps: RouterDeps = {};
  caps: PerFlightCaps = { softCapPe: A2_SOFT_CAP_PE, hardCapPe: A2_HARD_CAP_PE };
  providerFetchTimeoutMs = PROVIDER_FETCH_TIMEOUT_MS;
  capture: CaptureMessage | undefined = undefined;
  /** What the last flush sent; read by the lifecycle test for the observed chunk sizes. */
  flushStats: FlushStats = NO_FLUSH;
  /** Rows written by this in-memory instance over its life, every entry point included. */
  rowsWrittenLifetime = 0;
  rowsReadLifetime = 0;

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;
  readonly #log: Logger;
  #testClockMs: number | null = null;
  #inflight: Promise<ApplyOutcome> | null = null;
  #inflightSince: number | null = null;
  #finishing: Promise<void> | null = null;
  #counters: RowCounters = { read: 0, written: 0 };
  #seqAlloc: { next: number; dirty: boolean } | null = null;
  /** What the alarm's `attempts` row is finally marked with; written by `#recordAttempt`. */
  #attemptOutcome: { outcome: string; providerCallId: string | null } | null = null;
  #deleted = false;
  #cleanupArmed = false;
  #kvInFlight: Promise<void> | null = null;
  /** `#outInstants`' memo: the snapshot text it last parsed and the out instants in it. */
  #outMemo: { snapshot: string; estimatedOutMs: number | null; actualOutMs: number | null } | null =
    null;
  /** Configuration errors already alerted by this in-memory instance (once each). */
  readonly #configAlerted = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#log = createLogger({ durable_object: 'FlightTracker', name: ctx.id.name ?? 'unnamed' });
    this.outboxSink = env.PERSIST_QUEUE;
    this.kv = env.CACHE;
    this.bucket = env.PRIVATE_BUCKET;
    blockOnMigrations(ctx, FlightTracker.MIGRATIONS, (result) => {
      this.#schema = result;
      this.rowsWrittenLifetime += result.rowsWritten;
    });
  }

  // -------------------------------------------------------------------------------------------
  // RPC surface. Every payload goes through `parseRpcRequest` (ruling J8).
  // -------------------------------------------------------------------------------------------

  /** Liveness and schema probe. Cheap, does no I/O, and creates the object if it did not exist. */
  ping(): DurableObjectPing {
    return {
      className: 'FlightTracker',
      schemaVersion: FlightTracker.SCHEMA_VERSION,
      appliedVersion: this.#schema.version,
      applied: this.#schema.applied,
    };
  }

  /**
   * Test seam: replaces the clock every decision reads. Refused unless the `TEST_CLOCK` binding
   * is `true`, which only test/globalSetup.ts sets.
   */
  _setClock(ms: number | null): void {
    if (this.env.TEST_CLOCK !== 'true') {
      throw new RpcRequestError(
        'invalid_request',
        '_setClock is a test seam (TEST_CLOCK is not set)',
      );
    }
    this.#testClockMs = ms;
  }

  /**
   * Creates the tracker from a status the DesignatorResolver fetched (ruling J9). The instance
   * row goes into the outbox BEFORE the creation event, so the first batch the persist consumer
   * sees carries the row the event needs. Idempotent: a re-seed applies a fresher status as an
   * update (and finishes the flight when that status says it is over), ignores an older one.
   */
  async seed(input: unknown): Promise<Exact<SeedResponseV1>> {
    const request = parseRpcRequest(SeedRequestV1, input);
    this.#ensureSchema();
    await this.#awaitFinishing();
    await this.#awaitInflight();
    const now = this.#now();
    const key = request.flightKey;
    const status: FlightStatus = { ...request.status, key };
    let finishAfter: FinishReason | null = null;
    const response = this.#tx((): Exact<SeedResponseV1> => {
      const existing = this.#flight();
      if (existing !== null) {
        const stored = this.#snapshotOf(existing);
        if (existing.phase === 'finished') {
          return this.#seedResponse('finished', existing);
        }
        const incoming = ms(status.fetchedAt) ?? 0;
        const current = ms(stored.fetchedAt) ?? 0;
        if (incoming <= current) {
          return this.#seedResponse(incoming < current ? 'stale' : 'already', existing);
        }
        const applied = this.#applyStatus(
          existing,
          stored,
          status,
          now,
          request.trigger,
          undefined,
          'seed',
        );
        finishAfter = applied.finish;
        const updated = this.#flight();
        return this.#seedResponse('already', updated ?? existing);
      }
      const cadence = cadenceById(request.cadence);
      this.#exec(
        `INSERT INTO flight (id, key, cadence, phase, version, snapshot, search_designator,
                             scheduled_out_ms, scheduled_in_ms, estimated_in_ms, actual_off_ms,
                             actual_on_ms, actual_in_ms, operator_source, created_at_ms,
                             updated_at_ms, policy_state)
         VALUES (1, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        key,
        cadence.id,
        status.status,
        JSON.stringify(status),
        request.designator ?? null,
        ms(status.times.scheduledOut),
        ms(status.times.scheduledIn),
        ms(status.times.estimatedIn),
        ms(status.times.actualOff),
        ms(status.times.actualOn),
        ms(status.times.actualIn),
        status.operatorSource ?? null,
        now,
        now,
        // Seeded, never evaluated: the creation snapshot is what the subscribers already know.
        JSON.stringify(initialPolicyState(status)),
      );
      this.#exec(
        'INSERT INTO budget (id, flight_id, soft_cap_pe, hard_cap_pe) VALUES (1, 1, ?, ?)',
        this.caps.softCapPe,
        this.caps.hardCapPe,
      );
      this.#exec('INSERT INTO kv_debounce (id, flight_id) VALUES (1, 1)');
      const row = this.#requireFlight();
      const next = this.#schedule(row, now);
      if (next.finish !== null) {
        // Nothing left to poll (the flight already arrived, or was cancelled): straight to the
        // finish path once this transaction commits.
        this.#exec('UPDATE flight SET next_refresh_at_ms = NULL WHERE id = 1');
        finishAfter = next.finish;
      } else {
        this.#exec('UPDATE flight SET next_refresh_at_ms = ? WHERE id = 1', next.at);
        this.#setAlarm(next.at);
      }
      const seeded = this.#requireFlight();
      this.#appendInstance(seeded, now);
      this.#appendEvent(seeded, now, {
        type: 'created',
        field: 'trigger',
        newValue: request.trigger,
        source: 'system',
      });
      return this.#seedResponse('seeded', seeded);
    });
    if (finishAfter !== null) {
      await this.#finish(now, finishAfter);
      return { ...response, phase: 'finished', nextRefreshAt: null };
    }
    await this.#flushOutbox(now);
    this.#scheduleKv(now);
    return response;
  }

  async subscribe(input: unknown): Promise<Exact<SubscribeResponseV1>> {
    const request = parseRpcRequest(SubscribeRequestV1, input);
    this.#ensureSchema();
    await this.#awaitFinishing();
    // A fetch in flight is joined, never raced: the answer carries the fresh snapshot.
    await this.#awaitInflight();
    const now = this.#now();
    const row = this.#flight();
    if (row === null) {
      this.#armAbsentCleanup(now);
      throw new RpcRequestError(
        'invalid_request',
        'tracker is not seeded: resolve the flight first',
      );
    }
    if (row.phase === 'finished') {
      return {
        rpcVersion: RPC_SCHEMA_VERSION,
        status: 'archived',
        flightKey: row.key as FlightKey,
      };
    }
    const status = this.#tx((): 'subscribed' | 'already' => {
      const before = this.#count('subscribers');
      this.#exec(
        `INSERT INTO subscribers (subscription_id, flight_id, user_id, muted, overrides, created_at_ms)
         VALUES (?, 1, ?, ?, ?, ?) ON CONFLICT (subscription_id) DO NOTHING`,
        request.subscriptionId,
        request.userId,
        request.muted === true ? 1 : 0,
        request.overrides === undefined ? null : JSON.stringify(request.overrides),
        now,
      );
      return this.#count('subscribers') > before ? 'subscribed' : 'already';
    });
    this.#scheduleKv(now, false);
    const current = this.#requireFlight();
    return {
      rpcVersion: RPC_SCHEMA_VERSION,
      status,
      flightKey: current.key as FlightKey,
      snapshotEtag: String(current.version),
      version: current.version,
      snapshot: this.#snapshotOf(current),
    };
  }

  unsubscribe(input: unknown): Exact<UnsubscribeResponseV1> {
    const request = parseRpcRequest(UnsubscribeRequestV1, input);
    this.#ensureSchema();
    if (this.#flight() === null) {
      this.#armAbsentCleanup(this.#now());
      return { rpcVersion: RPC_SCHEMA_VERSION, status: 'absent', subscriberCount: 0 };
    }
    const status = this.#tx((): 'unsubscribed' | 'absent' => {
      const before = this.#count('subscribers');
      this.#exec('DELETE FROM subscribers WHERE subscription_id = ?', request.subscriptionId);
      return this.#count('subscribers') < before ? 'unsubscribed' : 'absent';
    });
    return { rpcVersion: RPC_SCHEMA_VERSION, status, subscriberCount: this.#count('subscribers') };
  }

  /**
   * The subscriber list (increment 12, the one Durable Object change of that increment): every
   * entry's subscription id, the user id it was stored under and when it was written, for the
   * housekeeping reconciliation that makes this list follow Postgres. Read only; `rpcVersion`
   * unchanged (the method is new, nothing else moved). A tracker that holds no flight answers
   * phase `absent` with an empty list and arms its cleanup, like `unsubscribe`.
   */
  listSubscribers(input: unknown = {}): Exact<ListSubscribersResponseV1> {
    parseRpcRequest(ListSubscribersRequestV1, input);
    this.#ensureSchema();
    const row = this.#flight();
    if (row === null) {
      this.#armAbsentCleanup(this.#now());
      return { rpcVersion: RPC_SCHEMA_VERSION, flightKey: null, phase: 'absent', subscribers: [] };
    }
    const subscribers = this.#exec<SubscriberListRow>(
      `SELECT subscription_id, user_id, created_at_ms FROM subscribers
       ORDER BY created_at_ms, subscription_id`,
    ).map((entry) => ({
      subscriptionId: entry.subscription_id,
      userId: entry.user_id,
      createdAtMs: entry.created_at_ms,
    }));
    return {
      rpcVersion: RPC_SCHEMA_VERSION,
      flightKey: row.key as FlightKey,
      phase: row.phase as TrackerHealthPhase,
      subscribers,
    };
  }

  getState(): Exact<GetStateResponseV1> {
    this.#ensureSchema();
    const row = this.#flight();
    if (row === null) {
      this.#armAbsentCleanup(this.#now());
      throw new RpcRequestError('invalid_request', 'tracker is not seeded');
    }
    return {
      rpcVersion: RPC_SCHEMA_VERSION,
      flightKey: row.key as FlightKey,
      phase: row.phase as TrackerPhase,
      snapshot: this.#snapshotOf(row),
      nextRefreshAt: iso(row.next_refresh_at_ms),
      doSchemaVersion: this.#schema.version,
      subscriberCount: this.#count('subscribers'),
      version: row.version,
    };
  }

  /**
   * A refresh outside the cadence: a user's pull-to-refresh, the reconcile cron re-arming an
   * abandoned tracker, or an operator. Coalesced twice over (ruling L15): onto a fetch in
   * flight, and onto a snapshot younger than `USER_REFRESH_FRESHNESS_MS`; neither charges the
   * user's daily cap, which is charged only when this call makes the provider call. A user
   * refresh is denied when the flight's ledger is at its hard cap. A reconcile refresh abandons
   * an in-flight handle older than `INFLIGHT_STALE_MS` (a hung promise, ruling L3). When the
   * answer says the flight is done, the finish path runs here exactly as it does in the alarm.
   */
  async forceRefresh(input: unknown): Promise<Exact<ForceRefreshResponseV1>> {
    const request = parseRpcRequest(ForceRefreshRequestV1, input);
    this.#ensureSchema();
    await this.#awaitFinishing();
    const now = this.#now();
    const row = this.#flight();
    if (row === null) {
      this.#armAbsentCleanup(now);
      return this.#refreshResponse('skipped', 'absent');
    }
    if (row.phase === 'finished') {
      return this.#refreshResponse('skipped', 'finished');
    }
    if (this.#inflight !== null) {
      const age = this.#inflightSince === null ? 0 : now - this.#inflightSince;
      if (request.reason === 'reconcile' && age >= INFLIGHT_STALE_MS) {
        this.#log.error('flight_tracker_inflight_abandoned', { age_ms: age });
        this.#inflight = null;
        this.#inflightSince = null;
      } else {
        await this.#awaitInflight();
        return this.#refreshResponse('coalesced', 'inflight');
      }
    }
    if (request.reason === 'user_refresh') {
      const userId = request.userId;
      if (userId === undefined) {
        throw new RpcRequestError('invalid_request', 'user_refresh needs a userId');
      }
      if (
        row.last_refreshed_at_ms !== null &&
        now - row.last_refreshed_at_ms < USER_REFRESH_FRESHNESS_MS
      ) {
        this.#scheduleKv(now, false);
        return this.#refreshResponse('coalesced', 'fresh');
      }
      const budget = this.#budget();
      const call = this.#expectedCall(row, now);
      const decision = perFlightLedgerDecision({
        spentPe: budget.scheduled_pe + budget.user_refresh_pe,
        requestPe: call.expectedPe,
        softCapPe: budget.soft_cap_pe,
        hardCapPe: budget.hard_cap_pe,
      });
      if (budget.hard_cap_hit === 1 || decision === 'hard_cap') {
        return this.#refreshResponse('denied', 'hard_cap');
      }
      const day = new Date(now).toISOString().slice(0, 10);
      const allowed = this.#tx((): boolean => {
        const used =
          this.#exec<CountRow>(
            'SELECT count AS n FROM user_refresh WHERE user_id = ? AND day = ?',
            userId,
            day,
          )[0]?.n ?? 0;
        if (used >= USER_REFRESH_DAILY_CAP) {
          return false;
        }
        this.#exec(
          `INSERT INTO user_refresh (user_id, day, flight_id, count) VALUES (?, ?, 1, 1)
           ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1`,
          userId,
          day,
        );
        return true;
      });
      if (!allowed) {
        return this.#refreshResponse('denied', 'user_refresh_cap');
      }
    }
    const trigger: ProviderCallTrigger =
      request.reason === 'user_refresh'
        ? 'user_refresh'
        : request.reason === 'reconcile'
          ? 'reconcile'
          : 'manual';
    const outcome = await this.#poll(trigger, now, null);
    if (outcome.finish !== null) {
      await this.#finish(this.#now(), outcome.finish);
    }
    return this.#refreshResponse('refreshed');
  }

  getCostLedger(): Exact<GetCostLedgerResponseV1> {
    this.#ensureSchema();
    const row = this.#flight();
    if (row === null) {
      this.#armAbsentCleanup(this.#now());
      throw new RpcRequestError('invalid_request', 'tracker is not seeded');
    }
    const budget = this.#budget();
    return {
      rpcVersion: RPC_SCHEMA_VERSION,
      flightKey: row.key as FlightKey,
      scheduledPe: budget.scheduled_pe,
      userRefreshPe: budget.user_refresh_pe,
      calls: budget.calls,
      softCapPe: budget.soft_cap_pe,
      hardCapPe: budget.hard_cap_pe,
      stretched: budget.stretched === 1,
      hardCapHit: budget.hard_cap_hit === 1,
      byTrigger: JSON.parse(budget.by_trigger) as Record<string, { pe: number; calls: number }>,
    };
  }

  /**
   * A provider event pushed in: an AeroAPI alert delivery is MERGED onto the snapshot (its
   * payload lacks timezone and status, so it never replaces it); an AeroDataBox hint, or any
   * event whose payload is not a patch, is a re-read through the coalesced refresh path. Either
   * way, an answer that says the flight is done runs the finish path (ruling L12).
   */
  async ingestProviderEvent(input: unknown): Promise<Exact<IngestProviderEventResponseV1>> {
    const event = parseRpcRequest(ProviderEventV1, input);
    this.#ensureSchema();
    await this.#awaitFinishing();
    const now = this.#now();
    const row = this.#flight();
    if (row === null) {
      this.#armAbsentCleanup(now);
      return { rpcVersion: RPC_SCHEMA_VERSION, outcome: 'ignored', reason: 'absent', version: 0 };
    }
    if (row.phase === 'finished') {
      return {
        rpcVersion: RPC_SCHEMA_VERSION,
        outcome: 'ignored',
        reason: 'finished',
        version: row.version,
      };
    }
    const patch = event.payload as Partial<AeroApiAlertPatch> | null | undefined;
    if (event.provider === 'aeroapi' && patch?.source === 'aeroapi_alert') {
      await this.#awaitInflight();
      const applied = this.#tx((): ApplyOutcome => {
        const current = this.#requireFlight();
        const snapshot = this.#snapshotOf(current);
        const merged = mergeAeroApiAlert(snapshot, patch as AeroApiAlertPatch, new Date(now));
        return this.#applyStatus(
          current,
          snapshot,
          merged,
          now,
          'provider_alert',
          undefined,
          'merge',
        );
      });
      if (applied.finish !== null) {
        await this.#finish(now, applied.finish);
      } else {
        await this.#flushOutbox(now);
        this.#scheduleKv(now);
      }
      return { rpcVersion: RPC_SCHEMA_VERSION, outcome: 'merged', version: applied.version };
    }
    if (this.#inflight !== null) {
      await this.#awaitInflight();
      return {
        rpcVersion: RPC_SCHEMA_VERSION,
        outcome: 'refreshed',
        reason: 'coalesced',
        version: this.#requireFlight().version,
      };
    }
    const outcome = await this.#poll('provider_alert', now, null);
    if (outcome.finish !== null) {
      await this.#finish(this.#now(), outcome.finish);
    }
    return { rpcVersion: RPC_SCHEMA_VERSION, outcome: 'refreshed', version: outcome.version };
  }

  /**
   * The event injector (ruling N11): classifies a synthetic next snapshot against the stored
   * snapshot and policy state with the same policy, confirmed by construction (no settle re-read,
   * no cancellation confirmation), and writes the intents through the same outbox as tests, the
   * injection id in their dedupe key. It stores NEITHER the synthetic snapshot NOR the state the
   * evaluation returns, so the next real poll diffs against real data and finds no change back;
   * the only rows it writes are its intents' dedupe and outbox rows. A replayed injection id
   * writes nothing. The Access-protected admin route that calls it is increment 15 part 3's.
   */
  async injectPolicyEvent(input: unknown): Promise<Exact<InjectPolicyEventResponseV1>> {
    const request = parseRpcRequest(InjectPolicyEventRequestV1, input);
    this.#ensureSchema();
    await this.#awaitFinishing();
    await this.#awaitInflight();
    const now = this.#now();
    const row = this.#flight();
    if (row === null || row.phase === 'finished') {
      if (row === null) {
        this.#armAbsentCleanup(now);
      }
      const reason = row === null ? 'absent' : 'finished';
      return { rpcVersion: RPC_SCHEMA_VERSION, outcome: 'ignored', reason, intents: [] };
    }
    const written = this.#tx((): WrittenIntent[] => {
      const current = this.#requireFlight();
      const previous = this.#snapshotOf(current);
      const next: FlightStatus = { ...request.status, key: current.key as FlightKey };
      const state = this.#storedPolicyState(current) ?? initialPolicyState(previous);
      const result = evaluatePolicy({ previous, next, state, now, context: { confirmed: true } });
      return this.#appendIntents(current, now, result.intents, next, request.injectionId);
    });
    await this.#flushOutbox(now);
    this.#log.info('flight_tracker_policy_injected', {
      injection_id: request.injectionId,
      intents: written.length,
      written: written.filter((entry) => entry.written).length,
    });
    return {
      rpcVersion: RPC_SCHEMA_VERSION,
      outcome: 'injected',
      intents: written.map(({ intent, dedupeKey, written: wrote }) => ({
        kind: intent.kind,
        subject: intent.subject,
        value: intent.value,
        dedupeKey,
        written: wrote,
      })),
    };
  }

  /**
   * The persist consumer's confirmation: the named seqs of this lifetime are stored, and their
   * rows are deleted. With `deadLettered`, the dead-letter consumer's notice instead: the seqs
   * exhausted the persist queue's retries. Those rows STAY (a dead-lettering after a minute of
   * retries is as often a Postgres outage as a poison row, and a deleted row is gone for good);
   * they are stamped so the flush spaces their re-sends out, doubling per dead-lettering. A seq
   * that is not in the outbox is ignored either way.
   */
  confirmPersisted(input: unknown): Exact<ConfirmPersistedResponseV1> {
    const request = parseRpcRequest(ConfirmPersistedRequestV1, input);
    this.#ensureSchema();
    const now = this.#now();
    const row = this.#flight();
    if (row === null) {
      // A confirmation that outlived its lifetime (a Queues duplicate after the +22 h delete):
      // the object it recreated must not stay behind with an empty schema.
      this.#armAbsentCleanup(now);
      return { rpcVersion: RPC_SCHEMA_VERSION, deleted: 0, remaining: 0, matched: false };
    }
    if (row.created_at_ms !== request.epochMs) {
      return {
        rpcVersion: RPC_SCHEMA_VERSION,
        deleted: 0,
        remaining: this.#count('outbox'),
        matched: false,
      };
    }
    if (request.deadLettered === true) {
      this.#tx(() => {
        forEachBindChunk(request.seqs, (placeholders, chunk) => {
          this.#exec(
            `UPDATE outbox SET dead_letter_count = dead_letter_count + 1, last_dead_lettered_at_ms = ?
              WHERE seq IN (${placeholders})`,
            now,
            ...chunk,
          );
        });
      });
      const remaining = this.#count('outbox');
      this.#log.warn('flight_tracker_outbox_dead_lettered', {
        seqs: request.seqs.length,
        unconfirmed: remaining,
      });
      this.#scheduleKv(now, false);
      return { rpcVersion: RPC_SCHEMA_VERSION, deleted: 0, remaining, matched: true };
    }
    const deleted = this.#tx((): number => {
      let removed = 0;
      forEachBindChunk(request.seqs, (placeholders, chunk) => {
        const before = this.#count('outbox');
        this.#exec(`DELETE FROM outbox WHERE seq IN (${placeholders})`, ...chunk);
        removed += before - this.#count('outbox');
      });
      return removed;
    });
    this.#scheduleKv(now, false);
    return {
      rpcVersion: RPC_SCHEMA_VERSION,
      deleted,
      remaining: this.#count('outbox'),
      matched: true,
    };
  }

  /** What the reconcile consumer and the resolver's probe read; `alarmAt` is `getAlarm()`. */
  async health(): Promise<Exact<HealthResponseV1>> {
    this.#ensureSchema();
    const row = this.#flight();
    const alarm = await this.ctx.storage.getAlarm();
    const now = this.#now();
    const inflightSinceMs =
      this.#inflight === null || this.#inflightSince === null
        ? null
        : Math.max(0, now - this.#inflightSince);
    if (row === null) {
      this.#armAbsentCleanup(now);
      return {
        rpcVersion: RPC_SCHEMA_VERSION,
        flightKey: null,
        phase: 'absent',
        alarmAt: iso(alarm),
        inflight: this.#inflight !== null,
        inflightSinceMs,
        version: 0,
        doSchemaVersion: this.#schema.version,
        unconfirmedOutbox: 0,
        subscriberCount: 0,
      };
    }
    return {
      rpcVersion: RPC_SCHEMA_VERSION,
      flightKey: row.key as FlightKey,
      phase: row.phase as TrackerHealthPhase,
      alarmAt: iso(alarm),
      inflight: this.#inflight !== null,
      inflightSinceMs,
      version: row.version,
      doSchemaVersion: this.#schema.version,
      unconfirmedOutbox: this.#count('outbox'),
      subscriberCount: this.#count('subscribers'),
    };
  }

  // -------------------------------------------------------------------------------------------
  // The alarm.
  // -------------------------------------------------------------------------------------------

  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    this.#counters = { read: 0, written: 0 };
    this.#attemptOutcome = null;
    this.#ensureSchema();
    const retryCount = alarmInfo?.retryCount ?? 0;
    const isRetry = alarmInfo?.isRetry ?? retryCount > 0;

    // Step 0: whatever is in flight settles first. Nothing is committed yet, so waiting is safe,
    // and step 1 then reads the row a user refresh or a finish just wrote (ruling L14).
    await this.#awaitFinishing();
    await this.#awaitInflight();
    const now = this.#now();

    // Step 1 (and step 2's decision): one synchronous transaction before any I/O.
    const plan = this.#tx((): AlarmPlan =>
      this.#planAlarm(now, retryCount, isRetry, alarmInfo?.scheduledTime),
    );

    switch (plan.kind) {
      case 'cleanup':
        await this.#deleteEverything();
        return;
      case 'finish_alarm':
        await this.#finishAlarm(now);
        return;
      case 'deferred':
        this.#log.warn('flight_tracker_alarm_deferred', {
          path: plan.path,
          retry_count: retryCount,
        });
        return;
      case 'exhausted':
      case 'rearm':
        this.#log.info('flight_tracker_alarm_rearmed', {
          kind: plan.kind,
          retry_count: retryCount,
        });
        this.#scheduleKv(now, false);
        return;
      case 'finish':
        await this.#finish(now, plan.reason);
        return;
      case 'stopped':
      case 'satisfied':
        await this.#flushOutbox(now);
        this.#scheduleKv(now, plan.kind === 'stopped');
        this.#recordAttempt(plan.slot);
        return;
      case 'skip_io':
        // The retry found step 1 committed: resend what the failed attempt left behind, leave
        // the provider alone, and resume the committed plan (ruling L13): the schedule must not
        // depend on how the platform treats set-then-throw.
        await this.#flushOutbox(now);
        this.#scheduleKv(now, false);
        await this.#resumeCommitted(now);
        this.#recordAttempt(plan.slot);
        return;
      case 'poll':
        break;
    }

    // Steps 3 to 5.
    const outcome = await this.#poll(plan.trigger, now, plan.slot, plan.call);
    if (outcome.finish !== null) {
      await this.#finish(this.#now(), outcome.finish);
    } else if (plan.finishAfter) {
      const reason = this.#pendingFinishReason();
      if (reason !== null) {
        await this.#finish(this.#now(), reason);
      }
    }
    this.#recordAttempt(plan.slot);
  }

  #planAlarm(
    now: number,
    retryCount: number,
    isRetry: boolean,
    scheduledTime: number | undefined,
  ): AlarmPlan {
    const row = this.#flight();
    if (row === null) {
      if (retryCount >= RETRY_LADDER_MAX) {
        this.#setAlarm(now + FINISH_RETRY_MS);
        return { kind: 'deferred', path: 'cleanup' };
      }
      return { kind: 'cleanup' };
    }
    if (row.phase === 'finished') {
      if (retryCount >= RETRY_LADDER_MAX) {
        // The ladder counts as one of the bounded finish attempts (ruling L16).
        this.#exec(
          'UPDATE flight SET finish_alarm_attempts = finish_alarm_attempts + 1, updated_at_ms = ? WHERE id = 1',
          now,
        );
        this.#setAlarm(now + FINISH_RETRY_MS);
        return { kind: 'deferred', path: 'finish_alarm' };
      }
      // The finish alarm's own time: 22 hours from the finish plus an hour per deferral so far.
      // An alarm that arrives before it is the cadence alarm that was already being delivered
      // while a refresh, an alert or a seed finished the flight (the finish path's `setAlarm`
      // replaced the pending alarm, not the delivery in progress), or a duplicate delivery. It
      // only re-asserts the due time and counts no deferral; running the finish logic 22 hours
      // early deferred once, deleted the object an hour later, and answered `not seeded` for the
      // 21 hours in which `archived` was promised.
      const due =
        (row.finished_at_ms ?? now) + FINISH_ALARM_MS + row.finish_alarm_attempts * FINISH_RETRY_MS;
      if (now + EARLY_ALARM_TOLERANCE_MS < due) {
        this.#setAlarm(due);
        return { kind: 'rearm', at: due };
      }
      return { kind: 'finish_alarm' };
    }
    if (retryCount >= RETRY_LADDER_MAX) {
      // Step 2: re-arm 30 s out and return. Never set-then-throw, and never overwrite the
      // committed schedule: when the backstop fires, `next_refresh_at_ms` decides whether it
      // re-arms to the grid slot (step 1 had committed) or polls the still-due slot.
      if (row.attempt_slot_ms !== null) {
        this.#exec(
          `UPDATE attempts SET retry_count = ?, outcome = 'retry_ladder_exhausted', finished_at_ms = ?
            WHERE slot_ms = ?`,
          retryCount,
          now,
          row.attempt_slot_ms,
        );
      }
      this.#setAlarm(now + RETRY_BACKSTOP_MS);
      return { kind: 'exhausted' };
    }
    const committedNext = row.next_refresh_at_ms;
    if (isRetry) {
      // Ruling L13: the committed schedule decides, never the age of the last attempt. The
      // first delivery's step 1 moved `next_refresh_at_ms` past now, or to NULL when no slot
      // follows; a step 1 that rolled back left the due slot where it was.
      const committed = committedNext === null || committedNext > now + EARLY_ALARM_TOLERANCE_MS;
      if (committed && row.attempt_slot_ms !== null) {
        this.#exec(
          `UPDATE attempts SET retry_count = ?,
                  outcome = CASE WHEN outcome = 'started' THEN 'skipped_retry' ELSE outcome END
            WHERE slot_ms = ?`,
          retryCount,
          row.attempt_slot_ms,
        );
        return { kind: 'skip_io', slot: row.attempt_slot_ms };
      }
    } else {
      const slotTarget = committedNext ?? scheduledTime ?? now;
      if (now + EARLY_ALARM_TOLERANCE_MS < slotTarget) {
        // A duplicate delivery, an alarm that fired before its time, or the 30 s backstop after
        // a committed step 1: keep the schedule.
        this.#setAlarm(slotTarget);
        return { kind: 'rearm', at: slotTarget };
      }
      if (committedNext === null) {
        // The committed plan had no next slot (the tail poll committed and its finish never
        // ran, or a refresh emptied the schedule): finish now.
        const reason = this.#schedule(row, now).finish;
        if (reason !== null) {
          return { kind: 'finish', reason };
        }
      }
    }
    const slot = committedNext ?? scheduledTime ?? now;
    const context = this.#cadenceContext(row, now);
    if (context === null) {
      return { kind: 'finish', reason: 'unschedulable' };
    }
    let trigger: ProviderCallTrigger = 'alarm';
    if (row.polling_stopped === 1) {
      if (row.stop_reason === 'hard_cap' && row.reconcile_poll_done === 0) {
        // The one reconciliation poll the hard cap allowed, at scheduled arrival.
        trigger = 'reconcile';
        this.#exec(
          'UPDATE flight SET reconcile_poll_done = 1, updated_at_ms = ? WHERE id = 1',
          now,
        );
      } else {
        return {
          kind: 'finish',
          reason: row.stop_reason === 'hard_cap' ? 'hard_cap' : 'key_drift',
        };
      }
    }
    if (
      trigger === 'alarm' &&
      row.last_refreshed_at_ms !== null &&
      now - row.last_refreshed_at_ms < this.#tierIntervalMs(row, slot) &&
      this.#refreshedSinceLastAttempt(row) &&
      // A due policy re-read (N2, N4) is a read by definition: no refresh satisfies it.
      !this.#rereadDue(row, now)
    ) {
      // Ruling L14: a refresh outside the cadence (a user's, a reconcile's, a merged alert's)
      // inside this slot's tier interval already answered it. Reschedule without a call; the
      // attempt row still records the slot and its row counters. The previous SCHEDULED poll
      // never satisfies a slot, whatever the gap between two tiers' grids: the cadence module
      // is normative for the poll count.
      const next = this.#schedule(row, now);
      if (next.finish !== null) {
        return { kind: 'finish', reason: next.finish };
      }
      this.#exec(
        `INSERT INTO attempts (slot_ms, flight_id, started_at_ms, finished_at_ms, retry_count, trigger, outcome)
         VALUES (?, 1, ?, ?, ?, 'alarm', 'satisfied')
         ON CONFLICT (slot_ms) DO UPDATE SET started_at_ms = excluded.started_at_ms,
                                            retry_count = excluded.retry_count,
                                            outcome = 'satisfied'`,
        slot,
        now,
        now,
        retryCount,
      );
      this.#exec(
        'UPDATE flight SET attempt_slot_ms = ?, next_refresh_at_ms = ?, updated_at_ms = ? WHERE id = 1',
        slot,
        next.at,
        now,
      );
      this.#setAlarm(next.at);
      return { kind: 'satisfied', slot };
    }
    const call = this.#expectedCall(row, now, context);
    const budget = this.#budget();
    const decision =
      trigger === 'alarm'
        ? perFlightLedgerDecision({
            spentPe: budget.scheduled_pe,
            requestPe: call.expectedPe,
            softCapPe: budget.soft_cap_pe,
            hardCapPe: budget.hard_cap_pe,
          })
        : 'ok';
    if (decision === 'hard_cap' && budget.hard_cap_hit === 0) {
      // Stop polling; alerts would be deleted here (Phase 1 registers them); one reconciliation
      // poll at scheduled arrival tells the subscribers how the flight ended.
      const arrival = row.estimated_in_ms ?? row.scheduled_in_ms ?? now;
      const at = Math.max(arrival, now + 60_000);
      this.#exec(`UPDATE budget SET hard_cap_hit = 1 WHERE id = 1`);
      this.#exec(
        `UPDATE flight SET polling_stopped = 1, stop_reason = 'hard_cap', next_refresh_at_ms = ?,
                attempt_slot_ms = ?, version = version + 1, updated_at_ms = ? WHERE id = 1`,
        at,
        slot,
        now,
      );
      this.#exec(
        `INSERT INTO attempts (slot_ms, flight_id, started_at_ms, finished_at_ms, retry_count, trigger, outcome)
         VALUES (?, 1, ?, ?, ?, 'alarm', 'budget_stop')`,
        slot,
        now,
        now,
        retryCount,
      );
      const stopped = this.#requireFlight();
      this.#appendInstance(stopped, now);
      this.#appendEvent(stopped, now, {
        type: 'budget_hard_cap',
        field: 'scheduledPe',
        oldValue: budget.scheduled_pe,
        newValue: budget.hard_cap_pe,
        source: 'system',
      });
      this.#log.warn('flight_tracker_hard_cap', {
        spent_pe: budget.scheduled_pe,
        hard_cap_pe: budget.hard_cap_pe,
        alerts_to_delete: this.#count('alert_registrations'),
        reconcile_poll_at: iso(at),
      });
      this.#setAlarm(at);
      return { kind: 'stopped', slot };
    }
    if (decision === 'soft_cap' && budget.stretched === 0) {
      // The soft cap stretches the cadence one tier: one grid slot is skipped from here on.
      this.#exec('UPDATE budget SET stretched = 1 WHERE id = 1');
      this.#appendEvent(row, now, {
        type: 'budget_soft_cap',
        field: 'scheduledPe',
        oldValue: budget.scheduled_pe,
        newValue: budget.soft_cap_pe,
        source: 'system',
      });
      this.#log.warn('flight_tracker_soft_cap', {
        spent_pe: budget.scheduled_pe,
        soft_cap_pe: budget.soft_cap_pe,
      });
    }
    const next = this.#schedule(row, now, trigger === 'reconcile', true);
    this.#exec(
      `INSERT INTO attempts (slot_ms, flight_id, started_at_ms, retry_count, trigger, outcome)
       VALUES (?, 1, ?, ?, ?, 'started')
       ON CONFLICT (slot_ms) DO UPDATE SET started_at_ms = excluded.started_at_ms,
                                          retry_count = excluded.retry_count,
                                          outcome = 'started'`,
      slot,
      now,
      retryCount,
      trigger,
    );
    this.#debit(budget, trigger, call.expectedPe);
    this.#exec(
      `UPDATE flight SET attempt_slot_ms = ?, next_refresh_at_ms = ?, version = version + 1,
              provider_call_count = provider_call_count + 1, last_refreshed_at_ms = ?,
              updated_at_ms = ? WHERE id = 1`,
      slot,
      next.finish === null ? next.at : null,
      now,
      now,
    );
    this.#appendInstance(this.#requireFlight(), now);
    if (next.finish === null) {
      this.#setAlarm(next.at);
    }
    return { kind: 'poll', slot, trigger, call, finishAfter: next.finish !== null };
  }

  /**
   * After a `skip_io` retry: the committed plan, resumed. A plan with no next slot, or stopped
   * polling, runs the finish path; otherwise the committed alarm is re-asserted (one row).
   */
  async #resumeCommitted(now: number): Promise<void> {
    const row = this.#flight();
    if (row === null || row.phase === 'finished') {
      return;
    }
    const schedule = this.#schedule(row, now);
    if (schedule.finish !== null) {
      await this.#finish(now, schedule.finish);
      return;
    }
    const at = row.next_refresh_at_ms ?? schedule.at;
    this.#tx(() => {
      if (row.next_refresh_at_ms !== at) {
        this.#exec(
          'UPDATE flight SET next_refresh_at_ms = ?, updated_at_ms = ? WHERE id = 1',
          at,
          now,
        );
      }
      this.#setAlarm(at);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Steps 3 to 5, shared by the alarm and the refresh paths.
  // -------------------------------------------------------------------------------------------

  /**
   * Fetch, apply, flush. `#inflight` is the promise `subscribe`, `forceRefresh`,
   * `ingestProviderEvent` and the alarm join while it is set. A refresh outside the cadence
   * passes no slot and no pre-debited call: the router is asked for the current window and the
   * expected cost is debited here.
   */
  async #poll(
    trigger: ProviderCallTrigger,
    now: number,
    slot: number | null,
    preDebited?: ExpectedCall,
  ): Promise<ApplyOutcome> {
    const run = async (): Promise<ApplyOutcome> => {
      const row = this.#requireFlight();
      const snapshot = this.#snapshotOf(row);
      let call = preDebited;
      if (call === undefined) {
        const expected = this.#expectedCall(row, now);
        call = expected;
        this.#tx(() => {
          this.#debit(this.#budget(), trigger, expected.expectedPe);
        });
      }
      const result = await this.#fetch(row, snapshot, call, trigger);
      const applied = this.#tx((): ApplyOutcome => {
        const current = this.#requireFlight();
        return this.#applyResult(current, result, this.#now(), slot);
      });
      const after = this.#now();
      await this.#flushOutbox(after);
      this.#scheduleKv(after);
      return applied;
    };
    const inflight = run();
    this.#inflight = inflight;
    this.#inflightSince = now;
    try {
      return await inflight;
    } finally {
      if (this.#inflight === inflight) {
        this.#inflight = null;
        this.#inflightSince = null;
      }
    }
  }

  /**
   * Step 3. Never throws for a provider problem; the record says what happened. The adapter is
   * resolved inside the try (ruling L17): a `ProviderConfigError` is a zero-cost error record
   * that keeps the schedule and raises the ops alert once per configuration error.
   */
  async #fetch(
    row: FlightRow,
    snapshot: FlightStatus,
    call: ExpectedCall,
    trigger: ProviderCallTrigger,
  ): Promise<FetchResult> {
    const key = row.key as FlightKey;
    const parts = parseFlightKey(key);
    const buffered: ProviderCallRecord[] = [];
    const logger = new DurableObjectCostLogger({
      append: (_kind, payload) => {
        buffered.push(payload);
      },
    });
    const ctx: ProviderCallContext = {
      trigger,
      flightKey: key,
      requestId: `${trigger}:${key}:${String(this.#now())}`,
      budget: budgetGuardFor(this.env, () => new Date(this.#now())),
      log: logger,
      now: () => new Date(this.#now()),
    };
    // Always by designator through the router, never by a provider id (`providerRef`): the
    // policy's confirming re-read of a cancellation or diversion (ruling N4) is this same read,
    // and a read by `fa_flight_id` would only return the record that raised the suspicion.
    const designator = lookupDesignator(row, snapshot);
    const carrier =
      designator.code.length === 3 ? { icao: designator.code } : { iata: designator.code };
    const startedAt = new Date(this.#now());
    try {
      const provider = providerFor(call.source, this.env, this.#routerDeps(), {
        scheduledOut: new Date(row.scheduled_out_ms ?? this.#now()),
        now: new Date(this.#now()),
      });
      const result = await provider.getFlight(
        {
          carrier,
          flightNumber: designator.number,
          dateLocal: parts.scheduledDepartureDateLocal,
          originIcao: parts.originIcao,
          scheduledOut: snapshot.times.scheduledOut,
        },
        ctx,
      );
      const status =
        result.data.find((item) => item.origin.icao === parts.originIcao) ?? result.data[0] ?? null;
      return { status, records: [...buffered, result.call], expectedPe: call.expectedPe, trigger };
    } catch (error) {
      // A throw out of the adapter (a mapping bug, a key it cannot form) or out of the router (a
      // provider that is not configured) is a provider error, not a storage one: recorded at
      // zero cost and never retried through the alarm ladder.
      const configuration = error instanceof ProviderConfigError;
      if (configuration) {
        this.#alertConfigError(error.message);
      } else {
        this.#log.error('flight_tracker_provider_threw', errorFields(error));
      }
      const record = callRecord({
        ctx,
        provider: call.provider,
        operation: operationFor(call.provider),
        startedAt,
        finishedAt: new Date(this.#now()),
        result: 'error',
        billed: false,
        error: `${configuration ? 'config' : 'thrown'}:${error instanceof Error ? error.message : String(error)}`,
      });
      return { status: null, records: [...buffered, record], expectedPe: call.expectedPe, trigger };
    }
  }

  /** The router's dependencies: the timed fetch under whatever a test overrode. */
  #routerDeps(): RouterDeps {
    const timeoutMs = this.providerFetchTimeoutMs;
    const timedFetch: ProviderFetch = (request) =>
      fetch(request, { signal: AbortSignal.timeout(timeoutMs) });
    return { ...this.providerDeps, fetch: this.providerDeps.fetch ?? timedFetch };
  }

  /** One ops alert per configuration error per in-memory instance, never a thrown alarm. */
  #alertConfigError(message: string): void {
    if (this.#configAlerted.has(message)) {
      this.#log.error('provider_config_error_repeated', { message });
      return;
    }
    this.#configAlerted.add(message);
    raiseOpsAlert(
      'provider_config_error',
      { flight_key: this.ctx.id.name ?? 'unnamed', message },
      this.#log,
      this.capture,
    );
  }

  /** Step 4, inside the caller's transaction. */
  #applyResult(
    row: FlightRow,
    result: FetchResult,
    now: number,
    slot: number | null,
  ): ApplyOutcome {
    const previous = this.#snapshotOf(row);
    let units = 0;
    let actualPe = 0;
    let lastId: string | undefined;
    for (const record of result.records) {
      this.#appendOutbox(row, now, {
        kind: PROVIDER_CALL_OUTBOX_KIND,
        flightKey: row.key as FlightKey,
        payload: record,
      });
      units += record.costUnits;
      actualPe += record.pollEquivalents;
      lastId = record.id;
    }
    if (actualPe !== result.expectedPe) {
      this.#adjustDebit(result.trigger, actualPe - result.expectedPe);
    }
    if (slot !== null) {
      // The attempt's outcome is the last record's result: ok, not_found, rate_limited, error.
      // Written once, at the end of the alarm, together with the row counters (`#recordAttempt`).
      this.#attemptOutcome = {
        outcome: result.status !== null ? 'ok' : (result.records.at(-1)?.result ?? 'error'),
        providerCallId: lastId ?? null,
      };
    }
    const current = this.#requireFlight();
    if (result.status === null) {
      // A miss or an error changes nothing about the flight; the schedule stands. The call's
      // cost still lands on the row (one write, the same one a change would make).
      this.#exec(
        'UPDATE flight SET provider_cost_units = provider_cost_units + ?, updated_at_ms = ? WHERE id = 1',
        units,
        now,
      );
      // A failed read leaves a due re-read due: it is tried again a spacing later, not at once.
      const next = this.#schedule(current, now, false, true);
      this.#reschedule(current, next, now);
      return { version: current.version, changed: false, finish: next.finish };
    }
    const reconciliation = reconcileFlightKey(row.key as FlightKey, result.status);
    if (reconciliation.drift !== 'none') {
      this.#appendEvent(current, now, {
        type: 'key_drift',
        field: reconciliation.drift,
        oldValue: reconciliation.key,
        newValue: reconciliation.fresh,
        source: result.status.source,
        providerCallId: lastId,
      });
      this.#log.warn('flight_tracker_key_drift', {
        drift: reconciliation.drift,
        fresh: reconciliation.fresh,
      });
    }
    if (reconciliation.drift === 'different_flight') {
      this.#exec(
        `UPDATE flight SET polling_stopped = 1, stop_reason = 'different_flight', version = version + 1,
                updated_at_ms = ? WHERE id = 1`,
        now,
      );
      const stopped = this.#requireFlight();
      this.#appendInstance(stopped, now);
      return { version: stopped.version, changed: true, finish: 'key_drift' };
    }
    const status: FlightStatus = { ...result.status, key: row.key as FlightKey };
    return this.#applyStatus(current, previous, status, now, result.trigger, lastId, 'read', units);
  }

  /** Replaces the snapshot when it changed: events, scalars, version, outbox, schedule. */
  #applyStatus(
    row: FlightRow,
    previous: FlightStatus,
    next: FlightStatus,
    now: number,
    trigger: ProviderCallTrigger,
    providerCallId: string | undefined,
    source: ObservationSource,
    units = 0,
  ): ApplyOutcome {
    const drafts = diffSnapshots(previous, next, next.source, providerCallId);
    // The notification policy (N1 to N7): classified here, on every path that stores a snapshot,
    // so its state, its intents and the snapshot commit together, and no path can finish the
    // flight on a cancellation the policy has not confirmed (N4).
    const policy = this.#evaluate(row, previous, next, now, source === 'read');
    const serialized = JSON.stringify(next);
    // `fetchedAt` moves on every poll; a snapshot that differs in nothing else is the same
    // flight, so the version stays and no instance row goes out. The fresh `fetchedAt` is still
    // stored, on the same write the cost update needs anyway.
    const changed = drafts.length > 0 || withoutFetchedAt(next) !== withoutFetchedAt(previous);
    for (const draft of drafts) {
      this.#appendEvent(row, now, draft);
    }
    this.#exec(
      `UPDATE flight SET snapshot = ?, phase = ?, version = version + ?, scheduled_out_ms = ?,
              scheduled_in_ms = ?, estimated_in_ms = ?, actual_off_ms = ?, actual_on_ms = ?,
              actual_in_ms = ?, operator_source = ?, last_refreshed_at_ms = ?,
              provider_cost_units = provider_cost_units + ?, policy_state = ?, updated_at_ms = ?
        WHERE id = 1`,
      serialized,
      next.status,
      changed ? 1 : 0,
      ms(next.times.scheduledOut),
      ms(next.times.scheduledIn),
      ms(next.times.estimatedIn),
      ms(next.times.actualOff),
      ms(next.times.actualOn),
      ms(next.times.actualIn),
      next.operatorSource ?? null,
      now,
      units,
      JSON.stringify(policy.state),
      now,
    );
    const current = this.#requireFlight();
    this.#appendIntents(current, now, policy.intents, next, null);
    const schedule = this.#schedule(current, now, trigger === 'reconcile', source === 'read');
    const rescheduled = this.#reschedule(current, schedule, now);
    if (changed || rescheduled || source === 'seed') {
      this.#appendInstance(this.#requireFlight(), now);
    }
    return { version: current.version, changed, finish: schedule.finish };
  }

  /** Moves the alarm when the schedule changed; returns whether it did. */
  #reschedule(
    row: FlightRow,
    schedule: { readonly at: number; readonly finish: FinishReason | null },
    now: number,
  ): boolean {
    if (schedule.finish !== null) {
      // Nothing left to schedule: the caller runs the finish path, which replaces the alarm.
      if (row.next_refresh_at_ms !== null) {
        this.#exec(
          'UPDATE flight SET next_refresh_at_ms = NULL, updated_at_ms = ? WHERE id = 1',
          now,
        );
        return true;
      }
      return false;
    }
    if (row.next_refresh_at_ms === schedule.at) {
      return false;
    }
    this.#exec(
      'UPDATE flight SET next_refresh_at_ms = ?, updated_at_ms = ? WHERE id = 1',
      schedule.at,
      now,
    );
    this.#setAlarm(schedule.at);
    return true;
  }

  /**
   * The next slot for this flight from `refreshIntervalFor`, or the reason there is none. A
   * stretched cadence (the soft cap) skips one grid slot, which for A2's inner tiers is exactly
   * the next slower tier's interval. Polling that was stopped by the hard cap keeps whatever the
   * hard cap scheduled.
   */
  #cadenceSchedule(
    row: FlightRow,
    now: number,
    afterReconcilePoll: boolean,
  ): { readonly at: number; readonly finish: FinishReason | null } {
    if (row.polling_stopped === 1) {
      if (row.stop_reason === 'hard_cap' && row.reconcile_poll_done === 0 && !afterReconcilePoll) {
        return { at: row.next_refresh_at_ms ?? now, finish: null };
      }
      // After the hard cap's one reconciliation poll: `arrived` when that poll saw the flight
      // in, otherwise the cap is what ended the tracking.
      const capped: FinishReason = row.actual_in_ms !== null ? 'arrived' : 'hard_cap';
      return { at: now, finish: row.stop_reason === 'hard_cap' ? capped : 'key_drift' };
    }
    const context = this.#cadenceContext(row, now);
    if (context === null) {
      return { at: now, finish: 'unschedulable' };
    }
    const cadence = cadenceById(row.cadence);
    let decision = refreshIntervalFor(cadence, context);
    if (decision !== null && this.#budget().stretched === 1) {
      const stretched = refreshIntervalFor(cadence, {
        ...context,
        now: decision.nextRefreshAt,
      });
      decision = stretched ?? decision;
    }
    if (decision === null) {
      const reason: FinishReason =
        context.phase === 'cancelled'
          ? 'cancelled'
          : context.actualIn !== undefined || context.phase === 'arrived'
            ? 'arrived'
            : 'lifetime';
      return { at: now, finish: reason };
    }
    return { at: decision.nextRefreshAt.getTime(), finish: null };
  }

  /**
   * The next alarm: the cadence's slot (`#cadenceSchedule`), moved by what the notification
   * policy owes (`#policySchedule`) unless polling is stopped. `readNow` says a provider read is
   * being made, or was just made, at `now`.
   */
  #schedule(
    row: FlightRow,
    now: number,
    afterReconcilePoll = false,
    readNow = false,
  ): { readonly at: number; readonly finish: FinishReason | null } {
    const base = this.#cadenceSchedule(row, now, afterReconcilePoll);
    return row.polling_stopped === 1 ? base : this.#policySchedule(row, now, base, readNow);
  }

  /**
   * Rulings N2 and N4 on top of the cadence. The re-read the policy owes moves the next alarm to
   * `min(the cadence's slot, wants.at)`, at once when that instant has passed; a due re-read
   * whose read is being made (or failed) at `now` is next tried `POLICY_REREAD_RETRY_MS` later,
   * never at once, so a failing provider is not polled in a loop. A suspected cancellation holds
   * the `cancelled` finish until the confirming re-read decides, for as long as the flight would
   * still be tracked were it not cancelled (a provider that never answers cannot keep the
   * tracker alive past the flight's own lifetime).
   */
  #policySchedule(
    row: FlightRow,
    now: number,
    base: { readonly at: number; readonly finish: FinishReason | null },
    readNow: boolean,
  ): { readonly at: number; readonly finish: FinishReason | null } {
    const state = this.#storedPolicyState(row);
    const wants = state === null ? null : policyWants(state);
    if (state === null || wants === null) {
      return base;
    }
    const due = wants.at <= now + EARLY_ALARM_TOLERANCE_MS;
    const at = !due ? wants.at : readNow ? now + POLICY_REREAD_RETRY_MS : now;
    if (base.finish === null) {
      return { at: Math.min(base.at, at), finish: null };
    }
    const held =
      base.finish === 'cancelled' &&
      state.cancellation.status === 'suspect' &&
      this.#lifetimeLeft(row, now);
    return held ? { at, finish: null } : base;
  }

  /** Whether the cadence would still have a slot for this flight were it not cancelled. */
  #lifetimeLeft(row: FlightRow, now: number): boolean {
    const context = this.#cadenceContext(row, now);
    return (
      context !== null &&
      refreshIntervalFor(cadenceById(row.cadence), { ...context, phase: 'unknown' }) !== null
    );
  }

  #cadenceContext(row: FlightRow, now: number): CadenceContext | null {
    const out = this.#outInstants(row);
    return cadenceContextFor(
      {
        scheduledOutMs: row.scheduled_out_ms,
        scheduledInMs: row.scheduled_in_ms,
        estimatedInMs: row.estimated_in_ms,
        actualOffMs: row.actual_off_ms,
        actualOnMs: row.actual_on_ms,
        actualInMs: row.actual_in_ms,
        estimatedOutMs: out.estimatedOutMs,
        actualOutMs: out.actualOutMs,
        phase: row.phase as TrackerPhase,
      },
      now,
    );
  }

  /**
   * Ruling N8: the departure anchor's estimated and actual out, read from the stored snapshot
   * (the row has no columns for them, and adding two would buy nothing: the snapshot is on the
   * row already). Parsed without the schema and memoised on the snapshot text, because the
   * cadence context is built several times per alarm.
   */
  #outInstants(row: FlightRow): { estimatedOutMs: number | null; actualOutMs: number | null } {
    if (this.#outMemo?.snapshot !== row.snapshot) {
      let times: { estimatedOut?: unknown; actualOut?: unknown } | undefined;
      try {
        times = (JSON.parse(row.snapshot) as { times?: typeof times }).times;
      } catch {
        times = undefined;
      }
      const instant = (value: unknown): number | null =>
        typeof value === 'string' ? ms(value) : null;
      this.#outMemo = {
        snapshot: row.snapshot,
        estimatedOutMs: instant(times?.estimatedOut),
        actualOutMs: instant(times?.actualOut),
      };
    }
    return this.#outMemo;
  }

  /** The call the current window asks for, priced before any adapter exists (ruling L17). */
  #expectedCall(row: FlightRow, now: number, context?: CadenceContext | null): ExpectedCall {
    const resolved = context === undefined ? this.#cadenceContext(row, now) : context;
    const source: CadenceSource =
      resolved === null
        ? 'aerodatabox'
        : (windowAt(cadenceById(row.cadence), resolved)?.source ?? 'aerodatabox');
    const provider = expectedProviderFor(source, this.env, {
      scheduledOut: new Date(row.scheduled_out_ms ?? now),
      now: new Date(now),
    });
    return { source, provider, expectedPe: pollEquivalents(provider, operationFor(provider)) };
  }

  /**
   * True when `last_refreshed_at_ms` was written after the last scheduled attempt ended: a
   * refresh from outside the cadence. A scheduled poll's own apply lands before its attempt row
   * is closed (`#recordAttempt`), so it never counts as one.
   */
  #refreshedSinceLastAttempt(row: FlightRow): boolean {
    if (row.last_refreshed_at_ms === null) {
      return false;
    }
    if (row.attempt_slot_ms === null) {
      return true;
    }
    const closed = this.#exec<{ closed_ms: number | null }>(
      'SELECT COALESCE(finished_at_ms, started_at_ms) AS closed_ms FROM attempts WHERE slot_ms = ?',
      row.attempt_slot_ms,
    )[0]?.closed_ms;
    return closed === undefined || closed === null || row.last_refreshed_at_ms > closed;
  }

  /** The nominal interval of the window that owns `slot`, for the freshness rules. */
  #tierIntervalMs(row: FlightRow, slot: number): number {
    const context = this.#cadenceContext(row, slot);
    if (context === null) {
      return FIXED_SLOT_TIER_MS;
    }
    const window = windowAt(cadenceById(row.cadence), context);
    if (window === null || !isIntervalWindow(window)) {
      return FIXED_SLOT_TIER_MS;
    }
    return window.intervalMinutes * 60_000;
  }

  /** The reason the flight would finish right now, or null when it still has slots. */
  #pendingFinishReason(): FinishReason | null {
    const row = this.#flight();
    if (row === null) {
      return null;
    }
    return this.#schedule(row, this.#now()).finish;
  }

  // -------------------------------------------------------------------------------------------
  // Finish path (ruling J12, L2, L11, L12, L14).
  // -------------------------------------------------------------------------------------------

  /**
   * Runs under `#finishing`, which `forceRefresh`, `ingestProviderEvent`, `subscribe`, `seed`
   * and the alarm await before they read the row: nothing fetches or writes events after the
   * archive is taken. A second caller during a finish joins it.
   */
  async #finish(now: number, reason: FinishReason): Promise<void> {
    if (this.#finishing !== null) {
      await this.#awaitFinishing();
      return;
    }
    const run = this.#finishBody(now, reason);
    this.#finishing = run;
    try {
      await run;
    } finally {
      if (this.#finishing === run) {
        this.#finishing = null;
      }
    }
  }

  async #finishBody(now: number, reason: FinishReason): Promise<void> {
    const row = this.#flight();
    if (row === null || row.phase === 'finished') {
      return;
    }
    await this.#flushOutbox(now);
    // The finishing event goes into the timeline first, so the archive carries it.
    this.#tx(() => {
      this.#appendEvent(row, now, {
        type: 'finished',
        field: 'reason',
        newValue: reason,
        source: 'system',
      });
    });
    const archiveKey = await this.#archiveEvents(row);
    this.#tx(() => {
      const current = this.#flight();
      if (current === null || current.phase === 'finished') {
        return;
      }
      this.#exec(
        `UPDATE flight SET phase = 'finished', finished_at_ms = ?, finish_reason = ?, events_r2_key = ?,
                next_refresh_at_ms = NULL, attempt_slot_ms = NULL, polling_stopped = 1,
                version = version + 1, updated_at_ms = ? WHERE id = 1`,
        now,
        reason,
        archiveKey,
        now,
      );
      this.#appendInstance(this.#requireFlight(), now);
      this.#setAlarm(now + FINISH_ALARM_MS);
    });
    this.#log.info('flight_tracker_finished', { reason, archived: archiveKey !== null });
    await this.#flushOutbox(now);
    await this.#writeFinalKv(now);
  }

  /**
   * The +22 h alarm (ruling L2): re-read phase and outbox in one synchronous block, flush, and
   * `deleteAll()` ONLY when every outbox row has been confirmed. While rows remain, re-arm an
   * hour out, bounded by nothing but the rows draining, and raise the ops alert once after the
   * sixth deferral. Storage for one small object is cheaper than losing a flight's events. A row
   * the dead-letter consumer stamped counts as remaining (it is unconfirmed); the flush re-sends
   * it on its own spacing, and the alert says how many rows are of that kind.
   */
  async #finishAlarm(now: number): Promise<void> {
    const state = this.#tx(() => {
      const row = this.#flight();
      return row === null
        ? null
        : {
            phase: row.phase,
            unconfirmed: this.#count('outbox'),
            attempts: row.finish_alarm_attempts,
            archived: row.events_r2_key !== null,
            key: row.key as FlightKey,
            row,
          };
    });
    if (state === null || state.phase !== 'finished') {
      return;
    }
    if (state.unconfirmed > 0) {
      await this.#flushOutbox(now);
    }
    if (!state.archived) {
      const archiveKey = await this.#archiveEvents(state.row);
      if (archiveKey !== null) {
        this.#tx(() => {
          this.#exec('UPDATE flight SET events_r2_key = ? WHERE id = 1', archiveKey);
        });
      }
    }
    const remaining = this.#count('outbox');
    if (remaining > 0) {
      const unsent = this.#countUnsent();
      const deadLettered = this.#countDeadLettered();
      const attempts = state.attempts + 1;
      this.#tx(() => {
        this.#exec(
          'UPDATE flight SET finish_alarm_attempts = ?, updated_at_ms = ? WHERE id = 1',
          attempts,
          now,
        );
        this.#setAlarm(now + FINISH_RETRY_MS);
      });
      if (attempts === FINISH_ALERT_AFTER_ATTEMPTS) {
        raiseOpsAlert(
          'flight_tracker_outbox_stuck',
          {
            flight_key: state.key,
            name: this.ctx.id.name ?? 'unnamed',
            unconfirmed: remaining,
            unsent,
            dead_lettered: deadLettered,
            attempts,
          },
          this.#log,
          this.capture,
        );
      } else {
        this.#log.warn('flight_tracker_finish_deferred', {
          unconfirmed: remaining,
          unsent,
          dead_lettered: deadLettered,
          attempts,
        });
      }
      return;
    }
    await this.#deleteEverything();
  }

  /**
   * The timeline to R2 under this lifetime's key, never overwriting: a key that exists was
   * written by an earlier attempt of this same finish and is kept as it is.
   */
  async #archiveEvents(row: FlightRow): Promise<string | null> {
    const key = row.key as FlightKey;
    const events = this.#exec<EventRow>(
      'SELECT seq, occurred_at_ms, type, field, old_value, new_value, source, provider_call_id FROM events ORDER BY seq',
    ).map((event) => ({
      seq: event.seq,
      occurredAt: new Date(event.occurred_at_ms).toISOString(),
      type: event.type,
      field: event.field,
      oldValue: event.old_value === null ? null : (JSON.parse(event.old_value) as unknown),
      newValue: event.new_value === null ? null : (JSON.parse(event.new_value) as unknown),
      source: event.source,
      providerCallId: event.provider_call_id,
    }));
    const archiveKey = eventsArchiveKey(key, row.created_at_ms);
    try {
      const outcome = await putJsonArchiveIfAbsent(this.bucket, archiveKey, {
        flightKey: key,
        lifetimeEpochMs: row.created_at_ms,
        events,
      });
      if (outcome === 'exists') {
        this.#log.warn('flight_tracker_archive_exists', { archive_key: archiveKey });
      }
      return archiveKey;
    } catch (error) {
      this.#log.error('flight_tracker_archive_failed', errorFields(error));
      return null;
    }
  }

  async #deleteEverything(): Promise<void> {
    this.#log.info('flight_tracker_deleted', {});
    await this.ctx.storage.deleteAll();
    this.#deleted = true;
    this.#cleanupArmed = false;
  }

  // -------------------------------------------------------------------------------------------
  // Outbox (step 5) and the KV snapshot.
  // -------------------------------------------------------------------------------------------

  /**
   * Sends every unsent row, every sent row that has waited `OUTBOX_RESEND_GRACE_MS` without
   * confirmation, and every dead-lettered row whose spacing has passed (`deadLetterResendDue`),
   * in byte-chunked batches; marks `sent_at` on the accepted rows only. Never throws: a failed
   * send leaves the rows for the next flush. Not inside a transaction.
   */
  async #flushOutbox(now: number): Promise<void> {
    const row = this.#flight();
    if (row === null) {
      return;
    }
    const due = this.#exec<OutboxRow>(
      `SELECT seq, payload, sent_at_ms, dead_letter_count, last_dead_lettered_at_ms FROM outbox
        WHERE sent_at_ms IS NULL OR sent_at_ms <= ? ORDER BY seq`,
      now - OUTBOX_RESEND_GRACE_MS,
    );
    // A row the dead-letter consumer stamped waits for its spacing, not for the grace.
    const rows = due.filter(
      (entry) => entry.dead_letter_count === 0 || deadLetterResendDue(entry, now),
    );
    if (rows.length === 0) {
      return;
    }
    const origin = flightTrackerOrigin(row.key as FlightKey, row.created_at_ms);
    const { chunks, oversize } = chunkOutbox(rows, (entry) => ({
      ...(JSON.parse(entry.payload) as Record<string, unknown>),
      seq: entry.seq,
      origin,
    }));
    if (oversize.length > 0) {
      // Never sent: dropped with an event that says so. The event is a small row of its own.
      this.#tx(() => {
        for (const entry of oversize) {
          this.#exec('DELETE FROM outbox WHERE seq = ?', entry.seq);
          this.#appendEvent(row, now, {
            type: 'outbox_oversize',
            field: 'seq',
            newValue: entry.seq,
            source: 'system',
          });
        }
      });
      this.#log.error('flight_tracker_outbox_oversize', { rows: oversize.length });
    }
    const outcome = await sendOutboxChunks(this.outboxSink, chunks, this.#log);
    let maxMessageBytes = 0;
    for (const chunk of chunks) {
      for (const body of chunk.bodies) {
        maxMessageBytes = Math.max(maxMessageBytes, JSON.stringify(body).length);
      }
    }
    this.flushStats = {
      batches: outcome.batches.length,
      messages: outcome.sentSeqs.length,
      maxMessagesPerBatch: Math.max(0, ...outcome.batches.map((batch) => batch.messages)),
      maxBytesPerBatch: Math.max(0, ...outcome.batches.map((batch) => batch.bytes)),
      maxMessageBytes,
    };
    if (outcome.sentSeqs.length > 0) {
      this.#tx(() => {
        markOutboxSent(
          (query, ...bindings) => this.#exec(query, ...bindings),
          outcome.sentSeqs,
          now,
        );
      });
    }
  }

  /**
   * The KV snapshot, debounced with stored state (never a timer) and written off the critical
   * path. A writer passes `dirty`; a suppressed write marks `pending`, and any entry point that
   * calls this with `dirty` false performs the pending write once the gap has passed (L11).
   */
  #scheduleKv(now: number, dirty = true): void {
    const row = this.#flight();
    if (row === null) {
      return;
    }
    const debounce = this.#exec<DebounceRow>(
      'SELECT last_write_at_ms, pending FROM kv_debounce WHERE id = 1',
    )[0];
    const pending = debounce?.pending === 1;
    if (!dirty && !pending) {
      return;
    }
    const last = debounce?.last_write_at_ms ?? 0;
    if (now - last < SNAPSHOT_KV_DEBOUNCE_MS || this.#kvInFlight !== null) {
      if (!pending) {
        this.#exec('UPDATE kv_debounce SET pending = 1 WHERE id = 1');
      }
      return;
    }
    this.#writeKv(now, row);
  }

  #writeKv(now: number, row: FlightRow): void {
    this.#exec('UPDATE kv_debounce SET last_write_at_ms = ?, pending = 0 WHERE id = 1', now);
    const value: SnapshotKvValue = {
      rpcVersion: 1,
      flightKey: row.key as FlightKey,
      phase: row.phase as TrackerHealthPhase,
      version: row.version,
      snapshot: this.#snapshotOf(row),
      nextRefreshAt: iso(row.next_refresh_at_ms),
      writtenAt: new Date(now).toISOString(),
    };
    const write = writeSnapshotKv(this.kv, value, this.#log)
      .then(() => undefined)
      .finally(() => {
        this.#kvInFlight = null;
      });
    this.#kvInFlight = write;
    this.ctx.waitUntil(write);
  }

  /**
   * The finished snapshot, written by the finish path itself (ruling L11): after the in-flight
   * write settles, and after the KV per-key gap when the poll of the same alarm just wrote,
   * waiting the remainder with `scheduler.wait` inside the running alarm. This is the one
   * in-request wait in the module, bounded by `SNAPSHOT_KV_MIN_GAP_MS`; nothing here is an idle
   * timer (a pending timer would keep the object from hibernating).
   */
  async #writeFinalKv(now: number): Promise<void> {
    await this.kvSettled();
    const debounce = this.#exec<DebounceRow>(
      'SELECT last_write_at_ms, pending FROM kv_debounce WHERE id = 1',
    )[0];
    const elapsed = now - (debounce?.last_write_at_ms ?? 0);
    if (elapsed >= 0 && elapsed < SNAPSHOT_KV_MIN_GAP_MS) {
      await scheduler.wait(SNAPSHOT_KV_MIN_GAP_MS - elapsed);
    }
    const row = this.#flight();
    if (row === null) {
      return;
    }
    this.#writeKv(this.#now(), row);
    await this.kvSettled();
  }

  /** Test seam: resolves once no KV write is in flight. */
  async kvSettled(): Promise<void> {
    while (this.#kvInFlight !== null) {
      await this.#kvInFlight;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Storage helpers. Everything below runs inside a caller's `transactionSync` unless it says
  // otherwise, and none of it awaits.
  // -------------------------------------------------------------------------------------------

  /**
   * Every transaction. Outbox seqs are allocated here from `flight.outbox_next_seq` (a rowid is
   * reused by SQLite once the confirmed rows above it are deleted, and a reused seq would
   * collide with an `events.seq` and repeat an `(origin, seq)` idempotency key), and the counter
   * is written back ONCE per transaction that appended rows, inside it, so a rollback takes the
   * allocation with it.
   */
  #tx<T>(fn: () => T): T {
    return this.ctx.storage.transactionSync((): T => {
      this.#seqAlloc = null;
      try {
        const result = fn();
        // Read through a method: the compiler narrows the field to null after the assignment
        // above and cannot see `fn()` mutate it.
        const alloc = this.#seqAllocation();
        if (alloc !== null && alloc.dirty) {
          this.#exec('UPDATE flight SET outbox_next_seq = ? WHERE id = 1', alloc.next);
        }
        return result;
      } finally {
        this.#seqAlloc = null;
      }
    });
  }

  #seqAllocation(): { next: number; dirty: boolean } | null {
    return this.#seqAlloc;
  }

  /** The next outbox seq of this lifetime; only inside `#tx`. */
  #nextSeq(): number {
    if (this.#seqAlloc === null) {
      const row = this.#exec<{ outbox_next_seq: number }>(
        'SELECT outbox_next_seq FROM flight WHERE id = 1',
      )[0];
      if (row === undefined) {
        throw new Error('FlightTracker flight row missing (seq allocation)');
      }
      this.#seqAlloc = { next: row.outbox_next_seq, dirty: false };
    }
    const seq = this.#seqAlloc.next;
    this.#seqAlloc = { next: seq + 1, dirty: true };
    return seq;
  }

  /** Every statement: runs it, drains the cursor, and counts its rows (ruling J5). */
  #exec<T extends Row = Row>(query: string, ...bindings: (string | number | null)[]): T[] {
    const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    this.#counters.read += cursor.rowsRead;
    this.#counters.written += cursor.rowsWritten;
    this.rowsReadLifetime += cursor.rowsRead;
    this.rowsWrittenLifetime += cursor.rowsWritten;
    return rows;
  }

  /** `setAlarm` is one row written (the platform prices it so); not awaited inside a transaction. */
  #setAlarm(atMs: number): void {
    void this.ctx.storage.setAlarm(atMs);
    this.#counters.written += 1;
    this.rowsWrittenLifetime += 1;
  }

  #now(): number {
    if (this.#testClockMs !== null && this.env.TEST_CLOCK === 'true') {
      return this.#testClockMs;
    }
    return Date.now();
  }

  /** After `deleteAll()` the tables are gone; a later touch recreates the (empty) schema. */
  #ensureSchema(): void {
    if (this.#deleted) {
      this.#schema = runSqlMigrations(this.ctx, FlightTracker.MIGRATIONS);
      this.rowsWrittenLifetime += this.#schema.rowsWritten;
      this.#deleted = false;
    }
  }

  /** An object that holds no flight bills for its empty schema: it deletes itself in a minute. */
  #armAbsentCleanup(now: number): void {
    if (this.#cleanupArmed) {
      return;
    }
    this.#cleanupArmed = true;
    void this.ctx.storage.setAlarm(now + ABSENT_CLEANUP_MS);
  }

  /** The finish path in progress, if any; errors are the finisher's to report. */
  async #awaitFinishing(): Promise<void> {
    while (this.#finishing !== null) {
      await this.#finishing.catch(() => undefined);
    }
  }

  /** The fetch in flight, if any; errors are the poller's to report. */
  async #awaitInflight(): Promise<void> {
    while (this.#inflight !== null) {
      await this.#inflight.catch(() => undefined);
    }
  }

  #flight(): FlightRow | null {
    return this.#exec<FlightRow>('SELECT * FROM flight WHERE id = 1')[0] ?? null;
  }

  #requireFlight(): FlightRow {
    const row = this.#flight();
    if (row === null) {
      throw new Error('FlightTracker flight row missing');
    }
    return row;
  }

  #budget(): BudgetRow {
    const row = this.#exec<BudgetRow>('SELECT * FROM budget WHERE id = 1')[0];
    if (row === undefined) {
      throw new Error('FlightTracker budget row missing');
    }
    return row;
  }

  #count(table: 'subscribers' | 'outbox' | 'alert_registrations'): number {
    return this.#exec<CountRow>(`SELECT COUNT(*) AS n FROM ${table}`)[0]?.n ?? 0;
  }

  /** Outbox rows that never reached the queue. */
  #countUnsent(): number {
    return (
      this.#exec<CountRow>('SELECT COUNT(*) AS n FROM outbox WHERE sent_at_ms IS NULL')[0]?.n ?? 0
    );
  }

  /** Outbox rows the persist queue has dead-lettered at least once. */
  #countDeadLettered(): number {
    return (
      this.#exec<CountRow>('SELECT COUNT(*) AS n FROM outbox WHERE dead_letter_count > 0')[0]?.n ??
      0
    );
  }

  #snapshotOf(row: FlightRow): FlightStatus {
    return FlightStatusSchema.parse(JSON.parse(row.snapshot));
  }

  /** The stored policy state (migration 003), or null when there is none this build can read. */
  #storedPolicyState(row: FlightRow): PolicyState | null {
    if (row.policy_state === null) {
      return null;
    }
    try {
      return readPolicyState(JSON.parse(row.policy_state));
    } catch {
      return null;
    }
  }

  /**
   * Whether the policy's re-read is due at `now`: the state names a `wants` at or before it
   * (within the early-alarm tolerance). Such an alarm must read, never be satisfied by a refresh.
   */
  #rereadDue(row: FlightRow, now: number): boolean {
    const state = this.#storedPolicyState(row);
    const wants = state === null ? null : policyWants(state);
    return wants !== null && wants.at <= now + EARLY_ALARM_TOLERANCE_MS;
  }

  /**
   * Rulings N1, N2, N4: classifies one stored observation against the snapshot before it. The
   * state is seeded from that snapshot when none is stored (a tracker created before increment
   * 15, or a layout this build cannot read). A provider read of this tracker's own (an alarm, a
   * user refresh, a reconcile poll, an alert's re-read), all by designator through the router,
   * made once the re-read is due IS that re-read; an alert merge or a re-seed never is (an
   * AeroAPI alert is keyed by `fa_flight_id` and carries the very flag a re-read must confirm).
   */
  #evaluate(
    row: FlightRow,
    previous: FlightStatus,
    next: FlightStatus,
    now: number,
    read: boolean,
  ): PolicyResult {
    const state = this.#storedPolicyState(row) ?? initialPolicyState(previous);
    const input = { previous, next, state, now };
    return read && this.#rereadDue(row, now) ? evaluateReread(input) : evaluatePolicy(input);
  }

  #debit(budget: BudgetRow, trigger: ProviderCallTrigger, pe: number): void {
    const byTrigger = JSON.parse(budget.by_trigger) as Record<
      string,
      { pe: number; calls: number }
    >;
    const entry = byTrigger[trigger] ?? { pe: 0, calls: 0 };
    byTrigger[trigger] = { pe: entry.pe + pe, calls: entry.calls + 1 };
    const scheduled = trigger === 'user_refresh' ? 0 : pe;
    const user = trigger === 'user_refresh' ? pe : 0;
    this.#exec(
      `UPDATE budget SET scheduled_pe = scheduled_pe + ?, user_refresh_pe = user_refresh_pe + ?,
              calls = calls + 1, by_trigger = ? WHERE id = 1`,
      scheduled,
      user,
      JSON.stringify(byTrigger),
    );
  }

  /** Brings a pre-debited expected cost to the recorded actual one. */
  #adjustDebit(trigger: ProviderCallTrigger, deltaPe: number): void {
    const budget = this.#budget();
    const byTrigger = JSON.parse(budget.by_trigger) as Record<
      string,
      { pe: number; calls: number }
    >;
    const entry = byTrigger[trigger] ?? { pe: 0, calls: 0 };
    byTrigger[trigger] = { pe: Math.max(0, entry.pe + deltaPe), calls: entry.calls };
    const column = trigger === 'user_refresh' ? 'user_refresh_pe' : 'scheduled_pe';
    this.#exec(
      `UPDATE budget SET ${column} = MAX(0, ${column} + ?), by_trigger = ? WHERE id = 1`,
      deltaPe,
      JSON.stringify(byTrigger),
    );
  }

  /** An event row and its outbox row; the outbox seq is the event seq. */
  #appendEvent(row: FlightRow, now: number, draft: EventDraft): void {
    const payload: FlightEventOutboxPayloadV1 = {
      occurredAt: new Date(now).toISOString(),
      type: draft.type,
      field: draft.field ?? null,
      oldValue: draft.oldValue,
      newValue: draft.newValue,
      source: draft.source,
      providerCallId: draft.providerCallId ?? null,
    };
    const seq = this.#appendOutbox(row, now, {
      kind: 'flight_event',
      flightKey: row.key as FlightKey,
      payload,
    });
    this.#exec(
      `INSERT INTO events (seq, flight_id, occurred_at_ms, type, field, old_value, new_value, source, provider_call_id)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      seq,
      now,
      draft.type,
      draft.field ?? null,
      draft.oldValue === undefined ? null : JSON.stringify(draft.oldValue),
      draft.newValue === undefined ? null : JSON.stringify(draft.newValue),
      draft.source,
      draft.providerCallId ?? null,
    );
  }

  /**
   * The `flight_instances` row as of `row`, into the outbox. A phase that is not finished never
   * persists a NULL `next_refresh_at` (ruling L12): when the plan has no next slot, the finish
   * instant goes out instead, so a tracker that dies between its last step 1 and its finish is
   * still found by the reconcile cron.
   */
  #appendInstance(row: FlightRow, now: number): void {
    const key = row.key as FlightKey;
    const parts = parseFlightKey(key);
    const nextRefreshAt =
      row.next_refresh_at_ms !== null
        ? iso(row.next_refresh_at_ms)
        : row.phase === 'finished'
          ? null
          : iso(now);
    const payload: FlightInstanceOutboxPayloadV1 = {
      operatingCarrierIcao: parts.operatingCarrierIcao,
      flightNumber: parts.flightNumber,
      scheduledDepartureDate: parts.scheduledDepartureDateLocal,
      originIcao: parts.originIcao,
      legSeq: parts.legSeq,
      version: row.version,
      phase: row.phase as TrackerPhase,
      trackingState: trackingStateFor(row.phase),
      refreshCadence: row.cadence as FlightInstanceOutboxPayloadV1['refreshCadence'],
      nextRefreshAt,
      lastRefreshedAt: iso(row.last_refreshed_at_ms),
      doSchemaVersion: this.#schema.version,
      snapshot: this.#snapshotOf(row),
      providerCallCount: row.provider_call_count,
      providerCostUnits: row.provider_cost_units,
      subscriberCount: this.#count('subscribers'),
      operatorSource: row.operator_source as FlightInstanceOutboxPayloadV1['operatorSource'],
      finishedAt: iso(row.finished_at_ms),
      eventsR2Key: row.events_r2_key,
    };
    this.#appendOutbox(row, now, { kind: 'flight_instance', flightKey: key, payload });
  }

  /**
   * Ruling N7: one `notify_intent` outbox row per intent, inside the caller's transaction (the
   * one that stores the state the intent came from), each guarded by `notif_dedupe`. The key
   * names the flight, the kind, the intent's value and the tracker's change sequence (`version`,
   * as of the stored observation): a retried alarm reproduces it and writes nothing twice, while a
   * later change back to a value pushed before (a delay of 20, then 10, then 20) gets a new one.
   * An injection's id stands in for the sequence and marks the intent as a test (N11), so a
   * replayed injection writes nothing.
   */
  #appendIntents(
    row: FlightRow,
    now: number,
    intents: readonly PolicyIntent[],
    observed: FlightStatus,
    injectionId: string | null,
  ): WrittenIntent[] {
    const flightKey = row.key as FlightKey;
    const sequence = injectionId === null ? `v${String(row.version)}` : `test:${injectionId}`;
    return intents.map((intent): WrittenIntent => {
      const dedupeKey = `${flightKey}:${intent.kind}:${intent.dedupeValue}:${sequence}`;
      const inserted = this.#exec(
        `INSERT INTO notif_dedupe (dedupe_key, flight_id, sent_at_ms) VALUES (?, 1, ?)
         ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key`,
        dedupeKey,
        now,
      );
      if (inserted.length === 0) {
        return { intent, dedupeKey, written: false };
      }
      const payload: NotifyIntentV1Input = {
        kind: 'notify_intent',
        flightKey,
        dedupeKey,
        intent: { ...intent },
        flight: flightSummary(observed),
        producedAt: new Date(now).toISOString(),
        test: injectionId !== null,
        ...(injectionId === null ? {} : { injectionId }),
      };
      this.#appendOutbox(row, now, { kind: 'notify_intent', flightKey, payload });
      return { intent, dedupeKey, written: true };
    });
  }

  /** Stores the message minus `seq` and `origin`, which are added at send time. Returns the seq. */
  #appendOutbox(_row: FlightRow, now: number, message: OutboxDraft): number {
    const seq = this.#nextSeq();
    this.#exec(
      'INSERT INTO outbox (seq, flight_id, kind, payload, created_at_ms) VALUES (?, 1, ?, ?, ?)',
      seq,
      message.kind,
      JSON.stringify(message),
      now,
    );
    return seq;
  }

  /**
   * Stores this alarm's outcome and row counters on its attempts row: one written row, counted
   * in the stored total. Outside any transaction, last.
   */
  #recordAttempt(slot: number): void {
    const written = this.#counters.written + 1;
    const read = this.#counters.read;
    const final = this.#attemptOutcome;
    this.#attemptOutcome = null;
    try {
      this.ctx.storage.sql.exec(
        `UPDATE attempts SET rows_read = ?, rows_written = ?, finished_at_ms = COALESCE(finished_at_ms, ?),
                outcome = COALESCE(?, outcome), provider_call_id = COALESCE(?, provider_call_id)
          WHERE slot_ms = ?`,
        read,
        written,
        this.#now(),
        final?.outcome ?? null,
        final?.providerCallId ?? null,
        slot,
      );
      this.rowsWrittenLifetime += 1;
    } catch (error) {
      this.#log.warn('flight_tracker_attempt_record_failed', errorFields(error));
    }
  }

  #seedResponse(status: SeedResponseV1['status'], row: FlightRow): Exact<SeedResponseV1> {
    return {
      rpcVersion: RPC_SCHEMA_VERSION,
      status,
      flightKey: row.key as FlightKey,
      version: row.version,
      phase: row.phase as TrackerHealthPhase,
      nextRefreshAt: iso(row.next_refresh_at_ms),
    };
  }

  #refreshResponse(
    outcome: ForceRefreshResponseV1['outcome'],
    reason?: string,
  ): Exact<ForceRefreshResponseV1> {
    const row = this.#flight();
    const response: Exact<ForceRefreshResponseV1> = {
      rpcVersion: RPC_SCHEMA_VERSION,
      outcome,
      phase: row === null ? 'absent' : (row.phase as TrackerHealthPhase),
      version: row?.version ?? 0,
      snapshot: row === null ? null : this.#snapshotOf(row),
    };
    if (reason !== undefined) {
      response.reason = reason;
    }
    return response;
  }
}
