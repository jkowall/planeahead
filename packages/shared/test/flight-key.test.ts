import { describe, expect, it } from 'vitest';
import { CARRIER_IATA_TO_ICAO_FALLBACK } from '../src/carriers';
import {
  FLIGHT_KEY_RE,
  FlightKeyError,
  FlightKeySchema,
  REGIONAL_OPERATOR_CONFIDENCES,
  REGIONAL_OPERATOR_SEED,
  RegionalOperatorRuleSchema,
  RegionalOperatorSeedSchema,
  buildFlightKey,
  canonicalizeFromProvider,
  classifyKeyDrift,
  flightNumberToken,
  isFlightKey,
  isValidIsoDate,
  normalizeFlightNumber,
  originLocalDate,
  parseDesignator,
  parseFlightKey,
  reconcileFlightKey,
  regionalOperatorHint,
  scheduledDepartureDateLocalOf,
  type FlightKey,
  type RegionalOperatorRule,
} from '../src/flight-key';
import { AA100_INPUT, makeStatus } from './fixtures';

const AA100_KEY = 'AAL-100-2026-09-19-KJFK';

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof FlightKeyError ? error.code : undefined;
  }
  return undefined;
}

describe('normalizeFlightNumber', () => {
  it('strips whitespace and leading zeros and upper-cases a suffix', () => {
    expect(normalizeFlightNumber('100')).toEqual({ number: '100' });
    expect(normalizeFlightNumber('0100')).toEqual({ number: '100' });
    expect(normalizeFlightNumber('0001')).toEqual({ number: '1' });
    expect(normalizeFlightNumber(' 0100a ')).toEqual({ number: '100', suffix: 'A' });
    expect(normalizeFlightNumber('9999')).toEqual({ number: '9999' });
    expect(normalizeFlightNumber('1 512')).toEqual({ number: '1512' });
  });

  it('never returns an explicit undefined suffix (exactOptionalPropertyTypes)', () => {
    expect(Object.keys(normalizeFlightNumber('7'))).toEqual(['number']);
  });

  it.each(['', '0', '000', '10000', 'AA100', '100AB', '-1', '12.5', 'A', '1-0'])(
    'rejects %j',
    (input) => {
      expect(errorCode(() => normalizeFlightNumber(input))).toBe('invalid_flight_number');
    },
  );
});

describe('flightNumberToken', () => {
  it('joins number and suffix as they appear in a key', () => {
    expect(flightNumberToken({ number: '100' })).toBe('100');
    expect(flightNumberToken({ number: '100', suffix: 'A' })).toBe('100A');
  });
});

describe('parseDesignator', () => {
  it.each([
    ['AA100', { carrier: { iata: 'AA' }, number: '100' }],
    ['AA 100', { carrier: { iata: 'AA' }, number: '100' }],
    ['AA-100', { carrier: { iata: 'AA' }, number: '100' }],
    ['AAL100', { carrier: { icao: 'AAL' }, number: '100' }],
    ['aa0100', { carrier: { iata: 'AA' }, number: '100' }],
    ['BA1512', { carrier: { iata: 'BA' }, number: '1512' }],
    ['b6 1', { carrier: { iata: 'B6' }, number: '1' }],
    ['9W123', { carrier: { iata: '9W' }, number: '123' }],
    ['DL0007', { carrier: { iata: 'DL' }, number: '7' }],
    ['AA100A', { carrier: { iata: 'AA' }, number: '100', suffix: 'A' }],
    [' dlh 400 ', { carrier: { icao: 'DLH' }, number: '400' }],
  ])('parses %j', (input, expected) => {
    expect(parseDesignator(input)).toEqual(expected);
  });

  it.each(['', '100', 'AAAA100', 'AA', 'AA10000', '12345', 'A100', '12100', 'AA100AB'])(
    'rejects %j',
    (input) => {
      expect(errorCode(() => parseDesignator(input))).toMatch(
        /invalid_designator|invalid_flight_number/,
      );
    },
  );

  it('does not resolve codeshares: BA1512 stays a BA reference until a provider answers', () => {
    expect(parseDesignator('BA1512').carrier).toEqual({ iata: 'BA' });
  });
});

describe('isValidIsoDate', () => {
  it('accepts real calendar dates only', () => {
    expect(isValidIsoDate('2026-09-19')).toBe(true);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2023-02-29')).toBe(false);
    expect(isValidIsoDate('2026-04-31')).toBe(false);
    expect(isValidIsoDate('2026-00-10')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidIsoDate('2026-9-19')).toBe(false);
    expect(isValidIsoDate('20260919')).toBe(false);
  });
});

describe('buildFlightKey and parseFlightKey', () => {
  it('builds the documented example', () => {
    expect(
      buildFlightKey({
        operatingCarrierIcao: 'AAL',
        flightNumber: '100',
        scheduledDepartureDateLocal: '2026-09-19',
        originIcao: 'KJFK',
      }),
    ).toBe(AA100_KEY);
  });

  it('normalises the flight number and renders legSeq only above 1', () => {
    const base = {
      operatingCarrierIcao: 'AAL',
      flightNumber: '0100',
      scheduledDepartureDateLocal: '2026-09-19',
      originIcao: 'KJFK',
    };
    expect(buildFlightKey(base)).toBe(AA100_KEY);
    expect(buildFlightKey({ ...base, legSeq: 1 })).toBe(AA100_KEY);
    expect(buildFlightKey({ ...base, legSeq: 2 })).toBe(`${AA100_KEY}-L2`);
    expect(buildFlightKey({ ...base, legSeq: 12 })).toBe(`${AA100_KEY}-L12`);
    expect(buildFlightKey({ ...base, flightNumber: '100a' })).toBe('AAL-100A-2026-09-19-KJFK');
  });

  it.each([
    ['AAL-100-2026-09-19-KJFK', 1],
    ['AAL-100-2026-09-19-KJFK-L2', 2],
    ['AAL-100A-2026-09-19-KJFK-L10', 10],
    ['ZZZ-1-2026-02-28-ZZ1A', 1],
  ] as const)('round-trips %s', (key, legSeq) => {
    const parsed = parseFlightKey(key);
    expect(parsed.legSeq).toBe(legSeq);
    expect(buildFlightKey(parsed)).toBe(key);
    expect(isFlightKey(key)).toBe(true);
    expect(FlightKeySchema.parse(key)).toBe(key);
  });

  it.each([
    ['lower-case carrier', { operatingCarrierIcao: 'aal' }, 'invalid_carrier'],
    ['IATA carrier', { operatingCarrierIcao: 'AA' }, 'invalid_carrier'],
    ['four-letter carrier', { operatingCarrierIcao: 'AALX' }, 'invalid_carrier'],
    ['flight number 0', { flightNumber: '0' }, 'invalid_flight_number'],
    ['short date', { scheduledDepartureDateLocal: '2026-9-19' }, 'invalid_date'],
    ['impossible date', { scheduledDepartureDateLocal: '2026-02-30' }, 'invalid_date'],
    ['compact date', { scheduledDepartureDateLocal: '20260919' }, 'invalid_date'],
    ['IATA airport', { originIcao: 'JFK' }, 'invalid_airport'],
    ['lower-case airport', { originIcao: 'kjfk' }, 'invalid_airport'],
    ['legSeq 0', { legSeq: 0 }, 'invalid_leg_seq'],
    ['fractional legSeq', { legSeq: 1.5 }, 'invalid_leg_seq'],
    ['negative legSeq', { legSeq: -1 }, 'invalid_leg_seq'],
  ])('build rejects %s', (_label, override, code) => {
    expect(
      errorCode(() =>
        buildFlightKey({
          operatingCarrierIcao: 'AAL',
          flightNumber: '100',
          scheduledDepartureDateLocal: '2026-09-19',
          originIcao: 'KJFK',
          ...override,
        }),
      ),
    ).toBe(code);
  });

  it.each([
    '',
    'aal-100-2026-09-19-kjfk',
    'AA-100-2026-09-19-KJFK',
    'AAL-0100-2026-09-19-KJFK',
    'AAL-100-2026-09-19-JFK',
    'AAL-100-2026-09-19',
    'AAL-100-2026-02-30-KJFK',
    'AAL-100-20260919-KJFK',
    'AAL-100-2026-09-19-KJFK-L1',
    'AAL-100-2026-09-19-KJFK-L0',
    'AAL-100-2026-09-19-KJFK-L02',
    'AAL-100-2026-09-19-KJFK-2',
    'AAL-100-2026-09-19-KJFK ',
    'AAL-100AB-2026-09-19-KJFK',
  ])('parse rejects %j', (key) => {
    expect(errorCode(() => parseFlightKey(key))).toBe('invalid_key');
    expect(isFlightKey(key)).toBe(false);
    expect(FlightKeySchema.safeParse(key).success).toBe(false);
  });

  it('FlightKeySchema rejects non-strings', () => {
    expect(FlightKeySchema.safeParse(100).success).toBe(false);
    expect(FlightKeySchema.safeParse(null).success).toBe(false);
  });

  it('FLIGHT_KEY_RE alone is not enough: the calendar check is separate', () => {
    expect(FLIGHT_KEY_RE.test('AAL-100-2026-02-30-KJFK')).toBe(true);
    expect(isFlightKey('AAL-100-2026-02-30-KJFK')).toBe(false);
  });
});

describe('originLocalDate', () => {
  it('derives the calendar date in the origin zone, never in UTC', () => {
    const instant = '2026-09-20T03:50:00Z';
    expect(originLocalDate(instant, 'America/New_York')).toBe('2026-09-19');
    expect(originLocalDate(instant, 'Europe/London')).toBe('2026-09-20');
    expect(originLocalDate(instant, 'Pacific/Kiritimati')).toBe('2026-09-20');
    expect(originLocalDate(instant, 'Pacific/Pago_Pago')).toBe('2026-09-19');
    expect(originLocalDate('2026-09-19T23:30:00Z', 'Asia/Tokyo')).toBe('2026-09-20');
    expect(originLocalDate('2026-09-19T23:30:00Z', 'UTC')).toBe('2026-09-19');
  });

  it('accepts a Date instance', () => {
    expect(originLocalDate(new Date('2026-09-20T03:50:00Z'), 'America/New_York')).toBe(
      '2026-09-19',
    );
  });

  it('follows daylight-saving transitions', () => {
    // DST ends 2026-11-01 at 06:00Z in New York.
    expect(originLocalDate('2026-11-01T03:30:00Z', 'America/New_York')).toBe('2026-10-31');
    expect(originLocalDate('2026-11-01T04:30:00Z', 'America/New_York')).toBe('2026-11-01');
    expect(originLocalDate('2026-11-02T04:30:00Z', 'America/New_York')).toBe('2026-11-01');
    expect(originLocalDate('2026-11-02T05:30:00Z', 'America/New_York')).toBe('2026-11-02');
  });

  it('refuses a bare date or a naive time, which new Date would read in the wrong zone', () => {
    // '2026-09-19' parses as UTC midnight, which is 2026-09-18 in New York.
    expect(errorCode(() => originLocalDate('2026-09-19', 'America/New_York'))).toBe(
      'invalid_instant',
    );
    expect(errorCode(() => originLocalDate('2026-09-19T23:50:00', 'America/New_York'))).toBe(
      'invalid_instant',
    );
    expect(originLocalDate('2026-09-19T23:50:00-04:00', 'America/New_York')).toBe('2026-09-19');
    expect(originLocalDate('2026-09-20T03:50:00.000Z', 'America/New_York')).toBe('2026-09-19');
    expect(originLocalDate('2026-09-20T03:50Z', 'America/New_York')).toBe('2026-09-19');
  });

  it('throws typed errors for a bad instant or an unknown zone', () => {
    expect(errorCode(() => originLocalDate('not-a-date', 'UTC'))).toBe('invalid_instant');
    expect(errorCode(() => originLocalDate(new Date(Number.NaN), 'UTC'))).toBe('invalid_instant');
    expect(errorCode(() => originLocalDate('2026-09-20T03:50:00Z', 'Mars/Olympus'))).toBe(
      'invalid_timezone',
    );
    expect(errorCode(() => originLocalDate('2026-09-20T03:50:00Z', ''))).toBe('invalid_timezone');
  });
});

describe('scheduledDepartureDateLocalOf', () => {
  it('prefers scheduledOut in the origin zone', () => {
    expect(scheduledDepartureDateLocalOf(makeStatus())).toBe('2026-09-19');
    expect(
      scheduledDepartureDateLocalOf(makeStatus({ scheduledDepartureDateLocal: '2026-09-20' })),
    ).toBe('2026-09-19');
  });

  it('falls back to the provider local date when the zone or the instant is missing', () => {
    const noTz = makeStatus({
      origin: { icao: 'KJFK' },
      scheduledDepartureDateLocal: '2026-09-19',
    });
    expect(scheduledDepartureDateLocalOf(noTz)).toBe('2026-09-19');
    const noInstant = makeStatus({ times: {}, scheduledDepartureDateLocal: '2026-09-19' });
    expect(scheduledDepartureDateLocalOf(noInstant)).toBe('2026-09-19');
  });

  it('throws missing_local_date rather than guessing UTC', () => {
    const noTz = makeStatus({ origin: { icao: 'KJFK' } });
    expect(errorCode(() => scheduledDepartureDateLocalOf(noTz))).toBe('missing_local_date');
    expect(errorCode(() => canonicalizeFromProvider(noTz))).toBe('missing_local_date');
    const nothing = makeStatus({ origin: { icao: 'KJFK' }, times: {} });
    expect(errorCode(() => scheduledDepartureDateLocalOf(nothing))).toBe('missing_local_date');
  });
});

describe('canonicalizeFromProvider', () => {
  it('builds the key from the operating carrier and the origin-local date', () => {
    expect(canonicalizeFromProvider(makeStatus())).toBe(AA100_KEY);
  });

  it('resolves a BA1512 marketing lookup to the AA key once the provider names AAL', () => {
    // The user typed BA1512; the DesignatorResolver asked the provider; the provider answered
    // with the operating carrier and listed BA1512 as a codeshare.
    const marketing = parseDesignator('BA1512');
    expect(marketing.carrier).toEqual({ iata: 'BA' });
    const fromBaLookup = makeStatus({
      codeshares: [{ carrierIata: 'BA', flightNumber: marketing.number }],
    });
    const fromAaLookup = makeStatus();
    expect(canonicalizeFromProvider(fromBaLookup)).toBe(AA100_KEY);
    expect(canonicalizeFromProvider(fromBaLookup)).toBe(canonicalizeFromProvider(fromAaLookup));
  });

  it('ignores a key already present on the status', () => {
    const stale = makeStatus({ key: 'BAW-1512-2026-09-19-KJFK' as FlightKey });
    expect(canonicalizeFromProvider(stale)).toBe(AA100_KEY);
  });

  it('renders legSeq from the status', () => {
    expect(canonicalizeFromProvider(makeStatus({ legSeq: 2 }))).toBe(`${AA100_KEY}-L2`);
  });

  it('uses the provider local date when the origin has no zone', () => {
    const status = makeStatus({
      origin: { icao: 'KJFK' },
      scheduledDepartureDateLocal: '2026-09-19',
    });
    expect(canonicalizeFromProvider(status)).toBe(AA100_KEY);
  });
});

describe('key immutability: reconcileFlightKey and classifyKeyDrift', () => {
  const existing = canonicalizeFromProvider(makeStatus());

  it('keeps the original key when a 23:50 departure slips to 00:10 local', () => {
    const slipped = makeStatus({
      times: { ...AA100_INPUT.times, scheduledOut: '2026-09-20T04:10:00Z' },
    });
    expect(canonicalizeFromProvider(slipped)).toBe('AAL-100-2026-09-20-KJFK');
    const result = reconcileFlightKey(existing, slipped);
    expect(result.key).toBe(AA100_KEY);
    expect(result.fresh).toBe('AAL-100-2026-09-20-KJFK');
    expect(result.drift).toBe('date_shift');
  });

  it('reports no drift for an unchanged status', () => {
    expect(reconcileFlightKey(existing, makeStatus())).toEqual({
      key: AA100_KEY,
      fresh: AA100_KEY,
      drift: 'none',
    });
  });

  it('flags an operator swap or a number change as a different flight', () => {
    const swapped = makeStatus({ operatingCarrierIcao: 'ENY' });
    expect(reconcileFlightKey(existing, swapped)).toEqual({
      key: AA100_KEY,
      fresh: 'ENY-100-2026-09-19-KJFK',
      drift: 'different_flight',
    });
    expect(reconcileFlightKey(existing, makeStatus({ legSeq: 2 })).drift).toBe('different_flight');
    expect(
      reconcileFlightKey(existing, makeStatus({ origin: { icao: 'KLGA', tz: 'America/New_York' } }))
        .drift,
    ).toBe('different_flight');
  });

  it('classifyKeyDrift compares parsed parts, not strings', () => {
    const a = 'AAL-100-2026-09-19-KJFK' as FlightKey;
    expect(classifyKeyDrift(a, 'AAL-100-2026-09-19-KJFK' as FlightKey)).toBe('none');
    expect(classifyKeyDrift(a, 'AAL-100-2026-09-21-KJFK' as FlightKey)).toBe('date_shift');
    expect(classifyKeyDrift(a, 'AAL-101-2026-09-19-KJFK' as FlightKey)).toBe('different_flight');
    expect(classifyKeyDrift(a, 'AAL-100-2026-09-19-KJFK-L2' as FlightKey)).toBe('different_flight');
    expect(() => classifyKeyDrift(a, 'nope' as FlightKey)).toThrow(FlightKeyError);
  });
});

describe('regionalOperatorHint', () => {
  const table: RegionalOperatorRule[] = [
    {
      marketingIata: 'AA',
      from: 3200,
      to: 4299,
      operatingIcao: 'ENY',
      confidence: 'observed',
      source: 'https://example.test/eagle',
      asOf: '2026-01-01',
    },
    {
      marketingIata: 'AA',
      from: 3300,
      to: 3399,
      operatingIcao: 'SKW',
      confidence: 'assumed',
      source: 'https://example.test/eagle',
      asOf: '2026-01-01',
    },
    {
      marketingIata: 'DL',
      from: 3000,
      to: 3999,
      operatingIcao: 'EDV',
      confidence: 'published',
      source: 'https://example.test/delta',
      asOf: '2026-01-01',
    },
  ];

  it('returns the operator of the first matching block, boundaries inclusive', () => {
    expect(regionalOperatorHint({ iata: 'AA' }, '3200', table)).toBe('ENY');
    expect(regionalOperatorHint({ iata: 'AA' }, '4299', table)).toBe('ENY');
    expect(regionalOperatorHint({ iata: 'AA' }, '03400', table)).toBe('ENY');
    expect(regionalOperatorHint({ iata: 'aa' }, '3400', table)).toBe('ENY');
    expect(regionalOperatorHint({ iata: 'DL' }, '3500', table)).toBe('EDV');
  });

  it('first hit wins when blocks overlap', () => {
    expect(regionalOperatorHint({ iata: 'AA' }, '3350', table)).toBe('ENY');
    expect(regionalOperatorHint({ iata: 'AA' }, '3350', [...table].reverse())).toBe('SKW');
  });

  it('returns undefined outside every block, for ICAO-only refs and for bad numbers', () => {
    expect(regionalOperatorHint({ iata: 'AA' }, '100', table)).toBeUndefined();
    expect(regionalOperatorHint({ iata: 'AA' }, '4300', table)).toBeUndefined();
    expect(regionalOperatorHint({ iata: 'UA' }, '3400', table)).toBeUndefined();
    expect(regionalOperatorHint({ icao: 'AAL' }, '3400', table)).toBeUndefined();
    expect(regionalOperatorHint({ iata: 'AA' }, 'ABC', table)).toBeUndefined();
    expect(regionalOperatorHint({ iata: 'AA' }, '', table)).toBeUndefined();
    expect(regionalOperatorHint({ iata: 'AA' }, '3400', [])).toBeUndefined();
  });

  it('is a hint: the same lookup against the seed and against an override can differ', () => {
    const override: RegionalOperatorRule[] = [{ ...table[0]!, operatingIcao: 'XXX' }];
    expect(regionalOperatorHint({ iata: 'AA' }, '3400', override)).toBe('XXX');
  });
});

describe('RegionalOperatorRuleSchema and the seed', () => {
  const rule = {
    marketingIata: 'AA',
    from: 3200,
    to: 4299,
    operatingIcao: 'ENY',
    confidence: 'observed',
    source: 'https://example.test/eagle',
    asOf: '2026-01-01',
  };

  it('validates the rule shape', () => {
    expect(RegionalOperatorRuleSchema.safeParse(rule).success).toBe(true);
    expect(RegionalOperatorRuleSchema.safeParse({ ...rule, from: 5000 }).success).toBe(false);
    expect(RegionalOperatorRuleSchema.safeParse({ ...rule, marketingIata: 'AAL' }).success).toBe(
      false,
    );
    expect(RegionalOperatorRuleSchema.safeParse({ ...rule, operatingIcao: 'MQ' }).success).toBe(
      false,
    );
    expect(RegionalOperatorRuleSchema.safeParse({ ...rule, source: 'wiki' }).success).toBe(false);
    expect(RegionalOperatorRuleSchema.safeParse({ ...rule, confidence: 'sure' }).success).toBe(
      false,
    );
    expect(RegionalOperatorRuleSchema.safeParse({ ...rule, asOf: '2026-1-1' }).success).toBe(false);
    expect(
      RegionalOperatorSeedSchema.safeParse({ asOf: '2026-09-19', rules: [rule] }).success,
    ).toBe(true);
    expect(REGIONAL_OPERATOR_CONFIDENCES).toEqual(['published', 'observed', 'assumed']);
  });

  it('ships rules for the marketing carriers and operators the spec names', () => {
    const pairs = new Set(
      REGIONAL_OPERATOR_SEED.map((r) => `${r.marketingIata}:${r.operatingIcao}`),
    );
    for (const pair of [
      'AA:ENY',
      'AA:SKW',
      'AA:JIA',
      'AA:PDT',
      'DL:EDV',
      'DL:SKW',
      'UA:SKW',
      'UA:ASH',
      'UA:RPA',
      'UA:GJS',
      'UA:UCA',
    ]) {
      expect(pairs.has(pair), pair).toBe(true);
    }
  });

  it('every seed operator is resolvable through the offline carrier table', () => {
    const known = new Set(Object.values(CARRIER_IATA_TO_ICAO_FALLBACK));
    for (const r of REGIONAL_OPERATOR_SEED) {
      expect(known.has(r.operatingIcao), r.operatingIcao).toBe(true);
    }
  });

  it('blocks never overlap within one marketing carrier, so first-hit-wins is unambiguous', () => {
    const byCarrier = new Map<string, RegionalOperatorRule[]>();
    for (const r of REGIONAL_OPERATOR_SEED) {
      byCarrier.set(r.marketingIata, [...(byCarrier.get(r.marketingIata) ?? []), r]);
    }
    for (const rules of byCarrier.values()) {
      const sorted = [...rules].sort((a, b) => a.from - b.from);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(
          sorted[i]!.from,
          `${sorted[i]!.marketingIata} ${String(sorted[i]!.from)}`,
        ).toBeGreaterThan(sorted[i - 1]!.to);
      }
    }
  });

  it('every rule cites an https source and a real date', () => {
    for (const r of REGIONAL_OPERATOR_SEED) {
      expect(r.source.startsWith('https://')).toBe(true);
      expect(isValidIsoDate(r.asOf)).toBe(true);
      expect(r.from).toBeGreaterThanOrEqual(1000);
      expect(r.to).toBeLessThanOrEqual(9999);
    }
  });

  it('a mainline number never gets a regional hint', () => {
    for (const iata of ['AA', 'DL', 'UA']) {
      expect(regionalOperatorHint({ iata }, '100', REGIONAL_OPERATOR_SEED)).toBeUndefined();
      expect(regionalOperatorHint({ iata }, '2999', REGIONAL_OPERATOR_SEED)).toBeUndefined();
    }
  });
});
