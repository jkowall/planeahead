import { z } from 'zod';
import { ICAO_AIRPORT_RE } from './airports';
import { ICAO_CARRIER_RE, IATA_CARRIER_RE, type CarrierRef } from './carriers';
import seedJson from './data/regional-operators.seed.json';
import type { FlightStatus } from './flight-status';

/**
 * Flight identity (ADR 0003). The canonical key of a flight instance is
 *
 *   `${OPERATING_ICAO}-${NUMBER}-${YYYY-MM-DD}-${ORIGIN_ICAO}` with `-L${legSeq}` when legSeq > 1
 *
 * for example `AAL-100-2026-09-19-KJFK`. The carrier is the OPERATING carrier (codeshares
 * collapse onto one key), the date is the origin-local scheduled departure date at first
 * sight, the airport is the origin's ICAO code. The key names the FlightTracker Durable
 * Object and the `flight_instances` row, so it is immutable once created: a later schedule
 * change that crosses midnight does not re-key the tracker (`reconcileFlightKey`), and a real
 * reschedule to another day is a new instance plus a merge record, never a rename.
 *
 * Nothing here talks to a provider or a database. Date derivation uses `Intl.DateTimeFormat`
 * with the `timeZone` option, which Node 24, Workers and Hermes all support, and never assumes
 * UTC when the origin time zone is unknown.
 */

declare const flightKeyBrand: unique symbol;
export type FlightKey = string & { readonly [flightKeyBrand]: true };

export const FLIGHT_KEY_RE =
  /^([A-Z]{3})-([1-9][0-9]{0,3}[A-Z]?)-([0-9]{4}-[0-9]{2}-[0-9]{2})-([A-Z0-9]{4})(?:-L([2-9]|[1-9][0-9]+))?$/;

export type FlightKeyErrorCode =
  | 'invalid_carrier'
  | 'invalid_flight_number'
  | 'invalid_date'
  | 'invalid_airport'
  | 'invalid_leg_seq'
  | 'invalid_key'
  | 'invalid_designator'
  | 'invalid_instant'
  | 'invalid_timezone'
  | 'missing_local_date';

export class FlightKeyError extends Error {
  override readonly name = 'FlightKeyError';

  constructor(
    readonly code: FlightKeyErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** True for a real calendar date in `YYYY-MM-DD` form (`2026-02-30` is false). */
export function isValidIsoDate(date: string): boolean {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(date);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export function isFlightKey(value: string): value is FlightKey {
  const match = FLIGHT_KEY_RE.exec(value);
  return match !== null && match[3] !== undefined && isValidIsoDate(match[3]);
}

export const FlightKeySchema = z.custom<FlightKey>(
  (value) => typeof value === 'string' && isFlightKey(value),
  { message: 'expected a flight key like AAL-100-2026-09-19-KJFK' },
);

export interface NormalizedFlightNumber {
  /** Digits without leading zeros, 1 to 4 of them. */
  number: string;
  /** Optional single upper-case letter, e.g. the `A` in `AA100A`. */
  suffix?: string;
}

/**
 * Strips whitespace and leading zeros, upper-cases a single-letter suffix, and rejects
 * anything that is not `^[0-9]{1,4}[A-Z]?$` afterwards. Flight number 0 does not exist, so
 * an all-zero input is rejected too.
 */
export function normalizeFlightNumber(input: string): NormalizedFlightNumber {
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/^0+(?=[0-9])/, '');
  const match = /^([1-9][0-9]{0,3})([A-Z])?$/.exec(cleaned);
  if (match === null || match[1] === undefined) {
    throw new FlightKeyError(
      'invalid_flight_number',
      `flight number "${input}" must be 1 to 4 digits with an optional letter suffix`,
    );
  }
  return match[2] === undefined ? { number: match[1] } : { number: match[1], suffix: match[2] };
}

/** `number` plus `suffix` as it appears inside a key (`100`, `100A`). */
export function flightNumberToken(value: NormalizedFlightNumber): string {
  return value.suffix === undefined ? value.number : `${value.number}${value.suffix}`;
}

export interface ParsedDesignator {
  carrier: CarrierRef;
  number: string;
  suffix?: string;
}

const DESIGNATOR_RE = /^([A-Z]{3}|(?=[0-9]*[A-Z])[A-Z0-9]{2})[\s-]*([0-9]+)([A-Z])?$/;

/**
 * Splits `AA100`, `AA 100`, `AAL100`, `aa0100`, `BA1512` into a carrier reference and a
 * normalised number. Three letters are read as ICAO, two characters as IATA. Codeshares are
 * not resolved here; that needs a provider answer (`canonicalizeFromProvider`).
 */
export function parseDesignator(input: string): ParsedDesignator {
  const match = DESIGNATOR_RE.exec(input.trim().toUpperCase());
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new FlightKeyError('invalid_designator', `"${input}" is not a flight designator`);
  }
  const code = match[1];
  const normalized = normalizeFlightNumber(match[2] + (match[3] ?? ''));
  const carrier: CarrierRef = ICAO_CARRIER_RE.test(code) ? { icao: code } : { iata: code };
  return normalized.suffix === undefined
    ? { carrier, number: normalized.number }
    : { carrier, number: normalized.number, suffix: normalized.suffix };
}

export interface FlightKeyParts {
  operatingCarrierIcao: string;
  /** Accepts `100`, `0100`, `100A`; normalised before use. */
  flightNumber: string;
  scheduledDepartureDateLocal: string;
  originIcao: string;
  legSeq?: number;
}

export interface ParsedFlightKey extends FlightKeyParts {
  flightNumber: string;
  legSeq: number;
}

/**
 * Builds a key from already-normalised parts. Carrier and airport codes must be upper-case
 * ICAO codes (no IATA, no lower-case); the date must be a real calendar date; `legSeq` must be
 * a positive integer and is only rendered when greater than 1.
 */
export function buildFlightKey(parts: FlightKeyParts): FlightKey {
  const { operatingCarrierIcao, scheduledDepartureDateLocal, originIcao, legSeq } = parts;
  if (!ICAO_CARRIER_RE.test(operatingCarrierIcao)) {
    throw new FlightKeyError(
      'invalid_carrier',
      `operating carrier "${operatingCarrierIcao}" must be a 3-letter upper-case ICAO code`,
    );
  }
  const number = flightNumberToken(normalizeFlightNumber(parts.flightNumber));
  if (!isValidIsoDate(scheduledDepartureDateLocal)) {
    throw new FlightKeyError(
      'invalid_date',
      `scheduled departure date "${scheduledDepartureDateLocal}" must be a valid YYYY-MM-DD`,
    );
  }
  if (!ICAO_AIRPORT_RE.test(originIcao)) {
    throw new FlightKeyError(
      'invalid_airport',
      `origin "${originIcao}" must be a 4-character upper-case ICAO code`,
    );
  }
  if (legSeq !== undefined && (!Number.isInteger(legSeq) || legSeq < 1)) {
    throw new FlightKeyError('invalid_leg_seq', `legSeq ${String(legSeq)} must be an integer >= 1`);
  }
  const suffix = legSeq !== undefined && legSeq > 1 ? `-L${String(legSeq)}` : '';
  return `${operatingCarrierIcao}-${number}-${scheduledDepartureDateLocal}-${originIcao}${suffix}` as FlightKey;
}

export function parseFlightKey(key: string): ParsedFlightKey {
  const match = FLIGHT_KEY_RE.exec(key);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined ||
    !isValidIsoDate(match[3])
  ) {
    throw new FlightKeyError('invalid_key', `"${key}" is not a flight key`);
  }
  return {
    operatingCarrierIcao: match[1],
    flightNumber: match[2],
    scheduledDepartureDateLocal: match[3],
    originIcao: match[4],
    legSeq: match[5] === undefined ? 1 : Number(match[5]),
  };
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatterFor(tz: string): Intl.DateTimeFormat {
  const cached = dateFormatters.get(tz);
  if (cached !== undefined) {
    return cached;
  }
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new FlightKeyError('invalid_timezone', `"${tz}" is not an IANA time zone`);
  }
  dateFormatters.set(tz, formatter);
  return formatter;
}

/**
 * Calendar date of `instant` in the IANA zone `tz`, as `YYYY-MM-DD`. This is the only way a
 * local date is ever derived in the system; there is no UTC fallback.
 */
export function originLocalDate(instant: Date | string, tz: string): string {
  const date = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(date.getTime())) {
    throw new FlightKeyError('invalid_instant', `"${String(instant)}" is not an instant`);
  }
  const parts = dateFormatterFor(tz).formatToParts(date);
  let year = '';
  let month = '';
  let day = '';
  for (const part of parts) {
    if (part.type === 'year') {
      year = part.value;
    } else if (part.type === 'month') {
      month = part.value;
    } else if (part.type === 'day') {
      day = part.value;
    }
  }
  return `${year.padStart(4, '0')}-${month}-${day}`;
}

/**
 * The origin-local scheduled departure date of a provider status: derived from
 * `times.scheduledOut` in `origin.tz` when both exist, else the provider's own local date
 * field, else a `missing_local_date` error. UTC is never assumed.
 */
export function scheduledDepartureDateLocalOf(status: FlightStatus): string {
  const scheduledOut = status.times.scheduledOut;
  const tz = status.origin.tz;
  if (scheduledOut !== undefined && tz !== undefined) {
    return originLocalDate(scheduledOut, tz);
  }
  if (status.scheduledDepartureDateLocal !== undefined) {
    return status.scheduledDepartureDateLocal;
  }
  throw new FlightKeyError(
    'missing_local_date',
    `cannot derive the origin-local date for ${status.operatingCarrierIcao}${status.flightNumber}: ` +
      'no origin.tz with times.scheduledOut and no scheduledDepartureDateLocal',
  );
}

/**
 * Canonical key of a provider-normalised status: operating carrier, normalised number,
 * origin-local scheduled date, origin ICAO, legSeq. Any `key` already on the status is ignored.
 */
export function canonicalizeFromProvider(status: FlightStatus): FlightKey {
  return buildFlightKey({
    operatingCarrierIcao: status.operatingCarrierIcao,
    flightNumber: status.flightNumber,
    scheduledDepartureDateLocal: scheduledDepartureDateLocalOf(status),
    originIcao: status.origin.icao,
    legSeq: status.legSeq,
  });
}

export type KeyDrift = 'none' | 'date_shift' | 'different_flight';

/**
 * Compares the key a tracker was created with against a freshly canonicalised one.
 * `date_shift` means only the local date moved (a schedule change across midnight, or a
 * reschedule to another day); `different_flight` means carrier, number, origin or leg differ
 * (an operator swap or a provider correction) and the merge path has to look at it.
 */
export function classifyKeyDrift(existing: FlightKey, fresh: FlightKey): KeyDrift {
  if (existing === fresh) {
    return 'none';
  }
  const a = parseFlightKey(existing);
  const b = parseFlightKey(fresh);
  const sameFlight =
    a.operatingCarrierIcao === b.operatingCarrierIcao &&
    a.flightNumber === b.flightNumber &&
    a.originIcao === b.originIcao &&
    a.legSeq === b.legSeq;
  return sameFlight ? 'date_shift' : 'different_flight';
}

export interface KeyReconciliation {
  /** Always `existing`: keys are immutable after creation. */
  key: FlightKey;
  /** What the status would canonicalise to today. */
  fresh: FlightKey;
  drift: KeyDrift;
}

/**
 * The immutability rule as a function. A tracker keeps the key it was created with no matter
 * what later statuses say (a 23:50 departure that slips to 00:10 stays on the original date);
 * the caller records `drift` so a `date_shift` becomes a schedule event and a
 * `different_flight` becomes a merge candidate (`flight_instance_merges`, `superseded_by_id`).
 */
export function reconcileFlightKey(existing: FlightKey, status: FlightStatus): KeyReconciliation {
  const fresh = canonicalizeFromProvider(status);
  return { key: existing, fresh, drift: classifyKeyDrift(existing, fresh) };
}

export const REGIONAL_OPERATOR_CONFIDENCES = ['published', 'observed', 'assumed'] as const;

export const RegionalOperatorRuleSchema = z
  .looseObject({
    marketingIata: z.string().regex(IATA_CARRIER_RE),
    from: z.int().min(1).max(9999),
    to: z.int().min(1).max(9999),
    operatingIcao: z.string().regex(ICAO_CARRIER_RE),
    /** `published`: a third-party page states the block. `observed`: inferred from dated records. `assumed`: a guess. */
    confidence: z.enum(REGIONAL_OPERATOR_CONFIDENCES),
    source: z.url(),
    asOf: z.iso.date(),
    note: z.string().optional(),
  })
  .refine((rule) => rule.from <= rule.to, { message: 'from must not exceed to', path: ['to'] });
export type RegionalOperatorRule = z.infer<typeof RegionalOperatorRuleSchema>;

export const RegionalOperatorSeedSchema = z.looseObject({
  asOf: z.iso.date(),
  rules: z.array(RegionalOperatorRuleSchema),
});

/**
 * HINT TABLE. Parsed and validated at module load from `data/regional-operators.seed.json`;
 * `packages/db` seeds `regional_operators` from OPTD and overrides it. See the `$comment` in
 * the JSON for what each confidence level means.
 */
export const REGIONAL_OPERATOR_SEED: readonly RegionalOperatorRule[] =
  RegionalOperatorSeedSchema.parse(seedJson).rules;

/**
 * Probable operating ICAO for a marketing designator, for lookup BEFORE canonicalisation only.
 * The DesignatorResolver uses it to check for an existing tracker before spending a provider
 * call; the provider answer wins. Rules are matched in order, first hit wins, and a marketing
 * reference without an IATA code or a malformed number yields `undefined` rather than an error.
 */
export function regionalOperatorHint(
  marketing: CarrierRef,
  number: string,
  table: readonly RegionalOperatorRule[],
): string | undefined {
  const iata = marketing.iata?.toUpperCase();
  if (iata === undefined) {
    return undefined;
  }
  let numeric: number;
  try {
    numeric = Number(normalizeFlightNumber(number).number);
  } catch {
    return undefined;
  }
  for (const rule of table) {
    if (rule.marketingIata === iata && numeric >= rule.from && numeric <= rule.to) {
      return rule.operatingIcao;
    }
  }
  return undefined;
}
