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
 *     delivery is a no-op that still acknowledges.
 *   - `flight_events`: insert on conflict `(flight_instance_id, seq)` do nothing, the instance
 *     id resolved by flight key in a preceding select. An event that arrives before its
 *     instance row throws and is retried with backoff: the row will exist by then.
 *   - `provider_calls`: insert on conflict `(id)` do nothing; the instance id resolved the same
 *     way when the record names a flight.
 *   - `provider_call_daily`: upsert on `(day, provider, operation, result)`, replacing the
 *     counters with the object's final ones.
 *
 * One `AnalyticsBudget` per invocation caps points at 200, every `writeDataPoint` sits in its
 * own try/catch with blobs truncated, and a bad point never fails its message. One database
 * client per batch (Hyperdrive closes it when the invocation ends); `max_concurrency` is 10 in
 * every environment, the Neon connection budget.
 *
 * After the batch, the seqs this invocation wrote are grouped by the FlightTracker lifetime that
 * sent them and confirmed with one `confirmPersisted` RPC each, at `locationHint: 'enam'`. A
 * failed confirmation is logged and not retried: the tracker re-sends every unconfirmed row on
 * its next flush, and these writes are idempotent.
 */

import { eq, sql } from 'drizzle-orm';
import {
  destinationColumns,
  flightEvents,
  flightInstances,
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
import { environmentName } from '../env';
import { raiseOpsAlert, type CaptureMessage } from '../observability/ops-alert';
import { errorFields } from '../observability/log';
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

async function instanceIdFor(db: Db, flightKey: string): Promise<string | null> {
  const [row] = await db
    .select({ id: flightInstances.id })
    .from(flightInstances)
    .where(eq(flightInstances.flightKey, flightKey))
    .limit(1);
  return row?.id ?? null;
}

/** The monotonic upsert. */
export async function upsertFlightInstance(
  db: Db,
  message: FlightInstanceMessageV1,
): Promise<void> {
  const p = message.payload;
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
    operatorSource: p.operatorSource,
    finishedAt: p.finishedAt,
    eventsR2Key: p.eventsR2Key,
  };
  await db
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
      // Monotonic: a stale or duplicate delivery changes nothing.
      setWhere: sql`${flightInstances.version} < excluded.version`,
    });
}

/** Insert on conflict `(flight_instance_id, seq)` do nothing; throws when the instance is absent. */
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
): Promise<void> {
  const instanceId = await instanceIdFor(db, flightKey);
  if (instanceId === null) {
    throw new InstanceMissingError(`no flight_instances row for ${flightKey} yet`);
  }
  await db
    .insert(flightEvents)
    .values({
      flightInstanceId: instanceId,
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
}

/** Insert on conflict `(id)` do nothing, with the instance id when the record names a flight. */
export async function insertProviderCall(db: Db, record: ProviderCallRecord): Promise<void> {
  const flightInstanceId =
    record.flightKey === undefined ? null : await instanceIdFor(db, record.flightKey);
  await db
    .insert(providerCalls)
    .values({ ...providerCallRow(record), flightInstanceId })
    .onConflictDoNothing({ target: providerCalls.id });
}

/**
 * The ProviderBudget's final counters as one `provider_call_daily` row per day and provider.
 * The object counts units and calls, not operations or results, so the row's `operation` is
 * `budget_daily` and its `result` is `ok`; the housekeeping roll-up of `provider_calls`
 * (increment 12) fills the per-operation rows next to it.
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
      operation: 'budget_daily',
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

interface Confirmation {
  readonly flightKey: FlightKey;
  readonly epochMs: number;
  readonly seqs: number[];
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
  const confirmations = new Map<string, Confirmation>();

  const outcome = await consumeBatch(
    batch,
    async (message) => {
      const parsed = PersistMessageV1.safeParse(message.body);
      if (!parsed.success) {
        // A message this build cannot read can never succeed on retry: acknowledge it, loudly.
        log.error('persist_message_invalid', {
          message_id: message.id,
          attempts: message.attempts,
          issue: parsed.error.issues[0]?.message,
        });
        return;
      }
      const body = parsed.data;
      switch (body.kind) {
        case 'flight_instance':
          await upsertFlightInstance(database(), body);
          break;
        case 'flight_event':
          await insertFlightEvent(database(), body.flightKey, body.seq, body.payload);
          break;
        case 'provider_call':
          await insertProviderCall(database(), body.payload);
          analytics.write(providerCallPoint(body.payload, environment));
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
      const origin = parseFlightTrackerOrigin(body.origin);
      if (origin !== null) {
        const entry = confirmations.get(body.origin) ?? { ...origin, seqs: [] };
        entry.seqs.push(body.seq);
        confirmations.set(body.origin, entry);
      }
    },
    log,
  );

  const trackerFor =
    deps.trackerFor ??
    ((flightKey: FlightKey): ConfirmingTracker =>
      env.FLIGHT_TRACKER.getByName(flightKey, { locationHint: 'enam' }));
  for (const confirmation of confirmations.values()) {
    try {
      const result = await trackerFor(confirmation.flightKey).confirmPersisted({
        rpcVersion: RPC_SCHEMA_VERSION,
        epochMs: confirmation.epochMs,
        seqs: confirmation.seqs,
      });
      log.debug('persist_confirmed', {
        flight_key: confirmation.flightKey,
        seqs: confirmation.seqs.length,
        deleted: result.deleted,
        matched: result.matched,
      });
    } catch (error) {
      // Not retried: the tracker re-sends unconfirmed rows and the writes above are idempotent.
      log.error('persist_confirm_failed', {
        flight_key: confirmation.flightKey,
        seqs: confirmation.seqs.length,
        ...errorFields(error),
      });
    }
  }

  analytics.report('persist_analytics');
  log.info('persist_batch_done', {
    queue: batch.queue,
    size: batch.messages.length,
    confirmations: confirmations.size,
    ...outcome,
  });
}
