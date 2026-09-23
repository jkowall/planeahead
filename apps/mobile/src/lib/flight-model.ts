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
 *   snapshot until `POST /v1/flights` answers. A pending row the store already holds as a live
 *   row (same designator and date) is `superseded` and hidden (src/lib/sync/local-intent.ts).
 * - live: a subscription with a snapshot (or still waiting for its first one).
 * - over: arrived, cancelled, finished (a refresh answered 410 `flight_archived`), or long past
 *   its arrival time (a flight whose provider never reported the arrival must not stay "next"
 *   for ever).
 *
 * The name a row shows (increment 10 review): the designator the user typed on this phone
 * (`added_as`, local only), else the key's operating designator. Never the snapshot's marketing
 * designator: the snapshot is shared by every subscriber of the flight key, and its marketing
 * fields name whoever searched the flight first. The operating designator is shown beside it when
 * the two differ.
 */

import {
  CARRIER_IATA_TO_ICAO_FALLBACK,
  FlightStatusSchema,
  FlightStatusValueSchema,
  parseDesignator,
  parseFlightKey,
  resolveCarrierIcao,
  type FlightStatus,
  type FlightStatusValue,
} from '@planeahead/shared';

export const PENDING_KEY_PREFIX = 'pending:';

/** A flight whose arrival is this far in the past is over, whatever its status still says. */
export const OVER_AFTER_ARRIVAL_MS = 12 * 60 * 60_000;

/**
 * A landed flight stays the home's next flight this long after its best arrival time, unless
 * another flight in the list departs before then (a connection): see `selectHome`.
 */
export const LANDED_GRACE_MS = 30 * 60_000;

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
  readonly added_as: string | null;
  /** 0 or 1 (SQLite has no boolean). */
  readonly superseded: number;
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
  /** A pending add the store already holds as a live row (hidden from the list). */
  readonly superseded: boolean;
  /** `BA1512`: the designator typed on this phone (`added_as`), else the key's operating one. */
  readonly designator: string;
  /** `AA100` for `AAL-100-...`: the key's operating designator; null for a pending row. */
  readonly operatingDesignator: string | null;
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
): Pick<FlightItem, 'pending' | 'designator' | 'operatingDesignator' | 'dateLocal'> {
  const pending = parsePendingKey(row.flight_key);
  if (pending !== null) {
    return {
      pending: true,
      designator: row.added_as ?? pending.designator,
      operatingDesignator: null,
      dateLocal: pending.dateLocal,
    };
  }
  let dateLocal: string | null = null;
  let operatingDesignator: string | null = null;
  try {
    const key = parseFlightKey(row.flight_key);
    dateLocal = key.scheduledDepartureDateLocal;
    operatingDesignator = displayDesignator(key.operatingCarrierIcao, key.flightNumber);
  } catch {
    // A key this build cannot parse still renders, as itself.
  }
  return {
    pending: false,
    designator: row.added_as ?? operatingDesignator ?? row.flight_key,
    operatingDesignator,
    dateLocal,
  };
}

export function toFlightItem(row: FlightRowRecord): FlightItem {
  const snapshot = parseSnapshot(row.snapshot_json);
  return {
    id: row.id,
    flightKey: row.flight_key,
    ...identity(row),
    superseded: row.superseded === 1,
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

/** `Operated as AA100` when the name shown is not the key's operating designator. */
export function operatedAs(item: FlightItem): string | null {
  return item.operatingDesignator === null || item.operatingDesignator === item.designator
    ? null
    : `Operated as ${item.operatingDesignator}`;
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
  /**
   * The first flight by scheduled departure that is not over, and not pending. A landed flight
   * gives the slot up 30 minutes after its arrival, or at once when another flight departs
   * before then (`LANDED_GRACE_MS`).
   */
  readonly next: FlightItem | null;
  /**
   * What the home's top card shows: `next`, else the oldest pending add (shown as "Adding"), else
   * null (only past flights, or none at all).
   */
  readonly hero: FlightItem | null;
  /**
   * Everything but the hero: pending adds, then upcoming by departure, then past flights (and
   * landed flights that gave the next slot up) newest first.
   */
  readonly rest: readonly FlightItem[];
}

function byDeparture(a: FlightItem, b: FlightItem): number {
  const left = ms(a.scheduledOut) ?? Number.MAX_SAFE_INTEGER;
  const right = ms(b.scheduledOut) ?? Number.MAX_SAFE_INTEGER;
  return left - right || a.id.localeCompare(b.id);
}

/** When a landed flight stops being the next flight: its best arrival plus the grace. */
function landedGraceEnds(item: FlightItem): number | null {
  const times = item.snapshot?.times;
  const arrival = ms(
    arrivalTime(item) ?? times?.actualOn ?? times?.estimatedOn ?? times?.scheduledOn ?? null,
  );
  return arrival === null ? null : arrival + LANDED_GRACE_MS;
}

/**
 * A landed flight is done as the next flight once its grace has passed, or when another flight
 * still ahead departs before the grace ends: the connection matters more than the gate walk.
 */
function landedHandsOver(item: FlightItem, live: readonly FlightItem[], nowMs: number): boolean {
  const ends = landedGraceEnds(item);
  if (ends !== null && nowMs > ends) {
    return true;
  }
  const limit = ends ?? Number.POSITIVE_INFINITY;
  return live.some((other) => {
    if (other.id === item.id || other.status === 'landed') {
      return false;
    }
    const departs = ms(departureTime(other));
    return departs !== null && departs < limit;
  });
}

export function selectHome(items: readonly FlightItem[], nowMs: number): HomeSelection {
  const shown = items.filter((item) => !item.superseded);
  const pending = shown
    .filter((item) => item.pending)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const live = shown.filter((item) => !item.pending && !isOver(item, nowMs)).sort(byDeparture);
  const handedOver = new Set(
    live
      .filter((item) => item.status === 'landed' && landedHandsOver(item, live, nowMs))
      .map((item) => item.id),
  );
  const upcoming = live.filter((item) => !handedOver.has(item.id));
  const past = shown
    .filter((item) => !item.pending && (isOver(item, nowMs) || handedOver.has(item.id)))
    .sort((a, b) => byDeparture(b, a));
  const [next = null, ...laterUpcoming] = upcoming;
  const hero = next ?? pending[0] ?? null;
  return {
    next,
    hero,
    rest: [...pending.filter((item) => item !== hero), ...laterUpcoming, ...past],
  };
}

// ---------------------------------------------------------------------------------------------
// Designators, for the pending-row dedupe (src/lib/sync/local-intent.ts).
// ---------------------------------------------------------------------------------------------

/**
 * Every spelling of a designator this build can derive, so `AA100` and `AAL100` compare equal:
 * the IATA and the ICAO carrier code (through the shared fallback table) with the same number.
 */
export function designatorSpellings(designator: string): string[] {
  try {
    const parsed = parseDesignator(designator);
    const number = `${parsed.number}${parsed.suffix ?? ''}`;
    const forms = new Set<string>();
    if (parsed.carrier.iata !== undefined) {
      forms.add(`${parsed.carrier.iata}${number}`);
    }
    const icao = resolveCarrierIcao(parsed.carrier, CARRIER_IATA_TO_ICAO_FALLBACK);
    if (icao !== undefined) {
      forms.add(`${icao}${number}`);
      const iata = ICAO_TO_IATA.get(icao);
      if (iata !== undefined) {
        forms.add(`${iata}${number}`);
      }
    }
    return [...forms];
  } catch {
    return [designator];
  }
}

/**
 * The designators a live row is known by on its date: the one typed on this phone, the key's
 * operating one, and the snapshot's marketing designator and codeshares (all name this flight).
 */
export function knownDesignators(item: FlightItem): ReadonlySet<string> {
  const names: string[] = [item.designator];
  if (item.operatingDesignator !== null) {
    names.push(item.operatingDesignator);
  }
  const snapshot = item.snapshot;
  if (
    snapshot?.marketingCarrierIcao !== undefined &&
    snapshot.marketingFlightNumber !== undefined
  ) {
    names.push(displayDesignator(snapshot.marketingCarrierIcao, snapshot.marketingFlightNumber));
  }
  for (const codeshare of snapshot?.codeshares ?? []) {
    const carrier = codeshare.carrierIata ?? codeshare.carrierIcao;
    if (carrier !== undefined) {
      names.push(`${carrier}${codeshare.flightNumber}`);
    }
  }
  return new Set(names.flatMap(designatorSpellings));
}

/** Whether a pending add names the same flight as a live row: same date, a shared designator. */
export function pendingMatchesLive(pending: FlightItem, live: FlightItem): boolean {
  if (!pending.pending || live.pending || pending.dateLocal !== live.dateLocal) {
    return false;
  }
  const known = knownDesignators(live);
  return designatorSpellings(pending.designator).some((form) => known.has(form));
}
