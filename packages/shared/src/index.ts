/**
 * Shared contracts for PlaneAhead. Increment 2 fills this with Zod schemas, FlightStatus,
 * the provider interfaces, uuidv7 and the real flight-key normaliser. For now it exports one
 * constant and one function so the build, lint and test pipeline is proven end to end.
 */

export const PLANEAHEAD = 'planeahead' as const;

/**
 * Placeholder for the flight-key normaliser that arrives in increment 2. The real function takes
 * an operating carrier, a flight number and an origin-local date and returns the canonical key
 * used to name the FlightTracker Durable Object.
 */
export function flightKeyPlaceholder(
  carrierIcao: string,
  flightNumber: number,
  dateLocal: string,
): string {
  return `${carrierIcao.toUpperCase()}-${String(flightNumber)}-${dateLocal}`;
}
