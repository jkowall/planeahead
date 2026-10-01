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

const AirportFlightSchema = z.looseObject({
  number: z.string().min(1),
  callSign: NullableString,
  status: AdbStatusSchema,
  codeshareStatus: CodeshareStatusSchema,
  movement: MovementSchema.nullish(),
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

/** Result of an AeroDataBox health check for one airport. */
export interface AdbCoverage {
  readonly airportIcao: string;
  readonly schedules: string;
  readonly live: string;
  readonly adsb: string;
  /** True when schedules or live updates are `OK` or `OKPartial`. */
  readonly covered: boolean;
}

interface Attempt {
  readonly call: ProviderCallRecord;
  readonly body: ReadBody | null;
  /** True when the caller must not retry this lookup (451, a refusal, a push-back). */
  readonly terminal: boolean;
}

const COVERED_STATUSES: ReadonlySet<string> = new Set(['OK', 'OKPartial']);

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
   * FIDS by airport (TIER 2, 2 units). `window.from` and `window.to` are airport-local times
   * (`YYYY-MM-DDTHH:mm`, the `BoardWindow` contract), sent as they are: FIDS asks in local time,
   * so `window.tz` is not needed here. FIDS selects by SCHEDULED time. A window wider than the plan
   * allows is cut to `fidsWindowHours`.
   */
  async getBoard(
    airportIcao: string,
    direction: 'dep' | 'arr',
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
    const query = new URLSearchParams({
      direction: direction === 'dep' ? 'Departure' : 'Arrival',
      withLeg: 'false',
      withCancelled: 'true',
      withCodeshared: 'true',
      withCargo: 'false',
      withPrivate: 'false',
    });
    const attempt = await this.#attempt(
      ctx,
      'fids',
      `flights/airports/Icao/${icao}/${formatLocalMinute(from)}/${formatLocalMinute(cappedTo)}?${query.toString()}`,
    );
    const body = attempt.body;
    if (attempt.call.result !== 'ok' || body?.kind !== 'json') {
      return { data: [], call: attempt.call };
    }
    const fids = FidsSchema.safeParse(body.value);
    if (!fids.success) {
      return { data: [], call: { ...attempt.call, result: 'error', error: 'not_a_fids_contract' } };
    }
    const items = (direction === 'dep' ? fids.data.departures : fids.data.arrivals) ?? [];
    const now = ctx.now();
    const mapping = this.#mappingContext(now);
    const rows: Exact<BoardRow>[] = [];
    for (const item of items) {
      const parsed = AirportFlightSchema.safeParse(item);
      if (!parsed.success || parsed.data.movement === null || parsed.data.movement === undefined) {
        continue;
      }
      const row = boardRow(parsed.data, parsed.data.movement, direction, mapping);
      if (row !== null) {
        rows.push(row);
      }
    }
    return { data: rows, call: attempt.call };
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
   * FREE TIER health check for one airport's data feeds: the DesignatorResolver's not-found
   * path asks it whether a miss means "no such flight" or "we do not cover this airport".
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
    const schedules = parsed.data.flightSchedulesFeed.status;
    const live = parsed.data.liveFlightUpdatesFeed.status;
    return {
      data: {
        airportIcao: icao,
        schedules,
        live,
        adsb: parsed.data.adsbUpdatesFeed.status,
        covered: COVERED_STATUSES.has(schedules) || COVERED_STATUSES.has(live),
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

/**
 * A board row's status from the data the row has. FIDS gives one movement: the departure at a
 * departures board, the arrival at an arrivals board.
 *
 * - Departures: `deriveStatus` over the departure's schedule, estimate and actual, as for a flight.
 * - Arrivals: there is no departure time on the row, so `deriveStatus` cannot see that the flight
 *   left. Flags and an actual arrival first (cancelled, diverted, arrived); then `en_route` once
 *   the status enum says the aircraft has left the origin (`isActualAt('departure')`, the same
 *   disambiguation the revised times use, never a mapping of the enum's name); `scheduled`
 *   before that, whatever the estimate says.
 */
function boardRowStatus(
  status: AdbStatus,
  direction: 'dep' | 'arr',
  times: { scheduled: string; estimated: string | undefined; actual: string | undefined },
  now: Date,
): FlightStatusValue {
  const flags = adbFlags(status);
  if (direction === 'dep') {
    return deriveStatus({
      ...flags,
      actualOut: times.actual,
      scheduledOut: times.scheduled,
      estimatedOut: times.estimated,
      now,
    });
  }
  if (flags.cancelled || flags.diverted || times.actual !== undefined) {
    return deriveStatus({ ...flags, actualIn: times.actual, now });
  }
  return isActualAt('departure', status) ? 'en_route' : 'scheduled';
}

function boardRow(
  flight: z.infer<typeof AirportFlightSchema>,
  movement: AdbMovementContract,
  direction: 'dep' | 'arr',
  mapping: AdbMappingContext,
): Exact<BoardRow> | null {
  const counterpart = adbAirportRef(movement.airport);
  const scheduled = parseAdbDateTime(movement.scheduledTime);
  if (counterpart === null || scheduled === null) {
    return null;
  }
  let parsed: ParsedNumber;
  try {
    parsed = parseAdbNumber(flight.number, flight.airline, mapping.carriers);
  } catch {
    return null;
  }
  const movementName = direction === 'dep' ? 'departure' : 'arrival';
  const revised = disambiguateRevisedTime(
    flight.status,
    parseAdbDateTime(movement.revisedTime)?.instant,
    scheduled.instant,
    movementName,
  );
  const actual = revised?.quality === 'live' ? revised.value : undefined;
  const estimated = revised?.quality === 'estimated' ? revised.value : undefined;
  const status = boardRowStatus(
    flight.status,
    direction,
    { scheduled: scheduled.instant, estimated, actual },
    mapping.now,
  );
  const row: Exact<BoardRow> = {
    direction,
    designator: parsed.compact,
    flightNumber: parsed.number,
    counterpart,
    scheduled: scheduled.instant,
    status,
    codeshares: [],
    source: 'aerodatabox',
  };
  const marketingIcao = parsed.marketingIcao;
  if (marketingIcao !== undefined) {
    // The same resolution as `mapAdbFlight`, regional hint included, so a row matches the key of
    // the tracker for the same operation: (operator, operating number).
    const operator = operatorOf(
      { ...parsed, marketingIcao },
      flight.codeshareStatus,
      flight.callSign,
      mapping.regionalRules,
    );
    row.operatingCarrierIcao = operator.operatingCarrierIcao;
    row.flightNumber = operator.operatingFlightNumber;
  }
  if (estimated !== undefined) {
    row.estimated = estimated;
  }
  if (actual !== undefined) {
    row.actual = actual;
  }
  const terminal = clean(movement.terminal);
  const gate = clean(movement.gate);
  const belt = clean(movement.baggageBelt);
  if (terminal !== undefined) {
    row.terminal = terminal;
  }
  if (gate !== undefined) {
    row.gate = gate;
  }
  if (belt !== undefined && direction === 'arr') {
    row.baggageClaim = belt;
  }
  return row;
}
