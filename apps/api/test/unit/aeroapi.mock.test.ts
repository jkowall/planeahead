/**
 * The AeroAPI adapter (mocked: no key in Phase 0) against the vendored OpenAPI 4.17.1 and
 * fixtures shaped strictly from it. Two request rules are pinned (the bracketed first fetch, then
 * `fa_flight_id` with `max_pages=1`), the diverted two-item response, alert registration with the
 * nine booleans and a mandatory per-alert `target_url`, the `Location` header, the 18 event codes
 * and the merge of a delivery onto a snapshot.
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
  AeroApiAdapter,
  AeroApiAlertError,
  alertEventFlags,
  bracketLocalDate,
  bracketWindow,
  mergeAeroApiAlert,
  parseAeroApiAlert,
  parseAlertLocation,
  type AeroApiAlertPatch,
} from '../../src/providers/aeroapi.mock';
import { ProviderCallError } from '../../src/providers/http';
import airportDepartures from '../../src/providers/fixtures/aeroapi/airport-departures.json';
import alertCreated from '../../src/providers/fixtures/aeroapi/alert-created.json';
import alertChange from '../../src/providers/fixtures/aeroapi/alert-delivery-change.json';
import alertOut from '../../src/providers/fixtures/aeroapi/alert-delivery-out.json';
import alertUnknown from '../../src/providers/fixtures/aeroapi/alert-delivery-unknown-code.json';
import error400 from '../../src/providers/fixtures/aeroapi/error-400.json';
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
  'error-400': error400,
  'flight-by-id-en-route': flightById,
  'flight-by-ident': flightByIdent,
  'flight-diverted': flightDiverted,
  'flight-empty': flightEmpty,
  'rate-limited-429': rateLimited,
};

const FA_FLIGHT_ID = 'AAL100-1758341600-schedule-0391';
const KEY = 'AAL-100-2026-09-22-KJFK' as FlightKey;
const TARGET = 'https://api-staging.planeahead.app/v1/webhooks/aeroapi/token-for-this-environment';

function adapter(
  fetch: ReturnType<typeof fixtureFetch>['fetch'],
  target: { readonly alertTargetUrl: string | undefined } = { alertTargetUrl: TARGET },
) {
  return new AeroApiAdapter({
    apiKey: 'aeroapi-test-key',
    fetch,
    alertTargetUrl: target.alertTargetUrl,
    now: () => new Date('2026-09-22T22:05:00Z'),
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
    // Clamped on the far side: a flight 2.5 days out only gets the window up to now + 2 days.
    expect(bracketWindow('2026-09-25T00:00:00Z', now)).toEqual({
      start: '2026-09-24T00:00:00Z',
      end: '2026-09-24T12:00:00Z',
    });
    // More than 3 days out, nothing is reachable: AeroAPI cannot see it.
    expect(bracketWindow('2026-09-26T00:00:00Z', now)).toBeNull();
    // Clamped at 10 days back.
    expect(bracketWindow('2026-09-12T06:00:00Z', now)).toEqual({
      start: '2026-09-12T12:00:00Z',
      end: '2026-09-13T06:00:00Z',
    });
    expect(bracketWindow('garbage', now)).toBeNull();
    // Only the local date known: every zone's local day is inside the bracket.
    expect(bracketLocalDate('2026-09-22', now)).toEqual({
      start: '2026-09-21T10:00:00Z',
      end: '2026-09-23T12:00:00Z',
    });
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
      { from: '2026-09-22T20:00:00Z', to: '2026-09-23T02:00:00Z' },
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
});

describe('alerts', () => {
  it('registers the nine booleans, the instance, max_weekly and a per-alert target_url; the id comes from Location', async () => {
    const stub = fixtureFetch(FIXTURES['alert-created'] as Fixture);
    const { data, call } = await adapter(stub.fetch).registerAlert(
      KEY,
      { events: ['out', 'off', 'on', 'in', 'cancelled', 'diverted'], maxWeekly: 20 },
      providerContext().ctx,
    );
    const request = stub.requests[0];
    expect(request?.method).toBe('POST');
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

  it('never registers without a per-alert https target_url (no account-wide endpoint)', async () => {
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
    // The adapter has no method that touches PUT /alerts/endpoint at all.
    expect(
      Object.getOwnPropertyNames(AeroApiAdapter.prototype).some((m) => /endpoint/i.test(m)),
    ).toBe(false);
  });

  it('a refused registration throws with the record attached, so it is still logged', async () => {
    const stub = fixtureFetch(FIXTURES['error-400'] as Fixture);
    const failure = adapter(stub.fetch).registerAlert(
      KEY,
      { events: ['out'], maxWeekly: 1 },
      providerContext().ctx,
    );
    await expect(failure).rejects.toBeInstanceOf(ProviderCallError);
    await failure.catch((error: unknown) => {
      expect((error as ProviderCallError).call).toMatchObject({ result: 'error', httpStatus: 400 });
    });
    const noLocation = fetchStub(() => new Response(null, { status: 201 }));
    await expect(
      adapter(noLocation.fetch).registerAlert(
        KEY,
        { events: ['out'], maxWeekly: 1 },
        providerContext().ctx,
      ),
    ).rejects.toMatchObject({ call: { result: 'error', error: 'no_location' } });
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
