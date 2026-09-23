import { describe, expect, it } from 'vitest';
import { PROVIDER_IDS } from '../src/flight-status';
import { SECRET_PATTERNS, findSecretPatterns } from '../src/secrets';

const MUST_MATCH = [
  'https://aeroapi.flightaware.com/aeroapi/flights/AAL100',
  'https://www.flightaware.com/aeroapi/portal',
  'https://aerodatabox.p.rapidapi.com/flights/number/AA100/2026-09-19',
  'https://prod.api.market/api/v1/aedbx/aerodatabox/flights/number/AA100',
  'https://api.adsb.lol/v2/hex/a0b1c2',
  'https://opendata.adsb.fi/api/v2/hex/a0b1c2',
  'https://api.airplanes.live/v2/hex/a0b1c2',
  'https://aviationweather.gov/api/data/metar?ids=KJFK',
  'https://api.weather.gov/alerts/active',
  'https://api.open-meteo.com/v1/forecast',
  'https://nasstatus.faa.gov/api/airport-status-information',
  'AEROAPI_KEY=abc',
  'AERODATABOX_API_KEY=abc',
  'process.env.APNS_KEY_ID',
  'FCM_SERVER_KEY',
  'BETTER_AUTH_SECRET',
  'TOKEN_KEK_V2',
  'RESEND_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'APPLE_SIWA_P8',
  'APPLE_SIWA_KEY_ID',
  'REVENUECAT_WEBHOOK_SECRET',
  'sk_live_4eC39HqLyjWDarjtT1zdp7dc',
  'sk_test_4eC39HqLyjWDarjtT1zdp7dc',
  're_123456789012345678901234',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIx',
  '-----BEGIN PRIVATE KEY-----',
  '-----BEGIN RSA PRIVATE KEY-----',
  '-----BEGIN EC PRIVATE KEY-----',
];

const MUST_NOT_MATCH = [
  'PlaneAhead flight tracker',
  'https://api.planeahead.app/v1/flights/AAL-100-2026-09-19-KJFK',
  'Bearer token required',
  'AERONAUTICAL_CHART',
  'aeroapi',
  'aerodatabox',
  'Data provided by AeroDataBox and FlightAware',
  'skip_live_update',
  'reticulating_splines_12345678901234567890',
  'apns-topic: app.planeahead.ios',
  'fcm topic',
  'The flight has a Bearer of bad news',
  PROVIDER_IDS.join(','),
];

describe('SECRET_PATTERNS', () => {
  it('is a frozen, non-empty list of regular expressions', () => {
    expect(Object.isFrozen(SECRET_PATTERNS)).toBe(true);
    expect(SECRET_PATTERNS.length).toBeGreaterThan(10);
    for (const pattern of SECRET_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.flags).not.toContain('g');
    }
  });

  it.each(MUST_MATCH)('flags %s', (text) => {
    expect(findSecretPatterns(text).length).toBeGreaterThan(0);
  });

  it.each(MUST_NOT_MATCH)('does not flag %s', (text) => {
    expect(findSecretPatterns(text)).toEqual([]);
  });

  it('does not flag its own source, so the patterns can ship inside a bundle', () => {
    const source = SECRET_PATTERNS.map((pattern) => pattern.source).join('\n');
    expect(findSecretPatterns(source)).toEqual([]);
  });

  it('findSecretPatterns returns every matching pattern', () => {
    const hits = findSecretPatterns('AEROAPI_KEY=sk_live_4eC39HqLyjWDarjtT1zdp7dc');
    expect(hits).toHaveLength(2);
    for (const hit of hits) {
      expect(SECRET_PATTERNS).toContain(hit);
    }
  });
});
