import { z } from 'zod';
import { IATA_AIRPORT_RE } from './airports';
import { FlightKeySchema } from './flight-key';
import { FlightStatusValueSchema, IsoInstantSchema } from './flight-status';

/**
 * The longest value each variable-length field of `LiveActivityContentStateV1` accepts, in
 * UTF-16 code units (what zod's `.max` counts).
 *
 * Every field of the state has a bound, so the schema has a worst case with a size, and
 * apps/mobile/__tests__/content-state-size.test.ts builds that worst case from these numbers
 * (increment 11 review, ruling Z2). The free-text fields come from providers unbounded
 * (`FlightStatus.originGate` and the rest); a Phase 1 producer shortens or drops a longer value.
 * The flight key and the instants are bounded here only: their grammars allow any number of leg
 * digits and any sub-second precision. Tightening a bound after Phase 1 ships needs a `V2`
 * schema, which is why they were set before anything produced the state.
 */
export const LIVE_ACTIVITY_FIELD_MAX_LENGTH = {
  /** `AAL-9999A-2026-12-31-KJFK-L99999`: a five-digit leg number. */
  flightKey: 32,
  designator: 8,
  gate: 16,
  terminal: 32,
  baggageClaim: 32,
  /** `2026-12-31T23:59:59.999999999Z`: nanosecond precision. */
  instant: 30,
} as const;

const MAX = LIVE_ACTIVITY_FIELD_MAX_LENGTH;

const ContentStateInstant = IsoInstantSchema.max(MAX.instant);

/**
 * ActivityKit content state for the flight Live Activity (iOS) and the mirrored Android
 * ongoing notification. Kept flat and small: APNs Live Activity payloads are capped at 4 KB
 * and every field here is rendered, not stored.
 *
 * On iOS the state travels inside expo-widgets' own content state, `{ name, props }`, with this
 * object JSON-encoded a second time as the `props` string (apps/mobile/widgets/content-state.ts,
 * ADR 0008). Every field is bounded (`LIVE_ACTIVITY_FIELD_MAX_LENGTH`), and
 * apps/mobile/__tests__/content-state-size.test.ts proves that the schema's worst case (every
 * field at its bound, filled with the characters that grow most when escaped twice) stays under
 * the 4 KB budget with that double encoding counted. The schema stays loose, like every shared
 * schema, so a newer producer's extra keys parse; the encoder (`encodeContentState`) strips them
 * and refuses a state that would not fit.
 *
 * `gate` and `terminal` are the ORIGIN's, the departure pair (`FlightStatus.originGate`,
 * `originTerminal`); `destinationGate` and `destinationTerminal` (increment 11 review, ruling Z7)
 * are the arrival pair, optional like every field added to a loose schema later. The layout
 * prints the destination gate beside the arrival time only when it is present.
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
  flightKey: FlightKeySchema.refine((key) => key.length <= MAX.flightKey, {
    message: `a Live Activity flight key has at most ${String(MAX.flightKey)} characters`,
  }),
  designator: z.string().min(3).max(MAX.designator).optional(),
  originIata: z.string().regex(IATA_AIRPORT_RE).optional(),
  destinationIata: z.string().regex(IATA_AIRPORT_RE).optional(),
  status: FlightStatusValueSchema,
  /** The origin's (departure) gate. */
  gate: z.string().max(MAX.gate).optional(),
  /** The origin's (departure) terminal. */
  terminal: z.string().max(MAX.terminal).optional(),
  /** The destination's (arrival) gate. */
  destinationGate: z.string().max(MAX.gate).optional(),
  /** The destination's (arrival) terminal. */
  destinationTerminal: z.string().max(MAX.terminal).optional(),
  scheduledOut: ContentStateInstant,
  estimatedOut: ContentStateInstant.optional(),
  actualOut: ContentStateInstant.optional(),
  scheduledIn: ContentStateInstant,
  estimatedIn: ContentStateInstant.optional(),
  progressPercent: z.number().min(0).max(100).optional(),
  baggageClaim: z.string().max(MAX.baggageClaim).optional(),
  updatedAt: ContentStateInstant,
});
export type LiveActivityContentStateV1 = z.infer<typeof LiveActivityContentStateV1>;

/**
 * ActivityKit's limit on a Live Activity's static plus dynamic data, as JSON: 4 KB combined
 * (https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities).
 * The field bounds above keep the schema's worst case under it, double encoding included
 * (apps/mobile/__tests__/content-state-size.test.ts), and `encodeContentState` refuses to build a
 * state that would reach it.
 */
export const LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES = 4_096;
