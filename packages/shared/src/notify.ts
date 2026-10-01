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
import { NotificationKindSchema, type NotificationKind } from './push';

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

/**
 * The app's two permanent Android notification channels (increment 15; increment 16's app creates
 * them at start-up). Permanent because Android keys a user's sound, vibration and importance
 * settings to the channel id and never lets an app rename one: a new id is a new channel with the
 * user's choices lost. Both match `ANDROID_CHANNEL_ID_RE`.
 */
export const ANDROID_CHANNEL_IDS = {
  /** Gate changes, first gate assignments, cancellations, diversions, and their corrections. */
  flightChanges: 'flight_changes',
  /** Delays and their corrections. */
  flightDelays: 'flight_delays',
} as const;
export type AndroidChannelId = (typeof ANDROID_CHANNEL_IDS)[keyof typeof ANDROID_CHANNEL_IDS];

/**
 * The channel each notification kind posts to; a correction posts to its kind's channel. Every
 * kind is listed, so a new kind fails to compile until it is given one. Only `delay`,
 * `gate_change`, `cancellation` and `diversion` are produced today (increment 15); the others go
 * to `flight_changes` until a later increment gives them a channel of their own.
 */
export const ANDROID_CHANNEL_BY_KIND: Readonly<Record<NotificationKind, AndroidChannelId>> = {
  schedule_change: ANDROID_CHANNEL_IDS.flightChanges,
  gate_change: ANDROID_CHANNEL_IDS.flightChanges,
  delay: ANDROID_CHANNEL_IDS.flightDelays,
  cancellation: ANDROID_CHANNEL_IDS.flightChanges,
  diversion: ANDROID_CHANNEL_IDS.flightChanges,
  boarding: ANDROID_CHANNEL_IDS.flightChanges,
  departure: ANDROID_CHANNEL_IDS.flightChanges,
  arrival: ANDROID_CHANNEL_IDS.flightChanges,
  baggage: ANDROID_CHANNEL_IDS.flightChanges,
  reminder: ANDROID_CHANNEL_IDS.flightChanges,
  trip_share: ANDROID_CHANNEL_IDS.flightChanges,
  system: ANDROID_CHANNEL_IDS.flightChanges,
};

/** The Android channel a notification of this kind posts to. */
export function androidChannelFor(kind: NotificationKind): AndroidChannelId {
  return ANDROID_CHANNEL_BY_KIND[kind];
}
