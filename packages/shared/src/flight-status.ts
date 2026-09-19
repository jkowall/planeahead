import { z } from 'zod';
import { AirportRefSchema } from './airports';
import { ICAO_CARRIER_RE, IATA_CARRIER_RE } from './carriers';
import { FlightKeySchema } from './flight-key';

/**
 * Boundary schemas for everything a provider adapter, a Durable Object or the sync feed hands
 * across a boundary. Every object schema is `z.looseObject` on purpose: Durable Objects roll
 * out gradually, so a Worker one version ahead of a FlightTracker (or behind it) must be able
 * to parse a payload that carries fields it does not know yet. Unknown keys are kept, never
 * rejected. Adding a field is therefore always backwards compatible; renaming or retyping one
 * needs a new versioned schema (see `rpc.ts`).
 *
 * All instants are ISO-8601 UTC strings with a trailing `Z`; the only local date in the system
 * is the origin-local scheduled departure date inside the flight key.
 */

export const PROVIDER_IDS = [
  'aeroapi',
  'aerodatabox',
  'adsb_lol',
  'adsb_fi',
  'airplanes_live',
  'aviationweather',
  'nws',
  'open_meteo',
  'faa_nas',
  'llm',
  'mock',
] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const FLIGHT_STATUS_VALUES = [
  'scheduled',
  'boarding',
  'departed',
  'en_route',
  'landed',
  'arrived',
  'cancelled',
  'diverted',
  'unknown',
] as const;
export const FlightStatusValueSchema = z.enum(FLIGHT_STATUS_VALUES);
export type FlightStatusValue = z.infer<typeof FlightStatusValueSchema>;

/** AeroAPI alert event codes. `filed` through `in` are the OOOI and ETA family. */
export const ALERT_EVENTS = [
  'filed',
  'departure',
  'arrival',
  'cancelled',
  'diverted',
  'out',
  'off',
  'on',
  'in',
  'hold_start',
  'hold_end',
] as const;
export const AlertEventSchema = z.enum(ALERT_EVENTS);
export type AlertEvent = z.infer<typeof AlertEventSchema>;

export const PROVIDER_CALL_TRIGGERS = [
  'alarm',
  'provider_alert',
  'adb_alert',
  'user_search',
  'user_refresh',
  'reconcile',
  'backfill',
  'cron',
  'import',
  'manual',
] as const;
export const ProviderCallTriggerSchema = z.enum(PROVIDER_CALL_TRIGGERS);
export type ProviderCallTrigger = z.infer<typeof ProviderCallTriggerSchema>;

export const PROVIDER_CALL_RESULTS = ['ok', 'not_found', 'rate_limited', 'error'] as const;
export const ProviderCallResultSchema = z.enum(PROVIDER_CALL_RESULTS);
export type ProviderCallResult = z.infer<typeof ProviderCallResultSchema>;

/** ISO-8601 instant in UTC (`2026-09-19T03:50:00Z`). Offsets other than `Z` are rejected. */
export const IsoInstantSchema = z.iso.datetime();
/** Calendar date `YYYY-MM-DD`; invalid calendar dates such as `2026-02-30` are rejected. */
export const IsoDateSchema = z.iso.date();

export const FLIGHT_NUMBER_RE = /^[1-9][0-9]{0,3}[A-Z]?$/;
export const ICAO_HEX_RE = /^[0-9A-Fa-f]{6}$/;

export const TIME_FIELDS = [
  'scheduledOut',
  'estimatedOut',
  'actualOut',
  'scheduledOff',
  'estimatedOff',
  'actualOff',
  'scheduledOn',
  'estimatedOn',
  'actualOn',
  'scheduledIn',
  'estimatedIn',
  'actualIn',
] as const;
export type FlightTimeField = (typeof TIME_FIELDS)[number];

export const FlightTimesSchema = z.looseObject({
  scheduledOut: IsoInstantSchema.optional(),
  estimatedOut: IsoInstantSchema.optional(),
  actualOut: IsoInstantSchema.optional(),
  scheduledOff: IsoInstantSchema.optional(),
  estimatedOff: IsoInstantSchema.optional(),
  actualOff: IsoInstantSchema.optional(),
  scheduledOn: IsoInstantSchema.optional(),
  estimatedOn: IsoInstantSchema.optional(),
  actualOn: IsoInstantSchema.optional(),
  scheduledIn: IsoInstantSchema.optional(),
  estimatedIn: IsoInstantSchema.optional(),
  actualIn: IsoInstantSchema.optional(),
});
export type FlightTimes = z.infer<typeof FlightTimesSchema>;

export const FIELD_QUALITY_VALUES = ['live', 'schedule', 'estimated'] as const;
export const FieldQualitySchema = z.enum(FIELD_QUALITY_VALUES);
export type FieldQuality = z.infer<typeof FieldQualitySchema>;
export const FieldQualityKeySchema = z.enum([...TIME_FIELDS, 'gate', 'baggage']);
export type FieldQualityKey = z.infer<typeof FieldQualityKeySchema>;

export const CodeshareSchema = z.looseObject({
  carrierIcao: z.string().regex(ICAO_CARRIER_RE).optional(),
  carrierIata: z.string().regex(IATA_CARRIER_RE).optional(),
  flightNumber: z.string().regex(FLIGHT_NUMBER_RE),
});
export type Codeshare = z.infer<typeof CodeshareSchema>;

export const ProviderRefSchema = z.looseObject({
  provider: ProviderIdSchema,
  providerId: z.string().min(1),
});
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

/**
 * The provider-normalised picture of one flight instance. Adapters produce it, the
 * FlightTracker stores it as its snapshot, the sync feed and Live Activities read it.
 *
 * `key` is optional because an adapter cannot know the canonical key until
 * `canonicalizeFromProvider` has run on this very object; the resolver and the tracker set it.
 * `scheduledDepartureDateLocal` is the provider's own origin-local date (AeroDataBox
 * `departure.scheduledTime.local`), kept so the key can be derived when `origin.tz` is missing.
 */
export const FlightStatusSchema = z.looseObject({
  key: FlightKeySchema.optional(),
  operatingCarrierIcao: z.string().regex(ICAO_CARRIER_RE),
  flightNumber: z.string().regex(FLIGHT_NUMBER_RE),
  legSeq: z.int().min(1).default(1),
  scheduledDepartureDateLocal: IsoDateSchema.optional(),
  codeshares: z.array(CodeshareSchema).default([]),
  origin: AirportRefSchema,
  destination: AirportRefSchema,
  actualDestination: AirportRefSchema.optional(),
  status: FlightStatusValueSchema,
  times: FlightTimesSchema,
  departureDelaySec: z.int().optional(),
  arrivalDelaySec: z.int().optional(),
  originTerminal: z.string().optional(),
  originGate: z.string().optional(),
  destinationTerminal: z.string().optional(),
  destinationGate: z.string().optional(),
  baggageClaim: z.string().optional(),
  aircraftTypeIcao: z.string().optional(),
  registration: z.string().optional(),
  icaoHex: z.string().regex(ICAO_HEX_RE).optional(),
  routeDistanceKm: z.number().nonnegative().optional(),
  progressPercent: z.number().min(0).max(100).optional(),
  inboundRef: ProviderRefSchema.optional(),
  providerRefs: z.partialRecord(ProviderIdSchema, z.string()).default({}),
  fetchedAt: IsoInstantSchema,
  source: ProviderIdSchema,
  fieldQuality: z.partialRecord(FieldQualityKeySchema, FieldQualitySchema).default({}),
});
export type FlightStatus = z.infer<typeof FlightStatusSchema>;
export type FlightStatusInput = z.input<typeof FlightStatusSchema>;

export const BoardRowSchema = z.looseObject({
  direction: z.enum(['dep', 'arr']),
  /** Marketing designator as displayed on the board, e.g. `AA100`. */
  designator: z.string().min(3),
  operatingCarrierIcao: z.string().regex(ICAO_CARRIER_RE).optional(),
  flightNumber: z.string().regex(FLIGHT_NUMBER_RE),
  /** The other end of the flight: destination for departures, origin for arrivals. */
  counterpart: AirportRefSchema,
  scheduled: IsoInstantSchema,
  estimated: IsoInstantSchema.optional(),
  actual: IsoInstantSchema.optional(),
  status: FlightStatusValueSchema,
  terminal: z.string().optional(),
  gate: z.string().optional(),
  baggageClaim: z.string().optional(),
  aircraftTypeIcao: z.string().optional(),
  codeshares: z.array(CodeshareSchema).default([]),
  flightKey: FlightKeySchema.optional(),
  source: ProviderIdSchema,
});
export type BoardRow = z.infer<typeof BoardRowSchema>;

export const AircraftPositionSchema = z.looseObject({
  icaoHex: z.string().regex(ICAO_HEX_RE),
  /** Callsign as broadcast (`AAL100`), when the feed carries it; used to match without a hex. */
  callsign: z.string().optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  altFt: z.number().optional(),
  gsKt: z.number().nonnegative().optional(),
  trackDeg: z.number().min(0).max(360).optional(),
  vsFpm: z.number().optional(),
  seenAt: IsoInstantSchema,
  source: ProviderIdSchema,
});
export type AircraftPosition = z.infer<typeof AircraftPositionSchema>;

export const ProviderEventKindSchema = z.enum([...ALERT_EVENTS, 'update', 'unknown']);
export type ProviderEventKind = z.infer<typeof ProviderEventKindSchema>;

/** How a webhook payload names the flight it is about; at least one of these is set. */
export const FlightRefSchema = z.looseObject({
  flightKey: FlightKeySchema.optional(),
  providerRef: ProviderRefSchema.optional(),
  /** Marketing designator plus origin-local date, e.g. `AA100` on `2026-09-19`. */
  designator: z.string().optional(),
  dateLocal: IsoDateSchema.optional(),
});
export type FlightRef = z.infer<typeof FlightRefSchema>;

export const ProviderEventSchema = z.looseObject({
  provider: ProviderIdSchema,
  /** Provider-side id, unique per provider; the dedupe key for `provider_webhook_events`. */
  externalId: z.string().min(1),
  receivedAt: IsoInstantSchema,
  kind: ProviderEventKindSchema,
  flightRef: FlightRefSchema,
  payload: z.unknown(),
});
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;

/**
 * One billable (or free but counted) provider call. Every adapter call returns one of these
 * next to its data, so a call without a cost record cannot compile.
 */
export const ProviderCallRecordSchema = z.looseObject({
  id: z.uuid(),
  provider: ProviderIdSchema,
  operation: z.string().min(1),
  trigger: ProviderCallTriggerSchema,
  flightKey: FlightKeySchema.optional(),
  airportIcao: z.string().optional(),
  requestId: z.string().min(1),
  startedAt: IsoInstantSchema,
  latencyMs: z.int().nonnegative(),
  httpStatus: z.int().min(100).max(599).optional(),
  result: ProviderCallResultSchema,
  /** Provider-native units: AeroAPI result sets, AeroDataBox units, 0 for free feeds. */
  costUnits: z.number().nonnegative(),
  /** Budget currency: AeroAPI status polls at list price (see `cost.ts`). */
  pollEquivalents: z.number().nonnegative(),
  estCostUsdMicros: z.int().nonnegative(),
  responseBytes: z.int().nonnegative().optional(),
  error: z.string().optional(),
});
export type ProviderCallRecord = z.infer<typeof ProviderCallRecordSchema>;
