import { z } from 'zod';
import { FlightKeySchema } from './flight-key';
import {
  FLIGHT_STATUS_VALUES,
  FlightStatusSchema,
  IsoDateSchema,
  IsoInstantSchema,
  ProviderEventSchema,
  tolerantEnum,
} from './flight-status';

/**
 * Versioned payloads for Durable Object RPC (FlightTracker `subscribe`, `unsubscribe`,
 * `getState`, `forceRefresh`, `getCostLedger`, `ingestProviderEvent`, `seed`,
 * `confirmPersisted`, `health`; DesignatorResolver `resolve`; and provider events pushed into
 * a tracker). Every schema is a `looseObject` so a Worker and a DO on different deploy versions
 * can still talk: unknown fields pass through, missing new fields must be optional, and a
 * tracker phase this build does not know parses as `unknown` (the phase itself stays required).
 * A breaking change gets a `V2` schema next to the `V1`, never an edit of `V1`.
 *
 * Every request, response and pushed event carries `rpcVersion`, defaulting to
 * `RPC_SCHEMA_VERSION` so a peer that never set it parses as V1. A DO answers in the dialect the
 * request names and a Worker reads the version off a response before it interprets the rest; a
 * `V2` schema sets its own default. The constant is therefore on the wire, not only in logs.
 *
 * The schemas themselves accept any positive `rpcVersion` (a V1 schema must be able to READ the
 * envelope of a request it cannot serve). Refusing an unknown version is the receiver's job:
 * `parseRpcRequest` is what a Durable Object runs on every incoming payload, and it throws a
 * typed `RpcRequestError` (`unsupported_rpc_version`) instead of silently serving a request in
 * a dialect it does not know (increment 7, ruling J8).
 */

export const RPC_SCHEMA_VERSION = 1;
const rpcVersion = z.int().min(1).default(RPC_SCHEMA_VERSION);

export const TRACKER_PHASES = [...FLIGHT_STATUS_VALUES, 'finished'] as const;
export const TrackerPhaseSchema = tolerantEnum(TRACKER_PHASES, 'unknown');

/**
 * What `health()` can report: a tracker phase, or `absent` for an object that exists (it was
 * named) but was never seeded and holds no flight.
 */
export const TRACKER_HEALTH_PHASES = [...TRACKER_PHASES, 'absent'] as const;
export const TrackerHealthPhaseSchema = tolerantEnum(TRACKER_HEALTH_PHASES, 'unknown');
export type TrackerHealthPhase = z.infer<typeof TrackerHealthPhaseSchema>;

export type RpcRequestErrorCode = 'unsupported_rpc_version' | 'invalid_request';

/**
 * Thrown by `parseRpcRequest`. Workers RPC serialises an `Error` by name and message only, so
 * the code is also the first token of the message (`unsupported_rpc_version: ...`) and a caller
 * on the far side of the boundary can still tell the two apart.
 */
export class RpcRequestError extends Error {
  override readonly name = 'RpcRequestError';
  readonly code: RpcRequestErrorCode;

  constructor(code: RpcRequestErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

/**
 * Validates an incoming RPC payload against a V1 schema. A payload naming an `rpcVersion` other
 * than `RPC_SCHEMA_VERSION` is refused with `unsupported_rpc_version` BEFORE the schema runs (the
 * schema would accept it); a payload the schema rejects is refused with `invalid_request`. A
 * payload with no `rpcVersion` at all is V1 by the schema's default.
 */
export function parseRpcRequest<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  if (typeof input === 'object' && input !== null && 'rpcVersion' in input) {
    const version: unknown = (input as { rpcVersion?: unknown }).rpcVersion;
    if (version !== undefined && version !== RPC_SCHEMA_VERSION) {
      const named = typeof version === 'number' ? String(version) : JSON.stringify(version);
      throw new RpcRequestError(
        'unsupported_rpc_version',
        `this build speaks rpcVersion ${String(RPC_SCHEMA_VERSION)}, the request names ${named}`,
      );
    }
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? '' : ` at ${first.path.map(String).join('.') || '(root)'}`;
    throw new RpcRequestError('invalid_request', `${first?.message ?? 'invalid payload'}${where}`);
  }
  return parsed.data;
}

/** Per-subscription notification overrides; the shape is owned by the notification domain. */
export const NotificationOverridesSchema = z.looseObject({
  muted: z.boolean().optional(),
  events: z.array(z.string()).optional(),
});

export const SubscribeRequestV1 = z.looseObject({
  rpcVersion,
  subscriptionId: z.uuid(),
  userId: z.string().min(1),
  muted: z.boolean().optional(),
  overrides: NotificationOverridesSchema.optional(),
});
export type SubscribeRequestV1 = z.infer<typeof SubscribeRequestV1>;

export const SubscribeResponseV1 = z.looseObject({
  rpcVersion,
  status: z.enum(['subscribed', 'already', 'archived']),
  flightKey: FlightKeySchema,
  snapshotEtag: z.string().optional(),
  /** The snapshot version at the time of the answer; absent on `archived`. */
  version: z.int().nonnegative().optional(),
  snapshot: FlightStatusSchema.nullable().optional(),
});
export type SubscribeResponseV1 = z.infer<typeof SubscribeResponseV1>;

export const UnsubscribeRequestV1 = z.looseObject({
  rpcVersion,
  subscriptionId: z.uuid(),
});
export type UnsubscribeRequestV1 = z.infer<typeof UnsubscribeRequestV1>;

export const UnsubscribeResponseV1 = z.looseObject({
  rpcVersion,
  status: z.enum(['unsubscribed', 'absent']),
  subscriberCount: z.int().nonnegative(),
});
export type UnsubscribeResponseV1 = z.infer<typeof UnsubscribeResponseV1>;

export const GetStateResponseV1 = z.looseObject({
  rpcVersion,
  flightKey: FlightKeySchema,
  phase: TrackerPhaseSchema,
  snapshot: FlightStatusSchema.nullable(),
  nextRefreshAt: IsoInstantSchema.nullable(),
  /** The DO's SQLite schema version (the migrations table), not the RPC contract. */
  doSchemaVersion: z.int().nonnegative(),
  subscriberCount: z.int().nonnegative(),
  /** The snapshot version; absent on a response from a build older than increment 7. */
  version: z.int().nonnegative().optional(),
});
export type GetStateResponseV1 = z.infer<typeof GetStateResponseV1>;

export const ForceRefreshRequestV1 = z.looseObject({
  rpcVersion,
  reason: z.enum(['user_refresh', 'reconcile', 'manual']),
  /** Required for `user_refresh`: the per-user cap (10 per flight per day) is keyed on it. */
  userId: z.string().min(1).optional(),
});
export type ForceRefreshRequestV1 = z.infer<typeof ForceRefreshRequestV1>;

export const ForceRefreshResponseV1 = z.looseObject({
  rpcVersion,
  /**
   * `refreshed`: this call made the provider call. `coalesced`: a fetch was in flight and the
   * caller waited for it. `denied`: the per-user cap or the per-flight hard cap refused it.
   * `skipped`: nothing to refresh (the tracker is finished or was never seeded).
   */
  outcome: z.enum(['refreshed', 'coalesced', 'denied', 'skipped']),
  reason: z.string().optional(),
  phase: TrackerHealthPhaseSchema,
  version: z.int().nonnegative(),
  snapshot: FlightStatusSchema.nullable(),
});
export type ForceRefreshResponseV1 = z.infer<typeof ForceRefreshResponseV1>;

export const GetCostLedgerResponseV1 = z.looseObject({
  rpcVersion,
  flightKey: FlightKeySchema,
  /** Poll-equivalents spent by the scheduled cadence (`alarm` and `reconcile` triggers). */
  scheduledPe: z.number().nonnegative(),
  /** Poll-equivalents spent by user refreshes, the separate sub-budget. */
  userRefreshPe: z.number().nonnegative(),
  calls: z.int().nonnegative(),
  softCapPe: z.number().nonnegative(),
  hardCapPe: z.number().nonnegative(),
  /** True once the soft cap stretched the cadence one tier. */
  stretched: z.boolean(),
  /** True once the hard cap stopped polling. */
  hardCapHit: z.boolean(),
  byTrigger: z.record(
    z.string(),
    z.looseObject({ pe: z.number().nonnegative(), calls: z.int().nonnegative() }),
  ),
});
export type GetCostLedgerResponseV1 = z.infer<typeof GetCostLedgerResponseV1>;

/** The shared provider event as pushed into a tracker, versioned like every other payload. */
export const ProviderEventV1 = ProviderEventSchema.extend({ rpcVersion });
export type ProviderEventV1 = z.infer<typeof ProviderEventV1>;

export const IngestProviderEventResponseV1 = z.looseObject({
  rpcVersion,
  /**
   * `merged`: the alert's fields were merged onto the snapshot. `refreshed`: the event was a
   * re-read hint and a provider call was made. `ignored`: the event named another flight, an
   * unknown provider, or arrived on a finished or unseeded tracker.
   */
  outcome: z.enum(['merged', 'refreshed', 'ignored']),
  reason: z.string().optional(),
  version: z.int().nonnegative(),
});
export type IngestProviderEventResponseV1 = z.infer<typeof IngestProviderEventResponseV1>;

/**
 * Creates a tracker from a status the DesignatorResolver already fetched: the status becomes
 * the initial snapshot (`fetchedAt` is its version stamp), the first alarm is set at the next
 * cadence slot, and the resolver's call is therefore never repeated by the tracker. Idempotent:
 * a second seed answers `already`; a seed carrying a status older than the stored snapshot
 * answers `stale` and changes nothing.
 */
export const SeedRequestV1 = z.looseObject({
  rpcVersion,
  flightKey: FlightKeySchema,
  status: FlightStatusSchema,
  cadence: z.enum(['literal', 'A1', 'A2', 'B']).default('A2'),
  /** How the flight came to be tracked; recorded on the creation event. */
  trigger: z.enum(['user_search', 'import', 'manual']).default('user_search'),
  /** The marketing designator the search was made with (`AA100`); the tracker polls by it. */
  designator: z.string().min(3).max(10).optional(),
});
export type SeedRequestV1 = z.infer<typeof SeedRequestV1>;

export const SeedResponseV1 = z.looseObject({
  rpcVersion,
  status: z.enum(['seeded', 'already', 'stale', 'finished']),
  flightKey: FlightKeySchema,
  version: z.int().nonnegative(),
  phase: TrackerHealthPhaseSchema,
  nextRefreshAt: IsoInstantSchema.nullable(),
});
export type SeedResponseV1 = z.infer<typeof SeedResponseV1>;

/** The persist consumer's confirmation: these outbox seqs of this tracker lifetime are stored. */
export const ConfirmPersistedRequestV1 = z.looseObject({
  rpcVersion,
  /** The lifetime the seqs belong to (`flight_tracker:{key}@{epochMs}`); a mismatch is ignored. */
  epochMs: z.int().nonnegative(),
  seqs: z.array(z.int().nonnegative()).max(1_000),
});
export type ConfirmPersistedRequestV1 = z.infer<typeof ConfirmPersistedRequestV1>;

export const ConfirmPersistedResponseV1 = z.looseObject({
  rpcVersion,
  /** Rows this call removed from the outbox. */
  deleted: z.int().nonnegative(),
  /** Rows still awaiting confirmation. */
  remaining: z.int().nonnegative(),
  /** False when `epochMs` named another lifetime of this key; nothing was deleted. */
  matched: z.boolean(),
});
export type ConfirmPersistedResponseV1 = z.infer<typeof ConfirmPersistedResponseV1>;

/**
 * What the reconcile consumer and the resolver's existing-tracker probe read. `alarmAt` is
 * `getAlarm()` at the time of the call; an alarm handler that is currently running also reports
 * null, which is why `phase` is checked before `alarmAt` is trusted.
 */
export const HealthResponseV1 = z.looseObject({
  rpcVersion,
  flightKey: FlightKeySchema.nullable(),
  phase: TrackerHealthPhaseSchema,
  alarmAt: IsoInstantSchema.nullable(),
  /** True while a provider fetch is in flight. */
  inflight: z.boolean(),
  version: z.int().nonnegative(),
  doSchemaVersion: z.int().nonnegative(),
  /** Outbox rows sent but not yet confirmed by the persist consumer. */
  unconfirmedOutbox: z.int().nonnegative(),
  subscriberCount: z.int().nonnegative(),
});
export type HealthResponseV1 = z.infer<typeof HealthResponseV1>;

/** A search: a marketing designator (`AA100`) and its origin-local departure date. */
export const ResolveRequestV1 = z.looseObject({
  rpcVersion,
  designator: z.string().min(3).max(10),
  dateLocal: IsoDateSchema,
  /** When the caller knows it, lets the resolver look for an existing tracker before spending. */
  originIcao: z.string().min(4).max(4).optional(),
  requestId: z.string().min(1).optional(),
});
export type ResolveRequestV1 = z.infer<typeof ResolveRequestV1>;

export const ResolveResponseV1 = z.looseObject({
  rpcVersion,
  /**
   * `resolved`: a tracker exists for `flightKey`. `not_found`: the provider knows no such
   * flight on that date (cached like a hit, so a typo does not cost a call per search).
   * `denied`: the budget refused the call. `error`: the provider failed; not cached.
   */
  outcome: z.enum(['resolved', 'not_found', 'denied', 'error']),
  flightKey: FlightKeySchema.optional(),
  status: FlightStatusSchema.optional(),
  /** True when this resolution created the tracker (`seed`), false when it adopted one. */
  created: z.boolean().optional(),
  /** True when the answer came from the stored resolution rather than a provider call. */
  cached: z.boolean(),
  resolvedAt: IsoInstantSchema,
  expiresAt: IsoInstantSchema.nullable(),
  reason: z.string().optional(),
});
export type ResolveResponseV1 = z.infer<typeof ResolveResponseV1>;
