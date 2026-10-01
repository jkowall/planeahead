import { describe, expect, it } from 'vitest';
import type { FlightKey } from '../src/flight-key';
import {
  ANDROID_CHANNEL_BY_KIND,
  ANDROID_CHANNEL_IDS,
  NOTIFY_SCHEMA_VERSION,
  NotifyIntentV1,
  androidChannelFor,
  type NotifyIntentV1Input,
} from '../src/notify';
import { ANDROID_CHANNEL_ID_RE, NOTIFICATION_KINDS } from '../src/push';
import { PersistMessageV1 } from '../src/outbox';

const KEY = 'AAL-100-2026-09-19-KJFK' as FlightKey;

function intent(overrides: Partial<NotifyIntentV1Input> = {}): NotifyIntentV1Input {
  return {
    kind: 'notify_intent',
    flightKey: KEY,
    dedupeKey: `${KEY}:delay:departure:45:v12`,
    intent: {
      kind: 'delay',
      subject: 'departure',
      value: '45',
      previousValue: '0',
      correction: false,
      firstAssignment: false,
      timeSensitive: true,
      expiresAt: '2026-09-19T21:00:00.000Z',
      dedupeValue: 'departure:45',
    },
    flight: {
      operatingCarrierIcao: 'AAL',
      flightNumber: '100',
      origin: { icao: 'KJFK', iata: 'JFK' },
      destination: { icao: 'EGLL', iata: 'LHR' },
      status: 'scheduled',
      times: { scheduledOut: '2026-09-19T15:00:00Z', estimatedOut: '2026-09-19T15:45:00Z' },
      originGate: 'B12',
    },
    producedAt: '2026-09-19T14:10:00.000Z',
    ...overrides,
  };
}

describe('NotifyIntentV1 (increment 15, ruling N7)', () => {
  it('fills the version and the test flag, and keeps fields it does not know', () => {
    const parsed = NotifyIntentV1.parse({ ...intent(), addedLater: 1 });
    expect(parsed.notifyVersion).toBe(NOTIFY_SCHEMA_VERSION);
    expect(parsed.test).toBe(false);
    expect((parsed as Record<string, unknown>)['addedLater']).toBe(1);
  });

  it('carries a test intent with its injection id', () => {
    const parsed = NotifyIntentV1.parse(intent({ test: true, injectionId: 'inj-1' }));
    expect(parsed).toMatchObject({ test: true, injectionId: 'inj-1' });
  });

  it('refuses an intent without a dedupe key, a kind it cannot name, or a bad subject', () => {
    expect(NotifyIntentV1.safeParse(intent({ dedupeKey: '' })).success).toBe(false);
    const kind = {
      ...intent().intent,
      kind: 'teleport',
    } as unknown as NotifyIntentV1Input['intent'];
    expect(NotifyIntentV1.safeParse(intent({ intent: kind })).success).toBe(false);
    const subject = {
      ...intent().intent,
      subject: 'gate',
    } as unknown as NotifyIntentV1Input['intent'];
    expect(NotifyIntentV1.safeParse(intent({ intent: subject })).success).toBe(false);
  });

  it('travels to persist as the notify_intent outbox kind', () => {
    const message = PersistMessageV1.parse({
      kind: 'notify_intent',
      flightKey: KEY,
      payload: intent(),
      seq: 7,
      origin: `flight_tracker:${KEY}@5`,
    });
    expect(message.kind).toBe('notify_intent');
    expect(message.kind === 'notify_intent' && message.payload.intent.value).toBe('45');
  });
});

describe('Android channels (increment 15)', () => {
  it('has two permanent ids the push contract accepts', () => {
    expect(ANDROID_CHANNEL_IDS).toEqual({
      flightChanges: 'flight_changes',
      flightDelays: 'flight_delays',
    });
    for (const id of Object.values(ANDROID_CHANNEL_IDS)) {
      expect(id).toMatch(ANDROID_CHANNEL_ID_RE);
    }
  });

  it('posts delays to flight_delays and every other kind to flight_changes', () => {
    expect(androidChannelFor('delay')).toBe('flight_delays');
    for (const kind of ['gate_change', 'cancellation', 'diversion'] as const) {
      expect(androidChannelFor(kind)).toBe('flight_changes');
    }
    expect(Object.keys(ANDROID_CHANNEL_BY_KIND).sort()).toEqual([...NOTIFICATION_KINDS].sort());
    const delays = NOTIFICATION_KINDS.filter((kind) => androidChannelFor(kind) === 'flight_delays');
    expect(delays).toEqual(['delay']);
  });
});
