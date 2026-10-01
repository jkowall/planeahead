/**
 * Ruling B9 (increment 18, part 2) and the review round's R8, R11 and R15: `BOARD_RL` (per user,
 * 30) and `BOARD_IP_RL` (per /64, 300) in every environment, both taken on both routes; the
 * anonymous airport limit (only airports of live subscriptions); the route-search caps in
 * `usage_counters` (per user, and per salted IP for anonymous accounts), whose 403 names its
 * scope; `BOARDS_ENABLED` (off answers 404 `boards_disabled`); and that both routes admit only a
 * session principal, mounted behind a session in the deployed Worker.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { boardBucketBounds, uuidv7, type AirportBoardResponse } from '@planeahead/shared';
import { flightInstances, flightSubscriptions } from '@planeahead/db';
import wranglerConfig from '../../wrangler.jsonc?raw';
import type { AuthenticatedUser } from '../../src/auth/user';
import type { AppBindings } from '../../src/env';
import { saltedIpSubject } from '../../src/lib/hmac';
import { createAirportRoutes } from '../../src/routes/airports';
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

/** Every `{ "name": NAME, ... "simple": { "limit", "period" } }` entry of wrangler.jsonc. */
function rateLimitEntries(name: string) {
  const entry = new RegExp(
    `\\{ "name": "${name}", "namespace_id": "(\\d+)", "simple": \\{ "limit": (\\d+), "period": (\\d+) \\} \\}`,
    'g',
  );
  return [...wranglerConfig.matchAll(entry)].map((match) => ({
    id: match[1],
    limit: Number(match[2]),
    period: Number(match[3]),
  }));
}

describe('BOARD_RL and BOARD_IP_RL (rulings B9 and R11)', () => {
  it('are 30 per user and 300 per /64 per 60 s, with their own namespaces in every environment', () => {
    const perUser = rateLimitEntries('BOARD_RL');
    const perAddress = rateLimitEntries('BOARD_IP_RL');
    expect(perUser.map(({ limit, period }) => ({ limit, period }))).toEqual(
      Array.from({ length: 3 }, () => ({ limit: 30, period: 60 })),
    );
    expect(perAddress.map(({ limit, period }) => ({ limit, period }))).toEqual(
      Array.from({ length: 3 }, () => ({ limit: 300, period: 60 })),
    );
    // Next to BOARD_RL's ids: local 3005, staging 1005, production 2005.
    expect(perAddress.map(({ id }) => id)).toEqual(['3005', '1005', '2005']);
    const ids = [...wranglerConfig.matchAll(/"namespace_id": "(\d+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('takes BOARD_RL by user and BOARD_IP_RL by address on both routes, each refusing past its own limit', async () => {
    // Stand-in limits (the real ones are pinned above): 2 per user, 3 per address.
    const app = boardApp({ nowMs: () => clockOfNewDay(), limit: 2, ipLimit: 3 });
    const ip = uniqueIp();
    // Signed in from their own addresses (Better Auth allows 3 sign-ins a minute per address),
    // then all behind one.
    const behind = async (): Promise<BoardSession> => ({ ...(await signedInSession()), ip });
    const [alice, bob, carol] = [await behind(), await behind(), await behind()];
    const board = (session: BoardSession) => app.get('/v1/airports/ZZZ7/board', session);
    expect((await board(alice)).status).toBe(404);
    expect((await board(alice)).status).toBe(404);
    expect(app.limiterKeys.slice(0, 2)).toEqual([
      `BOARD_RL user:${alice.userId}`,
      `BOARD_IP_RL ip:${ip}`,
    ]);
    const refused = await board(alice);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('60');
    expect(await refused.json()).toMatchObject({ error: 'rate_limited', limiter: 'BOARD_RL' });
    // The same account from another address is still refused by the user key ...
    expect((await board({ ...alice, ip: uniqueIp() })).status).toBe(429);
    // ... another account behind the address has the address's third request ...
    expect((await board(bob)).status).toBe(404);
    // ... and a third account is refused by the address key.
    const crowded = await board(carol);
    expect(crowded.status).toBe(429);
    expect(crowded.headers.get('retry-after')).toBe('60');
    expect(await crowded.json()).toMatchObject({ error: 'rate_limited', limiter: 'BOARD_IP_RL' });

    // The route search takes the same two brakes.
    const dave = await signedInSession();
    const route = await app.get('/v1/airports/ZZZ7/flights/to/ZZZ6?date=2101-01-01', dave);
    expect(route.status).toBe(404);
    expect(app.limiterKeys.slice(-2)).toEqual([
      `BOARD_RL user:${dave.userId}`,
      `BOARD_IP_RL ip:${dave.ip}`,
    ]);
  });

  it('keys BOARD_IP_RL by the /64: three addresses in one subnet share one allowance', async () => {
    const app = boardApp({ nowMs: () => clockOfNewDay(), ipLimit: 2 });
    const group = () => Math.floor(Math.random() * 0xffff).toString(16);
    const prefix = `2001:db8:${group()}:${group()}`;
    const slash64 = `${prefix
      .split(':')
      .map((part) => part.padStart(4, '0'))
      .join(':')}:0000:0000:0000:0000`;
    const subnet = [`${prefix}::1`, `${prefix}:1::2`, `${prefix}:ffff:1:2:3`];
    const statuses: number[] = [];
    for (const address of subnet) {
      expect(normaliseClientIp(address)).toBe(slash64);
      const session = await signedInSession();
      statuses.push((await app.get('/v1/airports/ZZZ7/board', { ...session, ip: address })).status);
    }
    expect(statuses).toEqual([404, 404, 429]);
    expect(app.limiterKeys.filter((key) => key.startsWith('BOARD_IP_RL'))).toEqual(
      subnet.map(() => `BOARD_IP_RL ip:${slash64}`),
    );
    // Another /64 is another allowance.
    const elsewhere = { ...(await signedInSession()), ip: `2001:db8:${group()}:${group()}::1` };
    expect((await app.get('/v1/airports/ZZZ7/board', elsewhere)).status).toBe(404);
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

describe('the route-search caps (rulings B9, B10 and R11)', () => {
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
      scope: 'user',
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
    // The network's allowance, not this account's (R11): the app says to sign in.
    expect(await refused.json()).toMatchObject({
      error: 'cap_exceeded',
      cap: 'route_searches',
      limit: 30,
      scope: 'ip',
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

/** The Worker's env with `BOARDS_ENABLED` absent, or set to `value` (production's is "false"). */
function envWithBoards(value: string | null): typeof testEnv {
  const rest = Object.fromEntries(
    Object.entries(testEnv).filter(([key]) => key !== 'BOARDS_ENABLED'),
  );
  return (value === null ? rest : { ...rest, BOARDS_ENABLED: value }) as typeof testEnv;
}

describe('BOARDS_ENABLED (R8)', () => {
  it('is "true" in local and staging and "false" in production', () => {
    expect(testEnv.BOARDS_ENABLED).toBe('true');
    expect([...wranglerConfig.matchAll(/"BOARDS_ENABLED": "true"/g)]).toHaveLength(2);
    const production = wranglerConfig.slice(wranglerConfig.indexOf('"production": {'));
    expect(production).toContain('"ENVIRONMENT": "production"');
    // Explicitly off, so a production deploy does not warn that a top-level var is missing
    // there (copying "true" would quiet that warning by switching boards on).
    expect([...production.matchAll(/"BOARDS_ENABLED": "(\w+)"/g)].map((m) => m[1])).toEqual([
      'false',
    ]);
  });

  it('answers 404 boards_disabled on both routes while off, before any brake or lookup', async () => {
    const paths = ['/v1/airports/ZZZ4/board', '/v1/airports/ZZZ4/flights/to/ZZZ3?date=2101-01-01'];
    const session = await signedInSession();
    // Only exactly "true" is on: a dashboard's `TRUE` or ` true ` is off (the re-review's N6).
    for (const value of [null, 'false', 'TRUE', ' true ']) {
      const app = boardApp({ nowMs: () => clockOfNewDay(), env: envWithBoards(value) });
      for (const path of paths) {
        const response = await app.get(path, session);
        expect(response.status, `${String(value)} ${path}`).toBe(404);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toMatchObject({
          error: 'boards_disabled',
          message: 'airport boards are not available yet',
        });
      }
      expect(app.limiterKeys).toEqual([]);
    }
    // On, the same requests reach the routes.
    const on = boardApp({ nowMs: () => clockOfNewDay(), env: envWithBoards('true') });
    for (const path of paths) {
      const response = await on.get(path, session);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toMatchObject({ error: 'airport_not_found' });
    }
    expect(on.limiterKeys).toHaveLength(4);
  });
});

describe('the session requirement (R15)', () => {
  /** The airport routes behind a stand-in auth that resolves `principal`, counting the brakes. */
  function probe(principal: AuthenticatedUser) {
    const taken: string[] = [];
    const counting = () => ({
      limit: ({ key }: { key: string }) => {
        taken.push(key);
        return Promise.resolve({ success: true });
      },
    });
    const app = new Hono<AppBindings>();
    app.use(async (c, next) => {
      c.set('requestId', 'probe-request-0001');
      c.set('user', principal);
      await next();
    });
    app.route('/v1/airports', createAirportRoutes({ limiter: counting, ipLimiter: counting }));
    const get = async (path: string) => {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request(`https://api.planeahead.test${path}`),
        testEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    };
    return { get, taken };
  }

  it('refuses a principal that is not a session (an API token) on both routes, whatever its scopes', async () => {
    const token = probe({
      id: uuidv7(),
      isAnonymous: false,
      kind: 'api_token',
      sessionId: '',
      scopes: ['user'],
    });
    for (const path of [
      '/v1/airports/ZZZ2/board',
      '/v1/airports/ZZZ2/flights/to/ZZZ1?date=2101-01-01',
    ]) {
      const response = await token.get(path);
      expect(response.status, path).toBe(403);
      expect(await response.json()).toMatchObject({
        error: 'insufficient_scope',
        message: 'this action needs a signed-in session',
      });
    }
    expect(token.taken).toEqual([]);

    // The same principal as a session reaches the board (the probe sends no client address, so
    // only the user brake is taken).
    const userId = uuidv7();
    const session = probe({
      id: userId,
      isAnonymous: false,
      kind: 'session',
      sessionId: 'probe-session',
      scopes: ['user'],
    });
    const board = await session.get('/v1/airports/ZZZ2/board');
    expect(board.status).toBe(404);
    expect(await board.json()).toMatchObject({ error: 'airport_not_found' });
    expect(session.taken).toEqual([`user:${userId}`]);
  });
});
