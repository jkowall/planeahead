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
 *     days ahead). Every LATER poll asks by `fa_flight_id` with `max_pages=1`, so one poll is
 *     exactly one billed result set.
 *   - A diverted flight comes back as two items with ONE `fa_flight_id`: the original leg and
 *     the diversion. Both are returned; the diversion leg carries `actualDestination`.
 *   - `status` has no enum and no example anywhere in the spec, so it is never read: the status
 *     is derived from the `cancelled` and `diverted` flags and the OOOI times (`deriveStatus`).
 *   - Every non-200 is billed in the ledger until FlightAware confirms otherwise (owner task).
 *   - Alerts: `registerAlert` sends the nine event booleans and a MANDATORY per-alert
 *     `target_url`; the account-wide `PUT /alerts/endpoint` is shared by every environment on one
 *     key and is never used. `max_weekly` is a creation-time rejection threshold and not a spend
 *     cap: deliveries are counted in our own ledger and the alert is deleted when the budget says
 *     so. The id comes from the 201 `Location` header; there is no body.
 *   - A delivery's `event_code` is one of 18 values and may grow: it is mapped tolerantly. Its
 *     `flight` object has no timezone and no status, so it is merged onto the last polled
 *     snapshot (`mergeAeroApiAlert`), never treated as a full status.
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
  type BoardRow,
  type CarrierIataToIcaoTable,
  type Codeshare,
  type Exact,
  type FieldQuality,
  type FlightDataProvider,
  type FlightKey,
  type FlightLookup,
  type FlightStatus,
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
const STATUTE_MILE_KM = 1.609_344;

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
 * The first fetch's window: `scheduled_out` plus or minus one day, clamped to what AeroAPI
 * accepts (no further than 10 days back and 2 days ahead of `now`). Null when nothing of the
 * window is reachable, which is the case for every flight more than 3 days out: AeroAPI cannot
 * see it, which is why the cadence never routes a pre-48 h window here.
 */
export function bracketWindow(center: Date | string, now: Date): BracketWindow | null {
  const centerMs = center instanceof Date ? center.getTime() : Date.parse(center);
  if (Number.isNaN(centerMs)) {
    return null;
  }
  const nowMs = now.getTime();
  const start = Math.max(centerMs - DAY_MS, nowMs - AEROAPI_STANDARD.maxDaysBehind * DAY_MS);
  const end = Math.min(centerMs + DAY_MS, nowMs + AEROAPI_STANDARD.maxDaysAhead * DAY_MS);
  return start < end ? { start: isoSeconds(start), end: isoSeconds(end) } : null;
}

/**
 * The window when only the origin-local date is known (a designator search before any
 * `scheduled_out` exists): the local day lies inside `[date 00:00Z - 14 h, date 24:00Z + 12 h)`
 * in every zone from UTC+14 to UTC-12, so that span is asked for, clamped like `bracketWindow`.
 */
export function bracketLocalDate(dateLocal: string, now: Date): BracketWindow | null {
  const midnight = Date.parse(`${dateLocal}T00:00:00Z`);
  if (Number.isNaN(midnight)) {
    return null;
  }
  const nowMs = now.getTime();
  const start = Math.max(
    midnight - 14 * 3_600_000,
    nowMs - AEROAPI_STANDARD.maxDaysBehind * DAY_MS,
  );
  const end = Math.min(
    midnight + DAY_MS + 12 * 3_600_000,
    nowMs + AEROAPI_STANDARD.maxDaysAhead * DAY_MS,
  );
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
  const status = deriveStatus({
    cancelled: flight.cancelled,
    diverted: flight.diverted,
    actualOut: times.actualOut,
    actualOff: times.actualOff,
    actualOn: times.actualOn,
    actualIn: times.actualIn,
    scheduledOut: times.scheduledOut ?? times.scheduledOff,
    estimatedOut: times.estimatedOut ?? times.estimatedOff,
    now: ctx.now,
  });
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

function boardRowOf(
  flight: AeroApiFlight,
  direction: 'dep' | 'arr',
  ctx: AeroApiMappingContext,
): Exact<BoardRow> | null {
  let status: Exact<FlightStatus>;
  try {
    status = mapAeroApiFlight(flight, ctx);
  } catch {
    return null;
  }
  const scheduled = direction === 'dep' ? status.times.scheduledOut : status.times.scheduledIn;
  if (scheduled === undefined) {
    return null;
  }
  const row: Exact<BoardRow> = {
    direction,
    designator:
      clean(flight.ident_iata) ??
      clean(flight.ident) ??
      `${status.operatingCarrierIcao}${status.flightNumber}`,
    operatingCarrierIcao: status.operatingCarrierIcao,
    flightNumber: status.flightNumber,
    counterpart: direction === 'dep' ? status.destination : status.origin,
    scheduled,
    status: status.status,
    codeshares: status.codeshares,
    source: 'aeroapi',
  };
  const estimated = direction === 'dep' ? status.times.estimatedOut : status.times.estimatedIn;
  const actual = direction === 'dep' ? status.times.actualOut : status.times.actualIn;
  const gate = direction === 'dep' ? status.originGate : status.destinationGate;
  const terminal = direction === 'dep' ? status.originTerminal : status.destinationTerminal;
  if (estimated !== undefined) {
    row.estimated = estimated;
  }
  if (actual !== undefined) {
    row.actual = actual;
  }
  if (gate !== undefined) {
    row.gate = gate;
  }
  if (terminal !== undefined) {
    row.terminal = terminal;
  }
  if (direction === 'arr' && status.baggageClaim !== undefined) {
    row.baggageClaim = status.baggageClaim;
  }
  if (status.aircraftTypeIcao !== undefined) {
    row.aircraftTypeIcao = status.aircraftTypeIcao;
  }
  return row;
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
  merged.status = deriveStatus({
    cancelled: patch.cancelled ?? snapshot.status === 'cancelled',
    diverted: patch.diverted ?? snapshot.status === 'diverted',
    actualOut: times.actualOut,
    actualOff: times.actualOff,
    actualOn: times.actualOn,
    actualIn: times.actualIn,
    scheduledOut: times.scheduledOut,
    estimatedOut: times.estimatedOut,
    now,
  });
  return merged;
}

// ---------------------------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------------------------

export interface AeroApiAdapterOptions {
  readonly apiKey: string;
  readonly fetch: ProviderFetch;
  /**
   * The per-alert `target_url`, which includes the environment's path token
   * (`${API_PUBLIC_URL}/v1/webhooks/aeroapi/${WEBHOOK_TOKEN_AEROAPI}`). Mandatory for
   * `registerAlert`: without it an alert would fall back to the account-wide endpoint.
   */
  readonly alertTargetUrl?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly carriers?: CarrierIataToIcaoTable | undefined;
  /** Clock for `parseWebhook` only; every call reads `ctx.now`. */
  readonly now: () => Date;
}

export class AeroApiAdapter implements FlightDataProvider {
  readonly id = 'aeroapi' as const;
  readonly capabilities: ProviderCapabilities = {
    alerts: true,
    // Which fields a delivery carries in practice is measured with a live alert (owner task).
    alertFields: ['unknown'],
    boards: true,
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

  /** One budgeted attempt. Every answer AeroAPI gives is billed; only a transport error is not. */
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
      await ctx.budget.release?.(reservation.request, reservation.request.pollEquivalents);
      return {
        call: transportErrorRecord(ctx, this.id, operation, startedAt, error, false),
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
   * lookup. Always `max_pages=1`.
   */
  async getFlight(
    lookup: FlightLookup,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<Exact<FlightStatus>[]>> {
    const now = ctx.now();
    let url: URL;
    let operation: 'flight_by_id' | 'flight_by_ident';
    if (lookup.providerRef?.provider === 'aeroapi') {
      operation = 'flight_by_id';
      url = this.#url(`flights/${encodeURIComponent(lookup.providerRef.id)}`, {
        ident_type: 'fa_flight_id',
        max_pages: '1',
      });
    } else {
      operation = 'flight_by_ident';
      const window =
        lookup.window === undefined
          ? bracketLocalDate(lookup.dateLocal, now)
          : clampWindow(lookup.window, now);
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
    const { data, skipped } = mapAeroApiFlights(parsed.data.flights, this.#mapping(now));
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

  /** Recent departures or arrivals at an airport (`airport_departures` / `airport_arrivals`). */
  async getBoard(
    airportIcao: string,
    direction: 'dep' | 'arr',
    window: { from: string; to: string },
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<Exact<BoardRow>[]>> {
    const icao = airportIcao.trim().toUpperCase();
    const now = ctx.now();
    const clamped = clampWindow({ start: window.from, end: window.to }, now);
    const operation = direction === 'dep' ? 'airport_departures' : 'airport_arrivals';
    if (clamped === null) {
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
    const url = this.#url(
      `airports/${encodeURIComponent(icao)}/flights/${direction === 'dep' ? 'departures' : 'arrivals'}`,
      { start: clamped.start, end: clamped.end, max_pages: '1' },
    );
    const { call, body } = await this.#send(
      ctx,
      operation,
      new Request(url, { method: 'GET' }),
      200,
    );
    if (call.result !== 'ok' || body?.kind !== 'json') {
      return { data: [], call };
    }
    const key = direction === 'dep' ? 'departures' : 'arrivals';
    const items = (body.value as Record<string, unknown> | null)?.[key];
    if (!Array.isArray(items)) {
      return { data: [], call: { ...call, result: 'error', error: 'not_a_board_response' } };
    }
    const mapping = this.#mapping(now);
    const rows: Exact<BoardRow>[] = [];
    for (const item of items) {
      const parsed = AeroApiFlightSchema.safeParse(item);
      const row = parsed.success ? boardRowOf(parsed.data, direction, mapping) : null;
      if (row !== null) {
        rows.push(row);
      }
    }
    return { data: rows, call };
  }

  /**
   * `POST /alerts` for one flight instance: the nine event booleans, the instance's origin and
   * date, `max_weekly` (a creation-time threshold, NOT a spend cap) and the mandatory per-alert
   * `target_url`. Throws `ProviderCallError` (carrying the record) when AeroAPI refuses it.
   */
  async registerAlert(
    key: FlightKey,
    options: AlertRegistrationOptions,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<{ alertId: string }>> {
    const targetUrl = this.#options.alertTargetUrl;
    if (targetUrl === undefined || !/^https:\/\//.test(targetUrl)) {
      throw new AeroApiAlertError(
        'registerAlert needs a per-alert https target_url; the account-wide endpoint is never used',
      );
    }
    const parts = parseFlightKey(key);
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

/** A caller-supplied window, clamped to 10 days back and 2 days ahead. */
function clampWindow(window: { start: string; end: string }, now: Date): BracketWindow | null {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }
  const nowMs = now.getTime();
  const from = Math.max(start, nowMs - AEROAPI_STANDARD.maxDaysBehind * DAY_MS);
  const to = Math.min(end, nowMs + AEROAPI_STANDARD.maxDaysAhead * DAY_MS);
  return from < to ? { start: isoSeconds(from), end: isoSeconds(to) } : null;
}
