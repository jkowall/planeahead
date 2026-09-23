/**
 * Development-only demo data: a `GET /v1/sync` page with three flights around "now", applied
 * through the REAL page apply (src/lib/sync/apply.ts), so a development build can show the home
 * screen with a seeded store while no API is reachable (docs/increments/10-verification.md: the
 * simulator launch). Nothing here runs in a production build: the only caller is the
 * `dev/seeded-home` route, which refuses outside `__DEV__` and the development variant.
 *
 * The page's cursor is a well-formed placeholder. A later real pull sends it, the server answers
 * 410 `resync_required` (it is bound to no user), and the store resets to the account's own
 * snapshot, the documented recovery (increment 9).
 */

import {
  buildFlightKey,
  encodeSyncCursor,
  originLocalDate,
  uuidv7,
  type FlightKey,
} from '@planeahead/shared';
import type { SqliteLike } from '../lib/db/sqlite-like';
import { applySyncPage, SyncPageShell, type ApplyOutcome } from '../lib/sync/apply';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

interface DemoFlight {
  readonly carrier: string;
  readonly number: string;
  readonly origin: { readonly icao: string; readonly iata: string; readonly tz: string };
  readonly destination: { readonly icao: string; readonly iata: string; readonly tz: string };
  readonly outInMs: number;
  readonly blockMinutes: number;
  readonly status: string;
  readonly extra: Record<string, unknown>;
}

function iso(ms: number): string {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS).toISOString().replace('.000Z', 'Z');
}

const JFK = { icao: 'KJFK', iata: 'JFK', tz: 'America/New_York' };
const LHR = { icao: 'EGLL', iata: 'LHR', tz: 'Europe/London' };
const ATL = { icao: 'KATL', iata: 'ATL', tz: 'America/New_York' };
const LAX = { icao: 'KLAX', iata: 'LAX', tz: 'America/Los_Angeles' };

function demoFlights(): DemoFlight[] {
  return [
    {
      carrier: 'AAL',
      number: '100',
      origin: JFK,
      destination: LHR,
      outInMs: 3 * HOUR_MS + 5 * MINUTE_MS,
      blockMinutes: 420,
      status: 'scheduled',
      extra: {
        originTerminal: '8',
        originGate: 'B22',
        aircraftTypeIcao: 'B77W',
        routeDistanceKm: 5540,
      },
    },
    {
      carrier: 'BAW',
      number: '117',
      origin: LHR,
      destination: JFK,
      outInMs: 2 * 24 * HOUR_MS,
      blockMinutes: 480,
      status: 'scheduled',
      extra: { originTerminal: '5' },
    },
    {
      carrier: 'DAL',
      number: '1',
      origin: ATL,
      destination: LAX,
      outInMs: -30 * HOUR_MS,
      blockMinutes: 290,
      status: 'arrived',
      extra: { destinationGate: '52A', baggageClaim: '4' },
    },
  ];
}

/** The page: one subscription upsert and one flight snapshot per demo flight. */
export function demoSyncPage(nowMs: number): SyncPageShell {
  const changes: unknown[] = [];
  const flights: unknown[] = [];
  for (const demo of demoFlights()) {
    const outMs = nowMs + demo.outInMs;
    const key: FlightKey = buildFlightKey({
      operatingCarrierIcao: demo.carrier,
      flightNumber: demo.number,
      scheduledDepartureDateLocal: originLocalDate(new Date(outMs), demo.origin.tz),
      originIcao: demo.origin.icao,
    });
    const id = uuidv7();
    const stamp = iso(nowMs);
    const arrived = demo.status === 'arrived';
    changes.push({
      entity: 'flight_subscriptions',
      op: 'upsert',
      id,
      updatedAt: stamp,
      row: {
        id,
        flightKey: key,
        flightInstanceId: uuidv7(),
        tripId: null,
        label: null,
        seat: null,
        cabin: null,
        muted: false,
        notificationOverrides: {},
        source: 'manual',
        liveTracked: false,
        createdAt: stamp,
        updatedAt: stamp,
        deletedAt: null,
      },
    });
    flights.push({
      key,
      operatingCarrierIcao: demo.carrier,
      flightNumber: demo.number,
      legSeq: 1,
      codeshares: [],
      origin: demo.origin,
      destination: demo.destination,
      status: demo.status,
      times: {
        scheduledOut: iso(outMs),
        scheduledIn: iso(outMs + demo.blockMinutes * MINUTE_MS),
        ...(arrived
          ? {
              actualOut: iso(outMs + 12 * MINUTE_MS),
              actualIn: iso(outMs + (demo.blockMinutes + 3) * MINUTE_MS),
            }
          : {}),
      },
      ...demo.extra,
      providerRefs: {},
      fetchedAt: iso(nowMs - 4 * MINUTE_MS),
      source: 'aerodatabox',
      fieldQuality: {},
    });
  }
  return SyncPageShell.parse({
    rpcVersion: 1,
    serverTime: iso(nowMs),
    cursor: encodeSyncCursor({ xid: '1', seq: '1', epoch: '1', binding: '0000000000000000' }),
    hasMore: false,
    changes,
    flights,
  });
}

/** Seeds the store through the real page apply (one immediate transaction, one signal). */
export function seedDemoFlights(db: SqliteLike, nowMs: number): ApplyOutcome {
  return applySyncPage(db, demoSyncPage(nowMs), { replace: false });
}
