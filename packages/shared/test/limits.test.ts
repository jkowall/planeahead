import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  CAP_NAMES,
  FREE_TIER_LIMITS,
  LIVE_TRACKING_LEAD_MS,
  SYNC_PAGE_SIZE,
  SubscribeFlightBodySchema,
  freeTierLimit,
  isApiError,
  isInLiveWindow,
} from '../src/index';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-23T12:00:00Z');

describe('free-tier limits (ruling K3)', () => {
  it('are the numbers the plan and the rulings fix', () => {
    expect(FREE_TIER_LIMITS).toEqual({
      activeSubscriptions: 5,
      liveTracked: 2,
      instancesCreatedPerDay: 20,
      anonymousTrackerCreationsPerDayPerIp: 10,
      refreshesPerFlightPerDay: 10,
      routeSearchesPerDay: 30,
      anonymousRouteSearchesPerDayPerIp: 30,
    });
    expect(SYNC_PAGE_SIZE).toBe(200);
    expect(Object.isFrozen(FREE_TIER_LIMITS)).toBe(true);
  });

  it('maps every cap name to its limit', () => {
    expect(CAP_NAMES.map((cap) => [cap, freeTierLimit(cap)])).toEqual([
      ['active_subscriptions', 5],
      ['live_tracked', 2],
      ['instances_created', 20],
      ['tracker_creations', 10],
      ['refresh', 10],
      ['route_searches', 30],
    ]);
  });
});

describe('isInLiveWindow', () => {
  const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

  it('is live from 48 h before departure until the flight is over', () => {
    expect(
      isInLiveWindow({ phase: 'scheduled', scheduledOut: at(LIVE_TRACKING_LEAD_MS) }, NOW),
    ).toBe(true);
    expect(isInLiveWindow({ phase: 'scheduled', scheduledOut: at(49 * HOUR) }, NOW)).toBe(false);
    expect(isInLiveWindow({ phase: 'en_route', scheduledOut: at(-2 * HOUR) }, NOW)).toBe(true);
    for (const phase of ['arrived', 'cancelled', 'finished']) {
      expect(isInLiveWindow({ phase, scheduledOut: at(HOUR) }, NOW), phase).toBe(false);
    }
  });

  it('treats an unknown departure as live, the conservative side of a cap', () => {
    expect(isInLiveWindow({ phase: 'scheduled' }, NOW)).toBe(true);
    expect(isInLiveWindow({ phase: 'scheduled', scheduledOut: 'garbage' }, NOW)).toBe(true);
  });
});

describe('the error envelope', () => {
  it('lists the increment 8 codes the mobile client branches on', () => {
    for (const code of [
      'account_deleted',
      'cap_exceeded',
      'idempotency_payload_mismatch',
      'in_flight',
      'resync_required',
      'refresh_timeout',
      'validation_failed',
    ]) {
      expect(API_ERROR_CODES, code).toContain(code);
    }
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });

  it('isApiError reads a body by its code', () => {
    const body = { error: 'cap_exceeded', cap: 'active_subscriptions', limit: 5, requestId: 'r' };
    expect(isApiError(body, 'cap_exceeded')).toBe(true);
    expect(isApiError(body, 'account_deleted')).toBe(false);
    expect(isApiError({ nope: true }, 'cap_exceeded')).toBe(false);
  });
});

describe('SubscribeFlightBodySchema', () => {
  it('accepts a key, or a number with a date, and nothing in between', () => {
    expect(
      SubscribeFlightBodySchema.safeParse({ flightKey: 'AAL-100-2026-09-19-KJFK' }).success,
    ).toBe(true);
    expect(
      SubscribeFlightBodySchema.safeParse({ number: 'AA 100', date: '2026-09-19', origin: 'jfk' })
        .success,
    ).toBe(true);
    expect(SubscribeFlightBodySchema.safeParse({}).success).toBe(false);
    expect(SubscribeFlightBodySchema.safeParse({ number: 'AA100' }).success).toBe(false);
    expect(
      SubscribeFlightBodySchema.safeParse({
        flightKey: 'AAL-100-2026-09-19-KJFK',
        number: 'AA100',
        date: '2026-09-19',
      }).success,
    ).toBe(false);
    expect(
      SubscribeFlightBodySchema.safeParse({ number: 'banana', date: '2026-09-19' }).success,
    ).toBe(false);
    expect(
      SubscribeFlightBodySchema.safeParse({ flightKey: 'AAL-100-2026-09-19-KJFK', extra: 1 })
        .success,
    ).toBe(false);
  });
});
