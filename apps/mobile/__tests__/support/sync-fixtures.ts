/** Wire-shaped `GET /v1/sync` pages, built from the shared contract's own helpers. */

import { buildFlightKey, encodeSyncCursor, type FlightKey } from '@planeahead/shared';

export const AA100: FlightKey = buildFlightKey({
  operatingCarrierIcao: 'AAL',
  flightNumber: '100',
  scheduledDepartureDateLocal: '2026-09-19',
  originIcao: 'KJFK',
});

export const BA117: FlightKey = buildFlightKey({
  operatingCarrierIcao: 'BAW',
  flightNumber: '117',
  scheduledDepartureDateLocal: '2026-09-21',
  originIcao: 'EGLL',
});

export function id(n: number): string {
  return `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

export function cursorAt(seq: number): string {
  return encodeSyncCursor({
    xid: String(5000 + seq),
    seq: String(seq),
    epoch: '1',
    binding: '0123456789abcdef',
  });
}

const T0 = '2026-09-19T12:00:00.000Z';

export function subscriptionUpsert(
  n: number,
  flightKey: FlightKey,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const row = {
    id: id(n),
    flightKey,
    flightInstanceId: id(900 + n),
    tripId: null,
    label: null,
    seat: null,
    cabin: null,
    muted: false,
    notificationOverrides: {},
    source: 'app',
    liveTracked: true,
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    ...overrides,
  };
  return {
    entity: 'flight_subscriptions',
    op: 'upsert',
    id: row.id,
    updatedAt: row.updatedAt,
    row,
  };
}

export function subscriptionDelete(n: number): Record<string, unknown> {
  return {
    entity: 'flight_subscriptions',
    op: 'delete',
    id: id(n),
    updatedAt: T0,
    row: { id: id(n), deletedAt: T0 },
  };
}

export function preferencesUpsert(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const row = {
    id: id(700),
    distanceUnit: 'km',
    temperatureUnit: 'c',
    timeFormat: '24h',
    showLocalTimes: true,
    settings: {},
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    ...overrides,
  };
  return { entity: 'user_preferences', op: 'upsert', id: row.id, updatedAt: T0, row };
}

/** A `notification_preferences` row as the API's `notificationPreferencesSyncRow` writes it. */
export function notificationPreferencesUpsert(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const row = {
    id: id(710),
    pushEnabled: true,
    emailEnabled: false,
    liveActivitiesEnabled: true,
    quietHoursStartMinutes: null,
    quietHoursEndMinutes: null,
    quietHoursTz: null,
    events: {},
    createdAt: T0,
    updatedAt: T0,
    deletedAt: null,
    ...overrides,
  };
  return { entity: 'notification_preferences', op: 'upsert', id: row.id, updatedAt: T0, row };
}

export function flight(
  key: FlightKey,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const base =
    key === AA100
      ? {
          operatingCarrierIcao: 'AAL',
          flightNumber: '100',
          origin: { icao: 'KJFK', iata: 'JFK', tz: 'America/New_York' },
          destination: { icao: 'EGLL', iata: 'LHR', tz: 'Europe/London' },
          times: { scheduledOut: '2026-09-20T03:50:00Z', scheduledIn: '2026-09-20T10:50:00Z' },
        }
      : {
          operatingCarrierIcao: 'BAW',
          flightNumber: '117',
          origin: { icao: 'EGLL', iata: 'LHR', tz: 'Europe/London' },
          destination: { icao: 'KJFK', iata: 'JFK', tz: 'America/New_York' },
          times: { scheduledOut: '2026-09-21T12:00:00Z', scheduledIn: '2026-09-21T20:00:00Z' },
        };
  return {
    key,
    ...base,
    legSeq: 1,
    codeshares: [],
    status: 'scheduled',
    originGate: 'B22',
    originTerminal: '8',
    providerRefs: {},
    fetchedAt: '2026-09-19T12:00:00Z',
    source: 'aerodatabox',
    fieldQuality: {},
    ...overrides,
  };
}

export function page(input: {
  readonly changes?: readonly Record<string, unknown>[];
  readonly flights?: readonly Record<string, unknown>[];
  readonly cursor: string;
  readonly hasMore?: boolean;
}): Record<string, unknown> {
  return {
    rpcVersion: 1,
    serverTime: '2026-09-19T12:00:01.000Z',
    cursor: input.cursor,
    hasMore: input.hasMore ?? false,
    changes: input.changes ?? [],
    flights: input.flights ?? [],
  };
}

export function envelope(error: string, extra: Record<string, unknown> = {}) {
  return { error, message: error, requestId: 'req-test', ...extra };
}
