import { describe, expect, it } from 'vitest';
import {
  CARRIER_IATA_TO_ICAO_FALLBACK,
  CarrierRefSchema,
  IATA_CARRIER_RE,
  ICAO_CARRIER_RE,
  carrierIcaoFromIata,
  resolveCarrierIcao,
} from '../src/carriers';

describe('CarrierRefSchema', () => {
  it('needs at least one code', () => {
    expect(CarrierRefSchema.safeParse({}).success).toBe(false);
    expect(CarrierRefSchema.safeParse({ iata: 'AA' }).success).toBe(true);
    expect(CarrierRefSchema.safeParse({ icao: 'AAL' }).success).toBe(true);
  });

  it('validates code shapes', () => {
    expect(CarrierRefSchema.safeParse({ icao: 'AA' }).success).toBe(false);
    expect(CarrierRefSchema.safeParse({ icao: 'aal' }).success).toBe(false);
    expect(CarrierRefSchema.safeParse({ iata: 'AAL' }).success).toBe(false);
    expect(CarrierRefSchema.safeParse({ iata: '12' }).success).toBe(false);
    expect(CarrierRefSchema.safeParse({ iata: '9W' }).success).toBe(true);
  });

  it('keeps unknown fields', () => {
    expect(CarrierRefSchema.parse({ iata: 'AA', name: 'American' })).toHaveProperty('name');
  });
});

describe('carrierIcaoFromIata', () => {
  it('resolves through the injected table', () => {
    expect(carrierIcaoFromIata('AA', { AA: 'AAL' })).toBe('AAL');
    expect(carrierIcaoFromIata('aa', { AA: 'AAL' })).toBe('AAL');
    expect(carrierIcaoFromIata(' aa ', { AA: 'AAL' })).toBe('AAL');
  });

  it('returns undefined for unknown or malformed codes', () => {
    expect(carrierIcaoFromIata('ZZ', { AA: 'AAL' })).toBeUndefined();
    expect(carrierIcaoFromIata('AAL', CARRIER_IATA_TO_ICAO_FALLBACK)).toBeUndefined();
    expect(carrierIcaoFromIata('', CARRIER_IATA_TO_ICAO_FALLBACK)).toBeUndefined();
  });

  it('does not read prototype properties as codes', () => {
    expect(carrierIcaoFromIata('constructor', {})).toBeUndefined();
  });

  it('lets the injected table override the fallback', () => {
    expect(carrierIcaoFromIata('AA', { AA: 'XXX' })).toBe('XXX');
    expect(carrierIcaoFromIata('AA', CARRIER_IATA_TO_ICAO_FALLBACK)).toBe('AAL');
  });
});

describe('resolveCarrierIcao', () => {
  it('prefers an explicit ICAO code and falls back to the table', () => {
    expect(resolveCarrierIcao({ icao: 'BAW', iata: 'AA' }, { AA: 'AAL' })).toBe('BAW');
    expect(resolveCarrierIcao({ iata: 'AA' }, { AA: 'AAL' })).toBe('AAL');
    expect(resolveCarrierIcao({ iata: 'ZZ' }, { AA: 'AAL' })).toBeUndefined();
  });
});

describe('CARRIER_IATA_TO_ICAO_FALLBACK', () => {
  it('holds only well-formed codes and roughly 60 or more carriers', () => {
    const entries = Object.entries(CARRIER_IATA_TO_ICAO_FALLBACK);
    expect(entries.length).toBeGreaterThanOrEqual(60);
    for (const [iata, icao] of entries) {
      expect(iata).toMatch(IATA_CARRIER_RE);
      expect(icao).toMatch(ICAO_CARRIER_RE);
    }
  });

  it('covers the US majors and the regional operators the hint table refers to', () => {
    expect(CARRIER_IATA_TO_ICAO_FALLBACK).toMatchObject({
      AA: 'AAL',
      DL: 'DAL',
      UA: 'UAL',
      MQ: 'ENY',
      OO: 'SKW',
      OH: 'JIA',
      PT: 'PDT',
      '9E': 'EDV',
      YX: 'RPA',
      YV: 'ASH',
      G7: 'GJS',
      C5: 'UCA',
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(CARRIER_IATA_TO_ICAO_FALLBACK)).toBe(true);
  });
});
