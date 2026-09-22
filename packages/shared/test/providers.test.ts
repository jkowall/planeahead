import { describe, expect, it } from 'vitest';
import { ALERT_EVENTS as STATUS_ALERT_EVENTS, type ProviderCallRecord } from '../src/flight-status';
import type { FlightKey } from '../src/flight-key';
import {
  ALERT_EVENTS,
  AlertEventSchema,
  type AircraftPositionProvider,
  type BudgetGuard,
  type CostLogger,
  type FlightDataProvider,
  type ProviderCallContext,
  type ProviderResult,
} from '../src/providers';
import { makeStatus } from './fixtures';

/**
 * The provider interfaces are types, so most of this file is checked by `tsc`: a provider that
 * forgets the cost record or reads the wall clock does not compile. The runtime assertions pin
 * the two behaviours an adapter must honour: every result carries its call record, and the only
 * clock is `ctx.now`.
 */

function makeCall(ctx: ProviderCallContext, operation: string): ProviderCallRecord {
  return {
    id: '019968a7-4e00-7000-8000-000000000010',
    provider: 'mock',
    operation,
    trigger: ctx.trigger,
    requestId: ctx.requestId,
    startedAt: ctx.now().toISOString(),
    latencyMs: 0,
    result: 'ok',
    costUnits: 0,
    pollEquivalents: 0,
    estCostUsdMicros: 0,
  };
}

const mockFlightProvider: FlightDataProvider = {
  id: 'mock',
  capabilities: {
    alerts: true,
    alertFields: ['status', 'times'],
    boards: false,
    maxDaysAhead: 2,
    fidsWindowHours: 48,
    inboundLink: false,
  },
  getFlight(lookup, ctx) {
    const status = makeStatus({ flightNumber: lookup.flightNumber });
    return Promise.resolve({ data: [status], call: makeCall(ctx, 'flight_status') });
  },
  registerAlert(_key, options, ctx) {
    return Promise.resolve({
      data: { alertId: `alert-${String(options.maxWeekly)}` },
      call: makeCall(ctx, 'alert_manage'),
    });
  },
  deleteAlert(_alertId, ctx) {
    return Promise.resolve({ data: undefined, call: makeCall(ctx, 'alert_manage') });
  },
};

const mockPositionProvider: AircraftPositionProvider = {
  id: 'mock',
  maxIdsPerRequest: 25,
  getPositions(query, ctx) {
    const hexes = query.icaoHexes ?? [];
    return Promise.resolve({
      data: hexes.map((icaoHex) => ({
        icaoHex,
        lat: 0,
        lon: 0,
        seenAt: ctx.now().toISOString(),
        source: 'mock' as const,
      })),
      call: makeCall(ctx, 'positions'),
    });
  },
};

function makeContext(now: Date): { ctx: ProviderCallContext; recorded: ProviderCallRecord[] } {
  const recorded: ProviderCallRecord[] = [];
  const budget: BudgetGuard = {
    reserve: (request) =>
      Promise.resolve({ allowed: true, granted: request.pollEquivalents, ladder: 'normal' }),
  };
  const log: CostLogger = {
    record: (call) => {
      recorded.push(call);
    },
  };
  const ctx: ProviderCallContext = {
    trigger: 'alarm',
    flightKey: 'AAL-100-2026-09-19-KJFK' as FlightKey,
    requestId: 'req-1',
    budget,
    log,
    now: () => now,
  };
  return { ctx, recorded };
}

describe('provider interfaces', () => {
  it('re-export the alert event vocabulary from flight-status', () => {
    expect(ALERT_EVENTS).toBe(STATUS_ALERT_EVENTS);
    expect(AlertEventSchema.safeParse('off').success).toBe(true);
    expect(AlertEventSchema.safeParse('gate').success).toBe(false);
    // Increment 6: AeroAPI 4.17.1 has no hold events.
    expect(AlertEventSchema.safeParse('hold_start').success).toBe(false);
    expect(AlertEventSchema.safeParse('hold_end').success).toBe(false);
  });

  it('a budget denial for the per-second rate carries a retry hint', async () => {
    const guard: BudgetGuard = {
      reserve: () =>
        Promise.resolve({ allowed: false, reason: 'provider_rate_limit', retryAfterMs: 100 }),
      backoff: () => Promise.resolve(),
    };
    const decision = await guard.reserve({
      provider: 'aerodatabox',
      operation: 'flight_status',
      pollEquivalents: 0.1,
      trigger: 'alarm',
    });
    expect(decision).toEqual({ allowed: false, reason: 'provider_rate_limit', retryAfterMs: 100 });
    await expect(guard.backoff?.('aerodatabox', 1_000)).resolves.toBeUndefined();
  });

  it('every call returns its data next to a cost record stamped with the injected clock', async () => {
    const now = new Date('2026-09-19T12:00:00Z');
    const { ctx, recorded } = makeContext(now);
    const result: ProviderResult<unknown[]> = await mockFlightProvider.getFlight(
      { carrier: { iata: 'AA' }, flightNumber: '100', dateLocal: '2026-09-19' },
      ctx,
    );
    await ctx.log.record(result.call);
    expect(result.data).toHaveLength(1);
    expect(result.call.startedAt).toBe('2026-09-19T12:00:00.000Z');
    expect(result.call.trigger).toBe('alarm');
    expect(recorded).toEqual([result.call]);
  });

  it('optional operations are absent unless the adapter implements them', async () => {
    expect(Object.keys(mockFlightProvider)).not.toContain('getBoard');
    expect(Object.keys(mockFlightProvider)).not.toContain('parseWebhook');
    const { ctx } = makeContext(new Date('2026-09-19T12:00:00Z'));
    const registered = await mockFlightProvider.registerAlert?.(
      'AAL-100-2026-09-19-KJFK' as FlightKey,
      { events: ['out', 'off', 'on', 'in'], maxWeekly: 20 },
      ctx,
    );
    expect(registered?.data.alertId).toBe('alert-20');
    const deleted = await mockFlightProvider.deleteAlert?.('alert-20', ctx);
    expect(deleted?.data).toBeUndefined();
    expect(deleted?.call.operation).toBe('alert_manage');
  });

  it('position providers batch by hex and report their measured batch size', async () => {
    const { ctx } = makeContext(new Date('2026-09-19T12:00:00Z'));
    const result = await mockPositionProvider.getPositions(
      { icaoHexes: ['A0B1C2', 'A0B1C3'] },
      ctx,
    );
    expect(mockPositionProvider.maxIdsPerRequest).toBe(25);
    expect(result.data.map((p) => p.icaoHex)).toEqual(['A0B1C2', 'A0B1C3']);
    expect(result.data[0]?.seenAt).toBe('2026-09-19T12:00:00.000Z');
  });

  it('the budget guard answers with a decision the adapter can branch on', async () => {
    const { ctx } = makeContext(new Date('2026-09-19T12:00:00Z'));
    const decision = await ctx.budget.reserve({
      provider: 'aeroapi',
      operation: 'flight_by_id',
      pollEquivalents: 1,
      trigger: 'alarm',
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.granted).toBe(1);
      expect(decision.ladder).toBe('normal');
    }
  });
});
