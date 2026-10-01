/**
 * Helpers for the increment 7 Durable Object tests: a unique flight per test, the fake
 * AeroDataBox gateway's control API, an on-time flight's scripted answers, and the seams every
 * FlightTracker and DesignatorResolver test installs through `runInDurableObject`.
 *
 * Every flight lives in the 2100s. Three reasons: the fake gateway keys its scripts and counters
 * by designator and date, so a random date per test isolates files that run in parallel; the
 * ProviderBudget object a tracker's calls debit is named by the tracker's clock date, and a day
 * in the future is always "open" whatever the wall clock says; and `setAlarm` accepts dates up to
 * 2189. Flight numbers are random too, so two tests on the same date never share a key.
 */

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  originLocalDate,
  type FlightKey,
  type PersistMessageV1,
  type ProviderBudgetDailyMessageV1,
} from '@planeahead/shared';
import type { DesignatorResolver } from '../../../src/do/designator-resolver';
import { utcDate } from '../../../src/providers/budget';
import type { FlightTracker } from '../../../src/do/flight-tracker';
import type { Env } from '../../../src/env';
import type { ScriptedAdbResponse } from '../../fake-providers';

export const testEnv = env as Env & { readonly TEST_FAKE_PROVIDERS_ORIGIN?: string };

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** Every stub a test touched, so `afterEach` can cancel whatever it left scheduled. */
const touched: DurableObjectStub[] = [];

export function track<T extends DurableObjectStub>(stub: T): T {
  touched.push(stub);
  return stub;
}

/** Forgets a stub its object's reset (`ctx.abort()`) has spent; `track` the new one instead. */
export function untrack(stub: DurableObjectStub): void {
  const index = touched.indexOf(stub);
  if (index >= 0) {
    touched.splice(index, 1);
  }
}

/**
 * The `afterEach` drain: cancels the alarm rather than running it (a tracker's alarm would make
 * a provider call and send outbox rows, which no test wants after its assertions), then lets
 * `runDurableObjectAlarm` confirm nothing is left.
 */
export async function drainTouched(): Promise<void> {
  while (touched.length > 0) {
    const stub = touched.pop();
    if (stub !== undefined) {
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
      await runDurableObjectAlarm(stub);
    }
  }
}

export interface TestFlight {
  /** `AA{number}`, the marketing designator a search is made with. */
  readonly designator: string;
  readonly number: string;
  /** Origin-local departure date, `YYYY-MM-DD`. */
  readonly dateLocal: string;
  readonly flightKey: FlightKey;
  readonly scheduledOut: Date;
  readonly scheduledIn: Date;
  readonly originTz: string;
}

/** A unique on-time AA flight KJFK to EGLL, 3 hours block, departing at 15:00Z on a 2100s date. */
export function uniqueFlight(blockMinutes = 180): TestFlight {
  const number = String(1 + Math.floor(Math.random() * 9_998));
  const year = 2100 + Math.floor(Math.random() * 70);
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 27);
  const scheduledOut = new Date(Date.UTC(year, month - 1, day, 15, 0, 0));
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

const KJFK = {
  icao: 'KJFK',
  iata: 'JFK',
  name: 'New York John F Kennedy',
  timeZone: 'America/New_York',
};
const EGLL = { icao: 'EGLL', iata: 'LHR', name: 'London Heathrow', timeZone: 'Europe/London' };

const localFormatters = new Map<string, Intl.DateTimeFormat>();

/** `YYYY-MM-DD HH:mm` at `tz`, the shape AeroDataBox's `.local` carries. */
export function adbLocal(instant: Date, tz: string): string {
  let formatter = localFormatters.get(tz);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    localFormatters.set(tz, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant).map((p) => [p.type, p.value]));
  return `${parts['year'] ?? ''}-${parts['month'] ?? ''}-${parts['day'] ?? ''} ${parts['hour'] ?? ''}:${parts['minute'] ?? ''}`;
}

/** `YYYY-MM-DD HH:mmZ`, the shape AeroDataBox's `.utc` carries. */
export function adbUtc(instant: Date): string {
  return `${instant.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function dateTime(instant: Date, tz: string): { utc: string; local: string } {
  return { utc: adbUtc(instant), local: adbLocal(instant, tz) };
}

/** An AeroDataBox `DateTime` contract (`.utc` and `.local`) for a scripted answer. */
export const adbDateTime = dateTime;

export type OnTimePhase = 'expected' | 'en_route' | 'arrived';

/** The phase an on-time flight is in at `now`, as the fake gateway should answer. */
export function onTimePhaseAt(flight: TestFlight, now: number): OnTimePhase {
  if (now >= flight.scheduledIn.getTime()) {
    return 'arrived';
  }
  return now >= flight.scheduledOut.getTime() ? 'en_route' : 'expected';
}

export interface AdbFlightOptions {
  readonly phase: OnTimePhase;
  readonly codeshareStatus?: 'Unknown' | 'IsOperator' | 'IsCodeshared';
  readonly callSign?: string;
  readonly originGate?: string;
  /** Overrides the origin airport (a key drift). */
  readonly origin?: typeof KJFK;
  /** Overrides the number the gateway reports (a key drift). */
  readonly number?: string;
}

/** One AeroDataBox `FlightContract` for the flight in the given phase, shaped like the fixtures. */
export function adbFlightContract(flight: TestFlight, options: AdbFlightOptions): unknown {
  const origin = options.origin ?? KJFK;
  const departure: Record<string, unknown> = {
    airport: origin,
    scheduledTime: dateTime(flight.scheduledOut, origin.timeZone),
    quality: ['Basic'],
  };
  const arrival: Record<string, unknown> = {
    airport: EGLL,
    scheduledTime: dateTime(flight.scheduledIn, EGLL.timeZone),
    quality: ['Basic'],
  };
  let status: string;
  switch (options.phase) {
    case 'expected':
      status = 'Expected';
      break;
    case 'en_route':
      status = 'EnRoute';
      departure['revisedTime'] = dateTime(flight.scheduledOut, origin.timeZone);
      departure['runwayTime'] = dateTime(flight.scheduledOut, origin.timeZone);
      departure['quality'] = ['Basic', 'Live'];
      arrival['revisedTime'] = dateTime(flight.scheduledIn, EGLL.timeZone);
      break;
    case 'arrived':
      status = 'Arrived';
      departure['revisedTime'] = dateTime(flight.scheduledOut, origin.timeZone);
      departure['runwayTime'] = dateTime(flight.scheduledOut, origin.timeZone);
      departure['quality'] = ['Basic', 'Live'];
      arrival['revisedTime'] = dateTime(flight.scheduledIn, EGLL.timeZone);
      arrival['runwayTime'] = dateTime(flight.scheduledIn, EGLL.timeZone);
      arrival['quality'] = ['Basic', 'Live'];
      break;
  }
  if (options.originGate !== undefined) {
    departure['gate'] = options.originGate;
  }
  return {
    greatCircleDistance: { km: 5539.97 },
    departure,
    arrival,
    lastUpdatedUtc: adbUtc(new Date(flight.scheduledOut.getTime() - 24 * HOUR_MS)),
    number: options.number ?? `AA ${flight.number}`,
    callSign: options.callSign ?? null,
    status,
    codeshareStatus: options.codeshareStatus ?? 'IsOperator',
    isCargo: false,
    aircraft: { model: 'Boeing 777-300ER', reg: 'N718AN' },
    airline: { name: 'American', iata: 'AA', icao: 'AAL' },
  };
}

export function adbOk(flight: TestFlight, options: AdbFlightOptions): ScriptedAdbResponse {
  return { status: 200, body: [adbFlightContract(flight, options)] };
}

// ---------------------------------------------------------------------------------------------
// The fake gateway's control API.
// ---------------------------------------------------------------------------------------------

function controlOrigin(): string {
  const origin = testEnv.TEST_FAKE_PROVIDERS_ORIGIN;
  if (origin === undefined) {
    throw new Error('TEST_FAKE_PROVIDERS_ORIGIN is not bound');
  }
  return origin;
}

/** Scripts the gateway's answers for this flight; the last one repeats. */
export async function scriptAdb(
  flight: TestFlight,
  responses: readonly ScriptedAdbResponse[],
): Promise<void> {
  const response = await fetch(
    `${controlOrigin()}/control/aerodatabox/flights/${flight.designator}/${flight.dateLocal}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ responses }),
    },
  );
  if (!response.ok) {
    throw new Error(`scriptAdb failed: ${String(response.status)}`);
  }
}

/** How many flight-status requests the gateway has served for this flight. */
export async function adbCalls(flight: TestFlight): Promise<number> {
  const response = await fetch(
    `${controlOrigin()}/control/aerodatabox/calls?designator=${flight.designator}&date=${flight.dateLocal}`,
  );
  const body: unknown = await response.json();
  return (body as { calls: number }).calls;
}

// ---------------------------------------------------------------------------------------------
// Object harnesses.
// ---------------------------------------------------------------------------------------------

/**
 * Lifts the per-second limit of the provider-wide daily budget for every UTC day the flight's
 * walk touches. The tracker's calls debit the ProviderBudget object named by the TRACKER's clock
 * date, but that object's own token bucket runs on the wall clock, and a test that runs 74 alarms
 * in a few real seconds would otherwise be refused as `provider_rate_limit` after the first burst.
 * The daily unit cap stays as configured; what production would see is unchanged.
 */
export async function openBudgetFor(flight: TestFlight, fromMs: number): Promise<void> {
  const days = new Set<string>();
  for (let t = fromMs; t <= flight.scheduledIn.getTime() + 36 * HOUR_MS; t += 12 * HOUR_MS) {
    days.add(utcDate(new Date(t)));
  }
  for (const day of days) {
    const stub = track(
      testEnv.PROVIDER_BUDGET.getByName(`aerodatabox:${day}`, { locationHint: 'enam' }),
    );
    await stub.configure({ perSecondLimit: 10_000 });
  }
}

export interface CapturedOutbox {
  readonly sent: PersistMessageV1[];
  /** Every `sendBatch` call's message count, in order. */
  readonly batches: number[];
  /** The next `sendBatch` calls reject when true. */
  failSends: boolean;
}

function capturingSink(capture: CapturedOutbox): Pick<Queue, 'sendBatch'> {
  return {
    sendBatch: (messages: Iterable<MessageSendRequest<unknown>>) => {
      if (capture.failSends) {
        return Promise.reject(new Error('queue unavailable'));
      }
      let count = 0;
      for (const message of messages) {
        capture.sent.push(message.body as PersistMessageV1);
        count += 1;
      }
      capture.batches.push(count);
      return Promise.resolve();
    },
  } as Pick<Queue, 'sendBatch'>;
}

export interface TrackerHarness {
  readonly stub: DurableObjectStub<FlightTracker>;
  readonly outbox: CapturedOutbox;
  setClock(ms: number): Promise<void>;
  alarmAt(): Promise<number | null>;
  /** Runs the pending alarm through the pool's runner; returns whether one ran. */
  runAlarm(): Promise<boolean>;
  /** Calls `alarm()` directly with a simulated platform retry. */
  retryAlarm(retryCount: number): Promise<void>;
  tables(): Promise<string[]>;
  rows<T extends Record<string, unknown>>(
    query: string,
    ...bindings: (string | number)[]
  ): Promise<T[]>;
}

/** A FlightTracker stub for `flightKey` with the capturing outbox sink and the clock installed. */
export async function trackerHarness(
  flightKey: FlightKey,
  clockMs: number,
): Promise<TrackerHarness> {
  const stub = track(testEnv.FLIGHT_TRACKER.getByName(flightKey, { locationHint: 'enam' }));
  const outbox: CapturedOutbox = { sent: [], batches: [], failSends: false };
  const sink = capturingSink(outbox);
  await runInDurableObject(stub, (instance: FlightTracker) => {
    instance.outboxSink = sink;
    instance._setClock(clockMs);
  });
  return {
    stub,
    outbox,
    setClock: (ms) => runInDurableObject(stub, (instance: FlightTracker) => instance._setClock(ms)),
    alarmAt: () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
    runAlarm: () => runDurableObjectAlarm(stub),
    retryAlarm: (retryCount) =>
      runInDurableObject(stub, async (instance: FlightTracker, state) => {
        const scheduledTime = (await state.storage.getAlarm()) ?? 0;
        await instance.alarm({ isRetry: true, retryCount, scheduledTime });
      }),
    tables: () =>
      runInDurableObject(stub, (_instance, state) =>
        [
          ...state.storage.sql.exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          ),
        ]
          .map((row) => row.name)
          .filter((name) => !name.startsWith('_cf_') && name !== '_sql_schema_migrations'),
      ),
    rows: <T extends Record<string, unknown>>(query: string, ...bindings: (string | number)[]) =>
      runInDurableObject(
        stub,
        (_instance, state) => state.storage.sql.exec(query, ...bindings).toArray() as T[],
      ),
  };
}

export interface ResolverHarness {
  readonly stub: DurableObjectStub<DesignatorResolver>;
  readonly name: string;
  readonly outbox: CapturedOutbox;
  setClock(ms: number): Promise<void>;
  alarmAt(): Promise<number | null>;
}

/** A DesignatorResolver stub for the flight's designator and date, with its seams installed. */
export async function resolverHarness(
  flight: TestFlight,
  clockMs: number,
): Promise<ResolverHarness> {
  const name = `${flight.designator}-${flight.dateLocal}`;
  const stub = track(testEnv.DESIGNATOR_RESOLVER.getByName(name));
  const outbox: CapturedOutbox = { sent: [], batches: [], failSends: false };
  const sink = capturingSink(outbox);
  await runInDurableObject(stub, (instance: DesignatorResolver) => {
    instance.outboxSink = sink;
    instance._setClock(clockMs);
  });
  return {
    stub,
    name,
    outbox,
    setClock: (ms) =>
      runInDurableObject(stub, (instance: DesignatorResolver) => instance._setClock(ms)),
    alarmAt: () => runInDurableObject(stub, (_instance, state) => state.storage.getAlarm()),
  };
}

/** Narrows a captured message by kind. */
export function ofKind<K extends PersistMessageV1['kind']>(
  messages: readonly PersistMessageV1[],
  kind: K,
): Extract<PersistMessageV1, { kind: K }>[] {
  return messages.filter((m): m is Extract<PersistMessageV1, { kind: K }> => m.kind === kind);
}

export type DailyMessage = ProviderBudgetDailyMessageV1;
