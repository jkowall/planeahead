/**
 * `persist` queue consumer (increment 7).
 *
 * This is the only path from a Durable Object to Postgres (ADR 0007): a tracker appends outbox
 * rows, flushes them here, and this consumer writes `flight_instances`, `flight_events` and
 * `provider_calls`, emits the Analytics Engine point for each provider call, writes the
 * ProviderBudget's daily counters and raises its kill-switch alert.
 *
 * Queues deliver at least once and out of order, so every write is idempotent and the instance
 * write is monotonic:
 *
 *   - `flight_instances`: upsert on the `flight_key` unique index, applied only when the
 *     incoming `version` is greater than the stored one (`setWhere`). A stale or duplicate
 *     delivery is a no-op that still acknowledges. The row also records the tracker LIFETIME it
 *     was written from (`do_lifetime_epoch_ms`, the `@{epochMs}` of the message's origin,
 *     ruling L9): an instance or event row from an OLDER lifetime than the stored one is
 *     ignored, and a NEWER lifetime for an instance whose tracking state is terminal is refused
 *     with the `flight_lifetime_rejected` ops alert. A finished flight never gets a second
 *     lifetime; a reborn tracker is a bug, not data. (A newer lifetime for a row that is still
 *     active is applied and logged: that is a recovery, not a rebirth.) Increment 8: the upsert
 *     runs in a transaction with the `flight_sync_changes` row it records (the sync feed's flight
 *     half, ADR 0012), inserted only when the upsert changed the row.
 *   - `flight_events`: insert on conflict `(flight_instance_id, seq)` do nothing, the instance
 *     id resolved by flight key in a preceding select. An event that arrives before its
 *     instance row throws and is retried with backoff: the row will exist by then.
 *   - `provider_calls`: insert on conflict `(id)` do nothing; the instance id resolved the same
 *     way when the record names a flight. The Analytics Engine point is written only when the
 *     row was inserted, so a redelivery never inflates the per-provider metrics (AE has no
 *     dedupe key).
 *   - `provider_call_daily`: one row PER ProviderBudget object, upserted on `(day, provider,
 *     operation, result)` with the counters REPLACED: operation `budget_daily` for the unsharded
 *     object, `budget_daily:{n}` per shard (ruling L10). Never summed: at-least-once delivery
 *     would count a redelivery twice. The increment 12 roll-up excludes operations starting
 *     with `budget_daily` from per-operation sums (docs/schema-review.md).
 *
 * One `AnalyticsBudget` per invocation caps points at 200, every `writeDataPoint` sits in its
 * own try/catch with blobs truncated, and a bad point never fails its message. One database
 * client per batch (Hyperdrive closes it when the invocation ends); `max_concurrency` is 10 in
 * every environment, the Neon connection budget.
 *
 * After the batch, the seqs this invocation acknowledged are grouped by the FlightTracker lifetime
 * that sent them and confirmed with one `confirmPersisted` RPC each, at `locationHint: 'enam'`. A
 * failed confirmation is logged and not retried: the tracker re-sends every unconfirmed row on
 * its next flush, and these writes are idempotent. EVERY acknowledged message is confirmed, a
 * message this build cannot read included: its `origin` and `seq` are read with the minimal
 * `PersistMessageIdentityV1` before the full validation, because no retry and no build will ever
 * write it, and an unconfirmed row would pin its finished tracker (hourly re-sends, for ever). The
 * dead-letter consumer confirms NOTHING: a message dead-letters after five retries spanning about
 * a minute, which a transient Postgres or Hyperdrive outage exceeds as easily as a poison row
 * does, and a confirmed row is deleted; it reports the dead-lettering instead (the same RPC with
 * `deadLettered: true`, src/queues/dlq.ts) and the tracker keeps the row and re-sends it with a
 * doubling spacing. The helpers below are what both consumers share.
 */

import { eq, sql } from 'drizzle-orm';
import {
  TERMINAL_TRACKING_STATES,
  destinationColumns,
  flightEvents,
  flightInstances,
  flightSyncChanges,
  openDb,
  originColumns,
  providerCallDaily,
  providerCalls,
  resolveAirportEndpoint,
  type Db,
} from '@planeahead/db';
import {
  ADB_UNIT_PRICE_USD_MICROS,
  AEROAPI_STATUS_PRICE_USD_MICROS,
  PersistMessageIdentityV1,
  PersistMessageV1,
  RPC_SCHEMA_VERSION,
  parseFlightTrackerOrigin,
  providerCallPoint,
  type ConfirmPersistedResponseV1,
  type Exact,
  type FlightInstanceMessageV1,
  type FlightKey,
  type ProviderBudgetDailyMessageV1,
  type ProviderCallRecord,
} from '@planeahead/shared';
import { environmentName, type Env } from '../env';
import { raiseOpsAlert, type CaptureMessage } from '../observability/ops-alert';
import { errorFields, type Logger } from '../observability/log';
import { providerCallRow } from '../providers/cost-log';
import { AnalyticsBudget } from './analytics';
import { consumeBatch } from './consume';
import type { QueueContext } from './index';

/** The wire shape; `PersistMessageV1` in shared is the contract, this is what a batch carries. */
export type PersistMessage = unknown;

/** The tracker RPC the consumer needs, narrowed so a test can hand in a fake. */
export interface ConfirmingTracker {
  confirmPersisted(input: unknown): Promise<Exact<ConfirmPersistedResponseV1>>;
}

export interface PersistDeps {
  /** The Sentry call behind the kill-switch alert; injectable so a test can observe it. */
  readonly capture?: CaptureMessage | undefined;
  /** Resolves a flight key to its tracker; the default is `FLIGHT_TRACKER.getByName`. */
  readonly trackerFor?: ((flightKey: FlightKey) => ConfirmingTracker) | undefined;
  /** The database handle; the default opens one on the Hyperdrive binding per batch. */
  readonly db?: Db | undefined;
}

const AIRCRAFT_TYPE_RE = /^[A-Z0-9]{2,4}$/;
const ICAO_HEX_RE = /^[0-9A-F]{6}$/;
const ICAO_AIRPORT_RE = /^[A-Z0-9]{4}$/;

function payloadFields(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null
    ? { ...(payload as Record<string, unknown>) }
    : {};
}

function checked(value: string | undefined, re: RegExp): string | null {
  return value !== undefined && re.test(value) ? value : null;
}

export class InstanceMissingError extends Error {
  override readonly name = 'InstanceMissingError';
}

/**
 * What a lifetime-aware write did. `stale_lifetime`: the row came from an older lifetime than
 * the stored one and was ignored. `rejected_lifetime`: a newer lifetime for a terminal instance,
 * ignored and alerted.
 */
export type LifetimeWrite = 'applied' | 'stale_lifetime' | 'rejected_lifetime';

interface StoredInstance {
  readonly id: string;
  readonly epochMs: number | null;
  readonly trackingState: string;
}

/** Anything that can select: the batch's handle or a transaction on it. */
type Selector = Pick<Db, 'select'>;

async function storedInstanceFor(db: Selector, flightKey: string): Promise<StoredInstance | null> {
  const [row] = await db
    .select({
      id: flightInstances.id,
      epochMs: flightInstances.doLifetimeEpochMs,
      trackingState: flightInstances.trackingState,
    })
    .from(flightInstances)
    .where(eq(flightInstances.flightKey, flightKey))
    .limit(1);
  return row ?? null;
}

async function instanceIdFor(db: Selector, flightKey: string): Promise<string | null> {
  return (await storedInstanceFor(db, flightKey))?.id ?? null;
}

function isTerminal(trackingState: string): boolean {
  return (TERMINAL_TRACKING_STATES as readonly string[]).includes(trackingState);
}

/** The lifetime rule shared by the instance and event writes; null means write. */
function lifetimeVerdict(
  stored: StoredInstance | null,
  epochMs: number | null,
): Exclude<LifetimeWrite, 'applied'> | null {
  if (stored === null || epochMs === null || stored.epochMs === null) {
    return null;
  }
  if (epochMs < stored.epochMs) {
    return 'stale_lifetime';
  }
  if (epochMs > stored.epochMs && isTerminal(stored.trackingState)) {
    return 'rejected_lifetime';
  }
  return null;
}

/**
 * The monotonic, lifetime-aware upsert. `epochMs` is the origin's lifetime, null if unknown.
 *
 * Increment 8 (ruling K4): the upsert and its `flight_sync_changes` row are one transaction on
 * one connection (`db.transaction`, postgres.js `sql.begin`; Hyperdrive may hand one invocation
 * several connections, so two statements outside a transaction could land on two). The change row
 * is written only when the upsert changed the row (`RETURNING` answered), so a duplicate or stale
 * delivery adds nothing to the sync feed, and the row carries the snapshot this upsert stored.
 */
export async function upsertFlightInstance(
  db: Db,
  message: FlightInstanceMessageV1,
  epochMs: number | null = parseFlightTrackerOrigin(message.origin)?.epochMs ?? null,
): Promise<LifetimeWrite> {
  return db.transaction((tx) => upsertFlightInstanceIn(tx, message, epochMs));
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function upsertFlightInstanceIn(
  db: Tx,
  message: FlightInstanceMessageV1,
  epochMs: number | null,
): Promise<LifetimeWrite> {
  const p = message.payload;
  const stored = await storedInstanceFor(db, message.flightKey);
  const verdict = lifetimeVerdict(stored, epochMs);
  if (verdict !== null) {
    return verdict;
  }
  const snapshot = p.snapshot;
  const origin = await resolveAirportEndpoint(db, p.originIcao);
  const destinationIcao = checked(snapshot?.destination.icao, ICAO_AIRPORT_RE);
  const destination =
    destinationIcao === null ? null : await resolveAirportEndpoint(db, destinationIcao);
  const times = snapshot?.times ?? {};
  const mutable = {
    ...(origin === null ? {} : originColumns(origin)),
    ...(destination === null ? { destinationIcao } : destinationColumns(destination)),
    divertedToIcao: checked(snapshot?.actualDestination?.icao, ICAO_AIRPORT_RE),
    status: snapshot?.status ?? 'scheduled',
    scheduledOut: times.scheduledOut ?? null,
    estimatedOut: times.estimatedOut ?? null,
    actualOut: times.actualOut ?? null,
    scheduledOff: times.scheduledOff ?? null,
    estimatedOff: times.estimatedOff ?? null,
    actualOff: times.actualOff ?? null,
    scheduledOn: times.scheduledOn ?? null,
    estimatedOn: times.estimatedOn ?? null,
    actualOn: times.actualOn ?? null,
    scheduledIn: times.scheduledIn ?? null,
    estimatedIn: times.estimatedIn ?? null,
    actualIn: times.actualIn ?? null,
    originTerminal: snapshot?.originTerminal ?? null,
    originGate: snapshot?.originGate ?? null,
    destinationTerminal: snapshot?.destinationTerminal ?? null,
    destinationGate: snapshot?.destinationGate ?? null,
    baggageClaim: snapshot?.baggageClaim ?? null,
    aircraftTypeIcao: checked(snapshot?.aircraftTypeIcao, AIRCRAFT_TYPE_RE),
    registration: snapshot?.registration ?? null,
    icaoHex: checked(snapshot?.icaoHex, ICAO_HEX_RE),
    aeroapiFaFlightId: snapshot?.providerRefs['aeroapi'] ?? null,
    aerodataboxRef: snapshot?.providerRefs['aerodatabox'] ?? null,
    trackingState: p.trackingState,
    refreshCadence: p.refreshCadence,
    nextRefreshAt: p.nextRefreshAt,
    lastRefreshedAt: p.lastRefreshedAt,
    providerCallCount: p.providerCallCount,
    providerCostUnits: Math.round(p.providerCostUnits),
    subscriberCount: p.subscriberCount,
    doSchemaVersion: p.doSchemaVersion,
    version: p.version,
    doLifetimeEpochMs: epochMs,
    operatorSource: p.operatorSource,
    finishedAt: p.finishedAt,
    eventsR2Key: p.eventsR2Key,
  };
  const written = await db
    .insert(flightInstances)
    .values({
      operatingCarrierIcao: p.operatingCarrierIcao,
      flightNumber: p.flightNumber,
      scheduledDepartureDate: p.scheduledDepartureDate,
      originIcao: p.originIcao,
      legSeq: p.legSeq,
      ...mutable,
    })
    .onConflictDoUpdate({
      target: flightInstances.flightKey,
      set: mutable,
      // Monotonic within a lifetime: a stale or duplicate delivery changes nothing. A newer
      // lifetime (a recovery of a row that is still active; a terminal row was refused above)
      // starts its own version sequence and is applied whatever the stored version.
      setWhere: sql`${flightInstances.version} < excluded.version
        or (${flightInstances.doLifetimeEpochMs} is not null
            and excluded.do_lifetime_epoch_ms is not null
            and ${flightInstances.doLifetimeEpochMs} < excluded.do_lifetime_epoch_ms)`,
    })
    .returning({ id: flightInstances.id });
  const row = written[0];
  if (row !== undefined && snapshot !== null && snapshot !== undefined) {
    // Insert only: the xid DEFAULT fires on insert, never on an upsert's DO UPDATE branch.
    await db.insert(flightSyncChanges).values({
      flightInstanceId: row.id,
      snapshot: { ...snapshot, key: message.flightKey },
    });
  }
  return 'applied';
}

/**
 * Insert on conflict `(flight_instance_id, seq)` do nothing; throws when the instance is absent,
 * or when the event's lifetime is newer than an active instance's (its own instance row has not
 * landed yet: it will, and the retry finds it).
 */
export async function insertFlightEvent(
  db: Db,
  flightKey: string,
  seq: number,
  payload: {
    occurredAt: string;
    type: string;
    field: string | null;
    oldValue?: unknown;
    newValue?: unknown;
    source: string;
    providerCallId: string | null;
  },
  epochMs: number | null = null,
): Promise<LifetimeWrite> {
  const stored = await storedInstanceFor(db, flightKey);
  if (stored === null) {
    throw new InstanceMissingError(`no flight_instances row for ${flightKey} yet`);
  }
  const verdict = lifetimeVerdict(stored, epochMs);
  if (verdict !== null) {
    return verdict;
  }
  if (epochMs !== null && stored.epochMs !== null && epochMs > stored.epochMs) {
    throw new InstanceMissingError(
      `flight_instances row for ${flightKey} is from an older lifetime; its instance row is due`,
    );
  }
  await db
    .insert(flightEvents)
    .values({
      flightInstanceId: stored.id,
      seq,
      occurredAt: payload.occurredAt,
      type: payload.type,
      field: payload.field,
      oldValue: payload.oldValue === undefined ? null : payload.oldValue,
      newValue: payload.newValue === undefined ? null : payload.newValue,
      source: payload.source,
      providerCallId: payload.providerCallId,
    })
    .onConflictDoNothing({ target: [flightEvents.flightInstanceId, flightEvents.seq] });
  return 'applied';
}

/**
 * Insert on conflict `(id)` do nothing, with the instance id when the record names a flight.
 * Returns whether this call inserted the row, so the caller writes the Analytics Engine point
 * once per record, not once per delivery.
 */
export async function insertProviderCall(db: Db, record: ProviderCallRecord): Promise<boolean> {
  const flightInstanceId =
    record.flightKey === undefined ? null : await instanceIdFor(db, record.flightKey);
  const inserted = await db
    .insert(providerCalls)
    .values({ ...providerCallRow(record), flightInstanceId })
    .onConflictDoNothing({ target: providerCalls.id })
    .returning({ id: providerCalls.id });
  return inserted.length > 0;
}

/** The `provider_call_daily.operation` of one ProviderBudget object's row (ruling L10). */
export function budgetDailyOperation(shard: number | null): string {
  return shard === null ? 'budget_daily' : `budget_daily:${String(shard)}`;
}

/**
 * The ProviderBudget's final counters as one `provider_call_daily` row per day, provider AND
 * object (shard). The object counts units and calls, not operations or results, so the row's
 * `operation` is `budget_daily` (or `budget_daily:{shard}`) and its `result` is `ok`, the
 * counters replaced on every delivery; the housekeeping roll-up of `provider_calls` (increment
 * 12) fills the per-operation rows next to it and excludes these from per-operation sums.
 */
export async function upsertProviderCallDaily(
  db: Db,
  message: ProviderBudgetDailyMessageV1,
): Promise<void> {
  const p = message.payload;
  const unitPrice =
    p.provider === 'aerodatabox' ? ADB_UNIT_PRICE_USD_MICROS : AEROAPI_STATUS_PRICE_USD_MICROS;
  const counters = {
    calls: p.calls,
    costUnits: Math.round(p.units),
    costUsdMicros: Math.round(p.units * unitPrice),
  };
  await db
    .insert(providerCallDaily)
    .values({
      day: p.utcDate,
      provider: p.provider,
      operation: budgetDailyOperation(p.shard),
      result: 'ok',
      ...counters,
    })
    .onConflictDoUpdate({
      target: [
        providerCallDaily.day,
        providerCallDaily.provider,
        providerCallDaily.operation,
        providerCallDaily.result,
      ],
      set: counters,
    });
}

/** The seqs one tracker lifetime sent, confirmed in one RPC. */
export interface Confirmation {
  readonly flightKey: FlightKey;
  readonly epochMs: number;
  readonly seqs: number[];
}

/** Confirmations grouped by origin, one tracker lifetime each. */
export type Confirmations = Map<string, Confirmation>;

/** `FLIGHT_TRACKER.getByName` at the one location hint every tracker call site uses. */
export function defaultTrackerFor(env: Env): (flightKey: FlightKey) => ConfirmingTracker {
  return (flightKey) => env.FLIGHT_TRACKER.getByName(flightKey, { locationHint: 'enam' });
}

/**
 * Records an acknowledged message for the confirmation push when its origin names a tracker
 * lifetime; a ProviderBudget's or a DesignatorResolver's message is confirmed to no one.
 */
export function noteConfirmation(confirmations: Confirmations, origin: string, seq: number): void {
  const parsed = parseFlightTrackerOrigin(origin);
  if (parsed === null) {
    return;
  }
  const entry = confirmations.get(origin) ?? { ...parsed, seqs: [] };
  entry.seqs.push(seq);
  confirmations.set(origin, entry);
}

/**
 * One `confirmPersisted` per tracker lifetime: a confirmation (the seqs are stored; the tracker
 * deletes their rows) or, with `deadLettered`, the dead-letter consumer's notice (the seqs
 * exhausted their retries; the tracker stamps their rows and keeps them). A failure is logged and
 * not retried: the tracker re-sends every unconfirmed row on its next flush, and the consumers'
 * writes are idempotent.
 */
export async function confirmPersistedSeqs(
  confirmations: Confirmations,
  trackerFor: (flightKey: FlightKey) => ConfirmingTracker,
  log: Logger,
  deadLettered = false,
): Promise<void> {
  for (const confirmation of confirmations.values()) {
    try {
      const result = await trackerFor(confirmation.flightKey).confirmPersisted({
        rpcVersion: RPC_SCHEMA_VERSION,
        epochMs: confirmation.epochMs,
        seqs: confirmation.seqs,
        ...(deadLettered ? { deadLettered: true } : {}),
      });
      const fields = {
        flight_key: confirmation.flightKey,
        seqs: confirmation.seqs.length,
        deleted: result.deleted,
        remaining: result.remaining,
        matched: result.matched,
      };
      if (deadLettered) {
        log.info('persist_dead_letter_noted', fields);
      } else {
        log.debug('persist_confirmed', fields);
      }
    } catch (error) {
      log.error('persist_confirm_failed', {
        flight_key: confirmation.flightKey,
        seqs: confirmation.seqs.length,
        dead_lettered: deadLettered,
        ...errorFields(error),
      });
    }
  }
}

export async function handlePersistBatch(
  batch: MessageBatch<PersistMessage>,
  { env, log }: QueueContext,
  deps: PersistDeps = {},
): Promise<void> {
  const analytics = new AnalyticsBudget(env.PROVIDER_CALLS, log);
  const environment = environmentName(env);
  let db: Db | null = deps.db ?? null;
  const database = (): Db => {
    // Opened on first use, once per batch: a batch of budget alerts never dials Postgres.
    db ??= openDb(env);
    return db;
  };
  const confirmations: Confirmations = new Map();
  /** Flight keys already alerted for a rejected lifetime in this batch (one alert per key). */
  const rejected = new Set<string>();
  const lifetimeOutcome = (
    body: { kind: string; flightKey?: string | undefined; origin: string; seq: number },
    outcome: LifetimeWrite,
  ): void => {
    if (outcome === 'applied') {
      return;
    }
    const fields = {
      kind: body.kind,
      flight_key: body.flightKey,
      origin: body.origin,
      seq: body.seq,
    };
    if (outcome === 'stale_lifetime') {
      log.info('persist_stale_lifetime', fields);
      return;
    }
    if (body.flightKey !== undefined && rejected.has(body.flightKey)) {
      log.error('persist_lifetime_rejected', fields);
      return;
    }
    if (body.flightKey !== undefined) {
      rejected.add(body.flightKey);
    }
    raiseOpsAlert('flight_lifetime_rejected', fields, log, deps.capture);
  };

  const outcome = await consumeBatch(
    batch,
    async (message) => {
      const parsed = PersistMessageV1.safeParse(message.body);
      if (!parsed.success) {
        // A message this build cannot read can never succeed on retry: acknowledge it, loudly,
        // with the body on the log line (this is its only trace), and confirm it to the tracker
        // lifetime it came from when the envelope says which, or that row is re-sent for ever.
        log.error('persist_message_invalid', {
          message_id: message.id,
          attempts: message.attempts,
          issue: parsed.error.issues[0]?.message,
          body: message.body,
        });
        const identity = PersistMessageIdentityV1.safeParse(message.body);
        if (identity.success) {
          noteConfirmation(confirmations, identity.data.origin, identity.data.seq);
        }
        return;
      }
      const body = parsed.data;
      const origin = parseFlightTrackerOrigin(body.origin);
      switch (body.kind) {
        case 'flight_instance':
          lifetimeOutcome(
            body,
            await upsertFlightInstance(database(), body, origin?.epochMs ?? null),
          );
          break;
        case 'flight_event':
          lifetimeOutcome(
            body,
            await insertFlightEvent(
              database(),
              body.flightKey,
              body.seq,
              body.payload,
              origin?.epochMs ?? null,
            ),
          );
          break;
        case 'provider_call':
          if (await insertProviderCall(database(), body.payload)) {
            analytics.write(providerCallPoint(body.payload, environment));
          }
          break;
        case 'provider_budget_kill_switch':
          // A queue handler has a Sentry client (withSentry wraps queue()); the object does not.
          raiseOpsAlert(
            'provider_kill_switch_tripped',
            { origin: body.origin, ...payloadFields(body.payload) },
            log,
            deps.capture,
          );
          break;
        case 'provider_budget_daily':
          await upsertProviderCallDaily(database(), body);
          log.info('provider_budget_daily', {
            origin: body.origin,
            ...payloadFields(body.payload),
          });
          break;
      }
      noteConfirmation(confirmations, body.origin, body.seq);
    },
    log,
  );

  await confirmPersistedSeqs(confirmations, deps.trackerFor ?? defaultTrackerFor(env), log);

  analytics.report('persist_analytics');
  log.info('persist_batch_done', {
    queue: batch.queue,
    size: batch.messages.length,
    confirmations: confirmations.size,
    ...outcome,
  });
}
