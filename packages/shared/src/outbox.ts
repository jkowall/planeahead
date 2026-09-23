import { z } from 'zod';
import { FlightKeySchema, type FlightKey } from './flight-key';
import {
  FlightStatusSchema,
  IsoDateSchema,
  IsoInstantSchema,
  OperatorSourceSchema,
  ProviderCallRecordSchema,
  ProviderIdSchema,
} from './flight-status';
import { TrackerPhaseSchema } from './rpc';

/**
 * The messages a Durable Object's outbox sends to the `persist` queue (increment 7). One
 * discriminated union on `kind`, so the persist consumer routes with an exhaustive switch and a
 * message this build does not know is refused by the parse, never half-applied:
 *
 * - `flight_instance`: a FlightTracker's snapshot row. It carries the natural key columns the
 *   generated `flight_instances.flight_key` needs, the monotonically increasing `version` the
 *   consumer's upsert guards on (Queues deliver at least once and out of order), the tracking
 *   state, the next refresh time the reconcile cron reads, and the Durable Object schema version.
 * - `flight_event`: one timeline row. The message's `seq` is the OUTBOX sequence, and it is also
 *   the event's `seq` in `flight_events` (unique on `flight_instance_id, seq`), so a redelivery
 *   is a conflict and a no-op.
 * - `provider_call`: one `ProviderCallRecord`, unchanged from increment 6 (the api's
 *   `PROVIDER_CALL_OUTBOX_KIND` is the same literal). The consumer derives the Analytics Engine
 *   point from it with `providerCallPoint`; there is no separate analytics kind.
 * - `provider_budget_kill_switch` and `provider_budget_daily`: the ProviderBudget kinds as built
 *   in increment 6, unchanged; their payloads are read loosely.
 *
 * Every message names its sender's LIFETIME in `origin` (`flight_tracker:{key}@{epochMs}`,
 * `provider_budget:{name}@{epochMs}`, `designator_resolver:{name}@{epochMs}`), so `(origin, seq)`
 * is unique even when an object is recreated after `deleteAll()`, and the consumer confirms
 * persisted seqs back to the one tracker lifetime that sent them and to nothing else. The
 * tracker's epoch is also stored on `flight_instances.do_lifetime_epoch_ms`: the consumer ignores
 * instance and event rows from an OLDER lifetime than the stored one, and refuses a NEWER
 * lifetime for an instance whose tracking state is terminal (a finished flight never gets a
 * second lifetime, ruling L9).
 *
 * Every object schema is `looseObject` for the same reason as `flight-status.ts`: a consumer one
 * release behind a producer keeps the fields it does not know. Nothing here reads a clock.
 */

export const OUTBOX_SCHEMA_VERSION = 1;
const outboxVersion = z.int().min(1).default(OUTBOX_SCHEMA_VERSION);

export const OUTBOX_KINDS = [
  'flight_instance',
  'flight_event',
  'provider_call',
  'provider_budget_kill_switch',
  'provider_budget_daily',
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];

/** Mirrors `TRACKING_STATES` in `@planeahead/db`; a db test asserts the two lists agree. */
export const FLIGHT_TRACKING_STATES = [
  'pending',
  'tracking',
  'airborne',
  'landed',
  'finished',
  'archived',
  'superseded',
] as const;
export const FlightTrackingStateSchema = z.enum(FLIGHT_TRACKING_STATES);
export type FlightTrackingState = z.infer<typeof FlightTrackingStateSchema>;

/** Mirrors `REFRESH_CADENCES` in `@planeahead/db` and `CadenceId` in `cadence.ts`. */
export const RefreshCadenceSchema = z.enum(['literal', 'A1', 'A2', 'B']);

export const FLIGHT_TRACKER_ORIGIN_PREFIX = 'flight_tracker:';
export const DESIGNATOR_RESOLVER_ORIGIN_PREFIX = 'designator_resolver:';

/** `flight_tracker:{key}@{epochMs}`: one FlightTracker lifetime. */
export function flightTrackerOrigin(flightKey: FlightKey, epochMs: number): string {
  return `${FLIGHT_TRACKER_ORIGIN_PREFIX}${flightKey}@${String(epochMs)}`;
}

/** `designator_resolver:{name}@{epochMs}`: one DesignatorResolver lifetime. */
export function designatorResolverOrigin(name: string, epochMs: number): string {
  return `${DESIGNATOR_RESOLVER_ORIGIN_PREFIX}${name}@${String(epochMs)}`;
}

export interface FlightTrackerOrigin {
  flightKey: FlightKey;
  epochMs: number;
}

const FLIGHT_TRACKER_ORIGIN_RE = /^flight_tracker:([^@]+)@([0-9]{1,16})$/;

/** The tracker lifetime an origin names, or null for any other sender. */
export function parseFlightTrackerOrigin(origin: string): FlightTrackerOrigin | null {
  const match = FLIGHT_TRACKER_ORIGIN_RE.exec(origin);
  const key = match?.[1];
  const epoch = match?.[2];
  if (key === undefined || epoch === undefined) {
    return null;
  }
  const parsedKey = FlightKeySchema.safeParse(key);
  if (!parsedKey.success) {
    return null;
  }
  return { flightKey: parsedKey.data, epochMs: Number(epoch) };
}

/**
 * The `flight_instances` row a tracker sends. The natural key columns are written explicitly
 * rather than derived from the key by the consumer, so the row the database generates its
 * `flight_key` from is exactly what the tracker meant.
 */
export const FlightInstanceOutboxPayloadV1 = z.looseObject({
  operatingCarrierIcao: z.string().min(3).max(3),
  flightNumber: z.string().min(1),
  scheduledDepartureDate: IsoDateSchema,
  originIcao: z.string().min(4).max(4),
  legSeq: z.int().min(1),
  /** Monotonic; the consumer applies a row only when this exceeds the stored version. */
  version: z.int().nonnegative(),
  phase: TrackerPhaseSchema,
  trackingState: FlightTrackingStateSchema,
  refreshCadence: RefreshCadenceSchema.nullable(),
  nextRefreshAt: IsoInstantSchema.nullable(),
  lastRefreshedAt: IsoInstantSchema.nullable(),
  doSchemaVersion: z.int().nonnegative(),
  snapshot: FlightStatusSchema.nullable(),
  providerCallCount: z.int().nonnegative(),
  providerCostUnits: z.number().nonnegative(),
  subscriberCount: z.int().nonnegative(),
  operatorSource: OperatorSourceSchema.nullable(),
  finishedAt: IsoInstantSchema.nullable(),
  eventsR2Key: z.string().nullable(),
});
export type FlightInstanceOutboxPayloadV1 = z.infer<typeof FlightInstanceOutboxPayloadV1>;

export const FlightEventOutboxPayloadV1 = z.looseObject({
  occurredAt: IsoInstantSchema,
  /** The DO's own vocabulary; `flight_events.type` is deliberately not check-constrained. */
  type: z.string().min(1),
  field: z.string().nullable().default(null),
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
  /** A `ProviderId`, `system` or `user` (`flight_events.source`). */
  source: z.string().min(1),
  providerCallId: z.uuid().nullable().default(null),
});
export type FlightEventOutboxPayloadV1 = z.infer<typeof FlightEventOutboxPayloadV1>;

const envelope = {
  outboxVersion,
  /** The sender's outbox sequence, unique per `origin`. */
  seq: z.int().nonnegative(),
  origin: z.string().min(1),
};

/**
 * The two envelope fields a consumer needs to name a message it cannot otherwise read. The
 * persist consumer confirms every message it acknowledges to the tracker lifetime that sent it,
 * an unreadable one included (no build will ever write it, and an unconfirmed row would pin its
 * finished tracker for ever); the dead-letter consumer reports a dead-lettered message by the
 * same two fields (`confirmPersisted` with `deadLettered: true`) and confirms nothing. Both parse
 * this before, or instead of, the full `PersistMessageV1`.
 */
export const PersistMessageIdentityV1 = z.looseObject({
  seq: envelope.seq,
  origin: envelope.origin,
});
export type PersistMessageIdentityV1 = z.infer<typeof PersistMessageIdentityV1>;

/**
 * How a FlightTracker re-sends an outbox row the dead-letter consumer reported (ADR 0011 item
 * 5). A `persist` message dead-letters after five consumer retries spanning about a minute, which
 * a transient Postgres or Hyperdrive outage exceeds as easily as a poison row does, so the row is
 * kept and re-sent: `DEAD_LETTER_RESEND_MS x 2^(count - 1)` after its last dead-lettering, from
 * one hour, doubling to `DEAD_LETTER_RESEND_MAX_MS`. A transient outage heals on the first
 * re-send after recovery; a poison row costs a bounded, decaying stream of dead-letter events
 * that settles at one per day per row.
 */
export const DEAD_LETTER_RESEND_MS = 60 * 60_000;
export const DEAD_LETTER_RESEND_MAX_MS = 24 * 60 * 60_000;

/** The spacing before a row dead-lettered `count` times (at least once) is re-sent. */
export function deadLetterResendSpacingMs(count: number): number {
  const doublings = Math.max(0, Math.floor(count) - 1);
  // `2 ** doublings` is Infinity past 1023 doublings, which `Math.min` still reads as the cap.
  return Math.min(DEAD_LETTER_RESEND_MAX_MS, DEAD_LETTER_RESEND_MS * 2 ** doublings);
}

export const FlightInstanceMessageV1 = z.looseObject({
  ...envelope,
  kind: z.literal('flight_instance'),
  flightKey: FlightKeySchema,
  payload: FlightInstanceOutboxPayloadV1,
});
export type FlightInstanceMessageV1 = z.infer<typeof FlightInstanceMessageV1>;

export const FlightEventMessageV1 = z.looseObject({
  ...envelope,
  kind: z.literal('flight_event'),
  flightKey: FlightKeySchema,
  payload: FlightEventOutboxPayloadV1,
});
export type FlightEventMessageV1 = z.infer<typeof FlightEventMessageV1>;

export const ProviderCallMessageV1 = z.looseObject({
  ...envelope,
  kind: z.literal('provider_call'),
  /** Absent for a search that found nothing: there is no flight to attribute it to yet. */
  flightKey: FlightKeySchema.optional(),
  payload: ProviderCallRecordSchema,
});
export type ProviderCallMessageV1 = z.infer<typeof ProviderCallMessageV1>;

/** What the ProviderBudget object writes when it trips (increment 6, `#appendKillAlert`). */
export const ProviderBudgetKillSwitchPayloadV1 = z.looseObject({
  provider: ProviderIdSchema,
  utcDate: IsoDateSchema,
  reason: z.string().min(1),
  atMs: z.number(),
});

/** The ProviderBudget's final daily counters (increment 6, `BudgetSnapshot`), read loosely. */
export const ProviderBudgetDailyPayloadV1 = z.looseObject({
  provider: ProviderIdSchema,
  utcDate: IsoDateSchema,
  /**
   * The shard (0 to 7) when the day is sharded, null for the unsharded object. The persist
   * consumer keeps one `provider_call_daily` row PER SHARD (`budget_daily` for null,
   * `budget_daily:{n}` per shard) with replace semantics, never a sum: at-least-once delivery
   * makes a summing upsert count a redelivery twice (ruling L10).
   */
  shard: z.int().min(0).max(7).nullable().default(null),
  units: z.number().nonnegative(),
  pollEquivalents: z.number().nonnegative(),
  calls: z.int().nonnegative(),
  releasedUnits: z.number().nonnegative().optional(),
  byTrigger: z
    .record(
      z.string(),
      z.looseObject({
        units: z.number().nonnegative(),
        pe: z.number().nonnegative(),
        calls: z.int().nonnegative(),
      }),
    )
    .default({}),
  denials: z.record(z.string(), z.int().nonnegative()).default({}),
  dailyUnitCap: z.number().nonnegative().optional(),
});

export const ProviderBudgetKillSwitchMessageV1 = z.looseObject({
  ...envelope,
  kind: z.literal('provider_budget_kill_switch'),
  payload: ProviderBudgetKillSwitchPayloadV1,
});
export type ProviderBudgetKillSwitchMessageV1 = z.infer<typeof ProviderBudgetKillSwitchMessageV1>;

export const ProviderBudgetDailyMessageV1 = z.looseObject({
  ...envelope,
  kind: z.literal('provider_budget_daily'),
  payload: ProviderBudgetDailyPayloadV1,
});
export type ProviderBudgetDailyMessageV1 = z.infer<typeof ProviderBudgetDailyMessageV1>;

/** Every message the `persist` queue carries. */
export const PersistMessageV1 = z.discriminatedUnion('kind', [
  FlightInstanceMessageV1,
  FlightEventMessageV1,
  ProviderCallMessageV1,
  ProviderBudgetKillSwitchMessageV1,
  ProviderBudgetDailyMessageV1,
]);
export type PersistMessageV1 = z.infer<typeof PersistMessageV1>;
/** What a producer builds; the defaults (`outboxVersion`, event `field`) may be left out. */
export type PersistMessageV1Input = z.input<typeof PersistMessageV1>;

/** The message the `reconcile` queue carries: one flight key the cron wants looked at. */
export const ReconcileMessageV1 = z.looseObject({
  outboxVersion,
  kind: z.literal('reconcile_flight'),
  flightKey: FlightKeySchema,
  /** When the cron saw the row, for the consumer's log line. */
  nextRefreshAt: IsoInstantSchema.nullable().default(null),
});
export type ReconcileMessageV1 = z.infer<typeof ReconcileMessageV1>;
