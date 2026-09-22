import { describe, expect, it } from 'vitest';
import type { FlightKey } from '../src/flight-key';
import type { ProviderCallRecord } from '../src/flight-status';
import {
  PROVIDER_CALL_POINT_BLOBS,
  PROVIDER_CALL_POINT_DOUBLES,
  providerCallPoint,
} from '../src/provider-call-point';

const RECORD: ProviderCallRecord = {
  id: '019968a7-4e00-7000-8000-000000000000',
  provider: 'aerodatabox',
  operation: 'flight_status',
  trigger: 'alarm',
  flightKey: 'AAL-100-2026-09-19-KJFK' as FlightKey,
  requestId: 'req-1',
  startedAt: '2026-09-19T12:00:00Z',
  latencyMs: 412,
  httpStatus: 200,
  result: 'ok',
  costUnits: 2,
  pollEquivalents: 0.1,
  estCostUsdMicros: 500,
};

describe('providerCallPoint', () => {
  it('fixes the column order: index1 provider, five blobs, four doubles', () => {
    expect(PROVIDER_CALL_POINT_BLOBS).toEqual([
      'operation',
      'flight_key',
      'trigger',
      'result',
      'environment',
    ]);
    expect(PROVIDER_CALL_POINT_DOUBLES).toEqual([
      'latency_ms',
      'cost_units',
      'est_cost_usd_micros',
      'http_status',
    ]);
  });

  it('maps a record onto that order', () => {
    expect(providerCallPoint(RECORD, 'staging')).toEqual({
      indexes: ['aerodatabox'],
      blobs: ['flight_status', 'AAL-100-2026-09-19-KJFK', 'alarm', 'ok', 'staging'],
      doubles: [412, 2, 500, 200],
    });
  });

  it('keeps the arity for a call with no flight key and no HTTP status', () => {
    const denied: ProviderCallRecord = {
      ...RECORD,
      result: 'rate_limited',
      costUnits: 0,
      estCostUsdMicros: 0,
      latencyMs: 0,
    };
    delete denied.flightKey;
    delete denied.httpStatus;
    const point = providerCallPoint(denied, 'production');
    expect(point.blobs).toHaveLength(PROVIDER_CALL_POINT_BLOBS.length);
    expect(point.doubles).toHaveLength(PROVIDER_CALL_POINT_DOUBLES.length);
    expect(point.blobs[1]).toBe('');
    expect(point.doubles[3]).toBe(0);
  });

  it('stays inside the Analytics Engine per-point limits', () => {
    const point = providerCallPoint(RECORD, 'production');
    expect(point.indexes).toHaveLength(1);
    expect(new TextEncoder().encode(point.indexes[0]).length).toBeLessThanOrEqual(96);
    expect(point.blobs.length).toBeLessThanOrEqual(20);
    expect(point.doubles.length).toBeLessThanOrEqual(20);
  });
});
