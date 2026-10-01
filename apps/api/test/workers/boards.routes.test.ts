/**
 * Rulings B7 and B8 (increment 18, part 2): the board and the route search through the Worker's
 * chain (session, `BOARD_RL`, validation, airport resolution, KV, `AirportState`, the budget) with
 * FIDS stubbed inside the object. A board comes from a cold bucket with one FIDS call, then from
 * KV with none; the ETag answers 304; filters run after the cache; a schedules-only airport
 * carries its badge; an uncovered one is 404. The route search reads both buckets of the
 * origin-local date, keeps the departures to the destination grouped by codeshare, and answers
 * the designator search's 422 past the lookahead. A row's `add` subscribes through the existing
 * `POST /v1/flights`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  boardBucketBounds,
  boardKvKey,
  utcMsToLocalMinute,
  type FlightKey,
  type AirportBoardResponse,
  type BoardBucketBounds,
  type RouteSearchResponse,
} from '@planeahead/shared';
import { providerSettings } from '../../src/providers/config';
import { airportHarness, feeds, uniqueDay, type AirportHarness } from './helpers/airports';
import {
  boardApp,
  fidsFlight,
  insertBoardAirport,
  signedInSession,
  type BoardApp,
  type BoardSession,
  type TestAirport,
} from './helpers/boards';
import {
  HOUR_MS,
  MINUTE_MS,
  adbOk,
  drainTouched,
  scriptAdb,
  testEnv,
  type TestFlight,
} from './helpers/flights';
import { counterValue, openTodaysBudget, subscribe, type SubscribeBody } from './helpers/routes';

afterEach(drainTouched);

const NY = 'America/New_York';
const AA = { iata: 'AA', icao: 'AAL' };
const BA = { iata: 'BA', icao: 'BAW' };
const IB = { iata: 'IB', icao: 'IBE' };
const DL = { iata: 'DL', icao: 'DAL' };

function boundsOf(bucket: string, tz = NY): BoardBucketBounds {
  const bounds = boardBucketBounds(bucket, tz);
  if (bounds === null) {
    throw new Error(`no bounds for ${bucket}`);
  }
  return bounds;
}

interface BoardScenario {
  readonly home: TestAirport;
  readonly london: TestAirport;
  readonly bucket: string;
  readonly bounds: BoardBucketBounds;
  /** The Worker's and the object's clock at the start: an hour into the PM bucket. */
  readonly now: number;
  readonly harness: AirportHarness;
  readonly app: BoardApp;
  readonly session: BoardSession;
  setWorkerClock(ms: number): void;
}

/**
 * A PM bucket at a fresh airport: AA100 to London with two codeshares 30 minutes from now,
 * DL40 to London in 2 hours, BA117 arriving from London in an hour.
 */
async function boardScenario(health?: () => Response): Promise<BoardScenario> {
  const [home, london] = await Promise.all([
    insertBoardAirport(NY),
    insertBoardAirport('Europe/London'),
  ]);
  const bucket = `${uniqueDay()}T12:00`;
  const bounds = boundsOf(bucket);
  const now = bounds.startMs + HOUR_MS;
  const leg = (homeMs: number, farMs: number) => ({ homeTz: NY, homeMs, far: london, farMs });
  const aa100 = { reg: 'N101NN', ...leg(now + 30 * MINUTE_MS, now + 7 * HOUR_MS) };
  const fids = {
    departures: [
      fidsFlight('dep', {
        number: 'BA 1511',
        airline: BA,
        codeshareStatus: 'IsCodeshared',
        ...aa100,
      }),
      fidsFlight('dep', { number: 'AA 100', airline: AA, codeshareStatus: 'IsOperator', ...aa100 }),
      fidsFlight('dep', {
        number: 'IB 4218',
        airline: IB,
        codeshareStatus: 'IsCodeshared',
        ...aa100,
      }),
      fidsFlight('dep', {
        number: 'DL 40',
        airline: DL,
        reg: 'N40DL',
        ...leg(now + 2 * HOUR_MS, now + 9 * HOUR_MS),
      }),
    ],
    arrivals: [
      fidsFlight('arr', {
        number: 'BA 117',
        airline: BA,
        reg: 'GXLEA',
        ...leg(now + HOUR_MS, now - 7 * HOUR_MS),
      }),
    ],
  };
  const harness = await airportHarness(fids, now, NY, home.icao);
  if (health !== undefined) {
    harness.adb.health = health;
  }
  let clock = now;
  const app = boardApp({ nowMs: () => clock });
  const session = await signedInSession();
  return {
    home,
    london,
    bucket,
    bounds,
    now,
    harness,
    app,
    session,
    setWorkerClock: (ms) => {
      clock = ms;
    },
  };
}

function boardPath(s: BoardScenario, query = ''): string {
  return `/v1/airports/${s.home.iata}/board${query}`;
}

describe('GET /v1/airports/{code}/board (rulings B7 and B8)', () => {
  it('fills a cold bucket with one FIDS call, then serves KV with none', async () => {
    const s = await boardScenario();
    const first = await s.app.get(boardPath(s), s.session);
    expect(first.status).toBe(200);
    const body = await first.json<AirportBoardResponse>();
    expect(body).toMatchObject({
      airport: { icao: s.home.icao, iata: s.home.iata, name: s.home.name, tz: NY },
      direction: 'departures',
      from: new Date(s.bounds.startMs).toISOString(),
      to: new Date(s.bounds.startMs + 12 * HOUR_MS).toISOString(),
      coverage: 'live',
      fetchedAt: new Date(s.now).toISOString(),
      stale: false,
      partial: false,
    });
    expect(body.rows.map((row) => [row.designator, row.codeshares])).toEqual([
      ['AA100', ['BA1511', 'IB4218']],
      ['DL40', []],
    ]);
    expect(body.rows[0]).toMatchObject({
      airlineIata: 'AA',
      operatingCarrierIcao: 'AAL',
      counterpart: { icao: s.london.icao, iata: s.london.iata },
      add: { number: 'AA100', date: s.bucket.slice(0, 10), origin: s.home.icao },
    });
    expect(JSON.stringify(body)).not.toContain('N101NN');
    expect(s.harness.adb.fidsCalls()).toBe(1);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    await s.harness.settled();
    const copy = await testEnv.CACHE.getWithMetadata(boardKvKey(s.home.icao, s.bucket));
    expect(copy.metadata).toMatchObject({ fetchedAt: new Date(s.now).toISOString() });

    // The object's clock moves past freshUntil (5 minutes, the bucket is current) while the
    // Worker's stays inside it: a request that reached the object would get the copy stale and
    // start a refresh. One served from KV does neither.
    await s.harness.setClock(s.now + 6 * MINUTE_MS);
    s.setWorkerClock(s.now + 2 * MINUTE_MS);
    const second = await s.app.get(boardPath(s), s.session);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(body);
    expect(second.headers.get('etag')).toBe(etag);
    await s.harness.settled();
    expect(s.harness.adb.fidsCalls()).toBe(1);
  });

  it('answers If-None-Match with 304 for the current tag, and 200 for another', async () => {
    const s = await boardScenario();
    const first = await s.app.get(boardPath(s), s.session);
    const etag = first.headers.get('etag') ?? '';
    const notModified = await s.app.get(boardPath(s), s.session, { 'if-none-match': etag });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe('');
    expect(notModified.headers.get('etag')).toBe(etag);
    const listed = await s.app.get(boardPath(s), s.session, {
      'if-none-match': `W/"old", ${etag.replace(/^W\//, '')}`,
    });
    expect(listed.status).toBe(304);
    const changed = await s.app.get(boardPath(s), s.session, { 'if-none-match': 'W/"old"' });
    expect(changed.status).toBe(200);
    // Another window is another body, so another tag.
    const later = await s.app.get(boardPath(s, '?direction=arrivals'), s.session, {
      'if-none-match': etag,
    });
    expect(later.status).toBe(200);
    expect(later.headers.get('etag')).not.toBe(etag);
    expect(s.harness.adb.fidsCalls()).toBe(1);
  });

  it('filters after the cache: direction, a window of at most 12 hours, an airline', async () => {
    const s = await boardScenario();
    const designators = async (query: string) => {
      const response = await s.app.get(boardPath(s, query), s.session);
      expect(response.status, query).toBe(200);
      return (await response.json<AirportBoardResponse>()).rows.map((row) => row.designator);
    };
    expect(await designators('?direction=arrivals')).toEqual(['BA117']);
    expect(await designators('?airline=IB')).toEqual(['AA100']);
    expect(await designators('?airline=dal')).toEqual(['DL40']);
    expect(await designators('?airline=BA&direction=arrivals')).toEqual(['BA117']);
    const from = new Date(s.now + HOUR_MS).toISOString();
    const to = new Date(s.now + 3 * HOUR_MS).toISOString();
    expect(await designators(`?from=${from}&to=${to}`)).toEqual(['DL40']);
    // One end alone: 12 hours from it. From the bucket's start that is the bucket itself.
    const start = new Date(s.bounds.startMs).toISOString();
    expect(await designators(`?from=${start}`)).toEqual(['AA100', 'DL40']);
    expect(s.harness.adb.fidsCalls()).toBe(1);
    // Twelve hours back from an hour ahead reaches into the morning bucket: it is read too.
    expect(await designators(`?to=${from}`)).toEqual(['AA100']);
    expect(s.harness.adb.fidsCalls()).toBe(2);
    expect(s.harness.adb.calls.filter((call) => call.includes('/flights/airports/'))).toEqual([
      expect.stringContaining(`/${s.bucket}/`),
      expect.stringContaining(`/${s.bucket.slice(0, 10)}T00:00/`),
    ]);

    for (const [query, path] of [
      [`?from=${to}&to=${from}`, 'to'],
      [`?from=${from}&to=${new Date(s.now + 13 * HOUR_MS + 1).toISOString()}`, 'to'],
      ['?direction=both', 'direction'],
      ['?airline=A', 'airline'],
      ['?from=yesterday', 'from'],
    ] as const) {
      const response = await s.app.get(boardPath(s, query), s.session);
      expect(response.status, query).toBe(400);
      const body = await response.json<{ error: string; issues: { path: string[] }[] }>();
      expect(body.error).toBe('validation_failed');
      expect(body.issues[0]?.path, query).toEqual([path]);
    }
  });

  it('carries the schedules-only badge, and answers 404 for an airport not covered, with no FIDS call', async () => {
    const schedules = await boardScenario(() => feeds('OK', 'NoData'));
    const badge = await schedules.app.get(boardPath(schedules), schedules.session);
    expect(badge.status).toBe(200);
    expect(await badge.json<AirportBoardResponse>()).toMatchObject({
      coverage: 'schedules_only',
      stale: false,
    });

    const uncovered = await boardScenario(() => feeds('NoData', 'NoData'));
    const missing = await uncovered.app.get(boardPath(uncovered), uncovered.session);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'board_not_covered' });
    expect(uncovered.harness.adb.fidsCalls()).toBe(0);
  });

  it('answers 404 for an unknown airport, 422 past the lookahead, 503 when nothing is readable', async () => {
    const s = await boardScenario();
    const unknown = await s.app.get('/v1/airports/ZZZ9/board', s.session);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'airport_not_found' });

    const maxDaysAhead = providerSettings(testEnv).adbPlan.maxDaysAhead;
    const far = new Date(s.now + (maxDaysAhead + 2) * 24 * HOUR_MS).toISOString();
    const tooFar = await s.app.get(boardPath(s, `?from=${far}`), s.session);
    expect(tooFar.status).toBe(422);
    expect(await tooFar.json()).toMatchObject({ error: 'date_out_of_range', maxDaysAhead });
    expect(s.harness.adb.fidsCalls()).toBe(0);

    s.harness.adb.fids = () => Response.json({ message: 'boom' }, { status: 500 });
    const failed = await s.app.get(boardPath(s), s.session);
    expect(failed.status).toBe(503);
    expect(failed.headers.get('retry-after')).toBe('30');
    expect(await failed.json()).toMatchObject({ error: 'board_unavailable' });
    expect(s.harness.adb.fidsCalls()).toBe(1);
  });
});

const AF = { iata: 'AF', icao: 'AFR' };
const UA = { iata: 'UA', icao: 'UAL' };

interface RouteScenario {
  readonly origin: TestAirport;
  readonly destination: TestAirport;
  readonly day: string;
  readonly now: number;
  readonly harness: AirportHarness;
  readonly app: BoardApp;
  readonly session: BoardSession;
}

/**
 * Both buckets of one origin-local date. Morning: AA10 to the destination with BA8010 on it,
 * AA11 elsewhere, AA12 arriving FROM the destination. Evening: DL20 to the destination with
 * AF21 on it (one callsign), and UA22, earlier. The clock is the evening before.
 */
async function routeScenario(): Promise<RouteScenario> {
  const [origin, destination, london] = await Promise.all([
    insertBoardAirport(NY),
    insertBoardAirport('America/Chicago'),
    insertBoardAirport('Europe/London'),
  ]);
  const day = uniqueDay();
  const am = boundsOf(`${day}T00:00`);
  const pm = boundsOf(`${day}T12:00`);
  const now = am.startMs - 2 * HOUR_MS;
  const at = (bounds: BoardBucketBounds, hours: number) => bounds.startMs + hours * HOUR_MS;
  const dep = (
    number: string,
    airline: { iata: string; icao: string },
    homeMs: number,
    far: TestAirport,
    extra: { reg?: string; callSign?: string; codeshareStatus?: 'IsCodeshared' },
  ) =>
    fidsFlight('dep', {
      number,
      airline,
      homeTz: NY,
      homeMs,
      far,
      farMs: homeMs + 3 * HOUR_MS,
      ...extra,
    });
  const morning = {
    departures: [
      dep('BA 8010', BA, at(am, 8), destination, { reg: 'N10AA', codeshareStatus: 'IsCodeshared' }),
      dep('AA 10', AA, at(am, 8), destination, { reg: 'N10AA' }),
      dep('AA 11', AA, at(am, 9), london, { reg: 'N11AA' }),
    ],
    arrivals: [
      fidsFlight('arr', {
        number: 'AA 12',
        airline: AA,
        reg: 'N12AA',
        homeTz: NY,
        homeMs: at(am, 10),
        far: destination,
        farMs: at(am, 7),
      }),
    ],
  };
  const evening = {
    departures: [
      dep('DL 20', DL, at(pm, 3), destination, { callSign: 'DAL20' }),
      dep('AF 21', AF, at(pm, 3), destination, {
        callSign: 'DAL20',
        codeshareStatus: 'IsCodeshared',
      }),
      dep('UA 22', UA, at(pm, 1), destination, { reg: 'N22UA' }),
    ],
    arrivals: [],
  };
  const harness = await airportHarness(morning, now, NY, origin.icao);
  harness.adb.fids = (url) =>
    Response.json(url.pathname.includes(`/${day}T00:00/`) ? morning : evening);
  const app = boardApp({ nowMs: () => now });
  return { origin, destination, day, now, harness, app, session: await signedInSession() };
}

function routePath(
  r: RouteScenario,
  date: string = r.day,
  destination = r.destination.icao,
): string {
  return `/v1/airports/${r.origin.iata}/flights/to/${destination}?date=${date}`;
}

describe('GET /v1/airports/{origin}/flights/to/{destination} (ruling B8)', () => {
  it('reads both buckets of the date and keeps the departures to the destination, grouped', async () => {
    const r = await routeScenario();
    const response = await r.app.get(routePath(r), r.session);
    expect(response.status).toBe(200);
    const body = await response.json<RouteSearchResponse>();
    expect(body).toMatchObject({
      origin: { icao: r.origin.icao, iata: r.origin.iata, tz: NY },
      destination: { icao: r.destination.icao, tz: 'America/Chicago' },
      date: r.day,
      coverage: 'live',
      fetchedAt: new Date(r.now).toISOString(),
      stale: false,
      partial: false,
    });
    expect(body.flights.map((flight) => [flight.designator, flight.codeshares])).toEqual([
      ['AA10', ['BA8010']],
      ['UA22', []],
      ['DL20', ['AF21']],
    ]);
    for (const flight of body.flights) {
      expect(flight.add).toEqual({ number: flight.designator, date: r.day, origin: r.origin.icao });
    }
    expect(response.headers.get('etag')).toMatch(/^W\//);
    expect(r.harness.adb.fidsCalls()).toBe(2);

    // Both calls are attributed to the search and to the origin (ruling B10).
    await r.harness.settled();
    const calls = r.harness.sent.flatMap((message) =>
      message.kind === 'provider_call' ? [message.payload] : [],
    );
    expect(calls.filter((call) => call.operation === 'fids')).toEqual([
      expect.objectContaining({ trigger: 'route_search', airportIcao: r.origin.icao }),
      expect.objectContaining({ trigger: 'route_search', airportIcao: r.origin.icao }),
    ]);
    expect(await counterValue('user', r.session.userId, 'route_searches')).toBe(1);

    // Again: from KV, no call, one more search counted.
    const again = await r.app.get(routePath(r), r.session);
    expect(await again.json()).toEqual(body);
    expect(r.harness.adb.fidsCalls()).toBe(2);
    expect(await counterValue('user', r.session.userId, 'route_searches')).toBe(2);
  });

  it('answers the designator search 422 past the lookahead, and for a date long gone, charging nothing', async () => {
    const r = await routeScenario();
    const maxDaysAhead = providerSettings(testEnv).adbPlan.maxDaysAhead;
    const beyond = new Date(r.now + (maxDaysAhead + 2) * 24 * HOUR_MS).toISOString().slice(0, 10);
    const tooFar = await r.app.get(routePath(r, beyond), r.session);
    expect(tooFar.status).toBe(422);
    expect(await tooFar.json()).toMatchObject({ error: 'date_out_of_range', maxDaysAhead });

    const past = new Date(r.now - 5 * 24 * HOUR_MS).toISOString().slice(0, 10);
    const gone = await r.app.get(routePath(r, past), r.session);
    expect(gone.status).toBe(422);
    expect(await gone.json()).toMatchObject({ error: 'date_out_of_range' });
    expect(r.harness.adb.fidsCalls()).toBe(0);
    expect(await counterValue('user', r.session.userId, 'route_searches')).toBe(0);
  });

  it('answers 404 for an unknown destination and 400 when it is the origin', async () => {
    const r = await routeScenario();
    const unknown = await r.app.get(routePath(r, r.day, 'ZZZ8'), r.session);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: 'airport_not_found' });
    const same = await r.app.get(routePath(r, r.day, r.origin.icao), r.session);
    expect(same.status).toBe(400);
    expect(await same.json()).toMatchObject({ error: 'validation_failed' });
    const noDate = await r.app.get(routePath(r, r.day).replace(/\?date=.*$/, ''), r.session);
    expect(noDate.status).toBe(400);
    expect(r.harness.adb.fidsCalls()).toBe(0);
  });
});

describe('adding a flight from a board (ruling B8)', () => {
  it("posts the row's add, unchanged, to the existing POST /v1/flights", async () => {
    const [home, london] = await Promise.all([
      insertBoardAirport(NY),
      insertBoardAirport('Europe/London'),
    ]);
    // Thirty days ahead of the real clock: the subscribe path checks the lookahead against it.
    const number = String(1_000 + Math.floor(Math.random() * 8_000));
    const departs =
      Date.parse(`${new Date().toISOString().slice(0, 10)}T15:00:00Z`) + 30 * 24 * HOUR_MS;
    const dateLocal = (utcMsToLocalMinute(departs, NY) ?? '').slice(0, 10);
    const flight: TestFlight = {
      designator: `AA${number}`,
      number,
      dateLocal,
      flightKey: `AAL-${number}-${dateLocal}-${home.icao}` as FlightKey,
      scheduledOut: new Date(departs),
      scheduledIn: new Date(departs + 7 * HOUR_MS),
      originTz: NY,
    };
    const now = departs - HOUR_MS;
    const fids = {
      departures: [
        fidsFlight('dep', {
          number: `AA ${number}`,
          airline: AA,
          reg: 'N718AN',
          homeTz: NY,
          homeMs: departs,
          far: london,
          farMs: departs + 7 * HOUR_MS,
        }),
      ],
      arrivals: [],
    };
    await airportHarness(fids, now, NY, home.icao);
    const app = boardApp({ nowMs: () => now });
    const session = await signedInSession();
    const board = await app.get(`/v1/airports/${home.icao}/board`, session);
    expect(board.status).toBe(200);
    const row = (await board.json<AirportBoardResponse>()).rows.find(
      (candidate) => candidate.designator === flight.designator,
    );
    expect(row?.add).toEqual({ number: flight.designator, date: dateLocal, origin: home.icao });

    await openTodaysBudget();
    await scriptAdb(flight, [
      adbOk(flight, {
        phase: 'expected',
        origin: { icao: home.icao, iata: home.iata, name: home.name, timeZone: NY },
      }),
    ]);
    const subscribed = await subscribe(session, { ...row?.add });
    expect(subscribed.status).toBe(201);
    const body = await subscribed.json<SubscribeBody>();
    expect(body.subscription.flightKey).toBe(flight.flightKey);
  });
});
