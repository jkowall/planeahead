import { describe, expect, it } from 'vitest';
import { FLIGHT_STATUS_VALUES, type FlightStatusValue } from '../src/flight-status';
import {
  ADB_STATUSES,
  AdbStatusSchema,
  adbFlags,
  adbStatusUncertain,
  deriveStatus,
  disambiguateRevisedTime,
  isActualAt,
  type AdbStatus,
  type DeriveStatusInput,
} from '../src/status-derivation';

const OUT = '2026-09-20T03:50:00Z';
const OUT_MS = Date.parse(OUT);

function minutesFromOut(minutes: number): Date {
  return new Date(OUT_MS + minutes * 60_000);
}

/** A flight that has done nothing yet, observed a day before departure. */
const BASE: DeriveStatusInput = {
  cancelled: false,
  diverted: false,
  scheduledOut: OUT,
  now: minutesFromOut(-1_440),
};

describe('deriveStatus', () => {
  it.each<[string, Partial<DeriveStatusInput>, FlightStatusValue]>([
    ['nothing yet, a day out', {}, 'scheduled'],
    ['41 minutes before scheduled out', { now: minutesFromOut(-41) }, 'scheduled'],
    ['exactly at the boarding anchor (T-40)', { now: minutesFromOut(-40) }, 'boarding'],
    ['past scheduled out with no actuals (a gate hold)', { now: minutesFromOut(30) }, 'boarding'],
    [
      'a delayed flight: boarding follows the estimate, not the schedule',
      { now: minutesFromOut(-10), estimatedOut: minutesFromOut(60).toISOString() },
      'scheduled',
    ],
    [
      'a delayed flight inside its new boarding window',
      { now: minutesFromOut(25), estimatedOut: minutesFromOut(60).toISOString() },
      'boarding',
    ],
    [
      'a custom boarding anchor',
      { now: minutesFromOut(-50), boardingMinutesBefore: 60 },
      'boarding',
    ],
    ['pushed back (out)', { actualOut: minutesFromOut(2) }, 'departed'],
    ['airborne (off)', { actualOut: minutesFromOut(2), actualOff: minutesFromOut(15) }, 'en_route'],
    ['off without out (runway time only)', { actualOff: minutesFromOut(15) }, 'en_route'],
    [
      'touched down (on)',
      { actualOff: minutesFromOut(15), actualOn: minutesFromOut(170) },
      'landed',
    ],
    [
      'at the gate (in)',
      {
        actualOff: minutesFromOut(15),
        actualOn: minutesFromOut(170),
        actualIn: minutesFromOut(178),
      },
      'arrived',
    ],
    ['in alone', { actualIn: minutesFromOut(178) }, 'arrived'],
    ['cancelled before departure', { cancelled: true }, 'cancelled'],
    [
      'cancelled wins over a stale actual',
      { cancelled: true, actualOut: minutesFromOut(2) },
      'cancelled',
    ],
    ['diverted', { diverted: true, actualOff: minutesFromOut(15) }, 'diverted'],
    [
      'diverted and landed at the alternate',
      { diverted: true, actualIn: minutesFromOut(200) },
      'diverted',
    ],
    ['cancelled wins over diverted', { cancelled: true, diverted: true }, 'cancelled'],
    ['no departure time at all', { scheduledOut: undefined }, 'unknown'],
    ['an unparseable schedule', { scheduledOut: 'not-a-time' }, 'unknown'],
    [
      'an unparseable actual counts as absent',
      { actualOff: 'garbage', now: minutesFromOut(-500) },
      'scheduled',
    ],
    [
      'Date inputs work as well as strings',
      { scheduledOut: new Date(OUT_MS), actualOut: new Date(OUT_MS) },
      'departed',
    ],
  ])('%s', (_label, overrides, expected) => {
    expect(deriveStatus({ ...BASE, ...overrides })).toBe(expected);
  });

  it('only ever returns a value of the nine-value vocabulary', () => {
    const seen = new Set<FlightStatusValue>();
    for (const cancelled of [false, true]) {
      for (const diverted of [false, true]) {
        for (const now of [-2_000, -40, 0, 300]) {
          seen.add(
            deriveStatus({ cancelled, diverted, scheduledOut: OUT, now: minutesFromOut(now) }),
          );
        }
      }
    }
    for (const value of seen) {
      expect(FLIGHT_STATUS_VALUES).toContain(value);
    }
  });
});

describe('AeroDataBox status enum', () => {
  it('lists the 13 values of the vendored spec, in order', () => {
    expect(ADB_STATUSES).toEqual([
      'Unknown',
      'Expected',
      'EnRoute',
      'CheckIn',
      'Boarding',
      'GateClosed',
      'Departed',
      'Delayed',
      'Approaching',
      'Arrived',
      'Canceled',
      'Diverted',
      'CanceledUncertain',
    ]);
  });

  it('parses a status AeroDataBox adds later as Unknown and rejects a non-string', () => {
    expect(AdbStatusSchema.parse('Taxiing')).toBe('Unknown');
    expect(AdbStatusSchema.parse('Arrived')).toBe('Arrived');
    expect(AdbStatusSchema.safeParse(9).success).toBe(false);
  });

  it.each<[AdbStatus, boolean, boolean]>([
    ['Unknown', false, false],
    ['Expected', false, false],
    ['EnRoute', false, false],
    ['CheckIn', false, false],
    ['Boarding', false, false],
    ['GateClosed', false, false],
    ['Departed', false, false],
    ['Delayed', false, false],
    ['Approaching', false, false],
    ['Arrived', false, false],
    ['Canceled', true, false],
    ['Diverted', false, true],
    ['CanceledUncertain', false, false],
  ])('%s carries cancelled=%s diverted=%s', (status, cancelled, diverted) => {
    expect(adbFlags(status)).toEqual({ cancelled, diverted });
  });

  // Review ruling Q11: the two statuses AeroDataBox marks as uncertain, and only those.
  it.each(ADB_STATUSES.map((status) => [status] as const))('%s uncertain?', (status) => {
    const expected = status === 'CanceledUncertain' || status === 'Unknown';
    expect(adbStatusUncertain(status)).toBe(expected);
  });
});

describe('disambiguateRevisedTime', () => {
  const SCHEDULED = '2026-09-20T03:50:00Z';
  const REVISED = '2026-09-20T04:20:00Z';

  /** One row per enum value: is a departure time an actual, is an arrival time an actual. */
  const TABLE: readonly (readonly [AdbStatus, boolean, boolean])[] = [
    ['Unknown', false, false],
    ['Expected', false, false],
    ['EnRoute', true, false],
    ['CheckIn', false, false],
    ['Boarding', false, false],
    ['GateClosed', false, false],
    ['Departed', true, false],
    ['Delayed', false, false],
    ['Approaching', true, false],
    ['Arrived', true, true],
    ['Canceled', false, false],
    ['Diverted', true, false],
    ['CanceledUncertain', false, false],
  ];

  it('has one row per enum value', () => {
    expect(TABLE.map(([status]) => status)).toEqual([...ADB_STATUSES]);
  });

  it.each(TABLE)('%s: departure actual=%s, arrival actual=%s', (status, departed, arrived) => {
    expect(isActualAt('departure', status)).toBe(departed);
    expect(isActualAt('arrival', status)).toBe(arrived);

    const out = disambiguateRevisedTime(status, REVISED, SCHEDULED, 'departure');
    expect(out).toEqual({
      field: departed ? 'actualOut' : 'estimatedOut',
      value: '2026-09-20T04:20:00.000Z',
      quality: departed ? 'live' : 'estimated',
      delaySec: 1_800,
    });
    const off = disambiguateRevisedTime(status, REVISED, SCHEDULED, 'departure', 'runway');
    expect(off?.field).toBe(departed ? 'actualOff' : 'estimatedOff');

    const inTime = disambiguateRevisedTime(status, REVISED, SCHEDULED, 'arrival');
    expect(inTime?.field).toBe(arrived ? 'actualIn' : 'estimatedIn');
    expect(inTime?.quality).toBe(arrived ? 'live' : 'estimated');
    const on = disambiguateRevisedTime(status, REVISED, SCHEDULED, 'arrival', 'runway');
    expect(on?.field).toBe(arrived ? 'actualOn' : 'estimatedOn');
  });

  it('returns null without a revised time and omits the delay without a schedule', () => {
    expect(disambiguateRevisedTime('Arrived', undefined, SCHEDULED, 'arrival')).toBeNull();
    expect(disambiguateRevisedTime('Arrived', 'garbage', SCHEDULED, 'arrival')).toBeNull();
    const early = disambiguateRevisedTime(
      'Departed',
      '2026-09-20T03:45:00Z',
      undefined,
      'departure',
    );
    expect(early).toEqual({
      field: 'actualOut',
      value: '2026-09-20T03:45:00.000Z',
      quality: 'live',
    });
    const ahead = disambiguateRevisedTime(
      'Departed',
      '2026-09-20T03:45:00Z',
      SCHEDULED,
      'departure',
    );
    expect(ahead?.delaySec).toBe(-300);
  });
});
