/**
 * ProviderBudget Durable Object (increment 6).
 *
 * One object per provider per UTC day, named `${provider}:${utcDate}` (`aerodatabox:2026-09-22`),
 * holding the day's unit ledger, the per-second token bucket and the kill switch. It is the only
 * budget authority there is: the rate limit binding cannot express a daily budget (`period` is 10
 * or 60 seconds), counts per Cloudflare location and is documented as "intentionally designed to
 * not be used as an accurate accounting system", and AeroDataBox may bill overage before it
 * rejects, so this object's hard cap is the only real ceiling (facts sheet section 5).
 *
 * THE ANTI-PATTERN, AND WHY IT IS ACCEPTED. Cloudflare's Rules of Durable Objects name "using a
 * Durable Object for global rate limiting or global counters" as an anti-pattern: one object is
 * one thread in one location, and every debit is a billed request plus a cross-colo round trip.
 * The numbers survive it. At 100,000 flights a month, cadence A2 makes about 88 billable calls
 * per flight (74 AeroAPI polls, 12 alert deliveries, 1 to 4 AeroDataBox calls), so 8.8 million
 * debits a month is about 3.4 debits a second on average and about 14 a second at the daily peak,
 * against the 200 to 500 requests a second one object sustains for a storage-writing workload:
 * 14x to 35x headroom at peak. Two things keep it cheap: a debit is one synchronous
 * `transactionSync` (two or three rows written) and nothing else, and the "is this provider over
 * budget" read never reaches the object at all while the provider is blocked: `ProviderBudgetGuard`
 * reads a 60 second KV copy (`budget:{provider}:{date}` in `CACHE`) that this object writes.
 *
 * ESCAPE HATCH: shard the day eight ways. The name grows a suffix, `${provider}:${utcDate}:${n}`
 * with `n` in 0..7 (`parseProviderBudgetName` already accepts it), callers pick the shard from a
 * hash of the flight key, and each shard holds one eighth of the cap and of the per-second rate
 * (implemented below). The daily counters then sum eight outbox rows. Take it when the peak nears
 * 100 debits a second, not before: sharding trades exactness at the cap for throughput.
 *
 * What the object does:
 *
 *   - `reserve(request)`: in ONE `transactionSync`, refuse on the kill switch, refuse and trip the
 *     kill switch when the call would pass the daily unit cap, take a token from the bucket
 *     (refilled from its stored state on this read: no `setTimeout` anywhere, which would make
 *     the object non-hibernateable), then debit the ledger. Input gates plus the synchronous
 *     transaction serialise concurrent debits: the cap cannot be overrun by a race. The answer
 *     carries the 70 / 90 / 100 percent ladder rung.
 *   - `release`, `backoff`, `snapshot`, `setKillSwitch`, `configure`.
 *   - Tripping the kill switch writes an outbox row that goes to the `persist` queue at once; the
 *     persist consumer raises the Sentry event (a queue handler has a Sentry client, a Durable
 *     Object RPC does not). A manual kill switch also persists in `CONFIG` KV, so tomorrow's
 *     object starts killed; the automatic one (the daily cap) ends with the day. The brake fails
 *     CLOSED: when the persistent kill switch cannot be read before the day's first decision, the
 *     day starts killed (`persistent:unknown`, with the same alert) and re-reads it every 30 s,
 *     lifting the stop on its own once the read says there is none. The re-read runs on the next
 *     call that reaches the object; the guard's fast path answers from the blocked KV copy until
 *     that expires, so through `ProviderBudgetGuard` the stop lifts within `BUDGET_KV_TTL_SECONDS`
 *     (60 s) rather than 30 s.
 *   - The alarm, armed when the day's config is first written (never in the constructor), fires at
 *     00:05 UTC the next day: it writes the final counters to the outbox, sends them, and calls
 *     `deleteAll()`, because storage bills until it is deleted.
 *   - From 00:05 the next day the object is READ-ONLY: a late call never recreates the day (no
 *     config, no alarm, no second daily row). `reserve` refuses with `routing_rule`, `release`
 *     and `backoff` do nothing, `configure` and `setKillSwitch` change nothing and answer the
 *     closed snapshot (`dayClosed: true`, and `persisted: false` for the switch), and `snapshot`
 *     reports the day closed. Nothing throws across the RPC boundary for it. Every outbox origin
 *     also carries the object's lifetime epoch (`config.created_at_ms`), so `(origin, seq)` stays
 *     unique even if a day were recreated.
 *   - The KV fast-path copy is written in the background (`ctx.waitUntil`), one write at a time,
 *     and never on a debit's critical path: a slow or failing KV adds nothing to a reservation's
 *     latency, and a failed write waits out KV's one-write-a-second limit before the next try.
 *
 * Durable Objects never open Postgres (ADR 0007); every counter leaves through the outbox.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  UnknownOperationError,
  costUnits,
  type BudgetDecision,
  type BudgetDenialReason,
  type BudgetRequest,
  type ProviderId,
} from '@planeahead/shared';
import type { Env } from '../env';
import { createLogger, errorFields, type Logger } from '../observability/log';
import {
  BUDGET_KV_TTL_SECONDS,
  PROVIDER_BUDGET_OUTBOX_KINDS,
  budgetKvKey,
  finaliseAtMs,
  ladderFor,
  parseProviderBudgetName,
  type BudgetKvCopy,
  type Ladder,
  type ProviderBudgetIdentity,
} from '../providers/budget';
import {
  boardsCapUnits,
  boardsShareSpent,
  checkBoards,
  isBoardTrigger,
  type BoardsLedger,
} from '../providers/boards-budget';
import {
  ADB_BOARD_AIRPORTS_PER_HOUR,
  budgetDefaults,
  providerSettings,
  type BudgetProvider,
} from '../providers/config';
import {
  backoff as bucketBackoff,
  bucketForLimit,
  initialBucket,
  take,
  type TokenBucketConfig,
  type TokenBucketState,
} from '../providers/token-bucket';
import { type DurableObjectPing, blockOnMigrations } from './base';
import {
  EMPTY_MIGRATION_RESULT,
  type MigrationResult,
  type SqlMigrations,
  runSqlMigrations,
} from './migrate';
import { PROVIDER_BUDGET_MIGRATION_001 } from './migrations/provider-budget/001';
import { PROVIDER_BUDGET_MIGRATION_002 } from './migrations/provider-budget/002';

/** The `CONFIG` KV key of a manual kill switch that outlives the day. */
export function persistentKillKey(provider: BudgetProvider): string {
  return `provider-budget:kill:${provider}`;
}

/** Retry an unsent outbox this long after a failed send. */
const OUTBOX_RETRY_MS = 30_000;
/** Refresh the KV copy at least this often while debits flow, so it never lapses while hot. */
const KV_REFRESH_MS = 10_000;
/** KV allows one write per second per key. */
const KV_MIN_WRITE_GAP_MS = 1_000;
/** Shards divide the cap and the rate. */
const SHARDS = 8;
/**
 * Re-read an unreadable persistent kill switch this often while the day runs killed. It runs on
 * the next call that reaches the object; the blocked KV copy keeps guard calls away for up to
 * `BUDGET_KV_TTL_SECONDS`, which is the real bound on recovery through the guard.
 */
const PERSISTENT_KILL_RETRY_MS = 30_000;
/** The kill reason of a day that started killed because the persistent switch was unreadable. */
export const PERSISTENT_KILL_UNKNOWN = 'persistent:unknown';
/** How long after a late touch of a closed day the storage it recreated is deleted again. */
const CLOSED_DAY_CLEANUP_MS = 60_000;

/**
 * Provider units one reservation debits, or null for an operation `cost.ts` does not price.
 * Widened to `ProviderId` on purpose: the operation arrives over RPC as a string.
 */
function unitsFor(provider: ProviderId, operation: string): number | null {
  try {
    return costUnits(provider, operation);
  } catch (error) {
    if (error instanceof UnknownOperationError) {
      return null;
    }
    throw error;
  }
}

/** The bucket for a per-second limit (at most that many grants in any one-second window). */
function bucketFor(perSecondLimit: number): TokenBucketConfig {
  return bucketForLimit(perSecondLimit);
}

export interface BudgetSnapshot {
  readonly provider: BudgetProvider;
  readonly utcDate: string;
  readonly shard: number | null;
  readonly units: number;
  readonly pollEquivalents: number;
  readonly calls: number;
  readonly releasedUnits: number;
  readonly byTrigger: Readonly<Record<string, { units: number; pe: number; calls: number }>>;
  readonly denials: Readonly<Record<string, number>>;
  readonly dailyUnitCap: number;
  readonly perSecondLimit: number;
  readonly killSwitch: boolean;
  readonly killReason: string | null;
  readonly ladder: Ladder;
  readonly percentUsed: number;
  readonly tokens: number;
  readonly finalised: boolean;
  /**
   * True from 00:05 UTC the next day: the object is read-only and the counters are final (or,
   * when the day's storage was already deleted, gone: every counter then reads zero).
   */
  readonly dayClosed: boolean;
  /** The boards share and the hourly airport cap (increment 18), for the admin page. */
  readonly boards: BoardsSnapshot;
}

export interface BoardsSnapshot {
  readonly spentUnits: number;
  readonly capUnits: number;
  /** 0 to 1; a day without a cap reads as spent. */
  readonly shareSpent: number;
  readonly airportsPerHourCap: number;
  /** The airports counted in the current UTC hour, first refreshed first. */
  readonly airportsThisHour: readonly string[];
}

/** What `setKillSwitch` answers: the snapshot, and whether `CONFIG` KV took the change. */
export interface KillSwitchResult extends BudgetSnapshot {
  /**
   * False when the `CONFIG` write failed: the switch holds today but will NOT carry into
   * tomorrow's object (on) or will come back tomorrow (off). The admin page shows it.
   */
  readonly persisted: boolean;
}

export interface BudgetConfigPatch {
  readonly dailyUnitCap?: number | undefined;
  readonly perSecondLimit?: number | undefined;
}

type Row = Record<string, string | number | ArrayBuffer | null>;

interface ConfigRow extends Row {
  daily_unit_cap: number;
  per_second_limit: number;
  kill_switch: number;
  kill_reason: string | null;
  finalised: number;
  alarm_at_ms: number | null;
  created_at_ms: number;
}

interface LedgerRow extends Row {
  trigger: string;
  units: number;
  pe: number;
  calls: number;
  released_units: number;
}

interface BucketRow extends Row {
  tokens: number;
  updated_at_ms: number;
  blocked_until_ms: number;
}

interface TotalsRow extends Row {
  units: number;
  pe: number;
  calls: number;
  released_units: number;
}

interface OutboxRow extends Row {
  seq: number;
  kind: string;
  payload: string;
}

/** The queue message one outbox row becomes. */
export interface ProviderBudgetMessage {
  readonly kind: string;
  readonly seq: number;
  /**
   * `provider_budget:${name}@${epoch}` (the epoch is `config.created_at_ms`): with `seq`, the
   * idempotency key on the consumer side, unique per object LIFETIME and not only per name.
   */
  readonly origin: string;
  readonly payload: unknown;
}

class BudgetIdentityError extends Error {
  override readonly name = 'BudgetIdentityError';
}

type PersistentKillState =
  | { readonly state: 'unread' }
  | { readonly state: 'known'; readonly reason: string | null }
  | { readonly state: 'unknown'; readonly retryAtMs: number };

export class ProviderBudget extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 2;

  /** Append only, in order. Index 0 is migration id 1. */
  static readonly MIGRATIONS: SqlMigrations = [
    PROVIDER_BUDGET_MIGRATION_001,
    PROVIDER_BUDGET_MIGRATION_002,
  ];

  /** Test seam: the clock every decision reads. */
  clock: () => number = () => Date.now();
  /** Test seam: where the outbox is sent (the `persist` queue). */
  outboxSink: Pick<Queue, 'sendBatch'>;
  /** Test seam: where the fast-path copy is written (`CACHE`). */
  kv: Pick<KVNamespace, 'put'>;
  /** Test seam: where the persistent manual kill switch lives (`CONFIG`). */
  configKv: Pick<KVNamespace, 'get' | 'put' | 'delete'>;

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;
  readonly #identity: ProviderBudgetIdentity | null;
  readonly #log: Logger;
  #persistentKill: PersistentKillState = { state: 'unread' };
  #deleted = false;
  #alertAppended = false;
  #cleanupArmed = false;
  /** The copy KV last ACCEPTED; a failed write leaves it as it was. */
  #kvSignature = '';
  #kvWrittenAtMs = 0;
  #kvRetryNotBeforeMs = 0;
  #kvInFlight: Promise<void> | null = null;
  #kvDirty = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const name = ctx.id.name;
    this.#identity = name === undefined ? null : parseProviderBudgetName(name);
    this.#log = createLogger({ durable_object: 'ProviderBudget', name: name ?? 'unnamed' });
    this.outboxSink = env.PERSIST_QUEUE;
    this.kv = env.CACHE;
    this.configKv = env.CONFIG;
    blockOnMigrations(ctx, ProviderBudget.MIGRATIONS, (result) => {
      this.#schema = result;
    });
  }

  /** Liveness and schema probe. Cheap, does no I/O, and creates the object if it did not exist. */
  ping(): DurableObjectPing {
    return {
      className: 'ProviderBudget',
      schemaVersion: ProviderBudget.SCHEMA_VERSION,
      appliedVersion: this.#schema.version,
      applied: this.#schema.applied,
    };
  }

  /**
   * Reserves one call. Refusals: `routing_rule` (a request for another provider, or an operation
   * with no price, which would otherwise debit nothing), `provider_kill_switch`,
   * `provider_daily_cap` (which also trips the kill switch) and `provider_rate_limit` with the
   * bucket's `retryAfterMs`. Never throws for a bad request: an exception would cross the RPC
   * boundary into the caller's alarm.
   */
  async reserve(request: BudgetRequest): Promise<BudgetDecision> {
    const identity = this.#requireIdentity();
    if (request.provider !== identity.provider || this.#otherDay(request)) {
      return { allowed: false, reason: 'routing_rule' };
    }
    const units = unitsFor(identity.provider, request.operation);
    if (units === null) {
      this.#log.error('provider_budget_unpriced_operation', { operation: request.operation });
      return { allowed: false, reason: 'routing_rule' };
    }
    const now = this.clock();
    if (this.#dayClosed(now)) {
      this.#log.warn('provider_budget_day_closed', { operation: request.operation });
      this.#armClosedDayCleanup(now);
      return { allowed: false, reason: 'routing_rule' };
    }
    await this.#prepare(now);
    let tripped = false;
    const decision = this.ctx.storage.transactionSync((): BudgetDecision => {
      const config = this.#ensureConfig(now);
      if (config.kill_switch === 1) {
        this.#countDenial('provider_kill_switch');
        return { allowed: false, reason: 'provider_kill_switch' };
      }
      const spent = this.#totals().units;
      if (spent + units > config.daily_unit_cap) {
        this.#countDenial('provider_daily_cap');
        this.#trip(now, 'daily_cap', { spentUnits: spent, dailyUnitCap: config.daily_unit_cap });
        tripped = true;
        return { allowed: false, reason: 'provider_daily_cap' };
      }
      // Increment 18 (ruling B5): board and route-search calls only.
      const boards = isBoardTrigger(request.trigger)
        ? checkBoards(request, units, config.daily_unit_cap, now, this.#boardsLedger())
        : null;
      if (boards !== null && !boards.allowed) {
        this.#countDenial(boards.reason);
        return { allowed: false, reason: boards.reason, boardsShareSpent: boards.shareSpent };
      }
      const bucket = bucketFor(config.per_second_limit);
      const taken = take(this.#bucket(bucket, now), bucket, now);
      this.#saveBucket(taken.state);
      if (!taken.allowed) {
        this.#countDenial('provider_rate_limit');
        return {
          allowed: false,
          reason: 'provider_rate_limit',
          retryAfterMs: taken.retryAfterMs,
        };
      }
      this.#debit(request.trigger, units, request.pollEquivalents);
      if (boards === null) {
        return {
          allowed: true,
          granted: request.pollEquivalents,
          ladder: ladderFor(spent + units, config.daily_unit_cap),
        };
      }
      if (!boards.counted) {
        this.ctx.storage.sql.exec(
          'INSERT INTO board_airports (hour_utc, airport_icao, first_at_ms) VALUES (?, ?, ?)',
          boards.hourUtc,
          boards.airportIcao,
          now,
        );
      }
      return {
        allowed: true,
        granted: request.pollEquivalents,
        ladder: ladderFor(spent + units, config.daily_unit_cap),
        boardsShareSpent: boards.shareAfter,
      };
    });
    // `#trip` and a fail-closed first touch both queue an alert; send it now, once.
    if (this.#takeAlertAppended()) {
      await this.#flushOutbox(now);
    }
    this.#refreshKvCopy(now, tripped);
    return decision;
  }

  /**
   * Gives back a reservation the provider did not bill (a 429, a 503, a non-JSON body) or that
   * was never used: `unusedPollEquivalents` and the matching share of units leave the ledger. The
   * call still counts; the token is not returned, because the request did reach the provider.
   */
  async release(request: BudgetRequest, unusedPollEquivalents: number): Promise<void> {
    const identity = this.#requireIdentity();
    if (
      request.provider !== identity.provider ||
      unusedPollEquivalents <= 0 ||
      this.#otherDay(request)
    ) {
      // A refund for another day's reservation would under-count this day and leave the other
      // day's debit in place; `utcDate` on the request says which day it was debited on.
      return;
    }
    const units = unitsFor(identity.provider, request.operation) ?? 0;
    const share =
      request.pollEquivalents > 0
        ? Math.min(1, unusedPollEquivalents / request.pollEquivalents)
        : 1;
    const refund = units * share;
    const now = this.clock();
    if (this.#dayClosed(now)) {
      this.#armClosedDayCleanup(now);
      return;
    }
    await this.#prepare(now);
    this.ctx.storage.transactionSync(() => {
      this.#ensureConfig(now);
      this.ctx.storage.sql.exec(
        `UPDATE ledger
            SET units = MAX(0, units - ?),
                pe = MAX(0, pe - ?),
                released_units = released_units + ?
          WHERE trigger = ?`,
        refund,
        Math.min(unusedPollEquivalents, request.pollEquivalents),
        refund,
        request.trigger,
      );
    });
    if (this.#takeAlertAppended()) {
      await this.#flushOutbox(now);
    }
    this.#refreshKvCopy(now, false);
  }

  /** The provider pushed back: empty the bucket and block it for `retryAfterMs`. */
  async backoff(retryAfterMs: number): Promise<void> {
    this.#requireIdentity();
    const now = this.clock();
    if (this.#dayClosed(now)) {
      this.#armClosedDayCleanup(now);
      return;
    }
    await this.#prepare(now);
    this.ctx.storage.transactionSync(() => {
      const config = this.#ensureConfig(now);
      const bucket = bucketFor(config.per_second_limit);
      this.#saveBucket(bucketBackoff(this.#bucket(bucket, now), bucket, now, retryAfterMs));
    });
    if (this.#takeAlertAppended()) {
      await this.#flushOutbox(now);
    }
  }

  /**
   * Turns the kill switch on or off by hand. On: every reservation is refused, the alert goes to
   * the `persist` queue (and from there to Sentry), and `CONFIG` KV remembers it so the next
   * day's object starts killed. Off: clears both.
   */
  async setKillSwitch(on: boolean, reason = 'manual'): Promise<KillSwitchResult> {
    const identity = this.#requireIdentity();
    const now = this.clock();
    if (this.#dayClosed(now)) {
      this.#log.warn('provider_budget_day_closed', { action: 'setKillSwitch', on });
      return { ...this.#readClosed(now), persisted: false };
    }
    await this.#prepare(now);
    this.ctx.storage.transactionSync(() => {
      const config = this.#ensureConfig(now);
      if (on && config.kill_switch === 0) {
        this.#trip(now, `manual:${reason}`, {});
      } else if (!on && config.kill_switch === 1) {
        this.ctx.storage.sql.exec(
          'UPDATE config SET kill_switch = 0, kill_reason = NULL, kill_at_ms = NULL, updated_at_ms = ? WHERE id = 1',
          now,
        );
      }
    });
    let persisted = true;
    try {
      if (on) {
        await this.configKv.put(
          persistentKillKey(identity.provider),
          JSON.stringify({ reason, atMs: now }),
        );
      } else {
        await this.configKv.delete(persistentKillKey(identity.provider));
      }
      this.#persistentKill = { state: 'known', reason: on ? reason : null };
    } catch (error) {
      persisted = false;
      this.#log.error('provider_budget_kill_persist_failed', { on, ...errorFields(error) });
    }
    // `#trip` and a fail-closed first touch both queue an alert; send it now, once.
    if (this.#takeAlertAppended()) {
      await this.#flushOutbox(now);
    }
    this.#refreshKvCopy(now, true);
    return { ...this.#snapshot(now), persisted };
  }

  /** Changes the day's cap or per-second limit (the admin page, increment 12; the tests). */
  async configure(patch: BudgetConfigPatch): Promise<BudgetSnapshot> {
    this.#requireIdentity();
    const now = this.clock();
    if (this.#dayClosed(now)) {
      this.#log.warn('provider_budget_day_closed', { action: 'configure' });
      return this.#readClosed(now);
    }
    await this.#prepare(now);
    this.ctx.storage.transactionSync(() => {
      this.#ensureConfig(now);
      if (patch.dailyUnitCap !== undefined) {
        if (!Number.isInteger(patch.dailyUnitCap) || patch.dailyUnitCap < 0) {
          throw new RangeError('dailyUnitCap must be a non-negative integer');
        }
        this.ctx.storage.sql.exec(
          'UPDATE config SET daily_unit_cap = ?, updated_at_ms = ? WHERE id = 1',
          patch.dailyUnitCap,
          now,
        );
      }
      if (patch.perSecondLimit !== undefined) {
        // Validates the limit (a RangeError rolls the whole patch back) before storing it.
        const bucket = bucketFor(patch.perSecondLimit);
        this.ctx.storage.sql.exec(
          'UPDATE config SET per_second_limit = ?, updated_at_ms = ? WHERE id = 1',
          patch.perSecondLimit,
          now,
        );
        this.#saveBucket(initialBucket(bucket, now));
      }
    });
    if (this.#takeAlertAppended()) {
      await this.#flushOutbox(now);
    }
    this.#refreshKvCopy(now, true);
    return this.#snapshot(now);
  }

  /**
   * The day so far. Creates the day's config if this is the first touch of an open day; a closed
   * day is only ever read, and a closed day whose storage is gone reads as zeros.
   */
  async snapshot(): Promise<BudgetSnapshot> {
    this.#requireIdentity();
    const now = this.clock();
    if (this.#dayClosed(now)) {
      return this.#readClosed(now);
    }
    await this.#prepare(now);
    this.ctx.storage.transactionSync(() => {
      this.#ensureConfig(now);
    });
    if (this.#takeAlertAppended()) {
      await this.#flushOutbox(now);
    }
    return this.#snapshot(now);
  }

  /** Test seam: resolves once no fast-path KV write is in flight. */
  async kvCopySettled(): Promise<void> {
    while (this.#kvInFlight !== null) {
      await this.#kvInFlight;
    }
  }

  /**
   * Fires at 00:05 UTC the day after (or sooner, to retry an unsent outbox). Before the due time
   * it only flushes and re-arms. At or after it: final counters into the outbox, send, and
   * `deleteAll()`; a failed send re-arms a minute later instead of deleting unsent rows.
   */
  override async alarm(): Promise<void> {
    const identity = this.#identity;
    if (identity === null) {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (this.#deleted) {
      // Already finalised and deleted by this instance: nothing to recreate or send.
      return;
    }
    this.#ensureSchema();
    const now = this.clock();
    const config = this.#config();
    if (config === null) {
      // Nothing was ever reserved under this name (or it was already deleted): nothing to keep.
      await this.ctx.storage.deleteAll();
      this.#deleted = true;
      return;
    }
    await this.#flushOutbox(now);
    const due = finaliseAtMs(identity.utcDate);
    if (now < due) {
      this.ctx.storage.transactionSync(() => {
        this.#armAlarm(this.#hasUnsent() ? Math.min(due, now + OUTBOX_RETRY_MS) : due, true);
      });
      return;
    }
    this.ctx.storage.transactionSync(() => {
      const current = this.#config();
      if (current !== null && current.finalised === 0) {
        this.#appendOutbox(PROVIDER_BUDGET_OUTBOX_KINDS.daily, this.#snapshot(now), now);
        this.ctx.storage.sql.exec(
          'UPDATE config SET finalised = 1, updated_at_ms = ? WHERE id = 1',
          now,
        );
      }
    });
    const sent = await this.#flushOutbox(now);
    if (!sent || this.#hasUnsent()) {
      this.ctx.storage.transactionSync(() => {
        this.#armAlarm(now + 2 * OUTBOX_RETRY_MS, true);
      });
      return;
    }
    this.#log.info('provider_budget_finalised', { units: this.#totals().units });
    await this.ctx.storage.deleteAll();
    this.#deleted = true;
    this.#kvSignature = '';
  }

  // -------------------------------------------------------------------------------------------
  // Storage helpers. Everything below runs inside a caller's `transactionSync` unless it says
  // otherwise, and none of it awaits.
  // -------------------------------------------------------------------------------------------

  #requireIdentity(): ProviderBudgetIdentity {
    if (this.#identity === null) {
      throw new BudgetIdentityError(
        `ProviderBudget objects are named \${provider}:\${utcDate}; this one is "${String(this.ctx.id.name)}"`,
      );
    }
    return this.#identity;
  }

  /**
   * After `deleteAll()` the tables are gone. Only an OPEN day ever gets here (every entry point
   * refuses a closed day first), so recreating them is safe: it is the same day, not yet final.
   */
  #ensureSchema(): void {
    if (this.#deleted) {
      this.#schema = runSqlMigrations(this.ctx, ProviderBudget.MIGRATIONS);
      this.#deleted = false;
    }
  }

  /** From 00:05 UTC the next day the counters are final and the object is read-only. */
  #dayClosed(now: number): boolean {
    return now >= finaliseAtMs(this.#requireIdentity().utcDate);
  }

  /** A request that names another day's budget than this object's. */
  #otherDay(request: BudgetRequest): boolean {
    return request.utcDate !== undefined && request.utcDate !== this.#requireIdentity().utcDate;
  }

  /** A closed day, read without writing: its final counters, or zeros once they are deleted. */
  #readClosed(now: number): BudgetSnapshot {
    if (this.#deleted || this.#config() === null) {
      this.#armClosedDayCleanup(now);
      return this.#closedSnapshot(now);
    }
    return this.#snapshot(now);
  }

  /**
   * A late touch on a closed day whose storage was already deleted: the constructor's migration
   * run recreated the (empty) schema, which would otherwise bill forever. Deleted again a minute
   * later by the alarm's no-config path, which sends nothing. Never armed at or before `now`, and
   * never when this instance did not recreate anything.
   */
  #armClosedDayCleanup(now: number): void {
    if (this.#cleanupArmed || this.#deleted || this.#schema.applied.length === 0) {
      return;
    }
    if (this.#config() !== null) {
      return;
    }
    this.#cleanupArmed = true;
    void this.ctx.storage.setAlarm(now + CLOSED_DAY_CLEANUP_MS);
  }

  /**
   * Everything an open day needs before its first synchronous decision: the schema, and the
   * persistent kill switch when the day's config does not exist yet (or started killed because
   * it could not be read). The only awaited step; it never runs inside a transaction.
   */
  async #prepare(now: number): Promise<void> {
    this.#ensureSchema();
    const config = this.#config();
    if (config !== null && config.kill_reason !== PERSISTENT_KILL_UNKNOWN) {
      return;
    }
    await this.#readPersistentKill(now);
    if (config === null || this.#persistentKill.state !== 'known') {
      return;
    }
    const known = this.#persistentKill.reason;
    this.ctx.storage.transactionSync(() => {
      const current = this.#config();
      if (current?.kill_reason !== PERSISTENT_KILL_UNKNOWN) {
        return;
      }
      if (known === null) {
        this.ctx.storage.sql.exec(
          'UPDATE config SET kill_switch = 0, kill_reason = NULL, kill_at_ms = NULL, updated_at_ms = ? WHERE id = 1',
          now,
        );
        this.#log.warn('provider_budget_kill_read_recovered', { lifted: true });
      } else {
        this.ctx.storage.sql.exec(
          'UPDATE config SET kill_reason = ?, updated_at_ms = ? WHERE id = 1',
          `persistent:${known}`,
          now,
        );
        this.#log.warn('provider_budget_kill_read_recovered', { lifted: false });
      }
    });
  }

  /** Reads the persistent manual kill switch from `CONFIG`, at most once per retry interval. */
  async #readPersistentKill(now: number): Promise<void> {
    const current = this.#persistentKill;
    if (current.state === 'known' || (current.state === 'unknown' && now < current.retryAtMs)) {
      return;
    }
    const identity = this.#requireIdentity();
    try {
      const stored = await this.configKv.get<{ reason?: unknown }>(
        persistentKillKey(identity.provider),
        'json',
      );
      this.#persistentKill = {
        state: 'known',
        reason:
          stored === null ? null : typeof stored.reason === 'string' ? stored.reason : 'manual',
      };
    } catch (error) {
      this.#persistentKill = { state: 'unknown', retryAtMs: now + PERSISTENT_KILL_RETRY_MS };
      this.#log.error('provider_budget_kill_read_failed', errorFields(error));
    }
  }

  /** Whether the last transaction appended an alert that must be sent now; resets the flag. */
  #takeAlertAppended(): boolean {
    const appended = this.#alertAppended;
    this.#alertAppended = false;
    return appended;
  }

  #config(): ConfigRow | null {
    const rows = this.ctx.storage.sql
      .exec<ConfigRow>(
        'SELECT daily_unit_cap, per_second_limit, kill_switch, kill_reason, finalised, alarm_at_ms, created_at_ms FROM config WHERE id = 1',
      )
      .toArray();
    return rows[0] ?? null;
  }

  /**
   * The day's config, created on first touch from the plan defaults (and the persistent manual
   * kill switch), together with a full token bucket and the finalising alarm. `setAlarm` is not
   * awaited: inside `transactionSync` it is covered by the rollback (facts sheet section 3). The
   * alarm is only ever armed in the future: callers refuse a closed day before getting here, and
   * the guard below holds even if one did not.
   *
   * Fail closed: when the persistent kill switch could not be read (`#prepare` tried), the day
   * starts killed with `persistent:unknown` and the kill-switch alert is queued, exactly as if an
   * operator had stopped the provider; `#prepare` lifts it once a read succeeds.
   */
  #ensureConfig(now: number): ConfigRow {
    const existing = this.#config();
    if (existing !== null) {
      return existing;
    }
    const identity = this.#requireIdentity();
    const defaults = budgetDefaults(identity.provider, providerSettings(this.env));
    const sharded = identity.shard !== undefined;
    const cap = sharded ? Math.floor(defaults.dailyUnitCap / SHARDS) : defaults.dailyUnitCap;
    const rate = sharded ? defaults.perSecondLimit / SHARDS : defaults.perSecondLimit;
    const persistent = this.#persistentKill;
    const killReason =
      persistent.state === 'known'
        ? persistent.reason === null
          ? null
          : `persistent:${persistent.reason}`
        : PERSISTENT_KILL_UNKNOWN;
    const due = finaliseAtMs(identity.utcDate);
    this.ctx.storage.sql.exec(
      `INSERT INTO config (id, provider, utc_date, daily_unit_cap, per_second_limit, kill_switch,
                           kill_reason, kill_at_ms, finalised, alarm_at_ms, created_at_ms,
                           updated_at_ms)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      identity.provider,
      identity.utcDate,
      cap,
      rate,
      killReason === null ? 0 : 1,
      killReason,
      killReason === null ? null : now,
      due > now ? due : null,
      now,
      now,
    );
    this.#saveBucket(initialBucket(bucketFor(rate), now));
    if (due > now) {
      void this.ctx.storage.setAlarm(due);
    }
    if (killReason === PERSISTENT_KILL_UNKNOWN) {
      this.#appendKillAlert(now, PERSISTENT_KILL_UNKNOWN, { configReadFailed: 1 });
    }
    const created = this.#config();
    if (created === null) {
      throw new Error('ProviderBudget config row missing after insert');
    }
    return created;
  }

  /** Moves the alarm earlier (or, with `force`, to exactly `atMs`). */
  #armAlarm(atMs: number, force: boolean): void {
    const config = this.#config();
    const current = config?.alarm_at_ms ?? null;
    if (!force && current !== null && current <= atMs) {
      return;
    }
    void this.ctx.storage.setAlarm(atMs);
    this.ctx.storage.sql.exec('UPDATE config SET alarm_at_ms = ? WHERE id = 1', atMs);
  }

  #bucket(config: TokenBucketConfig, now: number): TokenBucketState {
    const row = this.ctx.storage.sql
      .exec<BucketRow>('SELECT tokens, updated_at_ms, blocked_until_ms FROM bucket WHERE id = 1')
      .toArray()[0];
    return row === undefined
      ? initialBucket(config, now)
      : {
          tokens: row.tokens,
          updatedAtMs: row.updated_at_ms,
          blockedUntilMs: row.blocked_until_ms,
        };
  }

  #saveBucket(state: TokenBucketState): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO bucket (id, tokens, updated_at_ms, blocked_until_ms) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET tokens = excluded.tokens,
                                      updated_at_ms = excluded.updated_at_ms,
                                      blocked_until_ms = excluded.blocked_until_ms`,
      Math.max(0, state.tokens),
      state.updatedAtMs,
      state.blockedUntilMs,
    );
  }

  #debit(trigger: string, units: number, pe: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO ledger (trigger, units, pe, calls) VALUES (?, ?, ?, 1)
       ON CONFLICT (trigger) DO UPDATE SET units = units + excluded.units,
                                           pe = pe + excluded.pe,
                                           calls = calls + 1`,
      trigger,
      units,
      pe,
    );
  }

  /** What the boards decision reads (increment 18): spend by board triggers, airports by hour. */
  #boardsLedger(): BoardsLedger {
    const sql = this.ctx.storage.sql;
    const spent = sql
      .exec<{ units: number }>(
        "SELECT COALESCE(SUM(units), 0) AS units FROM ledger WHERE trigger IN ('board', 'route_search')",
      )
      .one().units;
    return {
      spentUnits: spent,
      counted: (hourUtc, airportIcao) =>
        sql
          .exec(
            'SELECT 1 FROM board_airports WHERE hour_utc = ? AND airport_icao = ?',
            hourUtc,
            airportIcao,
          )
          .toArray().length > 0,
      airportsIn: (hourUtc) =>
        sql
          .exec<{ n: number }>(
            'SELECT COUNT(*) AS n FROM board_airports WHERE hour_utc = ?',
            hourUtc,
          )
          .one().n,
    };
  }

  #boardsSnapshot(now: number, dailyUnitCap: number): BoardsSnapshot {
    const capUnits = boardsCapUnits(dailyUnitCap);
    const spentUnits = this.#boardsLedger().spentUnits;
    const airports = this.ctx.storage.sql
      .exec<{ airport_icao: string }>(
        'SELECT airport_icao FROM board_airports WHERE hour_utc = ? ORDER BY first_at_ms, airport_icao',
        new Date(now).getUTCHours(),
      )
      .toArray();
    return {
      spentUnits,
      capUnits,
      shareSpent: boardsShareSpent(spentUnits, capUnits),
      airportsPerHourCap: ADB_BOARD_AIRPORTS_PER_HOUR,
      airportsThisHour: airports.map((row) => row.airport_icao),
    };
  }

  #countDenial(reason: BudgetDenialReason): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO denials (reason, count) VALUES (?, 1)
       ON CONFLICT (reason) DO UPDATE SET count = count + 1`,
      reason,
    );
  }

  #totals(): { units: number; pe: number; calls: number; releasedUnits: number } {
    const row = this.ctx.storage.sql
      .exec<TotalsRow>(
        `SELECT COALESCE(SUM(units), 0) AS units, COALESCE(SUM(pe), 0) AS pe,
                COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(released_units), 0) AS released_units
           FROM ledger`,
      )
      .one();
    return { units: row.units, pe: row.pe, calls: row.calls, releasedUnits: row.released_units };
  }

  /** Flips the kill switch on and queues the alert. */
  #trip(now: number, reason: string, detail: Readonly<Record<string, number>>): void {
    this.ctx.storage.sql.exec(
      'UPDATE config SET kill_switch = 1, kill_reason = ?, kill_at_ms = ?, updated_at_ms = ? WHERE id = 1',
      reason,
      now,
      now,
    );
    this.#appendKillAlert(now, reason, detail);
  }

  /** Queues the kill-switch alert (the persist consumer raises it in Sentry). */
  #appendKillAlert(now: number, reason: string, detail: Readonly<Record<string, number>>): void {
    const identity = this.#requireIdentity();
    const payload = {
      provider: identity.provider,
      utcDate: identity.utcDate,
      reason,
      atMs: now,
      ...detail,
    };
    this.#appendOutbox(PROVIDER_BUDGET_OUTBOX_KINDS.killSwitch, payload, now);
    this.#alertAppended = true;
    this.#log.error('provider_kill_switch_tripped', payload);
  }

  #appendOutbox(kind: string, payload: unknown, now: number): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO outbox (kind, payload, created_at_ms) VALUES (?, ?, ?)',
      kind,
      JSON.stringify(payload),
      now,
    );
  }

  #hasUnsent(): boolean {
    return (
      this.ctx.storage.sql
        .exec<OutboxRow>('SELECT seq, kind, payload FROM outbox WHERE sent_at_ms IS NULL LIMIT 1')
        .toArray().length > 0
    );
  }

  /**
   * Sends every unsent outbox row to the `persist` queue (NOT inside a transaction: it awaits).
   * On failure the rows stay unsent and the alarm is pulled in to retry; returns whether the
   * send succeeded.
   */
  async #flushOutbox(now: number): Promise<boolean> {
    const identity = this.#requireIdentity();
    const rows = this.ctx.storage.sql
      .exec<OutboxRow>(
        'SELECT seq, kind, payload FROM outbox WHERE sent_at_ms IS NULL ORDER BY seq LIMIT 100',
      )
      .toArray();
    const last = rows.at(-1);
    if (last === undefined) {
      return true;
    }
    const epoch = this.#config()?.created_at_ms ?? 0;
    const origin = `provider_budget:${identity.provider}:${identity.utcDate}${
      identity.shard === undefined ? '' : `:${String(identity.shard)}`
    }@${String(epoch)}`;
    try {
      await this.outboxSink.sendBatch(
        rows.map((row) => ({
          body: {
            kind: row.kind,
            seq: row.seq,
            origin,
            payload: JSON.parse(row.payload) as unknown,
          } satisfies ProviderBudgetMessage,
        })),
      );
    } catch (error) {
      this.#log.error('provider_budget_outbox_send_failed', {
        rows: rows.length,
        ...errorFields(error),
      });
      this.ctx.storage.transactionSync(() => {
        this.#armAlarm(now + OUTBOX_RETRY_MS, false);
      });
      return false;
    }
    this.ctx.storage.sql.exec(
      'UPDATE outbox SET sent_at_ms = ? WHERE sent_at_ms IS NULL AND seq <= ?',
      now,
      last.seq,
    );
    return true;
  }

  #snapshot(now: number): BudgetSnapshot {
    const identity = this.#requireIdentity();
    const config = this.#config();
    const ledger = this.ctx.storage.sql
      .exec<LedgerRow>(
        'SELECT trigger, units, pe, calls, released_units FROM ledger ORDER BY trigger',
      )
      .toArray();
    const denials = this.ctx.storage.sql
      .exec<{ reason: string; count: number }>('SELECT reason, count FROM denials ORDER BY reason')
      .toArray();
    const totals = this.#totals();
    const cap = config?.daily_unit_cap ?? 0;
    const rate = config?.per_second_limit ?? 1;
    const bucket = bucketFor(rate);
    const byTrigger: Record<string, { units: number; pe: number; calls: number }> = {};
    for (const row of ledger) {
      byTrigger[row.trigger] = { units: row.units, pe: row.pe, calls: row.calls };
    }
    return {
      provider: identity.provider,
      utcDate: identity.utcDate,
      shard: identity.shard ?? null,
      units: totals.units,
      pollEquivalents: totals.pe,
      calls: totals.calls,
      releasedUnits: totals.releasedUnits,
      byTrigger,
      denials: Object.fromEntries(denials.map((row) => [row.reason, row.count])),
      dailyUnitCap: cap,
      perSecondLimit: rate,
      killSwitch: config?.kill_switch === 1,
      killReason: config?.kill_reason ?? null,
      ladder: ladderFor(totals.units, cap),
      percentUsed: cap > 0 ? Math.round((totals.units / cap) * 10_000) / 100 : 100,
      tokens: this.#bucket(bucket, now).tokens,
      finalised: config?.finalised === 1,
      dayClosed: this.#dayClosed(now),
      boards: this.#boardsSnapshot(now, cap),
    };
  }

  /** A closed day whose storage is gone: nothing is known any more, and nothing is written. */
  #closedSnapshot(now: number): BudgetSnapshot {
    const identity = this.#requireIdentity();
    return {
      provider: identity.provider,
      utcDate: identity.utcDate,
      shard: identity.shard ?? null,
      units: 0,
      pollEquivalents: 0,
      calls: 0,
      releasedUnits: 0,
      byTrigger: {},
      denials: {},
      dailyUnitCap: 0,
      perSecondLimit: 0,
      killSwitch: false,
      killReason: null,
      ladder: ladderFor(0, 0),
      percentUsed: 0,
      tokens: 0,
      finalised: true,
      dayClosed: this.#dayClosed(now),
      boards: {
        spentUnits: 0,
        capUnits: 0,
        shareSpent: 0,
        airportsPerHourCap: ADB_BOARD_AIRPORTS_PER_HOUR,
        airportsThisHour: [],
      },
    };
  }

  /**
   * Schedules the fast-path copy; never awaited on a caller's path. A change in what a reader
   * decides (blocked or killed) is written as soon as no other write is in flight; a change of
   * ladder rung, or a copy older than `KV_REFRESH_MS` while debits flow, waits out the KV per-key
   * limit of one write a second. A failed write (a 429 included) is logged, keeps the last
   * accepted signature (so the change is still pending) and blocks every write until
   * `KV_MIN_WRITE_GAP_MS` later, so a KV failure costs at most one attempt a second instead of
   * one per debit. A change that arrives while a write is in flight is written when it lands.
   */
  #refreshKvCopy(now: number, force: boolean): void {
    const identity = this.#requireIdentity();
    if (identity.shard !== undefined) {
      // A shard sees an eighth of the day; the copy is the unsharded object's to write.
      return;
    }
    if (this.#deleted) {
      return;
    }
    const config = this.#config();
    if (config === null) {
      return;
    }
    if (this.#kvInFlight !== null) {
      this.#kvDirty = true;
      return;
    }
    const units = this.#totals().units;
    const copy: BudgetKvCopy = {
      provider: identity.provider,
      utcDate: identity.utcDate,
      units,
      dailyUnitCap: config.daily_unit_cap,
      ladder: ladderFor(units, config.daily_unit_cap),
      killSwitch: config.kill_switch === 1,
      blocked: config.kill_switch === 1 || units >= config.daily_unit_cap,
      writtenAtMs: now,
    };
    const decisive = `${String(copy.blocked)}:${String(copy.killSwitch)}`;
    const signature = `${decisive}:${copy.ladder}`;
    const urgent = force || !this.#kvSignature.startsWith(`${decisive}:`);
    const changed = signature !== this.#kvSignature;
    const stale = now - this.#kvWrittenAtMs >= KV_REFRESH_MS;
    if (!urgent && !changed && !stale) {
      return;
    }
    if (now < this.#kvRetryNotBeforeMs) {
      return;
    }
    if (!urgent && now - this.#kvWrittenAtMs < KV_MIN_WRITE_GAP_MS) {
      return;
    }
    this.#kvWrittenAtMs = now;
    this.#kvDirty = false;
    const write = this.kv
      .put(budgetKvKey(identity.provider, identity.utcDate), JSON.stringify(copy), {
        expirationTtl: BUDGET_KV_TTL_SECONDS,
      })
      .then(
        () => {
          this.#kvSignature = signature;
        },
        (error: unknown) => {
          this.#kvRetryNotBeforeMs = now + KV_MIN_WRITE_GAP_MS;
          this.#log.warn('provider_budget_kv_write_failed', errorFields(error));
        },
      )
      .finally(() => {
        this.#kvInFlight = null;
        if (this.#kvDirty) {
          this.#kvDirty = false;
          this.#refreshKvCopy(this.clock(), false);
        }
      });
    this.#kvInFlight = write;
    this.ctx.waitUntil(write);
  }
}
