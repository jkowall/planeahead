/**
 * The AeroAPI adapter (mocked: no key in Phase 0) against the vendored OpenAPI 4.17.1 and
 * fixtures shaped strictly from it. Two request rules are pinned (the bracketed first fetch, which
 * must contain the flight and answers only the flight asked about, then `fa_flight_id` with
 * `max_pages=1`), the diverted two-item response, alert registration (the account endpoint set
 * first, then the nine booleans and a mandatory per-alert `target_url`), the `Location` header,
 * the 18 event codes and the merge of a delivery onto a snapshot.
 */

import { describe, expect, it } from 'vitest';
import {
  AEROAPI_EVENT_CODES,
  ALERT_EVENTS,
  FlightStatusSchema,
  ProviderEventSchema,
  type Exact,
  type FlightKey,
  type FlightStatus,
} from '@planeahead/shared';
import specText from '../../src/providers/specs/aeroapi-v4.17.1.yaml?raw';
import {
  AEROAPI_BASE_URL,
  AEROAPI_INSTANCE_MATCH_MS,
  AeroApiAdapter,
  AeroApiAlertError,
  alertEventFlags,
  bracketLocalDate,
  bracketWindow,
  localMinuteToUtcMs,
  mergeAeroApiAlert,
  parseAeroApiAlert,
  parseAlertLocation,
  type AeroApiAlertPatch,
} from '../../src/providers/aeroapi.mock';
import { AeroDataBoxAdapter } from '../../src/providers/aerodatabox.adapter';
import { ADB_PLANS, AEROAPI_STANDARD } from '../../src/providers/config';
import { ProviderCallError } from '../../src/providers/http';
import { aeroApiAllowedAt } from '../../src/providers/router';
import airportDepartures from '../../src/providers/fixtures/aeroapi/airport-departures.json';
import alertCreated from '../../src/providers/fixtures/aeroapi/alert-created.json';
import alertChange from '../../src/providers/fixtures/aeroapi/alert-delivery-change.json';
import alertOut from '../../src/providers/fixtures/aeroapi/alert-delivery-out.json';
import alertUnknown from '../../src/providers/fixtures/aeroapi/alert-delivery-unknown-code.json';
import alertEndpointSet from '../../src/providers/fixtures/aeroapi/alert-endpoint-set.json';
import error400 from '../../src/providers/fixtures/aeroapi/error-400.json';
import error400Endpoint from '../../src/providers/fixtures/aeroapi/error-400-alert-endpoint.json';
import flightById from '../../src/providers/fixtures/aeroapi/flight-by-id-en-route.json';
import flightByIdent from '../../src/providers/fixtures/aeroapi/flight-by-ident.json';
import flightDiverted from '../../src/providers/fixtures/aeroapi/flight-diverted.json';
import flightEmpty from '../../src/providers/fixtures/aeroapi/flight-empty.json';
import rateLimited from '../../src/providers/fixtures/aeroapi/rate-limited-429.json';
import { OpenApiDoc, at, keysOf, listOf, sha256HexOf, type YamlNode } from './helpers/openapi';
import {
  fetchStub,
  fixtureFetch,
  fixtureResponse,
  providerContext,
  type Fixture,
} from './helpers/providers';

/** `expect.objectContaining`, typed: the matcher is `any`, which the lint rules forbid assigning. */
function containing(value: object): unknown {
  return expect.objectContaining(value) as unknown;
}

/** SHA-256 of the vendored snapshot. A change here is a re-vendoring, reviewed as such. */
const AEROAPI_SPEC_SHA256 = '3023e7a0c54c86be61d130eacf9a420516574569d43c4feb62444e0b38611da5';

const spec = new OpenApiDoc(specText);
const JSON_TYPE = 'application/json; charset=UTF-8';

function required(node: YamlNode | undefined, name: string): YamlNode {
  if (node === undefined) {
    throw new Error(`spec has no ${name}`);
  }
  return node;
}

const FLIGHTS_SCHEMA = required(
  at(
    spec.root,
    'paths',
    '/flights/{ident}',
    'get',
    'responses',
    '200',
    'content',
    JSON_TYPE,
    'schema',
  ),
  'flights',
);
const SCHEMAS: Record<string, YamlNode> = {
  flights: FLIGHTS_SCHEMA,
  departures: required(
    at(
      spec.root,
      'paths',
      '/airports/{id}/flights/departures',
      'get',
      'responses',
      '200',
      'content',
      JSON_TYPE,
      'schema',
    ),
    'departures',
  ),
  Error: required(
    at(
      spec.root,
      'paths',
      '/flights/{ident}',
      'get',
      'responses',
      '400',
      'content',
      JSON_TYPE,
      'schema',
    ),
    'Error',
  ),
  deliver_alert: required(
    at(
      spec.root,
      'paths',
      '/alerts/endpoint',
      'put',
      'callbacks',
      'deliver_alert',
      'registered endpoint',
      'post',
      'requestBody',
      'content',
      JSON_TYPE,
      'schema',
    ),
    'deliver_alert',
  ),
};

const FIXTURES: Record<string, Fixture> = {
  'airport-departures': airportDepartures,
  'alert-created': alertCreated,
  'alert-delivery-change': alertChange,
  'alert-delivery-out': alertOut,
  'alert-delivery-unknown-code': alertUnknown,
  'alert-endpoint-set': alertEndpointSet,
  'error-400': error400,
  'error-400-alert-endpoint': error400Endpoint,
  'flight-by-id-en-route': flightById,
  'flight-by-ident': flightByIdent,
  'flight-diverted': flightDiverted,
  'flight-empty': flightEmpty,
  'rate-limited-429': rateLimited,
};

const FA_FLIGHT_ID = 'AAL100-1758341600-schedule-0391';
const DAY = 86_400_000;
const KEY = 'AAL-100-2026-09-22-KJFK' as FlightKey;
const TARGET = 'https://api-staging.planeahead.app/v1/webhooks/aeroapi/token-for-this-environment';

function adapter(
  fetch: ReturnType<typeof fixtureFetch>['fetch'],
  target: { readonly alertTargetUrl: string | undefined } = { alertTargetUrl: TARGET },
  alertEndpointsSet: Set<string> = new Set(),
) {
  return new AeroApiAdapter({
    apiKey: 'aeroapi-test-key',
    fetch,
    alertTargetUrl: target.alertTargetUrl,
    alertEndpointsSet,
    now: () => new Date('2026-09-22T22:05:00Z'),
  });
}

/** The fixture flight, re-dated by `shiftMs` and renamed, as another instance of AA 100. */
function instanceOf(shiftMs: number, faFlightId: string): Record<string, unknown> {
  const flight = (
    (FIXTURES['flight-by-ident'] as Fixture).response.body as { flights: Record<string, unknown>[] }
  ).flights[0] as Record<string, unknown>;
  const shifted: Record<string, unknown> = { ...flight, fa_flight_id: faFlightId };
  for (const [key, value] of Object.entries(flight)) {
    if (/^(scheduled|estimated|actual)_(out|off|on|in)$/.test(key) && typeof value === 'string') {
      shifted[key] = new Date(Date.parse(value) + shiftMs).toISOString().replace('.000Z', 'Z');
    }
  }
  return shifted;
}

/**
 * A fetch that answers `/flights/{ident}` the way the spec says AeroAPI does: every instance whose
 * `scheduled_out` is at or after `start` and before `end`.
 */
function specFaithfulFlights(instances: readonly Record<string, unknown>[]) {
  return fetchStub((request) => {
    const url = new URL(request.url);
    const start = Date.parse(url.searchParams.get('start') ?? '');
    const end = Date.parse(url.searchParams.get('end') ?? '');
    const flights = instances.filter((flight) => {
      const out = Date.parse(flight['scheduled_out'] as string);
      return out >= start && out < end;
    });
    return new Response(JSON.stringify({ links: null, num_pages: 1, flights }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=UTF-8' },
    });
  });
}

describe('the vendored AeroAPI spec', () => {
  it('is the pinned 4.17.1 snapshot', async () => {
    expect(await sha256HexOf(specText)).toBe(AEROAPI_SPEC_SHA256);
    expect(at(spec.root, 'info', 'version')?.value).toBe('4.17.1');
    expect(AEROAPI_BASE_URL).toBe('https://aeroapi.flightaware.com/aeroapi/');
  });

  it('authenticates with x-apikey and types ident_type as designator | registration | fa_flight_id', () => {
    expect(at(spec.root, 'components', 'securitySchemes', 'ApiKeyAuth', 'name')?.value).toBe(
      'x-apikey',
    );
    const parameters =
      at(spec.root, 'paths', '/flights/{ident}', 'get', 'parameters')?.children ?? [];
    const identType = parameters.find((p) => at(p, 'name')?.value === 'ident_type');
    expect(listOf(at(identType, 'schema', 'enum'))).toEqual([
      'designator',
      'registration',
      'fa_flight_id',
    ]);
    const maxPages = parameters.find((p) => at(p, 'name')?.value === 'max_pages');
    expect(at(maxPages, 'schema', 'default')?.value).toBe('1');
  });

  it('configures exactly the nine event booleans ALERT_EVENTS names (no hold events)', () => {
    const body = spec.resolve(
      required(
        at(spec.root, 'paths', '/alerts', 'post', 'requestBody', 'content', JSON_TYPE, 'schema'),
        'post',
      ),
    );
    const events = keysOf(at(body.properties.get('events'), 'properties'));
    expect([...events].sort()).toEqual([...ALERT_EVENTS].sort());
    expect(events).not.toContain('hold_start');
    expect(body.properties.has('target_url')).toBe(true);
    expect(
      at(spec.root, 'paths', '/alerts', 'post', 'responses', '201', 'headers', 'Location'),
    ).toBeDefined();
  });

  it('delivers the 18 event codes AEROAPI_EVENT_CODES lists, in spec order', () => {
    expect(listOf(at(SCHEMAS['deliver_alert'], 'properties', 'event_code', 'enum'))).toEqual([
      ...AEROAPI_EVENT_CODES,
    ]);
  });

  it('gives the delivered flight no timezone and no status', () => {
    const flight = keysOf(at(SCHEMAS['deliver_alert'], 'properties', 'flight', 'properties'));
    expect(flight).toContain('fa_flight_id');
    expect(flight).not.toContain('status');
    expect(flight.some((key) => key.includes('timezone'))).toBe(false);
  });
});

describe('fixtures', () => {
  it.each(Object.entries(FIXTURES).filter(([, f]) => f.schema !== null))(
    '%s is shaped strictly by its schema',
    (name, fixture) => {
      const errors = spec.violations(
        fixture.response.body,
        required(SCHEMAS[fixture.schema ?? ''], name),
      );
      if (name === 'alert-delivery-unknown-code') {
        // The one deliberate departure: a code FlightAware may add later.
        expect(errors).toEqual([
          `$.event_code: "taxi_stop" is not one of ${AEROAPI_EVENT_CODES.join('|')}`,
        ]);
        return;
      }
      expect(errors).toEqual([]);
    },
  );
});

describe('getFlight: the two request rules', () => {
  it('the first fetch is a designator lookup bracketed around scheduled_out, max_pages=1', async () => {
    const stub = fixtureFetch(FIXTURES['flight-by-ident'] as Fixture);
    const { ctx } = providerContext({ now: '2026-09-22T20:00:00Z', flightKey: KEY });
    const window = bracketWindow('2026-09-22T22:00:00Z', new Date('2026-09-22T20:00:00Z'));
    expect(window).toEqual({ start: '2026-09-21T22:00:00Z', end: '2026-09-23T22:00:00Z' });
    const { data, call } = await adapter(stub.fetch).getFlight(
      {
        carrier: { icao: 'AAL', iata: 'AA' },
        flightNumber: '100',
        dateLocal: '2026-09-22',
        window: window ?? undefined,
      },
      ctx,
    );
    const request = stub.requests[0];
    const url = new URL(request?.url ?? '');
    expect(url.origin + url.pathname).toBe(
      'https://aeroapi.flightaware.com/aeroapi/flights/AAL100',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ident_type: 'designator',
      start: '2026-09-21T22:00:00Z',
      end: '2026-09-23T22:00:00Z',
      max_pages: '1',
    });
    expect(request?.headers.get('x-apikey')).toBe('aeroapi-test-key');
    expect(call).toMatchObject({
      provider: 'aeroapi',
      operation: 'flight_by_ident',
      costUnits: 1,
      estCostUsdMicros: 5_000,
    });
    expect(data).toHaveLength(1);
  });

  it('every later poll asks by fa_flight_id with max_pages=1: one poll is one result set', async () => {
    const stub = fixtureFetch(FIXTURES['flight-by-id-en-route'] as Fixture);
    const { ctx } = providerContext({ now: '2026-09-22T23:00:00Z' });
    const { data, call } = await adapter(stub.fetch).getFlight(
      {
        carrier: { icao: 'AAL' },
        flightNumber: '100',
        dateLocal: '2026-09-22',
        providerRef: { provider: 'aeroapi', id: FA_FLIGHT_ID },
      },
      ctx,
    );
    const url = stub.urls()[0];
    expect(url?.pathname).toBe(`/aeroapi/flights/${FA_FLIGHT_ID}`);
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      ident_type: 'fa_flight_id',
      max_pages: '1',
    });
    expect(call).toMatchObject({
      operation: 'flight_by_id',
      result: 'ok',
      costUnits: 1,
      pollEquivalents: 1,
    });
    expect(data[0]).toMatchObject({ status: 'en_route', progressPercent: 35 });
  });

  it('brackets the start inclusively and the end exclusively inside 10 days back and 2 ahead', () => {
    const now = new Date('2026-09-22T12:00:00Z');
    // A flight 2.5 days out is beyond the 2-day horizon: no window AeroAPI accepts contains it.
    // (The clamped [09-24T00Z, 09-24T12Z) would have excluded the flight and answered with the
    // previous day's instance at its inclusive start.)
    expect(bracketWindow('2026-09-25T00:00:00Z', now)).toBeNull();
    // More than 3 days out, nothing is reachable at all.
    expect(bracketWindow('2026-09-26T00:00:00Z', now)).toBeNull();
    // Inside the horizon with the margin to spare: clamped at now + 2 days, flight inside.
    expect(bracketWindow('2026-09-24T11:00:00Z', now)).toEqual({
      start: '2026-09-23T11:00:00Z',
      end: '2026-09-24T12:00:00Z',
    });
    // Clamped at 10 days back, a minute inside the limit: the flight is still after the start.
    expect(bracketWindow('2026-09-13T00:00:00Z', now)).toEqual({
      start: '2026-09-12T12:01:00Z',
      end: '2026-09-14T00:00:00Z',
    });
    // A flight before the clamped start is outside the window, so nothing is asked.
    expect(bracketWindow('2026-09-12T06:00:00Z', now)).toBeNull();
    expect(bracketWindow('garbage', now)).toBeNull();
    // Only the local date known: every zone's local day is inside the bracket.
    expect(bracketLocalDate('2026-09-22', now)).toEqual({
      start: '2026-09-21T10:00:00Z',
      end: '2026-09-23T12:00:00Z',
    });
  });

  it('never sends a start past the 10-day limit, whatever the milliseconds of now', () => {
    // isoSeconds truncates: at .700 the old clamp sent 09-12T12:00:00Z, 700 ms past the limit.
    const now = new Date('2026-09-22T12:00:00.700Z');
    const limit = now.getTime() - AEROAPI_STANDARD.maxDaysBehind * DAY;
    for (const window of [
      bracketWindow('2026-09-13T00:00:00Z', now),
      bracketLocalDate('2026-09-12', now),
    ]) {
      expect(window).not.toBeNull();
      const start = Date.parse(window?.start ?? '');
      expect(start - limit).toBeGreaterThanOrEqual(AEROAPI_STANDARD.pastLimitMarginMs);
      expect(start % 1_000).toBe(0);
    }
    expect(bracketWindow('2026-09-13T00:00:00Z', now)?.start).toBe('2026-09-12T12:01:01Z');
  });

  it.each([
    ['exactly T-48 h', 0],
    ['T-48 h plus 400 ms (truncated to the second)', 400],
    ['T-48 h plus 4 minutes 59 seconds', 299_000],
  ])('sends nothing at %s: the flight is on the exclusive horizon', async (_label, lateMs) => {
    const out = Date.parse('2026-09-24T22:00:00Z');
    const now = new Date(out - 2 * DAY + lateMs);
    expect(bracketWindow(new Date(out), now)).toBeNull();
    // The router agrees: the T-48 h slot is AeroDataBox's, even in live mode.
    expect(aeroApiAllowedAt({ scheduledOut: new Date(out), now })).toBe(false);
    const stub = specFaithfulFlights([
      instanceOf(DAY, 'AAL100-prev'),
      instanceOf(2 * DAY, 'AAL100-target'),
    ]);
    const recorder = providerContext({ now });
    const { data, call } = await adapter(stub.fetch).getFlight(
      {
        carrier: { icao: 'AAL' },
        flightNumber: '100',
        dateLocal: '2026-09-24',
        scheduledOut: new Date(out).toISOString(),
      },
      recorder.ctx,
    );
    expect(stub.requests).toHaveLength(0);
    expect(recorder.reservations).toHaveLength(0);
    expect(data).toEqual([]);
    expect(call).toMatchObject({ result: 'error', costUnits: 0, error: 'outside_aeroapi_window' });
    // An explicit bracket around the same flight is refused the same way.
    const explicit = await adapter(stub.fetch).getFlight(
      {
        carrier: { icao: 'AAL' },
        flightNumber: '100',
        dateLocal: '2026-09-24',
        window: { start: '2026-09-23T22:00:00Z', end: '2026-09-25T22:00:00Z' },
      },
      recorder.ctx,
    );
    expect(explicit.call.error).toBe('outside_aeroapi_window');
    expect(stub.requests).toHaveLength(0);
  });

  it('once inside the horizon, answers the flight asked about and never the previous day', async () => {
    const out = Date.parse('2026-09-24T22:00:00Z');
    const now = new Date(out - 2 * DAY + AEROAPI_STANDARD.horizonMarginMs + 1_000);
    expect(aeroApiAllowedAt({ scheduledOut: new Date(out), now })).toBe(true);
    // The fixture flight departs 09-22T22:00Z; shifted two days it is the target, one day the
    // previous day's AA 100, which the bracket's inclusive start still holds.
    const stub = specFaithfulFlights([
      instanceOf(DAY, 'AAL100-prev'),
      instanceOf(2 * DAY, 'AAL100-target'),
    ]);
    const { data, call } = await adapter(stub.fetch).getFlight(
      {
        carrier: { icao: 'AAL' },
        flightNumber: '100',
        dateLocal: '2026-09-24',
        scheduledOut: new Date(out).toISOString(),
      },
      providerContext({ now }).ctx,
    );
    expect(Object.fromEntries(stub.urls()[0]?.searchParams ?? [])).toEqual({
      ident_type: 'designator',
      start: '2026-09-23T22:00:00Z',
      end: '2026-09-24T22:05:01Z',
      max_pages: '1',
    });
    expect(call).toMatchObject({ result: 'ok', costUnits: 1 });
    expect(data.map((flight) => flight.providerRefs['aeroapi'])).toEqual(['AAL100-target']);
    expect(data[0]?.scheduledDepartureDateLocal).toBe('2026-09-24');
  });

  it("a bracket holding only another day's instance is a billed miss, not that instance", async () => {
    const out = Date.parse('2026-09-23T22:00:00Z');
    const now = new Date('2026-09-22T20:00:00Z');
    // Only the previous day's departure is in the window (the flight itself was dropped).
    const stub = specFaithfulFlights([instanceOf(0, 'AAL100-prev')]);
    const { data, call } = await adapter(stub.fetch).getFlight(
      {
        carrier: { icao: 'AAL' },
        flightNumber: '100',
        dateLocal: '2026-09-23',
        scheduledOut: new Date(out).toISOString(),
      },
      providerContext({ now }).ctx,
    );
    expect(stub.requests).toHaveLength(1);
    expect(data).toEqual([]);
    expect(call).toMatchObject({ result: 'not_found', costUnits: 1, error: 'other_instances:1' });
    expect(AEROAPI_INSTANCE_MATCH_MS).toBe(12 * 3_600_000);
  });

  it('a lookup by local date alone keeps only the instances departing that local day', async () => {
    const stub = specFaithfulFlights([
      instanceOf(-DAY, 'AAL100-prev'),
      instanceOf(0, 'AAL100-target'),
      instanceOf(DAY, 'AAL100-next'),
    ]);
    const { data } = await adapter(stub.fetch).getFlight(
      { carrier: { icao: 'AAL' }, flightNumber: '100', dateLocal: '2026-09-22' },
      providerContext({ now: '2026-09-22T12:00:00Z' }).ctx,
    );
    // The local-day span reaches into the neighbouring days; only 09-22 at KJFK is returned.
    expect(data.map((flight) => flight.providerRefs['aeroapi'])).toEqual(['AAL100-target']);
  });

  it('refuses a lookup AeroAPI cannot answer without spending a result set', async () => {
    const stub = fixtureFetch(FIXTURES['flight-by-ident'] as Fixture);
    const recorder = providerContext({ now: '2026-09-22T12:00:00Z' });
    const { data, call } = await adapter(stub.fetch).getFlight(
      { carrier: { icao: 'AAL' }, flightNumber: '100', dateLocal: '2026-10-05' },
      recorder.ctx,
    );
    expect(stub.requests).toHaveLength(0);
    expect(recorder.reservations).toHaveLength(0);
    expect(data).toEqual([]);
    expect(call).toMatchObject({ result: 'error', costUnits: 0, error: 'outside_aeroapi_window' });
  });
});

describe('getFlight: mapping', () => {
  it('maps a flight: operator from operator_icao, codeshares joined, status from flags and OOOI', async () => {
    const stub = fixtureFetch(FIXTURES['flight-by-ident'] as Fixture);
    const { ctx } = providerContext({ now: '2026-09-22T20:00:00Z' });
    const { data } = await adapter(stub.fetch).getFlight(
      { carrier: { icao: 'AAL' }, flightNumber: '100', dateLocal: '2026-09-22' },
      ctx,
    );
    const status = data[0];
    expect(FlightStatusSchema.safeParse(status).success).toBe(true);
    expect(status).toMatchObject({
      operatingCarrierIcao: 'AAL',
      operatorSource: 'provider',
      flightNumber: '100',
      codeshares: [
        { carrierIcao: 'BAW', carrierIata: 'BA', flightNumber: '1512' },
        { carrierIcao: 'IBE', carrierIata: 'IB', flightNumber: '4218' },
      ],
      origin: { icao: 'KJFK', iata: 'JFK', tz: 'America/New_York' },
      destination: { icao: 'EGLL', iata: 'LHR', tz: 'Europe/London' },
      scheduledDepartureDateLocal: '2026-09-22',
      status: 'scheduled',
      originGate: 'B32',
      aircraftTypeIcao: 'B77W',
      registration: 'N717AN',
      providerRefs: { aeroapi: FA_FLIGHT_ID },
      inboundRef: { provider: 'aeroapi', providerId: 'AAL101-1758255200-schedule-0120' },
      routeDistanceKm: 5553.8,
      source: 'aeroapi',
    });
    expect(status?.times).toEqual({
      scheduledOut: '2026-09-22T22:00:00.000Z',
      estimatedOut: '2026-09-22T22:00:00.000Z',
      scheduledOff: '2026-09-22T22:15:00.000Z',
      estimatedOff: '2026-09-22T22:15:00.000Z',
      scheduledOn: '2026-09-23T05:00:00.000Z',
      estimatedOn: '2026-09-23T05:00:00.000Z',
      scheduledIn: '2026-09-23T05:10:00.000Z',
      estimatedIn: '2026-09-23T05:10:00.000Z',
    });
    // The opaque status string ("Scheduled") is never read.
    expect(status).not.toHaveProperty('statusText');
  });

  it('returns both legs of a diverted flight and marks actualDestination on the diversion', async () => {
    const stub = fixtureFetch(FIXTURES['flight-diverted'] as Fixture);
    const { ctx } = providerContext({ now: '2026-09-23T04:00:00Z' });
    const { data, call } = await adapter(stub.fetch).getFlight(
      {
        carrier: { icao: 'AAL' },
        flightNumber: '100',
        dateLocal: '2026-09-22',
        providerRef: { provider: 'aeroapi', id: FA_FLIGHT_ID },
      },
      ctx,
    );
    expect(call).toMatchObject({ result: 'ok', costUnits: 1 });
    expect(data).toHaveLength(2);
    expect(data.map((leg) => leg.providerRefs['aeroapi'])).toEqual([FA_FLIGHT_ID, FA_FLIGHT_ID]);
    expect(data[0]).toMatchObject({ status: 'diverted', destination: { icao: 'EGLL' } });
    expect(data[0]?.actualDestination).toBeUndefined();
    expect(data[1]).toMatchObject({
      status: 'diverted',
      destination: { icao: 'EGLL' },
      actualDestination: { icao: 'EINN', iata: 'SNN', tz: 'Europe/Dublin' },
      times: { actualIn: '2026-09-23T03:20:00.000Z' },
      destinationGate: '2',
    });
  });

  it('an empty result set is a billed miss', async () => {
    const { data, call } = await adapter(
      fixtureFetch(FIXTURES['flight-empty'] as Fixture).fetch,
    ).getFlight(
      { carrier: { icao: 'AAL' }, flightNumber: '100', dateLocal: '2026-09-22' },
      providerContext({ now: '2026-09-22T20:00:00Z' }).ctx,
    );
    expect(data).toEqual([]);
    expect(call).toMatchObject({ result: 'not_found', costUnits: 1, estCostUsdMicros: 5_000 });
  });

  it('a rejected fetch keeps its reservation and is billed: AeroAPI may have served it', async () => {
    const stub = fetchStub(() => {
      throw new TypeError('connection reset');
    });
    const recorder = providerContext({ now: '2026-09-22T23:00:00Z' });
    const { data, call } = await adapter(stub.fetch).getFlight(
      {
        carrier: { icao: 'AAL' },
        flightNumber: '100',
        dateLocal: '2026-09-22',
        providerRef: { provider: 'aeroapi', id: FA_FLIGHT_ID },
      },
      recorder.ctx,
    );
    expect(data).toEqual([]);
    expect(call).toMatchObject({
      result: 'error',
      costUnits: 1,
      estCostUsdMicros: 5_000,
      error: 'transport_unknown_billing:connection reset',
    });
    expect(recorder.reservations).toHaveLength(1);
    expect(recorder.releases).toEqual([]);
  });

  it.each([
    ['400', 'error-400', 'error'],
    ['429', 'rate-limited-429', 'rate_limited'],
  ] as const)(
    'a %s is billed until FlightAware confirms otherwise',
    async (_label, name, result) => {
      const recorder = providerContext({ now: '2026-09-22T23:00:00Z' });
      const { call } = await adapter(fixtureFetch(FIXTURES[name] as Fixture).fetch).getFlight(
        {
          carrier: { icao: 'AAL' },
          flightNumber: '100',
          dateLocal: '2026-09-22',
          providerRef: { provider: 'aeroapi', id: FA_FLIGHT_ID },
        },
        recorder.ctx,
      );
      expect(call).toMatchObject({ result, costUnits: 1, estCostUsdMicros: 5_000 });
      expect(recorder.releases).toEqual([]);
      expect(recorder.backoffs).toEqual(
        result === 'rate_limited' ? [{ provider: 'aeroapi', retryAfterMs: 1_000 }] : [],
      );
    },
  );
});

describe('getBoard', () => {
  it('reads recent departures as airport_departures, one result set', async () => {
    const stub = fixtureFetch(FIXTURES['airport-departures'] as Fixture);
    const { data, call } = await adapter(stub.fetch).getBoard(
      'KJFK',
      'dep',
      { from: '2026-09-22T16:00', to: '2026-09-22T22:00', tz: 'America/New_York' },
      providerContext({ now: '2026-09-22T23:00:00Z' }).ctx,
    );
    expect(stub.urls()[0]?.pathname).toBe('/aeroapi/airports/KJFK/flights/departures');
    expect(stub.urls()[0]?.searchParams.get('max_pages')).toBe('1');
    expect(call).toMatchObject({
      operation: 'airport_departures',
      costUnits: 1,
      estCostUsdMicros: 5_000,
    });
    expect(data).toEqual([
      containing({
        direction: 'dep',
        designator: 'AA100',
        operatingCarrierIcao: 'AAL',
        counterpart: { icao: 'EGLL', iata: 'LHR', tz: 'Europe/London' },
        status: 'en_route',
        actual: '2026-09-22T22:04:00.000Z',
        gate: 'B32',
        source: 'aeroapi',
      }),
    ]);
  });

  it('reads the shared BoardWindow as airport-local time, exactly as AeroDataBox does', async () => {
    // One window, both providers: 17:00 to 23:00 at JFK is 21:00Z to 03:00Z in September.
    const window = { from: '2026-09-22T17:00', to: '2026-09-22T23:00', tz: 'America/New_York' };
    const ctx = providerContext({ now: '2026-09-22T23:30:00Z' }).ctx;
    const aeroapi = fixtureFetch(FIXTURES['airport-departures'] as Fixture);
    await adapter(aeroapi.fetch).getBoard('KJFK', 'dep', window, ctx);
    expect(Object.fromEntries(aeroapi.urls()[0]?.searchParams ?? [])).toEqual({
      start: '2026-09-22T21:00:00Z',
      end: '2026-09-23T03:00:00Z',
      max_pages: '1',
    });
    const adb = fetchStub(
      () =>
        new Response(JSON.stringify({ departures: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await new AeroDataBoxAdapter({
      apiKey: 'adb',
      fetch: adb.fetch,
      plan: ADB_PLANS.growth,
      now: () => new Date(),
    }).getBoard('KJFK', 'dep', window, ctx);
    expect(adb.urls()[0]?.pathname).toBe(
      '/flights/airports/Icao/KJFK/2026-09-22T17:00/2026-09-22T23:00',
    );
    // The same wall clock in winter is five hours from UTC, not four.
    expect(localMinuteToUtcMs('2026-12-22T17:00', 'America/New_York')).toBe(
      Date.parse('2026-12-22T22:00:00Z'),
    );
    // Across the November fall-back and the March spring-forward.
    expect(localMinuteToUtcMs('2026-11-01T00:30', 'America/New_York')).toBe(
      Date.parse('2026-11-01T04:30:00Z'),
    );
    expect(localMinuteToUtcMs('2026-11-01T03:00', 'America/New_York')).toBe(
      Date.parse('2026-11-01T08:00:00Z'),
    );
    expect(localMinuteToUtcMs('2026-03-08T04:00', 'America/New_York')).toBe(
      Date.parse('2026-03-08T08:00:00Z'),
    );
    expect(localMinuteToUtcMs('2026-09-22T17:00', 'Not/AZone')).toBeNull();
    expect(localMinuteToUtcMs('2026-13-22T17:00', 'America/New_York')).toBeNull();
    expect(localMinuteToUtcMs('2026-09-22T17:00:00Z', 'America/New_York')).toBeNull();
    await expect(
      adapter(aeroapi.fetch).getBoard('KJFK', 'dep', { ...window, tz: 'nowhere' }, ctx),
    ).rejects.toThrow(RangeError);
  });
});

describe('alerts', () => {
  it('registers the nine booleans, the instance, max_weekly and a per-alert target_url; the id comes from Location', async () => {
    const stub = fixtureFetch(
      FIXTURES['alert-endpoint-set'] as Fixture,
      FIXTURES['alert-created'] as Fixture,
    );
    const recorder = providerContext();
    const { data, call } = await adapter(stub.fetch).registerAlert(
      KEY,
      { events: ['out', 'off', 'on', 'in', 'cancelled', 'diverted'], maxWeekly: 20 },
      recorder.ctx,
    );
    expect(stub.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'PUT /aeroapi/alerts/endpoint',
      'POST /aeroapi/alerts',
    ]);
    const request = stub.requests[1];
    expect(request?.url).toBe('https://aeroapi.flightaware.com/aeroapi/alerts');
    expect(request?.headers.get('content-type')).toBe(JSON_TYPE);
    const body = (await request?.json()) as Record<string, unknown>;
    expect(body).toEqual({
      ident: 'AAL100',
      origin: 'KJFK',
      start: '2026-09-22',
      end: '2026-09-22',
      max_weekly: 20,
      eta: 0,
      events: {
        filed: false,
        departure: false,
        arrival: false,
        cancelled: true,
        diverted: true,
        out: true,
        off: true,
        on: true,
        in: true,
      },
      target_url: TARGET,
    });
    // Every key we send is one the spec's request body declares; the nine booleans are required.
    const post = spec.resolve(
      required(
        at(spec.root, 'paths', '/alerts', 'post', 'requestBody', 'content', JSON_TYPE, 'schema'),
        'post',
      ),
    );
    for (const key of Object.keys(body)) {
      expect(post.properties.has(key), key).toBe(true);
    }
    expect(
      spec.violations(body['events'], required(post.properties.get('events'), 'events')),
    ).toEqual([]);
    expect(data).toEqual({ alertId: '28754391' });
    expect(call).toMatchObject({
      operation: 'alert_manage',
      result: 'ok',
      httpStatus: 201,
      costUnits: 0,
    });
  });

  it("sets the account-wide endpoint first, to this environment's URL, at most once per isolate", async () => {
    // The spec's alerts tag: PUT /alerts/endpoint "must first be used ... before any alerts can
    // be configured", or POST /alerts answers 400.
    expect(specText).toMatch(/This step must\s+be done before any alerts can be configured/);
    const put = spec.resolve(
      required(
        at(
          spec.root,
          'paths',
          '/alerts/endpoint',
          'put',
          'requestBody',
          'content',
          JSON_TYPE,
          'schema',
        ),
        'put',
      ),
    );
    expect([...put.properties.keys()]).toEqual(['url']);
    expect(at(spec.root, 'paths', '/alerts/endpoint', 'put', 'responses', '204')).toBeDefined();

    const isolate = new Set<string>();
    const stub = fixtureFetch(
      FIXTURES['alert-endpoint-set'] as Fixture,
      FIXTURES['alert-created'] as Fixture,
    );
    const recorder = providerContext();
    await adapter(stub.fetch, { alertTargetUrl: TARGET }, isolate).registerAlert(
      KEY,
      { events: ['out'], maxWeekly: 5 },
      recorder.ctx,
    );
    expect(await stub.requests[0]?.json()).toEqual({ url: TARGET });
    expect(stub.requests[0]?.headers.get('x-apikey')).toBe('aeroapi-test-key');
    // The PUT is not the call registerAlert returns, so the adapter records it: zero cost.
    expect(recorder.logged).toEqual([
      containing({ operation: 'alert_manage', result: 'ok', httpStatus: 204, costUnits: 0 }),
    ]);
    // A second registration in the same isolate (another adapter instance, same key and URL)
    // posts straight away.
    const again = fixtureFetch(FIXTURES['alert-created'] as Fixture);
    await adapter(again.fetch, { alertTargetUrl: TARGET }, isolate).registerAlert(
      KEY,
      { events: ['out'], maxWeekly: 5 },
      providerContext().ctx,
    );
    expect(again.requests.map((r) => r.method)).toEqual(['POST']);
  });

  it('never registers without an https target_url, and never posts when the endpoint PUT is refused', async () => {
    const stub = fixtureFetch(FIXTURES['alert-created'] as Fixture);
    for (const target of [undefined, 'http://insecure.example/hook']) {
      await expect(
        adapter(stub.fetch, { alertTargetUrl: target }).registerAlert(
          KEY,
          { events: ['out'], maxWeekly: 5 },
          providerContext().ctx,
        ),
      ).rejects.toThrow(AeroApiAlertError);
    }
    expect(stub.requests).toHaveLength(0);

    const refused = fixtureFetch(FIXTURES['error-400'] as Fixture);
    const failure = adapter(refused.fetch).registerAlert(
      KEY,
      { events: ['out'], maxWeekly: 1 },
      providerContext().ctx,
    );
    await expect(failure).rejects.toBeInstanceOf(ProviderCallError);
    await failure.catch((error: unknown) => {
      expect((error as ProviderCallError).call).toMatchObject({
        operation: 'alert_manage',
        result: 'error',
        httpStatus: 400,
      });
      expect((error as ProviderCallError).call.error).toMatch(/^alert_endpoint_not_set:http_400/);
    });
    expect(refused.requests.map((r) => r.method)).toEqual(['PUT']);
  });

  it('a 400 for a missing account endpoint is distinct and makes the next registration set it again', async () => {
    const isolate = new Set<string>();
    const first = fixtureFetch(
      FIXTURES['alert-endpoint-set'] as Fixture,
      FIXTURES['error-400-alert-endpoint'] as Fixture,
    );
    const failure = adapter(first.fetch, { alertTargetUrl: TARGET }, isolate).registerAlert(
      KEY,
      { events: ['out'], maxWeekly: 1 },
      providerContext().ctx,
    );
    await expect(failure).rejects.toMatchObject({
      call: { result: 'error', httpStatus: 400, costUnits: 0 },
    });
    await failure.catch((error: unknown) => {
      expect((error as ProviderCallError).call.error).toMatch(/^alert_endpoint_missing:/);
    });
    // Someone deleted the endpoint behind this isolate's back: the next registration PUTs again.
    const second = fixtureFetch(
      FIXTURES['alert-endpoint-set'] as Fixture,
      FIXTURES['alert-created'] as Fixture,
    );
    await adapter(second.fetch, { alertTargetUrl: TARGET }, isolate).registerAlert(
      KEY,
      { events: ['out'], maxWeekly: 1 },
      providerContext().ctx,
    );
    expect(second.requests.map((r) => r.method)).toEqual(['PUT', 'POST']);
  });

  it('a refused registration throws with the record attached, so it is still logged', async () => {
    const stub = fixtureFetch(
      FIXTURES['alert-endpoint-set'] as Fixture,
      FIXTURES['error-400'] as Fixture,
    );
    const failure = adapter(stub.fetch).registerAlert(
      KEY,
      { events: ['out'], maxWeekly: 1 },
      providerContext().ctx,
    );
    await expect(failure).rejects.toBeInstanceOf(ProviderCallError);
    await failure.catch((error: unknown) => {
      expect((error as ProviderCallError).call).toMatchObject({ result: 'error', httpStatus: 400 });
      expect((error as ProviderCallError).call.error).toMatch(/^http_400:/);
    });
    const noLocation = fetchStub((request) =>
      request.method === 'PUT'
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 201 }),
    );
    await expect(
      adapter(noLocation.fetch).registerAlert(
        KEY,
        { events: ['out'], maxWeekly: 1 },
        providerContext().ctx,
      ),
    ).rejects.toMatchObject({ call: { result: 'error', error: 'no_location' } });
  });

  it('registers on the operating designator the key carries (a callsign-resolved codeshare too)', async () => {
    // BA 1512 flown as AAL100 keys as AAL-100-...: the alert is on AAL100, the aircraft AeroAPI
    // tracks, never on AAL1512, which is American's own unrelated flight.
    const stub = fixtureFetch(
      FIXTURES['alert-endpoint-set'] as Fixture,
      FIXTURES['alert-created'] as Fixture,
    );
    await adapter(stub.fetch).registerAlert(
      'AAL-100-2026-09-22-KJFK' as FlightKey,
      { events: ['out'], maxWeekly: 1 },
      providerContext().ctx,
    );
    expect(((await stub.requests[1]?.json()) as { ident: string }).ident).toBe('AAL100');
  });

  it.each([
    ['/aeroapi/alerts/28754391', '28754391'],
    ['https://aeroapi.flightaware.com/aeroapi/alerts/28754391', '28754391'],
    ['/alerts/7/', '7'],
    ['/alerts/abc', null],
    ['', null],
    [null, null],
  ])('parses Location %s', (location, id) => {
    expect(parseAlertLocation(location)).toBe(id);
  });

  it('deletes by id with a 204', async () => {
    const stub = fetchStub(() => new Response(null, { status: 204 }));
    const { data, call } = await adapter(stub.fetch).deleteAlert('28754391', providerContext().ctx);
    expect(stub.requests[0]?.method).toBe('DELETE');
    expect(stub.urls()[0]?.pathname).toBe('/aeroapi/alerts/28754391');
    expect(data).toBeUndefined();
    expect(call).toMatchObject({ result: 'ok', costUnits: 0 });
    await expect(adapter(stub.fetch).deleteAlert('../x', providerContext().ctx)).rejects.toThrow(
      RangeError,
    );
  });

  it('alertEventFlags names all nine, true only for the requested', () => {
    expect(alertEventFlags(['in'])).toEqual({
      filed: false,
      departure: false,
      arrival: false,
      cancelled: false,
      diverted: false,
      out: false,
      off: false,
      on: false,
      in: true,
    });
  });
});

describe('alert deliveries', () => {
  const RECEIVED = new Date('2026-09-22T22:04:30Z');
  const raw = (fixture: string): string =>
    JSON.stringify((FIXTURES[fixture] as Fixture).response.body);

  it('an out delivery becomes a ProviderEvent carrying a patch, keyed by alert id and body digest', async () => {
    const event = await parseAeroApiAlert(raw('alert-delivery-out'), RECEIVED);
    expect(ProviderEventSchema.safeParse(event).success).toBe(true);
    expect(event).toMatchObject({
      provider: 'aeroapi',
      kind: 'out',
      receivedAt: '2026-09-22T22:04:30.000Z',
      flightRef: { providerRef: { provider: 'aeroapi', providerId: FA_FLIGHT_ID } },
    });
    expect(event.externalId).toMatch(/^28754391:[0-9a-f]{32}$/);
    const again = await parseAeroApiAlert(
      raw('alert-delivery-out'),
      new Date('2026-09-22T22:05:00Z'),
    );
    expect(again.externalId).toBe(event.externalId);
    const other = await parseAeroApiAlert(raw('alert-delivery-change'), RECEIVED);
    expect(other.externalId).not.toBe(event.externalId);
    expect((event.payload as AeroApiAlertPatch).times).toMatchObject({
      actualOut: '2026-09-22T22:04:00.000Z',
    });
  });

  it('maps every one of the 18 codes tolerantly and an unknown code to unknown, never throwing', async () => {
    const body = (FIXTURES['alert-delivery-out'] as Fixture).response.body as Record<
      string,
      unknown
    >;
    const kinds = await Promise.all(
      AEROAPI_EVENT_CODES.map(
        async (code) =>
          (await parseAeroApiAlert(JSON.stringify({ ...body, event_code: code }), RECEIVED)).kind,
      ),
    );
    expect(kinds).toEqual([
      'filed',
      'departure',
      'arrival',
      'out',
      'off',
      'on',
      'in',
      'diverted',
      'cancelled',
      'update',
      'update',
      'update',
      'update',
      'update',
      'update',
      'update',
      'update',
      'update',
    ]);
    const unknown = await parseAeroApiAlert(raw('alert-delivery-unknown-code'), RECEIVED);
    expect(unknown.kind).toBe('unknown');
    expect((unknown.payload as AeroApiAlertPatch).eventCode).toBe('taxi_stop');
  });

  it.each([
    ['not JSON', '{'],
    [
      'no event_code',
      JSON.stringify({ ...((alertOut as Fixture).response.body as object), event_code: undefined }),
    ],
    [
      'a numeric event_code',
      JSON.stringify({ ...((alertOut as Fixture).response.body as object), event_code: 7 }),
    ],
    [
      'no flight',
      JSON.stringify({ ...((alertOut as Fixture).response.body as object), flight: undefined }),
    ],
    [
      'no fa_flight_id',
      JSON.stringify({
        ...((alertOut as Fixture).response.body as object),
        flight: { ident: 'AAL100' },
      }),
    ],
    [
      'a string alert_id',
      JSON.stringify({ ...((alertOut as Fixture).response.body as object), alert_id: '1' }),
    ],
  ])('rejects a delivery with %s', async (_label, text) => {
    await expect(parseAeroApiAlert(text, RECEIVED)).rejects.toThrow(AeroApiAlertError);
  });

  it('merges a delivery onto the last snapshot instead of replacing it', async () => {
    const polled = await adapter(
      fixtureFetch(FIXTURES['flight-by-ident'] as Fixture).fetch,
    ).getFlight(
      { carrier: { icao: 'AAL' }, flightNumber: '100', dateLocal: '2026-09-22' },
      providerContext({ now: '2026-09-22T20:00:00Z' }).ctx,
    );
    const snapshot = polled.data[0] as Exact<FlightStatus>;
    const change = (await parseAeroApiAlert(raw('alert-delivery-change'), RECEIVED))
      .payload as AeroApiAlertPatch;
    const merged = mergeAeroApiAlert(snapshot, change, new Date('2026-09-22T22:10:00Z'));
    // Identity, airports (with their time zones) and codeshares are the snapshot's.
    expect(merged.origin).toEqual(snapshot.origin);
    expect(merged.destination).toEqual(snapshot.destination);
    expect(merged.codeshares).toEqual(snapshot.codeshares);
    expect(merged.fetchedAt).toBe(snapshot.fetchedAt);
    expect(merged).toMatchObject({ originGate: 'B36', status: 'boarding' });
    expect(merged.times.estimatedOut).toBe('2026-09-22T22:45:00.000Z');
    expect(merged.fieldQuality).toMatchObject({ estimatedOut: 'estimated', gate: 'live' });
    // The snapshot itself is untouched.
    expect(snapshot.originGate).toBe('B32');

    const out = (await parseAeroApiAlert(raw('alert-delivery-out'), RECEIVED))
      .payload as AeroApiAlertPatch;
    const departed = mergeAeroApiAlert(merged, out, new Date('2026-09-22T22:05:00Z'));
    expect(departed.status).toBe('departed');
    expect(departed.times.actualOut).toBe('2026-09-22T22:04:00.000Z');

    const other = mergeAeroApiAlert(snapshot, { ...out, faFlightId: 'SOMEONE-ELSE' }, new Date());
    expect(other).toBe(snapshot);
  });

  it('a merge keeps the scheduled_off fallback the poll used, so a known status stays known', () => {
    const polled = mergeAeroApiAlert(
      {
        operatingCarrierIcao: 'AAL',
        flightNumber: '100',
        legSeq: 1,
        codeshares: [],
        origin: { icao: 'KJFK', tz: 'America/New_York' },
        destination: { icao: 'EGLL' },
        // A flight AeroAPI knows only by its runway schedule: no scheduled_out.
        status: 'scheduled',
        times: { scheduledOff: '2026-09-22T22:15:00.000Z' },
        providerRefs: { aeroapi: FA_FLIGHT_ID },
        fetchedAt: '2026-09-22T20:00:00.000Z',
        source: 'aeroapi',
        fieldQuality: {},
      },
      {
        source: 'aeroapi_alert',
        faFlightId: FA_FLIGHT_ID,
        eventCode: 'change',
        times: { estimatedOff: '2026-09-22T22:40:00.000Z' },
      },
      new Date('2026-09-22T21:00:00Z'),
    );
    expect(polled.status).toBe('scheduled');
    expect(
      mergeAeroApiAlert(
        polled,
        {
          source: 'aeroapi_alert',
          faFlightId: FA_FLIGHT_ID,
          eventCode: 'change',
          times: {},
        },
        new Date('2026-09-22T22:10:00Z'),
      ).status,
    ).toBe('boarding');
  });

  it('parseWebhook on the adapter reads the request and stamps it with its clock', async () => {
    const events = await adapter(fixtureFetch(FIXTURES['error-400'] as Fixture).fetch).parseWebhook(
      new Request('https://x.test/', { method: 'POST', body: raw('alert-delivery-out') }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.receivedAt).toBe('2026-09-22T22:05:00.000Z');
  });
});

describe('fixture transport', () => {
  it('serves the 201 with its Location and no body', () => {
    const response = fixtureResponse(FIXTURES['alert-created'] as Fixture);
    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe('/aeroapi/alerts/28754391');
  });
});
