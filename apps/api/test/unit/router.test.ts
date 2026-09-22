/**
 * The provider router: AeroDataBox answers every window while `AEROAPI_MODE=mock`, cost
 * attribution names the provider that answered, and zero AeroAPI calls happen before T-48 h in
 * any mode (walked over every cadence and lead time, not asserted at one instant).
 */

import { describe, expect, it } from 'vitest';
import {
  CADENCES,
  DAY_MS,
  MINUTE_MS,
  refreshIntervalFor,
  windowAt,
  type CadenceContext,
  type FlightDataProvider,
  type TrackerPhase,
} from '@planeahead/shared';
import { AeroApiAdapter } from '../../src/providers/aeroapi.mock';
import { AeroDataBoxAdapter } from '../../src/providers/aerodatabox.adapter';
import {
  AEROAPI_EARLIEST_MINUTES_BEFORE_OUT,
  ProviderConfigError,
  aeroApiAlertTargetUrl,
  aeroApiAllowedAt,
  providerFor,
  type RouterDeps,
  type RouterEnv,
} from '../../src/providers/router';
import flightScheduled from '../../src/providers/fixtures/aerodatabox/flight-scheduled.json';
import { fixtureFetch, providerContext } from './helpers/providers';

const MOCK: RouterEnv = {
  AERODATABOX_API_KEY: 'adb',
  AEROAPI_API_KEY: 'aero',
  AEROAPI_MODE: 'mock',
};
const LIVE: RouterEnv = { ...MOCK, AEROAPI_MODE: 'live' };

/** Stand-ins that say who they are, so a count of AeroAPI selections is a count of calls. */
function labelled(id: 'aerodatabox' | 'aeroapi'): FlightDataProvider {
  return {
    id,
    capabilities: {} as FlightDataProvider['capabilities'],
    getFlight: () => Promise.reject(new Error(id)),
  };
}
const DEPS: RouterDeps = { aerodatabox: labelled('aerodatabox'), aeroapi: labelled('aeroapi') };

const OUT = Date.UTC(2026, 8, 30, 12, 0, 0);
const BLOCK = 180;

function contextAt(t: number): CadenceContext {
  const phase: TrackerPhase =
    t < OUT - 40 * MINUTE_MS
      ? 'scheduled'
      : t < OUT
        ? 'boarding'
        : t < OUT + BLOCK * MINUTE_MS
          ? 'en_route'
          : 'arrived';
  const ctx: CadenceContext = {
    now: new Date(t),
    scheduledOut: new Date(OUT),
    scheduledIn: new Date(OUT + BLOCK * MINUTE_MS),
    phase,
  };
  if (t >= OUT) {
    ctx.actualOff = new Date(OUT);
  }
  if (t >= OUT + BLOCK * MINUTE_MS) {
    ctx.actualIn = new Date(OUT + BLOCK * MINUTE_MS);
  }
  return ctx;
}

/** Walks a tracker from creation to the end of its cadence, routing every poll. */
function walk(env: RouterEnv, leadDays: number): { calls: { at: number; provider: string }[] } {
  const calls: { at: number; provider: string }[] = [];
  for (const cadence of CADENCES) {
    let t = OUT - leadDays * DAY_MS;
    const first = windowAt(cadence, contextAt(t));
    if (first !== null) {
      calls.push({
        at: t,
        provider: providerFor(first.source, env, DEPS, {
          scheduledOut: new Date(OUT),
          now: new Date(t),
        }).id,
      });
    }
    for (let i = 0; i < 10_000; i += 1) {
      const decision = refreshIntervalFor(cadence, contextAt(t));
      if (decision === null) {
        break;
      }
      t = decision.nextRefreshAt.getTime();
      const provider = providerFor(decision.source, env, DEPS, {
        scheduledOut: new Date(OUT),
        now: new Date(t),
      });
      calls.push({ at: t, provider: provider.id });
    }
  }
  return { calls };
}

describe('providerFor', () => {
  it('routes every window to AeroDataBox while AEROAPI_MODE=mock', () => {
    for (const lead of [2, 3, 14, 30]) {
      const { calls } = walk(MOCK, lead);
      expect(calls.length).toBeGreaterThan(0);
      expect(new Set(calls.map((c) => c.provider))).toEqual(new Set(['aerodatabox']));
    }
    // Asked for an AeroAPI window without an instant: still AeroDataBox in mock mode.
    expect(providerFor('aeroapi', MOCK, DEPS).id).toBe('aerodatabox');
  });

  it('invariant: zero AeroAPI calls before T-48 h, in every mode, cadence and lead time', () => {
    const edge = OUT - AEROAPI_EARLIEST_MINUTES_BEFORE_OUT * MINUTE_MS;
    for (const env of [MOCK, LIVE]) {
      for (const lead of [2, 3, 9, 14, 30, 60]) {
        const early = walk(env, lead).calls.filter((c) => c.at < edge);
        expect(
          early.filter((c) => c.provider === 'aeroapi'),
          `${String(env.AEROAPI_MODE)} lead ${String(lead)}`,
        ).toEqual([]);
      }
    }
    // In live mode AeroAPI does answer inside 48 h: the invariant is not vacuous.
    const live = walk(LIVE, 30).calls;
    expect(live.some((c) => c.provider === 'aeroapi' && c.at >= edge)).toBe(true);
    expect(live.filter((c) => c.at < edge).length).toBeGreaterThan(0);
  });

  it('refuses an AeroAPI window asked for too early, or without saying when, in live mode', () => {
    const early = { scheduledOut: new Date(OUT), now: new Date(OUT - 49 * 60 * MINUTE_MS) };
    const inside = { scheduledOut: new Date(OUT), now: new Date(OUT - 48 * 60 * MINUTE_MS) };
    expect(aeroApiAllowedAt(early)).toBe(false);
    expect(aeroApiAllowedAt(inside)).toBe(true);
    expect(providerFor('aeroapi', LIVE, DEPS, early).id).toBe('aerodatabox');
    expect(providerFor('aeroapi', LIVE, DEPS, inside).id).toBe('aeroapi');
    expect(() => providerFor('aeroapi', LIVE, DEPS)).toThrow(ProviderConfigError);
  });

  it('builds the real adapters from the environment and refuses a missing key', () => {
    expect(providerFor('aerodatabox', MOCK)).toBeInstanceOf(AeroDataBoxAdapter);
    expect(
      providerFor('aeroapi', LIVE, {}, { scheduledOut: new Date(OUT), now: new Date(OUT) }),
    ).toBeInstanceOf(AeroApiAdapter);
    expect(() => providerFor('aerodatabox', { AEROAPI_MODE: 'mock' })).toThrow(ProviderConfigError);
    expect(() =>
      providerFor(
        'aeroapi',
        { ...LIVE, AEROAPI_API_KEY: '' },
        {},
        { scheduledOut: new Date(OUT), now: new Date(OUT) },
      ),
    ).toThrow(ProviderConfigError);
  });

  it('builds the per-alert target_url from the public URL and the environment token', () => {
    expect(
      aeroApiAlertTargetUrl({
        API_PUBLIC_URL: 'https://api-staging.planeahead.app/',
        WEBHOOK_TOKEN_AEROAPI: 'tok',
      }),
    ).toBe('https://api-staging.planeahead.app/v1/webhooks/aeroapi/tok');
    expect(aeroApiAlertTargetUrl({ API_PUBLIC_URL: 'https://x.test' })).toBeUndefined();
  });

  it('attributes cost to the provider that answered, not to the window it served', async () => {
    const stub = fixtureFetch(flightScheduled);
    const provider = providerFor('aeroapi', MOCK, { fetch: stub.fetch });
    const { ctx } = providerContext();
    const { call } = await provider.getFlight(
      { carrier: { iata: 'AA' }, flightNumber: '100', dateLocal: '2026-09-29' },
      ctx,
    );
    expect(call.provider).toBe('aerodatabox');
    expect(call.operation).toBe('flight_status');
    expect(stub.urls()[0]?.hostname).toBe('api.aerodatabox.com');
  });
});
