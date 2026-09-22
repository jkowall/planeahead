import { z } from 'zod';
import { AirportRefSchema } from './airports';
import { ICAO_CARRIER_RE, IATA_CARRIER_RE } from './carriers';
import { FlightKeySchema } from './flight-key';

/**
 * Boundary schemas for everything a provider adapter, a Durable Object or the sync feed hands
 * across a boundary. Every object schema is `z.looseObject` on purpose: Durable Objects roll
 * out gradually, so a Worker one version ahead of a FlightTracker (or behind it) must be able
 * to parse a payload that carries fields it does not know yet. Unknown fields are kept, never
 * rejected, at every level including the `providerRefs` and `fieldQuality` maps, so adding a
 * field is always backwards compatible; renaming or retyping one needs a new versioned schema
 * (see `rpc.ts`).
 *
 * Enumerations are the exception, because a value has to mean something to the consumer:
 * - `status`, a provider event's `kind` and the tracker phase carry an `unknown` member and
 *   parse a string this build does not know as `unknown` (`tolerantEnum`), so a newer producer
 *   degrades an older consumer instead of failing it. The field stays required: an absent key,
 *   `null` or a number is still rejected. The input type stays the closed union, so a producer
 *   is still checked at compile time.
 * - Every other vocabulary (`ProviderId`, `ProviderCallTrigger`, `ProviderCallResult`,
 *   `AlertEvent`, `FieldQuality`, `SyncEntity`) is closed and append-only: a producer may emit
 *   a new value only one release after every consumer accepts it.
 *
 * `z.infer` of a `looseObject` carries a string index signature, which switches off
 * TypeScript's excess-property check, so a producer that misspells a field would compile.
 * Producers (adapters, the tracker) declare what they build as `Exact<FlightStatus>` and so on
 * to get the check back; consumers keep the loose inferred types. Open-keyed records such as
 * `providerRefs` and `fieldQuality` are nothing but an index signature, so `Exact` leaves them
 * readable and writable by any string key.
 *
 * All instants are ISO-8601 UTC strings with a trailing `Z`; the only local date in the system
 * is the origin-local scheduled departure date inside the flight key.
 */

/** The keys of `T` that are not an index signature. */
type NamedKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: never;
};

/**
 * `T` with the string index signature that `looseObject` infers removed, recursively, so an
 * object literal typed `Exact<FlightStatus>` fails to compile on a misspelled field. A pure
 * record (`providerRefs`, `fieldQuality`), which has no named keys at all, keeps its index
 * signature, so a consumer can still read and write it by any string key (ruling R12). `T` and
 * `Exact<T>` are assignable to each other; only the compile-time check differs.
 */
export type Exact<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : T extends Date | ((...args: never[]) => unknown)
    ? T
    : T extends readonly (infer U)[]
      ? T extends U[]
        ? Exact<U>[]
        : readonly Exact<U>[]
      : T extends object
        ? [NamedKeys<T>] extends [never]
          ? { [K in keyof T]: Exact<T[K]> }
          : {
              [K in keyof T as string extends K ? never : number extends K ? never : K]: Exact<
                T[K]
              >;
            }
        : T;

/**
 * A closed vocabulary with a member that absorbs what this build does not know: a string outside
 * `values` parses as `fallback`, while an absent key, `null` or a non-string is still rejected,
 * so the field stays required (ruling R11). The head of the pipe accepts any string at run time
 * but is typed as the closed union, so `z.input` stays closed and a producer on this build is
 * still checked at compile time; `z.string().pipe(...)` would widen the input type to `string`.
 */
export function tolerantEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number],
): z.ZodType<T[number], T[number]> {
  return z
    .custom<T[number]>((value) => typeof value === 'string', { error: 'expected a string' })
    .pipe(z.enum(values).catch(fallback));
}

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
/** A status this build does not know parses as `unknown`; the field stays required. */
export const FlightStatusValueSchema = tolerantEnum(FLIGHT_STATUS_VALUES, 'unknown');
export type FlightStatusValue = z.infer<typeof FlightStatusValueSchema>;

/**
 * The events an AeroAPI alert can be configured for: exactly the nine booleans of the `events`
 * object in AeroAPI 4.17.1 (`POST /alerts`). `hold_start` and `hold_end`, which the plan listed,
 * do not exist in the spec and were removed in increment 6 (facts sheet section 2). This is the
 * CONFIGURATION vocabulary; what a delivery reports is the wider `AEROAPI_EVENT_CODES` below.
 */
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
] as const;
export const AlertEventSchema = z.enum(ALERT_EVENTS);
export type AlertEvent = z.infer<typeof AlertEventSchema>;

/**
 * The `event_code` of an AeroAPI alert DELIVERY (the `deliver_alert` callback in AeroAPI
 * 4.17.1), in the spec's order. Wider than `ALERT_EVENTS`: a departure or arrival bundle can
 * deliver `change`, `minutes_out` or `power_on`, and position-only and non-airport flights have
 * their own codes. FlightAware can add a code at any time, so the schema is tolerant: a code
 * this build does not know parses as `unknown` instead of failing the webhook.
 */
export const AEROAPI_EVENT_CODES = [
  'filed',
  'departure',
  'arrival',
  'out',
  'off',
  'on',
  'in',
  'diverted',
  'cancelled',
  'position_only_arrival',
  'position_only_departure',
  'fru_arrival',
  'nonairport_arrival',
  'nonairport_departure',
  'nonairport_filed',
  'minutes_out',
  'power_on',
  'change',
] as const;
export type AeroApiEventCode = (typeof AEROAPI_EVENT_CODES)[number];
/** A delivery `event_code` this build does not know parses as `unknown`; a non-string is rejected. */
export const AeroApiEventCodeSchema = tolerantEnum([...AEROAPI_EVENT_CODES, 'unknown'], 'unknown');

/**
 * Where the operating carrier in a flight key came from (ADR 0010). AeroDataBox never names an
 * operator, so the key carries the best-known operator at creation and records how it was
 * decided: `provider` (the provider says the marketing carrier operates it), `callsign` (the ATC
 * callsign's three-letter prefix on a codeshare), `hint` (the regional operator hint table) or
 * `marketing` (nothing better was known). Mirrored by `flight_instances.operator_source`.
 */
export const OPERATOR_SOURCES = ['provider', 'callsign', 'hint', 'marketing'] as const;
export const OperatorSourceSchema = z.enum(OPERATOR_SOURCES);
export type OperatorSource = z.infer<typeof OperatorSourceSchema>;

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
/** ICAO 24-bit address as six upper-case hex digits; feeds send lower case, normalise first. */
export const ICAO_HEX_RE = /^[0-9A-F]{6}$/;

/** Upper-cases a 24-bit ICAO address; returns undefined for anything that is not six hex digits. */
export function normalizeIcaoHex(value: string): string | undefined {
  const upper = value.trim().toUpperCase();
  return ICAO_HEX_RE.test(upper) ? upper : undefined;
}

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
/**
 * The fields a producer on this build marks with a quality. The `fieldQuality` map itself is
 * keyed by any string, so a marker for a field a newer producer added still parses.
 */
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
  /** How `operatingCarrierIcao` was decided (ADR 0010); absent on snapshots older than increment 6. */
  operatorSource: OperatorSourceSchema.optional(),
  /** The marketing carrier the provider was asked about, when it differs or may differ. */
  marketingCarrierIcao: z.string().regex(ICAO_CARRIER_RE).optional(),
  /** The marketing flight number that goes with `marketingCarrierIcao`. */
  marketingFlightNumber: z.string().regex(FLIGHT_NUMBER_RE).optional(),
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
  /** Provider-side ids keyed by `ProviderId`; open-keyed so an entry from a newer build parses. */
  providerRefs: z.record(z.string(), z.string()).default({}),
  fetchedAt: IsoInstantSchema,
  source: ProviderIdSchema,
  /** Quality per field, keyed by `FieldQualityKey`; open-keyed for the same reason. */
  fieldQuality: z.record(z.string(), FieldQualitySchema).default({}),
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

export const PROVIDER_EVENT_KINDS = [...ALERT_EVENTS, 'update', 'unknown'] as const;
/** A kind this build does not know parses as `unknown`; the field stays required. */
export const ProviderEventKindSchema = tolerantEnum(PROVIDER_EVENT_KINDS, 'unknown');
export type ProviderEventKind = z.infer<typeof ProviderEventKindSchema>;

const ALERT_EVENT_SET: ReadonlySet<string> = new Set(ALERT_EVENTS);
const AEROAPI_EVENT_CODE_SET: ReadonlySet<string> = new Set(AEROAPI_EVENT_CODES);

/**
 * The `ProviderEvent.kind` of an AeroAPI delivery `event_code`. A code that names one of the
 * nine configurable events keeps its name; every other code the spec lists (`change`,
 * `minutes_out`, `power_on`, the position-only and non-airport variants) is an `update` the
 * tracker merges and re-reads; anything else, including a code FlightAware adds later, is
 * `unknown`. Never throws: a webhook must not fail on a vocabulary it has not seen.
 */
export function aeroApiEventKind(code: string): ProviderEventKind {
  if (ALERT_EVENT_SET.has(code)) {
    return code as AlertEvent;
  }
  return AEROAPI_EVENT_CODE_SET.has(code) ? 'update' : 'unknown';
}

/**
 * How a webhook payload names the flight it is about: a key, a provider ref, or a marketing
 * designator plus its origin-local date. An event that names no flight cannot be routed, so
 * the webhook route rejects it here instead of the queue consumer failing on it later.
 */
export const FlightRefSchema = z
  .looseObject({
    flightKey: FlightKeySchema.optional(),
    providerRef: ProviderRefSchema.optional(),
    /** Marketing designator plus origin-local date, e.g. `AA100` on `2026-09-19`. */
    designator: z.string().optional(),
    dateLocal: IsoDateSchema.optional(),
  })
  .refine(
    (ref) =>
      ref.flightKey !== undefined ||
      ref.providerRef !== undefined ||
      (ref.designator !== undefined && ref.dateLocal !== undefined),
    {
      message: 'a flight reference needs a key, a provider ref, or a designator plus a local date',
    },
  );
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
