/**
 * Cost logging: inside a Durable Object a record is an outbox append; in a Worker it is a
 * `provider_calls` row written through `withDb` plus the Analytics Engine point whose shape
 * `@planeahead/shared` fixes. The database test uses a fresh UUIDv7 per record, so it runs in
 * parallel with every other file against the one test database.
 */

import { eq } from 'drizzle-orm';
import { providerCalls, withDb } from '@planeahead/db';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_CALL_POINT_BLOBS,
  PROVIDER_CALL_POINT_DOUBLES,
  providerCallPoint,
  uuidv7,
  type FlightKey,
  type ProviderCallRecord,
} from '@planeahead/shared';
import type { Env } from '../../src/env';
import { createLogger } from '../../src/observability/log';
import {
  DurableObjectCostLogger,
  PROVIDER_CALL_OUTBOX_KIND,
  WorkerCostLogger,
  createCostLogger,
  providerCallRow,
} from '../../src/providers/cost-log';
import { AnalyticsBudget } from '../../src/queues/analytics';

function record(overrides: Partial<ProviderCallRecord> = {}): ProviderCallRecord {
  return {
    id: uuidv7(),
    provider: 'aerodatabox',
    operation: 'flight_status',
    trigger: 'alarm',
    flightKey: 'AAL-100-2026-09-22-KJFK' as FlightKey,
    requestId: 'req-cost-log',
    startedAt: '2026-09-22T20:00:00.000Z',
    latencyMs: 412,
    httpStatus: 200,
    result: 'ok',
    costUnits: 2,
    pollEquivalents: 0.1,
    estCostUsdMicros: 500,
    responseBytes: 3_812,
    ...overrides,
  };
}

describe('inside a Durable Object', () => {
  it('appends to the outbox, synchronously, with no I/O', () => {
    const appended: { kind: string; payload: ProviderCallRecord }[] = [];
    const logger = createCostLogger({
      outbox: { append: (kind, payload) => appended.push({ kind, payload }) },
    });
    expect(logger).toBeInstanceOf(DurableObjectCostLogger);
    const call = record();
    const returned = logger.record(call);
    expect(returned).toBeUndefined();
    expect(appended).toEqual([{ kind: PROVIDER_CALL_OUTBOX_KIND, payload: call }]);
    expect(PROVIDER_CALL_OUTBOX_KIND).toBe('provider_call');
  });
});

describe('the provider_calls row', () => {
  it('maps every column the ledger keeps', () => {
    const call = record({ error: 'x'.repeat(300) });
    expect(providerCallRow(call)).toEqual({
      id: call.id,
      provider: 'aerodatabox',
      operation: 'flight_status',
      trigger: 'alarm',
      result: 'ok',
      httpStatus: 200,
      durationMs: 412,
      costUnits: 2,
      costUsdMicros: 500,
      flightKey: 'AAL-100-2026-09-22-KJFK',
      requestId: 'req-cost-log',
      errorCode: 'x'.repeat(200),
    });
    const refused = record({ result: 'rate_limited', costUnits: 0, estCostUsdMicros: 0 });
    delete refused.httpStatus;
    delete refused.flightKey;
    expect(providerCallRow(refused)).toMatchObject({
      httpStatus: null,
      flightKey: null,
      errorCode: null,
    });
  });
});

describe('the Analytics Engine point (shape fixed in shared)', () => {
  it('index1 provider; blobs operation, flight_key, trigger, result, environment; four doubles', () => {
    expect(providerCallPoint(record(), 'test')).toEqual({
      indexes: ['aerodatabox'],
      blobs: ['flight_status', 'AAL-100-2026-09-22-KJFK', 'alarm', 'ok', 'test'],
      doubles: [412, 2, 500, 200],
    });
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
});

describe('in a Worker', () => {
  it('writes the point and the provider_calls row, idempotently on the record id', async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const dataset = {
      writeDataPoint: (point?: AnalyticsEngineDataPoint) => points.push(point ?? {}),
    };
    const workerEnv = {
      DB: (env as Env).DB,
      PROVIDER_CALLS: dataset as unknown as AnalyticsEngineDataset,
    };
    const logger = createCostLogger({ env: workerEnv, environment: 'test' });
    expect(logger).toBeInstanceOf(WorkerCostLogger);
    const call = record({ trigger: 'user_search', result: 'not_found' });

    await logger.record(call);
    // A second record of the same call (a retried write) is stored once.
    await logger.record(call);

    expect(points).toHaveLength(2);
    expect(points[0]).toEqual({
      indexes: ['aerodatabox'],
      blobs: ['flight_status', 'AAL-100-2026-09-22-KJFK', 'user_search', 'not_found', 'test'],
      doubles: [412, 2, 500, 200],
    });
    const rows = await withDb(env as Env, (db) =>
      db.select().from(providerCalls).where(eq(providerCalls.id, call.id)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'aerodatabox',
      operation: 'flight_status',
      trigger: 'user_search',
      result: 'not_found',
      httpStatus: 200,
      durationMs: 412,
      costUnits: 2,
      costUsdMicros: 500,
      flightKey: 'AAL-100-2026-09-22-KJFK',
      requestId: 'req-cost-log',
    });
  });

  it("counts against the invocation's Analytics Engine budget when given one", async () => {
    const points: AnalyticsEngineDataPoint[] = [];
    const dataset = {
      writeDataPoint: (point?: AnalyticsEngineDataPoint) => points.push(point ?? {}),
    } as unknown as AnalyticsEngineDataset;
    // One invocation, one budget (a queue batch that also logs provider calls): a budget of 1
    // shared by two loggers lets exactly one point through, where two private budgets let two.
    const invocation = new AnalyticsBudget(
      dataset,
      createLogger({}, () => undefined),
      1,
    );
    const workerEnv = { DB: (env as Env).DB, PROVIDER_CALLS: dataset };
    const first = createCostLogger({ env: workerEnv, environment: 'test', analytics: invocation });
    const second = new WorkerCostLogger(workerEnv, { environment: 'test', analytics: invocation });
    expect((first as WorkerCostLogger).analytics).toBe(invocation);
    expect(second.analytics).toBe(invocation);
    await first.record(record());
    await second.record(record());
    expect(points).toHaveLength(1);
    expect(invocation.stats).toMatchObject({ written: 1, overflowed: 1 });
    // Without one, a logger in a route builds its own.
    expect(new WorkerCostLogger(workerEnv, { environment: 'test' }).analytics).not.toBe(invocation);
  });
});
