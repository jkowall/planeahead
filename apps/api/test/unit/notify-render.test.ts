/**
 * The push text of every intent kind (increment 15, ruling N9): plain, self-contained (the
 * designator, the route, the current times and the gate), a correction saying what changed back,
 * airport-local times in the user's format, and never past the shared length bounds.
 */

import { describe, expect, it } from 'vitest';
import {
  PUSH_BODY_MAX_LENGTH,
  PUSH_TITLE_MAX_LENGTH,
  type FlightKey,
  type NotifyIntentV1,
} from '@planeahead/shared';
import { clip, duration, localTime, renderPush } from '../../src/notify/render';

type IntentFields = NotifyIntentV1['intent'];
type Flight = NotifyIntentV1['flight'];

const BASE_TIMES = {
  scheduledOut: '2026-10-03T19:00:00.000Z',
  scheduledIn: '2026-10-04T01:10:00.000Z',
};

/** AA100, JFK 15:00 EDT to LAX 18:10 PDT on 2026-10-03, origin Terminal 8 gate B12. */
function intentOf(fields: Partial<IntentFields>, flight: Partial<Flight> = {}): NotifyIntentV1 {
  return {
    notifyVersion: 1,
    kind: 'notify_intent',
    flightKey: 'AAL-100-2026-10-03-KJFK' as FlightKey,
    dedupeKey: 'key',
    intent: {
      kind: 'delay',
      subject: 'departure',
      value: '45',
      previousValue: null,
      correction: false,
      firstAssignment: false,
      timeSensitive: false,
      expiresAt: '2026-10-04T01:10:00.000Z',
      dedupeValue: 'departure:45',
      ...fields,
    },
    flight: {
      operatingCarrierIcao: 'AAL',
      flightNumber: '100',
      origin: { icao: 'KJFK', iata: 'JFK', tz: 'America/New_York' },
      destination: { icao: 'KLAX', iata: 'LAX', tz: 'America/Los_Angeles' },
      status: 'scheduled',
      times: {
        scheduledOut: '2026-10-03T19:00:00.000Z',
        estimatedOut: '2026-10-03T19:45:00.000Z',
        scheduledIn: '2026-10-04T01:10:00.000Z',
        estimatedIn: '2026-10-04T01:50:00.000Z',
      },
      originTerminal: '8',
      originGate: 'B12',
      destinationGate: 'C3',
      ...flight,
    },
    producedAt: '2026-10-03T18:00:00.000Z',
    test: false,
  };
}

describe('renderPush', () => {
  it('a departure delay: the new time, the lateness, the gate and the arrival', () => {
    expect(renderPush(intentOf({}))).toEqual({
      title: 'AA100 delayed 45 min',
      body: 'Departs 3:45 PM from JFK, 45 min late (scheduled 3:00 PM). Terminal 8, gate B12. Arrives 6:50 PM at LAX.',
    });
  });

  it('a delay that moved says what was reported before, in the 24 hour clock', () => {
    const moved = intentOf(
      { value: '75', previousValue: '45' },
      { times: { ...BASE_TIMES, estimatedOut: '2026-10-03T20:15:00.000Z' } },
    );
    expect(renderPush(moved, '24h')).toEqual({
      title: 'AA100 delayed 1 h 15 min',
      body: 'Departs 16:15 from JFK, 1 h 15 min late (scheduled 15:00). Earlier reported 45 min late. Terminal 8, gate B12. Arrives 18:10 at LAX.',
    });
  });

  // Review ruling Q15: a correction's title states the new value (was "no longer delayed").
  it('a delay correction states the new delay, or on time at or before scheduled', () => {
    const corrected = intentOf(
      { value: '5', previousValue: '45', correction: true },
      { times: { ...BASE_TIMES, estimatedOut: '2026-10-03T19:05:00.000Z' } },
    );
    const onTime = intentOf(
      { value: '0', previousValue: '45', correction: true },
      { times: { ...BASE_TIMES, estimatedOut: '2026-10-03T19:00:00.000Z' } },
    );
    expect(renderPush(onTime).title).toBe('AA100 now on time');
    expect(renderPush(intentOf({ value: '-3', correction: true })).title).toBe('AA100 now on time');
    expect(renderPush(corrected)).toEqual({
      title: 'AA100 delay now 5 min',
      body: 'Departs 3:05 PM from JFK, 5 min late (scheduled 3:00 PM). Earlier reported 45 min late. Terminal 8, gate B12. Arrives 6:10 PM at LAX.',
    });
  });

  it('an arrival delay and its correction', () => {
    expect(renderPush(intentOf({ subject: 'arrival', value: '40' }))).toEqual({
      title: 'AA100 arriving 40 min late',
      body: 'Arrives 6:50 PM at LAX, 40 min late (scheduled 6:10 PM). Departs 3:45 PM from JFK, Terminal 8, gate B12.',
    });
    // Review ruling Q15: the arrival correction states the new value too.
    const back = intentOf({ subject: 'arrival', value: '10', correction: true });
    expect(renderPush(back).title).toBe('AA100 arrival delay now 10 min');
    expect(renderPush(back).body).toMatch(/^Arrives 6:50 PM at LAX, 10 min late/);
    const early = intentOf({ subject: 'arrival', value: '0', correction: true });
    expect(renderPush(early).title).toBe('AA100 now arriving on time');
  });

  // Review ruling Q18: an arrival intent produced on the observation that saw in.
  it('an arrival intent on landing says it arrived', () => {
    const times = { ...BASE_TIMES, actualOut: '2026-10-03T19:40:00.000Z' };
    const landed = intentOf(
      { subject: 'arrival', value: '31' },
      { status: 'arrived', times: { ...times, actualIn: '2026-10-04T01:41:00.000Z' } },
    );
    expect(renderPush(landed)).toEqual({
      title: 'AA100 arrived 31 min late',
      body: 'Arrived 6:41 PM at LAX, 31 min late (scheduled 6:10 PM). Departed 3:40 PM from JFK, Terminal 8, gate B12.',
    });
    const onTime = intentOf(
      { subject: 'arrival', value: '0', correction: true },
      { status: 'arrived', times: { ...times, actualIn: '2026-10-04T01:10:00.000Z' } },
    );
    expect(renderPush(onTime).title).toBe('AA100 arrived on time');
  });
});

describe('renderPush: gates', () => {
  it('a departure gate change, a first assignment and a reverted flap', () => {
    const changed = intentOf({
      kind: 'gate_change',
      subject: 'origin',
      value: 'B12',
      previousValue: 'A4',
    });
    expect(renderPush(changed)).toEqual({
      title: 'AA100 gate change to B12',
      body: 'Departure gate changed from A4 to B12 at JFK, Terminal 8. Departs 3:45 PM from JFK. Arrives 6:50 PM at LAX.',
    });
    const first = intentOf({
      kind: 'gate_change',
      subject: 'origin',
      value: 'B12',
      previousValue: null,
      firstAssignment: true,
    });
    expect(renderPush(first)).toEqual({
      title: 'AA100 departs from gate B12',
      body: 'Departure gate B12 at JFK, Terminal 8. Departs 3:45 PM from JFK. Arrives 6:50 PM at LAX.',
    });
    const back = intentOf({
      kind: 'gate_change',
      subject: 'origin',
      value: 'A4',
      previousValue: 'B12',
      correction: true,
    });
    expect(renderPush(back)).toEqual({
      title: 'AA100 gate back to A4',
      body: 'Departure gate changed back to A4 at JFK, Terminal 8, earlier reported as B12. Departs 3:45 PM from JFK. Arrives 6:50 PM at LAX.',
    });
  });

  it('an arrival gate change names the arrival and the baggage claim', () => {
    const arrival = intentOf(
      { kind: 'gate_change', subject: 'destination', value: 'C3', previousValue: 'C1' },
      { baggageClaim: '5' },
    );
    expect(renderPush(arrival)).toEqual({
      title: 'AA100 arrival gate change to C3',
      body: 'Arrival gate changed from C1 to C3 at LAX. Arrives 6:50 PM at LAX. Baggage claim 5.',
    });
  });
});

describe('renderPush: cancellation and diversion', () => {
  it('a cancellation names the scheduled departure; its correction says the flight operates', () => {
    const cancelled = intentOf(
      { kind: 'cancellation', subject: 'flight', value: 'cancelled' },
      { status: 'cancelled' },
    );
    expect(renderPush(cancelled)).toEqual({
      title: 'AA100 cancelled',
      body: 'AA100 from JFK to LAX, scheduled to depart Oct 3 at 3:00 PM, is cancelled.',
    });
    const back = intentOf({
      kind: 'cancellation',
      subject: 'flight',
      value: 'uncancelled',
      previousValue: 'cancelled',
      correction: true,
    });
    expect(renderPush(back)).toEqual({
      title: 'AA100 no longer cancelled',
      body: 'AA100 from JFK to LAX is operating again, earlier reported cancelled. Departs 3:45 PM from JFK, Terminal 8, gate B12. Arrives 6:50 PM at LAX.',
    });
  });

  it('a diversion names the airport, or says only diverted when the provider names none', () => {
    const diverted = intentOf(
      { kind: 'diversion', subject: 'flight', value: 'KSFO', previousValue: 'KLAX' },
      {
        status: 'diverted',
        actualDestination: { icao: 'KSFO', iata: 'SFO', tz: 'America/Los_Angeles' },
        times: { ...BASE_TIMES, actualOut: '2026-10-03T19:50:00.000Z' },
      },
    );
    expect(renderPush(diverted)).toEqual({
      title: 'AA100 diverted to SFO',
      body: 'AA100 from JFK, planned to arrive at LAX, is diverting to SFO. Departed 3:50 PM from JFK.',
    });
    const unnamed = intentOf({ kind: 'diversion', subject: 'flight', value: 'diverted' });
    expect(renderPush(unnamed).title).toBe('AA100 diverted');
  });

  // Review ruling Q18: without an actual out a diversion never says "Departs" (it has left).
  it('a diversion without an actual out names the scheduled departure', () => {
    const noOut = intentOf(
      { kind: 'diversion', subject: 'flight', value: 'KSFO', previousValue: 'KLAX' },
      { status: 'diverted', actualDestination: { icao: 'KSFO', iata: 'SFO' } },
    );
    expect(renderPush(noOut).body).toBe(
      'AA100 from JFK, planned to arrive at LAX, is diverting to SFO. Scheduled to depart 3:00 PM from JFK.',
    );
  });

  // Review ruling Q14: a confirmed un-diversion is a correction.
  it('an un-diversion says the flight is expected at its destination again', () => {
    const back = intentOf({
      kind: 'diversion',
      subject: 'flight',
      value: 'undiverted',
      previousValue: 'KSFO',
      correction: true,
    });
    expect(renderPush(back)).toEqual({
      title: 'AA100 no longer diverted',
      body: 'AA100 from JFK is expected at LAX again, earlier reported diverted. Arrives 6:50 PM at LAX, gate C3.',
    });
  });
});

describe('renderPush: bounds and fallbacks', () => {
  it('stays within the shared bounds whatever the provider sent', () => {
    const long = 'G'.repeat(500);
    const rendered = renderPush(
      intentOf(
        { kind: 'gate_change', subject: 'origin', value: long, previousValue: long },
        { originTerminal: long },
      ),
    );
    expect(rendered.title.length).toBeLessThanOrEqual(PUSH_TITLE_MAX_LENGTH);
    expect(rendered.body.length).toBeLessThanOrEqual(PUSH_BODY_MAX_LENGTH);
    expect(rendered.body.endsWith('\u2026')).toBe(true);
  });

  it('marks UTC when the airport zone is unknown, and keeps an unknown carrier as ICAO', () => {
    expect(localTime('2026-10-03T19:05:00.000Z', undefined, '24h')).toBe('19:05 UTC');
    expect(localTime('2026-10-03T19:05:00.000Z', 'Not/AZone', '12h')).toBe('7:05 PM UTC');
    const unknown = intentOf({}, { operatingCarrierIcao: 'QQQ' });
    expect(renderPush(unknown).title).toBe('QQQ100 delayed 45 min');
    expect(duration(120)).toBe('2 h');
    expect(clip('abcdef', 4)).toBe('abc\u2026');
  });
});
