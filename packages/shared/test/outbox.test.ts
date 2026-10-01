import { describe, expect, it } from 'vitest';
import type { FlightKey } from '../src/flight-key';
import {
  DEAD_LETTER_RESEND_MAX_MS,
  DEAD_LETTER_RESEND_MS,
  FLIGHT_TRACKING_STATES,
  FlightEventOutboxPayloadV1,
  FlightInstanceOutboxPayloadV1,
  OUTBOX_KINDS,
  OUTBOX_SCHEMA_VERSION,
  PersistMessageV1,
  ReconcileMessageV1,
  deadLetterResendSpacingMs,
  designatorResolverOrigin,
  flightTrackerOrigin,
  parseFlightTrackerOrigin,
  type PersistMessageV1Input,
} from '../src/outbox';
import { AA100_INPUT } from './fixtures';

const KEY = 'AAL-100-2026-09-19-KJFK' as FlightKey;
const ORIGIN = flightTrackerOrigin(KEY, 1_758_000_000_000);

const INSTANCE: PersistMessageV1Input = {
  kind: 'flight_instance',
  seq: 7,
  origin: ORIGIN,
  flightKey: KEY,
  payload: {
    operatingCarrierIcao: 'AAL',
    flightNumber: '100',
    scheduledDepartureDate: '2026-09-19',
    originIcao: 'KJFK',
    legSeq: 1,
    version: 3,
    phase: 'scheduled',
    trackingState: 'tracking',
    refreshCadence: 'A2',
    nextRefreshAt: '2026-09-19T13:00:00Z',
    lastRefreshedAt: '2026-09-19T12:00:00Z',
    doSchemaVersion: 1,
    snapshot: AA100_INPUT,
    providerCallCount: 2,
    providerCostUnits: 4,
    subscriberCount: 1,
    operatorSource: 'provider',
    finishedAt: null,
    eventsR2Key: null,
  },
};

describe('outbox origins', () => {
  it('names a tracker lifetime and parses it back', () => {
    expect(ORIGIN).toBe('flight_tracker:AAL-100-2026-09-19-KJFK@1758000000000');
    expect(parseFlightTrackerOrigin(ORIGIN)).toEqual({
      flightKey: KEY,
      epochMs: 1_758_000_000_000,
    });
  });

  it('does not parse another sender, a malformed key or a missing epoch', () => {
    expect(parseFlightTrackerOrigin(designatorResolverOrigin('AA100-2026-09-19', 5))).toBeNull();
    expect(parseFlightTrackerOrigin('provider_budget:aerodatabox:2026-09-22@5')).toBeNull();
    expect(parseFlightTrackerOrigin('flight_tracker:AA100@5')).toBeNull();
    expect(parseFlightTrackerOrigin(`flight_tracker:${KEY}`)).toBeNull();
    expect(designatorResolverOrigin('AA100-2026-09-19', 5)).toBe(
      'designator_resolver:AA100-2026-09-19@5',
    );
  });
});

describe('PersistMessageV1', () => {
  it('is at outbox schema version 1 and names six kinds', () => {
    expect(OUTBOX_SCHEMA_VERSION).toBe(1);
    expect(OUTBOX_KINDS).toEqual([
      'flight_instance',
      'flight_event',
      'provider_call',
      'provider_budget_kill_switch',
      'provider_budget_daily',
      'notify_intent',
    ]);
    expect(FLIGHT_TRACKING_STATES).toEqual([
      'pending',
      'tracking',
      'airborne',
      'landed',
      'finished',
      'archived',
      'superseded',
    ]);
  });

  it('parses a flight_instance message and defaults outboxVersion', () => {
    const parsed = PersistMessageV1.parse(INSTANCE);
    expect(parsed.kind).toBe('flight_instance');
    expect(parsed.outboxVersion).toBe(1);
    if (parsed.kind === 'flight_instance') {
      expect(parsed.payload.version).toBe(3);
      expect(parsed.payload.snapshot?.operatingCarrierIcao).toBe('AAL');
    }
  });

  it('keeps unknown fields at every level and rejects a bad version or key', () => {
    const parsed = PersistMessageV1.parse({
      ...INSTANCE,
      future: true,
      payload: { ...INSTANCE.payload, futureColumn: 'x' },
    });
    expect(parsed).toHaveProperty('future', true);
    expect(parsed.payload).toHaveProperty('futureColumn', 'x');
    expect(
      PersistMessageV1.safeParse({ ...INSTANCE, payload: { ...INSTANCE.payload, version: -1 } })
        .success,
    ).toBe(false);
    expect(PersistMessageV1.safeParse({ ...INSTANCE, flightKey: 'AA100' }).success).toBe(false);
    expect(
      FlightInstanceOutboxPayloadV1.safeParse({ ...INSTANCE.payload, trackingState: 'active' })
        .success,
    ).toBe(false);
  });

  it('parses a flight_event message with the outbox seq as the event seq', () => {
    const parsed = PersistMessageV1.parse({
      kind: 'flight_event',
      seq: 8,
      origin: ORIGIN,
      flightKey: KEY,
      payload: {
        occurredAt: '2026-09-19T12:00:00Z',
        type: 'status_changed',
        oldValue: 'scheduled',
        newValue: 'boarding',
        source: 'aerodatabox',
      },
    });
    expect(parsed.seq).toBe(8);
    if (parsed.kind === 'flight_event') {
      expect(parsed.payload.field).toBeNull();
      expect(parsed.payload.providerCallId).toBeNull();
    }
    expect(
      FlightEventOutboxPayloadV1.safeParse({
        occurredAt: 'yesterday',
        type: 'x',
        source: 'system',
      }).success,
    ).toBe(false);
  });

  it('parses a provider_call message with or without a flight key', () => {
    const call = {
      id: '019968a7-4e00-7000-8000-000000000000',
      provider: 'aerodatabox',
      operation: 'flight_status',
      trigger: 'user_search',
      requestId: 'req-1',
      startedAt: '2026-09-19T12:00:00Z',
      latencyMs: 210,
      result: 'not_found',
      costUnits: 2,
      pollEquivalents: 0.1,
      estCostUsdMicros: 500,
    };
    const without = PersistMessageV1.parse({
      kind: 'provider_call',
      seq: 1,
      origin: designatorResolverOrigin('AA100-2026-09-19', 1),
      payload: call,
    });
    expect(without.kind).toBe('provider_call');
    const withKey = PersistMessageV1.parse({
      kind: 'provider_call',
      seq: 9,
      origin: ORIGIN,
      flightKey: KEY,
      payload: { ...call, trigger: 'alarm', flightKey: KEY },
    });
    if (withKey.kind === 'provider_call') {
      expect(withKey.flightKey).toBe(KEY);
    }
  });

  it('parses the two ProviderBudget kinds as increment 6 built them', () => {
    const kill = PersistMessageV1.parse({
      kind: 'provider_budget_kill_switch',
      seq: 1,
      origin: 'provider_budget:aerodatabox:2026-09-22@1758000000000',
      payload: {
        provider: 'aerodatabox',
        utcDate: '2026-09-22',
        reason: 'daily_cap',
        atMs: 1_758_000_000_000,
        spentUnits: 13_333,
        dailyUnitCap: 13_333,
      },
    });
    expect(kill.kind).toBe('provider_budget_kill_switch');
    expect(kill.payload).toHaveProperty('spentUnits', 13_333);
    const daily = PersistMessageV1.parse({
      kind: 'provider_budget_daily',
      seq: 2,
      origin: 'provider_budget:aerodatabox:2026-09-22@1758000000000',
      payload: {
        provider: 'aerodatabox',
        utcDate: '2026-09-22',
        shard: null,
        units: 4,
        pollEquivalents: 0.2,
        calls: 2,
        releasedUnits: 0,
        byTrigger: { alarm: { units: 2, pe: 0.1, calls: 1 } },
        denials: {},
        dailyUnitCap: 13_333,
        finalised: false,
      },
    });
    if (daily.kind === 'provider_budget_daily') {
      expect(daily.payload.byTrigger['alarm']?.calls).toBe(1);
    }
  });

  it('refuses a kind this build does not know rather than half-applying it', () => {
    expect(
      PersistMessageV1.safeParse({ kind: 'flight_upsert', seq: 1, origin: ORIGIN, payload: {} })
        .success,
    ).toBe(false);
    expect(PersistMessageV1.safeParse({ seq: 1, origin: ORIGIN }).success).toBe(false);
  });
});

describe('deadLetterResendSpacingMs', () => {
  it('doubles from an hour per dead-lettering and caps at a day', () => {
    expect(DEAD_LETTER_RESEND_MS).toBe(3_600_000);
    expect(DEAD_LETTER_RESEND_MAX_MS).toBe(24 * 3_600_000);
    expect([1, 2, 3, 4, 5].map(deadLetterResendSpacingMs)).toEqual(
      [1, 2, 4, 8, 16].map((hours) => hours * 3_600_000),
    );
    expect(deadLetterResendSpacingMs(6)).toBe(DEAD_LETTER_RESEND_MAX_MS);
    // A row dead-lettered daily for years never wraps to zero: 2 ** 1024 is Infinity, which
    // the cap still bounds.
    expect(deadLetterResendSpacingMs(2_000)).toBe(DEAD_LETTER_RESEND_MAX_MS);
    expect(deadLetterResendSpacingMs(0)).toBe(DEAD_LETTER_RESEND_MS);
  });
});

describe('ReconcileMessageV1', () => {
  it('carries one flight key and defaults the rest', () => {
    const parsed = ReconcileMessageV1.parse({ kind: 'reconcile_flight', flightKey: KEY });
    expect(parsed).toEqual({
      outboxVersion: 1,
      kind: 'reconcile_flight',
      flightKey: KEY,
      nextRefreshAt: null,
    });
    expect(
      ReconcileMessageV1.safeParse({ kind: 'reconcile_flight', flightKey: 'nope' }).success,
    ).toBe(false);
  });
});
