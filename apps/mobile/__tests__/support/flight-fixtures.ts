/**
 * Increment 10's seeded store: three synced flights around a fixed "now" (Wednesday 23 September
 * 2026, 10:00 in New York), written through the REAL page apply, plus the helpers the screen tests
 * share (a Map-backed kv module for the settings store, a scripted `fetch`, JSON responses).
 *
 * - AA100 JFK to LHR tonight: 18:00 New York scheduled, 18:25 estimated (25 min late), terminal 8
 *   gate B22, arriving 07:10 London the next morning. The next flight.
 * - BA117 LHR to JFK on Friday.
 * - DL1 ATL to LAX yesterday, arrived: a past flight.
 */

import { buildFlightKey, type FlightKey } from '@planeahead/shared';
import type { SqliteLike } from '../../src/lib/db/sqlite-like';
import { applySyncPage, SyncPageShell, type ApplyOutcome } from '../../src/lib/sync/apply';
import { cursorAt, id, page, subscriptionUpsert } from './sync-fixtures';

export const NOW = Date.parse('2026-09-23T14:00:00Z');

export const AA100_KEY: FlightKey = buildFlightKey({
  operatingCarrierIcao: 'AAL',
  flightNumber: '100',
  scheduledDepartureDateLocal: '2026-09-23',
  originIcao: 'KJFK',
});
export const BA117_KEY: FlightKey = buildFlightKey({
  operatingCarrierIcao: 'BAW',
  flightNumber: '117',
  scheduledDepartureDateLocal: '2026-09-25',
  originIcao: 'EGLL',
});
export const DL1_KEY: FlightKey = buildFlightKey({
  operatingCarrierIcao: 'DAL',
  flightNumber: '1',
  scheduledDepartureDateLocal: '2026-09-22',
  originIcao: 'KATL',
});

export const AA100_ID = id(1);
export const BA117_ID = id(2);
export const DL1_ID = id(3);

const JFK = { icao: 'KJFK', iata: 'JFK', tz: 'America/New_York' };
const LHR = { icao: 'EGLL', iata: 'LHR', tz: 'Europe/London' };
const ATL = { icao: 'KATL', iata: 'ATL', tz: 'America/New_York' };
const LAX = { icao: 'KLAX', iata: 'LAX', tz: 'America/Los_Angeles' };

/** AA100's snapshot as the feed carries it; `overrides` replace top-level fields. */
export function aa100Snapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: AA100_KEY,
    operatingCarrierIcao: 'AAL',
    flightNumber: '100',
    legSeq: 1,
    codeshares: [{ carrierIata: 'BA', flightNumber: '1511' }],
    origin: JFK,
    destination: LHR,
    status: 'scheduled',
    times: {
      scheduledOut: '2026-09-23T22:00:00Z',
      estimatedOut: '2026-09-23T22:25:00Z',
      scheduledOff: '2026-09-23T22:20:00Z',
      scheduledOn: '2026-09-24T05:55:00Z',
      scheduledIn: '2026-09-24T06:10:00Z',
      estimatedIn: '2026-09-24T06:10:00Z',
    },
    departureDelaySec: 1500,
    originTerminal: '8',
    originGate: 'B22',
    destinationTerminal: '3',
    aircraftTypeIcao: 'B77W',
    routeDistanceKm: 5540,
    providerRefs: {},
    fetchedAt: '2026-09-23T13:56:00Z',
    source: 'aerodatabox',
    fieldQuality: {},
    ...overrides,
  };
}

export function ba117Snapshot(): Record<string, unknown> {
  return {
    key: BA117_KEY,
    operatingCarrierIcao: 'BAW',
    flightNumber: '117',
    legSeq: 1,
    codeshares: [],
    origin: LHR,
    destination: JFK,
    status: 'scheduled',
    times: { scheduledOut: '2026-09-25T11:20:00Z', scheduledIn: '2026-09-25T19:25:00Z' },
    originTerminal: '5',
    providerRefs: {},
    fetchedAt: '2026-09-23T09:00:00Z',
    source: 'aerodatabox',
    fieldQuality: {},
  };
}

export function dl1Snapshot(): Record<string, unknown> {
  return {
    key: DL1_KEY,
    operatingCarrierIcao: 'DAL',
    flightNumber: '1',
    legSeq: 1,
    codeshares: [],
    origin: ATL,
    destination: LAX,
    status: 'arrived',
    times: {
      scheduledOut: '2026-09-22T12:00:00Z',
      actualOut: '2026-09-22T12:04:00Z',
      scheduledIn: '2026-09-22T16:50:00Z',
      actualIn: '2026-09-22T16:41:00Z',
    },
    destinationGate: '52A',
    baggageClaim: '4',
    providerRefs: {},
    fetchedAt: '2026-09-22T17:00:00Z',
    source: 'aerodatabox',
    fieldQuality: {},
  };
}

/** The seeded page: the three subscriptions and their snapshots, one immediate transaction. */
export function seededPage(aa100Overrides: Record<string, unknown> = {}): SyncPageShell {
  return SyncPageShell.parse(
    page({
      changes: [
        subscriptionUpsert(1, AA100_KEY),
        subscriptionUpsert(2, BA117_KEY),
        subscriptionUpsert(3, DL1_KEY),
      ],
      flights: [aa100Snapshot(aa100Overrides), ba117Snapshot(), dl1Snapshot()],
      cursor: cursorAt(1),
    }),
  );
}

export function seedStore(
  db: SqliteLike,
  aa100Overrides: Record<string, unknown> = {},
): ApplyOutcome {
  return applySyncPage(db, seededPage(aa100Overrides), { ownerUserId: 'user-1' });
}

/** A JSON `Response`, as the API answers. */
export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly signal: AbortSignal | null;
}

/**
 * A `fetch` that answers from a queue of responders and records every request (method, path,
 * headers, parsed body). A responder may throw (offline) or return a pending promise.
 */
export function scriptedFetch() {
  const requests: RecordedRequest[] = [];
  const queue: ((request: RecordedRequest) => Promise<Response> | Response)[] = [];
  const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = init?.body;
    let body: unknown = null;
    if (typeof raw === 'string' && raw !== '') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const request: RecordedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
      signal: init?.signal ?? null,
    };
    requests.push(request);
    const next = queue.shift();
    if (next === undefined) {
      return Promise.reject(new TypeError(`no scripted response for ${request.method} ${url}`));
    }
    try {
      return Promise.resolve(next(request));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return {
    fetchMock,
    requests,
    answer(responder: (request: RecordedRequest) => Promise<Response> | Response) {
      queue.push(responder);
    },
  };
}
