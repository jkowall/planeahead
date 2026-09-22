import { describe, expect, it } from 'vitest';
import {
  AEROAPI_EVENT_CODES,
  ALERT_EVENTS,
  AeroApiEventCodeSchema,
  AircraftPositionSchema,
  AlertEventSchema,
  BoardRowSchema,
  FIELD_QUALITY_VALUES,
  FLIGHT_STATUS_VALUES,
  FieldQualityKeySchema,
  FieldQualitySchema,
  FlightRefSchema,
  FlightStatusSchema,
  FlightStatusValueSchema,
  IsoDateSchema,
  IsoInstantSchema,
  PROVIDER_CALL_RESULTS,
  PROVIDER_EVENT_KINDS,
  PROVIDER_IDS,
  ProviderCallRecordSchema,
  ProviderCallResultSchema,
  ProviderCallTriggerSchema,
  ProviderEventKindSchema,
  ProviderEventSchema,
  ProviderIdSchema,
  OPERATOR_SOURCES,
  OperatorSourceSchema,
  TIME_FIELDS,
  aeroApiEventKind,
  tolerantEnum,
  normalizeIcaoHex,
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

  it('lists exactly the nine AeroAPI alert events (increment 6: no hold_start or hold_end)', () => {
    expect(ALERT_EVENTS).toEqual([
      'filed',
      'departure',
      'arrival',
      'cancelled',
      'diverted',
      'out',
      'off',
      'on',
      'in',
    ]);
  });

  it('lists the 18 AeroAPI delivery event codes in spec order and parses them tolerantly', () => {
    expect(AEROAPI_EVENT_CODES).toHaveLength(18);
    expect(new Set(AEROAPI_EVENT_CODES).size).toBe(18);
    for (const code of AEROAPI_EVENT_CODES) {
      expect(AeroApiEventCodeSchema.parse(code)).toBe(code);
    }
    expect(AeroApiEventCodeSchema.parse('taxi_stop')).toBe('unknown');
    expect(AeroApiEventCodeSchema.safeParse(3).success).toBe(false);
    expect(AeroApiEventCodeSchema.safeParse(null).success).toBe(false);
    // Every configurable event is also a delivery code.
    for (const event of ALERT_EVENTS) {
      expect(AEROAPI_EVENT_CODES).toContain(event);
    }
  });

  it.each([
    ...ALERT_EVENTS.map((code) => [code, code] as const),
    ['change', 'update'],
    ['minutes_out', 'update'],
    ['power_on', 'update'],
    ['position_only_arrival', 'update'],
    ['position_only_departure', 'update'],
    ['fru_arrival', 'update'],
    ['nonairport_arrival', 'update'],
    ['nonairport_departure', 'update'],
    ['nonairport_filed', 'update'],
    ['hold_start', 'unknown'],
    ['taxi_stop', 'unknown'],
    ['', 'unknown'],
  ] as const)('maps AeroAPI event_code %s to kind %s', (code, kind) => {
    expect(aeroApiEventKind(code)).toBe(kind);
    expect(ProviderEventKindSchema.parse(aeroApiEventKind(code))).toBe(kind);
  });

  it('lists the operator sources the key can record (ADR 0010)', () => {
    expect(OPERATOR_SOURCES).toEqual(['provider', 'callsign', 'hint', 'marketing']);
    expect(OperatorSourceSchema.safeParse('callsign').success).toBe(true);
    expect(OperatorSourceSchema.safeParse('guess').success).toBe(false);
  });

  it('lists the call results and field qualities', () => {
    expect(PROVIDER_CALL_RESULTS).toEqual(['ok', 'not_found', 'rate_limited', 'error']);
    expect(FIELD_QUALITY_VALUES).toEqual(['live', 'schedule', 'estimated']);
  });

  it('keys field quality by every time field plus gate and baggage', () => {
    expect(FieldQualityKeySchema.options).toEqual([...TIME_FIELDS, 'gate', 'baggage']);
    expect(TIME_FIELDS).toHaveLength(12);
  });

  it('parses a status or an event kind this build does not know as unknown', () => {
    expect(FlightStatusValueSchema.parse('taxiing')).toBe('unknown');
    expect(FlightStatusValueSchema.parse('en_route')).toBe('en_route');
    expect(ProviderEventKindSchema.parse('landed')).toBe('unknown');
    expect(PROVIDER_EVENT_KINDS).toEqual([...ALERT_EVENTS, 'update', 'unknown']);
  });

  it('still requires a string for status and kind: absent, null and a number are rejected (R11)', () => {
    for (const schema of [FlightStatusValueSchema, ProviderEventKindSchema]) {
      expect(schema.safeParse(undefined).success).toBe(false);
      expect(schema.safeParse(null).success).toBe(false);
      expect(schema.safeParse(3).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.parse('never-heard-of-it')).toBe('unknown');
      expect(schema.parse('unknown')).toBe('unknown');
    }
    const custom = tolerantEnum(['a', 'b', 'other'], 'other');
    expect(custom.parse('a')).toBe('a');
    expect(custom.parse('zzz')).toBe('other');
    expect(custom.safeParse(1).success).toBe(false);
    expect(custom.safeParse(undefined).success).toBe(false);
  });

  it('keeps every other vocabulary closed (append-only, consumers first)', () => {
    expect(ProviderIdSchema.safeParse('flightradar').success).toBe(false);
    expect(ProviderCallTriggerSchema.safeParse('timer').success).toBe(false);
    expect(ProviderCallResultSchema.safeParse('meh').success).toBe(false);
    expect(AlertEventSchema.safeParse('gate').success).toBe(false);
    expect(FieldQualitySchema.safeParse('guessed').success).toBe(false);
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

  it('keeps providerRefs and fieldQuality entries it does not know (a newer producer added them)', () => {
    const status = FlightStatusSchema.parse({
      ...AA100_INPUT,
      times: { ...AA100_INPUT.times, estimatedBoarding: '2026-09-20T03:20:00Z' },
      fieldQuality: { scheduledOut: 'schedule', estimatedBoarding: 'estimated' },
      providerRefs: { aerodatabox: 'adb-1', flightradar24: 'fr24-1' },
    });
    expect(status.fieldQuality).toEqual({
      scheduledOut: 'schedule',
      estimatedBoarding: 'estimated',
    });
    expect(status.providerRefs).toEqual({ aerodatabox: 'adb-1', flightradar24: 'fr24-1' });
  });

  it('degrades a status it does not know to unknown instead of failing the payload', () => {
    expect(FlightStatusSchema.parse({ ...AA100_INPUT, status: 'taxiing' }).status).toBe('unknown');
  });

  it('rejects a payload with no status at all (R11)', () => {
    const withoutStatus = Object.fromEntries(
      Object.entries(AA100_INPUT).filter(([field]) => field !== 'status'),
    );
    expect(FlightStatusSchema.safeParse(withoutStatus).success).toBe(false);
    expect(FlightStatusSchema.safeParse({ ...withoutStatus, status: null }).success).toBe(false);
    expect(FlightStatusSchema.safeParse({ ...withoutStatus, status: 4 }).success).toBe(false);
    expect(FlightStatusSchema.safeParse({ ...withoutStatus, status: 'taxiing' }).success).toBe(
      true,
    );
  });

  it('accepts the increment 6 operator fields and leaves them optional', () => {
    const status = makeStatus({
      operatorSource: 'callsign',
      marketingCarrierIcao: 'BAW',
      marketingFlightNumber: '1512',
    });
    expect(status.operatorSource).toBe('callsign');
    expect(status.marketingCarrierIcao).toBe('BAW');
    expect(status.marketingFlightNumber).toBe('1512');
    expect(makeStatus().operatorSource).toBeUndefined();
    expect(FlightStatusSchema.safeParse({ ...AA100_INPUT, operatorSource: 'guess' }).success).toBe(
      false,
    );
    expect(
      FlightStatusSchema.safeParse({ ...AA100_INPUT, marketingCarrierIcao: 'BA' }).success,
    ).toBe(false);
    expect(
      FlightStatusSchema.safeParse({ ...AA100_INPUT, marketingFlightNumber: '01512' }).success,
    ).toBe(false);
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
    ['legSeq 0', { legSeq: 0 }],
    ['non-integer legSeq', { legSeq: 1.5 }],
    ['offset instant', { times: { scheduledOut: '2026-09-19T23:50:00-04:00' } }],
    ['malformed key', { key: 'AA-100-2026-09-19-JFK' }],
    ['bad local date', { scheduledDepartureDateLocal: '2026-02-30' }],
    ['bad icao hex', { icaoHex: 'A0B1C' }],
    ['progress above 100', { progressPercent: 101 }],
    ['unknown field quality value', { fieldQuality: { scheduledOut: 'guessed' } }],
    ['non-string provider ref', { providerRefs: { aeroapi: 42 } }],
    ['unknown source', { source: 'flightradar' }],
    ['missing origin', { origin: undefined }],
    ['missing status', { status: undefined }],
    ['null status', { status: null }],
    ['numeric status', { status: 4 }],
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

  it('rejects an unknown direction, a bad counterpart or a missing status', () => {
    expect(BoardRowSchema.safeParse({ ...row, direction: 'in' }).success).toBe(false);
    expect(BoardRowSchema.safeParse({ ...row, counterpart: { iata: 'LHR' } }).success).toBe(false);
    expect(BoardRowSchema.safeParse({ ...row, status: undefined }).success).toBe(false);
    expect(BoardRowSchema.safeParse({ ...row, status: null }).success).toBe(false);
    expect(BoardRowSchema.parse({ ...row, status: 'taxiing' }).status).toBe('unknown');
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
    // Feeds broadcast lower-case hex; the contract is upper case and the normaliser gets there.
    expect(AircraftPositionSchema.safeParse({ ...position, icaoHex: 'a0b1c2' }).success).toBe(
      false,
    );
    expect(normalizeIcaoHex(' a0b1c2 ')).toBe('A0B1C2');
    expect(normalizeIcaoHex('A0B1C')).toBeUndefined();
    expect(normalizeIcaoHex('XYZ123')).toBeUndefined();
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
    expect(PROVIDER_EVENT_KINDS).toContain('filed');
    expect(PROVIDER_EVENT_KINDS).toContain('update');
    expect(PROVIDER_EVENT_KINDS).toContain('unknown');
    expect(ProviderEventKindSchema.parse('landed')).toBe('unknown');
  });

  it('requires a kind: absent, null and a number are rejected, an unknown string degrades (R11)', () => {
    const event = {
      provider: 'aeroapi',
      externalId: 'evt-3',
      receivedAt: '2026-09-20T03:55:00Z',
      flightRef: { flightKey: 'AAL-100-2026-09-19-KJFK' },
      payload: null,
    };
    expect(ProviderEventSchema.safeParse(event).success).toBe(false);
    expect(ProviderEventSchema.safeParse({ ...event, kind: null }).success).toBe(false);
    expect(ProviderEventSchema.safeParse({ ...event, kind: 7 }).success).toBe(false);
    expect(ProviderEventSchema.parse({ ...event, kind: 'taxi_start' }).kind).toBe('unknown');
  });

  it('requires a non-empty external id', () => {
    expect(
      ProviderEventSchema.safeParse({
        provider: 'aeroapi',
        externalId: '',
        receivedAt: '2026-09-20T03:55:00Z',
        kind: 'out',
        flightRef: { flightKey: 'AAL-100-2026-09-19-KJFK' },
      }).success,
    ).toBe(false);
  });

  it('rejects an event whose flight reference names no flight', () => {
    expect(
      ProviderEventSchema.safeParse({
        provider: 'aeroapi',
        externalId: 'evt-2',
        receivedAt: '2026-09-20T03:55:00Z',
        kind: 'out',
        flightRef: {},
      }).success,
    ).toBe(false);
  });
});

describe('FlightRefSchema', () => {
  it.each([
    ['a flight key', { flightKey: 'AAL-100-2026-09-19-KJFK' }],
    ['a provider ref', { providerRef: { provider: 'aeroapi', providerId: 'AAL100-1758253800' } }],
    ['a designator plus a local date', { designator: 'AA100', dateLocal: '2026-09-19' }],
  ])('accepts %s', (_label, ref) => {
    expect(FlightRefSchema.safeParse(ref).success).toBe(true);
  });

  it.each([
    ['nothing', {}],
    ['a designator alone', { designator: 'AA100' }],
    ['a local date alone', { dateLocal: '2026-09-19' }],
    ['a malformed key alone', { flightKey: 'AA100' }],
  ])('rejects %s', (_label, ref) => {
    expect(FlightRefSchema.safeParse(ref).success).toBe(false);
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
