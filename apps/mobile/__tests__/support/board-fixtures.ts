/**
 * Board and route-search answers as the increment 18 routes give them (the shared
 * `AirportBoardResponse` and `RouteSearchResponse`), at the fixtures' NOW (2026-09-23T14:00Z,
 * 10:00 in New York).
 */

import type { AirportBoardResponse, BoardViewRow, RouteSearchResponse } from '@planeahead/shared';

export const JFK_VIEW = {
  icao: 'KJFK',
  iata: 'JFK',
  name: 'John F Kennedy International',
  tz: 'America/New_York',
};
export const LHR_VIEW = { icao: 'EGLL', iata: 'LHR', name: 'London Heathrow', tz: 'Europe/London' };

/** AA100 JFK to LHR, 18:00 local, expected 18:25, sold as BA1511 and IB4218 too. */
export function boardRow(overrides: Partial<BoardViewRow> = {}): BoardViewRow {
  return {
    id: 'dep:AA100:2026-09-23T22:00:00Z',
    designator: 'AA100',
    airlineIata: 'AA',
    airlineIcao: 'AAL',
    operatingCarrierIcao: 'AAL',
    operatingFlightNumber: '100',
    codeshares: ['BA1511', 'IB4218'],
    counterpart: { icao: 'EGLL', iata: 'LHR' },
    status: 'scheduled',
    scheduled: '2026-09-23T22:00:00Z',
    estimated: '2026-09-23T22:25:00Z',
    terminal: '8',
    gate: '12',
    counterpartScheduled: '2026-09-24T10:10:00Z',
    aircraftModel: 'Boeing 777-300ER',
    add: { number: 'AA100', date: '2026-09-23', origin: 'KJFK' },
    ...overrides,
  };
}

/** DL1 JFK to LAX, 11:00 local, departed 11:05. */
export function departedRow(): BoardViewRow {
  return boardRow({
    id: 'dep:DL1:2026-09-23T15:00:00Z',
    designator: 'DL1',
    airlineIata: 'DL',
    airlineIcao: 'DAL',
    operatingCarrierIcao: 'DAL',
    operatingFlightNumber: '1',
    codeshares: [],
    counterpart: { icao: 'KLAX', iata: 'LAX' },
    status: 'departed',
    scheduled: '2026-09-23T15:00:00Z',
    estimated: '2026-09-23T15:00:00Z',
    actual: '2026-09-23T15:05:00Z',
    terminal: '4',
    gate: 'B30',
    add: { number: 'DL1', date: '2026-09-23', origin: 'KJFK' },
  });
}

/** A row the provider gave no origin-local date for: it cannot be added. */
export function unaddableRow(): BoardViewRow {
  const row = boardRow({
    id: 'dep:ZZ999:2026-09-23T16:00:00Z',
    designator: 'ZZ999',
    codeshares: [],
    counterpart: { icao: 'KBOS' },
    scheduled: '2026-09-23T16:00:00Z',
  });
  delete row.add;
  delete row.estimated;
  return row;
}

export function boardAnswer(overrides: Partial<AirportBoardResponse> = {}): AirportBoardResponse {
  return {
    airport: JFK_VIEW,
    direction: 'departures',
    from: '2026-09-23T13:00:00.000Z',
    to: '2026-09-24T01:00:00.000Z',
    coverage: 'live',
    fetchedAt: '2026-09-23T13:58:00.000Z',
    stale: false,
    partial: false,
    rows: [departedRow(), unaddableRow(), boardRow()],
    ...overrides,
  };
}

export function routeAnswer(overrides: Partial<RouteSearchResponse> = {}): RouteSearchResponse {
  return {
    origin: JFK_VIEW,
    destination: LHR_VIEW,
    date: '2026-09-23',
    coverage: 'live',
    fetchedAt: '2026-09-23T13:58:00.000Z',
    stale: false,
    partial: false,
    flights: [boardRow()],
    ...overrides,
  };
}
