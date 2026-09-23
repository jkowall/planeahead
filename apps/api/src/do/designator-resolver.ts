/**
 * DesignatorResolver Durable Object (increment 7).
 *
 * One object per marketing designator and origin-local date, named `${marketingIata}${number}-
 * ${dateLocal}` (`AA100-2026-09-19`). It serialises the first provider call for an unresolved
 * designator: fifty concurrent searches for the same flight cost one AeroDataBox call, because
 * the object is one thread and the call sits behind `#inflight`, a promise every caller that
 * arrives mid-fetch awaits. The answer (a flight key and the status it was created from, or a
 * not-found) is stored for 24 hours; one alarm at expiry calls `deleteAll()`. No `setAlarm` in
 * the constructor: an alarm waking the object runs the constructor first, and a constructor that
 * armed one would postpone the cleanup forever.
 *
 * `resolve()`, inside the object:
 *
 *   1. a stored, unexpired resolution is returned;
 *   2. when the caller knows the origin, the trackers a `regionalOperatorHint` and the
 *      marketing carrier would name are probed with `health` and an existing one is adopted
 *      (a flight key needs an origin, and the key is the only name a tracker has, so without an
 *      origin there is nothing to probe);
 *   3. otherwise the single AeroDataBox call is made through `providerFor` with trigger
 *      `user_search` (the router's contract: one lookup, up to three billed attempts for a
 *      person-supplied date), `resolveOperator` and `canonicalizeFromProvider` produce the key
 *      (both run inside the adapter's mapping), and the FlightTracker is created through its
 *      `seed` RPC: the fetched status becomes its initial snapshot and its first alarm is set,
 *      so this one call is never repeated by the tracker's first alarm. Seed is idempotent.
 *
 * The Worker-side half is `resolveDesignator`: it checks KV `search:number:{designator}:{date}`
 * (900 s, written by the object once it has an answer) before `getByName`, because the first
 * `get()` on a never-used name pays a global uniqueness check, and it catches the account-level
 * "generating too much load" error with one jittered retry before answering `overloaded`, which
 * the search route turns into a 503 with `Retry-After` (increment 8).
 *
 * Never opens Postgres (ADR 0007): the provider call records leave through this object's own
 * outbox to the `persist` queue.
 */

import { DurableObject } from 'cloudflare:workers';
import {
  CARRIER_IATA_TO_ICAO_FALLBACK,
  REGIONAL_OPERATOR_SEED,
  RPC_SCHEMA_VERSION,
  ResolveRequestV1,
  ResolveResponseV1 as ResolveResponseSchema,
  RpcRequestError,
  buildFlightKey,
  canonicalizeFromProvider,
  designatorResolverOrigin,
  parseDesignator,
  parseRpcRequest,
  regionalOperatorHint,
  resolveCarrierIcao,
  type Exact,
  type FlightKey,
  type FlightStatus,
  type ProviderCallContext,
  type ProviderCallRecord,
  type ResolveRequestV1 as ResolveRequest,
  type ResolveResponseV1,
} from '@planeahead/shared';

/** The wire shape without the loose index signature, so the RPC stub keeps a real type. */
type ResolveResponse = Exact<ResolveResponseV1>;
import type { Env } from '../env';
import { createLogger, errorFields, type Logger } from '../observability/log';
import { DurableObjectCostLogger, PROVIDER_CALL_OUTBOX_KIND } from '../providers/cost-log';
import { callRecord } from '../providers/http';
import { budgetGuardFor, providerFor, type RouterDeps } from '../providers/router';
import { type DurableObjectPing, blockOnMigrations } from './base';
import {
  EMPTY_MIGRATION_RESULT,
  type MigrationResult,
  type SqlMigrations,
  runSqlMigrations,
} from './migrate';
import { DESIGNATOR_RESOLVER_MIGRATION_001 } from './migrations/designator-resolver/001';
import { chunkOutbox, sendOutboxChunks } from './outbox';

/** A stored resolution lives this long; the object deletes itself at the end. */
export const RESOLUTION_TTL_MS = 24 * 60 * 60_000;
/** The Worker-side KV cache in front of the object. */
export const SEARCH_KV_TTL_SECONDS = 900;
/** `Retry-After` the search route sends when the namespace is overloaded. */
export const OVERLOADED_RETRY_AFTER_SECONDS = 2;

export function searchKvKey(designator: string, dateLocal: string): string {
  return `search:number:${designator}:${dateLocal}`;
}

/**
 * The object name for a search: the designator normalised (`AA 0100` is `AA100`, an ICAO
 * designator keeps its ICAO code) and the origin-local date. Throws `FlightKeyError` on a
 * designator that is not one.
 */
export function designatorResolverName(designator: string, dateLocal: string): string {
  return `${normalizeDesignator(designator)}-${dateLocal}`;
}

export function normalizeDesignator(designator: string): string {
  const parsed = parseDesignator(designator);
  const code = parsed.carrier.iata ?? parsed.carrier.icao ?? '';
  return `${code}${parsed.number}${parsed.suffix ?? ''}`;
}

type Row = Record<string, string | number | ArrayBuffer | null>;

interface ResolutionRow extends Row {
  designator: string;
  date_local: string;
  outcome: string;
  flight_key: string | null;
  status: string | null;
  created_flight: number;
  kv_written: number;
  created_at_ms: number;
  resolved_at_ms: number;
  expires_at_ms: number;
}

interface OutboxRow extends Row {
  seq: number;
  payload: string;
}

/** The FlightTracker RPCs the resolver uses; narrowed so a test can hand in a fake. */
export interface TrackerRpc {
  health(): Promise<{ phase: string; flightKey: string | null }>;
  seed(input: unknown): Promise<{ status: string; version: number }>;
}

export class DesignatorResolver extends DurableObject<Env> {
  /** Schema version this build expects. Reported by `GET /health` without touching an object. */
  static readonly SCHEMA_VERSION = 1;

  /** Append only, in order. Index 0 is migration id 1. */
  static readonly MIGRATIONS: SqlMigrations = [DESIGNATOR_RESOLVER_MIGRATION_001];

  /** Test seams, set through `runInDurableObject`, never over RPC. */
  outboxSink: Pick<Queue, 'sendBatch'>;
  kv: Pick<KVNamespace, 'put'>;
  providerDeps: RouterDeps = {};
  /** Resolves a flight key to its tracker; the default is `FLIGHT_TRACKER.getByName`. */
  trackerFor: (flightKey: FlightKey) => TrackerRpc;

  #schema: MigrationResult = EMPTY_MIGRATION_RESULT;
  readonly #log: Logger;
  #testClockMs: number | null = null;
  #inflight: Promise<ResolveResponse> | null = null;
  #kvInFlight: Promise<void> | null = null;
  #deleted = false;
  #cleanupArmed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#log = createLogger({
      durable_object: 'DesignatorResolver',
      name: ctx.id.name ?? 'unnamed',
    });
    this.outboxSink = env.PERSIST_QUEUE;
    this.kv = env.CACHE;
    this.trackerFor = (flightKey) =>
      env.FLIGHT_TRACKER.getByName(flightKey, { locationHint: 'enam' });
    blockOnMigrations(ctx, DesignatorResolver.MIGRATIONS, (result) => {
      this.#schema = result;
    });
  }

  /** Liveness and schema probe. Cheap, does no I/O, and creates the object if it did not exist. */
  ping(): DurableObjectPing {
    return {
      className: 'DesignatorResolver',
      schemaVersion: DesignatorResolver.SCHEMA_VERSION,
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

  async resolve(input: unknown): Promise<ResolveResponse> {
    const request = parseRpcRequest(ResolveRequestV1, input);
    this.#ensureSchema();
    const now = this.#now();
    const stored = this.#resolution();
    if (stored !== null && now < stored.expires_at_ms) {
      return this.#responseFrom(stored, true);
    }
    if (this.#inflight !== null) {
      return this.#inflight;
    }
    const inflight = this.#resolveUncached(request, now).finally(() => {
      if (this.#inflight === inflight) {
        this.#inflight = null;
      }
    });
    this.#inflight = inflight;
    return inflight;
  }

  /** The expiry alarm: sends anything unsent (best effort) and deletes everything. */
  override async alarm(): Promise<void> {
    this.#ensureSchema();
    const now = this.#now();
    const stored = this.#resolution();
    if (stored !== null && now < stored.expires_at_ms) {
      // Woken early (a duplicate delivery): keep the schedule.
      void this.ctx.storage.setAlarm(stored.expires_at_ms);
      return;
    }
    await this.#flushOutbox(now);
    await this.ctx.storage.deleteAll();
    this.#deleted = true;
    this.#cleanupArmed = false;
    this.#log.info('designator_resolver_expired', {});
  }

  async #resolveUncached(request: ResolveRequest, now: number): Promise<ResolveResponse> {
    const designator = normalizeDesignator(request.designator);
    const parsed = parseDesignator(designator);
    const marketingIcao = resolveCarrierIcao(parsed.carrier, CARRIER_IATA_TO_ICAO_FALLBACK);

    // 2. An existing tracker, when the origin is known: the regional operator hint first, then
    //    the marketing carrier. A probe of a tracker that does not exist creates an empty
    //    object, which deletes itself a minute later (`health` arms that cleanup).
    if (request.originIcao !== undefined && marketingIcao !== undefined) {
      const hint = regionalOperatorHint(parsed.carrier, parsed.number, REGIONAL_OPERATOR_SEED);
      const candidates = [
        ...new Set([hint, marketingIcao].filter((c): c is string => c !== undefined)),
      ];
      for (const operator of candidates) {
        let key: FlightKey;
        try {
          key = buildFlightKey({
            operatingCarrierIcao: operator,
            flightNumber: `${parsed.number}${parsed.suffix ?? ''}`,
            scheduledDepartureDateLocal: request.dateLocal,
            originIcao: request.originIcao,
          });
        } catch {
          continue;
        }
        try {
          const health = await this.trackerFor(key).health();
          if (health.phase !== 'absent' && health.phase !== 'unknown') {
            const adopted = this.#store(now, 'resolved', key, null, false);
            await this.#flushOutbox(now);
            this.#writeSearchKv(adopted);
            return this.#responseFrom(adopted, false);
          }
        } catch (error) {
          this.#log.warn('designator_resolver_probe_failed', {
            flight_key: key,
            ...errorFields(error),
          });
        }
      }
    }

    // 3. The single provider call.
    const buffered: ProviderCallRecord[] = [];
    const logger = new DurableObjectCostLogger({
      append: (_kind, payload) => {
        buffered.push(payload);
      },
    });
    const ctx: ProviderCallContext = {
      trigger: 'user_search',
      requestId: request.requestId ?? `search:${designator}:${request.dateLocal}`,
      budget: budgetGuardFor(this.env, () => new Date(this.#now())),
      log: logger,
      now: () => new Date(this.#now()),
    };
    const provider = providerFor('aerodatabox', this.env, this.providerDeps);
    const startedAt = new Date(now);
    let statuses: Exact<FlightStatus>[] = [];
    let records: ProviderCallRecord[];
    let failure: string | undefined;
    try {
      const result = await provider.getFlight(
        {
          carrier: parsed.carrier,
          flightNumber: `${parsed.number}${parsed.suffix ?? ''}`,
          dateLocal: request.dateLocal,
          originIcao: request.originIcao,
        },
        ctx,
      );
      statuses = result.data;
      records = [...buffered, result.call];
      if (result.call.result === 'error' || result.call.result === 'rate_limited') {
        failure = result.call.error ?? result.call.result;
      }
    } catch (error) {
      this.#log.error('designator_resolver_provider_threw', errorFields(error));
      records = [
        ...buffered,
        callRecord({
          ctx,
          provider: provider.id,
          operation: 'flight_status',
          startedAt,
          finishedAt: new Date(this.#now()),
          result: 'error',
          billed: false,
          error: `thrown:${error instanceof Error ? error.message : String(error)}`,
        }),
      ];
      failure = 'thrown';
    }
    const after = this.#now();
    const chosen =
      request.originIcao === undefined
        ? statuses[0]
        : (statuses.find((status) => status.origin.icao === request.originIcao) ?? statuses[0]);

    if (chosen === undefined) {
      const denied = records.at(-1)?.error?.startsWith('budget_denied') === true;
      const outcome: ResolveResponse['outcome'] =
        failure === undefined ? 'not_found' : denied ? 'denied' : 'error';
      const stored = this.ctx.storage.transactionSync((): ResolutionRow | null => {
        this.#appendRecords(records, after);
        // A not-found is cached like a hit (a typo must not cost a call per search); a failure
        // is not, so the next search tries again.
        return outcome === 'not_found' ? this.#store(after, 'not_found', null, null, false) : null;
      });
      await this.#flushOutbox(after);
      if (stored !== null) {
        this.#writeSearchKv(stored);
        return this.#responseFrom(stored, false);
      }
      return {
        rpcVersion: RPC_SCHEMA_VERSION,
        outcome,
        cached: false,
        resolvedAt: new Date(after).toISOString(),
        expiresAt: null,
        reason: failure,
      };
    }

    const key = canonicalizeFromProvider(chosen);
    const status: FlightStatus = { ...chosen, key };
    let created = false;
    try {
      const seeded = await this.trackerFor(key).seed({
        rpcVersion: RPC_SCHEMA_VERSION,
        flightKey: key,
        status,
        designator,
        trigger: 'user_search',
      });
      created = seeded.status === 'seeded';
    } catch (error) {
      // The provider answered and was billed; the tracker could not be created. Record the
      // call, answer the search from the status, and let the next search seed again.
      this.#log.error('designator_resolver_seed_failed', {
        flight_key: key,
        ...errorFields(error),
      });
      this.ctx.storage.transactionSync(() => {
        this.#appendRecords(records, after);
      });
      await this.#flushOutbox(after);
      return {
        rpcVersion: RPC_SCHEMA_VERSION,
        outcome: 'error',
        flightKey: key,
        status,
        cached: false,
        resolvedAt: new Date(after).toISOString(),
        expiresAt: null,
        reason: 'seed_failed',
      };
    }
    const stored = this.ctx.storage.transactionSync((): ResolutionRow => {
      this.#appendRecords(records, after);
      return this.#store(after, 'resolved', key, status, created);
    });
    await this.#flushOutbox(after);
    this.#writeSearchKv(stored);
    return this.#responseFrom(stored, false);
  }

  // -------------------------------------------------------------------------------------------
  // Storage helpers.
  // -------------------------------------------------------------------------------------------

  #now(): number {
    if (this.#testClockMs !== null && this.env.TEST_CLOCK === 'true') {
      return this.#testClockMs;
    }
    return Date.now();
  }

  #ensureSchema(): void {
    if (this.#deleted) {
      this.#schema = runSqlMigrations(this.ctx, DesignatorResolver.MIGRATIONS);
      this.#deleted = false;
    }
  }

  #resolution(): ResolutionRow | null {
    return (
      this.ctx.storage.sql
        .exec<ResolutionRow>('SELECT * FROM resolution WHERE id = 1')
        .toArray()[0] ?? null
    );
  }

  /**
   * Stores the answer and arms the expiry alarm (inside the caller's transaction when there is
   * one; the alarm write is covered by its rollback). The lifetime epoch is the first store's
   * time and never changes for the life of the object.
   */
  #store(
    now: number,
    outcome: 'resolved' | 'not_found',
    flightKey: FlightKey | null,
    status: FlightStatus | null,
    created: boolean,
  ): ResolutionRow {
    const name = this.ctx.id.name ?? 'unnamed';
    const [designator, dateLocal] = splitName(name);
    const existing = this.#resolution();
    const epoch = existing?.created_at_ms ?? now;
    const expires = now + RESOLUTION_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO resolution (id, name, designator, date_local, outcome, flight_key, status,
                               created_flight, kv_written, created_at_ms, resolved_at_ms, expires_at_ms)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET outcome = excluded.outcome, flight_key = excluded.flight_key,
                                      status = excluded.status, created_flight = excluded.created_flight,
                                      kv_written = 0, resolved_at_ms = excluded.resolved_at_ms,
                                      expires_at_ms = excluded.expires_at_ms`,
      name,
      designator,
      dateLocal,
      outcome,
      flightKey,
      status === null ? null : JSON.stringify(status),
      created ? 1 : 0,
      epoch,
      now,
      expires,
    );
    void this.ctx.storage.setAlarm(expires);
    this.#cleanupArmed = true;
    const stored = this.#resolution();
    if (stored === null) {
      throw new Error('DesignatorResolver resolution row missing after insert');
    }
    return stored;
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

  /** Sends unsent rows to the `persist` queue; a failed send leaves them for the alarm. */
  async #flushOutbox(now: number): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<OutboxRow>('SELECT seq, payload FROM outbox WHERE sent_at_ms IS NULL ORDER BY seq')
      .toArray();
    if (rows.length === 0) {
      return;
    }
    const epoch = this.#resolution()?.created_at_ms ?? rows[0]?.seq ?? 0;
    const origin = designatorResolverOrigin(this.ctx.id.name ?? 'unnamed', epoch);
    const { chunks } = chunkOutbox(rows, (row) => ({
      ...(JSON.parse(row.payload) as Record<string, unknown>),
      seq: row.seq,
      origin,
    }));
    const outcome = await sendOutboxChunks(this.outboxSink, chunks, this.#log);
    if (outcome.sentSeqs.length > 0) {
      this.ctx.storage.sql.exec(
        `UPDATE outbox SET sent_at_ms = ? WHERE seq IN (${outcome.sentSeqs.map(() => '?').join(', ')})`,
        now,
        ...outcome.sentSeqs,
      );
    }
    if (outcome.error !== null && !this.#cleanupArmed) {
      // Nothing else would ever retry the send: the expiry alarm does, so make sure there is one.
      void this.ctx.storage.setAlarm(now + RESOLUTION_TTL_MS);
      this.#cleanupArmed = true;
    }
  }

  /** The Worker-side cache, written once per answer, off the critical path, never on failure. */
  #writeSearchKv(stored: ResolutionRow): void {
    if (stored.kv_written === 1) {
      return;
    }
    this.ctx.storage.sql.exec('UPDATE resolution SET kv_written = 1 WHERE id = 1');
    const value = this.#responseFrom(stored, true);
    const write = this.kv
      .put(searchKvKey(stored.designator, stored.date_local), JSON.stringify(value), {
        expirationTtl: SEARCH_KV_TTL_SECONDS,
      })
      .catch((error: unknown) => {
        this.#log.warn('designator_resolver_kv_write_failed', errorFields(error));
      })
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

  #responseFrom(stored: ResolutionRow, cached: boolean): ResolveResponse {
    const response: ResolveResponse = {
      rpcVersion: RPC_SCHEMA_VERSION,
      outcome: stored.outcome === 'resolved' ? 'resolved' : 'not_found',
      cached,
      resolvedAt: new Date(stored.resolved_at_ms).toISOString(),
      expiresAt: new Date(stored.expires_at_ms).toISOString(),
    };
    if (stored.flight_key !== null) {
      response.flightKey = stored.flight_key as FlightKey;
      response.created = stored.created_flight === 1;
    }
    if (stored.status !== null) {
      response.status = JSON.parse(stored.status) as FlightStatus;
    }
    return response;
  }
}

function splitName(name: string): [string, string] {
  const at = name.lastIndexOf('-', name.length - 11);
  return at <= 0 ? [name, ''] : [name.slice(0, at), name.slice(at + 1)];
}

// ---------------------------------------------------------------------------------------------
// The Worker-side half.
// ---------------------------------------------------------------------------------------------

export interface DesignatorSearchInput {
  readonly designator: string;
  readonly dateLocal: string;
  readonly originIcao?: string | undefined;
  readonly requestId?: string | undefined;
}

export type DesignatorSearchResult =
  ResolveResponse | { readonly outcome: 'overloaded'; readonly retryAfterSeconds: number };

export interface DesignatorSearchDeps {
  /** Resolves an object name to its stub; the default is `DESIGNATOR_RESOLVER.getByName`. */
  readonly stubFor?: ((name: string) => Pick<DesignatorResolver, 'resolve'>) | undefined;
  /** The jittered wait before the one retry; a test replaces it with a no-op. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly log?: Logger | undefined;
}

/** The undocumented account-level error a namespace under load answers with. */
export function isTooMuchLoadError(error: unknown): boolean {
  return error instanceof Error && /too much load/i.test(error.message);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The search: KV first, then the object, with one jittered retry on "generating too much
 * load" and an `overloaded` answer after that (the route sends 503 with `Retry-After`).
 */
export async function resolveDesignator(
  env: Pick<Env, 'DESIGNATOR_RESOLVER' | 'CACHE'>,
  input: DesignatorSearchInput,
  deps: DesignatorSearchDeps = {},
): Promise<DesignatorSearchResult> {
  const log = deps.log ?? createLogger();
  const designator = normalizeDesignator(input.designator);
  const name = `${designator}-${input.dateLocal}`;
  try {
    const cached: unknown = await env.CACHE.get(searchKvKey(designator, input.dateLocal), 'json');
    const parsed = ResolveResponseSchema.safeParse(cached);
    if (parsed.success) {
      return { ...parsed.data, cached: true };
    }
  } catch (error) {
    log.warn('designator_search_kv_read_failed', errorFields(error));
  }
  const stubFor =
    deps.stubFor ?? ((objectName: string) => env.DESIGNATOR_RESOLVER.getByName(objectName));
  const request: ResolveRequest = {
    rpcVersion: RPC_SCHEMA_VERSION,
    designator,
    dateLocal: input.dateLocal,
    ...(input.originIcao === undefined ? {} : { originIcao: input.originIcao }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  };
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await stubFor(name).resolve(request);
    } catch (error) {
      if (!isTooMuchLoadError(error) || attempt >= 1) {
        if (isTooMuchLoadError(error)) {
          log.error('designator_search_overloaded', { name, ...errorFields(error) });
          return { outcome: 'overloaded', retryAfterSeconds: OVERLOADED_RETRY_AFTER_SECONDS };
        }
        throw error;
      }
      log.warn('designator_search_retry', { name, ...errorFields(error) });
      await (deps.sleep ?? defaultSleep)(50 + Math.floor(Math.random() * 200));
    }
  }
}
