/**
 * The Postgres side of "a flight the routes know about" (increment 8).
 *
 * `flight_instances` is written by the persist consumer (ADR 0007), which fills every tracked
 * column from the tracker's outbox. That write is asynchronous, and a subscription needs the row
 * NOW: `flight_subscriptions.flight_instance_id` is NOT NULL with a foreign key. So the routes
 * register the row's KEY COLUMNS on first sight (`insert ... on conflict (flight_key) do
 * nothing`, the five natural-key columns and nothing else, version 0), which is the carve-out
 * docs/schema-review.md section 7 already names; the consumer's monotonic upsert then applies the
 * tracker's first version over it. The search route records the marketing designator the same
 * way (`flight_designators`), so the next search for it can pass the origin the resolver's
 * existing-tracker probe needs.
 */

import { and, eq, or } from 'drizzle-orm';
import {
  DESIGNATOR_SOURCES,
  TERMINAL_TRACKING_STATES,
  airports,
  flightDesignators,
  flightInstances,
  type Db,
} from '@planeahead/db';
import {
  CARRIER_IATA_TO_ICAO_FALLBACK,
  ICAO_AIRPORT_RE,
  parseDesignator,
  parseFlightKey,
  resolveCarrierIcao,
  type FlightKey,
  type FlightStatus,
} from '@planeahead/shared';

/** A transaction on the request's handle, or the handle itself. */
export type DbOrTx = Pick<Db, 'insert' | 'select' | 'update' | 'delete' | 'execute'>;

/** Ensures the registry row exists and returns its id. */
export async function ensureInstanceRegistered(db: DbOrTx, flightKey: FlightKey): Promise<string> {
  const parts = parseFlightKey(flightKey);
  await db
    .insert(flightInstances)
    .values({
      operatingCarrierIcao: parts.operatingCarrierIcao,
      flightNumber: parts.flightNumber,
      scheduledDepartureDate: parts.scheduledDepartureDateLocal,
      originIcao: parts.originIcao,
      legSeq: parts.legSeq,
    })
    .onConflictDoNothing({ target: flightInstances.flightKey });
  const [row] = await db
    .select({ id: flightInstances.id })
    .from(flightInstances)
    .where(eq(flightInstances.flightKey, flightKey))
    .limit(1);
  if (row === undefined) {
    throw new Error(`flight_instances row for ${flightKey} vanished after its insert`);
  }
  return row.id;
}

export interface KnownInstance {
  readonly id: string;
  readonly flightKey: FlightKey;
  readonly trackingState: string;
}

export async function instanceByKey(
  db: DbOrTx,
  flightKey: FlightKey,
): Promise<KnownInstance | null> {
  const [row] = await db
    .select({
      id: flightInstances.id,
      flightKey: flightInstances.flightKey,
      trackingState: flightInstances.trackingState,
    })
    .from(flightInstances)
    .where(eq(flightInstances.flightKey, flightKey))
    .limit(1);
  return row === undefined ? null : { ...row, flightKey: row.flightKey as FlightKey };
}

/** Whether Postgres says the flight is over for good (finished, archived, superseded). */
export function isTerminalTrackingState(state: string): boolean {
  return (TERMINAL_TRACKING_STATES as readonly string[]).includes(state);
}

/**
 * An origin as ICAO: a 4-character code as given, a 3-character IATA code through `airports`.
 * Null when the IATA code is unknown.
 */
export async function resolveOriginIcao(db: DbOrTx, code: string): Promise<string | null> {
  if (ICAO_AIRPORT_RE.test(code)) {
    return code;
  }
  const [row] = await db
    .select({ icao: airports.icao })
    .from(airports)
    .where(eq(airports.iata, code))
    .limit(1);
  return row?.icao ?? null;
}

interface DesignatorParts {
  readonly icao: string | undefined;
  readonly iata: string | undefined;
  readonly number: string;
}

function designatorParts(designator: string): DesignatorParts {
  const parsed = parseDesignator(designator);
  return {
    icao: resolveCarrierIcao(parsed.carrier, CARRIER_IATA_TO_ICAO_FALLBACK),
    iata: parsed.carrier.iata,
    number: `${parsed.number}${parsed.suffix ?? ''}`,
  };
}

export interface DesignatorHit {
  readonly originIcao: string;
  readonly flightKey: FlightKey;
  readonly trackingState: string;
}

/**
 * The instance a marketing designator and origin-local date map to, when exactly one is known
 * (with `originIcao` the match is exact; without it a multi-leg number is ambiguous and nothing is
 * returned, so the resolver decides).
 */
export async function lookupDesignator(
  db: DbOrTx,
  designator: string,
  dateLocal: string,
  originIcao: string | undefined,
): Promise<DesignatorHit | null> {
  const parts = designatorParts(designator);
  const carrier =
    parts.icao !== undefined && parts.iata !== undefined
      ? or(
          eq(flightDesignators.marketingCarrierIcao, parts.icao),
          eq(flightDesignators.marketingCarrierIata, parts.iata),
        )
      : parts.icao !== undefined
        ? eq(flightDesignators.marketingCarrierIcao, parts.icao)
        : eq(flightDesignators.marketingCarrierIata, parts.iata ?? '');
  const rows = await db
    .select({
      originIcao: flightDesignators.originIcao,
      flightKey: flightInstances.flightKey,
      trackingState: flightInstances.trackingState,
    })
    .from(flightDesignators)
    .innerJoin(flightInstances, eq(flightInstances.id, flightDesignators.flightInstanceId))
    .where(
      and(
        carrier,
        eq(flightDesignators.flightNumber, parts.number),
        eq(flightDesignators.scheduledDepartureDate, dateLocal),
        originIcao === undefined ? undefined : eq(flightDesignators.originIcao, originIcao),
      ),
    )
    .limit(2);
  const [only] = rows;
  if (rows.length !== 1 || only === undefined) {
    return null;
  }
  return { ...only, flightKey: only.flightKey as FlightKey };
}

/** Records `designator` as naming `flightKey`'s instance (first sight; never overwritten). */
export async function recordDesignator(
  db: DbOrTx,
  designator: string,
  flightKey: FlightKey,
  instanceId: string,
  status: FlightStatus | undefined,
): Promise<void> {
  const parts = designatorParts(designator);
  if (parts.icao === undefined) {
    return;
  }
  const key = parseFlightKey(flightKey);
  const source = (DESIGNATOR_SOURCES as readonly string[]).includes(status?.source ?? '')
    ? (status?.source ?? 'aerodatabox')
    : 'aerodatabox';
  const operating = parts.icao === key.operatingCarrierIcao && parts.number === key.flightNumber;
  await db
    .insert(flightDesignators)
    .values({
      marketingCarrierIcao: parts.icao,
      marketingCarrierIata: parts.iata ?? null,
      flightNumber: parts.number,
      scheduledDepartureDate: key.scheduledDepartureDateLocal,
      originIcao: key.originIcao,
      flightInstanceId: instanceId,
      kind: operating ? 'operating' : 'codeshare',
      source,
    })
    .onConflictDoNothing({
      target: [
        flightDesignators.marketingCarrierIcao,
        flightDesignators.flightNumber,
        flightDesignators.scheduledDepartureDate,
        flightDesignators.originIcao,
      ],
    });
}
