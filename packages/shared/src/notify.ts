import { z } from 'zod';
import { AirportRefSchema } from './airports';
import { ICAO_CARRIER_RE } from './carriers';
import { FlightKeySchema } from './flight-key';
import {
  FLIGHT_NUMBER_RE,
  FlightStatusValueSchema,
  FlightTimesSchema,
  IsoInstantSchema,
} from './flight-status';
import { NotificationKindSchema } from './push';

/**
 * The `notify` queue's intent message (increment 15, ruling N7): one push-worthy change a
 * FlightTracker's notification policy produced. The tracker writes it as the payload of a
 * `notify_intent` outbox row in the transaction that changed its state; the persist consumer
 * forwards the payload to `notify` unchanged and confirms the row only after the send succeeded.
 * `looseObject` for the reason `outbox.ts` gives: a consumer one release behind keeps the fields
 * it does not know.
 *
 * `dedupeKey` is the tracker's `notif_dedupe` key (the flight, the kind, the value and the
 * tracker's change sequence; an injection's id instead of the sequence), so `notify` can insert
 * its `notifications` rows unique per user and key and a redelivery inserts nothing twice.
 * `flight` is the flight as it stood when the intent was produced, everything a push renders.
 */

export const NOTIFY_SCHEMA_VERSION = 1;
const notifyVersion = z.int().min(1).default(NOTIFY_SCHEMA_VERSION);

export const NOTIFY_INTENT_SUBJECTS = [
  'departure',
  'arrival',
  'origin',
  'destination',
  'flight',
] as const;

/** The flight as a push renders it: designators, airports, status, times, gates. */
export const NotifyFlightSummaryV1 = z.looseObject({
  operatingCarrierIcao: z.string().regex(ICAO_CARRIER_RE),
  flightNumber: z.string().regex(FLIGHT_NUMBER_RE),
  marketingCarrierIcao: z.string().regex(ICAO_CARRIER_RE).optional(),
  marketingFlightNumber: z.string().regex(FLIGHT_NUMBER_RE).optional(),
  origin: AirportRefSchema,
  destination: AirportRefSchema,
  actualDestination: AirportRefSchema.optional(),
  status: FlightStatusValueSchema,
  times: FlightTimesSchema,
  originTerminal: z.string().optional(),
  originGate: z.string().optional(),
  destinationTerminal: z.string().optional(),
  destinationGate: z.string().optional(),
  baggageClaim: z.string().optional(),
});
export type NotifyFlightSummaryV1 = z.infer<typeof NotifyFlightSummaryV1>;

/** The policy's intent (`PolicyIntent` in notification-policy.ts), as it travels. */
export const NotifyIntentFieldsV1 = z.looseObject({
  kind: NotificationKindSchema,
  subject: z.enum(NOTIFY_INTENT_SUBJECTS),
  value: z.string().min(1),
  previousValue: z.string().nullable(),
  correction: z.boolean(),
  firstAssignment: z.boolean(),
  timeSensitive: z.boolean(),
  expiresAt: IsoInstantSchema,
  dedupeValue: z.string().min(1),
});

export const NotifyIntentV1 = z.looseObject({
  notifyVersion,
  kind: z.literal('notify_intent'),
  flightKey: FlightKeySchema,
  dedupeKey: z.string().min(1).max(512),
  intent: NotifyIntentFieldsV1,
  flight: NotifyFlightSummaryV1,
  /** When the tracker produced the intent. */
  producedAt: IsoInstantSchema,
  /** N11: an injected intent; `notify` marks its rows as tests and applies the allow-list. */
  test: z.boolean().default(false),
  /** The admin injection that produced a test intent. */
  injectionId: z.string().min(1).max(128).optional(),
});
export type NotifyIntentV1 = z.infer<typeof NotifyIntentV1>;
/** What a producer builds; `notifyVersion` and `test` may be left out. */
export type NotifyIntentV1Input = z.input<typeof NotifyIntentV1>;
