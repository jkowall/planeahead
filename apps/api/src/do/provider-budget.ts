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
 *     object starts killed; the automatic one (the daily cap) ends with the day.
 *   - The alarm, armed when the day's config is first written (never in the constructor), fires at
 *     00:05 UTC the next day: it writes the final counters to the outbox, sends them, and calls
 *     `deleteAll()`, because storage bills until it is deleted.
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
import { budgetDefaults, providerSettings, type BudgetProvider } from '../providers/config';
import {
  backoff as bucketBackoff,
  bucketConfig,
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

/** The bucket for a per-second limit: one second of burst, never less than one token. */
function bucketFor(perSecondLimit: number): TokenBucketConfig {
  return bucketConfig(perSecondLimit, Math.max(1, perSecondLimit));
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
  /** `provider_budget:${name}`: with `seq`, the idempotency key on the consumer side. */
  readonly origin: string;
  readonly payload: unknown;
}

class BudgetIdentityError extends Error {
  override readonly name = 'BudgetIdentityError';
}

export class ProviderBudget extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 1;

  /** Append only, in order. Index 0 is migration id 1. */
  static readonly MIGRATIONS: SqlMigrations = [PROVIDER_BUDGET_MIGRATION_001];

  /** Test seam: the clock every decision reads. */
  clock: () => number = () => Date.now();
  /** Test seam: where the outbox is sent (the `persist` queue). */
  outboxSink: Pick<Queue, 'sendBatch'>;
  /** Test seam: where the fast-path copy is written (`CACHE`). */
  kv: Pick<KVNamespace, 'put'>;

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;
  readonly #identity: ProviderBudgetIdentity | null;
  readonly #log: Logger;
  #persistentKill: string | null = null;
  #deleted = false;
  #kvSignature = '';
  #kvWrittenAtMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const name = ctx.id.name;
    this.#identity = name === undefined ? null : parseProviderBudgetName(name);
    this.#log = createLogger({ durable_object: 'ProviderBudget', name: name ?? 'unnamed' });
    this.outboxSink = env.PERSIST_QUEUE;
    this.kv = env.CACHE;
    blockOnMigrations(ctx, ProviderBudget.MIGRATIONS, (result) => {
      this.#schema = result;
    });
    const identity = this.#identity;
    if (identity !== null) {
      // A manual kill switch set on an earlier day. Read once per construction, before the
      // first request, so the first `reserve` of the day already sees it.
      void ctx.blockConcurrencyWhile(async () => {
        try {
          const stored = await env.CONFIG.get<{ reason?: unknown }>(
            persistentKillKey(identity.provider),
            'json',
          );
          this.#persistentKill =
            stored === null ? null : typeof stored.reason === 'string' ? stored.reason : 'manual';
        } catch (error) {
          this.#log.warn('provider_budget_kill_read_failed', errorFields(error));
        }
      });
    }
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
    if (request.provider !== identity.provider) {
      return { allowed: false, reason: 'routing_rule' };
    }
    const units = unitsFor(identity.provider, request.operation);
    if (units === null) {
      this.#log.error('provider_budget_unpriced_operation', { operation: request.operation });
      return { allowed: false, reason: 'routing_rule' };
    }
    const now = this.clock();
    this.#ensureSchema();
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
      return {
        allowed: true,
        granted: request.pollEquivalents,
        ladder: ladderFor(spent + units, config.daily_unit_cap),
      };
    });
    if (tripped) {
      await this.#flushOutbox(now);
    }
    await this.#refreshKvCopy(now, tripped);
    return decision;
  }

  /**
   * Gives back a reservation the provider did not bill (a 429, a 503, a non-JSON body) or that
   * was never used: `unusedPollEquivalents` and the matching share of units leave the ledger. The
   * call still counts; the token is not returned, because the request did reach the provider.
   */
  async release(request: BudgetRequest, unusedPollEquivalents: number): Promise<void> {
    const identity = this.#requireIdentity();
    if (request.provider !== identity.provider || unusedPollEquivalents <= 0) {
      return;
    }
    const units = unitsFor(identity.provider, request.operation) ?? 0;
    const share =
      request.pollEquivalents > 0
        ? Math.min(1, unusedPollEquivalents / request.pollEquivalents)
        : 1;
    const refund = units * share;
    const now = this.clock();
    this.#ensureSchema();
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
    await this.#refreshKvCopy(now, false);
  }

  /** The provider pushed back: empty the bucket and block it for `retryAfterMs`. */
  async backoff(retryAfterMs: number): Promise<void> {
    this.#requireIdentity();
    const now = this.clock();
    this.#ensureSchema();
    this.ctx.storage.transactionSync(() => {
      const config = this.#ensureConfig(now);
      const bucket = bucketFor(config.per_second_limit);
      this.#saveBucket(bucketBackoff(this.#bucket(bucket, now), bucket, now, retryAfterMs));
    });
    return Promise.resolve();
  }

  /**
   * Turns the kill switch on or off by hand. On: every reservation is refused, the alert goes to
   * the `persist` queue (and from there to Sentry), and `CONFIG` KV remembers it so the next
   * day's object starts killed. Off: clears both.
   */
  async setKillSwitch(on: boolean, reason = 'manual'): Promise<BudgetSnapshot> {
    const identity = this.#requireIdentity();
    const now = this.clock();
    this.#ensureSchema();
    let tripped = false;
    this.ctx.storage.transactionSync(() => {
      const config = this.#ensureConfig(now);
      if (on && config.kill_switch === 0) {
        this.#trip(now, `manual:${reason}`, {});
        tripped = true;
      } else if (!on && config.kill_switch === 1) {
        this.ctx.storage.sql.exec(
          'UPDATE config SET kill_switch = 0, kill_reason = NULL, kill_at_ms = NULL, updated_at_ms = ? WHERE id = 1',
          now,
        );
      }
    });
    try {
      if (on) {
        await this.env.CONFIG.put(
          persistentKillKey(identity.provider),
          JSON.stringify({ reason, atMs: now }),
        );
      } else {
        await this.env.CONFIG.delete(persistentKillKey(identity.provider));
      }
      this.#persistentKill = on ? reason : null;
    } catch (error) {
      this.#log.error('provider_budget_kill_persist_failed', errorFields(error));
    }
    if (tripped) {
      await this.#flushOutbox(now);
    }
    await this.#refreshKvCopy(now, true);
    return this.#snapshot(now);
  }

  /** Changes the day's cap or per-second limit (the admin page, increment 12; the tests). */
  async configure(patch: BudgetConfigPatch): Promise<BudgetSnapshot> {
    this.#requireIdentity();
    const now = this.clock();
    this.#ensureSchema();
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
        const bucket = bucketFor(patch.perSecondLimit);
        this.ctx.storage.sql.exec(
          'UPDATE config SET per_second_limit = ?, updated_at_ms = ? WHERE id = 1',
          bucket.ratePerSecond,
          now,
        );
        this.#saveBucket(initialBucket(bucket, now));
      }
    });
    await this.#refreshKvCopy(now, true);
    return this.#snapshot(now);
  }

  /** The day so far. Creates the day's config if this is the first touch. */
  snapshot(): BudgetSnapshot {
    this.#requireIdentity();
    const now = this.clock();
    this.#ensureSchema();
    this.ctx.storage.transactionSync(() => {
      this.#ensureConfig(now);
    });
    return this.#snapshot(now);
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

  /** After `deleteAll()` the tables are gone; a later call on the same instance recreates them. */
  #ensureSchema(): void {
    if (this.#deleted) {
      this.#schema = runSqlMigrations(this.ctx, ProviderBudget.MIGRATIONS);
      this.#deleted = false;
    }
  }

  #config(): ConfigRow | null {
    const rows = this.ctx.storage.sql
      .exec<ConfigRow>(
        'SELECT daily_unit_cap, per_second_limit, kill_switch, kill_reason, finalised, alarm_at_ms FROM config WHERE id = 1',
      )
      .toArray();
    return rows[0] ?? null;
  }

  /**
   * The day's config, created on first touch from the plan defaults (and a persistent manual
   * kill switch), together with a full token bucket and the finalising alarm. `setAlarm` is not
   * awaited: inside `transactionSync` it is covered by the rollback (facts sheet section 3).
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
    const killed = this.#persistentKill !== null;
    const due = finaliseAtMs(identity.utcDate);
    this.ctx.storage.sql.exec(
      `INSERT INTO config (id, provider, utc_date, daily_unit_cap, per_second_limit, kill_switch,
                           kill_reason, kill_at_ms, finalised, alarm_at_ms, updated_at_ms)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      identity.provider,
      identity.utcDate,
      cap,
      rate,
      killed ? 1 : 0,
      killed ? `persistent:${this.#persistentKill ?? ''}` : null,
      killed ? now : null,
      due,
      now,
    );
    this.#saveBucket(initialBucket(bucketFor(rate), now));
    void this.ctx.storage.setAlarm(due);
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
    const identity = this.#requireIdentity();
    this.ctx.storage.sql.exec(
      'UPDATE config SET kill_switch = 1, kill_reason = ?, kill_at_ms = ?, updated_at_ms = ? WHERE id = 1',
      reason,
      now,
      now,
    );
    const payload = {
      provider: identity.provider,
      utcDate: identity.utcDate,
      reason,
      atMs: now,
      ...detail,
    };
    this.#appendOutbox(PROVIDER_BUDGET_OUTBOX_KINDS.killSwitch, payload, now);
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
    const origin = `provider_budget:${identity.provider}:${identity.utcDate}${
      identity.shard === undefined ? '' : `:${String(identity.shard)}`
    }`;
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
    };
  }

  /**
   * Writes the fast-path copy. A change in what a reader decides (blocked or killed) is written at
   * once; a change of ladder rung, or a copy older than `KV_REFRESH_MS` while debits flow, waits
   * out the KV per-key limit of one write a second. A KV failure (a 429 included) is logged, never
   * fails the reservation, and leaves the copy marked unwritten so the next call retries it.
   */
  async #refreshKvCopy(now: number, force: boolean): Promise<void> {
    const identity = this.#requireIdentity();
    if (identity.shard !== undefined) {
      // A shard sees an eighth of the day; the copy is the unsharded object's to write.
      return;
    }
    const config = this.#config();
    if (config === null) {
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
    if (!urgent && now - this.#kvWrittenAtMs < KV_MIN_WRITE_GAP_MS) {
      return;
    }
    this.#kvSignature = signature;
    this.#kvWrittenAtMs = now;
    try {
      await this.kv.put(budgetKvKey(identity.provider, identity.utcDate), JSON.stringify(copy), {
        expirationTtl: BUDGET_KV_TTL_SECONDS,
      });
    } catch (error) {
      this.#kvSignature = '';
      this.#log.warn('provider_budget_kv_write_failed', errorFields(error));
    }
  }
}
