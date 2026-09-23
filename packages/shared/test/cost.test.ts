import { describe, expect, it } from 'vitest';
import {
  ADB_UNITS,
  ADB_UNIT_PRICE_USD_MICROS,
  AERODATABOX_OPERATIONS,
  AEROAPI_OPERATIONS,
  AEROAPI_STANDARD_MONTHLY_MINIMUM_USD_MICROS,
  AEROAPI_STATUS_PRICE_USD_MICROS,
  LIST_PRICE_USD_MICROS,
  UnknownOperationError,
  costUnits,
  estimateCostUsdMicros,
  listPriceUsdMicros,
  pollEquivalents,
} from '../src/cost';
import { PROVIDER_IDS, type ProviderId } from '../src/flight-status';

/**
 * A provider id as it arrives off the wire. With a literal provider the helpers check the
 * operation at compile time (see `types.test.ts`); with a run-time id the table check throws.
 */
function wire(provider: ProviderId): ProviderId {
  return provider;
}

const FREE_PROVIDERS = [
  'adsb_lol',
  'adsb_fi',
  'airplanes_live',
  'aviationweather',
  'nws',
  'open_meteo',
  'faa_nas',
  'llm',
  'mock',
] as const;

describe('LIST_PRICE_USD_MICROS', () => {
  it('has a price table for every provider id', () => {
    for (const provider of PROVIDER_IDS) {
      expect(LIST_PRICE_USD_MICROS).toHaveProperty(provider);
      expect(Object.keys(LIST_PRICE_USD_MICROS[provider]).length).toBeGreaterThan(0);
    }
  });

  it('prices AeroAPI operations as the plan states (USD micros per result set)', () => {
    expect(LIST_PRICE_USD_MICROS.aeroapi).toEqual({
      flight_by_ident: 5_000,
      flight_by_id: 5_000,
      flight_by_canonical: 1_000,
      position: 10_000,
      track: 12_000,
      schedules: 20_000,
      airport_flights: 20_000,
      airport_arrivals: 5_000,
      airport_departures: 5_000,
      alert_delivery: 20_000,
      alert_manage: 0,
    });
    expect(AEROAPI_STATUS_PRICE_USD_MICROS).toBe(LIST_PRICE_USD_MICROS.aeroapi.flight_by_id);
  });

  it('adds the increment 6 prices: canonical at one fifth of a poll, arrivals and departures apart from airport flights', () => {
    expect(listPriceUsdMicros('aeroapi', 'flight_by_canonical')).toBe(1_000);
    expect(listPriceUsdMicros('aeroapi', 'airport_arrivals')).toBe(5_000);
    expect(listPriceUsdMicros('aeroapi', 'airport_departures')).toBe(5_000);
    expect(listPriceUsdMicros('aeroapi', 'airport_flights')).toBe(20_000);
    expect(pollEquivalents('aeroapi', 'flight_by_canonical')).toBe(0.2);
    expect(pollEquivalents('aeroapi', 'airport_arrivals')).toBe(1);
    expect(costUnits('aeroapi', 'flight_by_canonical')).toBe(1);
    // The Standard tier's $100 monthly minimum, which the plan omitted.
    expect(AEROAPI_STANDARD_MONTHLY_MINIMUM_USD_MICROS).toBe(100_000_000);
  });

  it('prices AeroDataBox by units at the Growth unit price', () => {
    expect(ADB_UNIT_PRICE_USD_MICROS).toBe(250);
    expect(ADB_UNITS).toEqual({ flight_status: 2, fids: 2, airport: 1, alert_item: 1, health: 0 });
    expect(LIST_PRICE_USD_MICROS.aerodatabox).toEqual({
      flight_status: 500,
      fids: 500,
      airport: 250,
      alert_item: 250,
      health: 0,
    });
    // Health checks are FREE TIER but still an operation with a record.
    expect(costUnits('aerodatabox', 'health')).toBe(0);
    expect(estimateCostUsdMicros('aerodatabox', 'health')).toBe(0);
  });

  it('lists every AeroAPI and AeroDataBox operation exactly once', () => {
    expect(Object.keys(LIST_PRICE_USD_MICROS.aeroapi).sort()).toEqual(
      [...AEROAPI_OPERATIONS].sort(),
    );
    expect(Object.keys(LIST_PRICE_USD_MICROS.aerodatabox).sort()).toEqual(
      [...AERODATABOX_OPERATIONS].sort(),
    );
  });

  it('prices free feeds, the LLM and the mock at zero', () => {
    for (const provider of FREE_PROVIDERS) {
      for (const price of Object.values(LIST_PRICE_USD_MICROS[provider])) {
        expect(price).toBe(0);
      }
    }
  });
});

describe('listPriceUsdMicros', () => {
  it('returns the table entry', () => {
    expect(listPriceUsdMicros('aeroapi', 'schedules')).toBe(20_000);
    expect(listPriceUsdMicros('aerodatabox', 'airport')).toBe(250);
    expect(listPriceUsdMicros('nws', 'alerts')).toBe(0);
  });

  it('throws UnknownOperationError for an operation that is not priced', () => {
    expect(() => listPriceUsdMicros(wire('aeroapi'), 'weather')).toThrow(UnknownOperationError);
    expect(() => listPriceUsdMicros(wire('aeroapi'), 'weather')).toThrow(/aeroapi\.weather/);
  });

  it('does not read prototype properties as operations', () => {
    const aeroapi = wire('aeroapi');
    expect(() => listPriceUsdMicros(aeroapi, 'constructor')).toThrow(UnknownOperationError);
    expect(() => listPriceUsdMicros(aeroapi, '__proto__')).toThrow(UnknownOperationError);
  });
});

describe('pollEquivalents', () => {
  it('reproduces the plan table from the price table', () => {
    expect(pollEquivalents('aeroapi', 'flight_by_id')).toBe(1);
    expect(pollEquivalents('aeroapi', 'flight_by_ident')).toBe(1);
    expect(pollEquivalents('aeroapi', 'alert_delivery')).toBe(4);
    expect(pollEquivalents('aeroapi', 'schedules')).toBe(4);
    expect(pollEquivalents('aeroapi', 'airport_flights')).toBe(4);
    expect(pollEquivalents('aeroapi', 'position')).toBe(2);
    expect(pollEquivalents('aeroapi', 'track')).toBe(2.4);
    expect(pollEquivalents('aeroapi', 'alert_manage')).toBe(0);
    expect(pollEquivalents('aerodatabox', 'flight_status')).toBe(0.1);
    expect(pollEquivalents('aerodatabox', 'fids')).toBe(0.1);
    expect(pollEquivalents('aerodatabox', 'airport')).toBe(0.05);
    expect(pollEquivalents('aerodatabox', 'alert_item')).toBe(0.05);
    expect(pollEquivalents('adsb_lol', 'positions')).toBe(0);
    expect(pollEquivalents('aviationweather', 'metar')).toBe(0);
  });

  it('throws for an unpriced operation instead of returning 0', () => {
    expect(() => pollEquivalents(wire('adsb_lol'), 'track')).toThrow(UnknownOperationError);
  });
});

describe('costUnits', () => {
  it('counts AeroAPI result sets, AeroDataBox units and nothing for free feeds', () => {
    expect(costUnits('aeroapi', 'flight_by_id')).toBe(1);
    expect(costUnits('aeroapi', 'alert_delivery')).toBe(1);
    expect(costUnits('aeroapi', 'alert_manage')).toBe(0);
    expect(costUnits('aerodatabox', 'flight_status')).toBe(2);
    expect(costUnits('aerodatabox', 'fids')).toBe(2);
    expect(costUnits('aerodatabox', 'airport')).toBe(1);
    expect(costUnits('aerodatabox', 'alert_item')).toBe(1);
    expect(costUnits('adsb_fi', 'positions')).toBe(0);
    expect(costUnits('llm', 'completion')).toBe(0);
  });

  it('throws for an unpriced operation', () => {
    expect(() => costUnits(wire('aerodatabox'), 'flight_plan')).toThrow(UnknownOperationError);
  });
});

describe('estimateCostUsdMicros', () => {
  it('defaults to one call at list price', () => {
    expect(estimateCostUsdMicros('aeroapi', 'flight_by_id')).toBe(5_000);
    expect(estimateCostUsdMicros('aerodatabox', 'flight_status')).toBe(500);
    expect(estimateCostUsdMicros('open_meteo', 'forecast')).toBe(0);
  });

  it('scales with the units the call actually consumed', () => {
    expect(estimateCostUsdMicros('aeroapi', 'flight_by_ident', 3)).toBe(15_000);
    expect(estimateCostUsdMicros('aerodatabox', 'flight_status', 4)).toBe(1_000);
    expect(estimateCostUsdMicros('aerodatabox', 'airport', 0)).toBe(0);
    expect(estimateCostUsdMicros('adsb_lol', 'positions', 50)).toBe(0);
  });

  it('throws for an unpriced operation on every provider kind', () => {
    for (const provider of ['aeroapi', 'aerodatabox', 'nws'] as const) {
      expect(() => estimateCostUsdMicros(wire(provider), 'x', 1)).toThrow(UnknownOperationError);
    }
  });
});
