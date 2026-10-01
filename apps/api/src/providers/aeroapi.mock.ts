/**
 * AeroAPI adapter, mocked (increment 6).
 *
 * "Mocked" describes its data, not its code. The adapter is written against the vendored
 * AeroAPI OpenAPI 4.17.1 (`specs/aeroapi-v4.17.1.yaml`, SHA-256 pinned in
 * test/unit/aeroapi.mock.test.ts) and builds real requests, but Phase 0 has no AeroAPI key: its
 * only transport is a fixture-serving `fetch` in the tests, and while `AEROAPI_MODE=mock` the
 * router sends every cadence window to AeroDataBox and never constructs it. Facts sheet
 * section 2 decides every rule below:
 *
 *   - Auth header `x-apikey`; `ident_type` is `designator | registration | fa_flight_id`.
 *   - The FIRST fetch for a flight is a designator lookup bracketed around `scheduled_out`
 *     plus or minus one day (`start` inclusive, `end` exclusive, clamped to 10 days back and 2
 *     days ahead). The clamped window must still CONTAIN the flight, with margin
 *     (`AEROAPI_STANDARD.horizonMarginMs` before the exclusive end, the start at or before it);
 *     otherwise nothing is sent. A clamped window that lost the flight still holds the previous
 *     day's instance at its inclusive start, and that is what AeroAPI would bill and answer. Of
 *     what comes back, only the instance nearest `scheduled_out` (within 12 h) is returned, since
 *     the bracket spans two same-numbered departures a day apart. Every LATER poll asks by
 *     `fa_flight_id` with `max_pages=1`, so one poll is exactly one billed result set.
 *   - A diverted flight comes back as two items with ONE `fa_flight_id`: the original leg and
 *     the diversion. Both are returned; the diversion leg carries `actualDestination`.
 *   - `status` has no enum and no example anywhere in the spec, so it is never read: the status
 *     is derived from the `cancelled` and `diverted` flags and the OOOI times (`deriveStatus`).
 *   - Every non-200 is billed in the ledger until FlightAware confirms otherwise (owner task), and
 *     so is a `fetch` that rejects (`transport_unknown_billing`): it may have been served.
 *   - Alerts follow both halves of FlightAware's contract (orchestrator ruling I7). The spec's
 *     alerts tag says `PUT /alerts/endpoint` "must first be used ... before any alerts can be
 *     configured", or `POST /alerts` answers 400. So `registerAlert` first makes sure the
 *     account-wide endpoint is set, with an idempotent PUT of this environment's own
 *     token-bearing webhook URL (a zero-cost `alert_manage` call, at most once per isolate), and
 *     then posts the alert with the nine event booleans and a MANDATORY per-alert `target_url`
 *     (the same URL), so a delivery never depends on the account default, which every environment
 *     on one key shares. Whether staging and production need separate AeroAPI keys is an open
 *     owner decision (ADR 0010). `max_weekly` is a creation-time rejection threshold and not a
 *     spend cap: deliveries are counted in our own ledger and the alert is deleted when the
 *     budget says so. The id comes from the 201 `Location` header; there is no body.
 *   - A delivery's `event_code` is one of 18 values and may grow: it is mapped tolerantly. Its
 *     `flight` object has no timezone and no status, so it is merged onto the last polled
 *     snapshot (`mergeAeroApiAlert`), never treated as a full status.
 *   - No boards: boards and route search are AeroDataBox only (Phase 1 plan section 3,
 *     increment 18), so this adapter has no board method and `capabilities.boards` is false.
 */

import { z } from 'zod';
import {
  ALERT_EVENTS,
  AeroApiEventCodeSchema,
  CARRIER_IATA_TO_ICAO_FALLBACK,
  FLIGHT_NUMBER_RE,
  IATA_AIRPORT_RE,
  IATA_CARRIER_RE,
  ICAO_AIRPORT_RE,
  ICAO_CARRIER_RE,
  aeroApiEventKind,
  carrierIcaoFromIata,
  deriveStatus,
  flightNumberToken,
  isValidTimeZone,
  normalizeFlightNumber,
  originLocalDate,
  parseFlightKey,
  type AirportRef,
  type AlertEvent,
  type AlertRegistrationOptions,
  type CarrierIataToIcaoTable,
  type Codeshare,
  type Exact,
  type FieldQuality,
  type FlightDataProvider,
  type FlightKey,
  type FlightLookup,
  type FlightStatus,
  type FlightStatusValue,
  type FlightTimeField,
  type FlightTimes,
  type ProviderCallContext,
  type ProviderCallRecord,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderResult,
} from '@planeahead/shared';
import { sha256Hex } from '../crypto/hash';
import { AEROAPI_STANDARD } from './config';
import {
  ProviderCallError,
  callRecord,
  deniedRecord,
  errorMessageOf,
  readBody,
  reserve,
  transportErrorRecord,
  type ProviderFetch,
  type ReadBody,
} from './http';

export const AEROAPI_BASE_URL = 'https://aeroapi.flightaware.com/aeroapi/';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const STATUTE_MILE_KM = 1.609_344;

/**
 * The bracket spans two same-numbered departures a day apart; an item is the flight asked about
 * only when its `scheduled_out` lies within half that spacing of the one asked for.
 */
export const AEROAPI_INSTANCE_MATCH_MS = 12 * HOUR_MS;

/** Wait after a 429 when FlightAware sends no `Retry-After` (the spec documents none). */
export const AEROAPI_DEFAULT_BACKOFF_MS = 1_000;

// ---------------------------------------------------------------------------------------------
// Response schemas.
// ---------------------------------------------------------------------------------------------

const NullableString = z.string().nullish();
const NullableInt = z.number().nullish();

const AirportRefSchema = z.looseObject({
  code: NullableString,
  code_icao: NullableString,
  code_iata: NullableString,
  code_lid: NullableString,
  timezone: NullableString,
  name: NullableString,
  city: NullableString,
});

export const AeroApiFlightSchema = z.looseObject({
  ident: z.string(),
  ident_icao: NullableString,
  ident_iata: NullableString,
  fa_flight_id: z.string().min(1),
  operator: NullableString,
  operator_icao: NullableString,
  operator_iata: NullableString,
  flight_number: NullableString,
  registration: NullableString,
  atc_ident: NullableString,
  inbound_fa_flight_id: NullableString,
  codeshares: z.array(z.string()).nullish(),
  codeshares_iata: z.array(z.string()).nullish(),
  blocked: z.boolean(),
  diverted: z.boolean(),
  cancelled: z.boolean(),
  position_only: z.boolean(),
  origin: AirportRefSchema.nullish(),
  destination: AirportRefSchema.nullish(),
  departure_delay: NullableInt,
  arrival_delay: NullableInt,
  progress_percent: NullableInt,
  aircraft_type: NullableString,
  route_distance: NullableInt,
  baggage_claim: NullableString,
  gate_origin: NullableString,
  gate_destination: NullableString,
  terminal_origin: NullableString,
  terminal_destination: NullableString,
  scheduled_out: NullableString,
  estimated_out: NullableString,
  actual_out: NullableString,
  scheduled_off: NullableString,
  estimated_off: NullableString,
  actual_off: NullableString,
  scheduled_on: NullableString,
  estimated_on: NullableString,
  actual_on: NullableString,
  scheduled_in: NullableString,
  estimated_in: NullableString,
  actual_in: NullableString,
});
export type AeroApiFlight = z.infer<typeof AeroApiFlightSchema>;

const FlightsResponseSchema = z.looseObject({
  flights: z.array(z.unknown()),
  num_pages: z.number().optional(),
});

/** The `deliver_alert` callback body, strict on the six required fields. */
export const AeroApiAlertSchema = z.looseObject({
  long_description: z.string().max(4_096),
  short_description: z.string().max(1_024),
  summary: z.string().max(1_024),
  event_code: AeroApiEventCodeSchema,
  alert_id: z.int().nonnegative(),
  flight: z.looseObject({
    fa_flight_id: z.string().min(1).max(128),
    ident: z.string().max(32).optional(),
    cancelled: z.boolean().optional(),
    diverted: z.boolean().optional(),
    registration: NullableString,
    aircraft_type: z.string().max(16).optional(),
    gate_origin: NullableString,
    gate_destination: NullableString,
    terminal_origin: NullableString,
    terminal_destination: NullableString,
    baggage_claim: NullableString,
    scheduled_out: NullableString,
    estimated_out: NullableString,
    actual_out: NullableString,
    scheduled_off: NullableString,
    estimated_off: NullableString,
    actual_off: NullableString,
    scheduled_on: NullableString,
    estimated_on: NullableString,
    actual_on: NullableString,
    scheduled_in: NullableString,
    estimated_in: NullableString,
    actual_in: NullableString,
  }),
});

// ---------------------------------------------------------------------------------------------
// Requests.
// ---------------------------------------------------------------------------------------------

export interface BracketWindow {
  /** Inclusive, ISO-8601 UTC without milliseconds. */
  readonly start: string;
  /** Exclusive. */
  readonly end: string;
}

function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * The earliest `start` AeroAPI accepts at `now`, kept `pastLimitMarginMs` inside its 10-day limit
 * and rounded UP to a whole second: `isoSeconds` truncates, and a start truncated past the limit
 * (or reaching FlightAware a few hundred milliseconds later than `now`) is a billed 400.
 */
function earliestStartMs(nowMs: number): number {
  const limit =
    nowMs - AEROAPI_STANDARD.maxDaysBehind * DAY_MS + AEROAPI_STANDARD.pastLimitMarginMs;
  return Math.ceil(limit / 1_000) * 1_000;
}

/** The latest exclusive `end` AeroAPI accepts at `now`, rounded down to a whole second. */
function latestEndMs(nowMs: number): number {
  return Math.floor((nowMs + AEROAPI_STANDARD.maxDaysAhead * DAY_MS) / 1_000) * 1_000;
}

/**
 * `[start, end)` clamped to what AeroAPI accepts, and only when the flight at `centerMs` is still
 * inside it: at or after the inclusive start, and at least `horizonMarginMs` before the exclusive
 * end. Null otherwise, and then nothing is sent (an unbilled `outside_aeroapi_window` record).
 */
function containingWindow(
  startMs: number,
  endMs: number,
  centerMs: number,
  nowMs: number,
): BracketWindow | null {
  const start = Math.max(startMs, earliestStartMs(nowMs));
  const end = Math.min(endMs, latestEndMs(nowMs));
  if (start > centerMs || end - centerMs < AEROAPI_STANDARD.horizonMarginMs) {
    return null;
  }
  return { start: isoSeconds(start), end: isoSeconds(end) };
}

/**
 * The first fetch's window: `scheduled_out` plus or minus one day, clamped to what AeroAPI
 * accepts (no further than 10 days back and 2 days ahead of `now`), and null unless the flight
 * itself is still inside the clamped window (see `containingWindow`). That makes it null for
 * every flight at or beyond T-48 h less the margin: AeroAPI cannot see it, which is why the
 * router never sends such a lookup here.
 */
export function bracketWindow(center: Date | string, now: Date): BracketWindow | null {
  const centerMs = center instanceof Date ? center.getTime() : Date.parse(center);
  if (Number.isNaN(centerMs)) {
    return null;
  }
  return containingWindow(centerMs - DAY_MS, centerMs + DAY_MS, centerMs, now.getTime());
}

/**
 * The window when only the origin-local date is known (a designator search before any
 * `scheduled_out` exists): the local day lies inside `[date 00:00Z - 14 h, date 24:00Z + 12 h)`
 * in every zone from UTC+14 to UTC-12, so that span is asked for, clamped like `bracketWindow`.
 * The span covers more than one local day, so the adapter keeps only the items whose origin-local
 * departure date is the one asked for.
 */
export function bracketLocalDate(dateLocal: string, now: Date): BracketWindow | null {
  const midnight = Date.parse(`${dateLocal}T00:00:00Z`);
  if (Number.isNaN(midnight)) {
    return null;
  }
  const nowMs = now.getTime();
  const start = Math.max(midnight - 14 * HOUR_MS, earliestStartMs(nowMs));
  const end = Math.min(midnight + DAY_MS + 12 * HOUR_MS, latestEndMs(nowMs));
  return start < end ? { start: isoSeconds(start), end: isoSeconds(end) } : null;
}

/** The alert id in a 201 `Location` header (`/alerts/12345`, or the absolute URL). */
export function parseAlertLocation(location: string | null): string | null {
  if (location === null) {
    return null;
  }
  const match = /\/alerts\/([0-9]+)\/?(?:[?#].*)?$/.exec(location.trim());
  return match?.[1] ?? null;
}

/** The nine `events` booleans of `POST /alerts`, true for each requested event. */
export function alertEventFlags(events: readonly AlertEvent[]): Record<AlertEvent, boolean> {
  const wanted = new Set(events);
  const flags = {} as Record<AlertEvent, boolean>;
  for (const event of ALERT_EVENTS) {
    flags[event] = wanted.has(event);
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// Mapping.
// ---------------------------------------------------------------------------------------------

export class AeroApiMappingError extends Error {
  override readonly name = 'AeroApiMappingError';
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function instant(value: string | null | undefined): string | undefined {
  const text = clean(value);
  if (text === undefined) {
    return undefined;
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) || !/[zZ]|[+-][0-9]{2}:?[0-9]{2}$/.test(text)
    ? undefined
    : new Date(ms).toISOString();
}

function airportRef(
  airport: z.infer<typeof AirportRefSchema> | null | undefined,
): AirportRef | null {
  if (airport === null || airport === undefined) {
    return null;
  }
  const code = clean(airport.code)?.toUpperCase();
  const icao =
    clean(airport.code_icao)?.toUpperCase() ??
    (code !== undefined && ICAO_AIRPORT_RE.test(code) ? code : undefined);
  if (icao === undefined || !ICAO_AIRPORT_RE.test(icao) || icao.startsWith('ZZ')) {
    return null;
  }
  const ref: AirportRef = { icao };
  const iata = clean(airport.code_iata)?.toUpperCase();
  if (iata !== undefined && IATA_AIRPORT_RE.test(iata)) {
    ref.iata = iata;
  }
  const tz = clean(airport.timezone);
  if (tz !== undefined && isValidTimeZone(tz)) {
    ref.tz = tz;
  }
  return ref;
}

const TIME_KEYS: readonly (readonly [keyof AeroApiFlight, FlightTimeField, FieldQuality])[] = [
  ['scheduled_out', 'scheduledOut', 'schedule'],
  ['estimated_out', 'estimatedOut', 'estimated'],
  ['actual_out', 'actualOut', 'live'],
  ['scheduled_off', 'scheduledOff', 'schedule'],
  ['estimated_off', 'estimatedOff', 'estimated'],
  ['actual_off', 'actualOff', 'live'],
  ['scheduled_on', 'scheduledOn', 'schedule'],
  ['estimated_on', 'estimatedOn', 'estimated'],
  ['actual_on', 'actualOn', 'live'],
  ['scheduled_in', 'scheduledIn', 'schedule'],
  ['estimated_in', 'estimatedIn', 'estimated'],
  ['actual_in', 'actualIn', 'live'],
];

const CODESHARE_RE = /^([A-Z0-9]{2,3}?)([1-9][0-9]{0,3}[A-Z]?)$/;

/** Codeshares from the ICAO idents, joined with the IATA idents by flight number. */
function codesharesOf(flight: AeroApiFlight): Exact<Codeshare>[] {
  const byNumber = new Map<string, Exact<Codeshare>>();
  for (const ident of flight.codeshares ?? []) {
    const match = /^([A-Z]{3})([1-9][0-9]{0,3}[A-Z]?)$/.exec(ident.trim().toUpperCase());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      byNumber.set(match[2], { carrierIcao: match[1], flightNumber: match[2] });
    }
  }
  for (const ident of flight.codeshares_iata ?? []) {
    const match = CODESHARE_RE.exec(ident.trim().toUpperCase());
    const carrier = match?.[1];
    const number = match?.[2];
    if (carrier === undefined || number === undefined || !IATA_CARRIER_RE.test(carrier)) {
      continue;
    }
    const existing = byNumber.get(number);
    byNumber.set(
      number,
      existing === undefined
        ? { carrierIata: carrier, flightNumber: number }
        : { ...existing, carrierIata: carrier },
    );
  }
  return [...byNumber.values()];
}

export interface AeroApiMappingContext {
  readonly now: Date;
  readonly carriers: CarrierIataToIcaoTable;
}

function operatorOf(flight: AeroApiFlight, carriers: CarrierIataToIcaoTable): string | undefined {
  const icao = clean(flight.operator_icao)?.toUpperCase();
  if (icao !== undefined && ICAO_CARRIER_RE.test(icao)) {
    return icao;
  }
  const operator = clean(flight.operator)?.toUpperCase();
  if (operator !== undefined && ICAO_CARRIER_RE.test(operator)) {
    return operator;
  }
  const iata = clean(flight.operator_iata) ?? operator;
  return iata === undefined ? undefined : carrierIcaoFromIata(iata, carriers);
}

function flightNumberOf(flight: AeroApiFlight): string | undefined {
  const bare = clean(flight.flight_number);
  const candidate = bare ?? /([1-9][0-9]{0,3}[A-Z]?)$/.exec(clean(flight.ident_icao) ?? '')?.[1];
  if (candidate === undefined) {
    return undefined;
  }
  try {
    return flightNumberToken(normalizeFlightNumber(candidate));
  } catch {
    return undefined;
  }
}

/**
 * The status of an AeroAPI flight from its flags and OOOI times, with the runway times standing
 * in for missing gate times (a flight AeroAPI knows only by `scheduled_off` is still scheduled).
 * One function for a polled flight and for a delivery merged onto one, so a merge never loses a
 * fallback the poll had.
 */
export function deriveAeroApiStatus(
  flags: { readonly cancelled: boolean; readonly diverted: boolean },
  times: Exact<FlightTimes>,
  now: Date,
): FlightStatusValue {
  return deriveStatus({
    cancelled: flags.cancelled,
    diverted: flags.diverted,
    actualOut: times.actualOut,
    actualOff: times.actualOff,
    actualOn: times.actualOn,
    actualIn: times.actualIn,
    scheduledOut: times.scheduledOut ?? times.scheduledOff,
    estimatedOut: times.estimatedOut ?? times.estimatedOff,
    now,
  });
}

/** One AeroAPI flight item as a `FlightStatus`; throws for a flight we cannot key. */
export function mapAeroApiFlight(
  flight: AeroApiFlight,
  ctx: AeroApiMappingContext,
): Exact<FlightStatus> {
  const operator = operatorOf(flight, ctx.carriers);
  const number = flightNumberOf(flight);
  const origin = airportRef(flight.origin);
  const destination = airportRef(flight.destination);
  if (operator === undefined || number === undefined || !FLIGHT_NUMBER_RE.test(number)) {
    throw new AeroApiMappingError(`${flight.fa_flight_id} has no operator ICAO or flight number`);
  }
  if (origin === null || destination === null) {
    throw new AeroApiMappingError(`${flight.fa_flight_id} has no ICAO origin or destination`);
  }
  const times: Exact<FlightTimes> = {};
  const fieldQuality: Record<string, FieldQuality> = {};
  for (const [key, field, quality] of TIME_KEYS) {
    const value = instant(flight[key] as string | null | undefined);
    if (value !== undefined) {
      times[field] = value;
      fieldQuality[field] = quality;
    }
  }
  const status = deriveAeroApiStatus(flight, times, ctx.now);
  const result: Exact<FlightStatus> = {
    operatingCarrierIcao: operator,
    operatorSource: 'provider',
    flightNumber: number,
    legSeq: 1,
    codeshares: codesharesOf(flight),
    origin,
    destination,
    status,
    times,
    providerRefs: { aeroapi: flight.fa_flight_id },
    fetchedAt: ctx.now.toISOString(),
    source: 'aeroapi',
    fieldQuality,
  };
  if (times.scheduledOut !== undefined && origin.tz !== undefined) {
    result.scheduledDepartureDateLocal = originLocalDate(times.scheduledOut, origin.tz);
  }
  if (typeof flight.departure_delay === 'number') {
    result.departureDelaySec = Math.round(flight.departure_delay);
  }
  if (typeof flight.arrival_delay === 'number') {
    result.arrivalDelaySec = Math.round(flight.arrival_delay);
  }
  const optional = {
    originTerminal: clean(flight.terminal_origin),
    originGate: clean(flight.gate_origin),
    destinationTerminal: clean(flight.terminal_destination),
    destinationGate: clean(flight.gate_destination),
    baggageClaim: clean(flight.baggage_claim),
    aircraftTypeIcao: clean(flight.aircraft_type)?.toUpperCase(),
    registration: clean(flight.registration)?.toUpperCase(),
  } as const;
  for (const [field, value] of Object.entries(optional)) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[field] = value;
    }
  }
  if (optional.originGate !== undefined || optional.destinationGate !== undefined) {
    fieldQuality['gate'] = 'live';
  }
  if (optional.baggageClaim !== undefined) {
    fieldQuality['baggage'] = 'live';
  }
  if (typeof flight.route_distance === 'number' && flight.route_distance >= 0) {
    result.routeDistanceKm = Math.round(flight.route_distance * STATUTE_MILE_KM * 10) / 10;
  }
  if (typeof flight.progress_percent === 'number') {
    result.progressPercent = Math.min(100, Math.max(0, flight.progress_percent));
  }
  const inbound = clean(flight.inbound_fa_flight_id);
  if (inbound !== undefined) {
    result.inboundRef = { provider: 'aeroapi', providerId: inbound };
  }
  return result;
}

/**
 * Every item mapped, in response order. Items sharing an `fa_flight_id` are a diversion: the
 * first of them is taken as the original leg and each later one as a diversion leg, which keeps
 * the original's `destination` and carries its own reported destination as `actualDestination`.
 * The ordering rule is an assumption (the spec says only that the diversion leg has a duplicate
 * id and does not order the two); the fixture pins it and a recorded response will confirm it.
 */
export function mapAeroApiFlights(
  items: readonly unknown[],
  ctx: AeroApiMappingContext,
): { data: Exact<FlightStatus>[]; skipped: string[] } {
  const data: Exact<FlightStatus>[] = [];
  const skipped: string[] = [];
  const originalById = new Map<string, Exact<FlightStatus>>();
  for (const item of items) {
    const parsed = AeroApiFlightSchema.safeParse(item);
    if (!parsed.success) {
      skipped.push('invalid_flight');
      continue;
    }
    let mapped: Exact<FlightStatus>;
    try {
      mapped = mapAeroApiFlight(parsed.data, ctx);
    } catch (error) {
      if (!(error instanceof AeroApiMappingError)) {
        throw error;
      }
      skipped.push(error.message);
      continue;
    }
    const original = originalById.get(parsed.data.fa_flight_id);
    if (original === undefined) {
      originalById.set(parsed.data.fa_flight_id, mapped);
    } else {
      mapped.actualDestination = mapped.destination;
      mapped.destination = original.destination;
    }
    data.push(mapped);
  }
  return { data, skipped };
}

function scheduledOutMs(flight: Exact<FlightStatus>): number | undefined {
  const value = flight.times.scheduledOut ?? flight.times.scheduledOff;
  const ms = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * The instance a bracketed lookup asked about: of the items from `originIcao` (when given), the
 * `fa_flight_id` whose `scheduled_out` is nearest `centerMs`, if within
 * `AEROAPI_INSTANCE_MATCH_MS`, with every item sharing that id (a diversion leg). The bracket
 * holds the previous day's departure at its inclusive start, so returning everything would hand
 * a tracker the wrong day to adopt. Among equally near ids, an operating one wins over a
 * cancelled one whatever the order they are listed in (review ruling Q11: on a re-key the stale
 * cancelled record and its replacement share `scheduled_out`, and picking the stale one would
 * confirm a false cancellation); when every candidate is cancelled, the cancelled one is returned.
 */
export function nearestInstance(
  flights: readonly Exact<FlightStatus>[],
  centerMs: number,
  originIcao?: string,
): Exact<FlightStatus>[] {
  let bestId: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestCancelled = false;
  for (const flight of flights) {
    const ms = scheduledOutMs(flight);
    const id = flight.providerRefs['aeroapi'];
    if (ms === undefined || id === undefined) {
      continue;
    }
    if (originIcao !== undefined && flight.origin.icao !== originIcao) {
      continue;
    }
    const distance = Math.abs(ms - centerMs);
    const cancelled = flight.status === 'cancelled';
    if (distance < bestDistance || (distance === bestDistance && bestCancelled && !cancelled)) {
      bestDistance = distance;
      bestId = id;
      bestCancelled = cancelled;
    }
  }
  if (bestId === undefined || bestDistance >= AEROAPI_INSTANCE_MATCH_MS) {
    return [];
  }
  return flights.filter((flight) => flight.providerRefs['aeroapi'] === bestId);
}

/**
 * The instances departing on the origin-local date asked for (a lookup by date alone spans
 * parts of three local days). An item whose local date cannot be derived (its origin has no
 * zone) is kept rather than guessed about.
 */
export function onLocalDate(
  flights: readonly Exact<FlightStatus>[],
  dateLocal: string,
  originIcao?: string,
): Exact<FlightStatus>[] {
  return flights.filter(
    (flight) =>
      (originIcao === undefined || flight.origin.icao === originIcao) &&
      (flight.scheduledDepartureDateLocal === undefined ||
        flight.scheduledDepartureDateLocal === dateLocal),
  );
}

// ---------------------------------------------------------------------------------------------
// Alert deliveries.
// ---------------------------------------------------------------------------------------------

/**
 * What an alert delivery can change on a snapshot. Only fields the delivery actually carried
 * are present; `eventCode` is the raw code (the ProviderEvent `kind` is its tolerant mapping).
 */
export interface AeroApiAlertPatch {
  readonly source: 'aeroapi_alert';
  readonly faFlightId: string;
  readonly eventCode: string;
  readonly times: Readonly<Partial<Record<FlightTimeField, string>>>;
  readonly cancelled?: boolean | undefined;
  readonly diverted?: boolean | undefined;
  readonly originGate?: string | undefined;
  readonly destinationGate?: string | undefined;
  readonly originTerminal?: string | undefined;
  readonly destinationTerminal?: string | undefined;
  readonly baggageClaim?: string | undefined;
  readonly registration?: string | undefined;
  readonly aircraftTypeIcao?: string | undefined;
}

/**
 * Validates a `deliver_alert` body and turns it into one `ProviderEvent` whose payload is an
 * `AeroApiAlertPatch`. FlightAware sends no delivery id, so `externalId` is the alert id plus a
 * digest of the raw body: an identical redelivery dedupes, a different delivery does not.
 */
export async function parseAeroApiAlert(
  rawBody: string,
  receivedAt: Date,
): Promise<Exact<ProviderEvent>> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    throw new AeroApiAlertError('body is not JSON');
  }
  const parsed = AeroApiAlertSchema.safeParse(body);
  if (!parsed.success) {
    throw new AeroApiAlertError('not an AeroAPI alert delivery');
  }
  const alert = parsed.data;
  const rawCode =
    typeof (body as { event_code?: unknown }).event_code === 'string'
      ? (body as { event_code: string }).event_code.slice(0, 64)
      : alert.event_code;
  const times: Partial<Record<FlightTimeField, string>> = {};
  for (const [key, field] of TIME_KEYS) {
    const value = instant(alert.flight[key] as string | null | undefined);
    if (value !== undefined) {
      times[field] = value;
    }
  }
  const patch: AeroApiAlertPatch = {
    source: 'aeroapi_alert',
    faFlightId: alert.flight.fa_flight_id,
    eventCode: rawCode,
    times,
    ...(alert.flight.cancelled === undefined ? {} : { cancelled: alert.flight.cancelled }),
    ...(alert.flight.diverted === undefined ? {} : { diverted: alert.flight.diverted }),
    ...optionalString('originGate', alert.flight.gate_origin),
    ...optionalString('destinationGate', alert.flight.gate_destination),
    ...optionalString('originTerminal', alert.flight.terminal_origin),
    ...optionalString('destinationTerminal', alert.flight.terminal_destination),
    ...optionalString('baggageClaim', alert.flight.baggage_claim),
    ...optionalString('registration', alert.flight.registration?.toUpperCase()),
    ...optionalString('aircraftTypeIcao', alert.flight.aircraft_type?.toUpperCase()),
  };
  const digest = (await sha256Hex(rawBody)).slice(0, 32);
  return {
    provider: 'aeroapi',
    externalId: `${String(alert.alert_id)}:${digest}`,
    receivedAt: receivedAt.toISOString(),
    kind: aeroApiEventKind(alert.event_code),
    flightRef: { providerRef: { provider: 'aeroapi', providerId: alert.flight.fa_flight_id } },
    payload: patch,
  };
}

function optionalString<K extends string>(
  key: K,
  value: string | null | undefined,
): Partial<Record<K, string>> {
  const text = clean(value);
  return text === undefined ? {} : ({ [key]: text } as Record<K, string>);
}

export class AeroApiAlertError extends Error {
  override readonly name = 'AeroApiAlertError';
}

/**
 * Merges an alert delivery onto the last polled snapshot. The delivery has no timezone, no
 * status and no operator, so origin, destination, identity and `fetchedAt` stay the snapshot's;
 * only the times, gates, terminals, belt, registration and type it carried move, each marked with
 * the quality its field implies, and the status is derived again from the merged flags and
 * times. A delivery for another `fa_flight_id` than the snapshot's AeroAPI ref is not applied.
 */
export function mergeAeroApiAlert(
  snapshot: Exact<FlightStatus>,
  patch: AeroApiAlertPatch,
  now: Date,
): Exact<FlightStatus> {
  const ref = snapshot.providerRefs['aeroapi'];
  if (ref !== undefined && ref !== patch.faFlightId) {
    return snapshot;
  }
  const times: Exact<FlightTimes> = { ...snapshot.times };
  const fieldQuality: Record<string, FieldQuality> = { ...snapshot.fieldQuality };
  for (const [, field, quality] of TIME_KEYS) {
    const value = patch.times[field];
    if (value !== undefined) {
      times[field] = value;
      fieldQuality[field] = quality;
    }
  }
  const merged: Exact<FlightStatus> = {
    ...snapshot,
    times,
    fieldQuality,
    providerRefs: { ...snapshot.providerRefs, aeroapi: patch.faFlightId },
  };
  for (const field of [
    'originGate',
    'destinationGate',
    'originTerminal',
    'destinationTerminal',
    'baggageClaim',
    'registration',
    'aircraftTypeIcao',
  ] as const) {
    const value = patch[field];
    if (value !== undefined) {
      merged[field] = value;
    }
  }
  if (patch.originGate !== undefined || patch.destinationGate !== undefined) {
    fieldQuality['gate'] = 'live';
  }
  if (patch.baggageClaim !== undefined) {
    fieldQuality['baggage'] = 'live';
  }
  merged.status = deriveAeroApiStatus(
    {
      cancelled: patch.cancelled ?? snapshot.status === 'cancelled',
      diverted: patch.diverted ?? snapshot.status === 'diverted',
    },
    times,
    now,
  );
  return merged;
}

// ---------------------------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------------------------

export interface AeroApiAdapterOptions {
  readonly apiKey: string;
  readonly fetch: ProviderFetch;
  /**
   * The environment's webhook URL, which includes its path token
   * (`${API_PUBLIC_URL}/v1/webhooks/aeroapi/${WEBHOOK_TOKEN_AEROAPI}`, built by the router only
   * from a well-formed token). `registerAlert` sets it as the account-wide endpoint (the
   * prerequisite FlightAware enforces) and sends it as every alert's own `target_url`. Mandatory
   * for `registerAlert`.
   */
  readonly alertTargetUrl?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly carriers?: CarrierIataToIcaoTable | undefined;
  /**
   * Which account endpoints this isolate has already set (test seam). Defaults to one set per
   * isolate, so the PUT happens at most once per isolate per key and URL.
   */
  readonly alertEndpointsSet?: Set<string> | undefined;
  /** Clock for `parseWebhook` only; every call reads `ctx.now`. */
  readonly now: () => Date;
}

/**
 * The account endpoints this isolate has set. Isolate scope on purpose (ruling I7: "at most once
 * per isolate"): the PUT is idempotent, so losing this on eviction costs one more free call, and
 * it holds no request data. Keyed by base URL, a digest of the key and the endpoint URL.
 */
const ALERT_ENDPOINTS_SET = new Set<string>();

/** Whether an AeroAPI error text is the "set the account endpoint first" refusal. */
function isMissingEndpointError(error: string | undefined): boolean {
  return error !== undefined && /alerts\/endpoint|endpoint.*(?:configur|set)/i.test(error);
}

export class AeroApiAdapter implements FlightDataProvider {
  readonly id = 'aeroapi' as const;
  readonly capabilities: ProviderCapabilities = {
    alerts: true,
    // Which fields a delivery carries in practice is measured with a live alert (owner task).
    alertFields: ['unknown'],
    boards: false,
    maxDaysAhead: AEROAPI_STANDARD.maxDaysAhead,
    fidsWindowHours: AEROAPI_STANDARD.fidsWindowHours,
    inboundLink: true,
  };
  readonly #options: AeroApiAdapterOptions;
  readonly #baseUrl: string;

  constructor(options: AeroApiAdapterOptions) {
    this.#options = options;
    this.#baseUrl = options.baseUrl ?? AEROAPI_BASE_URL;
  }

  #mapping(now: Date): AeroApiMappingContext {
    return { now, carriers: this.#options.carriers ?? CARRIER_IATA_TO_ICAO_FALLBACK };
  }

  /**
   * One budgeted attempt. Every answer AeroAPI gives is billed, and so is a `fetch` that rejects
   * (the reservation is kept: the request may have been served). The request is built by the
   * caller before this reserves, so nothing that fails before sending holds a reservation.
   */
  async #send(
    ctx: ProviderCallContext,
    operation:
      | 'flight_by_ident'
      | 'flight_by_id'
      | 'airport_arrivals'
      | 'airport_departures'
      | 'alert_manage',
    request: Request,
    okStatus: number,
  ): Promise<{ call: ProviderCallRecord; body: ReadBody | null; response: Response | null }> {
    const reservation = await reserve(ctx, this.id, operation);
    if (!reservation.decision.allowed) {
      return {
        call: deniedRecord(ctx, this.id, operation, reservation.decision.reason),
        body: null,
        response: null,
      };
    }
    request.headers.set('x-apikey', this.#options.apiKey);
    request.headers.set('Accept', 'application/json; charset=UTF-8');
    const startedAt = ctx.now();
    let response: Response;
    try {
      response = await this.#options.fetch(request);
    } catch (error) {
      return {
        call: transportErrorRecord(ctx, this.id, operation, startedAt, error),
        body: null,
        response: null,
      };
    }
    const body = await readBody(response);
    const base = {
      ctx,
      provider: this.id,
      operation,
      startedAt,
      finishedAt: ctx.now(),
      httpStatus: response.status,
      responseBytes: body.bytes,
      billed: true,
    } as const;
    if (response.status === okStatus) {
      return { call: callRecord({ ...base, result: 'ok' }), body, response };
    }
    if (response.status === 429) {
      const header = Number(response.headers.get('retry-after'));
      await ctx.budget.backoff?.(
        this.id,
        Number.isFinite(header) && header > 0
          ? Math.min(60_000, header * 1_000)
          : AEROAPI_DEFAULT_BACKOFF_MS,
      );
      return {
        call: callRecord({ ...base, result: 'rate_limited', error: 'http_429' }),
        body,
        response,
      };
    }
    const message = errorMessageOf(body);
    return {
      call: callRecord({
        ...base,
        result: response.status === 404 ? 'not_found' : 'error',
        error: `http_${String(response.status)}${message === undefined ? '' : `:${message}`}`,
      }),
      body,
      response,
    };
  }

  #url(path: string, query: Record<string, string>): URL {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  /**
   * By `fa_flight_id` once known (`lookup.providerRef`), otherwise the bracketed designator
   * lookup: around `lookup.scheduledOut` when the caller has it, around the midpoint of
   * `lookup.window` when it passes a bracket, or across the origin-local day. Always
   * `max_pages=1`. A bracket that no longer contains the flight is not sent (see
   * `bracketWindow`), and of a designator answer only the flight asked about is returned: the
   * instance nearest `scheduled_out` (within `AEROAPI_INSTANCE_MATCH_MS`, with its diversion leg),
   * or every instance departing on the asked origin-local date. Nothing else AeroAPI returned is
   * ever handed to a tracker to adopt.
   */
  async getFlight(
    lookup: FlightLookup,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<Exact<FlightStatus>[]>> {
    const now = ctx.now();
    let url: URL;
    let operation: 'flight_by_id' | 'flight_by_ident';
    let centerMs: number | undefined;
    if (lookup.providerRef?.provider === 'aeroapi') {
      operation = 'flight_by_id';
      url = this.#url(`flights/${encodeURIComponent(lookup.providerRef.id)}`, {
        ident_type: 'fa_flight_id',
        max_pages: '1',
      });
    } else {
      operation = 'flight_by_ident';
      let window: BracketWindow | null;
      if (lookup.scheduledOut !== undefined) {
        centerMs = Date.parse(lookup.scheduledOut);
        window = bracketWindow(lookup.scheduledOut, now);
      } else if (lookup.window !== undefined) {
        const start = Date.parse(lookup.window.start);
        const end = Date.parse(lookup.window.end);
        centerMs = start + (end - start) / 2;
        window =
          Number.isNaN(start) || Number.isNaN(end) || end <= start
            ? null
            : containingWindow(start, end, centerMs, now.getTime());
      } else {
        window = bracketLocalDate(lookup.dateLocal, now);
      }
      if (window === null) {
        return {
          data: [],
          call: callRecord({
            ctx,
            provider: this.id,
            operation,
            startedAt: now,
            finishedAt: now,
            result: 'error',
            billed: false,
            error: 'outside_aeroapi_window',
          }),
        };
      }
      const carrier = lookup.carrier.icao ?? lookup.carrier.iata;
      if (carrier === undefined) {
        throw new RangeError('a lookup needs an ICAO or IATA carrier code');
      }
      const ident = `${carrier}${flightNumberToken(normalizeFlightNumber(lookup.flightNumber))}`;
      url = this.#url(`flights/${encodeURIComponent(ident)}`, {
        ident_type: 'designator',
        start: window.start,
        end: window.end,
        max_pages: '1',
      });
    }
    const { call, body } = await this.#send(
      ctx,
      operation,
      new Request(url, { method: 'GET' }),
      200,
    );
    if (call.result !== 'ok') {
      return { data: [], call };
    }
    if (body?.kind !== 'json') {
      return { data: [], call: { ...call, result: 'error', error: 'non_json' } };
    }
    const parsed = FlightsResponseSchema.safeParse(body.value);
    if (!parsed.success) {
      return { data: [], call: { ...call, result: 'error', error: 'not_a_flights_response' } };
    }
    if (parsed.data.flights.length === 0) {
      return { data: [], call: { ...call, result: 'not_found' } };
    }
    const mapped = mapAeroApiFlights(parsed.data.flights, this.#mapping(now));
    const skipped = mapped.skipped;
    let data = mapped.data;
    if (operation === 'flight_by_ident' && data.length > 0) {
      // Other instances of the same designator are not errors: the bracket spans them by design.
      data =
        centerMs === undefined
          ? onLocalDate(data, lookup.dateLocal, lookup.originIcao)
          : nearestInstance(data, centerMs, lookup.originIcao);
      if (data.length === 0) {
        return {
          data,
          call: {
            ...call,
            result: 'not_found',
            error: `other_instances:${String(mapped.data.length)}`,
          },
        };
      }
    }
    if (skipped.length === 0) {
      return { data, call };
    }
    return {
      data,
      call: {
        ...call,
        result: data.length === 0 ? 'error' : call.result,
        error: `skipped ${String(skipped.length)}: ${skipped.join('; ')}`.slice(0, 200),
      },
    };
  }

  /**
   * Makes sure the account-wide alert endpoint is set before the first alert (FlightAware's
   * prerequisite: without it `POST /alerts` answers 400). An idempotent `PUT /alerts/endpoint`
   * of this environment's webhook URL, a zero-cost `alert_manage` call made at most once per
   * isolate, recorded here through `ctx.log` because `registerAlert` returns the POST's record.
   * A refusal throws `ProviderCallError` carrying the PUT's record (`alert_endpoint_not_set`),
   * and no alert is posted.
   */
  async #ensureAlertEndpoint(url: string, ctx: ProviderCallContext): Promise<string> {
    const set = this.#options.alertEndpointsSet ?? ALERT_ENDPOINTS_SET;
    const cacheKey = `${this.#baseUrl} ${await sha256Hex(this.#options.apiKey)} ${url}`;
    if (set.has(cacheKey)) {
      return cacheKey;
    }
    const request = new Request(this.#url('alerts/endpoint', {}), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ url }),
    });
    const { call } = await this.#send(ctx, 'alert_manage', request, 204);
    if (call.result !== 'ok') {
      throw new ProviderCallError('AeroAPI refused to set the account alert endpoint', {
        ...call,
        error: `alert_endpoint_not_set:${call.error ?? ''}`,
      });
    }
    await ctx.log.record(call);
    set.add(cacheKey);
    return cacheKey;
  }

  /**
   * `POST /alerts` for one flight instance: the nine event booleans, the instance's operating
   * designator, origin and date, `max_weekly` (a creation-time threshold, NOT a spend cap) and
   * the mandatory per-alert `target_url`, after `#ensureAlertEndpoint`. Throws
   * `ProviderCallError` (carrying the record) when AeroAPI refuses; a 400 that names the missing
   * account endpoint is `alert_endpoint_missing` and forgets this isolate's "already set", so the
   * next registration PUTs again.
   */
  async registerAlert(
    key: FlightKey,
    options: AlertRegistrationOptions,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ alertId: string }>> {
    const targetUrl = this.#options.alertTargetUrl;
    if (targetUrl === undefined || !/^https:\/\//.test(targetUrl)) {
      throw new AeroApiAlertError(
        "registerAlert needs this environment's https webhook URL (with a well-formed token) as its target_url",
      );
    }
    const parts = parseFlightKey(key);
    const cacheKey = await this.#ensureAlertEndpoint(targetUrl, ctx);
    const body = {
      ident: `${parts.operatingCarrierIcao}${parts.flightNumber}`,
      origin: parts.originIcao,
      start: parts.scheduledDepartureDateLocal,
      end: parts.scheduledDepartureDateLocal,
      max_weekly: options.maxWeekly,
      eta: 0,
      events: alertEventFlags(options.events),
      target_url: targetUrl,
    };
    const request = new Request(this.#url('alerts', {}), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
    });
    const { call, response } = await this.#send(ctx, 'alert_manage', request, 201);
    if (call.result !== 'ok' || response === null) {
      if (call.httpStatus === 400 && isMissingEndpointError(call.error)) {
        (this.#options.alertEndpointsSet ?? ALERT_ENDPOINTS_SET).delete(cacheKey);
        throw new ProviderCallError(
          'AeroAPI has no account alert endpoint for this key; the next registration sets it',
          { ...call, error: `alert_endpoint_missing:${call.error ?? ''}` },
        );
      }
      throw new ProviderCallError(`AeroAPI refused the alert for ${key}`, call);
    }
    const alertId = parseAlertLocation(response.headers.get('location'));
    if (alertId === null) {
      throw new ProviderCallError('AeroAPI answered 201 without a parseable Location header', {
        ...call,
        result: 'error',
        error: 'no_location',
      });
    }
    return { data: { alertId }, call };
  }

  /** `DELETE /alerts/{id}`; 204 on success, `ProviderCallError` otherwise. */
  async deleteAlert(alertId: string, ctx: ProviderCallContext): Promise<ProviderResult<void>> {
    if (!/^[0-9]+$/.test(alertId)) {
      throw new RangeError(`"${alertId}" is not an AeroAPI alert id`);
    }
    const request = new Request(this.#url(`alerts/${alertId}`, {}), { method: 'DELETE' });
    const { call } = await this.#send(ctx, 'alert_manage', request, 204);
    if (call.result !== 'ok') {
      throw new ProviderCallError(`AeroAPI refused to delete alert ${alertId}`, call);
    }
    return { data: undefined, call };
  }

  /** Parses one `deliver_alert` callback (the route has already checked the path token). */
  async parseWebhook(raw: Request): Promise<Exact<ProviderEvent>[]> {
    return [await parseAeroApiAlert(await raw.text(), this.#options.now())];
  }
}
