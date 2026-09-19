import { z } from 'zod';
import { FlightKeySchema } from './flight-key';
import {
  FLIGHT_STATUS_VALUES,
  FlightStatusSchema,
  IsoInstantSchema,
  ProviderEventSchema,
} from './flight-status';

/**
 * Versioned payloads for Durable Object RPC (FlightTracker `subscribe`, `unsubscribe`,
 * `getState`, `forceRefresh`, and provider events pushed into a tracker). Every schema is a
 * `looseObject` so a Worker and a DO on different deploy versions can still talk: unknown
 * fields pass through, missing new fields must be optional. A breaking change gets a `V2`
 * schema next to the `V1`, never an edit of `V1`.
 */

export const RPC_SCHEMA_VERSION = 1;

export const TRACKER_PHASES = [...FLIGHT_STATUS_VALUES, 'finished'] as const;
export const TrackerPhaseSchema = z.enum(TRACKER_PHASES);

/** Per-subscription notification overrides; the shape is owned by the notification domain. */
export const NotificationOverridesSchema = z.looseObject({
  muted: z.boolean().optional(),
  events: z.array(z.string()).optional(),
});

export const SubscribeRequestV1 = z.looseObject({
  subscriptionId: z.uuid(),
  userId: z.string().min(1),
  muted: z.boolean().optional(),
  overrides: NotificationOverridesSchema.optional(),
});
export type SubscribeRequestV1 = z.infer<typeof SubscribeRequestV1>;

export const SubscribeResponseV1 = z.looseObject({
  status: z.enum(['subscribed', 'already', 'archived']),
  flightKey: FlightKeySchema,
  snapshotEtag: z.string().optional(),
});
export type SubscribeResponseV1 = z.infer<typeof SubscribeResponseV1>;

export const UnsubscribeRequestV1 = z.looseObject({
  subscriptionId: z.uuid(),
});
export type UnsubscribeRequestV1 = z.infer<typeof UnsubscribeRequestV1>;

export const GetStateResponseV1 = z.looseObject({
  flightKey: FlightKeySchema,
  phase: TrackerPhaseSchema,
  snapshot: FlightStatusSchema.nullable(),
  nextRefreshAt: IsoInstantSchema.nullable(),
  doSchemaVersion: z.int().nonnegative(),
  subscriberCount: z.int().nonnegative(),
});
export type GetStateResponseV1 = z.infer<typeof GetStateResponseV1>;

export const ForceRefreshRequestV1 = z.looseObject({
  reason: z.enum(['user_refresh', 'reconcile', 'manual']),
});
export type ForceRefreshRequestV1 = z.infer<typeof ForceRefreshRequestV1>;

export const ProviderEventV1 = ProviderEventSchema;
export type ProviderEventV1 = z.infer<typeof ProviderEventV1>;
