/**
 * AirportState test harness (increment 18). Every test gets its own airport (the object's name)
 * and its own UTC day far in the future (its own ProviderBudget object, and alarms the wall
 * clock never reaches); AeroDataBox is a counting fake `fetch` injected into the object, whose
 * FIDS answer can be held back to keep a call in flight. No real provider is ever called. The
 * ProviderBudget of the day the harness clock is on reads that clock too, so its token bucket
 * refills on the time a test sets, at the plan's real per-second limit. `evict()` resets the
 * object as eviction or a deploy does: memory lost, storage kept.
 */

import { runInDurableObject } from 'cloudflare:test';
import type { PersistMessageV1 } from '@planeahead/shared';
import type { AirportState } from '../../../src/do/airport-state';
import type { ProviderBudget } from '../../../src/do/provider-budget';
import { testEnv, track, untrack } from './flights';

/** A unique, well-formed ICAO name: `Q` and three base-36 characters. */
let nextAirport = Math.floor(Math.random() * 30_000);
export function uniqueAirport(): string {
  nextAirport += 1;
  return `Q${nextAirport.toString(36).toUpperCase().padStart(3, '0')}`;
}

/**
 * Unused UTC days from a random start in the 22nd century (`setAlarm` stops at 2189), 16 days
 * apart: a test may move its clock (and so the budget day its board calls reserve on) two weeks
 * on without reaching the next test's days, whose token bucket it would otherwise have spent.
 */
let nextDay = Date.UTC(2101 + Math.floor(Math.random() * 70), 0, 1);
export function uniqueDay(): string {
  nextDay += 16 * 86_400_000;
  return new Date(nextDay).toISOString().slice(0, 10);
}

/**
 * Points the AeroDataBox ProviderBudget of `ms`'s UTC day at `ms`. On the wall clock its bucket
 * would refill only in the milliseconds between a test's calls, however far the test moved its
 * own clock, and board calls keep a floor of tokens for the trackers (ruling R2): a test's
 * fourth quick board call would meet it.
 */
async function budgetClockAt(ms: number, tracked: Set<string>): Promise<void> {
  const day = new Date(ms).toISOString().slice(0, 10);
  const budget = testEnv.PROVIDER_BUDGET.getByName(`aerodatabox:${day}`, { locationHint: 'enam' });
  if (!tracked.has(day)) {
    tracked.add(day);
    track(budget);
  }
  await runInDurableObject(budget, (instance: ProviderBudget) => {
    instance.clock = () => ms;
  });
}

export interface FakeAdb {
  readonly fetch: (request: Request) => Promise<Response>;
  /** Every request's path and query, in order. */
  readonly calls: string[];
  /** FIDS requests so far. */
  readonly fidsCalls: () => number;
  readonly healthCalls: () => number;
  /** Holds every FIDS answer until `release()`. */
  hold(): void;
  release(): void;
  /** What FIDS answers next (default: the body given at creation); sees the request's URL. */
  fids: (url: URL) => Response;
  health: () => Response;
}

export function feeds(schedules: string, live: string): Response {
  return Response.json({
    flightSchedulesFeed: { service: 'FlightSchedules', status: schedules },
    liveFlightUpdatesFeed: { service: 'LiveFlightUpdates', status: live },
    adsbUpdatesFeed: { service: 'AdsbUpdates', status: 'OK' },
  });
}

export function fakeAdb(body: unknown): FakeAdb {
  const calls: string[] = [];
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  const adb: FakeAdb = {
    calls,
    fidsCalls: () => calls.filter((call) => call.includes('/flights/airports/')).length,
    healthCalls: () => calls.filter((call) => call.includes('/health/')).length,
    hold() {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release() {
      open?.();
      gate = null;
    },
    fids: () => Response.json(body),
    health: () => feeds('OK', 'OK'),
    fetch: async (request) => {
      const url = new URL(request.url);
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname.includes('/health/')) {
        return adb.health();
      }
      if (gate !== null) {
        await gate;
      }
      return adb.fids(url);
    },
  };
  return adb;
}

export interface AirportHarness {
  /** The object's stub; a new one after `evict()`. */
  readonly stub: DurableObjectStub<AirportState>;
  readonly icao: string;
  readonly tz: string;
  readonly adb: FakeAdb;
  /** What the object sent to `persist`. */
  readonly sent: PersistMessageV1[];
  setClock(ms: number): Promise<void>;
  /** Waits for the object's background refreshes, KV writes and sends. */
  settled(): Promise<void>;
  /**
   * Waits until `n` FIDS requests have reached the fake, by asking the object (whose input gate
   * is open while it waits on the network) rather than through a promise the object resolves:
   * workerd refuses I/O across Durable Object contexts, the test runner's included.
   */
  untilFids(n: number): Promise<void>;
  /** Lets the held FIDS answers go, from inside the object's own context. */
  release(): Promise<void>;
  /**
   * Resets the object as eviction or a deploy does (`ctx.abort()`, once its background work is
   * done): what the instance held in memory is gone, its storage stays. The fake provider, the
   * clock and the outbox are set again on the new instance.
   */
  evict(): Promise<void>;
}

const EVICTED = 'evicted by the test';

export async function airportHarness(
  body: unknown,
  clockMs: number,
  tz = 'America/New_York',
  icao: string = uniqueAirport(),
): Promise<AirportHarness> {
  let stub = track(testEnv.AIRPORT_STATE.getByName(icao));
  let clock = clockMs;
  const adb = fakeAdb(body);
  const sent: PersistMessageV1[] = [];
  const budgetDays = new Set<string>();
  await budgetClockAt(clockMs, budgetDays);
  const seams = () =>
    runInDurableObject(stub, (instance: AirportState) => {
      instance.providerDeps = { fetch: adb.fetch };
      instance._setClock(clock);
      instance.outboxSink = {
        sendBatch: (messages: Iterable<MessageSendRequest<unknown>>) => {
          for (const message of messages) {
            sent.push(message.body as PersistMessageV1);
          }
          return Promise.resolve();
        },
      } as unknown as Pick<Queue, 'sendBatch'>;
    });
  await seams();
  const settled = () => runInDurableObject(stub, (instance: AirportState) => instance.settled());
  return {
    get stub() {
      return stub;
    },
    icao,
    tz,
    adb,
    sent,
    setClock: async (ms) => {
      clock = ms;
      await runInDurableObject(stub, (instance: AirportState) => {
        instance._setClock(ms);
      });
      await budgetClockAt(ms, budgetDays);
    },
    settled,
    evict: async () => {
      await settled();
      const spent = stub;
      try {
        // `abort()` throws its reason at the caller, and leaves this stub unusable.
        await runInDurableObject(spent, (_instance, state) => {
          state.abort(EVICTED);
        });
      } catch (error) {
        if (!String(error).includes(EVICTED)) {
          throw error;
        }
      }
      untrack(spent);
      stub = track(testEnv.AIRPORT_STATE.getByName(icao));
      await seams();
    },
    untilFids: async (n) => {
      for (let i = 0; i < 1_000 && adb.fidsCalls() < n; i += 1) {
        await runInDurableObject(stub, () => undefined);
      }
      if (adb.fidsCalls() < n) {
        throw new Error(
          `only ${String(adb.fidsCalls())} FIDS calls arrived, ${String(n)} expected`,
        );
      }
    },
    release: () =>
      runInDurableObject(stub, () => {
        adb.release();
      }),
  };
}

const LHR = { icao: 'EGLL', iata: 'LHR', name: 'London Heathrow', timeZone: 'Europe/London' };

/** Base64 noise, which gzip cannot shrink: a way to make a board big after compression. */
function noise(chars: number): string {
  const bytes = new Uint8Array(Math.ceil((chars * 3) / 4));
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).slice(0, chars);
}

/**
 * A synthetic `withLeg=true` FIDS body of `perDirection` departures and as many arrivals, all to
 * or from Heathrow at `scheduledUtc` (`YYYY-MM-DD HH:mmZ`). `noiseChars` puts that much random
 * text in each aircraft model, so the compressed bucket is large.
 */
export function syntheticFids(perDirection: number, scheduledUtc: string, noiseChars = 0): unknown {
  const time = { utc: scheduledUtc, local: scheduledUtc.slice(0, 16) };
  const home = { scheduledTime: time, quality: ['Basic'] };
  const away = { airport: LHR, scheduledTime: time, quality: ['Basic'] };
  const item = (i: number, direction: 'dep' | 'arr') => ({
    number: `AA ${String((i % 9_999) + 1)}`,
    status: 'Expected',
    codeshareStatus: 'IsOperator',
    isCargo: false,
    airline: { name: 'American', iata: 'AA', icao: 'AAL' },
    aircraft: {
      reg: `N${String(i)}AA`,
      model: noiseChars > 0 ? noise(noiseChars) : 'Boeing 737-800',
    },
    departure: direction === 'dep' ? home : away,
    arrival: direction === 'dep' ? away : home,
  });
  return {
    departures: Array.from({ length: perDirection }, (_, i) => item(i, 'dep')),
    arrivals: Array.from({ length: perDirection }, (_, i) => item(i, 'arr')),
  };
}
