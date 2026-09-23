/**
 * The AeroDataBox adapter against the vendored direct-gateway OpenAPI 1.15.3.0 and fixtures
 * shaped strictly from it. Every request goes to an injected `fetch` that serves a fixture; no
 * test reaches api.aerodatabox.com. When a key exists, `scripts/record-adb-fixtures.mjs`
 * replaces the synthetic fixtures with recorded ones and these tests must still pass.
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalizeFromProvider,
  type FlightKey,
  type ProviderCallRecord,
} from '@planeahead/shared';
import specText from '../../src/providers/specs/aerodatabox-direct-v1.15.3.yaml?raw';
import {
  AERODATABOX_BASE_URL,
  AeroDataBoxAdapter,
  WebhookPayloadError,
  parseAdbNotification,
} from '../../src/providers/aerodatabox.adapter';
import { ADB_PLANS } from '../../src/providers/config';
import airportKjfk from '../../src/providers/fixtures/aerodatabox/airport-kjfk.json';
import cloudflare403 from '../../src/providers/fixtures/aerodatabox/cloudflare-403.json';
import fidsKjfkArrivals from '../../src/providers/fixtures/aerodatabox/fids-kjfk-arrivals.json';
import fidsKjfk from '../../src/providers/fixtures/aerodatabox/fids-kjfk-departures.json';
import flightArrived from '../../src/providers/fixtures/aerodatabox/flight-arrived.json';
import flightCancelled from '../../src/providers/fixtures/aerodatabox/flight-cancelled.json';
import flightCodeshared from '../../src/providers/fixtures/aerodatabox/flight-codeshared.json';
import flightCodesharedRegional from '../../src/providers/fixtures/aerodatabox/flight-codeshared-regional.json';
import flightDelayedGate from '../../src/providers/fixtures/aerodatabox/flight-delayed-gate.json';
import flightDiverted from '../../src/providers/fixtures/aerodatabox/flight-diverted.json';
import flightLanded from '../../src/providers/fixtures/aerodatabox/flight-landed.json';
import flightOvernightBoth from '../../src/providers/fixtures/aerodatabox/flight-overnight-both.json';
import flightScheduled from '../../src/providers/fixtures/aerodatabox/flight-scheduled.json';
import healthKjfk from '../../src/providers/fixtures/aerodatabox/health-kjfk.json';
import legal451 from '../../src/providers/fixtures/aerodatabox/legal-451.json';
import miss204 from '../../src/providers/fixtures/aerodatabox/miss-204.json';
import notification from '../../src/providers/fixtures/aerodatabox/notification.json';
import { OpenApiDoc, at, keysOf, listOf, sha256HexOf } from './helpers/openapi';
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
const ADB_SPEC_SHA256 = '9d2d6b908c57dc9a3e3f9b24ff5df9074d26c5f344011c8f412e6843ffb2c4b5';

const spec = new OpenApiDoc(specText);

const FIXTURES: Record<string, Fixture> = {
  'airport-kjfk': airportKjfk,
  'cloudflare-403': cloudflare403,
  'fids-kjfk-arrivals': fidsKjfkArrivals,
  'fids-kjfk-departures': fidsKjfk,
  'flight-arrived': flightArrived,
  'flight-cancelled': flightCancelled,
  'flight-codeshared': flightCodeshared,
  'flight-codeshared-regional': flightCodesharedRegional,
  'flight-delayed-gate': flightDelayedGate,
  'flight-diverted': flightDiverted,
  'flight-landed': flightLanded,
  'flight-overnight-both': flightOvernightBoth,
  'flight-scheduled': flightScheduled,
  'health-kjfk': healthKjfk,
  'legal-451': legal451,
  'miss-204': miss204,
  notification: notification,
};

const KEY = 'AAL-100-2026-09-22-KJFK' as FlightKey;
const API_KEY = 'adb-test-key';

function adapter(fetch: ReturnType<typeof fixtureFetch>['fetch'], alertsEnabled = false) {
  return new AeroDataBoxAdapter({
    apiKey: API_KEY,
    fetch,
    plan: ADB_PLANS.growth,
    alertsEnabled,
    now: () => new Date('2026-09-22T20:45:30Z'),
  });
}

const AA100 = { carrier: { iata: 'AA' }, flightNumber: '100', dateLocal: '2026-09-22' } as const;
const KJFK_EVENING = {
  from: '2026-09-22T17:00',
  to: '2026-09-23T17:00',
  tz: 'America/New_York',
} as const;

/**
 * A fetch that answers `/flights/Number/{designator}/{date}` from `items` the way the spec says
 * the gateway does: with `dateLocalRole=Departure` only the flights departing on the date
 * (origin-local), with `Both` (the default) also those that only ARRIVE on it.
 */
function byLocalRole(items: readonly Record<string, unknown>[]) {
  return fetchStub((request) => {
    const url = new URL(request.url);
    const date = url.pathname.split('/').at(-1) ?? '';
    const role = url.searchParams.get('dateLocalRole') ?? 'Both';
    const localDate = (movement: unknown): string =>
      ((movement as { scheduledTime?: { local?: string } }).scheduledTime?.local ?? '').slice(
        0,
        10,
      );
    const matching = items.filter(
      (item) =>
        localDate(item['departure']) === date ||
        (role === 'Both' && localDate(item['arrival']) === date),
    );
    return matching.length === 0
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(matching), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
  });
}

describe('the vendored direct-gateway spec', () => {
  it('is the pinned 1.15.3.0 snapshot', async () => {
    expect(await sha256HexOf(specText)).toBe(ADB_SPEC_SHA256);
    expect(at(spec.root, 'info', 'version')?.value).toBe('1.15.3.0');
    expect(at(spec.root, 'servers', 0, 'url')?.value).toBe(AERODATABOX_BASE_URL);
  });

  it('authenticates with the X-Api-Key header', () => {
    const scheme = at(spec.root, 'components', 'securitySchemes', 'X-Api-Key');
    expect(at(scheme, 'in')?.value).toBe('header');
    expect(at(scheme, 'name')?.value).toBe('X-Api-Key');
  });

  it('declares the flight status path, its casing, its 204 miss and its 451', () => {
    const operation = at(
      spec.root,
      'paths',
      '/flights/{searchBy}/{searchParam}/{dateLocal}',
      'get',
    );
    expect(listOf(at(spec.schema('FlightSearchByEnum'), 'enum'))).toContain('Number');
    expect(keysOf(at(operation, 'responses')).sort()).toEqual(
      ['200', '204', '400', '401', '451', '500', '503'].sort(),
    );
    expect(
      at(operation, 'responses', '200', 'content', 'application/json', 'schema', 'type')?.value,
    ).toBe('array');
    expect(at(operation, 'x-badges', 0, 'name')?.value).toBe('TIER 2');
    // withFlightPlan exists, bills twice on Starter, and the adapter never sends it.
    const parameters = (at(operation, 'parameters')?.children ?? []).map(
      (p) => at(p, 'name')?.value,
    );
    expect(parameters).toContain('withFlightPlan');
    // No 429 is declared anywhere, although per-second limits exist (facts sheet section 1).
    expect(specText).not.toMatch(/'429':/);
  });

  it('prices the airport lookup as TIER 1 and the health check as FREE TIER', () => {
    expect(
      at(spec.root, 'paths', '/airports/{codeType}/{code}', 'get', 'x-badges', 0, 'name')?.value,
    ).toBe('TIER 1');
    expect(
      at(spec.root, 'paths', '/health/services/airports/{icao}/feeds', 'get', 'x-badges', 0, 'name')
        ?.value,
    ).toBe('FREE TIER');
    expect(
      at(
        spec.root,
        'paths',
        '/flights/airports/{codeType}/{code}/{fromLocal}/{toLocal}',
        'get',
        'x-badges',
        0,
        'name',
      )?.value,
    ).toBe('TIER 2');
  });

  it('has no operating carrier and no codeshare list on a flight (only the marker)', () => {
    const properties = keysOf(at(spec.schema('FlightContract'), 'properties'));
    expect(properties).toContain('codeshareStatus');
    expect(properties).toContain('callSign');
    expect(properties.filter((p) => /operat/i.test(p) || p === 'codeshares')).toEqual([]);
    expect(keysOf(at(spec.schema('DateTimeContract'), 'properties')).sort()).toEqual([
      'local',
      'utc',
    ]);
  });
});

describe('fixtures', () => {
  it.each(Object.entries(FIXTURES).filter(([, f]) => f.schema !== null))(
    '%s is shaped strictly by its schema',
    (_name, fixture) => {
      const schema = fixture.schema ?? '';
      const body = fixture.response.body;
      const errors = schema.endsWith('[]')
        ? (body as unknown[]).flatMap((item, i) =>
            spec.violations(item, spec.schema(schema.slice(0, -2)), `$[${String(i)}]`),
          )
        : spec.violations(body, spec.schema(schema));
      expect(errors).toEqual([]);
    },
  );

  it('the synthetic 204 has no body and the 403 is not JSON', () => {
    expect(miss204.response).toEqual({ status: 204 });
    expect((cloudflare403 as Fixture).response.contentType).toMatch(/^text\/html/);
  });
});

describe('getFlight: the request', () => {
  it('asks /flights/Number/{designator}/{dateLocal} by DEPARTURE date, with X-Api-Key and never withFlightPlan', async () => {
    const stub = fixtureFetch(FIXTURES['flight-delayed-gate'] as Fixture);
    const { ctx } = providerContext({ flightKey: KEY });
    await adapter(stub.fetch).getFlight(AA100, ctx);

    expect(stub.requests).toHaveLength(1);
    const request = stub.requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.url).toBe(
      'https://api.aerodatabox.com/flights/Number/AA100/2026-09-22?dateLocalRole=Departure',
    );
    expect(request?.headers.get('X-Api-Key')).toBe(API_KEY);
    expect(new URL(request?.url ?? '').searchParams.has('withFlightPlan')).toBe(false);
    expect(Object.fromEntries(new URL(request?.url ?? '').searchParams)).toEqual({
      dateLocalRole: 'Departure',
    });
    // The parameter and the value exist on this path in the vendored spec.
    const parameters =
      at(spec.root, 'paths', '/flights/{searchBy}/{searchParam}/{dateLocal}', 'get', 'parameters')
        ?.children ?? [];
    const role = parameters.find((p) => at(p, 'name')?.value === 'dateLocalRole');
    expect(at(role, 'in')?.value).toBe('query');
    expect(listOf(at(spec.schema('FlightDirection'), 'enum'))).toContain('Departure');
  });

  it.each(['alarm', 'reconcile', 'user_refresh', 'provider_alert', 'user_search'] as const)(
    'an overnight flight: %s gets the departure on the date asked, never the previous night',
    async (trigger) => {
      const items = (FIXTURES['flight-overnight-both'] as Fixture).response.body as Record<
        string,
        unknown
      >[];
      // Without the role the gateway would answer both, the 22nd's departure first.
      const both = byLocalRole(items);
      const defaultRole = await both
        .fetch(new Request('https://api.aerodatabox.com/flights/Number/AA100/2026-09-23'))
        .then((r) => r.json());
      expect(defaultRole).toHaveLength(2);

      const stub = byLocalRole(items);
      const { ctx } = providerContext({ trigger, now: '2026-09-23T02:00:00Z' });
      const { data, call } = await adapter(stub.fetch).getFlight(
        { ...AA100, dateLocal: '2026-09-23' },
        ctx,
      );
      expect(stub.requests).toHaveLength(1);
      expect(call).toMatchObject({ result: 'ok', costUnits: 2 });
      expect(data.map((flight) => [flight.scheduledDepartureDateLocal, flight.status])).toEqual([
        ['2026-09-23', 'scheduled'],
      ]);
    },
  );

  it('uses the ICAO code when the lookup has no IATA code and normalises the number', async () => {
    const stub = fixtureFetch(FIXTURES['flight-delayed-gate'] as Fixture);
    const { ctx } = providerContext();
    await adapter(stub.fetch).getFlight(
      { carrier: { icao: 'AAL' }, flightNumber: '0100', dateLocal: '2026-09-22' },
      ctx,
    );
    expect(stub.urls()[0]?.pathname).toBe('/flights/Number/AAL100/2026-09-22');
  });

  it('reads the lookahead from the plan and refuses a date beyond it without a call', async () => {
    const stub = fixtureFetch(FIXTURES['flight-scheduled'] as Fixture);
    const starter = new AeroDataBoxAdapter({
      apiKey: API_KEY,
      fetch: stub.fetch,
      plan: ADB_PLANS.starter,
      now: () => new Date(),
    });
    expect(starter.capabilities.maxDaysAhead).toBe(180);
    expect(adapter(stub.fetch).capabilities).toMatchObject({
      maxDaysAhead: 365,
      fidsWindowHours: 24,
    });
    const { ctx, reservations } = providerContext({ now: '2026-09-22T12:00:00Z' });
    const result = await starter.getFlight({ ...AA100, dateLocal: '2027-04-10' }, ctx);
    expect(stub.requests).toHaveLength(0);
    expect(reservations).toHaveLength(0);
    expect(result.data).toEqual([]);
    expect(result.call).toMatchObject({
      result: 'error',
      costUnits: 0,
      error: 'beyond_max_days_ahead:180',
    });
  });
});

describe('getFlight: mapping', () => {
  async function mapped(fixture: string, now = '2026-09-22T20:00:00Z') {
    const { ctx } = providerContext({ now, flightKey: KEY });
    return adapter(fixtureFetch(FIXTURES[fixture] as Fixture).fetch).getFlight(AA100, ctx);
  }

  it('a schedule-only flight: times from .utc, the local date from .local, codeshares empty', async () => {
    const { data, call } = await mapped('flight-scheduled');
    expect(call).toMatchObject({ result: 'ok', costUnits: 2, httpStatus: 200 });
    expect(data).toEqual([
      {
        operatingCarrierIcao: 'AAL',
        operatorSource: 'provider',
        marketingCarrierIcao: 'AAL',
        marketingFlightNumber: '100',
        flightNumber: '100',
        legSeq: 1,
        codeshares: [],
        origin: { icao: 'KJFK', iata: 'JFK', tz: 'America/New_York' },
        destination: { icao: 'EGLL', iata: 'LHR', tz: 'Europe/London' },
        status: 'scheduled',
        times: {
          scheduledOut: '2026-09-29T22:00:00.000Z',
          scheduledIn: '2026-09-30T05:10:00.000Z',
        },
        providerRefs: { aerodatabox: 'AA100/2026-09-29' },
        fetchedAt: '2026-09-22T20:00:00.000Z',
        source: 'aerodatabox',
        fieldQuality: { scheduledOut: 'schedule', scheduledIn: 'schedule' },
        scheduledDepartureDateLocal: '2026-09-29',
        routeDistanceKm: 5539.97,
      },
    ]);
  });

  it('delayed with a live gate: revisedTime is an estimate at Delayed, the gate is live', async () => {
    const { data } = await mapped('flight-delayed-gate', '2026-09-22T22:40:00Z');
    const status = data[0];
    expect(status?.times).toEqual({
      scheduledOut: '2026-09-22T22:00:00.000Z',
      scheduledIn: '2026-09-23T05:10:00.000Z',
      estimatedOut: '2026-09-22T23:10:00.000Z',
      estimatedIn: '2026-09-23T06:05:00.000Z',
    });
    expect(status?.fieldQuality).toMatchObject({
      estimatedOut: 'estimated',
      estimatedIn: 'estimated',
      gate: 'live',
    });
    expect(status).toMatchObject({
      departureDelaySec: 4_200,
      arrivalDelaySec: 3_300,
      originTerminal: '8',
      originGate: 'B32',
      destinationTerminal: '3',
      registration: 'N717AN',
      icaoHex: 'A9A0F7',
      codeshares: [],
      // 22:40 is inside the 40 minutes before the 23:10 estimate, not the 22:00 schedule.
      status: 'boarding',
    });
    const earlier = await mapped('flight-delayed-gate', '2026-09-22T21:30:00Z');
    expect(earlier.data[0]?.status).toBe('scheduled');
  });

  it('cancelled comes from the Canceled flag, not from the status string', async () => {
    const { data } = await mapped('flight-cancelled');
    expect(data[0]?.status).toBe('cancelled');
    expect(data[0]?.times.actualOut).toBeUndefined();
  });

  it('diverted: departure times are actuals, the arrival airport is left as reported (unverified)', async () => {
    const { data } = await mapped('flight-diverted', '2026-09-23T03:00:00Z');
    expect(data[0]).toMatchObject({
      status: 'diverted',
      times: { actualOut: '2026-09-22T22:20:00.000Z', actualOff: '2026-09-22T22:41:00.000Z' },
      fieldQuality: { actualOut: 'live', actualOff: 'live' },
      destination: { icao: 'EGLL' },
    });
    expect(data[0]?.actualDestination).toBeUndefined();
  });

  it('landed: an arrival runway time without a gate time is on, not in', async () => {
    const { data } = await mapped('flight-landed', '2026-09-23T05:01:00Z');
    expect(data[0]?.status).toBe('landed');
    expect(data[0]?.times).toMatchObject({
      actualOut: '2026-09-22T22:05:00.000Z',
      actualOff: '2026-09-22T22:24:00.000Z',
      actualOn: '2026-09-23T04:58:00.000Z',
    });
    expect(data[0]?.times.actualIn).toBeUndefined();
  });

  it('arrived: in, on, the belt and the arrival gate', async () => {
    const { data } = await mapped('flight-arrived', '2026-09-23T05:20:00Z');
    expect(data[0]).toMatchObject({
      status: 'arrived',
      times: { actualIn: '2026-09-23T05:07:00.000Z', actualOn: '2026-09-23T04:58:00.000Z' },
      destinationGate: 'C64',
      baggageClaim: '7',
      fieldQuality: { actualIn: 'live', baggage: 'live', gate: 'live' },
      arrivalDelaySec: -180,
    });
  });

  it('a codeshare resolves its operating designator from the callsign and keeps the marketing identity', async () => {
    const { data } = await mapped('flight-codeshared');
    expect(data[0]).toMatchObject({
      operatingCarrierIcao: 'AAL',
      operatorSource: 'callsign',
      marketingCarrierIcao: 'BAW',
      marketingFlightNumber: '1512',
      // The callsign AAL100 is the operating designator: carrier AND number.
      flightNumber: '100',
      codeshares: [],
      providerRefs: { aerodatabox: 'BA1512/2026-09-22' },
    });
    expect(canonicalizeFromProvider(data[0] as never)).toBe('AAL-100-2026-09-22-KJFK');
  });

  it('a callsign codeshare never takes the key of an unrelated flight with the marketing number', async () => {
    // BA 1512 flown as AAL100, and American's own AA 1512 from the same airport the same day.
    const codeshare = (await mapped('flight-codeshared')).data[0];
    const body = (flightCodeshared as Fixture).response.body as Record<string, unknown>[];
    const realAa1512 = {
      ...body[0],
      number: 'AA 1512',
      callSign: 'AAL1512',
      codeshareStatus: 'IsOperator',
      airline: { name: 'American', iata: 'AA', icao: 'AAL' },
    };
    const stub = fetchStub(() =>
      fixtureResponse({
        ...(flightCodeshared as Fixture),
        response: { status: 200, body: [realAa1512] },
      }),
    );
    const real = (
      await adapter(stub.fetch).getFlight(
        { carrier: { iata: 'AA' }, flightNumber: '1512', dateLocal: '2026-09-22' },
        providerContext({ flightKey: KEY }).ctx,
      )
    ).data[0];
    const keys = [codeshare, real].map((status) => canonicalizeFromProvider(status as never));
    expect(keys).toEqual(['AAL-100-2026-09-22-KJFK', 'AAL-1512-2026-09-22-KJFK']);
    expect(new Set(keys).size).toBe(2);
  });

  it('an alphanumeric ATC callsign is not a designator: the marketing identity stands', async () => {
    const body = (flightCodeshared as Fixture).response.body as Record<string, unknown>[];
    const stub = fetchStub(() =>
      fixtureResponse({
        ...(flightCodeshared as Fixture),
        response: { status: 200, body: [{ ...body[0], callSign: 'AAL12AB' }] },
      }),
    );
    const { data } = await adapter(stub.fetch).getFlight(
      { carrier: { iata: 'BA' }, flightNumber: '1512', dateLocal: '2026-09-22' },
      providerContext().ctx,
    );
    expect(data[0]).toMatchObject({
      operatingCarrierIcao: 'BAW',
      flightNumber: '1512',
      operatorSource: 'marketing',
    });
  });

  it('a regional codeshare without a callsign takes the operator hint', async () => {
    const { data } = await mapped('flight-codeshared-regional');
    expect(data[0]).toMatchObject({
      operatingCarrierIcao: 'ENY',
      operatorSource: 'hint',
      marketingCarrierIcao: 'AAL',
      flightNumber: '3456',
      origin: { icao: 'KORD', tz: 'America/Chicago' },
      scheduledDepartureDateLocal: '2026-09-22',
    });
  });

  it('never has codeshares, whatever the fixture', async () => {
    for (const name of Object.keys(FIXTURES).filter((n) => n.startsWith('flight-'))) {
      const { data } = await mapped(name);
      for (const status of data) {
        expect(status.codeshares).toEqual([]);
      }
    }
  });

  it('skips an item it cannot key and says so on the record', async () => {
    const body = [
      (flightScheduled as Fixture).response.body,
      {
        ...(((flightScheduled as Fixture).response.body as unknown[])[0] as object),
        number: 'not a flight',
      },
    ].flat();
    const stub = fetchStub(() =>
      fixtureResponse({ ...(flightScheduled as Fixture), response: { status: 200, body } }),
    );
    const { ctx } = providerContext();
    const { data, call } = await adapter(stub.fetch).getFlight(AA100, ctx);
    expect(data).toHaveLength(1);
    expect(call.result).toBe('ok');
    expect(call.error).toMatch(/^skipped 1: unparseable flight number/);
  });

  it('measures latency on the injected clock and stamps the record', async () => {
    const recorder = providerContext({
      now: '2026-09-22T20:00:00.000Z',
      flightKey: KEY,
      trigger: 'alarm',
    });
    const stub = fetchStub(() => {
      recorder.setNow('2026-09-22T20:00:00.412Z');
      return fixtureResponse(FIXTURES['flight-scheduled'] as Fixture);
    });
    const { call } = await adapter(stub.fetch).getFlight(AA100, recorder.ctx);
    expect(call).toMatchObject({
      provider: 'aerodatabox',
      operation: 'flight_status',
      trigger: 'alarm',
      flightKey: KEY,
      requestId: 'req-provider-test',
      startedAt: '2026-09-22T20:00:00.000Z',
      latencyMs: 412,
      httpStatus: 200,
      result: 'ok',
      costUnits: 2,
      pollEquivalents: 0.1,
      estCostUsdMicros: 500,
    });
    expect(call.responseBytes).toBeGreaterThan(100);
    expect(recorder.reservations).toEqual([
      {
        provider: 'aerodatabox',
        operation: 'flight_status',
        pollEquivalents: 0.1,
        trigger: 'alarm',
        flightKey: KEY,
        utcDate: '2026-09-22',
      },
    ]);
  });
});

describe('getFlight: misses, suppression and push-back', () => {
  /** A 204 whose json() throws: the adapter must never call it. */
  function strict204(): Response {
    const response = new Response(null, { status: 204 });
    Object.defineProperty(response, 'json', {
      value: () => {
        throw new Error('json() called on a 204');
      },
    });
    return response;
  }

  it('a 204 is a billed miss that is never parsed; a tracker poll does not retry', async () => {
    const stub = fetchStub(() => strict204());
    const recorder = providerContext({ trigger: 'alarm' });
    const { data, call } = await adapter(stub.fetch).getFlight(AA100, recorder.ctx);
    expect(stub.requests).toHaveLength(1);
    expect(data).toEqual([]);
    expect(call).toMatchObject({
      result: 'not_found',
      httpStatus: 204,
      costUnits: 2,
      estCostUsdMicros: 500,
    });
    expect(recorder.logged).toEqual([]);
    expect(recorder.releases).toEqual([]);
  });

  it('a person-supplied date retries the day before and the day after, and every miss is billed once', async () => {
    const stub = fetchStub(() => strict204());
    const recorder = providerContext({ trigger: 'user_search' });
    const { data, call } = await adapter(stub.fetch).getFlight(AA100, recorder.ctx);
    expect(stub.urls().map((url) => url.pathname)).toEqual([
      '/flights/Number/AA100/2026-09-22',
      '/flights/Number/AA100/2026-09-21',
      '/flights/Number/AA100/2026-09-23',
    ]);
    expect(data).toEqual([]);
    // Two misses recorded by the adapter, the third returned for the caller to record.
    expect(recorder.logged.map((r) => [r.result, r.costUnits])).toEqual([
      ['not_found', 2],
      ['not_found', 2],
    ]);
    expect(call).toMatchObject({ result: 'not_found', costUnits: 2 });
    const all: ProviderCallRecord[] = [...recorder.logged, call];
    expect(new Set(all.map((r) => r.id)).size).toBe(3);
    expect(all.reduce((sum, r) => sum + r.costUnits, 0)).toBe(6);
    expect(recorder.reservations).toHaveLength(3);
  });

  it('a retry that hits returns the neighbouring day and records the miss before it', async () => {
    const stub = fetchStub((_request, index) =>
      index === 0 ? strict204() : fixtureResponse(FIXTURES['flight-delayed-gate'] as Fixture),
    );
    const recorder = providerContext({ trigger: 'import' });
    const { data, call } = await adapter(stub.fetch).getFlight(
      { ...AA100, dateLocal: '2026-09-23' },
      recorder.ctx,
    );
    expect(stub.urls().map((url) => url.pathname)).toEqual([
      '/flights/Number/AA100/2026-09-23',
      '/flights/Number/AA100/2026-09-22',
    ]);
    expect(data[0]?.scheduledDepartureDateLocal).toBe('2026-09-22');
    expect(call.result).toBe('ok');
    expect(recorder.logged.map((r) => r.result)).toEqual(['not_found']);
  });

  it("an empty array is a billed not_found, like a 204 (and like AeroAPI's empty result set)", async () => {
    const stub = fetchStub(() =>
      fixtureResponse({ ...(miss204 as Fixture), response: { status: 200, body: [] } }),
    );
    const { ctx } = providerContext();
    const { data, call } = await adapter(stub.fetch).getFlight(AA100, ctx);
    expect(data).toEqual([]);
    expect(call).toMatchObject({ result: 'not_found', httpStatus: 200, costUnits: 2 });
    // Retried on a search: every empty 200 the adapter records itself says not_found too.
    const recorder = providerContext({ trigger: 'user_search' });
    const retried = await adapter(stub.fetch).getFlight(AA100, recorder.ctx);
    expect([...recorder.logged, retried.call].map((r) => r.result)).toEqual([
      'not_found',
      'not_found',
      'not_found',
    ]);
  });

  it('451 is terminal: billed, an error, never retried even for a search', async () => {
    const stub = fixtureFetch(FIXTURES['legal-451'] as Fixture);
    const recorder = providerContext({ trigger: 'user_search' });
    const { data, call } = await adapter(stub.fetch).getFlight(AA100, recorder.ctx);
    expect(stub.requests).toHaveLength(1);
    expect(data).toEqual([]);
    expect(call).toMatchObject({ result: 'error', httpStatus: 451, costUnits: 2 });
    expect(call.error).toMatch(/^legal_suppression:/);
    expect(recorder.logged).toEqual([]);
  });

  it.each([
    ['429', 429, { 'retry-after': '3' }, 3_000],
    ['503', 503, {}, 1_000],
  ] as const)(
    '%s is rate_limited at zero cost: released, backed off, not retried',
    async (_label, status, headers, wait) => {
      const stub = fetchStub(
        () =>
          new Response(JSON.stringify({ message: 'slow down' }), {
            status,
            headers: { 'content-type': 'application/json', ...headers },
          }),
      );
      const recorder = providerContext({ trigger: 'user_search' });
      const { data, call } = await adapter(stub.fetch).getFlight(AA100, recorder.ctx);
      expect(stub.requests).toHaveLength(1);
      expect(data).toEqual([]);
      expect(call).toMatchObject({
        result: 'rate_limited',
        httpStatus: status,
        costUnits: 0,
        pollEquivalents: 0,
        estCostUsdMicros: 0,
      });
      expect(recorder.releases).toEqual([
        { request: containing({ operation: 'flight_status' }), unused: 0.1 },
      ]);
      expect(recorder.backoffs).toEqual([{ provider: 'aerodatabox', retryAfterMs: wait }]);
    },
  );

  it('a Cloudflare HTML 403 is rate_limited at zero cost, never parsed as JSON', async () => {
    const stub = fixtureFetch(FIXTURES['cloudflare-403'] as Fixture);
    const recorder = providerContext();
    const { call } = await adapter(stub.fetch).getFlight(AA100, recorder.ctx);
    expect(call).toMatchObject({
      result: 'rate_limited',
      httpStatus: 403,
      costUnits: 0,
      error: 'http_403:non_json',
    });
    expect(recorder.backoffs).toHaveLength(1);
  });

  it('a 200 that is not JSON is a push-back too', async () => {
    const stub = fetchStub(
      () =>
        new Response('<html>busy</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const { call } = await adapter(stub.fetch).getFlight(AA100, providerContext().ctx);
    expect(call).toMatchObject({ result: 'rate_limited', costUnits: 0 });
  });

  it('a budget refusal makes no call and records nothing billed', async () => {
    const stub = fixtureFetch(FIXTURES['flight-scheduled'] as Fixture);
    const refused = providerContext({
      decide: () => ({ allowed: false, reason: 'provider_rate_limit', retryAfterMs: 100 }),
    });
    const { data, call } = await adapter(stub.fetch).getFlight(AA100, refused.ctx);
    expect(stub.requests).toHaveLength(0);
    expect(data).toEqual([]);
    expect(call).toMatchObject({
      result: 'rate_limited',
      costUnits: 0,
      error: 'budget_denied:provider_rate_limit',
    });
    expect(call.httpStatus).toBeUndefined();
    const killed = providerContext({
      decide: () => ({ allowed: false, reason: 'provider_kill_switch' }),
    });
    const second = await adapter(stub.fetch).getFlight(AA100, killed.ctx);
    expect(second.call).toMatchObject({
      result: 'error',
      error: 'budget_denied:provider_kill_switch',
    });
  });

  it('a rejected fetch keeps its reservation and is billed: the gateway may have served it', async () => {
    const stub = fetchStub(() => {
      throw new TypeError('network connection lost');
    });
    const recorder = providerContext();
    const { call } = await adapter(stub.fetch).getFlight(AA100, recorder.ctx);
    expect(call).toMatchObject({
      result: 'error',
      costUnits: 2,
      estCostUsdMicros: 500,
      error: 'transport_unknown_billing:network connection lost',
    });
    expect(recorder.reservations).toHaveLength(1);
    expect(recorder.releases).toEqual([]);
  });

  it('names the budget day on every reservation, so a refund after midnight finds it', async () => {
    const recorder = providerContext({ now: '2026-09-22T23:59:59.900Z' });
    await adapter(fixtureFetch(FIXTURES['flight-scheduled'] as Fixture).fetch).getFlight(
      AA100,
      recorder.ctx,
    );
    expect(recorder.reservations[0]).toMatchObject({ utcDate: '2026-09-22' });
  });
});

describe('boards, airports and coverage', () => {
  it('getBoard asks FIDS by ICAO, caps the window at the plan, maps rows and skips the unkeyable', async () => {
    const stub = fixtureFetch(FIXTURES['fids-kjfk-departures'] as Fixture);
    const { ctx } = providerContext({ now: '2026-09-22T22:40:00Z' });
    const { data, call } = await adapter(stub.fetch).getBoard('kjfk', 'dep', KJFK_EVENING, ctx);
    const url = stub.urls()[0];
    // Growth allows 24 hours; the 24-hour ask stays, anything longer is cut.
    expect(url?.pathname).toBe('/flights/airports/Icao/KJFK/2026-09-22T17:00/2026-09-23T17:00');
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      direction: 'Departure',
      withLeg: 'false',
      withCancelled: 'true',
      withCodeshared: 'true',
      withCargo: 'false',
      withPrivate: 'false',
    });
    expect(call).toMatchObject({ operation: 'fids', costUnits: 2, result: 'ok' });
    expect(
      data.map((row) => [
        row.designator,
        row.operatingCarrierIcao,
        row.flightNumber,
        row.counterpart.icao,
        row.status,
      ]),
    ).toEqual([
      ['AA100', 'AAL', '100', 'EGLL', 'boarding'],
      // The codeshare row names the operating designator its tracker is keyed by (AAL-100-...).
      ['BA1512', 'AAL', '100', 'EGLL', 'boarding'],
      ['AF11', 'AFR', '11', 'LFPG', 'departed'],
    ]);
    expect(data[0]).toMatchObject({
      estimated: '2026-09-22T23:10:00.000Z',
      gate: 'B32',
      terminal: '8',
    });
    expect(data[2]).toMatchObject({ actual: '2026-09-22T21:34:00.000Z' });

    const wide = fixtureFetch(FIXTURES['fids-kjfk-departures'] as Fixture);
    await adapter(wide.fetch).getBoard(
      'KJFK',
      'arr',
      { from: '2026-09-22T00:00', to: '2026-09-24T00:00', tz: 'America/New_York' },
      ctx,
    );
    expect(wide.urls()[0]?.pathname).toBe(
      '/flights/airports/Icao/KJFK/2026-09-22T00:00/2026-09-23T00:00',
    );
    expect(wide.urls()[0]?.searchParams.get('direction')).toBe('Arrival');
  });

  it('arrival rows derive their status from what an arrival row has, and resolve operators like flights', async () => {
    const stub = fixtureFetch(FIXTURES['fids-kjfk-arrivals'] as Fixture);
    const { data } = await adapter(stub.fetch).getBoard(
      'KJFK',
      'arr',
      KJFK_EVENING,
      providerContext({ now: '2026-09-22T21:30:00Z' }).ctx,
    );
    expect(
      data.map((row) => [row.designator, row.operatingCarrierIcao, row.flightNumber, row.status]),
    ).toEqual([
      // In the air (the enum says it left the origin), with an estimated arrival: en route.
      ['AA101', 'AAL', '101', 'en_route'],
      // At the gate: the revised time is the actual in.
      ['BA117', 'BAW', '117', 'arrived'],
      // A regional codeshare with no callsign takes the hint, exactly as getFlight does.
      ['AA3456', 'ENY', '3456', 'scheduled'],
      ['DL404', 'DAL', '404', 'cancelled'],
    ]);
    expect(data[0]).toMatchObject({ estimated: '2026-09-22T22:05:00.000Z' });
    expect(data[0]?.actual).toBeUndefined();
    expect(data[1]).toMatchObject({ actual: '2026-09-22T20:52:00.000Z', baggageClaim: '4' });
    // The row and the flight for the same operation resolve to the same operator.
    const flight = await adapter(
      fixtureFetch(FIXTURES['flight-codeshared-regional'] as Fixture).fetch,
    ).getFlight(
      { carrier: { iata: 'AA' }, flightNumber: '3456', dateLocal: '2026-09-22' },
      providerContext().ctx,
    );
    expect([flight.data[0]?.operatingCarrierIcao, flight.data[0]?.flightNumber]).toEqual([
      data[2]?.operatingCarrierIcao,
      data[2]?.flightNumber,
    ]);
  });

  it('getAirport is one unit and yields the time zone', async () => {
    const stub = fixtureFetch(FIXTURES['airport-kjfk'] as Fixture);
    const { data, call } = await adapter(stub.fetch).getAirport('KJFK', providerContext().ctx);
    expect(stub.urls()[0]?.pathname).toBe('/airports/Icao/KJFK');
    expect(data).toEqual({ icao: 'KJFK', iata: 'JFK', tz: 'America/New_York' });
    expect(call).toMatchObject({ operation: 'airport', costUnits: 1, estCostUsdMicros: 250 });
  });

  it('checkCoverage is the FREE TIER health check: counted, costing nothing', async () => {
    const stub = fixtureFetch(FIXTURES['health-kjfk'] as Fixture);
    const recorder = providerContext();
    const { data, call } = await adapter(stub.fetch).checkCoverage('KJFK', recorder.ctx);
    expect(stub.urls()[0]?.pathname).toBe('/health/services/airports/KJFK/feeds');
    expect(data).toEqual({
      airportIcao: 'KJFK',
      schedules: 'OK',
      live: 'OKPartial',
      adsb: 'OK',
      covered: true,
    });
    expect(call).toMatchObject({
      operation: 'health',
      result: 'ok',
      costUnits: 0,
      estCostUsdMicros: 0,
    });
    expect(recorder.reservations[0]).toMatchObject({ operation: 'health', pollEquivalents: 0 });
  });
});

describe('webhook parsing (behind ADB_ALERTS_ENABLED)', () => {
  const body = JSON.stringify((notification as Fixture).response.body);
  const NOTIFICATION_ATTEMPT = (
    (notification as Fixture).response.body as {
      deliveryAttempt: { seqNo: number; costCredits: number };
    }
  ).deliveryAttempt;

  it('refuses every body while alerts are disabled', async () => {
    const disabled = adapter(fixtureFetch(miss204).fetch, false);
    await expect(
      disabled.parseWebhook(new Request('https://x.test/', { method: 'POST', body })),
    ).rejects.toThrow(WebhookPayloadError);
  });

  it('turns each notified flight into a hint that names the designator and local date', async () => {
    const enabled = adapter(fixtureFetch(miss204).fetch, true);
    const events = await enabled.parseWebhook(
      new Request('https://x.test/', { method: 'POST', body }),
    );
    expect(events).toEqual([
      {
        provider: 'aerodatabox',
        externalId: '4d1f6c52-2d0b-4c9b-9a55-0c1f5b8e2a71:0',
        receivedAt: '2026-09-22T20:45:30.000Z',
        kind: 'update',
        flightRef: { designator: 'AA100', dateLocal: '2026-09-22' },
        payload: {
          hint: 'reread',
          notificationId: '4d1f6c52-2d0b-4c9b-9a55-0c1f5b8e2a71',
          subscriptionId: 'a3c8e1b2-7f44-4f0e-9c1d-2b6f8a9e0d13',
          lastUpdatedUtc: '2026-09-22 20:45Z',
          deliverySeqNo: NOTIFICATION_ATTEMPT.seqNo,
          deliveryItemCount: 1,
          deliveryCostCredits: NOTIFICATION_ATTEMPT.costCredits,
        },
      },
    ]);
  });

  it("carries the delivery's billed credits once per notification, however many items it holds", () => {
    const payload = (notification as Fixture).response.body as {
      flights: Record<string, unknown>[];
    };
    const second = { ...payload.flights[0], number: 'AA 102' };
    const events = parseAdbNotification(
      { ...payload, flights: [payload.flights[0], second] },
      new Date('2026-09-22T20:45:30Z'),
    );
    expect(events.map((event) => event.payload)).toEqual([
      containing({
        deliverySeqNo: NOTIFICATION_ATTEMPT.seqNo,
        deliveryItemCount: 2,
        deliveryCostCredits: NOTIFICATION_ATTEMPT.costCredits,
      }),
      containing({ deliverySeqNo: NOTIFICATION_ATTEMPT.seqNo, deliveryItemCount: 2 }),
    ]);
    expect(events[1]?.payload).not.toHaveProperty('deliveryCostCredits');
  });

  it.each([
    ['not JSON', 'nope'],
    ['no flights', { ...((notification as Fixture).response.body as object), flights: [] }],
    ['a bad notification id', { ...((notification as Fixture).response.body as object), id: 'x' }],
    [
      'no subscription',
      { ...((notification as Fixture).response.body as object), subscription: undefined },
    ],
  ])('rejects %s', (_label, value) => {
    const parse = () =>
      parseAdbNotification(
        typeof value === 'string' ? value : JSON.parse(JSON.stringify(value)),
        new Date(),
      );
    expect(parse).toThrow(WebhookPayloadError);
  });
});
