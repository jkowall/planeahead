import { describe, expect, it } from 'vitest';
import {
  AircraftPositionSchema,
  BoardRowSchema,
  FIELD_QUALITY_VALUES,
  FLIGHT_STATUS_VALUES,
  FieldQualityKeySchema,
  FlightStatusSchema,
  IsoDateSchema,
  IsoInstantSchema,
  PROVIDER_CALL_RESULTS,
  PROVIDER_IDS,
  ProviderCallRecordSchema,
  ProviderEventKindSchema,
  ProviderEventSchema,
  TIME_FIELDS,
} from '../src/flight-status';
import type { FlightKey } from '../src/flight-key';
import { AA100_INPUT, makeStatus } from './fixtures';

describe('enumerations', () => {
  it('lists the provider ids the spec names, in order', () => {
    expect(PROVIDER_IDS).toEqual([
      'aeroapi',
      'aerodatabox',
      'adsb_lol',
      'adsb_fi',
      'airplanes_live',
      'aviationweather',
      'nws',
      'open_meteo',
      'faa_nas',
      'llm',
      'mock',
    ]);
  });

  it('lists the flight status values the spec names', () => {
    expect(FLIGHT_STATUS_VALUES).toEqual([
      'scheduled',
      'boarding',
      'departed',
      'en_route',
      'landed',
      'arrived',
      'cancelled',
      'diverted',
      'unknown',
    ]);
  });

  it('lists the call results and field qualities', () => {
    expect(PROVIDER_CALL_RESULTS).toEqual(['ok', 'not_found', 'rate_limited', 'error']);
    expect(FIELD_QUALITY_VALUES).toEqual(['live', 'schedule', 'estimated']);
  });

  it('keys field quality by every time field plus gate and baggage', () => {
    expect(FieldQualityKeySchema.options).toEqual([...TIME_FIELDS, 'gate', 'baggage']);
    expect(TIME_FIELDS).toHaveLength(12);
  });
});

describe('IsoInstantSchema and IsoDateSchema', () => {
  it('accepts UTC instants with or without fractional seconds', () => {
    expect(IsoInstantSchema.safeParse('2026-09-19T03:50:00Z').success).toBe(true);
    expect(IsoInstantSchema.safeParse('2026-09-19T03:50:00.123Z').success).toBe(true);
  });

  it('rejects offsets, naive timestamps and dates', () => {
    expect(IsoInstantSchema.safeParse('2026-09-19T03:50:00+02:00').success).toBe(false);
    expect(IsoInstantSchema.safeParse('2026-09-19T03:50:00').success).toBe(false);
    expect(IsoInstantSchema.safeParse('2026-09-19').success).toBe(false);
    expect(IsoInstantSchema.safeParse(1_758_253_800_000).success).toBe(false);
  });

  it('rejects impossible calendar dates', () => {
    expect(IsoDateSchema.safeParse('2026-09-19').success).toBe(true);
    expect(IsoDateSchema.safeParse('2024-02-29').success).toBe(true);
    expect(IsoDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(IsoDateSchema.safeParse('2023-02-29').success).toBe(false);
    expect(IsoDateSchema.safeParse('2026-13-01').success).toBe(false);
    expect(IsoDateSchema.safeParse('20260919').success).toBe(false);
  });
});

describe('FlightStatusSchema', () => {
  it('parses the fixture and applies the defaults', () => {
    const status = makeStatus();
    expect(status.legSeq).toBe(1);
    expect(status.key).toBeUndefined();
    expect(status.codeshares).toEqual([
      { carrierIata: 'BA', carrierIcao: 'BAW', flightNumber: '1512' },
    ]);
    expect(status.fieldQuality).toEqual({ scheduledOut: 'schedule', scheduledIn: 'schedule' });
  });

  it('defaults codeshares, providerRefs and fieldQuality when absent', () => {
    const omitted = new Set(['codeshares', 'providerRefs', 'fieldQuality']);
    const rest = Object.fromEntries(
      Object.entries(AA100_INPUT).filter(([field]) => !omitted.has(field)),
    );
    const status = FlightStatusSchema.parse(rest);
    expect(status.codeshares).toEqual([]);
    expect(status.providerRefs).toEqual({});
    expect(status.fieldQuality).toEqual({});
  });

  it('keeps unknown fields at every level (gradual Durable Object rollout)', () => {
    const status = FlightStatusSchema.parse({
      ...AA100_INPUT,
      newTopLevelField: 'kept',
      origin: { ...AA100_INPUT.origin, elevationFt: 13 },
      times: { ...AA100_INPUT.times, scheduledPushback: '2026-09-20T03:45:00Z' },
    });
    expect(status).toHaveProperty('newTopLevelField', 'kept');
    expect(status.origin).toHaveProperty('elevationFt', 13);
    expect(status.times).toHaveProperty('scheduledPushback', '2026-09-20T03:45:00Z');
  });

  it('accepts a canonical key, a legSeq above 1 and a provider-local date', () => {
    const status = makeStatus({
      key: 'AAL-100-2026-09-19-KJFK-L2' as FlightKey,
      legSeq: 2,
      scheduledDepartureDateLocal: '2026-09-19',
    });
    expect(status.key).toBe('AAL-100-2026-09-19-KJFK-L2');
    expect(status.legSeq).toBe(2);
  });

  it.each([
    ['lower-case carrier', { operatingCarrierIcao: 'aal' }],
    ['IATA carrier', { operatingCarrierIcao: 'AA' }],
    ['leading zero in flight number', { flightNumber: '0100' }],
    ['five-digit flight number', { flightNumber: '10000' }],
    ['unknown status', { status: 'taxiing' }],
    ['legSeq 0', { legSeq: 0 }],
    ['non-integer legSeq', { legSeq: 1.5 }],
    ['offset instant', { times: { scheduledOut: '2026-09-19T23:50:00-04:00' } }],
    ['malformed key', { key: 'AA-100-2026-09-19-JFK' }],
    ['bad local date', { scheduledDepartureDateLocal: '2026-02-30' }],
    ['bad icao hex', { icaoHex: 'A0B1C' }],
    ['progress above 100', { progressPercent: 101 }],
    ['unknown provider in providerRefs', { providerRefs: { flightradar: 'x' } }],
    ['unknown field quality key', { fieldQuality: { registration: 'live' } }],
    ['unknown source', { source: 'flightradar' }],
    ['missing origin', { origin: undefined }],
  ])('rejects %s', (_label, override) => {
    expect(FlightStatusSchema.safeParse({ ...AA100_INPUT, ...override }).success).toBe(false);
  });
});

describe('BoardRowSchema', () => {
  const row = {
    direction: 'dep',
    designator: 'AA100',
    flightNumber: '100',
    counterpart: { icao: 'EGLL', iata: 'LHR' },
    scheduled: '2026-09-20T03:50:00Z',
    status: 'scheduled',
    source: 'aerodatabox',
  };

  it('parses a board row and defaults codeshares', () => {
    const parsed = BoardRowSchema.parse(row);
    expect(parsed.codeshares).toEqual([]);
    expect(parsed.flightKey).toBeUndefined();
  });

  it('rejects an unknown direction or a bad counterpart', () => {
    expect(BoardRowSchema.safeParse({ ...row, direction: 'in' }).success).toBe(false);
    expect(BoardRowSchema.safeParse({ ...row, counterpart: { iata: 'LHR' } }).success).toBe(false);
  });
});

describe('AircraftPositionSchema', () => {
  const position = {
    icaoHex: 'A0B1C2',
    lat: 40.64,
    lon: -73.78,
    altFt: 1_200,
    gsKt: 160,
    trackDeg: 310,
    vsFpm: -800,
    seenAt: '2026-09-20T04:05:00Z',
    source: 'adsb_lol',
  };

  it('parses a position', () => {
    expect(AircraftPositionSchema.parse(position).icaoHex).toBe('A0B1C2');
  });

  it('bounds latitude, longitude and track', () => {
    expect(AircraftPositionSchema.safeParse({ ...position, lat: 91 }).success).toBe(false);
    expect(AircraftPositionSchema.safeParse({ ...position, lon: -181 }).success).toBe(false);
    expect(AircraftPositionSchema.safeParse({ ...position, trackDeg: 361 }).success).toBe(false);
    expect(AircraftPositionSchema.safeParse({ ...position, gsKt: -1 }).success).toBe(false);
    expect(AircraftPositionSchema.safeParse({ ...position, icaoHex: 'XYZ123' }).success).toBe(
      false,
    );
  });
});

describe('ProviderEventSchema', () => {
  it('parses a webhook event with an opaque payload', () => {
    const event = ProviderEventSchema.parse({
      provider: 'aeroapi',
      externalId: 'evt-1',
      receivedAt: '2026-09-20T03:55:00Z',
      kind: 'out',
      flightRef: {
        providerRef: { provider: 'aeroapi', providerId: 'AAL100-1758253800-airline-0' },
      },
      payload: { anything: ['goes'] },
    });
    expect(event.kind).toBe('out');
    expect(event.payload).toEqual({ anything: ['goes'] });
  });

  it('accepts alert event codes plus update and unknown as kinds', () => {
    expect(ProviderEventKindSchema.options).toContain('filed');
    expect(ProviderEventKindSchema.options).toContain('update');
    expect(ProviderEventKindSchema.options).toContain('unknown');
    expect(ProviderEventKindSchema.safeParse('landed').success).toBe(false);
  });

  it('requires a non-empty external id', () => {
    expect(
      ProviderEventSchema.safeParse({
        provider: 'aeroapi',
        externalId: '',
        receivedAt: '2026-09-20T03:55:00Z',
        kind: 'out',
        flightRef: {},
      }).success,
    ).toBe(false);
  });
});

describe('ProviderCallRecordSchema', () => {
  const record = {
    id: '019968a7-4e00-7000-8000-000000000000',
    provider: 'aeroapi',
    operation: 'flight_by_id',
    trigger: 'alarm',
    flightKey: 'AAL-100-2026-09-19-KJFK',
    requestId: 'req-1',
    startedAt: '2026-09-20T03:55:00Z',
    latencyMs: 210,
    httpStatus: 200,
    result: 'ok',
    costUnits: 1,
    pollEquivalents: 1,
    estCostUsdMicros: 5_000,
    responseBytes: 4_096,
  };

  it('parses a complete record', () => {
    expect(ProviderCallRecordSchema.parse(record).result).toBe('ok');
  });

  it('rejects malformed ids, results, statuses and negative latency', () => {
    expect(ProviderCallRecordSchema.safeParse({ ...record, id: 'call-1' }).success).toBe(false);
    expect(ProviderCallRecordSchema.safeParse({ ...record, result: 'meh' }).success).toBe(false);
    expect(ProviderCallRecordSchema.safeParse({ ...record, httpStatus: 42 }).success).toBe(false);
    expect(ProviderCallRecordSchema.safeParse({ ...record, latencyMs: -1 }).success).toBe(false);
    expect(ProviderCallRecordSchema.safeParse({ ...record, trigger: 'timer' }).success).toBe(false);
    expect(ProviderCallRecordSchema.safeParse({ ...record, estCostUsdMicros: 0.5 }).success).toBe(
      false,
    );
  });
});
