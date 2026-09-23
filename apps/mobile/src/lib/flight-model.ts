/**
 * What the flight screens render, derived from a `flight_subscriptions` row (the flight snapshot
 * is denormalised onto it, increment 9) and nothing else. Pure, so the home's selection and the
 * detail's derived fields are unit-tested without a renderer.
 *
 * A row is one of:
 *
 * - pending: the optimistic row the add-flight sheet wrote (src/lib/flights.ts). Its flight key is
 *   a local placeholder, `pending:<DESIGNATOR>:<YYYY-MM-DD>`, because the canonical key (operating
 *   carrier, origin ICAO) is only known once the server resolved the designator. It has no
 *   snapshot until `POST /v1/flights` answers.
 * - live: a subscription with a snapshot (or still waiting for its first one).
 * - over: arrived, cancelled, finished (a refresh answered 410 `flight_archived`), or long past
 *   its arrival time (a flight whose provider never reported the arrival must not stay "next"
 *   for ever).
 */

import {
  CARRIER_IATA_TO_ICAO_FALLBACK,
  FlightStatusSchema,
  FlightStatusValueSchema,
  parseFlightKey,
  type FlightStatus,
  type FlightStatusValue,
} from '@planeahead/shared';

export const PENDING_KEY_PREFIX = 'pending:';

/** A flight whose arrival is this far in the past is over, whatever its status still says. */
export const OVER_AFTER_ARRIVAL_MS = 12 * 60 * 60_000;

/** The `flight_subscriptions` row as `SELECT *` returns it. */
export interface FlightRowRecord {
  readonly id: string;
  readonly flight_key: string;
  readonly label: string | null;
  readonly created_at: string;
  readonly deleted_at: string | null;
  readonly flight_status: string | null;
  readonly scheduled_out: string | null;
  readonly estimated_out: string | null;
  readonly actual_out: string | null;
  readonly scheduled_in: string | null;
  readonly estimated_in: string | null;
  readonly actual_in: string | null;
  readonly origin_icao: string | null;
  readonly origin_iata: string | null;
  readonly origin_tz: string | null;
  readonly destination_icao: string | null;
  readonly destination_iata: string | null;
  readonly destination_tz: string | null;
  readonly origin_terminal: string | null;
  readonly origin_gate: string | null;
  readonly destination_terminal: string | null;
  readonly destination_gate: string | null;
  readonly baggage_claim: string | null;
  readonly aircraft_type_icao: string | null;
  readonly departure_delay_sec: number | null;
  readonly arrival_delay_sec: number | null;
  readonly snapshot_json: string | null;
  readonly snapshot_fetched_at: string | null;
  readonly snapshot_source: string | null;
  readonly finished_at: string | null;
}

export interface AirportEnd {
  /** IATA when known, else ICAO, else null (a pending row). */
  readonly code: string | null;
  readonly tz: string | null;
  readonly terminal: string | null;
  readonly gate: string | null;
}

export interface FlightItem {
  readonly id: string;
  readonly flightKey: string;
  readonly pending: boolean;
  /** `AA100`: the marketing designator when the snapshot names one, else the operating one. */
  readonly designator: string;
  /** Origin-local departure date `YYYY-MM-DD`, from the key (or the pending placeholder). */
  readonly dateLocal: string | null;
  readonly label: string | null;
  readonly status: FlightStatusValue | null;
  readonly origin: AirportEnd;
  readonly destination: AirportEnd;
  readonly scheduledOut: string | null;
  readonly estimatedOut: string | null;
  readonly actualOut: string | null;
  readonly scheduledIn: string | null;
  readonly estimatedIn: string | null;
  readonly actualIn: string | null;
  readonly departureDelaySec: number | null;
  readonly arrivalDelaySec: number | null;
  readonly baggageClaim: string | null;
  readonly aircraftTypeIcao: string | null;
  /** The whole provider snapshot (OOOI times, codeshares, distance), when one is stored. */
  readonly snapshot: FlightStatus | null;
  readonly snapshotFetchedAt: string | null;
  readonly snapshotSource: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

const ICAO_TO_IATA: ReadonlyMap<string, string> = new Map(
  Object.entries(CARRIER_IATA_TO_ICAO_FALLBACK).map(([iata, icao]) => [icao, iata]),
);

/** `AA100` for `AAL` and `100`; the ICAO code when the fallback table has no IATA one. */
export function displayDesignator(carrierIcao: string, number: string): string {
  return `${ICAO_TO_IATA.get(carrierIcao) ?? carrierIcao}${number}`;
}

export function pendingFlightKey(designator: string, dateLocal: string): string {
  return `${PENDING_KEY_PREFIX}${designator}:${dateLocal}`;
}

function parsePendingKey(key: string): { designator: string; dateLocal: string } | null {
  if (!key.startsWith(PENDING_KEY_PREFIX)) {
    return null;
  }
  const [designator = '', dateLocal = ''] = key.slice(PENDING_KEY_PREFIX.length).split(':');
  return { designator, dateLocal };
}

function parseSnapshot(json: string | null): FlightStatus | null {
  if (json === null) {
    return null;
  }
  try {
    const parsed = FlightStatusSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function statusOf(value: string | null): FlightStatusValue | null {
  if (value === null) {
    return null;
  }
  const parsed = FlightStatusValueSchema.safeParse(value);
  return parsed.success ? parsed.data : 'unknown';
}

function identity(
  row: FlightRowRecord,
  snapshot: FlightStatus | null,
): Pick<FlightItem, 'pending' | 'designator' | 'dateLocal'> {
  const pending = parsePendingKey(row.flight_key);
  if (pending !== null) {
    return { pending: true, designator: pending.designator, dateLocal: pending.dateLocal };
  }
  let dateLocal: string | null = null;
  let designator = row.flight_key;
  try {
    const key = parseFlightKey(row.flight_key);
    dateLocal = key.scheduledDepartureDateLocal;
    designator = displayDesignator(key.operatingCarrierIcao, key.flightNumber);
  } catch {
    // A key this build cannot parse still renders, as itself.
  }
  if (
    snapshot?.marketingCarrierIcao !== undefined &&
    snapshot.marketingFlightNumber !== undefined
  ) {
    designator = displayDesignator(snapshot.marketingCarrierIcao, snapshot.marketingFlightNumber);
  }
  return { pending: false, designator, dateLocal };
}

export function toFlightItem(row: FlightRowRecord): FlightItem {
  const snapshot = parseSnapshot(row.snapshot_json);
  return {
    id: row.id,
    flightKey: row.flight_key,
    ...identity(row, snapshot),
    label: row.label,
    status: statusOf(row.flight_status),
    origin: {
      code: row.origin_iata ?? row.origin_icao,
      tz: row.origin_tz,
      terminal: row.origin_terminal,
      gate: row.origin_gate,
    },
    destination: {
      code: row.destination_iata ?? row.destination_icao,
      tz: row.destination_tz,
      terminal: row.destination_terminal,
      gate: row.destination_gate,
    },
    scheduledOut: row.scheduled_out,
    estimatedOut: row.estimated_out,
    actualOut: row.actual_out,
    scheduledIn: row.scheduled_in,
    estimatedIn: row.estimated_in,
    actualIn: row.actual_in,
    departureDelaySec: row.departure_delay_sec,
    arrivalDelaySec: row.arrival_delay_sec,
    baggageClaim: row.baggage_claim,
    aircraftTypeIcao: row.aircraft_type_icao,
    snapshot,
    snapshotFetchedAt: row.snapshot_fetched_at,
    snapshotSource: row.snapshot_source,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

function ms(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) {
    return null;
  }
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
}

/** The departure time to count down to: actual, else estimated, else scheduled. */
export function departureTime(item: FlightItem): string | null {
  return item.actualOut ?? item.estimatedOut ?? item.scheduledOut;
}

/** The arrival time to count down to: actual, else estimated, else scheduled. */
export function arrivalTime(item: FlightItem): string | null {
  return item.actualIn ?? item.estimatedIn ?? item.scheduledIn;
}

export function hasDeparted(item: FlightItem, nowMs: number): boolean {
  if (item.actualOut !== null) {
    return true;
  }
  if (
    item.status === 'departed' ||
    item.status === 'en_route' ||
    item.status === 'landed' ||
    item.status === 'arrived' ||
    item.status === 'diverted'
  ) {
    return true;
  }
  const out = ms(item.estimatedOut ?? item.scheduledOut);
  // Without a report, a flight well past its departure time (an hour) is treated as gone.
  return out !== null && nowMs - out > 60 * 60_000;
}

/** Arrived, cancelled, finished, or long past its arrival: not a "next flight" any more. */
export function isOver(item: FlightItem, nowMs: number): boolean {
  if (item.pending) {
    return false;
  }
  if (item.finishedAt !== null || item.status === 'arrived' || item.status === 'cancelled') {
    return true;
  }
  const arrival = ms(arrivalTime(item));
  return arrival !== null && nowMs - arrival > OVER_AFTER_ARRIVAL_MS;
}

export type Countdown =
  | { readonly kind: 'departs'; readonly at: string }
  | { readonly kind: 'arrives'; readonly at: string }
  | null;

/** What the home's countdown counts to: departure, then arrival once it has left, then nothing. */
export function countdownFor(item: FlightItem, nowMs: number): Countdown {
  if (item.pending || isOver(item, nowMs) || item.status === 'landed') {
    return null;
  }
  if (!hasDeparted(item, nowMs)) {
    const at = item.estimatedOut ?? item.scheduledOut;
    return at === null ? null : { kind: 'departs', at };
  }
  const at = item.estimatedIn ?? item.scheduledIn;
  if (at === null || (ms(at) ?? 0) <= nowMs) {
    return null;
  }
  return { kind: 'arrives', at };
}

export interface HomeSelection {
  /** The first flight by scheduled departure that is not over, and not pending. */
  readonly next: FlightItem | null;
  /** Everything else: pending adds, then upcoming by departure, then past flights newest first. */
  readonly rest: readonly FlightItem[];
}

function byDeparture(a: FlightItem, b: FlightItem): number {
  const left = ms(a.scheduledOut) ?? Number.MAX_SAFE_INTEGER;
  const right = ms(b.scheduledOut) ?? Number.MAX_SAFE_INTEGER;
  return left - right || a.id.localeCompare(b.id);
}

export function selectHome(items: readonly FlightItem[], nowMs: number): HomeSelection {
  const pending = items
    .filter((item) => item.pending)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const upcoming = items.filter((item) => !item.pending && !isOver(item, nowMs)).sort(byDeparture);
  const past = items
    .filter((item) => !item.pending && isOver(item, nowMs))
    .sort((a, b) => byDeparture(b, a));
  const [next = null, ...laterUpcoming] = upcoming;
  return { next, rest: [...pending, ...laterUpcoming, ...past] };
}
