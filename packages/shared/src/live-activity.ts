import { z } from 'zod';
import { FlightKeySchema } from './flight-key';
import { FlightStatusValueSchema, IsoInstantSchema } from './flight-status';

/**
 * ActivityKit content state for the flight Live Activity (iOS) and the mirrored Android
 * ongoing notification. Kept flat and small: APNs Live Activity payloads are capped at 4 KB
 * and every field here is rendered, not stored.
 *
 * `stale_at` guidance: the APNs payload carries `stale-date` next to this state. Set it to
 * `updatedAt + 2 x the tracker's current nominal refresh interval` (from `refreshIntervalFor`)
 * so the Activity flips to its stale UI as soon as two scheduled refreshes have been missed,
 * and never later than the tracker's `MAX_LIFETIME`. Phase 1 wires this up.
 */
export const LiveActivityContentStateV1 = z.looseObject({
  flightKey: FlightKeySchema,
  status: FlightStatusValueSchema,
  gate: z.string().optional(),
  terminal: z.string().optional(),
  scheduledOut: IsoInstantSchema,
  estimatedOut: IsoInstantSchema.optional(),
  actualOut: IsoInstantSchema.optional(),
  scheduledIn: IsoInstantSchema,
  estimatedIn: IsoInstantSchema.optional(),
  progressPercent: z.number().min(0).max(100).optional(),
  baggageClaim: z.string().optional(),
  updatedAt: IsoInstantSchema,
});
export type LiveActivityContentStateV1 = z.infer<typeof LiveActivityContentStateV1>;

/** Hard limit ActivityKit enforces on the JSON payload; a test keeps the schema well under it. */
export const LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES = 4_096;
