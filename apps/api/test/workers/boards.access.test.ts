/**
 * Ruling B9 (increment 18, part 2): `BOARD_RL` in every environment, taken by user and by client
 * IP on both routes; the anonymous airport limit (only airports of live subscriptions); the
 * route-search caps in `usage_counters` (per user, and per salted IP for anonymous accounts); and
 * that the deployed Worker mounts both routes behind a session.
 */

import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { boardBucketBounds, uuidv7, type AirportBoardResponse } from '@planeahead/shared';
import { flightInstances, flightSubscriptions } from '@planeahead/db';
import wranglerConfig from '../../wrangler.jsonc?raw';
import { saltedIpSubject } from '../../src/lib/hmac';
import { normaliseClientIp } from '../../src/validation/client-ip';
import { airportHarness, uniqueDay } from './helpers/airports';
import { signInAnonymously, uniqueIp, worker, jsonRequest } from './helpers/auth';
import {
  boardApp,
  insertBoardAirport,
  openBoardBudget,
  signedInSession,
  type BoardSession,
  type TestAirport,
} from './helpers/boards';
import { HOUR_MS, drainTouched, testEnv } from './helpers/flights';
import { counterValue, db } from './helpers/routes';

afterEach(drainTouched);

const NY = 'America/New_York';
const EMPTY_FIDS = { departures: [], arrivals: [] };

/** A fresh day's clock, an hour into its PM bucket. */
function clockOfNewDay(): number {
  const bounds = boardBucketBounds(`${uniqueDay()}T12:00`, NY);
  if (bounds === null) {
    throw new Error('no bounds');
  }
  return bounds.startMs + HOUR_MS;
}

/** An airport whose object answers an empty board at `now`. */
async function servedAirport(now: number): Promise<TestAirport> {
  const airport = await insertBoardAirport(NY);
  await airportHarness(EMPTY_FIDS, now, NY, airport.icao);
  return airport;
}

describe('BOARD_RL (ruling B9)', () => {
  it('is 30 per 60 s with its own namespace in every environment', () => {
    const entries = [
      ...wranglerConfig.matchAll(
        /\{ "name": "BOARD_RL", "namespace_id": "(\d+)", "simple": \{ "limit": (\d+), "period": (\d+) \} \}/g,
      ),
    ].map((match) => ({ id: match[1], limit: Number(match[2]), period: Number(match[3]) }));
    expect(entries.map(({ limit, period }) => ({ limit, period }))).toEqual([
      { limit: 30, period: 60 },
      { limit: 30, period: 60 },
      { limit: 30, period: 60 },
    ]);
    const ids = [...wranglerConfig.matchAll(/"namespace_id": "(\d+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is taken by user and by client IP on both routes, and refuses either one past 30', async () => {
    const app = boardApp({ nowMs: () => clockOfNewDay(), limit: 30 });
    const ip = uniqueIp();
    const alice = await signedInSession(ip);
    const board = (session: BoardSession) => app.get('/v1/airports/ZZZ7/board', session);
    for (let i = 0; i < 30; i += 1) {
      expect((await board(alice)).status).toBe(404);
    }
    expect(app.limiterKeys.slice(0, 2)).toEqual([`user:${alice.userId}`, `ip:${ip}`]);
    const refused = await board(alice);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(await refused.json()).toMatchObject({ error: 'rate_limited', limiter: 'BOARD_RL' });

    // Another account behind the same address is refused by the IP key ...
    const bob = await signedInSession(ip);
    expect((await board(bob)).status).toBe(429);
    // ... the same account from another address by the user key ...
    expect((await board({ ...alice, ip: uniqueIp() })).status).toBe(429);
    // ... and the route search takes the same two keys.
    const carol = await signedInSession();
    const route = await app.get('/v1/airports/ZZZ7/flights/to/ZZZ6?date=2101-01-01', carol);
    expect(route.status).toBe(404);
    expect(app.limiterKeys.slice(-2)).toEqual([`user:${carol.userId}`, `ip:${carol.ip}`]);
  });
});

/** A live (or tombstoned) subscription of `userId` to a flight between two airports. */
async function plantSubscription(
  userId: string,
  originIcao: string,
  destinationIcao: string | null,
  deleted = false,
): Promise<void> {
  const [instance] = await db()
    .insert(flightInstances)
    .values({
      operatingCarrierIcao: 'AAL',
      flightNumber: String(1 + Math.floor(Math.random() * 9_998)),
      scheduledDepartureDate: '2101-06-01',
      originIcao,
      ...(destinationIcao === null ? {} : { destinationIcao }),
      trackingState: 'tracking',
      version: 1,
    })
    .returning({ id: flightInstances.id });
  await db()
    .insert(flightSubscriptions)
    .values({
      id: uuidv7(),
      userId,
      flightInstanceId: instance?.id ?? '',
      deletedAt: deleted ? new Date().toISOString() : null,
    });
}

describe('the anonymous airport limit (ruling B9)', () => {
  it('opens only airports of live subscriptions, origin or destination; signed-in opens any', async () => {
    const now = clockOfNewDay();
    const day = new Date(now).toISOString().slice(0, 10);
    await openBoardBudget(now);
    const app = boardApp({ nowMs: () => now });
    const [origin, destination, unrelated, dropped] = await Promise.all([
      servedAirport(now),
      servedAirport(now),
      servedAirport(now),
      servedAirport(now),
    ]);
    const anonymous = await signInAnonymously();
    const open = (airport: TestAirport, session: BoardSession = anonymous) =>
      app.get(`/v1/airports/${airport.iata}/board`, session);

    const before = await open(origin);
    expect(before.status).toBe(403);
    expect(await before.json()).toMatchObject({ error: 'board_requires_account' });

    await plantSubscription(anonymous.userId, origin.icao, destination.icao);
    await plantSubscription(anonymous.userId, dropped.icao, null, true);
    const fromOrigin = await open(origin);
    expect(fromOrigin.status).toBe(200);
    expect((await fromOrigin.json<AirportBoardResponse>()).rows).toEqual([]);
    expect((await open(destination)).status).toBe(200);
    expect((await open(unrelated)).status).toBe(403);
    expect((await open(dropped)).status).toBe(403);

    expect((await open(unrelated, await signedInSession())).status).toBe(200);
    // The route search stays open to the anonymous account, from any airport.
    const search = await app.get(
      `/v1/airports/${unrelated.iata}/flights/to/${origin.iata}?date=${day}`,
      anonymous,
    );
    expect(search.status).toBe(200);
  });
});

/** Seeds a `route_searches` counter for the UTC day, as if `count` searches had run. */
async function seedSearches(scope: 'user' | 'ip', subject: string, day: string, count: number) {
  await db().execute(sql`
    insert into usage_counters (id, scope, subject, counter, window_start, count)
    values (${uuidv7()}, ${scope}, ${subject}, 'route_searches', ${`${day}T00:00:00Z`}::timestamptz,
            ${count})
  `);
}

async function searchScenario() {
  const now = clockOfNewDay();
  const day = new Date(now).toISOString().slice(0, 10);
  await openBoardBudget(now);
  const [origin, destination] = await Promise.all([servedAirport(now), insertBoardAirport(NY)]);
  const app = boardApp({ nowMs: () => now });
  const path = `/v1/airports/${origin.iata}/flights/to/${destination.iata}?date=${day}`;
  return { day, app, path };
}

describe('the route-search caps (rulings B9 and B10)', () => {
  it('allows 30 searches per user per UTC day, and charges a signed-in account no IP slot', async () => {
    const { day, app, path } = await searchScenario();
    const user = await signedInSession();
    await seedSearches('user', user.userId, day, 29);
    expect((await app.get(path, user)).status).toBe(200);
    expect(await counterValue('user', user.userId, 'route_searches')).toBe(30);
    const capped = await app.get(path, user);
    expect(capped.status).toBe(403);
    expect(await capped.json()).toMatchObject({
      error: 'cap_exceeded',
      cap: 'route_searches',
      limit: 30,
    });
    const subject = await saltedIpSubject(
      testEnv.IP_SALT_SECRET ?? '',
      normaliseClientIp(user.ip) ?? '',
      day,
    );
    expect(await counterValue('ip', subject, 'route_searches')).toBe(0);
  });

  it('allows anonymous accounts 30 per salted IP per UTC day, whichever account asks', async () => {
    const { day, app, path } = await searchScenario();
    const ip = uniqueIp();
    const subject = await saltedIpSubject(
      testEnv.IP_SALT_SECRET ?? '',
      normaliseClientIp(ip) ?? '',
      day,
    );
    await seedSearches('ip', subject, day, 29);
    const first = await signInAnonymously(ip);
    expect((await app.get(path, first)).status).toBe(200);
    expect(await counterValue('ip', subject, 'route_searches')).toBe(30);
    expect(await counterValue('user', first.userId, 'route_searches')).toBe(1);

    const second = await signInAnonymously(ip);
    const refused = await app.get(path, second);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: 'cap_exceeded',
      cap: 'route_searches',
      limit: 30,
    });
    // The refused search gave its own user slot back.
    expect(await counterValue('user', second.userId, 'route_searches')).toBe(0);
    // Another address is another allowance; a signed-in account is not held by the address.
    expect((await app.get(path, await signInAnonymously())).status).toBe(200);
    expect((await app.get(path, await signedInSession(ip))).status).toBe(200);
  });
});

describe('the deployed Worker', () => {
  it('mounts both routes behind a session', async () => {
    for (const path of [
      '/v1/airports/JFK/board',
      '/v1/airports/JFK/flights/to/LHR?date=2026-10-02',
    ]) {
      const response = await worker(jsonRequest(path, 'GET', undefined));
      expect(response.status, path).toBe(401);
    }
    const anonymous = await signInAnonymously();
    const unknown = await worker(
      jsonRequest('/v1/airports/ZZZ5/board', 'GET', undefined, {
        ip: anonymous.ip,
        cookie: anonymous.cookie,
      }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'airport_not_found' });
  });
});
