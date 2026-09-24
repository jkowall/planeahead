import { z } from 'zod';
import { IATA_AIRPORT_RE } from './airports';
import { FlightKeySchema } from './flight-key';
import { FlightStatusValueSchema, IsoInstantSchema } from './flight-status';

/**
 * ActivityKit content state for the flight Live Activity (iOS) and the mirrored Android
 * ongoing notification. Kept flat and small: APNs Live Activity payloads are capped at 4 KB
 * and every field here is rendered, not stored.
 *
 * On iOS the state travels inside expo-widgets' own content state, `{ name, props }`, with this
 * object JSON-encoded a second time as the `props` string (apps/mobile/widgets/content-state.ts,
 * ADR 0008); apps/mobile/__tests__/content-state-size.test.ts counts that double encoding
 * against the 4 KB budget.
 *
 * `designator`, `originIata` and `destinationIata` (increment 11) are what the Lock Screen and
 * the Dynamic Island print: the marketing designator as a board row shows it (`BoardRow.
 * designator`, e.g. `AA100`) and the two airports' IATA codes. They are optional,
 * like every field added to a loose schema after the fact: an airport without an IATA code has
 * none, and the layout falls back to the flight key.
 *
 * `stale_at` guidance: the APNs payload carries `stale-date` next to this state. Set it to
 * `updatedAt + 2 x the tracker's current nominal refresh interval` (from `refreshIntervalFor`)
 * so the Activity flips to its stale UI as soon as two scheduled refreshes have been missed,
 * and never later than the tracker's `MAX_LIFETIME`. Phase 1 wires this up.
 */
export const LiveActivityContentStateV1 = z.looseObject({
  flightKey: FlightKeySchema,
  designator: z.string().min(3).max(8).optional(),
  originIata: z.string().regex(IATA_AIRPORT_RE).optional(),
  destinationIata: z.string().regex(IATA_AIRPORT_RE).optional(),
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
