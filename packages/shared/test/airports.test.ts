import { describe, expect, it } from 'vitest';
import { AirportRefSchema, isSyntheticIcao, isValidTimeZone } from '../src/airports';

describe('AirportRefSchema', () => {
  it('parses a real airport and keeps unknown fields', () => {
    const parsed = AirportRefSchema.parse({
      icao: 'KJFK',
      iata: 'JFK',
      tz: 'America/New_York',
      elevationFt: 13,
    });
    expect(parsed.icao).toBe('KJFK');
    expect(parsed).toHaveProperty('elevationFt', 13);
  });

  it('requires a 4-character upper-case ICAO code', () => {
    expect(AirportRefSchema.safeParse({ icao: 'kjfk' }).success).toBe(false);
    expect(AirportRefSchema.safeParse({ icao: 'JFK' }).success).toBe(false);
    expect(AirportRefSchema.safeParse({ icao: 'KJFKX' }).success).toBe(false);
    expect(AirportRefSchema.safeParse({}).success).toBe(false);
  });

  it('validates the optional IATA code shape', () => {
    expect(AirportRefSchema.safeParse({ icao: 'KJFK', iata: 'jfk' }).success).toBe(false);
    expect(AirportRefSchema.safeParse({ icao: 'KJFK', iata: 'JFKX' }).success).toBe(false);
  });

  it('accepts a synthetic ZZ code only when flagged synthetic', () => {
    expect(AirportRefSchema.safeParse({ icao: 'ZZ1A', synthetic: true }).success).toBe(true);
    expect(AirportRefSchema.safeParse({ icao: 'ZZ1A' }).success).toBe(false);
    expect(AirportRefSchema.safeParse({ icao: 'ZZ1A', synthetic: false }).success).toBe(false);
  });

  it('rejects the synthetic flag on a real ICAO code', () => {
    expect(AirportRefSchema.safeParse({ icao: 'KJFK', synthetic: true }).success).toBe(false);
    expect(AirportRefSchema.safeParse({ icao: 'KJFK', synthetic: false }).success).toBe(true);
  });
});

describe('isSyntheticIcao', () => {
  it('recognises the ZZ placeholder prefix', () => {
    expect(isSyntheticIcao('ZZ00')).toBe(true);
    expect(isSyntheticIcao('ZZZZ')).toBe(true);
    expect(isSyntheticIcao('KJFK')).toBe(false);
    expect(isSyntheticIcao('ZZ0')).toBe(false);
  });
});

describe('isValidTimeZone', () => {
  it('accepts IANA zones and rejects garbage', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
