/**
 * A fake AeroAPI for the FlightTracker in `live` mode (increment 15, review ruling Q11). The
 * Workers suite serves only AeroDataBox (test/fake-providers.ts), so these tests install the
 * tracker's `providerDeps.fetch` seam: a request to AeroAPI's host is answered from a script
 * built on the vendored `flight-by-ident.json` fixture and recorded; every other request (the
 * fake AeroDataBox gateway) goes to the real fetch. The real router and both adapters run.
 */

import { runInDurableObject } from 'cloudflare:test';
import flightByIdent from '../../../src/providers/fixtures/aeroapi/flight-by-ident.json';
import type { FlightTracker } from '../../../src/do/flight-tracker';
import type { Env } from '../../../src/env';
import { AEROAPI_BASE_URL } from '../../../src/providers/aeroapi.mock';
import { utcDate } from '../../../src/providers/budget';
import {
  HOUR_MS,
  MINUTE_MS,
  testEnv,
  track,
  type TestFlight,
  type TrackerHarness,
} from './flights';

/** One scripted AeroAPI answer: the flight, cancelled or not, or an HTTP error status. */
export type AeroApiAnswer = { readonly cancelled: boolean } | { readonly httpStatus: number };

export interface FakeAeroApi {
  /** The answers still to give, in order; the last one repeats. */
  answers: AeroApiAnswer[];
  /** Every AeroAPI request the tracker made, in order. */
  readonly requests: URL[];
}

const FIXTURE_FLIGHT = flightByIdent.response.body.flights[0] as Record<string, unknown>;

/** The flight as AeroAPI's `GET /flights/{ident}` lists it: on time, cancelled or not. */
export function aeroApiFlight(flight: TestFlight, cancelled: boolean): Record<string, unknown> {
  const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const out = flight.scheduledOut.getTime();
  const arrival = flight.scheduledIn.getTime();
  const ident = `AAL${flight.number}`;
  return {
    ...FIXTURE_FLIGHT,
    ident,
    ident_icao: ident,
    ident_iata: `AA${flight.number}`,
    flight_number: flight.number,
    fa_flight_id: `${ident}-${String(out / 1000)}-schedule-0001`,
    inbound_fa_flight_id: null,
    codeshares: [],
    codeshares_iata: [],
    cancelled,
    status: cancelled ? 'Cancelled' : 'Scheduled',
    ...Object.fromEntries(
      [
        ['out', out],
        ['off', out + 15 * MINUTE_MS],
        ['on', arrival - 10 * MINUTE_MS],
        ['in', arrival],
      ].flatMap(([edge, at]) => [
        [`scheduled_${String(edge)}`, iso(Number(at))],
        [`estimated_${String(edge)}`, iso(Number(at))],
      ]),
    ),
  };
}

function fakeFetch(fake: FakeAeroApi, flight: TestFlight): (request: Request) => Promise<Response> {
  return (request) => {
    if (!request.url.startsWith(AEROAPI_BASE_URL)) {
      return fetch(request);
    }
    fake.requests.push(new URL(request.url));
    const answer = fake.answers.length > 1 ? fake.answers.shift() : fake.answers[0];
    const json = { 'content-type': 'application/json; charset=UTF-8' };
    if (answer === undefined || 'httpStatus' in answer) {
      const status = answer?.httpStatus ?? 500;
      const body = { title: 'Error', reason: 'scripted', detail: 'scripted', status };
      return Promise.resolve(new Response(JSON.stringify(body), { status, headers: json }));
    }
    const body = { links: null, num_pages: 1, flights: [aeroApiFlight(flight, answer.cancelled)] };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: json }));
  };
}

/**
 * Puts the tracker in `live` mode (its env: `AEROAPI_MODE=live` and a key) with the fake AeroAPI
 * answering `answers`, and lifts the per-second limit of AeroAPI's daily budget for every day the
 * walk touches (as `openBudgetFor` does for AeroDataBox). Returns the fake, which records.
 */
export async function goLive(
  tracker: TrackerHarness,
  flight: TestFlight,
  answers: AeroApiAnswer[],
): Promise<FakeAeroApi> {
  const fake: FakeAeroApi = { answers, requests: [] };
  await runInDurableObject(tracker.stub, (instance: FlightTracker) => {
    const holder = instance as unknown as { env: Env };
    holder.env = { ...holder.env, AEROAPI_MODE: 'live', AEROAPI_API_KEY: 'test-aeroapi-key' };
    instance.providerDeps = { fetch: fakeFetch(fake, flight) };
  });
  const days = new Set<string>();
  const from = flight.scheduledOut.getTime() - 48 * HOUR_MS;
  for (let t = from; t <= flight.scheduledIn.getTime() + 36 * HOUR_MS; t += 12 * HOUR_MS) {
    days.add(utcDate(new Date(t)));
  }
  for (const day of days) {
    const stub = track(
      testEnv.PROVIDER_BUDGET.getByName(`aeroapi:${day}`, { locationHint: 'enam' }),
    );
    await stub.configure({ perSecondLimit: 10_000 });
  }
  return fake;
}
