/**
 * AirportState Durable Object (increment 18; the shell since increment 4).
 *
 * One object per airport, named by its ICAO code, and the ONLY caller of AeroDataBox FIDS
 * (ruling B3, R3 D4). It holds the airport's board buckets: 12 airport-local hours each (ruling
 * B2), fetched with ONE call in R3 D2's shape (`getAirportBoard`: both directions, both legs).
 * The Worker resolves the airport from Postgres and passes its ICAO code and zone (ADR 0007:
 * objects never open Postgres); an unknown code never reaches an object.
 *
 * `getBucket()`, the one RPC:
 *
 *   1. A copy younger than its `freshUntil` is served as it is.
 *   2. A bucket that ended more than 24 hours ago is never fetched again, nor one beyond the
 *      plan's lookahead: the copy is served if one exists, else `out_of_range`.
 *   3. Coverage, once a day through the free health check (ruling B6): `not_covered` makes no
 *      FIDS call at all; `schedules_only` is carried on the answer for the screen's badge. A feed
 *      down or of unknown status is `unknown`, fetched anyway and asked again in an hour (ruling
 *      R5, `coverageOf`): `not_covered` only when AeroDataBox provides neither feed. A check the
 *      budget refuses is not asked again until the refusal can lift, and with no answer stored
 *      the bucket is `unavailable` with the refusal's reason: no FIDS call is reserved for an
 *      airport nothing says AeroDataBox covers (the re-review's M2).
 *   4. Between `freshUntil` and `staleUntil` the stale copy is served at once while ONE refresh
 *      runs in the background.
 *   5. Otherwise (no copy, or past `staleUntil`) the caller waits for the refresh. Concurrent
 *      misses for one bucket share one in-flight promise (`#inflight`, the resolver's pattern),
 *      because an outbound fetch lets other requests interleave (R3 F37); a handle older than
 *      `INFLIGHT_STALE_MS` is abandoned as hung (the tracker's guard, ruling L3). A refresh that
 *      fails or is refused leaves an existing copy served, stale: never an empty board while a
 *      copy exists. A failed bucket is not retried for `BOARD_REFRESH_RETRY_MS` after a transport
 *      error, a 408, a 5xx or a push-back, a refused one until the refusal can lift, and one the
 *      provider would answer the same way again (another 4xx, a 200 that is not a FIDS contract)
 *      for as long as a copy would be fresh, so a failing provider is not called on every view.
 *      That last wait is kept in storage (`bucket_failures`): an object evicted or redeployed
 *      inside it would otherwise bill the same failure again (M1). The others are in memory. A
 *      billed 200 whose items all fail mapping is stored as an empty bucket (ruling R6).
 *
 * Freshness is R3 D5's ladder (`boardFreshness` in shared), degraded by the boards share the
 * budget reports on the reservation (ruling B5): every limit doubles from 70 percent, quadruples
 * from 90, and at 100 percent the budget refuses and stale copies are all there is.
 *
 * A bucket's rows are stored as one gzip stream in chunks of at most 1 MB (`boards/cache.ts`),
 * and copied to KV `board:v2:{ICAO}:{bucketStartLocal}` with `fetchedAt`, `freshUntil` and
 * `staleUntil` in the metadata, expiring at the purge. Workers read KV first and call the object
 * only on a miss or past `freshUntil`. The alarm purges every bucket at the sooner of 48 hours
 * after it ends and 7 days after its fetch (ruling R4: a bucket fetched weeks ahead is not kept
 * for weeks), its KV copy included (Terms 5.5), a failed bucket's stored wait at the purge a copy
 * fetched then would have had, and `deleteAll()`s once nothing is left.
 *
 * Every provider call record leaves through this object's outbox to `persist` with
 * `airportIcao` set, under origin `airport_state:{ICAO}@{epoch}`.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  ADB_COVERAGE_TTL_MS,
  BoardBucketRequestV1,
  INFLIGHT_STALE_MS,
  RPC_SCHEMA_VERSION,
  RpcRequestError,
  boardBucketBounds,
  boardBucketWindow,
  boardFreshness,
  boardKvKey,
  boardRefreshable,
  isValidTimeZone,
  parseRpcRequest,
  type BoardBucketBounds,
  type BoardBucketResponseV1,
  type BoardCoverage,
  type BoardKvMetaV1,
  type BoardRow,
  type BoardWindow,
  type BudgetDecision,
  type BudgetGuard,
  type Exact,
  type ProviderCallContext,
  type ProviderCallRecord,
  type ProviderResult,
} from '@planeahead/shared';
import { decodeBoardRows, gzipJson, joinChunks, splitChunks } from '../boards/cache';
import type { Env } from '../env';
import { createLogger, errorFields, type Logger } from '../observability/log';
import { fidsAllSkipped, type AdbCoverage } from '../providers/aerodatabox.adapter';
import { providerSettings } from '../providers/config';
import { DurableObjectCostLogger, PROVIDER_CALL_OUTBOX_KIND } from '../providers/cost-log';
import { callRecord } from '../providers/http';
import { aerodataboxFor, budgetGuardFor, type RouterDeps } from '../providers/router';
import { type DurableObjectPing, blockOnMigrations } from './base';
import {
  EMPTY_MIGRATION_RESULT,
  type MigrationResult,
  type SqlMigrations,
  runSqlMigrations,
} from './migrate';
import { AIRPORT_STATE_MIGRATION_001 } from './migrations/airport-state/001';
import { AIRPORT_STATE_MIGRATION_002 } from './migrations/airport-state/002';
import { chunkOutbox, forEachBindChunk, sendOutboxChunks } from './outbox';

/**
 * A bucket whose fetch failed in transport, with a 408, a 5xx or a push-back (or whose copy could
 * not be stored) is not fetched again for this long. A refusal waits until it can lift and a
 * deterministic answer waits the ladder (`retryDelayMs`, `deterministicFailure`; ruling R6).
 */
export const BOARD_REFRESH_RETRY_MS = 60_000;
/**
 * An `unknown` coverage (the free check failed, or the deciding feed is down or of unknown
 * status) is asked again after this long; every other answer stands `ADB_COVERAGE_TTL_MS`.
 */
export const COVERAGE_RETRY_MS = 60 * 60_000;
/** Unsent call records are retried by the alarm this often. */
export const AIRPORT_OUTBOX_RETRY_MS = 5 * 60_000;
/** Decoded buckets kept in memory, so a hot board is not decompressed on every view. */
const DECODED_CACHE_SIZE = 4;

/**
 * What a feed's `FeedServiceStatus` (spec v1.15.3) says about it (ruling R5): OK, OKPartial and
 * Degraded mean provided, Down provided but down, Unavailable not provided. Unknown, and any
 * value outside the enum, is indeterminate: only Unavailable may ever read as not covered.
 */
type FeedState = 'provided' | 'down' | 'indeterminate' | 'not_provided';

const FEED_STATES: ReadonlyMap<string, FeedState> = new Map([
  ['OK', 'provided'],
  ['OKPartial', 'provided'],
  ['Degraded', 'provided'],
  ['Down', 'down'],
  ['Unknown', 'indeterminate'],
  ['Unavailable', 'not_provided'],
]);

function feedState(status: string): FeedState {
  return FEED_STATES.get(status) ?? 'indeterminate';
}

export const AIRPORT_STATE_ORIGIN_PREFIX = 'airport_state:';

/** What the object needs from the AeroDataBox adapter; narrowed so a test can hand in a fake. */
export interface BoardProvider {
  getAirportBoard(
    airportIcao: string,
    window: BoardWindow,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<Exact<BoardRow>[]>>;
  checkCoverage(
    airportIcao: string,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<AdbCoverage | null>>;
}

function isBoardProvider(value: unknown): value is BoardProvider {
  const candidate = value as Partial<BoardProvider> | null;
  return (
    typeof candidate?.getAirportBoard === 'function' &&
    typeof candidate.checkCoverage === 'function'
  );
}

/**
 * The coverage a health check answer means (R3 D6, ruling R5), live updates first: provided is
 * `live`; down or indeterminate is `unknown` (the board is fetched anyway and the check asked
 * again in an hour, so a transient status never pins a covered airport). Only when live updates
 * are not provided do the schedules decide, the same way: `schedules_only`, `unknown`, and
 * `not_covered` only when neither feed is provided.
 */
export function coverageOf(feeds: Pick<AdbCoverage, 'schedules' | 'live'>): BoardCoverage {
  const live = feedState(feeds.live);
  if (live !== 'not_provided') {
    return live === 'provided' ? 'live' : 'unknown';
  }
  const schedules = feedState(feeds.schedules);
  if (schedules !== 'not_provided') {
    return schedules === 'provided' ? 'schedules_only' : 'unknown';
  }
  return 'not_covered';
}

/** How long a coverage answer stands: an hour while it is `unknown`, else a day (ruling R5). */
export function coverageTtlMs(coverage: BoardCoverage): number {
  return coverage === 'unknown' ? COVERAGE_RETRY_MS : ADB_COVERAGE_TTL_MS;
}

/** A guard that hands every decision to `seen` as well, so the share spent reaches the object. */
function observing(guard: BudgetGuard, seen: (decision: BudgetDecision) => void): BudgetGuard {
  return {
    reserve: async (request) => {
      const decision = await guard.reserve(request);
      seen(decision);
      return decision;
    },
    release: async (request, unused) => {
      await guard.release?.(request, unused);
    },
    backoff: async (provider, retryAfterMs) => {
      await guard.backoff?.(provider, retryAfterMs);
    },
  };
}

/**
 * How long a bucket whose call failed in transport, with a 408, a 5xx or a push-back, or was
 * refused, waits: a refusal until it can lift, anything else a minute. (A deterministic answer
 * waits the ladder instead: `deterministicFailure`.) A refused coverage check waits the same way.
 */
function retryDelayMs(decision: BudgetDecision | null, nowMs: number): number {
  if (decision !== null && !decision.allowed) {
    if (decision.reason === 'provider_rate_limit' || decision.reason === 'board_rate_floor') {
      return Math.max(1_000, decision.retryAfterMs ?? 1_000);
    }
    if (decision.reason === 'board_airports_per_hour') {
      return 3_600_000 - (nowMs % 3_600_000);
    }
  }
  return BOARD_REFRESH_RETRY_MS;
}

/**
 * Whether a failed FIDS call is an answer the provider would give again (ruling R6): a billed
 * 4xx (a push-back is `rate_limited`, never here) or a 200 that is not a FIDS contract. Asked
 * again in a minute it would only be billed again, so the bucket waits as long as a copy would
 * be fresh. A 408 is a timeout on the way, not an answer about the request: it waits the
 * minute, as a 5xx does, rather than holding the bucket unavailable for hours.
 */
function deterministicFailure(call: ProviderCallRecord): boolean {
  return (
    call.result === 'error' &&
    call.httpStatus !== undefined &&
    call.httpStatus < 500 &&
    call.httpStatus !== 408
  );
}

type Row = Record<string, string | number | ArrayBuffer | null>;

interface BucketRow extends Row {
  bucket_start_local: string;
  tz: string;
  start_ms: number;
  end_ms: number;
  fetched_at_ms: number;
  fresh_until_ms: number;
  stale_until_ms: number;
  purge_at_ms: number;
  coverage: string;
  row_count: number;
  chunk_count: number;
  gzip_bytes: number;
}

interface CoverageRow extends Row {
  coverage: string;
  expires_at_ms: number;
}

interface OutboxRow extends Row {
  seq: number;
  payload: string;
}

interface FailureRow extends Row {
  retry_at_ms: number;
  reason: string;
}

/** A bucket not fetched again before `atMs`, and why. */
interface FailedWait {
  readonly atMs: number;
  readonly reason: string;
}

/**
 * The coverage a request goes on with. `refused` is set when the check was refused and no answer
 * is stored: the bucket is then not fetched (M2).
 */
interface CoverageAnswer {
  readonly coverage: BoardCoverage;
  readonly refused?: string;
}

type RefreshOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

type BucketResponse = Exact<BoardBucketResponseV1>;

export class AirportState extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 2;

  /** Append only, in order. Index 0 is migration id 1. */
  static readonly MIGRATIONS: SqlMigrations = [
    AIRPORT_STATE_MIGRATION_001,
    AIRPORT_STATE_MIGRATION_002,
  ];

  /** Test seams, set through `runInDurableObject`, never over RPC. */
  outboxSink: Pick<Queue, 'sendBatch'>;
  kv: Pick<KVNamespace, 'put' | 'delete'>;
  providerDeps: RouterDeps = {};
  /** Replaces the adapter outright; the default is `aerodataboxFor(env, providerDeps)`. */
  boardProvider: (() => BoardProvider) | undefined = undefined;

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;
  readonly #log: Logger;
  #testClockMs: number | null = null;
  #deleted = false;
  /** Whether the `airport` row is known to exist in this instance's storage. */
  #airportKnown = false;
  /** One refresh per bucket at a time (ruling B3), with when it started. */
  readonly #inflight = new Map<string, { promise: Promise<RefreshOutcome>; sinceMs: number }>();
  /**
   * Buckets whose last fetch failed: not fetched again before `atMs`. Lost with the instance; a
   * deterministic failure's wait is also stored in `bucket_failures`, which outlives it (M1).
   */
  readonly #retryAt = new Map<string, FailedWait>();
  #coverageInflight: Promise<CoverageAnswer> | null = null;
  /** After a refused coverage check: the budget is not asked again before `atMs` (M2). */
  #coverageRetryAt: FailedWait | null = null;
  /** Decoded rows by `${bucket}@${fetchedAtMs}`, most recent last. */
  readonly #decoded = new Map<string, BoardRow[]>();
  /** Background work (refreshes, KV writes, outbox sends), so a test can wait for it. */
  readonly #background = new Set<Promise<unknown>>();
  #flushing: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#log = createLogger({ durable_object: 'AirportState', name: ctx.id.name ?? 'unnamed' });
    this.outboxSink = env.PERSIST_QUEUE;
    this.kv = env.CACHE;
    blockOnMigrations(ctx, AirportState.MIGRATIONS, (result) => {
      this.#schema = result;
    });
  }

  /** Liveness and schema probe. Cheap, does no I/O, and creates the object if it did not exist. */
  ping(): DurableObjectPing {
    return {
      className: 'AirportState',
      schemaVersion: AirportState.SCHEMA_VERSION,
      appliedVersion: this.#schema.version,
      applied: this.#schema.applied,
    };
  }

  /** Test seam: the clock every decision reads. Refused unless `TEST_CLOCK` is `true`. */
  _setClock(ms: number | null): void {
    if (this.env.TEST_CLOCK !== 'true') {
      throw new RpcRequestError(
        'invalid_request',
        '_setClock is a test seam (TEST_CLOCK is not set)',
      );
    }
    this.#testClockMs = ms;
  }

  /** Test seam: resolves once no background refresh, KV write or outbox send is pending. */
  async settled(): Promise<void> {
    while (this.#background.size > 0) {
      await Promise.allSettled([...this.#background]);
    }
  }

  #now(): number {
    return this.#testClockMs !== null && this.env.TEST_CLOCK === 'true'
      ? this.#testClockMs
      : Date.now();
  }

  #ensureSchema(): void {
    if (this.#deleted) {
      this.#schema = runSqlMigrations(this.ctx, AirportState.MIGRATIONS);
      this.#deleted = false;
    }
  }

  /** Runs `work` off the caller's path, tracked for `settled()`. */
  #inBackground(work: Promise<unknown>): void {
    const tracked = work
      .catch((error: unknown) => {
        this.#log.error('airport_state_background_failed', errorFields(error));
      })
      .finally(() => {
        this.#background.delete(tracked);
      });
    this.#background.add(tracked);
    this.ctx.waitUntil(tracked);
  }

  /**
   * One bucket's normalised rows with `fetchedAt`, `freshUntil`, `staleUntil` and the coverage
   * (the contract is `BoardBucketResponseV1` in shared). A provider failure never throws: the
   * answer serves the copy stale with a `reason`, or says `unavailable`. A request for another
   * airport than the object's name, a bad zone or a bad bucket throws `RpcRequestError`.
   */
  async getBucket(input: unknown): Promise<BucketResponse> {
    const request = parseRpcRequest(BoardBucketRequestV1, input);
    const name = this.ctx.id.name;
    if (name !== undefined && name !== request.airportIcao) {
      throw new RpcRequestError(
        'invalid_request',
        `this object serves ${name}, not ${request.airportIcao}`,
      );
    }
    const bounds = isValidTimeZone(request.tz)
      ? boardBucketBounds(request.bucketStartLocal, request.tz)
      : null;
    if (bounds === null) {
      throw new RpcRequestError('invalid_request', 'the zone and the bucket name no real instants');
    }
    this.#ensureSchema();
    const now = this.#now();
    this.#ensureAirport(request.airportIcao, now);
    const stored = this.#bucket(request.bucketStartLocal);
    if (stored !== null && now < stored.fresh_until_ms) {
      return this.#answer(request, stored);
    }
    if (!this.#fetchable(bounds, now)) {
      return stored === null
        ? this.#empty(request, 'out_of_range', this.#knownCoverage(), 'not_refreshed')
        : this.#answer(request, stored, 'not_refreshed');
    }
    const { coverage, refused } = await this.#coverage(request, now);
    if (refused !== undefined) {
      // The check was refused and no answer is stored: nothing says AeroDataBox covers this
      // airport, so no FIDS call is reserved for it (M2). A copy, if one exists, is served.
      return stored === null
        ? this.#empty(request, 'unavailable', coverage, refused)
        : this.#answer(request, stored, refused);
    }
    if (coverage === 'not_covered') {
      return stored === null
        ? this.#empty(request, 'not_covered', coverage)
        : this.#answer(request, stored, 'not_covered');
    }
    if (stored !== null && now < stored.stale_until_ms) {
      // Stale while revalidate: this caller gets the copy at once; one refresh runs behind it.
      this.#inBackground(this.#refresh(request, bounds, coverage));
      return this.#answer(request, stored);
    }
    const outcome = await this.#refresh(request, bounds, coverage);
    const copy = this.#bucket(request.bucketStartLocal);
    if (copy === null) {
      return this.#empty(
        request,
        'unavailable',
        coverage,
        outcome.ok ? 'not_stored' : outcome.reason,
      );
    }
    // A failed refresh leaves the old copy, served stale: never an empty board while one exists.
    return this.#answer(request, copy, outcome.ok ? undefined : outcome.reason);
  }

  /** Whether the bucket may be fetched now: not ended over 24 h ago, not past the lookahead. */
  #fetchable(bounds: BoardBucketBounds, now: number): boolean {
    const lookaheadMs = providerSettings(this.env).adbPlan.maxDaysAhead * 86_400_000;
    return boardRefreshable(bounds, now) && bounds.startMs - now <= lookaheadMs;
  }

  #empty(
    request: BoardBucketRequestV1,
    state: 'not_covered' | 'unavailable' | 'out_of_range',
    coverage: BoardCoverage,
    reason?: string,
  ): BucketResponse {
    const response: BucketResponse = {
      rpcVersion: RPC_SCHEMA_VERSION,
      airportIcao: request.airportIcao,
      bucketStartLocal: request.bucketStartLocal,
      state,
      coverage,
      rows: [],
      stale: false,
    };
    if (reason !== undefined) {
      response.reason = reason;
    }
    return response;
  }

  async #answer(
    request: BoardBucketRequestV1,
    row: BucketRow,
    reason?: string,
  ): Promise<BucketResponse> {
    const response: BucketResponse = {
      rpcVersion: RPC_SCHEMA_VERSION,
      airportIcao: request.airportIcao,
      bucketStartLocal: row.bucket_start_local,
      state: 'ok',
      coverage: row.coverage as BoardCoverage,
      rows: await this.#rows(row),
      fetchedAt: new Date(row.fetched_at_ms).toISOString(),
      freshUntil: new Date(row.fresh_until_ms).toISOString(),
      staleUntil: new Date(row.stale_until_ms).toISOString(),
      stale: this.#now() >= row.fresh_until_ms,
    };
    if (reason !== undefined) {
      response.reason = reason;
    }
    return response;
  }

  /** A stored bucket's rows: its chunks joined and decompressed, kept decoded in memory. */
  async #rows(row: BucketRow): Promise<BoardRow[]> {
    const cacheKey = `${row.bucket_start_local}@${String(row.fetched_at_ms)}`;
    const cached = this.#decoded.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    const chunks = this.ctx.storage.sql
      .exec<{ data: ArrayBuffer }>(
        'SELECT data FROM bucket_chunks WHERE bucket_start_local = ? ORDER BY idx',
        row.bucket_start_local,
      )
      .toArray()
      .map((chunk) => new Uint8Array(chunk.data));
    if (chunks.length !== row.chunk_count) {
      throw new Error(`bucket ${row.bucket_start_local} has ${String(chunks.length)} chunks`);
    }
    const rows = await decodeBoardRows(joinChunks(chunks));
    this.#decoded.set(cacheKey, rows);
    while (this.#decoded.size > DECODED_CACHE_SIZE) {
      const oldest = this.#decoded.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#decoded.delete(oldest);
    }
    return rows;
  }

  #bucket(bucketStartLocal: string): BucketRow | null {
    return (
      this.ctx.storage.sql
        .exec<BucketRow>('SELECT * FROM buckets WHERE bucket_start_local = ?', bucketStartLocal)
        .toArray()[0] ?? null
    );
  }

  /** Records the airport and the object's lifetime epoch on first use. */
  #ensureAirport(airportIcao: string, now: number): void {
    if (this.#airportKnown) {
      return;
    }
    this.#airportKnown = true;
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO airport (id, airport_icao, created_at_ms) VALUES (1, ?, ?)',
      airportIcao,
      now,
    );
  }

  #airport(): { airportIcao: string; epochMs: number } | null {
    const row = this.ctx.storage.sql
      .exec<{ airport_icao: string; created_at_ms: number }>(
        'SELECT airport_icao, created_at_ms FROM airport WHERE id = 1',
      )
      .toArray()[0];
    return row === undefined ? null : { airportIcao: row.airport_icao, epochMs: row.created_at_ms };
  }

  /** The stored coverage answer, whatever its age. */
  #coverageRow(): CoverageRow | undefined {
    return this.ctx.storage.sql
      .exec<CoverageRow>('SELECT coverage, expires_at_ms FROM coverage WHERE id = 1')
      .toArray()[0];
  }

  /** The last coverage answer, whatever its age; `unknown` when there is none. */
  #knownCoverage(): BoardCoverage {
    return (this.#coverageRow()?.coverage as BoardCoverage | undefined) ?? 'unknown';
  }

  /** After a refused check: the last answer, whatever its age, or with none the refusal (M2). */
  #afterRefusal(reason: string): CoverageAnswer {
    const row = this.#coverageRow();
    return row === undefined
      ? { coverage: 'unknown', refused: reason }
      : { coverage: row.coverage as BoardCoverage };
  }

  #provider(): BoardProvider {
    const provider = this.boardProvider?.() ?? aerodataboxFor(this.env, this.providerDeps);
    if (!isBoardProvider(provider)) {
      throw new Error('the AeroDataBox adapter has no board methods');
    }
    return provider;
  }

  /** A context whose records are buffered here and whose budget decisions reach `seen`. */
  #context(
    request: BoardBucketRequestV1,
    purpose: 'board' | 'coverage',
    buffered: ProviderCallRecord[],
    seen: (decision: BudgetDecision) => void = () => undefined,
  ): ProviderCallContext {
    const clock = (): Date => new Date(this.#now());
    return {
      trigger: request.trigger,
      airportIcao: request.airportIcao,
      requestId:
        request.requestId ?? `${purpose}:${request.airportIcao}:${request.bucketStartLocal}`,
      budget: observing(budgetGuardFor(this.env, clock), seen),
      log: new DurableObjectCostLogger({
        append: (_kind, payload) => {
          buffered.push(payload);
        },
      }),
      now: clock,
    };
  }

  /** A zero-cost error record for a call that threw before or instead of reaching the provider. */
  #thrownRecord(
    ctx: ProviderCallContext,
    operation: 'fids' | 'health',
    startedAt: Date,
    error: unknown,
  ): ProviderCallRecord {
    this.#log.error('airport_state_provider_threw', { operation, ...errorFields(error) });
    return callRecord({
      ctx,
      provider: 'aerodatabox',
      operation,
      startedAt,
      finishedAt: new Date(this.#now()),
      result: 'error',
      billed: false,
      error: `thrown:${error instanceof Error ? error.message : String(error)}`,
    });
  }

  /**
   * The airport's coverage: the stored answer while it stands, else one free check (B6). Until a
   * refused check's refusal can lift, the budget is not asked again (`#coverageRetryAt`, M2): the
   * request goes on as the refused one did.
   */
  async #coverage(request: BoardBucketRequestV1, now: number): Promise<CoverageAnswer> {
    const row = this.#coverageRow();
    if (row !== undefined && now < row.expires_at_ms) {
      return { coverage: row.coverage as BoardCoverage };
    }
    const refused = this.#coverageRetryAt;
    if (refused !== null && now < refused.atMs) {
      return this.#afterRefusal(refused.reason);
    }
    if (this.#coverageInflight === null) {
      const inflight = this.#checkCoverage(request).finally(() => {
        if (this.#coverageInflight === inflight) {
          this.#coverageInflight = null;
        }
      });
      this.#coverageInflight = inflight;
    }
    return this.#coverageInflight;
  }

  /**
   * The free health check (`checkCoverage`), stored for `coverageTtlMs`: a day, or an hour while
   * `unknown` (a failed check, or a feed down or of unknown status; ruling R5). A check the
   * budget refuses never reached AeroDataBox, so it stores nothing, rather than an `unknown`
   * standing for an hour while FIDS calls go out ungated (review A's ma4): the request goes on
   * with the last answer, or with none is refused too (`#afterRefusal`). The budget is not asked
   * again until the refusal can lift (`retryDelayMs`: a second for the rate and the floor, a
   * minute otherwise), so a refusing budget costs one record a wait, not one a view (M2). The
   * answer lives in this object only (R15: the KV copy it used to write had no reader).
   */
  async #checkCoverage(request: BoardBucketRequestV1): Promise<CoverageAnswer> {
    const buffered: ProviderCallRecord[] = [];
    const observed: { decision: BudgetDecision | null } = { decision: null };
    const ctx = this.#context(request, 'coverage', buffered, (decision) => {
      observed.decision = decision;
    });
    const startedAt = new Date(this.#now());
    let feeds: AdbCoverage | null = null;
    let call: ProviderCallRecord;
    try {
      const result = await this.#provider().checkCoverage(request.airportIcao, ctx);
      call = result.call;
      feeds = result.data;
    } catch (error) {
      call = this.#thrownRecord(ctx, 'health', startedAt, error);
    }
    buffered.push(call);
    const at = this.#now();
    const decision = observed.decision;
    if (decision?.allowed === false) {
      const reason = call.error ?? call.result;
      this.#coverageRetryAt = { atMs: at + retryDelayMs(decision, at), reason };
      this.#keepRecords(request.airportIcao, buffered, at);
      return this.#afterRefusal(reason);
    }
    this.#coverageRetryAt = null;
    const coverage: BoardCoverage = feeds === null ? 'unknown' : coverageOf(feeds);
    if (feeds !== null) {
      // The raw statuses, so a status outside the enum (read as indeterminate) is seen as sent.
      this.#log.info('airport_state_coverage_checked', {
        airport_icao: request.airportIcao,
        schedules: feeds.schedules,
        live: feeds.live,
        adsb: feeds.adsb,
        coverage,
      });
    }
    this.#ensureSchema();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO coverage
           (id, coverage, schedules, live, adsb, checked_at_ms, expires_at_ms)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
        coverage,
        feeds?.schedules ?? null,
        feeds?.live ?? null,
        feeds?.adsb ?? null,
        at,
        at + coverageTtlMs(coverage),
      );
      this.#appendRecords(buffered, at);
    });
    this.#scheduleFlush();
    return { coverage };
  }

  /**
   * One refresh per bucket (ruling B3): a caller arriving while one runs shares its promise,
   * unless that handle is older than `INFLIGHT_STALE_MS` (hung: abandoned, as the tracker does).
   * A bucket whose last fetch failed is not fetched again before its retry time, read from
   * memory and then from `bucket_failures` (a deterministic failure's, which outlives eviction).
   */
  #refresh(
    request: BoardBucketRequestV1,
    bounds: BoardBucketBounds,
    coverage: BoardCoverage,
  ): Promise<RefreshOutcome> {
    const key = request.bucketStartLocal;
    const now = this.#now();
    const running = this.#inflight.get(key);
    if (running !== undefined) {
      if (now - running.sinceMs < INFLIGHT_STALE_MS) {
        return running.promise;
      }
      this.#log.error('airport_state_inflight_abandoned', {
        bucket: key,
        age_ms: now - running.sinceMs,
      });
    }
    // A caller that waited (on the coverage check) may find the bucket refreshed meanwhile.
    const current = this.#bucket(key);
    if (current !== null && now < current.fresh_until_ms) {
      return Promise.resolve({ ok: true });
    }
    const failed = this.#failedWait(key, now);
    if (failed !== null) {
      return Promise.resolve({ ok: false, reason: failed.reason });
    }
    const promise = this.#fetchBucket(request, bounds, coverage)
      .catch((error: unknown): RefreshOutcome => {
        this.#log.error('airport_state_refresh_failed', { bucket: key, ...errorFields(error) });
        return { ok: false, reason: 'store_failed' };
      })
      .finally(() => {
        if (this.#inflight.get(key)?.promise === promise) {
          this.#inflight.delete(key);
        }
      });
    this.#inflight.set(key, { promise, sinceMs: now });
    return promise;
  }

  /** The wait a failed fetch left on the bucket, if it still holds at `now`. */
  #failedWait(key: string, now: number): FailedWait | null {
    const held = this.#retryAt.get(key);
    if (held !== undefined && now < held.atMs) {
      return held;
    }
    const stored = this.ctx.storage.sql
      .exec<FailureRow>(
        'SELECT retry_at_ms, reason FROM bucket_failures WHERE bucket_start_local = ?',
        key,
      )
      .toArray()[0];
    return stored !== undefined && now < stored.retry_at_ms
      ? { atMs: stored.retry_at_ms, reason: stored.reason }
      : null;
  }

  /**
   * The one FIDS call for a bucket. A 200 (rows), a 204 (an empty window, the billed
   * `not_found`) and a billed 200 whose every item was skipped (stored empty while its record
   * keeps the error, ruling R6) are stored; anything else (an error, a refusal, a push-back, a
   * throw) records its call, sets the bucket's retry time (a deterministic failure's in storage
   * too, M1) and leaves any existing copy alone. A copy that cannot be stored keeps its call's
   * record and waits the same way (R15).
   */
  async #fetchBucket(
    request: BoardBucketRequestV1,
    bounds: BoardBucketBounds,
    coverage: BoardCoverage,
  ): Promise<RefreshOutcome> {
    const key = request.bucketStartLocal;
    const window = boardBucketWindow(key, request.tz);
    if (window === null) {
      return { ok: false, reason: 'not_a_bucket' };
    }
    const buffered: ProviderCallRecord[] = [];
    const observed: { decision: BudgetDecision | null } = { decision: null };
    const ctx = this.#context(request, 'board', buffered, (decision) => {
      observed.decision = decision;
    });
    const startedAt = new Date(this.#now());
    let rows: Exact<BoardRow>[] = [];
    let call: ProviderCallRecord;
    try {
      const result = await this.#provider().getAirportBoard(request.airportIcao, window, ctx);
      rows = result.data;
      call = result.call;
    } catch (error) {
      call = this.#thrownRecord(ctx, 'fids', startedAt, error);
    }
    buffered.push(call);
    const at = this.#now();
    const decision = observed.decision;
    const share = decision?.allowed === true ? decision.boardsShareSpent : undefined;
    if (call.result !== 'ok' && call.result !== 'not_found' && !fidsAllSkipped(call)) {
      const reason = call.error ?? call.result;
      if (!deterministicFailure(call)) {
        this.#retryAt.set(key, { atMs: at + retryDelayMs(decision, at), reason });
        this.#keepRecords(request.airportIcao, buffered, at);
        return { ok: false, reason };
      }
      // Asked again it would be billed again, so the wait is stored as well: neither eviction nor
      // a deploy lifts it (M1). In memory first, so it holds even when storage fails.
      const freshness = boardFreshness(bounds, at, share);
      this.#retryAt.set(key, { atMs: freshness.freshUntilMs, reason });
      this.#keepRecords(request.airportIcao, buffered, at);
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO bucket_failures
           (bucket_start_local, retry_at_ms, purge_at_ms, reason)
         VALUES (?, ?, ?, ?)`,
        key,
        freshness.freshUntilMs,
        freshness.purgeAtMs,
        reason,
      );
      this.#armAlarm();
      return { ok: false, reason };
    }
    this.#retryAt.delete(key);
    try {
      await this.#store(request, bounds, coverage, rows, at, share, buffered);
    } catch (error) {
      // The failed transaction held the billed call's record: keep it on its own, and wait like
      // a failed transport so the next view does not bill again at once (R15). The wait is set
      // first, so it holds even when keeping the record fails too.
      this.#log.error('airport_state_store_failed', { bucket: key, ...errorFields(error) });
      this.#retryAt.set(key, { atMs: at + BOARD_REFRESH_RETRY_MS, reason: 'store_failed' });
      this.#keepRecords(request.airportIcao, buffered, at);
      return { ok: false, reason: 'store_failed' };
    }
    return { ok: true };
  }

  /** Call records no stored bucket carries (a failed or unstored fetch), for the outbox. */
  #keepRecords(airportIcao: string, records: readonly ProviderCallRecord[], now: number): void {
    this.#ensureSchema();
    this.#ensureAirport(airportIcao, now);
    this.ctx.storage.transactionSync(() => {
      this.#appendRecords(records, now);
    });
    this.#scheduleFlush();
  }

  /**
   * Replaces a bucket in one transaction: its chunks (one gzip stream cut at 1 MB), its row with
   * the ladder's limits, the call records, and the end of any stored failure wait. Then the KV
   * copy, off the caller's path.
   */
  async #store(
    request: BoardBucketRequestV1,
    bounds: BoardBucketBounds,
    coverage: BoardCoverage,
    rows: Exact<BoardRow>[],
    fetchedAtMs: number,
    share: number | undefined,
    records: readonly ProviderCallRecord[],
  ): Promise<void> {
    const key = request.bucketStartLocal;
    const gzip = await gzipJson(rows);
    const chunks = splitChunks(gzip);
    const freshness = boardFreshness(bounds, fetchedAtMs, share);
    this.#ensureSchema();
    this.#ensureAirport(request.airportIcao, fetchedAtMs);
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec('DELETE FROM bucket_chunks WHERE bucket_start_local = ?', key);
      chunks.forEach((chunk, idx) => {
        sql.exec(
          'INSERT INTO bucket_chunks (bucket_start_local, idx, data) VALUES (?, ?, ?)',
          key,
          idx,
          chunk.buffer,
        );
      });
      sql.exec(
        `INSERT OR REPLACE INTO buckets
           (bucket_start_local, tz, start_ms, end_ms, fetched_at_ms, fresh_until_ms,
            stale_until_ms, purge_at_ms, coverage, row_count, chunk_count, gzip_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        key,
        request.tz,
        bounds.startMs,
        bounds.endMs,
        fetchedAtMs,
        freshness.freshUntilMs,
        freshness.staleUntilMs,
        freshness.purgeAtMs,
        coverage,
        rows.length,
        chunks.length,
        gzip.length,
      );
      sql.exec('DELETE FROM bucket_failures WHERE bucket_start_local = ?', key);
      this.#appendRecords(records, fetchedAtMs);
    });
    this.#decoded.set(`${key}@${String(fetchedAtMs)}`, rows);
    this.#scheduleFlush();
    this.#armAlarm();
    const meta: BoardKvMetaV1 = {
      airportIcao: request.airportIcao,
      bucketStartLocal: key,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      freshUntil: new Date(freshness.freshUntilMs).toISOString(),
      staleUntil: new Date(freshness.staleUntilMs).toISOString(),
      coverage,
      rowCount: rows.length,
    };
    // Relative, so KV expires the copy at the purge whatever clock it keeps (60 s minimum).
    const expirationTtl = Math.max(60, Math.ceil((freshness.purgeAtMs - fetchedAtMs) / 1_000));
    this.#inBackground(
      this.kv.put(boardKvKey(request.airportIcao, key), gzip, { expirationTtl, metadata: meta }),
    );
  }

  #appendRecords(records: readonly ProviderCallRecord[], now: number): void {
    for (const record of records) {
      this.ctx.storage.sql.exec(
        'INSERT INTO outbox (kind, payload, created_at_ms) VALUES (?, ?, ?)',
        PROVIDER_CALL_OUTBOX_KIND,
        JSON.stringify({ kind: PROVIDER_CALL_OUTBOX_KIND, payload: record }),
        now,
      );
    }
  }

  /** Sends what is unsent, after any send already running, off the caller's path. */
  #scheduleFlush(): void {
    this.#inBackground(this.#chainFlush());
  }

  /** One send at a time, so two flushes never send the same rows twice. */
  #chainFlush(): Promise<void> {
    const next = this.#flushing.then(() => this.#flushOutbox());
    this.#flushing = next.catch(() => undefined);
    return next;
  }

  /**
   * Unsent records to `persist`, origin `airport_state:{ICAO}@{epoch}`. An object that lives as
   * long as its airport has traffic cannot keep what it sent, so accepted rows are deleted; a
   * failed send leaves the rest for the alarm, armed `AIRPORT_OUTBOX_RETRY_MS` out.
   */
  async #flushOutbox(): Promise<void> {
    if (this.#deleted) {
      return;
    }
    const rows = this.ctx.storage.sql
      .exec<OutboxRow>('SELECT seq, payload FROM outbox WHERE sent_at_ms IS NULL ORDER BY seq')
      .toArray();
    if (rows.length === 0) {
      return;
    }
    const airport = this.#airport();
    const name = airport?.airportIcao ?? this.ctx.id.name ?? 'unnamed';
    const origin = `${AIRPORT_STATE_ORIGIN_PREFIX}${name}@${String(airport?.epochMs ?? 0)}`;
    const { chunks } = chunkOutbox(rows, (row) => ({
      ...(JSON.parse(row.payload) as Record<string, unknown>),
      seq: row.seq,
      origin,
    }));
    const outcome = await sendOutboxChunks(this.outboxSink, chunks, this.#log);
    if (outcome.sentSeqs.length > 0 && !this.#deleted) {
      this.ctx.storage.transactionSync(() => {
        forEachBindChunk(outcome.sentSeqs, (placeholders, seqs) => {
          this.ctx.storage.sql.exec(`DELETE FROM outbox WHERE seq IN (${placeholders})`, ...seqs);
        });
      });
    }
    if (outcome.error !== null) {
      this.#armAlarm(this.#now() + AIRPORT_OUTBOX_RETRY_MS);
    }
  }

  /**
   * Arms the alarm for the earliest purge (a bucket's, or a failed bucket's stored wait's), or
   * `retryAtMs` when sooner; never postpones one.
   */
  #armAlarm(retryAtMs?: number): void {
    this.#inBackground(this.#armAlarmNow(retryAtMs));
  }

  async #armAlarmNow(retryAtMs?: number): Promise<void> {
    if (this.#deleted) {
      return;
    }
    const purge = this.ctx.storage.sql
      .exec<{ at: number | null }>(
        `SELECT MIN(purge_at_ms) AS at FROM
           (SELECT purge_at_ms FROM buckets UNION ALL SELECT purge_at_ms FROM bucket_failures)`,
      )
      .one().at;
    const wanted = [purge, retryAtMs ?? null].filter((at): at is number => at !== null);
    if (wanted.length === 0) {
      return;
    }
    const target = Math.min(...wanted);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || target < current) {
      await this.ctx.storage.setAlarm(target);
    }
  }

  /**
   * Purges every bucket at its `purge_at_ms` (48 hours after it ended, or 7 days after its last
   * fetch when that is sooner: ruling R4), its KV copy included (Terms 5.5: cached contents are
   * deleted once their purpose is served), and a failed bucket's stored wait at its own purge
   * (M1), retries unsent records, and deletes all storage once nothing is left and nothing is in
   * flight. A refetch moves a bucket's purge later; an alarm armed for the old purge finds
   * nothing due and re-arms for the next.
   */
  override async alarm(): Promise<void> {
    this.#ensureSchema();
    const now = this.#now();
    await this.#chainFlush();
    const expired = this.ctx.storage.sql
      .exec<{ bucket_start_local: string }>(
        'SELECT bucket_start_local FROM buckets WHERE purge_at_ms <= ? ORDER BY bucket_start_local',
        now,
      )
      .toArray()
      .map((row) => row.bucket_start_local);
    if (expired.length > 0) {
      const airport = this.#airport()?.airportIcao ?? this.ctx.id.name;
      this.ctx.storage.transactionSync(() => {
        for (const key of expired) {
          this.ctx.storage.sql.exec('DELETE FROM bucket_chunks WHERE bucket_start_local = ?', key);
          this.ctx.storage.sql.exec('DELETE FROM buckets WHERE bucket_start_local = ?', key);
        }
      });
      for (const key of expired) {
        this.#retryAt.delete(key);
        for (const cached of [...this.#decoded.keys()].filter((k) => k.startsWith(`${key}@`))) {
          this.#decoded.delete(cached);
        }
      }
      if (airport !== undefined) {
        await Promise.allSettled(expired.map((key) => this.kv.delete(boardKvKey(airport, key))));
      }
      this.#log.info('airport_state_purged', { buckets: expired.length });
    }
    this.ctx.storage.sql.exec('DELETE FROM bucket_failures WHERE purge_at_ms <= ?', now);
    const remaining = this.ctx.storage.sql
      .exec<{ n: number }>(
        'SELECT (SELECT COUNT(*) FROM buckets) + (SELECT COUNT(*) FROM bucket_failures) AS n',
      )
      .one().n;
    const unsent = this.ctx.storage.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE sent_at_ms IS NULL')
      .one().n;
    if (
      remaining === 0 &&
      unsent === 0 &&
      this.#inflight.size === 0 &&
      this.#coverageInflight === null
    ) {
      await this.ctx.storage.deleteAll();
      this.#deleted = true;
      this.#airportKnown = false;
      this.#decoded.clear();
      return;
    }
    await this.#armAlarmNow(unsent > 0 ? now + AIRPORT_OUTBOX_RETRY_MS : undefined);
  }
}
