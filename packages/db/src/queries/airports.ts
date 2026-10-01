/**
 * The one lookup that fills a flight's airport triple. `flight_instances.origin_icao`,
 * `origin_airport_id` and `origin_tz` (and the destination pair) describe a single airport:
 * the code goes into the frozen `flight_key`, the id is the foreign key, the zone decides the
 * origin-local date. They must come from one `airports` row, never from separate provider
 * fields, or a mismatch would be frozen into the key and the FlightTracker name at first
 * sight. The composite foreign key `(origin_airport_id, origin_icao) -> airports (id, icao)`
 * rejects a mismatch the database can see; this helper is how writers avoid producing one.
 */

import { and, eq } from 'drizzle-orm';
import type { Db } from '../client';
import { airports } from '../schema/reference';

export interface AirportEndpoint {
  readonly airportId: string;
  /** `airports.icao`: a real ICAO code or an ident-derived pseudo code. */
  readonly icao: string;
  /** IANA zone, never null (the seed refuses an airport without one). */
  readonly tz: string;
}

/**
 * Looks an airport up by its stored code. Null when the code is unknown. Takes anything that can
 * select, so a writer can call it inside its own transaction (the persist consumer does).
 */
export async function resolveAirportEndpoint(
  db: Pick<Db, 'select'>,
  icao: string,
): Promise<AirportEndpoint | null> {
  const [row] = await db
    .select({ airportId: airports.id, icao: airports.icao, tz: airports.tz })
    .from(airports)
    .where(eq(airports.icao, icao))
    .limit(1);
  return row ?? null;
}

/** The `flight_instances` origin columns for a resolved airport. */
export function originColumns(endpoint: AirportEndpoint) {
  return {
    originIcao: endpoint.icao,
    originAirportId: endpoint.airportId,
    originTz: endpoint.tz,
  };
}

/** The `flight_instances` destination columns for a resolved airport. */
export function destinationColumns(endpoint: AirportEndpoint) {
  return {
    destinationIcao: endpoint.icao,
    destinationAirportId: endpoint.airportId,
  };
}

/** An airport a board can be asked for (increment 18). */
export interface BoardAirport {
  /** A real ICAO code: AeroDataBox FIDS is asked by ICAO. */
  readonly icao: string;
  readonly iata: string | null;
  readonly name: string;
  /** IANA zone: the board's buckets are airport-local. */
  readonly tz: string;
}

const ICAO_CODE_RE = /^[A-Z0-9]{4}$/;
const IATA_CODE_RE = /^[A-Z0-9]{3}$/;

/**
 * The airport a board request names (ruling B2), by a 4-character ICAO code or a 3-character
 * IATA code, case-insensitive. Only an airport with a real ICAO code (`icao_source =
 * 'icao_code'`) qualifies, because FIDS is asked by ICAO; an ident-derived pseudo code, an
 * unknown code or anything else is null, which the route answers with a 404 before any object
 * is touched.
 */
export async function resolveBoardAirport(
  db: Pick<Db, 'select'>,
  code: string,
): Promise<BoardAirport | null> {
  const normalized = code.trim().toUpperCase();
  const column = ICAO_CODE_RE.test(normalized)
    ? airports.icao
    : IATA_CODE_RE.test(normalized)
      ? airports.iata
      : null;
  if (column === null) {
    return null;
  }
  const [row] = await db
    .select({ icao: airports.icao, iata: airports.iata, name: airports.name, tz: airports.tz })
    .from(airports)
    .where(and(eq(column, normalized), eq(airports.icaoSource, 'icao_code')))
    .limit(1);
  return row ?? null;
}
