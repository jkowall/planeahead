/**
 * The one lookup that fills a flight's airport triple. `flight_instances.origin_icao`,
 * `origin_airport_id` and `origin_tz` (and the destination pair) describe a single airport:
 * the code goes into the frozen `flight_key`, the id is the foreign key, the zone decides the
 * origin-local date. They must come from one `airports` row, never from separate provider
 * fields, or a mismatch would be frozen into the key and the FlightTracker name at first
 * sight. The composite foreign key `(origin_airport_id, origin_icao) -> airports (id, icao)`
 * rejects a mismatch the database can see; this helper is how writers avoid producing one.
 */

import { eq } from 'drizzle-orm';
import type { Db } from '../client';
import { airports } from '../schema/reference';

export interface AirportEndpoint {
  readonly airportId: string;
  /** `airports.icao`: a real ICAO code or an ident-derived pseudo code. */
  readonly icao: string;
  /** IANA zone, never null (the seed refuses an airport without one). */
  readonly tz: string;
}

/** Looks an airport up by its stored code. Null when the code is unknown. */
export async function resolveAirportEndpoint(
  db: Db,
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
