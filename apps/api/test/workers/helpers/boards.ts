/**
 * Board and route-search route harness (increment 18, part 2). Airports are synthetic rows in the
 * API test database (it has no reference data), each named by a unique ICAO code so its
 * `AirportState` object is fresh; FIDS is the counting fake of `helpers/airports.ts`, injected
 * into that object. The routes run in `createApp()` with `createV1Routes({ airports })`, the
 * Worker's own chain, so a test can set the Worker's clock to the object's, count `BOARD_RL` and
 * `BOARD_IP_RL`, and switch the boards off. No real provider is ever called.
 */

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { airports } from '@planeahead/db';
import { utcMsToLocalMinute } from '@planeahead/shared';
import { createApp } from '../../../src/app';
import { createV1Routes } from '../../../src/routes/v1';
import { API_ORIGIN, APP_ORIGIN, signInWithMagicLink, uniqueEmail, uniqueIp } from './auth';
import { uniqueAirport } from './airports';
import { testEnv, track } from './flights';
import { db } from './routes';

export interface TestAirport {
  readonly icao: string;
  readonly iata: string;
  readonly name: string;
  readonly tz: string;
}

/**
 * A synthetic airport with a real-looking ICAO code (`icao_source = 'icao_code'`). It writes
 * through the file's one database handle (`db()`, helpers/routes.ts), never a client per call: a
 * client keeps its sockets until the file's isolate ends, so a client per airport exhausted the
 * cluster's `max_connections` in the full suite (increment 18, R0).
 */
export async function insertBoardAirport(tz = 'America/New_York'): Promise<TestAirport> {
  const icao = uniqueAirport();
  const airport = { icao, iata: icao.slice(1), name: `Test Field ${icao}`, tz };
  await db()
    .insert(airports)
    .values({
      ourairportsId: 900_000_000 + Math.floor(Math.random() * 99_000_000),
      ident: icao,
      icao,
      icaoSource: 'icao_code',
      iata: airport.iata,
      name: airport.name,
      type: 'large_airport',
      latitude: 40,
      longitude: -73,
      isoCountry: 'US',
      tz,
      tzSource: 'override',
    });
  return airport;
}

/** An AeroDataBox `DateTimeContract`: `.utc` as the instant, `.local` the zone's wall clock. */
export function adbTime(ms: number, tz: string): { utc: string; local: string } {
  const local = utcMsToLocalMinute(ms, tz) ?? '';
  return {
    utc: `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`,
    local: local.replace('T', ' '),
  };
}

export interface FidsFlightInput {
  /** `AA 100`, as FIDS spells it. */
  readonly number: string;
  readonly airline: { readonly iata: string; readonly icao: string };
  readonly codeshareStatus?: 'IsOperator' | 'IsCodeshared' | 'Unknown';
  readonly reg?: string;
  readonly callSign?: string;
  /** The board's own airport's zone: the home leg's local time. */
  readonly homeTz: string;
  readonly homeMs: number;
  /** The other end of the flight. */
  readonly far: TestAirport;
  readonly farMs: number;
}

/** One `withLeg=true` FIDS item; `direction` decides which leg is home. */
export function fidsFlight(direction: 'dep' | 'arr', input: FidsFlightInput): unknown {
  const home = { scheduledTime: adbTime(input.homeMs, input.homeTz), quality: ['Basic'] };
  const away = {
    airport: {
      icao: input.far.icao,
      iata: input.far.iata,
      name: input.far.name,
      timeZone: input.far.tz,
    },
    scheduledTime: adbTime(input.farMs, input.far.tz),
    quality: ['Basic'],
  };
  return {
    number: input.number,
    ...(input.callSign === undefined ? {} : { callSign: input.callSign }),
    status: 'Expected',
    codeshareStatus: input.codeshareStatus ?? 'IsOperator',
    isCargo: false,
    airline: { name: input.airline.iata, ...input.airline },
    aircraft: { ...(input.reg === undefined ? {} : { reg: input.reg }), model: 'Airbus A321' },
    departure: direction === 'dep' ? home : away,
    arrival: direction === 'dep' ? away : home,
  };
}

export interface BoardSession {
  readonly userId: string;
  readonly cookie: string;
  readonly ip: string;
}

/** A signed-in (not anonymous) account, through the real magic-link flow. */
export async function signedInSession(ip: string = uniqueIp()): Promise<BoardSession> {
  const session = await signInWithMagicLink(uniqueEmail('boards'), { ip });
  return { userId: session.userId, cookie: session.cookie, ip };
}

export interface BoardAppOptions {
  /** The Worker's clock; the AirportState object's is set apart (`_setClock`). */
  readonly nowMs: () => number;
  /** What the `BOARD_RL` stub (per user) allows per key per test; unlimited by default. */
  readonly limit?: number;
  /** What the `BOARD_IP_RL` stub (per /64) allows per key per test; unlimited by default. */
  readonly ipLimit?: number;
  /** The Worker's bindings and variables; `testEnv` (BOARDS_ENABLED "true") by default. */
  readonly env?: typeof testEnv;
}

export interface BoardApp {
  get(path: string, session: BoardSession, headers?: Record<string, string>): Promise<Response>;
  /** Every brake taken, in order: `BOARD_RL user:{id}` or `BOARD_IP_RL ip:{address or /64}`. */
  readonly limiterKeys: string[];
}

/** The Worker's chain with the airport routes' clock, `BOARD_RL` and `BOARD_IP_RL` replaced. */
export function boardApp(options: BoardAppOptions): BoardApp {
  const counts = new Map<string, number>();
  const limiterKeys: string[] = [];
  const stub =
    (binding: 'BOARD_RL' | 'BOARD_IP_RL', limit = Number.POSITIVE_INFINITY) =>
    () => ({
      limit: ({ key }: { key: string }) => {
        const taken = `${binding} ${key}`;
        limiterKeys.push(taken);
        const next = (counts.get(taken) ?? 0) + 1;
        counts.set(taken, next);
        return Promise.resolve({ success: next <= limit });
      },
    });
  const allow = () => ({ limit: () => Promise.resolve({ success: true }) });
  const app = createApp({ limiter: allow });
  app.route(
    '/v1',
    createV1Routes({
      airports: {
        now: options.nowMs,
        limiter: stub('BOARD_RL', options.limit),
        ipLimiter: stub('BOARD_IP_RL', options.ipLimit),
      },
    }),
  );
  return {
    limiterKeys,
    get: async (path, session, headers = {}) => {
      const ctx = createExecutionContext();
      const response = await app.fetch(
        new Request(`${API_ORIGIN}${path}`, {
          headers: {
            'cf-connecting-ip': session.ip,
            cookie: session.cookie,
            origin: APP_ORIGIN,
            ...headers,
          },
        }),
        options.env ?? testEnv,
        ctx,
      );
      await waitOnExecutionContext(ctx);
      return response;
    },
  };
}

/**
 * Lifts the per-second limit of the AeroDataBox budget of `nowMs`'s UTC day (Starter allows 5),
 * so a test that fills several buckets within one second is not refused by the token bucket.
 */
export async function openBoardBudget(nowMs: number): Promise<void> {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const budget = track(
    testEnv.PROVIDER_BUDGET.getByName(`aerodatabox:${day}`, { locationHint: 'enam' }),
  );
  await budget.configure({ perSecondLimit: 1_000 });
}
