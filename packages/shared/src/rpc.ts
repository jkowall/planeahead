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
 * `confirmPersisted`, `health`, `listSubscribers`; DesignatorResolver `resolve`; and provider
 * events pushed into a tracker). Every schema is a `looseObject` so a Worker and a DO on different deploy versions
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

/**
 * A user refresh made within this long of the tracker's last provider answer is answered from
 * the stored snapshot (`coalesced`, reason `fresh`) without a provider call and without charging
 * the user's daily cap (increment 7, ruling L15): 500 refreshes from many users inside one minute
 * cost one call. The in-flight promise coalesces the concurrent case; this coalesces the
 * sequential one.
 */
export const USER_REFRESH_FRESHNESS_MS = 60_000;

/**
 * An in-flight fetch older than this (`HealthResponseV1.inflightSinceMs`) is a hung promise, not
 * a slow provider: every provider request carries a 30 s timeout. The reconcile consumer refreshes
 * such a tracker anyway and the tracker abandons the stale handle (ruling L3).
 */
export const INFLIGHT_STALE_MS = 5 * 60_000;

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

/**
 * `subscribe` and `getState` on a tracker that holds no flight (never seeded, or finished and
 * deleted by its +22 h alarm) throw the typed `RpcRequestError('invalid_request')`. Increment 8's
 * routes MUST catch it: 404 for a flight that was never seeded, 410 for one that finished and was
 * deleted (Postgres `flight_instances.tracking_state` says which). A route never subscribes
 * before the DesignatorResolver has seeded the object: the search resolves first, then the
 * subscribe is made against the key it answered.
 */
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
   * `refreshed`: this call made the provider call. `coalesced`: no call was made because a fetch
   * was in flight and the caller waited for it (reason `inflight`), or because the snapshot is
   * younger than `USER_REFRESH_FRESHNESS_MS` (reason `fresh`); neither charges the user's daily
   * cap. `denied`: the per-user cap (reason `user_refresh_cap`) or the per-flight hard cap
   * (reason `hard_cap`) refused it. `skipped`: nothing to refresh (the tracker is finished or
   * was never seeded).
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

/**
 * The persist consumer's confirmation: these outbox seqs of this tracker lifetime are stored, and
 * the tracker deletes them. With `deadLettered: true` it is the dead-letter consumer's NOTICE
 * instead: the seqs exhausted the persist queue's retries and their raw bodies are archived; the
 * tracker stamps the rows (`dead_letter_count`, `last_dead_lettered_at_ms`) and KEEPS them,
 * re-sending each after `deadLetterResendSpacingMs` of its count (increment 7 final re-review:
 * a message dead-letters after about a minute of retries, which a transient Postgres outage
 * exceeds as easily as a poison row does, and a confirmed row is gone). The flag is optional so
 * a caller one build behind still parses; `rpcVersion` is unchanged.
 */
export const ConfirmPersistedRequestV1 = z.looseObject({
  rpcVersion,
  /** The lifetime the seqs belong to (`flight_tracker:{key}@{epochMs}`); a mismatch is ignored. */
  epochMs: z.int().nonnegative(),
  seqs: z.array(z.int().nonnegative()).max(1_000),
  /** True for the dead-letter consumer's notice: stamp and keep the rows, delete nothing. */
  deadLettered: z.boolean().optional(),
});
export type ConfirmPersistedRequestV1 = z.infer<typeof ConfirmPersistedRequestV1>;

export const ConfirmPersistedResponseV1 = z.looseObject({
  rpcVersion,
  /** Rows this call removed from the outbox; 0 for a dead-letter notice. */
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
  /**
   * How long the in-flight fetch has been running, in milliseconds of the tracker's clock; null
   * when none is. Every provider request carries a 30 s timeout, so a value in the minutes means
   * a hung promise, and the reconcile consumer treats one older than five minutes as stale and
   * refreshes anyway (increment 7, ruling L3).
   */
  inflightSinceMs: z.int().nonnegative().nullable().optional(),
  version: z.int().nonnegative(),
  doSchemaVersion: z.int().nonnegative(),
  /** Outbox rows sent but not yet confirmed by the persist consumer. */
  unconfirmedOutbox: z.int().nonnegative(),
  subscriberCount: z.int().nonnegative(),
});
export type HealthResponseV1 = z.infer<typeof HealthResponseV1>;

/**
 * `listSubscribers` (increment 12): the tracker's subscriber list, for the housekeeping
 * reconciliation that makes every active tracker's list follow Postgres (unsubscribing an entry
 * with no live `flight_subscriptions` row, re-pointing one whose row moved to another user in a
 * merge). The only Durable Object change of increment 12; additive, so `rpcVersion` stays 1 and a
 * Worker one build ahead of a tracker still reads everything else. `getState`, `health` and
 * `unsubscribe` carry only `subscriberCount`, which is why this exists. A tracker that holds no
 * flight answers phase `absent` and an empty list (never throws), like `unsubscribe`.
 */
export const ListSubscribersRequestV1 = z.looseObject({ rpcVersion });
export type ListSubscribersRequestV1 = z.infer<typeof ListSubscribersRequestV1>;

/** One entry of a tracker's subscriber list: the subscription it names and that row's user. */
export const TrackerSubscriberV1 = z.looseObject({
  subscriptionId: z.uuid(),
  /** The subscriber's user id as the tracker stored it at `subscribe`. */
  userId: z.string().min(1),
  /** When the entry was written, in milliseconds of the tracker's clock. */
  createdAtMs: z.int().nonnegative(),
});
export type TrackerSubscriberV1 = z.infer<typeof TrackerSubscriberV1>;

export const ListSubscribersResponseV1 = z.looseObject({
  rpcVersion,
  flightKey: FlightKeySchema.nullable(),
  phase: TrackerHealthPhaseSchema,
  subscribers: z.array(TrackerSubscriberV1),
});
export type ListSubscribersResponseV1 = z.infer<typeof ListSubscribersResponseV1>;

/**
 * A search: a marketing designator (`AA100`) and its origin-local departure date. The existing-
 * tracker probe (a `health` call on the trackers a regional operator hint and the marketing
 * carrier would name) runs ONLY when `originIcao` is supplied: a flight key needs an origin and
 * the key is the only name a tracker has. Increment 8's search route reads `flight_designators`
 * and `flight_instances` before calling the resolver and passes the origin it finds there.
 */
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
   * `resolved`: the flight is known and `flightKey` names it. `not_found`: the provider knows no
   * such flight on that date (cached like a hit, so a typo does not cost a call per search).
   * `denied`: the budget refused the call. `error`: the provider failed; not cached.
   */
  outcome: z.enum(['resolved', 'not_found', 'denied', 'error']),
  flightKey: FlightKeySchema.optional(),
  status: FlightStatusSchema.optional(),
  /** True when this resolution created the tracker (`seed`), false when it adopted one. */
  created: z.boolean().optional(),
  /**
   * What stands behind `flightKey` on a `resolved` answer: `seeded` (this resolution created the
   * tracker), `adopted` (one already existed), or `none` (the fetched status was terminal and the
   * cadence had nothing left to schedule, so NO tracker was created: the flight is over and
   * `status` is the answer; a subscribe against the key would find an absent object). A finished
   * flight never gets a second lifetime (ruling L9).
   */
  tracker: z.enum(['seeded', 'adopted', 'none']).optional(),
  /** True when the answer came from the stored resolution rather than a provider call. */
  cached: z.boolean(),
  resolvedAt: IsoInstantSchema,
  expiresAt: IsoInstantSchema.nullable(),
  reason: z.string().optional(),
});
export type ResolveResponseV1 = z.infer<typeof ResolveResponseV1>;

/**
 * The event injector (increment 15, ruling N11): a synthetic next snapshot for one tracker, sent
 * by the Access-protected admin action. The tracker classifies it against its current snapshot
 * and policy state with the same notification policy, confirmed by construction (no settle
 * re-read, no cancellation confirmation), and writes the intents through its outbox marked as
 * tests, `injectionId` in each dedupe key, so a replayed injection writes nothing. It stores
 * NEITHER the synthetic snapshot NOR the policy state the evaluation returns: the next real poll
 * diffs against real data and produces no spurious change back.
 */
export const InjectPolicyEventRequestV1 = z.looseObject({
  rpcVersion,
  injectionId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  status: FlightStatusSchema,
});
export type InjectPolicyEventRequestV1 = z.infer<typeof InjectPolicyEventRequestV1>;

export const InjectedIntentV1 = z.looseObject({
  kind: z.string(),
  subject: z.string(),
  value: z.string(),
  dedupeKey: z.string(),
  /** False when the dedupe key was already written (a replay): no outbox row. */
  written: z.boolean(),
});
export type InjectedIntentV1 = z.infer<typeof InjectedIntentV1>;

export const InjectPolicyEventResponseV1 = z.looseObject({
  rpcVersion,
  outcome: z.enum(['injected', 'ignored']),
  /** Why an injection was ignored: no tracked flight, or a finished one. */
  reason: z.enum(['absent', 'finished']).optional(),
  intents: z.array(InjectedIntentV1),
});
export type InjectPolicyEventResponseV1 = z.infer<typeof InjectPolicyEventResponseV1>;
