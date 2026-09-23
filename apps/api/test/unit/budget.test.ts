/**
 * The budget guards' pure parts and the Worker-side guard with fakes: the 70 / 90 / 100 ladder,
 * the object naming, the per-flight rule with the caps derived in shared, the composition that
 * releases on refusal, and the KV fast path that only ever says no.
 */

import { describe, expect, it } from 'vitest';
import {
  A2_EXPECTED_PE,
  A2_HARD_CAP_PE,
  A2_SOFT_CAP_PE,
  type BudgetDecision,
  type BudgetGuard,
  type BudgetRequest,
} from '@planeahead/shared';
import {
  LADDER_THRESHOLDS,
  ProviderBudgetGuard,
  budgetKvKey,
  composeBudgets,
  finaliseAtMs,
  ladderFor,
  parseProviderBudgetName,
  perFlightLedgerDecision,
  providerBudgetName,
  utcDate,
  type BudgetKvCopy,
  type ProviderBudgetRpc,
} from '../../src/providers/budget';
import { ADB_PLANS, budgetDefaults, providerSettings } from '../../src/providers/config';

const REQUEST: BudgetRequest = {
  provider: 'aerodatabox',
  operation: 'flight_status',
  pollEquivalents: 0.1,
  trigger: 'alarm',
};

describe('the 70 / 90 / 100 percent ladder', () => {
  it.each([
    [0, 'normal'],
    [69.9, 'normal'],
    [70, 'warn'],
    [89.9, 'warn'],
    [90, 'degraded'],
    [100, 'degraded'],
  ] as const)('%s percent of the cap is %s', (percent, rung) => {
    expect(ladderFor(percent, 100)).toBe(rung);
  });

  it('pins the thresholds and treats a zero cap as degraded', () => {
    expect(LADDER_THRESHOLDS).toEqual({ warn: 0.7, degraded: 0.9 });
    expect(ladderFor(0, 0)).toBe('degraded');
  });
});

describe('object naming', () => {
  it('is one object per provider per UTC day', () => {
    expect(providerBudgetName('aerodatabox', new Date('2026-09-22T23:59:59Z'))).toBe(
      'aerodatabox:2026-09-22',
    );
    expect(providerBudgetName('aeroapi', new Date('2026-09-23T00:00:00Z'))).toBe(
      'aeroapi:2026-09-23',
    );
    expect(utcDate(new Date('2026-09-22T20:00:00-05:00'))).toBe('2026-09-23');
  });

  it('parses a name, the eight-way shard suffix, and nothing else', () => {
    expect(parseProviderBudgetName('aerodatabox:2026-09-22')).toEqual({
      provider: 'aerodatabox',
      utcDate: '2026-09-22',
    });
    expect(parseProviderBudgetName('aeroapi:2026-09-22:7')).toEqual({
      provider: 'aeroapi',
      utcDate: '2026-09-22',
      shard: 7,
    });
    for (const bad of [
      'aerodatabox',
      'adsb_lol:2026-09-22',
      'aerodatabox:2026-02-30',
      'aerodatabox:2026-9-22',
      'aerodatabox:2026-09-22:8',
      'aerodatabox:2026-09-22:0:1',
      'ping-ProviderBudget-1234',
    ]) {
      expect(parseProviderBudgetName(bad), bad).toBeNull();
    }
  });

  it('finalises at 00:05 UTC the next day and keys the KV copy by provider and date', () => {
    expect(new Date(finaliseAtMs('2026-09-22')).toISOString()).toBe('2026-09-23T00:05:00.000Z');
    expect(new Date(finaliseAtMs('2026-12-31')).toISOString()).toBe('2027-01-01T00:05:00.000Z');
    expect(budgetKvKey('aerodatabox', '2026-09-22')).toBe('budget:aerodatabox:2026-09-22');
  });
});

describe('defaults per plan', () => {
  it('derive the daily cap from the monthly quota and the rate from the plan', () => {
    expect(budgetDefaults('aerodatabox', providerSettings({ ADB_PLAN: 'starter' }))).toEqual({
      dailyUnitCap: 1_333,
      perSecondLimit: 5,
    });
    expect(budgetDefaults('aerodatabox', providerSettings({ ADB_PLAN: 'growth' }))).toEqual({
      dailyUnitCap: 13_333,
      perSecondLimit: 10,
    });
    expect(budgetDefaults('aerodatabox', providerSettings({ ADB_PLAN: 'scale' }))).toEqual({
      dailyUnitCap: 133_333,
      perSecondLimit: 20,
    });
    expect(budgetDefaults('aeroapi', providerSettings({}))).toEqual({
      dailyUnitCap: 10_000,
      perSecondLimit: 5,
    });
  });

  it('fall back to the cautious side for unset or unknown settings', () => {
    expect(providerSettings({})).toEqual({
      aeroapiMode: 'mock',
      adbPlan: ADB_PLANS.starter,
      adbAlertsEnabled: false,
    });
    expect(
      providerSettings({ AEROAPI_MODE: 'LIVE ', ADB_PLAN: 'Growth', ADB_ALERTS_ENABLED: 'true' }),
    ).toEqual({
      aeroapiMode: 'live',
      adbPlan: ADB_PLANS.growth,
      adbAlertsEnabled: true,
    });
    expect(
      providerSettings({ AEROAPI_MODE: 'yes', ADB_PLAN: 'mega', ADB_ALERTS_ENABLED: '1' }),
    ).toEqual({
      aeroapiMode: 'mock',
      adbPlan: ADB_PLANS.starter,
      adbAlertsEnabled: false,
    });
    expect(ADB_PLANS.growth).toMatchObject({
      maxDaysAhead: 365,
      fidsWindowHours: 24,
      perSecondLimit: 10,
    });
    expect(ADB_PLANS.starter).toMatchObject({
      maxDaysAhead: 180,
      fidsWindowHours: 12,
      perSecondLimit: 5,
    });
    expect(ADB_PLANS.scale).toMatchObject({
      maxDaysAhead: 365,
      fidsWindowHours: 48,
      perSecondLimit: 20,
    });
  });
});

describe('the per-flight ledger rule (increment 7 applies it in the tracker)', () => {
  it('uses the caps derived in shared: soft at 2x, hard at 4x the expected spend', () => {
    expect(A2_SOFT_CAP_PE).toBe(2 * A2_EXPECTED_PE);
    expect(A2_HARD_CAP_PE).toBe(4 * A2_EXPECTED_PE);
    expect(perFlightLedgerDecision({ spentPe: 0, requestPe: 1 })).toBe('ok');
    expect(perFlightLedgerDecision({ spentPe: A2_SOFT_CAP_PE - 1, requestPe: 1 })).toBe('ok');
    expect(perFlightLedgerDecision({ spentPe: A2_SOFT_CAP_PE, requestPe: 1 })).toBe('soft_cap');
    expect(perFlightLedgerDecision({ spentPe: A2_HARD_CAP_PE - 1, requestPe: 1 })).toBe('soft_cap');
    expect(perFlightLedgerDecision({ spentPe: A2_HARD_CAP_PE, requestPe: 0.1 })).toBe('hard_cap');
    expect(perFlightLedgerDecision({ spentPe: 5, requestPe: 1, softCapPe: 5, hardCapPe: 10 })).toBe(
      'soft_cap',
    );
  });
});

function guard(decision: BudgetDecision, log: string[], name: string): BudgetGuard {
  return {
    reserve: () => {
      log.push(`${name}.reserve`);
      return Promise.resolve(decision);
    },
    release: (_request, unused) => {
      log.push(`${name}.release:${String(unused)}`);
      return Promise.resolve();
    },
    backoff: (_provider, ms) => {
      log.push(`${name}.backoff:${String(ms)}`);
      return Promise.resolve();
    },
  };
}

describe('composeBudgets', () => {
  it('needs every guard to allow, and gives back what the earlier ones granted on a refusal', async () => {
    const log: string[] = [];
    const composed = composeBudgets(
      guard({ allowed: true, granted: 0.1, ladder: 'warn' }, log, 'flight'),
      guard({ allowed: false, reason: 'provider_daily_cap' }, log, 'provider'),
    );
    expect(await composed.reserve(REQUEST)).toEqual({
      allowed: false,
      reason: 'provider_daily_cap',
    });
    expect(log).toEqual(['flight.reserve', 'provider.reserve', 'flight.release:0.1']);
  });

  it('reports the worst rung and fans out release and backoff', async () => {
    const log: string[] = [];
    const composed = composeBudgets(
      guard({ allowed: true, granted: 0.1, ladder: 'warn' }, log, 'a'),
      guard({ allowed: true, granted: 0.1, ladder: 'normal' }, log, 'b'),
    );
    expect(await composed.reserve(REQUEST)).toEqual({
      allowed: true,
      granted: 0.1,
      ladder: 'warn',
    });
    await composed.release?.(REQUEST, 0.1);
    await composed.backoff?.('aerodatabox', 500);
    expect(log.slice(2)).toEqual([
      'a.release:0.1',
      'b.release:0.1',
      'a.backoff:500',
      'b.backoff:500',
    ]);
  });
});

describe('ProviderBudgetGuard (the Worker side)', () => {
  function fakes(copy: BudgetKvCopy | string | null) {
    const calls: string[] = [];
    const stub: ProviderBudgetRpc = {
      reserve: (request) => {
        calls.push(`reserve:${request.operation}`);
        return Promise.resolve({
          allowed: true,
          granted: request.pollEquivalents,
          ladder: 'normal',
        });
      },
      release: () => {
        calls.push('release');
        return Promise.resolve();
      },
      backoff: (ms) => {
        calls.push(`backoff:${String(ms)}`);
        return Promise.resolve();
      },
    };
    const names: string[] = [];
    const kv = {
      get: (key: string) => {
        calls.push(`kv:${key}`);
        if (copy === 'throw') {
          return Promise.reject(new Error('kv down'));
        }
        return Promise.resolve(copy);
      },
    } as unknown as Pick<KVNamespace, 'get'>;
    const budgetGuard = new ProviderBudgetGuard({
      stubFor: (name) => {
        names.push(name);
        return stub;
      },
      kv,
      now: () => new Date('2026-09-22T20:00:00Z'),
    });
    return { budgetGuard, calls, names };
  }

  const BLOCKED: BudgetKvCopy = {
    provider: 'aerodatabox',
    utcDate: '2026-09-22',
    units: 13_334,
    dailyUnitCap: 13_333,
    ladder: 'degraded',
    killSwitch: true,
    blocked: true,
    writtenAtMs: 0,
  };

  it('refuses from the KV copy alone when the provider is blocked: no object request', async () => {
    const { budgetGuard, calls } = fakes(BLOCKED);
    expect(await budgetGuard.reserve(REQUEST)).toEqual({
      allowed: false,
      reason: 'provider_kill_switch',
    });
    expect(calls).toEqual(['kv:budget:aerodatabox:2026-09-22']);
    const capOnly = fakes({ ...BLOCKED, killSwitch: false });
    expect(await capOnly.budgetGuard.reserve(REQUEST)).toEqual({
      allowed: false,
      reason: 'provider_daily_cap',
    });
  });

  it('asks the day object when the copy is missing, unblocked, malformed or unreadable', async () => {
    for (const copy of [
      null,
      { ...BLOCKED, blocked: false, killSwitch: false },
      'garbage',
      'throw',
    ] as const) {
      const { budgetGuard, calls, names } = fakes(copy);
      expect((await budgetGuard.reserve(REQUEST)).allowed).toBe(true);
      expect(calls.at(-1)).toBe('reserve:flight_status');
      expect(names).toEqual(['aerodatabox:2026-09-22']);
    }
  });

  it('lets free providers through without touching KV or an object, and forwards release and backoff', async () => {
    const { budgetGuard, calls } = fakes(null);
    expect(
      await budgetGuard.reserve({
        ...REQUEST,
        provider: 'adsb_lol',
        operation: 'positions',
        pollEquivalents: 0,
      }),
    ).toEqual({
      allowed: true,
      granted: 0,
      ladder: 'normal',
    });
    expect(calls).toEqual([]);
    await budgetGuard.release(REQUEST, 0.1);
    await budgetGuard.release(REQUEST, 0);
    await budgetGuard.backoff('aerodatabox', 750);
    await budgetGuard.backoff('nws', 750);
    expect(calls).toEqual(['release', 'backoff:750']);
  });

  it('a release after midnight refunds the day the reservation was debited on', async () => {
    let clock = new Date('2026-09-22T23:59:59.900Z');
    const names: string[] = [];
    const seen: BudgetRequest[] = [];
    const stub: ProviderBudgetRpc = {
      reserve: (request) => {
        seen.push(request);
        return Promise.resolve({
          allowed: true,
          granted: request.pollEquivalents,
          ladder: 'normal',
        });
      },
      release: (request) => {
        seen.push(request);
        return Promise.resolve();
      },
      backoff: () => Promise.resolve(),
    };
    const guard = new ProviderBudgetGuard({
      stubFor: (name) => {
        names.push(name);
        return stub;
      },
      kv: { get: () => Promise.resolve(null) } as unknown as Pick<KVNamespace, 'get'>,
      now: () => clock,
    });
    // Built the way the adapters build it: the day is named once, from the call's clock.
    const request: BudgetRequest = { ...REQUEST, utcDate: '2026-09-22' };
    await guard.reserve(request);
    clock = new Date('2026-09-23T00:00:00.300Z');
    await guard.release(request, request.pollEquivalents);
    // A push-back slows the NEXT reservations, which land on the new day.
    await guard.backoff('aerodatabox', 500);
    expect(names).toEqual([
      'aerodatabox:2026-09-22',
      'aerodatabox:2026-09-22',
      'aerodatabox:2026-09-23',
    ]);
    expect(seen.map((r) => r.utcDate)).toEqual(['2026-09-22', '2026-09-22']);
    // A request that names no day gets the guard's day, and carries it into the object.
    clock = new Date('2026-09-23T08:00:00Z');
    await guard.reserve(REQUEST);
    expect(seen.at(-1)?.utcDate).toBe('2026-09-23');
  });
});
