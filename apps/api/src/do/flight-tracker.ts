/**
 * FlightTracker Durable Object (increment 7).
 *
 * One object per canonical flight key (ADR 0003), for example `AAL-100-2026-09-19-KJFK`. This is
 * where the shared-flight invariant becomes structural: every subscriber to a flight talks to
 * this one object, so a refresh costs one provider call no matter how many users are watching,
 * and a refresh that is already in flight is joined, never repeated (`#inflight`).
 *
 * The alarm handler is five steps, in this order, and the order is the design (ADR 0011):
 *
 *   1. ONE `transactionSync` before any I/O: read `alarmInfo?.retryCount`, find the slot this
 *      alarm is for, and either (a) skip the provider I/O because a retry finds this slot's
 *      `attempts` row started less than a tier interval ago, or (b) insert the attempt, debit the
 *      per-flight budget (`perFlightLedgerDecision`: the soft cap logs and stretches the cadence
 *      one tier, the hard cap stops polling and schedules one reconciliation poll at scheduled
 *      arrival), append the outbox intent row and `setAlarm(next)` without awaiting it. The
 *      commit makes attempt, debit, outbox row and alarm atomic (spike 1: `setAlarm` inside
 *      `transactionSync` is covered by the rollback).
 *   2. `retryCount >= 5`: `setAlarm(now + 30 s)` and return, never set-then-throw. The reconcile
 *      cron is the backstop, not the primary recovery.
 *   3. Fetch through the router behind `#inflight`, an explicit promise handle: input gates do
 *      not cover an `await` on `fetch`, so a `subscribe` or `forceRefresh` arriving mid-fetch
 *      awaits the same promise. Every provider error becomes an error `ProviderCallRecord` at
 *      zero cost; only a storage error throws (and is retried by the platform).
 *   4. A second `transactionSync` applies the result: `reconcileFlightKey` (drift is an event,
 *      never a rename; `different_flight` stops polling), the snapshot with a monotonically
 *      increasing `version`, the events rows, the outbox rows.
 *   5. After the commit: send the outbox to the `persist` queue in byte-chunked batches, and
 *      write the debounced KV snapshot off the critical path.
 *
 * Rows written are a budgeted number (ruling J5): every statement runs through `#exec`, which
 * sums the cursor's `rowsRead` and `rowsWritten`; each `setAlarm` adds one; the totals are stored
 * on the alarm's `attempts` row and the lifecycle test asserts a full A2 walk stays under
 * `ROWS_WRITTEN_BUDGET_PER_FLIGHT`.
 *
 * Outbox rows are deleted only when the persist consumer confirms them (`confirmPersisted`);
 * a lost send is re-sent by the next flush. The finish path flushes, archives the events to R2,
 * sets phase `finished` and arms one alarm 22 hours out that calls `deleteAll()` once the outbox
 * is empty. `deleteAll()` is never called inside a transaction, and there is no `setAlarm` in the
 * constructor, no `setTimeout` anywhere, no `blockConcurrencyWhile` outside the migration run.
 *
 * Never opens Postgres (ADR 0007). Every write leaves through the outbox.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  A2_HARD_CAP_PE,
  A2_SOFT_CAP_PE,
  CADENCES,
  ConfirmPersistedRequestV1,
  ForceRefreshRequestV1,
  FlightStatusSchema,
  ProviderEventV1,
  RPC_SCHEMA_VERSION,
  RpcRequestError,
  SeedRequestV1,
  SubscribeRequestV1,
  UnsubscribeRequestV1,
  flightTrackerOrigin,
  isIntervalWindow,
  parseDesignator,
  parseFlightKey,
  parseRpcRequest,
  pollEquivalents,
  reconcileFlightKey,
  refreshIntervalFor,
  windowAt,
  type CadenceContext,
  type CadenceDefinition,
  type CadenceSource,
  type ConfirmPersistedResponseV1,
  type Exact,
  type FlightDataProvider,
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
  type ProviderCallContext,
  type ProviderCallRecord,
  type ProviderCallTrigger,
  type SeedResponseV1,
  type SubscribeResponseV1,
  type TrackerHealthPhase,
  type TrackerPhase,
  type UnsubscribeResponseV1,
} from '@planeahead/shared';
import type { Env } from '../env';
import { writeSnapshotKv, SNAPSHOT_KV_DEBOUNCE_MS } from '../kv/snapshot';
import { createLogger, errorFields, type Logger } from '../observability/log';
import { mergeAeroApiAlert, type AeroApiAlertPatch } from '../providers/aeroapi.mock';
import { perFlightLedgerDecision } from '../providers/budget';
import { DurableObjectCostLogger, PROVIDER_CALL_OUTBOX_KIND } from '../providers/cost-log';
import { callRecord } from '../providers/http';
import { budgetGuardFor, providerFor, type RouterDeps } from '../providers/router';
import { eventsArchiveKey, putJsonArchive } from '../r2/archive';
import { type DurableObjectPing, blockOnMigrations } from './base';
import {
  EMPTY_MIGRATION_RESULT,
  type MigrationResult,
  type SqlMigrations,
  runSqlMigrations,
} from './migrate';
import { FLIGHT_TRACKER_MIGRATION_001 } from './migrations/flight-tracker/001';
import { chunkOutbox, sendOutboxChunks } from './outbox';

// ---------------------------------------------------------------------------------------------
// Constants. Every one is a design number from the spec or the facts sheet.
// ---------------------------------------------------------------------------------------------

/**
 * Rows written over one flight's life (creation to `deleteAll()`), the budget the lifecycle
 * test holds a full A2 walk under. Measured on 2026-09-22 (test/workers/flight-tracker.lifecycle):
 * 1,173 rows for the whole life of an on-time flight created at T-48 h, everything included
 * (the seed, two subscribes, 74 alarms at 13 rows each when nothing changed, the persist
 * confirmations, the finish path and the +22 h deletion). The budget is that with about a third
 * of headroom for a delayed flight's extra events (two rows each), and it moves only
 * deliberately: rows written are 70 to 85 percent of the per-flight Durable Object cost.
 */
export const ROWS_WRITTEN_BUDGET_PER_FLIGHT = 1_600;

/** At this many platform retries the handler re-arms 30 s out and returns (ruling J2 step 2). */
export const RETRY_LADDER_MAX = 5;
export const RETRY_BACKSTOP_MS = 30_000;
/** The finished object's last alarm, which calls `deleteAll()`. */
export const FINISH_ALARM_MS = 22 * 60 * 60_000;
/** A finished object whose outbox will not confirm retries this often, this many times. */
const FINISH_RETRY_MS = 60 * 60_000;
const FINISH_MAX_RETRIES = 6;
/** An alarm that fires more than this early is a duplicate delivery and only re-arms. */
const EARLY_ALARM_TOLERANCE_MS = 5_000;
/**
 * A sent row is re-sent by the next flush when it has been unconfirmed this long. Confirmation
 * normally lands within seconds; the grace keeps a burst of coalesced user refreshes from
 * re-sending rows whose acknowledgement is still in flight.
 */
export const OUTBOX_RESEND_GRACE_MS = 10_000;
/** Per user, per flight, per UTC day (ruling J8). */
export const USER_REFRESH_DAILY_CAP = 10;
/** An object that exists but holds no flight (probed, or finished and deleted) cleans up. */
const ABSENT_CLEANUP_MS = 60_000;
/** The tier interval assumed for a fixed-slot window when deciding whether a retry is fresh. */
const FIXED_SLOT_TIER_MS = 15 * 60_000;
/** Block time assumed when a snapshot carries no scheduled arrival. */
const DEFAULT_BLOCK_MS = 3 * 60 * 60_000;

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

interface AttemptRow extends Row {
  slot_ms: number;
  started_at_ms: number;
  retry_count: number;
  outcome: string;
}

interface OutboxRow extends Row {
  seq: number;
  payload: string;
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

/** An outbox row before `seq` and `origin` are added at send time. */
type OutboxDraft =
  | { kind: 'flight_instance'; flightKey: FlightKey; payload: FlightInstanceOutboxPayloadV1 }
  | { kind: 'flight_event'; flightKey: FlightKey; payload: FlightEventOutboxPayloadV1 }
  | { kind: typeof PROVIDER_CALL_OUTBOX_KIND; flightKey: FlightKey; payload: ProviderCallRecord };

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

/** What step 1 decided; the rest of the alarm only executes it. */
type AlarmPlan =
  | { readonly kind: 'cleanup' }
  | { readonly kind: 'finish_alarm' }
  | { readonly kind: 'exhausted' }
  | { readonly kind: 'rearm'; readonly at: number }
  | { readonly kind: 'skip_io'; readonly slot: number }
  | { readonly kind: 'stopped'; readonly slot: number }
  | { readonly kind: 'finish'; readonly reason: FinishReason }
  | {
      readonly kind: 'poll';
      readonly slot: number;
      readonly trigger: ProviderCallTrigger;
      readonly provider: FlightDataProvider;
      readonly expectedPe: number;
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

function operationFor(provider: FlightDataProvider): string {
  return provider.id === 'aeroapi' ? 'flight_by_id' : 'flight_status';
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
  static readonly SCHEMA_VERSION = 1;

  /** Append only, in order. Index 0 is migration id 1. */
  static readonly MIGRATIONS: SqlMigrations = [FLIGHT_TRACKER_MIGRATION_001];

  /**
   * Test seams, set through `runInDurableObject` and never over RPC: where the outbox is sent,
   * where the KV snapshot and the R2 archive go, and the router's adapter overrides (a
   * throwing provider, for the retries test). Production never touches them.
   */
  outboxSink: Pick<Queue, 'sendBatch'>;
  kv: Pick<KVNamespace, 'put'>;
  bucket: Pick<R2Bucket, 'put'>;
  providerDeps: RouterDeps = {};
  /** What the last flush sent; read by the lifecycle test for the observed chunk sizes. */
  flushStats: FlushStats = NO_FLUSH;
  /** Rows written by this in-memory instance over its life, every entry point included. */
  rowsWrittenLifetime = 0;
  rowsReadLifetime = 0;

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;
  readonly #log: Logger;
  #testClockMs: number | null = null;
  #inflight: Promise<ApplyOutcome> | null = null;
  #counters: RowCounters = { read: 0, written: 0 };
  #seqAlloc: { next: number; dirty: boolean } | null = null;
  /** What the alarm's `attempts` row is finally marked with; written by `#recordAttempt`. */
  #attemptOutcome: { outcome: string; providerCallId: string | null } | null = null;
  #deleted = false;
  #cleanupArmed = false;
  #kvInFlight: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#log = createLogger({ durable_object: 'FlightTracker', name: ctx.id.name ?? 'unnamed' });
    this.outboxSink = env.PERSIST_QUEUE;
    this.kv = env.CACHE;
    this.bucket = env.PRIVATE_BUCKET;
    blockOnMigrations(ctx, FlightTracker.MIGRATIONS, (result) => {
      this.#schema = result;
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

  /** Creates the tracker from a status the DesignatorResolver fetched (ruling J9). */
  async seed(input: unknown): Promise<Exact<SeedResponseV1>> {
    const request = parseRpcRequest(SeedRequestV1, input);
    this.#ensureSchema();
    const now = this.#now();
    const key = request.flightKey;
    const status: FlightStatus = { ...request.status, key };
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
        this.#applyStatus(existing, stored, status, now, request.trigger, undefined, true);
        const updated = this.#flight();
        return this.#seedResponse('already', updated ?? existing);
      }
      const cadence = cadenceById(request.cadence);
      this.#exec(
        `INSERT INTO flight (id, key, cadence, phase, version, snapshot, search_designator,
                             scheduled_out_ms, scheduled_in_ms, estimated_in_ms, actual_off_ms,
                             actual_on_ms, actual_in_ms, operator_source, created_at_ms,
                             updated_at_ms)
         VALUES (1, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
      const { softCapPe, hardCapPe } = this.#caps();
      this.#exec(
        'INSERT INTO budget (id, flight_id, soft_cap_pe, hard_cap_pe) VALUES (1, 1, ?, ?)',
        softCapPe,
        hardCapPe,
      );
      this.#exec('INSERT INTO kv_debounce (id, flight_id) VALUES (1, 1)');
      const row = this.#requireFlight();
      this.#appendEvent(row, now, {
        type: 'created',
        field: 'trigger',
        newValue: request.trigger,
        source: 'system',
      });
      const next = this.#schedule(row, now);
      if (next.finish !== null) {
        // Nothing left to poll (the flight already arrived, or was cancelled): straight to the
        // finish path once this transaction commits.
        this.#exec('UPDATE flight SET next_refresh_at_ms = NULL WHERE id = 1');
      } else {
        this.#exec('UPDATE flight SET next_refresh_at_ms = ? WHERE id = 1', next.at);
        this.#setAlarm(next.at);
      }
      const seeded = this.#requireFlight();
      this.#appendInstance(seeded, now);
      return this.#seedResponse('seeded', seeded);
    });
    if (response.status === 'seeded' && response.nextRefreshAt === null) {
      const reason = this.#pendingFinishReason();
      if (reason !== null) {
        await this.#finish(now, reason);
        return { ...response, phase: 'finished' };
      }
    }
    await this.#flushOutbox(now);
    this.#scheduleKv(now);
    return response;
  }

  async subscribe(input: unknown): Promise<Exact<SubscribeResponseV1>> {
    const request = parseRpcRequest(SubscribeRequestV1, input);
    this.#ensureSchema();
    const row = this.#flight();
    if (row === null) {
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
    // A fetch in flight is joined, never raced: the answer carries the fresh snapshot.
    if (this.#inflight !== null) {
      await this.#inflight.catch(() => undefined);
    }
    const now = this.#now();
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
      return { rpcVersion: RPC_SCHEMA_VERSION, status: 'absent', subscriberCount: 0 };
    }
    const status = this.#tx((): 'unsubscribed' | 'absent' => {
      const before = this.#count('subscribers');
      this.#exec('DELETE FROM subscribers WHERE subscription_id = ?', request.subscriptionId);
      return this.#count('subscribers') < before ? 'unsubscribed' : 'absent';
    });
    return { rpcVersion: RPC_SCHEMA_VERSION, status, subscriberCount: this.#count('subscribers') };
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
   * A refresh outside the cadence: a user's pull-to-refresh (capped per user per day, its cost
   * on the separate sub-budget that never debits the scheduled cadence), the reconcile cron
   * re-arming an abandoned tracker, or an operator. Coalesced onto a fetch in flight.
   */
  async forceRefresh(input: unknown): Promise<Exact<ForceRefreshResponseV1>> {
    const request = parseRpcRequest(ForceRefreshRequestV1, input);
    this.#ensureSchema();
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
      await this.#inflight.catch(() => undefined);
      return this.#refreshResponse('coalesced');
    }
    if (request.reason === 'user_refresh') {
      const userId = request.userId;
      if (userId === undefined) {
        throw new RpcRequestError('invalid_request', 'user_refresh needs a userId');
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
    await this.#poll(trigger, now, null);
    return this.#refreshResponse('refreshed');
  }

  getCostLedger(): Exact<GetCostLedgerResponseV1> {
    this.#ensureSchema();
    const row = this.#flight();
    if (row === null) {
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
   * event whose payload is not a patch, is a re-read through the coalesced refresh path.
   */
  async ingestProviderEvent(input: unknown): Promise<Exact<IngestProviderEventResponseV1>> {
    const event = parseRpcRequest(ProviderEventV1, input);
    this.#ensureSchema();
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
      if (this.#inflight !== null) {
        await this.#inflight.catch(() => undefined);
      }
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
          false,
        );
      });
      await this.#flushOutbox(now);
      this.#scheduleKv(now);
      return { rpcVersion: RPC_SCHEMA_VERSION, outcome: 'merged', version: applied.version };
    }
    if (this.#inflight !== null) {
      await this.#inflight.catch(() => undefined);
      return {
        rpcVersion: RPC_SCHEMA_VERSION,
        outcome: 'refreshed',
        reason: 'coalesced',
        version: this.#requireFlight().version,
      };
    }
    const outcome = await this.#poll('provider_alert', now, null);
    return { rpcVersion: RPC_SCHEMA_VERSION, outcome: 'refreshed', version: outcome.version };
  }

  /** The persist consumer's confirmation: the named seqs of this lifetime are stored. */
  confirmPersisted(input: unknown): Exact<ConfirmPersistedResponseV1> {
    const request = parseRpcRequest(ConfirmPersistedRequestV1, input);
    this.#ensureSchema();
    const row = this.#flight();
    if (row === null || row.created_at_ms !== request.epochMs) {
      return {
        rpcVersion: RPC_SCHEMA_VERSION,
        deleted: 0,
        remaining: row === null ? 0 : this.#count('outbox'),
        matched: false,
      };
    }
    const deleted = this.#tx((): number => {
      let removed = 0;
      for (let i = 0; i < request.seqs.length; i += 100) {
        const chunk = request.seqs.slice(i, i + 100);
        const before = this.#count('outbox');
        this.#exec(
          `DELETE FROM outbox WHERE seq IN (${chunk.map(() => '?').join(', ')})`,
          ...chunk,
        );
        removed += before - this.#count('outbox');
      }
      return removed;
    });
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
    if (row === null) {
      this.#armAbsentCleanup(this.#now());
      return {
        rpcVersion: RPC_SCHEMA_VERSION,
        flightKey: null,
        phase: 'absent',
        alarmAt: iso(alarm),
        inflight: this.#inflight !== null,
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
      case 'exhausted':
      case 'rearm':
        this.#log.info('flight_tracker_alarm_rearmed', {
          kind: plan.kind,
          retry_count: retryCount,
        });
        return;
      case 'finish':
        await this.#finish(now, plan.reason);
        return;
      case 'stopped':
        await this.#flushOutbox(now);
        this.#scheduleKv(now);
        this.#recordAttempt(plan.slot);
        return;
      case 'skip_io':
        // The retry found its slot already attempted: resend what the failed attempt left
        // behind and leave the provider alone.
        await this.#flushOutbox(now);
        this.#scheduleKv(now);
        this.#recordAttempt(plan.slot);
        return;
      case 'poll':
        break;
    }

    // Steps 3 to 5.
    const outcome = await this.#poll(plan.trigger, now, plan.slot, plan.provider, plan.expectedPe);
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
      return { kind: 'cleanup' };
    }
    if (row.phase === 'finished') {
      return { kind: 'finish_alarm' };
    }
    if (retryCount >= RETRY_LADDER_MAX) {
      // Step 2: re-arm 30 s out and return. Never set-then-throw.
      const at = now + RETRY_BACKSTOP_MS;
      if (row.attempt_slot_ms !== null) {
        this.#exec(
          `UPDATE attempts SET retry_count = ?, outcome = 'retry_ladder_exhausted', finished_at_ms = ?
            WHERE slot_ms = ?`,
          retryCount,
          now,
          row.attempt_slot_ms,
        );
      }
      this.#exec(
        'UPDATE flight SET next_refresh_at_ms = ?, updated_at_ms = ? WHERE id = 1',
        at,
        now,
      );
      this.#setAlarm(at);
      return { kind: 'exhausted' };
    }
    const slotTarget = row.next_refresh_at_ms ?? scheduledTime ?? now;
    if (!isRetry && now + EARLY_ALARM_TOLERANCE_MS < slotTarget) {
      // A duplicate delivery, or an alarm that fired before its time: keep the schedule.
      this.#setAlarm(slotTarget);
      return { kind: 'rearm', at: slotTarget };
    }
    if (isRetry && row.attempt_slot_ms !== null) {
      const attempt = this.#exec<AttemptRow>(
        'SELECT slot_ms, started_at_ms, retry_count, outcome FROM attempts WHERE slot_ms = ?',
        row.attempt_slot_ms,
      )[0];
      if (
        attempt !== undefined &&
        now - attempt.started_at_ms < this.#tierIntervalMs(row, attempt.slot_ms)
      ) {
        this.#exec(
          `UPDATE attempts SET retry_count = ?,
                  outcome = CASE WHEN outcome = 'started' THEN 'skipped_retry' ELSE outcome END
            WHERE slot_ms = ?`,
          retryCount,
          attempt.slot_ms,
        );
        return { kind: 'skip_io', slot: attempt.slot_ms };
      }
    }
    const slot = slotTarget;
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
    const cadence = cadenceById(row.cadence);
    const source: CadenceSource = windowAt(cadence, context)?.source ?? 'aerodatabox';
    const scheduledOut = new Date(context.scheduledOut);
    const provider = providerFor(source, this.env, this.providerDeps, {
      scheduledOut,
      now: new Date(now),
    });
    const expectedPe = pollEquivalents(provider.id, operationFor(provider));
    const budget = this.#budget();
    const decision =
      trigger === 'alarm'
        ? perFlightLedgerDecision({
            spentPe: budget.scheduled_pe,
            requestPe: expectedPe,
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
      this.#appendInstance(stopped, now);
      this.#setAlarm(at);
      return { kind: 'stopped', slot };
    }
    if (decision === 'soft_cap' && budget.stretched === 0) {
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
    const next = this.#schedule(row, now, trigger === 'reconcile');
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
    this.#debit(budget, trigger, expectedPe);
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
    return { kind: 'poll', slot, trigger, provider, expectedPe, finishAfter: next.finish !== null };
  }

  // -------------------------------------------------------------------------------------------
  // Steps 3 to 5, shared by the alarm and the refresh paths.
  // -------------------------------------------------------------------------------------------

  /**
   * Fetch, apply, flush. `#inflight` is the promise `subscribe`, `forceRefresh` and
   * `ingestProviderEvent` join while it is set. A refresh outside the cadence passes no slot,
   * no provider (the router is asked for the current window) and no pre-debited cost.
   */
  async #poll(
    trigger: ProviderCallTrigger,
    now: number,
    slot: number | null,
    provider?: FlightDataProvider,
    expectedPe?: number,
  ): Promise<ApplyOutcome> {
    const run = async (): Promise<ApplyOutcome> => {
      const row = this.#requireFlight();
      const snapshot = this.#snapshotOf(row);
      let adapter = provider;
      let pe = expectedPe;
      if (adapter === undefined || pe === undefined) {
        const context = this.#cadenceContext(row, now);
        const source: CadenceSource =
          context === null
            ? 'aerodatabox'
            : (windowAt(cadenceById(row.cadence), context)?.source ?? 'aerodatabox');
        adapter = providerFor(source, this.env, this.providerDeps, {
          scheduledOut: new Date(row.scheduled_out_ms ?? now),
          now: new Date(now),
        });
        pe = pollEquivalents(adapter.id, operationFor(adapter));
        this.#tx(() => {
          this.#debit(this.#budget(), trigger, pe ?? 0);
        });
      }
      const result = await this.#fetch(row, snapshot, adapter, trigger, pe);
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
    try {
      return await inflight;
    } finally {
      if (this.#inflight === inflight) {
        this.#inflight = null;
      }
    }
  }

  /** Step 3. Never throws for a provider problem; the record says what happened. */
  async #fetch(
    row: FlightRow,
    snapshot: FlightStatus,
    provider: FlightDataProvider,
    trigger: ProviderCallTrigger,
    expectedPe: number,
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
    const designator = lookupDesignator(row, snapshot);
    const carrier =
      designator.code.length === 3 ? { icao: designator.code } : { iata: designator.code };
    const startedAt = new Date(this.#now());
    try {
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
      return { status, records: [...buffered, result.call], expectedPe, trigger };
    } catch (error) {
      // A throw out of the adapter (a mapping bug, a key it cannot form) is a provider error, not
      // a storage one: recorded at zero cost and never retried through the alarm ladder.
      this.#log.error('flight_tracker_provider_threw', errorFields(error));
      const record = callRecord({
        ctx,
        provider: provider.id,
        operation: operationFor(provider),
        startedAt,
        finishedAt: new Date(this.#now()),
        result: 'error',
        billed: false,
        error: `thrown:${error instanceof Error ? error.message : String(error)}`,
      });
      return { status: null, records: [...buffered, record], expectedPe, trigger };
    }
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
      const next = this.#schedule(current, now, false);
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
    return this.#applyStatus(current, previous, status, now, result.trigger, lastId, false, units);
  }

  /** Replaces the snapshot when it changed: events, scalars, version, outbox, schedule. */
  #applyStatus(
    row: FlightRow,
    previous: FlightStatus,
    next: FlightStatus,
    now: number,
    trigger: ProviderCallTrigger,
    providerCallId: string | undefined,
    fromSeed: boolean,
    units = 0,
  ): ApplyOutcome {
    const drafts = diffSnapshots(previous, next, next.source, providerCallId);
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
              provider_cost_units = provider_cost_units + ?, updated_at_ms = ?
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
      now,
    );
    const current = this.#requireFlight();
    const schedule = this.#schedule(current, now, trigger === 'reconcile');
    const rescheduled = this.#reschedule(current, schedule, now);
    if (changed || rescheduled || fromSeed) {
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
  #schedule(
    row: FlightRow,
    now: number,
    afterReconcilePoll = false,
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

  #cadenceContext(row: FlightRow, now: number): CadenceContext | null {
    if (row.scheduled_out_ms === null) {
      return null;
    }
    const scheduledIn = row.scheduled_in_ms ?? row.scheduled_out_ms + DEFAULT_BLOCK_MS;
    const context: CadenceContext = {
      now: new Date(now),
      scheduledOut: new Date(row.scheduled_out_ms),
      scheduledIn: new Date(scheduledIn),
      phase: row.phase as TrackerPhase,
    };
    if (row.estimated_in_ms !== null) {
      context.estimatedIn = new Date(row.estimated_in_ms);
    }
    if (row.actual_off_ms !== null) {
      context.actualOff = new Date(row.actual_off_ms);
    }
    if (row.actual_on_ms !== null) {
      context.actualOn = new Date(row.actual_on_ms);
    }
    if (row.actual_in_ms !== null) {
      context.actualIn = new Date(row.actual_in_ms);
    }
    return context;
  }

  /** The nominal interval of the window that owns `slot`, for the retry freshness rule. */
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
  // Finish path (ruling J12).
  // -------------------------------------------------------------------------------------------

  async #finish(now: number, reason: FinishReason): Promise<void> {
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
    const archiveKey = await this.#archiveEvents(row.key as FlightKey);
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
    this.#scheduleKv(now);
  }

  /** The +22 h alarm: re-read phase and outbox in one synchronous block, then `deleteAll()`. */
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
          };
    });
    if (state === null || state.phase !== 'finished') {
      return;
    }
    if (state.unconfirmed > 0) {
      await this.#flushOutbox(now);
    }
    if (!state.archived) {
      const archiveKey = await this.#archiveEvents(state.key);
      if (archiveKey !== null) {
        this.#tx(() => {
          this.#exec('UPDATE flight SET events_r2_key = ? WHERE id = 1', archiveKey);
        });
      }
    }
    const remaining = this.#count('outbox');
    if (remaining > 0 && state.attempts < FINISH_MAX_RETRIES) {
      this.#tx(() => {
        this.#exec(
          'UPDATE flight SET finish_alarm_attempts = finish_alarm_attempts + 1, updated_at_ms = ? WHERE id = 1',
          now,
        );
        this.#setAlarm(now + FINISH_RETRY_MS);
      });
      this.#log.warn('flight_tracker_finish_deferred', {
        unconfirmed: remaining,
        attempts: state.attempts + 1,
      });
      return;
    }
    if (remaining > 0) {
      this.#log.error('flight_tracker_outbox_abandoned', { unconfirmed: remaining });
    }
    await this.#deleteEverything();
  }

  async #archiveEvents(key: FlightKey): Promise<string | null> {
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
    const archiveKey = eventsArchiveKey(key);
    try {
      await putJsonArchive(this.bucket, archiveKey, { flightKey: key, events });
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
   * Sends every unsent row, and every sent row that has waited `OUTBOX_RESEND_GRACE_MS` without
   * confirmation, in byte-chunked batches; marks `sent_at` on the accepted rows only. Never
   * throws: a failed send leaves the rows for the next flush. Not inside a transaction.
   */
  async #flushOutbox(now: number): Promise<void> {
    const row = this.#flight();
    if (row === null) {
      return;
    }
    const rows = this.#exec<OutboxRow>(
      'SELECT seq, payload FROM outbox WHERE sent_at_ms IS NULL OR sent_at_ms <= ? ORDER BY seq',
      now - OUTBOX_RESEND_GRACE_MS,
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
        for (let i = 0; i < outcome.sentSeqs.length; i += 100) {
          const chunk = outcome.sentSeqs.slice(i, i + 100);
          this.#exec(
            `UPDATE outbox SET sent_at_ms = ? WHERE seq IN (${chunk.map(() => '?').join(', ')})`,
            now,
            ...chunk,
          );
        }
      });
    }
  }

  /**
   * The KV snapshot, debounced with stored state (never `setTimeout`) and written off the
   * critical path. A suppressed write marks `pending`; the next flush writes it.
   */
  #scheduleKv(now: number): void {
    const row = this.#flight();
    if (row === null) {
      return;
    }
    const debounce = this.#exec<{ last_write_at_ms: number; pending: number }>(
      'SELECT last_write_at_ms, pending FROM kv_debounce WHERE id = 1',
    )[0];
    const last = debounce?.last_write_at_ms ?? 0;
    if (now - last < SNAPSHOT_KV_DEBOUNCE_MS || this.#kvInFlight !== null) {
      if (debounce?.pending !== 1) {
        this.#exec('UPDATE kv_debounce SET pending = 1 WHERE id = 1');
      }
      return;
    }
    this.#exec('UPDATE kv_debounce SET last_write_at_ms = ?, pending = 0 WHERE id = 1', now);
    const write = writeSnapshotKv(
      this.kv,
      {
        rpcVersion: 1,
        flightKey: row.key as FlightKey,
        phase: row.phase as TrackerHealthPhase,
        version: row.version,
        snapshot: this.#snapshotOf(row),
        nextRefreshAt: iso(row.next_refresh_at_ms),
        writtenAt: new Date(now).toISOString(),
      },
      this.#log,
    )
      .then(() => undefined)
      .finally(() => {
        this.#kvInFlight = null;
      });
    this.#kvInFlight = write;
    this.ctx.waitUntil(write);
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

  #snapshotOf(row: FlightRow): FlightStatus {
    return FlightStatusSchema.parse(JSON.parse(row.snapshot));
  }

  #caps(): { softCapPe: number; hardCapPe: number } {
    // The shared caps: 2x and 4x the expected A2 spend, the same defaults
    // `perFlightLedgerDecision` applies. Stored on the budget row so the ledger response can
    // show them and a test can lower them without changing the rule.
    return { softCapPe: A2_SOFT_CAP_PE, hardCapPe: A2_HARD_CAP_PE };
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

  /** The `flight_instances` row as of `row`, into the outbox. */
  #appendInstance(row: FlightRow, now: number): void {
    const key = row.key as FlightKey;
    const parts = parseFlightKey(key);
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
      nextRefreshAt: iso(row.next_refresh_at_ms),
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
