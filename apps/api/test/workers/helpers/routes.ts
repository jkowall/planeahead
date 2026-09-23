/**
 * Helpers for the increment 8 route tests: flights a test owns, trackers seeded without a
 * provider call, the `/v1/flights` requests the mobile outbox makes, and direct Postgres reads.
 *
 * Two kinds of flight. `nearUniqueFlight()` departs inside the provider lookahead measured from
 * the REAL clock, because the search route checks the date against `Date.now()` and the
 * DesignatorResolver it calls runs on the real clock unless a test sets one; its number and date
 * are random so files running in parallel never share a fake-gateway script. `seededFlight()`
 * is a 2100s flight whose tracker a test seeds directly through the `seed` RPC (no provider
 * call), for the routes that take a flight key.
 *
 * Every object a route creates is `track()`ed so the file's `afterEach(drainTouched)` cancels
 * its alarm.
 */

import { env } from 'cloudflare:workers';
import { sql } from 'drizzle-orm';
import { openDb, type Db } from '@planeahead/db';
import {
  RPC_SCHEMA_VERSION,
  originLocalDate,
  type FlightKey,
  type FlightStatus,
} from '@planeahead/shared';
import { makeStatus } from '../../../../../packages/shared/test/fixtures';
import type { FlightTracker } from '../../../src/do/flight-tracker';
import { IDEMPOTENCY_KEY_HEADER } from '../../../src/middleware/idempotency';
import { jsonRequest, worker, type AnonymousSession } from './auth';
import { MINUTE_MS, track, testEnv, type TestFlight } from './flights';

export const DAY_MS = 86_400_000;
export const HOUR = 3_600_000;

let fileHandle: Db | null = null;

/**
 * The test file's database handle, created on first use and shared by every helper and test in
 * the file. One per FILE, not one per call: a client a test opens keeps its sockets until the
 * file's isolate ends, and a helper that polls (`eventually`) would otherwise open a pool per
 * poll and exhaust the cluster's `max_connections` for every file running in parallel.
 */
export function db(): Db {
  fileHandle ??= openDb(env);
  return fileHandle;
}

function randomFlightNumber(): string {
  return String(1 + Math.floor(Math.random() * 9_998));
}

/**
 * A unique on-time AA flight KJFK to EGLL departing at 15:00Z between `minDays` and `maxDays`
 * days from the real today, inside the Growth plan's 365-day lookahead.
 */
export function nearUniqueFlight(minDays = 20, maxDays = 300, blockMinutes = 420): TestFlight {
  const number = randomFlightNumber();
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T15:00:00Z`);
  const offset = minDays + Math.floor(Math.random() * (maxDays - minDays + 1));
  const scheduledOut = new Date(today + offset * DAY_MS);
  const scheduledIn = new Date(scheduledOut.getTime() + blockMinutes * MINUTE_MS);
  const originTz = 'America/New_York';
  const dateLocal = originLocalDate(scheduledOut, originTz);
  return {
    designator: `AA${number}`,
    number,
    dateLocal,
    flightKey: `AAL-${number}-${dateLocal}-KJFK` as FlightKey,
    scheduledOut,
    scheduledIn,
    originTz,
  };
}

/** A 2100s flight (or one departing `departsInMs` from now) for a directly seeded tracker. */
export function seededFlightFor(departsInMs?: number): TestFlight {
  const number = randomFlightNumber();
  let scheduledOut: Date;
  if (departsInMs === undefined) {
    const year = 2100 + Math.floor(Math.random() * 70);
    const month = 1 + Math.floor(Math.random() * 12);
    const day = 1 + Math.floor(Math.random() * 27);
    scheduledOut = new Date(Date.UTC(year, month - 1, day, 15, 0, 0));
  } else {
    scheduledOut = new Date(Math.floor((Date.now() + departsInMs) / 60_000) * 60_000);
  }
  const scheduledIn = new Date(scheduledOut.getTime() + 420 * MINUTE_MS);
  const originTz = 'America/New_York';
  const dateLocal = originLocalDate(scheduledOut, originTz);
  return {
    designator: `AA${number}`,
    number,
    dateLocal,
    flightKey: `AAL-${number}-${dateLocal}-KJFK` as FlightKey,
    scheduledOut,
    scheduledIn,
    originTz,
  };
}

/** The status a seeded tracker starts from. */
export function statusFor(
  flight: TestFlight,
  overrides: Partial<Parameters<typeof makeStatus>[0]> = {},
): FlightStatus {
  return makeStatus({
    key: flight.flightKey,
    flightNumber: flight.number,
    codeshares: [],
    scheduledDepartureDateLocal: flight.dateLocal,
    times: {
      scheduledOut: flight.scheduledOut.toISOString(),
      scheduledIn: flight.scheduledIn.toISOString(),
    },
    providerRefs: {},
    fetchedAt: new Date(Date.now() - 10 * MINUTE_MS).toISOString(),
    ...overrides,
  });
}

/** The tracker stub the routes use for `flight` (same name, same location hint), tracked. */
export function trackerStub(flightKey: FlightKey): DurableObjectStub<FlightTracker> {
  return track(testEnv.FLIGHT_TRACKER.getByName(flightKey, { locationHint: 'enam' }));
}

/** Seeds the flight's tracker from a status, as the DesignatorResolver would, with no call. */
export async function seedTracker(
  flight: TestFlight,
  overrides: Partial<Parameters<typeof makeStatus>[0]> = {},
): Promise<DurableObjectStub<FlightTracker>> {
  const stub = trackerStub(flight.flightKey);
  await stub.seed({
    rpcVersion: RPC_SCHEMA_VERSION,
    flightKey: flight.flightKey,
    status: statusFor(flight, overrides),
    designator: flight.designator,
  });
  return stub;
}

export function idempotencyKey(label: string): string {
  return `${label}-${crypto.randomUUID()}`;
}

export interface SubscribeOptions {
  readonly key?: string | null;
  readonly headers?: Record<string, string>;
}

/** `POST /v1/flights` the way the outbox sends it. */
export function subscribeRequest(
  session: Pick<AnonymousSession, 'cookie' | 'ip'>,
  body: Record<string, unknown>,
  options: SubscribeOptions = {},
): Request {
  const key = options.key === undefined ? idempotencyKey('sub') : options.key;
  return jsonRequest('/v1/flights', 'POST', body, {
    ip: session.ip,
    cookie: session.cookie,
    headers: {
      ...(key === null ? {} : { [IDEMPOTENCY_KEY_HEADER]: key }),
      ...options.headers,
    },
  });
}

export function subscribe(
  session: Pick<AnonymousSession, 'cookie' | 'ip'>,
  body: Record<string, unknown>,
  options: SubscribeOptions = {},
): Promise<Response> {
  return worker(subscribeRequest(session, body, options));
}

/** A GET (or bodiless POST/DELETE) under `/v1` as the signed-in client. */
export function authed(
  session: Pick<AnonymousSession, 'cookie' | 'ip'>,
  path: string,
  method = 'GET',
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker(
    jsonRequest(path, method, undefined, { ip: session.ip, cookie: session.cookie, headers }),
  );
}

export interface SubscribeBody {
  readonly subscription: {
    readonly id: string;
    readonly flightKey: string;
    readonly flightInstanceId: string;
    readonly deletedAt: string | null;
  };
  readonly flight: { key: string; phase: string; snapshot: unknown } | null;
  readonly created: boolean;
}

export interface ErrorBody {
  readonly error: string;
  readonly message?: string;
  readonly cap?: string;
  readonly limit?: number;
  readonly issues?: { path: (string | number)[]; message: string }[];
}

/** Counter value, or 0 when the row does not exist. */
export async function counterValue(
  scope: 'user' | 'ip',
  subject: string,
  counter: string,
): Promise<number> {
  const rows = await db().execute<{ count: number }>(sql`
    select coalesce(sum(count), 0)::int as count from usage_counters
    where scope = ${scope} and subject = ${subject} and counter = ${counter}
  `);
  return rows[0]?.count ?? 0;
}

/** The subscriber count the tracker itself reports. */
export async function subscriberCount(flightKey: FlightKey): Promise<number> {
  const state = await trackerStub(flightKey).getState();
  return state.subscriberCount;
}

/** Waits until `check` holds (polling), for effects the persist queue applies asynchronously. */
export async function eventually<T>(
  read: () => Promise<T>,
  check: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!check(value)) {
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${String(timeoutMs)} ms: ${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
}

/** Lifts today's AeroDataBox per-second limit for this file (its Durable Object storage). */
export async function openTodaysBudget(): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const stub = track(
    testEnv.PROVIDER_BUDGET.getByName(`aerodatabox:${day}`, { locationHint: 'enam' }),
  );
  await stub.configure({ perSecondLimit: 10_000 });
}
