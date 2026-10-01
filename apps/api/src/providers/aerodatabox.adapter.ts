/**
 * AeroDataBox adapter, direct gateway (increment 6).
 *
 * Written against the vendored OpenAPI snapshot `specs/aerodatabox-direct-v1.15.3.yaml`
 * (version 1.15.3.0, SHA-256 pinned in test/unit/aerodatabox.adapter.test.ts). Every rule below
 * comes from that spec or from the facts sheet, section 1:
 *
 *   - Base `https://api.aerodatabox.com/`, auth header `X-Api-Key` (the direct gateway's own
 *     security scheme, not RapidAPI's header pair).
 *   - Flight status is `GET /flights/Number/{designator}/{dateLocal}?dateLocalRole=Departure`
 *     with the `searchBy` enum's own casing. `dateLocalRole=Departure` makes the date the
 *     ORIGIN-LOCAL DEPARTURE date, the date a flight key carries (the default `Both` also returns
 *     a flight that only ARRIVES that day, so an overnight flight's previous-day departure came
 *     back first). `withFlightPlan` is never set: it bills the call twice on Starter. Nor are
 *     `withAircraftImage` or `withLocation`; the defaults are false.
 *   - 200 is a JSON array, 204 is a miss. Both bill 2 units (TIER 2). A 204 is never parsed, and
 *     a 200 with an empty array is recorded as the same billed `not_found`.
 *   - 451 is legal suppression: terminal for that key, never retried.
 *   - 429 and 503 and any body that is not JSON (an unauthenticated or throttled request meets a
 *     Cloudflare HTML 403) are `rate_limited` at zero cost: the reservation is released and the
 *     token bucket backs off. The spec declares 503 (Service Unavailable, no body) but not 429,
 *     although per-second limits exist; both are treated alike.
 *   - A `fetch` that rejects keeps its reservation and is recorded billed
 *     (`transport_unknown_billing`, see `transportErrorRecord`): the request may have been served.
 *   - Other error statuses are recorded as billed `error`s until AeroDataBox says otherwise;
 *     over-counting in our own ledger is the safe direction for a budget.
 *   - Times come from `.utc` only (`parseAdbDateTime`); `revisedTime` is split into estimate or
 *     actual by the status enum (`disambiguateRevisedTime`); the status itself is derived from
 *     flags and OOOI times (`deriveStatus`), never mapped from the enum's name.
 *   - AeroDataBox never names an operator: `resolveOperator` picks the best-known operating
 *     designator (carrier AND number: a callsign supplies both) and the status records
 *     `operatorSource` (ADR 0010). There is no codeshare sibling list, so `codeshares` is always
 *     empty.
 *
 * Recording rule: the caller records `result.call`. The plus or minus one day retry makes up to
 * three HTTP calls for one lookup, and ONLY for a person-supplied date (`user_search`, `import`);
 * a tracker's own triggers make exactly one. Every attempt this method does not return is
 * recorded here, through `ctx.log`, so the ledger sees every billed call exactly once.
 */

import { z } from 'zod';
import {
  AdbStatusSchema,
  CARRIER_IATA_TO_ICAO_FALLBACK,
  CodeshareStatusSchema,
  FlightKeyError,
  IATA_AIRPORT_RE,
  ICAO_AIRPORT_RE,
  ICAO_CARRIER_RE,
  REGIONAL_OPERATOR_SEED,
  adbFlags,
  adbStatusUncertain,
  deriveStatus,
  disambiguateRevisedTime,
  flightNumberToken,
  isActualAt,
  isValidIsoDate,
  isValidTimeZone,
  normalizeFlightNumber,
  normalizeIcaoHex,
  parseAdbDateTime,
  parseDesignator,
  regionalOperatorHint,
  resolveCarrierIcao,
  resolveOperator,
  type AdbStatus,
  type AirportRef,
  type BoardRow,
  type BoardWindow,
  type CodeshareStatus,
  type CarrierIataToIcaoTable,
  type Exact,
  type FieldQuality,
  type FlightDataProvider,
  type FlightLookup,
  type FlightStatus,
  type FlightStatusValue,
  type FlightTimes,
  type ProviderCallContext,
  type ProviderCallRecord,
  type ProviderCapabilities,
  type ProviderEvent,
  type ProviderResult,
  type RegionalOperatorRule,
  type ResolvedOperator,
} from '@planeahead/shared';
import type { AdbPlan } from './config';
import {
  callRecord,
  deniedRecord,
  errorMessageOf,
  readBody,
  reserve,
  transportErrorRecord,
  type ProviderFetch,
  type ReadBody,
} from './http';

export const AERODATABOX_BASE_URL = 'https://api.aerodatabox.com/';

const DAY_MS = 86_400_000;

/** Wait after a push-back when the provider sends no `Retry-After`. */
export const ADB_DEFAULT_BACKOFF_MS = 1_000;

/** Triggers on which the date came from a person and may be a day off. */
const RETRY_ADJACENT_DAY_TRIGGERS: ReadonlySet<string> = new Set(['user_search', 'import']);

/** The flight-status query: the path date is the origin-local DEPARTURE date, nothing else. */
const FLIGHT_STATUS_QUERY = new URLSearchParams({ dateLocalRole: 'Departure' }).toString();

/**
 * R3 D2's one FIDS fetch shape. `withLocation` is not sent: its default is false, boards need no
 * position, and whether it bills extra is undocumented (R3 U3).
 */
const FIDS_QUERY = new URLSearchParams({
  direction: 'Both',
  withLeg: 'true',
  withCancelled: 'true',
  withCodeshared: 'true',
  withCargo: 'false',
  withPrivate: 'false',
}).toString();

// ---------------------------------------------------------------------------------------------
// Response schemas. Tolerant of fields the spec may add (a newer gateway must not break the
// adapter), strict on the fields the mapping reads.
// ---------------------------------------------------------------------------------------------

const NullableString = z.string().nullish();

const DateTimeSchema = z.looseObject({ utc: NullableString, local: NullableString });

const ListingAirportSchema = z.looseObject({
  icao: NullableString,
  iata: NullableString,
  name: NullableString,
  timeZone: NullableString,
});

const MovementSchema = z.looseObject({
  airport: ListingAirportSchema,
  scheduledTime: DateTimeSchema.nullish(),
  revisedTime: DateTimeSchema.nullish(),
  runwayTime: DateTimeSchema.nullish(),
  terminal: NullableString,
  gate: NullableString,
  baggageBelt: NullableString,
  quality: z.array(z.string()).nullish(),
});
type AdbMovementContract = z.infer<typeof MovementSchema>;

const AircraftSchema = z.looseObject({
  reg: NullableString,
  modeS: NullableString,
  model: NullableString,
});

const AirlineSchema = z.looseObject({
  name: NullableString,
  iata: NullableString,
  icao: NullableString,
});

export const AdbFlightSchema = z.looseObject({
  number: z.string().min(1),
  callSign: NullableString,
  status: AdbStatusSchema,
  codeshareStatus: CodeshareStatusSchema,
  isCargo: z.boolean().nullish(),
  lastUpdatedUtc: NullableString,
  departure: MovementSchema,
  arrival: MovementSchema,
  greatCircleDistance: z.looseObject({ km: z.number().nonnegative() }).nullish(),
  aircraft: AircraftSchema.nullish(),
  airline: AirlineSchema.nullish(),
});
export type AdbFlightContract = z.infer<typeof AdbFlightSchema>;

/**
 * A `withLeg=true` leg. The spec marks `airport` required, but `AirportFlightContract` says the
 * leg at the requested airport leaves it unset, so it is optional here and the home airport is
 * the one the call asked about.
 */
const LegSchema = MovementSchema.extend({ airport: ListingAirportSchema.nullish() });
type AdbLegContract = z.infer<typeof LegSchema>;

/**
 * `AirportFlightContract`: `departure` and `arrival` with `withLeg=true`, else `movement` (the
 * home leg, whose `airport` is the opposite one). Both shapes are read, so a gateway that ignores
 * `withLeg` still yields rows, without the counterpart leg's times.
 */
const AirportFlightSchema = z.looseObject({
  number: z.string().min(1),
  callSign: NullableString,
  status: AdbStatusSchema,
  codeshareStatus: CodeshareStatusSchema,
  movement: MovementSchema.nullish(),
  departure: LegSchema.nullish(),
  arrival: LegSchema.nullish(),
  aircraft: AircraftSchema.nullish(),
  airline: AirlineSchema.nullish(),
});

const FidsSchema = z.looseObject({
  departures: z.array(z.unknown()).nullish(),
  arrivals: z.array(z.unknown()).nullish(),
});

const AirportContractSchema = z.looseObject({
  icao: NullableString,
  iata: NullableString,
  timeZone: z.string().min(1),
});

/**
 * `FeedServiceStatusContract`. The status is any string, not the spec's enum: a value AeroDataBox
 * adds later must not fail the whole check, and `coverageOf` reads it as indeterminate (R5).
 */
const FeedStatusSchema = z.looseObject({ service: z.string(), status: z.string() });
const AirportFeedsSchema = z.looseObject({
  flightSchedulesFeed: FeedStatusSchema,
  liveFlightUpdatesFeed: FeedStatusSchema,
  adsbUpdatesFeed: FeedStatusSchema,
});

/** `FlightNotificationContract` (webhook delivery), strict on everything routing needs. */
const NotificationItemSchema = z.looseObject({
  number: z.string().min(1).max(16),
  status: AdbStatusSchema,
  codeshareStatus: CodeshareStatusSchema,
  isCargo: z.boolean(),
  lastUpdatedUtc: z.string().min(1).max(40),
  departure: MovementSchema,
  arrival: MovementSchema,
});
export const AdbNotificationSchema = z.looseObject({
  id: z.uuid(),
  timestampUtc: z.string().min(1).max(40),
  subscription: z.looseObject({ id: z.uuid(), isActive: z.boolean() }),
  deliveryAttempt: z.looseObject({ seqNo: z.int(), costCredits: z.int() }),
  flights: z.array(NotificationItemSchema).min(1).max(200),
});

// ---------------------------------------------------------------------------------------------
// Mapping.
// ---------------------------------------------------------------------------------------------

export interface AdbMappingContext {
  readonly now: Date;
  readonly carriers: CarrierIataToIcaoTable;
  readonly regionalRules: readonly RegionalOperatorRule[];
}

export class AdbMappingError extends Error {
  override readonly name = 'AdbMappingError';
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** An `AirportRef` from a listing airport, or null when it has no usable ICAO code. */
export function adbAirportRef(airport: z.infer<typeof ListingAirportSchema>): AirportRef | null {
  const icao = clean(airport.icao)?.toUpperCase();
  if (icao === undefined || !ICAO_AIRPORT_RE.test(icao) || icao.startsWith('ZZ')) {
    return null;
  }
  const ref: AirportRef = { icao };
  const iata = clean(airport.iata)?.toUpperCase();
  if (iata !== undefined && IATA_AIRPORT_RE.test(iata)) {
    ref.iata = iata;
  }
  const tz = clean(airport.timeZone);
  if (tz !== undefined && isValidTimeZone(tz)) {
    ref.tz = tz;
  }
  return ref;
}

interface ParsedNumber {
  readonly carrierCode: string;
  readonly number: string;
  readonly compact: string;
  readonly marketingIcao: string | undefined;
  readonly marketingIata: string | undefined;
}

function parseAdbNumber(
  value: string,
  airline: z.infer<typeof AirlineSchema> | null | undefined,
  carriers: CarrierIataToIcaoTable,
): ParsedNumber {
  const designator = parseDesignator(value);
  const number = flightNumberToken(
    designator.suffix === undefined
      ? { number: designator.number }
      : { number: designator.number, suffix: designator.suffix },
  );
  const airlineIcao = clean(airline?.icao)?.toUpperCase();
  const airlineIata = clean(airline?.iata)?.toUpperCase();
  const marketingIcao =
    airlineIcao !== undefined && ICAO_CARRIER_RE.test(airlineIcao)
      ? airlineIcao
      : resolveCarrierIcao(designator.carrier, carriers);
  const carrierCode = designator.carrier.iata ?? designator.carrier.icao ?? '';
  return {
    carrierCode,
    number,
    compact: `${carrierCode}${number}`,
    marketingIcao,
    marketingIata: designator.carrier.iata ?? airlineIata,
  };
}

/**
 * The operating designator of one AeroDataBox item: `resolveOperator` with the regional hint
 * looked up for the marketing designator. One helper for flights and board rows, so a board row
 * and the tracker it should match resolve the same way.
 */
function operatorOf(
  parsed: ParsedNumber & { readonly marketingIcao: string },
  codeshareStatus: CodeshareStatus,
  callSign: string | null | undefined,
  regionalRules: readonly RegionalOperatorRule[],
): ResolvedOperator {
  const hint =
    parsed.marketingIata === undefined
      ? undefined
      : regionalOperatorHint({ iata: parsed.marketingIata }, parsed.number, regionalRules);
  return resolveOperator({
    marketingIcao: parsed.marketingIcao,
    marketingNumber: parsed.number,
    codeshareStatus,
    callSign,
    hint,
  });
}

function hasLiveQuality(movement: AdbMovementContract): boolean {
  return (movement.quality ?? []).some((quality) => quality === 'Live');
}

/**
 * One `FlightContract` as a `FlightStatus`. Throws `AdbMappingError` when the contract cannot
 * name a flight we can key (no marketing carrier ICAO, no origin or destination ICAO, no
 * scheduled departure); the caller skips that item.
 */
export function mapAdbFlight(
  flight: AdbFlightContract,
  ctx: AdbMappingContext,
): Exact<FlightStatus> {
  let parsed: ParsedNumber;
  try {
    parsed = parseAdbNumber(flight.number, flight.airline, ctx.carriers);
  } catch (error) {
    if (error instanceof FlightKeyError) {
      throw new AdbMappingError(`unparseable flight number "${flight.number}"`);
    }
    throw error;
  }
  const marketingIcao = parsed.marketingIcao;
  if (marketingIcao === undefined) {
    throw new AdbMappingError(`no ICAO code for the carrier of ${parsed.compact}`);
  }
  const origin = adbAirportRef(flight.departure.airport);
  const destination = adbAirportRef(flight.arrival.airport);
  if (origin === null || destination === null) {
    throw new AdbMappingError(`${parsed.compact} has no ICAO origin or destination`);
  }
  const scheduledOut = parseAdbDateTime(flight.departure.scheduledTime);
  if (scheduledOut === null) {
    throw new AdbMappingError(`${parsed.compact} has no scheduled departure`);
  }
  const scheduledIn = parseAdbDateTime(flight.arrival.scheduledTime);

  const status: AdbStatus = flight.status;
  const times: Exact<FlightTimes> = { scheduledOut: scheduledOut.instant };
  const fieldQuality: Record<string, FieldQuality> = { scheduledOut: 'schedule' };
  if (scheduledIn !== null) {
    times.scheduledIn = scheduledIn.instant;
    fieldQuality['scheduledIn'] = 'schedule';
  }

  let departureDelaySec: number | undefined;
  let arrivalDelaySec: number | undefined;
  const revisions = [
    { movement: 'departure', kind: 'gate', contract: flight.departure.revisedTime },
    { movement: 'departure', kind: 'runway', contract: flight.departure.runwayTime },
    { movement: 'arrival', kind: 'gate', contract: flight.arrival.revisedTime },
    { movement: 'arrival', kind: 'runway', contract: flight.arrival.runwayTime },
  ] as const;
  for (const revision of revisions) {
    const parsedTime = parseAdbDateTime(revision.contract);
    const scheduled = revision.movement === 'departure' ? scheduledOut : scheduledIn;
    const result = disambiguateRevisedTime(
      status,
      parsedTime?.instant,
      scheduled?.instant,
      revision.movement,
      revision.kind,
    );
    if (result === null) {
      continue;
    }
    times[result.field] = result.value;
    fieldQuality[result.field] = result.quality;
    if (revision.kind === 'gate') {
      if (revision.movement === 'departure') {
        departureDelaySec = result.delaySec;
      } else {
        arrivalDelaySec = result.delaySec;
      }
    }
  }

  const operator = operatorOf(
    { ...parsed, marketingIcao },
    flight.codeshareStatus,
    flight.callSign,
    ctx.regionalRules,
  );

  const flags = adbFlags(status);
  const derived = deriveStatus({
    ...flags,
    actualOut: times.actualOut,
    actualOff: times.actualOff,
    actualOn: times.actualOn,
    actualIn: times.actualIn,
    scheduledOut: times.scheduledOut,
    estimatedOut: times.estimatedOut,
    now: ctx.now,
  });

  const localDate = scheduledOut.localDate;
  const result: Exact<FlightStatus> = {
    operatingCarrierIcao: operator.operatingCarrierIcao,
    operatorSource: operator.operatorSource,
    marketingCarrierIcao: marketingIcao,
    marketingFlightNumber: parsed.number,
    // The operating number: a codeshare resolved by its callsign keys under the callsign's own
    // number (BA 1512 flown as AAL100 is AAL-100-...), never under the marketing one.
    flightNumber: operator.operatingFlightNumber,
    legSeq: 1,
    codeshares: [],
    origin,
    destination,
    status: derived,
    times,
    providerRefs: {
      aerodatabox: localDate === undefined ? parsed.compact : `${parsed.compact}/${localDate}`,
    },
    fetchedAt: ctx.now.toISOString(),
    source: 'aerodatabox',
    fieldQuality,
  };
  if (localDate !== undefined) {
    result.scheduledDepartureDateLocal = localDate;
  }
  if (adbStatusUncertain(status)) {
    // `CanceledUncertain` and `Unknown` carry no flag of their own: the derived status stays
    // operating, and the marker makes the answer inconclusive to the notification policy
    // (review ruling Q11), so it never clears a suspected cancellation.
    result.statusUncertain = true;
  }
  if (departureDelaySec !== undefined) {
    result.departureDelaySec = departureDelaySec;
  }
  if (arrivalDelaySec !== undefined) {
    result.arrivalDelaySec = arrivalDelaySec;
  }
  const originTerminal = clean(flight.departure.terminal);
  const originGate = clean(flight.departure.gate);
  const destinationTerminal = clean(flight.arrival.terminal);
  const destinationGate = clean(flight.arrival.gate);
  const baggageClaim = clean(flight.arrival.baggageBelt);
  if (originTerminal !== undefined) {
    result.originTerminal = originTerminal;
  }
  if (originGate !== undefined) {
    result.originGate = originGate;
  }
  if (destinationTerminal !== undefined) {
    result.destinationTerminal = destinationTerminal;
  }
  if (destinationGate !== undefined) {
    result.destinationGate = destinationGate;
  }
  if (originGate !== undefined || destinationGate !== undefined) {
    const live =
      (originGate !== undefined && hasLiveQuality(flight.departure)) ||
      (destinationGate !== undefined && hasLiveQuality(flight.arrival));
    fieldQuality['gate'] = live ? 'live' : 'schedule';
  }
  if (baggageClaim !== undefined) {
    result.baggageClaim = baggageClaim;
    fieldQuality['baggage'] = hasLiveQuality(flight.arrival) ? 'live' : 'schedule';
  }
  const registration = clean(flight.aircraft?.reg);
  if (registration !== undefined) {
    result.registration = registration.toUpperCase();
  }
  const icaoHex = normalizeIcaoHex(flight.aircraft?.modeS ?? '');
  if (icaoHex !== undefined) {
    result.icaoHex = icaoHex;
  }
  const km = flight.greatCircleDistance?.km;
  if (km !== undefined) {
    result.routeDistanceKm = km;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Webhook parsing (behind ADB_ALERTS_ENABLED).
// ---------------------------------------------------------------------------------------------

export class WebhookPayloadError extends Error {
  override readonly name = 'WebhookPayloadError';
}

/**
 * Validates an AeroDataBox `FlightNotificationContract` and turns each flight item into a
 * `ProviderEvent`. The subscription carries no secret and no HMAC, so the body is a HINT: the
 * payload keeps only what routes it, and the tracker re-reads the flight rather than trusting
 * the delivery. `externalId` is the notification id plus the item index; AeroDataBox keeps the
 * id across delivery retries, so a retried delivery dedupes.
 *
 * The delivery's own billing travels too, so the ledger records the provider's number instead of
 * assuming one credit per item: every event carries `deliverySeqNo` and `deliveryItemCount`, and
 * the FIRST event of a notification alone carries `deliveryCostCredits` (the whole delivery's
 * cost, counted once however many items it held).
 */
export function parseAdbNotification(body: unknown, receivedAt: Date): Exact<ProviderEvent>[] {
  const parsed = AdbNotificationSchema.safeParse(body);
  if (!parsed.success) {
    throw new WebhookPayloadError('not an AeroDataBox FlightNotificationContract');
  }
  const notification = parsed.data;
  const events: Exact<ProviderEvent>[] = [];
  for (const [index, item] of notification.flights.entries()) {
    const departure = parseAdbDateTime(item.departure.scheduledTime);
    const dateLocal = departure?.localDate;
    let designator: string;
    try {
      const parsedDesignator = parseDesignator(item.number);
      designator = `${parsedDesignator.carrier.iata ?? parsedDesignator.carrier.icao ?? ''}${
        parsedDesignator.number
      }${parsedDesignator.suffix ?? ''}`;
    } catch {
      continue;
    }
    if (dateLocal === undefined || !isValidIsoDate(dateLocal)) {
      continue;
    }
    events.push({
      provider: 'aerodatabox',
      externalId: `${notification.id}:${String(index)}`,
      receivedAt: receivedAt.toISOString(),
      kind: 'update',
      flightRef: { designator, dateLocal },
      payload: {
        hint: 'reread',
        notificationId: notification.id,
        subscriptionId: notification.subscription.id,
        lastUpdatedUtc: item.lastUpdatedUtc,
        deliverySeqNo: notification.deliveryAttempt.seqNo,
        deliveryItemCount: notification.flights.length,
        ...(events.length === 0
          ? { deliveryCostCredits: notification.deliveryAttempt.costCredits }
          : {}),
      },
    });
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// The adapter.
// ---------------------------------------------------------------------------------------------

export interface AeroDataBoxAdapterOptions {
  readonly apiKey: string;
  readonly fetch: ProviderFetch;
  readonly plan: AdbPlan;
  /** `ADB_ALERTS_ENABLED`; `parseWebhook` refuses every body while this is false. */
  readonly alertsEnabled?: boolean | undefined;
  readonly baseUrl?: string | undefined;
  /** IATA to ICAO for marketing carriers; defaults to the shared fallback table. */
  readonly carriers?: CarrierIataToIcaoTable | undefined;
  /** Regional operator hints; defaults to the shared seed. */
  readonly regionalRules?: readonly RegionalOperatorRule[] | undefined;
  /** Clock for `parseWebhook` only; every call reads `ctx.now`. */
  readonly now: () => Date;
}

/**
 * Result of an AeroDataBox health check for one airport: each feed's `FeedServiceStatus` as
 * sent (Down, Degraded, OKPartial, OK, Unknown or Unavailable). What the statuses mean for a
 * board is `coverageOf` in the AirportState object (ruling R5), the one reader.
 */
export interface AdbCoverage {
  readonly airportIcao: string;
  readonly schedules: string;
  readonly live: string;
  readonly adsb: string;
}

interface Attempt {
  readonly call: ProviderCallRecord;
  readonly body: ReadBody | null;
  /** True when the caller must not retry this lookup (451, a refusal, a push-back). */
  readonly terminal: boolean;
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get('retry-after');
  if (header === null) {
    return ADB_DEFAULT_BACKOFF_MS;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(60_000, Math.ceil(seconds * 1_000));
  }
  return ADB_DEFAULT_BACKOFF_MS;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export class AeroDataBoxAdapter implements FlightDataProvider {
  readonly id = 'aerodatabox' as const;
  readonly capabilities: ProviderCapabilities;
  readonly #options: AeroDataBoxAdapterOptions;
  readonly #baseUrl: string;

  constructor(options: AeroDataBoxAdapterOptions) {
    this.#options = options;
    this.#baseUrl = options.baseUrl ?? AERODATABOX_BASE_URL;
    this.capabilities = {
      alerts: options.alertsEnabled === true,
      // Which changes trigger an AeroDataBox alert is undocumented; measured once a key exists.
      alertFields: ['unknown'],
      boards: true,
      maxDaysAhead: options.plan.maxDaysAhead,
      fidsWindowHours: options.plan.fidsWindowHours,
      inboundLink: false,
    };
  }

  #mappingContext(now: Date): AdbMappingContext {
    return {
      now,
      carriers: this.#options.carriers ?? CARRIER_IATA_TO_ICAO_FALLBACK,
      regionalRules: this.#options.regionalRules ?? REGIONAL_OPERATOR_SEED,
    };
  }

  /**
   * One budgeted HTTP attempt: build the request, reserve, fetch, classify, record. Push-backs
   * release the reservation and back the bucket off; nothing here retries. The request is built
   * BEFORE the reservation, so a failure that provably never left the Worker holds no budget,
   * and a rejected `fetch` (which may have been served) keeps it.
   */
  async #attempt(
    ctx: ProviderCallContext,
    operation: 'flight_status' | 'fids' | 'airport' | 'health',
    path: string,
  ): Promise<Attempt> {
    const outgoing = new Request(new URL(path, this.#baseUrl), {
      method: 'GET',
      headers: { 'X-Api-Key': this.#options.apiKey, Accept: 'application/json' },
    });
    const { request, decision } = await reserve(ctx, this.id, operation);
    if (!decision.allowed) {
      return {
        call: deniedRecord(ctx, this.id, operation, decision.reason),
        body: null,
        terminal: true,
      };
    }
    const startedAt = ctx.now();
    let response: Response;
    try {
      response = await this.#options.fetch(outgoing);
    } catch (error) {
      return {
        call: transportErrorRecord(ctx, this.id, operation, startedAt, error),
        body: null,
        terminal: true,
      };
    }
    const body = await readBody(response);
    const finishedAt = ctx.now();
    const base = {
      ctx,
      provider: this.id,
      operation,
      startedAt,
      finishedAt,
      httpStatus: response.status,
      responseBytes: body.bytes,
    } as const;

    const pushedBack =
      response.status === 429 || response.status === 503 || body.kind === 'non_json';
    if (pushedBack) {
      await ctx.budget.release?.(request, request.pollEquivalents);
      await ctx.budget.backoff?.(this.id, retryAfterMs(response));
      return {
        call: callRecord({
          ...base,
          result: 'rate_limited',
          billed: false,
          error: `http_${String(response.status)}${body.kind === 'non_json' ? ':non_json' : ''}`,
        }),
        body,
        terminal: true,
      };
    }
    if (response.status === 200) {
      return { call: callRecord({ ...base, result: 'ok', billed: true }), body, terminal: false };
    }
    if (response.status === 204) {
      return {
        call: callRecord({ ...base, result: 'not_found', billed: true }),
        body,
        terminal: false,
      };
    }
    const message = errorMessageOf(body);
    const error =
      response.status === 451
        ? `legal_suppression${message === undefined ? '' : `:${message}`}`
        : `http_${String(response.status)}${message === undefined ? '' : `:${message}`}`;
    return {
      call: callRecord({ ...base, result: 'error', billed: true, error }),
      body,
      terminal: true,
    };
  }

  /**
   * Flight status by marketing designator and ORIGIN-LOCAL DEPARTURE date
   * (`dateLocalRole=Departure`: the date in the path is the date the flight key carries, so a
   * tracker's lookup never gets back the neighbouring day's overnight departure). Returns every
   * flight the gateway answers with, mapped; an item that cannot be keyed is skipped and named in
   * the record's `error`.
   *
   * The plus or minus one day retry runs ONLY for a person-supplied date (`user_search` and
   * `import`), where the day may be off by one: up to three billed calls. A tracker's own triggers
   * (`alarm`, `reconcile`, `user_refresh`, `provider_alert`) make exactly one call per lookup,
   * because the key's date is canonical and a neighbouring day's flight is a different instance.
   */
  async getFlight(
    lookup: FlightLookup,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<Exact<FlightStatus>[]>> {
    const carrierCode = lookup.carrier.iata ?? lookup.carrier.icao;
    if (carrierCode === undefined) {
      throw new FlightKeyError('invalid_carrier', 'a lookup needs an IATA or ICAO carrier code');
    }
    const designator = `${carrierCode}${flightNumberToken(normalizeFlightNumber(lookup.flightNumber))}`;
    const dates = RETRY_ADJACENT_DAY_TRIGGERS.has(ctx.trigger)
      ? [lookup.dateLocal, shiftDate(lookup.dateLocal, -1), shiftDate(lookup.dateLocal, 1)]
      : [lookup.dateLocal];

    const attempts: Attempt[] = [];
    for (const date of dates) {
      if (this.#beyondLookahead(date, ctx.now())) {
        if (attempts.length === 0) {
          const at = ctx.now();
          return {
            data: [],
            call: callRecord({
              ctx,
              provider: this.id,
              operation: 'flight_status',
              startedAt: at,
              finishedAt: at,
              result: 'error',
              billed: false,
              error: `beyond_max_days_ahead:${String(this.capabilities.maxDaysAhead)}`,
            }),
          };
        }
        continue;
      }
      const attempt = await this.#attempt(
        ctx,
        'flight_status',
        `flights/Number/${encodeURIComponent(designator)}/${date}?${FLIGHT_STATUS_QUERY}`,
      );
      if (attempt.terminal) {
        attempts.push(attempt);
        break;
      }
      const flights = this.#flightsFrom(attempt, ctx);
      if (flights !== null) {
        attempts.push(attempt);
        await this.#recordAllBut(attempts, ctx);
        return flights;
      }
      // A miss: a 204, or a 200 whose array is empty, which is the same billed `not_found`.
      attempts.push({ ...attempt, call: { ...attempt.call, result: 'not_found' } });
    }
    const last = attempts.at(-1);
    if (last === undefined) {
      throw new Error('unreachable: no attempt was made');
    }
    await this.#recordAllBut(attempts, ctx);
    return { data: [], call: last.call };
  }

  /** Records every attempt except the last, which the caller records from the result. */
  async #recordAllBut(attempts: readonly Attempt[], ctx: ProviderCallContext): Promise<void> {
    for (const attempt of attempts.slice(0, -1)) {
      await ctx.log.record(attempt.call);
    }
  }

  #beyondLookahead(date: string, now: Date): boolean {
    const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
    const target = Date.parse(`${date}T00:00:00Z`);
    return (target - today) / DAY_MS > this.capabilities.maxDaysAhead;
  }

  /** The mapped result of a 200, or null for a miss (a 204 or an empty array). */
  #flightsFrom(
    attempt: Attempt,
    ctx: ProviderCallContext,
  ): ProviderResult<Exact<FlightStatus>[]> | null {
    const body = attempt.body;
    if (attempt.call.result === 'not_found' || body === null || body.kind === 'empty') {
      return null;
    }
    if (body.kind !== 'json' || !Array.isArray(body.value)) {
      return { data: [], call: { ...attempt.call, result: 'error', error: 'not_a_flight_array' } };
    }
    if (body.value.length === 0) {
      return null;
    }
    const mapping = this.#mappingContext(ctx.now());
    const data: Exact<FlightStatus>[] = [];
    const skipped: string[] = [];
    for (const item of body.value) {
      const parsed = AdbFlightSchema.safeParse(item);
      if (!parsed.success) {
        skipped.push('invalid_contract');
        continue;
      }
      try {
        data.push(mapAdbFlight(parsed.data, mapping));
      } catch (error) {
        if (!(error instanceof AdbMappingError)) {
          throw error;
        }
        skipped.push(error.message);
      }
    }
    if (skipped.length === 0) {
      return { data, call: attempt.call };
    }
    const call: ProviderCallRecord = {
      ...attempt.call,
      error: `skipped ${String(skipped.length)}: ${skipped.join('; ')}`.slice(0, 200),
    };
    if (data.length === 0) {
      call.result = 'error';
    }
    return { data, call };
  }

  /**
   * One FIDS call (TIER 2, 2 units) for an airport and an airport-local window, in R3 D2's one
   * fetch shape (`FIDS_QUERY`): both directions, both legs, codeshares and cancellations, no
   * cargo, no private flights, no position. `window.from` and `window.to` are sent as they are
   * (FIDS asks in local time); a window wider than the plan allows is cut to `fidsWindowHours`.
   * FIDS returns flights "scheduled, planned or commenced" within the range; the spec does not say
   * whether the scheduled or the revised time decides membership (R3 F9; unverified, R3 U1).
   * An item that cannot be keyed is skipped and counted on the record's `error`; a 200 whose
   * items were all skipped is an `error` (`fidsAllSkipped`: the board cache still stores it,
   * empty). A 204 is the billed `not_found` of an empty window.
   */
  async getAirportBoard(
    airportIcao: string,
    window: BoardWindow,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<Exact<BoardRow>[]>> {
    const icao = airportIcao.trim().toUpperCase();
    if (!ICAO_AIRPORT_RE.test(icao)) {
      throw new RangeError(`"${airportIcao}" is not an ICAO airport code`);
    }
    const from = localMinute(window.from);
    const to = localMinute(window.to);
    if (from === null || to === null || to <= from) {
      throw new RangeError('a board window needs two local times YYYY-MM-DDTHH:mm, from < to');
    }
    const cappedTo = Math.min(to, from + this.capabilities.fidsWindowHours * 3_600_000);
    const attempt = await this.#attempt(
      ctx,
      'fids',
      `flights/airports/Icao/${icao}/${formatLocalMinute(from)}/${formatLocalMinute(cappedTo)}?${FIDS_QUERY}`,
    );
    const body = attempt.body;
    if (attempt.call.result !== 'ok' || body?.kind !== 'json') {
      return { data: [], call: attempt.call };
    }
    const fids = FidsSchema.safeParse(body.value);
    if (!fids.success) {
      return { data: [], call: { ...attempt.call, result: 'error', error: 'not_a_fids_contract' } };
    }
    const mapping = this.#mappingContext(ctx.now());
    const rows: Exact<BoardRow>[] = [];
    const skipped = new Map<BoardSkip, number>();
    const sides = [
      ['dep', fids.data.departures ?? []],
      ['arr', fids.data.arrivals ?? []],
    ] as const;
    for (const [direction, items] of sides) {
      for (const item of items) {
        const mapped = fidsBoardRow(item, direction, mapping);
        if (typeof mapped === 'string') {
          skipped.set(mapped, (skipped.get(mapped) ?? 0) + 1);
        } else {
          rows.push(mapped);
        }
      }
    }
    return { data: rows, call: withSkipped(attempt.call, skipped, rows.length) };
  }

  /** Airport by ICAO code (TIER 1, 1 unit): the reference and its time zone. */
  async getAirport(
    airportIcao: string,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<AirportRef | null>> {
    const icao = airportIcao.trim().toUpperCase();
    const attempt = await this.#attempt(
      ctx,
      'airport',
      `airports/Icao/${encodeURIComponent(icao)}`,
    );
    const body = attempt.body;
    if (attempt.call.result !== 'ok' || body?.kind !== 'json') {
      return { data: null, call: attempt.call };
    }
    const parsed = AirportContractSchema.safeParse(body.value);
    const ref = parsed.success
      ? adbAirportRef({
          icao: parsed.data.icao,
          iata: parsed.data.iata,
          timeZone: parsed.data.timeZone,
        })
      : null;
    return ref === null
      ? { data: null, call: { ...attempt.call, result: 'error', error: 'not_an_airport_contract' } }
      : { data: ref, call: attempt.call };
  }

  /**
   * FREE TIER health check for one airport's data feeds: the AirportState object asks it once a
   * day whether a board can be fetched (R3 D6). Each status is passed on as sent; one outside
   * the enum is not a failed check, so the object reads it as indeterminate (ruling R5).
   */
  async checkCoverage(
    airportIcao: string,
    ctx: ProviderCallContext,
  ): Promise<ProviderResult<AdbCoverage | null>> {
    const icao = airportIcao.trim().toUpperCase();
    const attempt = await this.#attempt(
      ctx,
      'health',
      `health/services/airports/${encodeURIComponent(icao)}/feeds`,
    );
    const body = attempt.body;
    if (attempt.call.result !== 'ok' || body?.kind !== 'json') {
      return { data: null, call: attempt.call };
    }
    const parsed = AirportFeedsSchema.safeParse(body.value);
    if (!parsed.success) {
      return { data: null, call: { ...attempt.call, result: 'error', error: 'not_a_feed_status' } };
    }
    return {
      data: {
        airportIcao: icao,
        schedules: parsed.data.flightSchedulesFeed.status,
        live: parsed.data.liveFlightUpdatesFeed.status,
        adsb: parsed.data.adsbUpdatesFeed.status,
      },
      call: attempt.call,
    };
  }

  /** Parses a webhook delivery. Refuses everything while AeroDataBox alerts are disabled. */
  async parseWebhook(raw: Request): Promise<Exact<ProviderEvent>[]> {
    if (this.#options.alertsEnabled !== true) {
      throw new WebhookPayloadError('AeroDataBox alerts are disabled (ADB_ALERTS_ENABLED)');
    }
    let body: unknown;
    try {
      body = JSON.parse(await raw.text()) as unknown;
    } catch {
      throw new WebhookPayloadError('body is not JSON');
    }
    return parseAdbNotification(body, this.#options.now());
  }
}

// ---------------------------------------------------------------------------------------------
// Boards.
// ---------------------------------------------------------------------------------------------

const LOCAL_MINUTE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$/;

/** `YYYY-MM-DDTHH:mm` as a wall-clock millisecond count (the zone is the airport's). */
function localMinute(value: string): number | null {
  const match = LOCAL_MINUTE_RE.exec(value);
  if (match === null) {
    return null;
  }
  const [, y, mo, d, h, mi] = match;
  const date = `${y ?? ''}-${mo ?? ''}-${d ?? ''}`;
  if (!isValidIsoDate(date) || Number(h) > 23 || Number(mi) > 59) {
    return null;
  }
  return Date.parse(`${date}T${h ?? '00'}:${mi ?? '00'}:00Z`);
}

function formatLocalMinute(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/** Why a FIDS item yields no row. Counted on the call record, never silently dropped. */
type BoardSkip =
  | 'invalid_contract'
  | 'no_home_leg'
  | 'no_counterpart_icao'
  | 'no_scheduled_time'
  | 'unparseable_number';

/** How a FIDS record's `error` starts when items were skipped. */
const FIDS_SKIPPED_PREFIX = 'skipped ';

/** The record with its skipped items counted (`skipped 3: no_counterpart_icao x2; ...`). */
function withSkipped(
  call: ProviderCallRecord,
  skipped: ReadonlyMap<BoardSkip, number>,
  kept: number,
): ProviderCallRecord {
  if (skipped.size === 0) {
    return call;
  }
  let total = 0;
  const parts: string[] = [];
  for (const [reason, count] of skipped) {
    total += count;
    parts.push(`${reason} x${String(count)}`);
  }
  const error = `${FIDS_SKIPPED_PREFIX}${String(total)}: ${parts.join('; ')}`.slice(0, 200);
  return kept === 0 ? { ...call, result: 'error', error } : { ...call, error };
}

/**
 * Whether a FIDS record is a billed 200 whose every item was skipped: an answer that maps to no
 * row. The record stays an `error`, and the board cache stores it as an empty bucket that waits
 * out the ladder like any other (increment 18, ruling R6) instead of re-billing it every minute.
 */
export function fidsAllSkipped(call: ProviderCallRecord): boolean {
  return (
    call.operation === 'fids' &&
    call.result === 'error' &&
    call.httpStatus === 200 &&
    call.error?.startsWith(FIDS_SKIPPED_PREFIX) === true
  );
}

interface LegTimes {
  readonly scheduled: ReturnType<typeof parseAdbDateTime>;
  readonly estimated: string | undefined;
  readonly actual: string | undefined;
  /** An actual runway time (off or on), read only for the status. */
  readonly runwayActual: string | undefined;
}

/** One leg's times, its revised gate and runway times split by the status enum. */
function legTimes(
  leg: AdbLegContract | null | undefined,
  movement: 'departure' | 'arrival',
  status: AdbStatus,
): LegTimes {
  const scheduled = leg == null ? null : parseAdbDateTime(leg.scheduledTime);
  const revise = (contract: AdbLegContract['revisedTime'], kind: 'gate' | 'runway') =>
    disambiguateRevisedTime(
      status,
      parseAdbDateTime(contract)?.instant,
      scheduled?.instant,
      movement,
      kind,
    );
  const gate = leg == null ? null : revise(leg.revisedTime, 'gate');
  const runway = leg == null ? null : revise(leg.runwayTime, 'runway');
  return {
    scheduled,
    estimated: gate?.quality === 'estimated' ? gate.value : undefined,
    actual: gate?.quality === 'live' ? gate.value : undefined,
    runwayActual: runway?.quality === 'live' ? runway.value : undefined,
  };
}

/**
 * A board row's status from both legs, as `mapAdbFlight` derives a flight's: flags, then the
 * furthest actual, then boarding or scheduled. When no actual says so but the status enum says
 * the aircraft has left the origin (`isActualAt('departure')`, the disambiguation the revised
 * times use, never a mapping of the enum's name), the row is `en_route`. An arrival without a
 * departure leg (a gateway that ignored `withLeg`) is `scheduled` until then.
 */
function boardStatus(
  status: AdbStatus,
  departure: LegTimes,
  arrival: LegTimes,
  now: Date,
): FlightStatusValue {
  const derived = deriveStatus({
    ...adbFlags(status),
    actualOut: departure.actual,
    actualOff: departure.runwayActual,
    actualOn: arrival.runwayActual,
    actualIn: arrival.actual,
    scheduledOut: departure.scheduled?.instant,
    estimatedOut: departure.estimated,
    now,
  });
  if (derived !== 'scheduled' && derived !== 'boarding' && derived !== 'unknown') {
    return derived;
  }
  if (isActualAt('departure', status)) {
    return 'en_route';
  }
  return derived === 'unknown' && departure.scheduled === null ? 'scheduled' : derived;
}

/** The home leg, the counterpart leg and the counterpart airport of one FIDS item. */
function boardLegs(
  flight: z.infer<typeof AirportFlightSchema>,
  direction: 'dep' | 'arr',
): { home: AdbLegContract; far: AdbLegContract | null; counterpart: AirportRef | null } | null {
  if (flight.departure != null || flight.arrival != null) {
    const home = direction === 'dep' ? flight.departure : flight.arrival;
    const far = (direction === 'dep' ? flight.arrival : flight.departure) ?? null;
    if (home == null) {
      return null;
    }
    return { home, far, counterpart: far?.airport == null ? null : adbAirportRef(far.airport) };
  }
  const movement = flight.movement;
  return movement == null
    ? null
    : { home: movement, far: null, counterpart: adbAirportRef(movement.airport) };
}

/** Sets `row[key]` only when `value` is defined (`exactOptionalPropertyTypes`). */
function put<K extends keyof Exact<BoardRow>>(
  row: Exact<BoardRow>,
  key: K,
  value: Exact<BoardRow>[K] | undefined,
): void {
  if (value !== undefined) {
    row[key] = value;
  }
}

/**
 * One FIDS item as a `BoardRow`, or the reason it was skipped. The operator is resolved as
 * `mapAdbFlight` resolves it, regional hint included, so a row matches the key of the tracker
 * for the same operation: (operator, operating number).
 */
function fidsBoardRow(
  item: unknown,
  direction: 'dep' | 'arr',
  mapping: AdbMappingContext,
): Exact<BoardRow> | BoardSkip {
  const parsedItem = AirportFlightSchema.safeParse(item);
  if (!parsedItem.success) {
    return 'invalid_contract';
  }
  const flight = parsedItem.data;
  const legs = boardLegs(flight, direction);
  if (legs === null) {
    return 'no_home_leg';
  }
  if (legs.counterpart === null) {
    return 'no_counterpart_icao';
  }
  let parsed: ParsedNumber;
  try {
    parsed = parseAdbNumber(flight.number, flight.airline, mapping.carriers);
  } catch {
    return 'unparseable_number';
  }
  const homeMovement = direction === 'dep' ? 'departure' : 'arrival';
  const farMovement = direction === 'dep' ? 'arrival' : 'departure';
  const home = legTimes(legs.home, homeMovement, flight.status);
  const far = legTimes(legs.far, farMovement, flight.status);
  if (home.scheduled === null) {
    return 'no_scheduled_time';
  }
  const departure = direction === 'dep' ? home : far;
  const arrival = direction === 'dep' ? far : home;
  const row: Exact<BoardRow> = {
    direction,
    designator: parsed.compact,
    flightNumber: parsed.number,
    counterpart: legs.counterpart,
    scheduled: home.scheduled.instant,
    status: boardStatus(flight.status, departure, arrival, mapping.now),
    codeshareStatus: flight.codeshareStatus,
    codeshares: [],
    source: 'aerodatabox',
  };
  const marketingIcao = parsed.marketingIcao;
  if (marketingIcao !== undefined) {
    const operator = operatorOf(
      { ...parsed, marketingIcao },
      flight.codeshareStatus,
      flight.callSign,
      mapping.regionalRules,
    );
    row.operatingCarrierIcao = operator.operatingCarrierIcao;
    row.flightNumber = operator.operatingFlightNumber;
    row.marketingCarrierIcao = marketingIcao;
  }
  put(row, 'marketingCarrierIata', parsed.marketingIata);
  put(row, 'callSign', clean(flight.callSign)?.toUpperCase());
  put(row, 'registration', clean(flight.aircraft?.reg)?.toUpperCase());
  put(row, 'aircraftModel', clean(flight.aircraft?.model));
  put(row, 'estimated', home.estimated);
  put(row, 'actual', home.actual);
  put(row, 'terminal', clean(legs.home.terminal));
  put(row, 'gate', clean(legs.home.gate));
  if (direction === 'arr') {
    put(row, 'baggageClaim', clean(legs.home.baggageBelt));
  }
  put(row, 'counterpartScheduled', far.scheduled?.instant);
  put(row, 'counterpartEstimated', far.estimated);
  put(row, 'counterpartActual', far.actual);
  put(row, 'counterpartTerminal', clean(legs.far?.terminal));
  put(row, 'counterpartGate', clean(legs.far?.gate));
  const localDate = departure.scheduled?.localDate;
  if (localDate !== undefined && isValidIsoDate(localDate)) {
    row.scheduledDepartureDateLocal = localDate;
  }
  return row;
}
