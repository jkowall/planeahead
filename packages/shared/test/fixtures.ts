import {
  FlightStatusSchema,
  type FlightStatus,
  type FlightStatusInput,
} from '../src/flight-status';

/** AA100 JFK to LHR, scheduled 2026-09-19 23:50 local at JFK, which is 2026-09-20T03:50Z. */
export const AA100_INPUT: FlightStatusInput = {
  operatingCarrierIcao: 'AAL',
  flightNumber: '100',
  codeshares: [{ carrierIata: 'BA', carrierIcao: 'BAW', flightNumber: '1512' }],
  origin: { icao: 'KJFK', iata: 'JFK', tz: 'America/New_York' },
  destination: { icao: 'EGLL', iata: 'LHR', tz: 'Europe/London' },
  status: 'scheduled',
  times: {
    scheduledOut: '2026-09-20T03:50:00Z',
    scheduledIn: '2026-09-20T10:50:00Z',
  },
  providerRefs: { aerodatabox: 'adb-aa100-20260919' },
  fetchedAt: '2026-09-19T12:00:00Z',
  source: 'aerodatabox',
  fieldQuality: { scheduledOut: 'schedule', scheduledIn: 'schedule' },
};

export function makeStatus(overrides: Partial<FlightStatusInput> = {}): FlightStatus {
  return FlightStatusSchema.parse({ ...AA100_INPUT, ...overrides });
}
