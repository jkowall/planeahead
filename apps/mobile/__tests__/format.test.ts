/**
 * src/lib/format.ts is pure (ruling T4): the 12 h and 24 h clocks in an airport's zone, the dates,
 * the countdown, delays, distances in both unit systems and a snapshot's age.
 */

import {
  addDays,
  dayShift,
  formatAge,
  formatClock,
  formatCountdown,
  formatDateList,
  formatDay,
  formatDelay,
  formatDistance,
  formatIsoDate,
  localDate,
  minutesBetween,
  providerName,
  statusLabel,
  unitSystemOf,
  unitSystemPatch,
} from '../src/lib/format';
import { FLIGHT_STATUS_VALUES } from '@planeahead/shared';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatClock', () => {
  it('prints the 24 h form in the given zone', () => {
    expect(
      formatClock('2026-09-23T22:00:00Z', { timeFormat: '24h', timeZone: 'America/New_York' }),
    ).toBe('18:00');
    expect(
      formatClock('2026-09-24T06:10:00Z', { timeFormat: '24h', timeZone: 'Europe/London' }),
    ).toBe('07:10');
    expect(formatClock('2026-09-23T04:05:00Z', { timeFormat: '24h', timeZone: 'UTC' })).toBe(
      '04:05',
    );
  });

  it('prints the 12 h form with AM and PM, noon and midnight included', () => {
    const at = (iso: string) => formatClock(iso, { timeFormat: '12h', timeZone: 'UTC' });
    expect(at('2026-09-23T15:50:00Z')).toBe('3:50 PM');
    expect(at('2026-09-23T09:05:00Z')).toBe('9:05 AM');
    expect(at('2026-09-23T00:00:00Z')).toBe('12:00 AM');
    expect(at('2026-09-23T12:00:00Z')).toBe('12:00 PM');
    expect(at('2026-09-23T23:59:00Z')).toBe('11:59 PM');
  });

  it('uses plain ASCII spacing whatever the ICU version prints', () => {
    expect(formatClock('2026-09-23T15:50:00Z', { timeFormat: '12h', timeZone: 'UTC' })).toMatch(
      /^[0-9]{1,2}:[0-9]{2} (AM|PM)$/,
    );
  });

  it('crosses daylight saving correctly', () => {
    // New York: EDT (UTC-4) in September, EST (UTC-5) in December.
    expect(
      formatClock('2026-12-01T22:00:00Z', { timeFormat: '24h', timeZone: 'America/New_York' }),
    ).toBe('17:00');
  });

  it('shows --:-- for a missing or unreadable instant, and survives an unknown zone', () => {
    expect(formatClock(null, { timeFormat: '24h' })).toBe('--:--');
    expect(formatClock('not a date', { timeFormat: '12h' })).toBe('--:--');
    expect(
      formatClock('2026-09-23T15:50:00Z', { timeFormat: '24h', timeZone: 'Mars/Olympus' }),
    ).toMatch(/^[0-9]{2}:50$/);
  });
});

describe('dates', () => {
  it('names the day in the zone of the airport', () => {
    // 01:30 UTC on the 24th is still the 23rd in New York.
    expect(formatDay('2026-09-24T01:30:00Z', 'America/New_York')).toBe('Wed 23 Sep');
    expect(formatDay('2026-09-24T01:30:00Z', 'Europe/London')).toBe('Thu 24 Sep');
    expect(formatDay(null)).toBe('');
  });

  it('formats a calendar date without shifting it through a zone', () => {
    expect(formatIsoDate('2026-09-24')).toBe('Thu 24 Sep');
    expect(formatIsoDate('2027-01-01')).toBe('Fri 1 Jan');
    expect(formatIsoDate('garbage')).toBe('garbage');
  });

  it('lists the dates a search tried, in order', () => {
    expect(formatDateList(['2026-09-24', '2026-09-23', '2026-09-25'])).toBe(
      'Wed 23 Sep, Thu 24 Sep or Fri 25 Sep',
    );
    expect(formatDateList(['2026-09-24', '2026-09-23'])).toBe('Wed 23 Sep or Thu 24 Sep');
    expect(formatDateList(['2026-09-24'])).toBe('Thu 24 Sep');
    expect(formatDateList([])).toBe('');
  });

  it('computes local dates, date arithmetic and the overnight +1', () => {
    expect(localDate(Date.parse('2026-09-24T01:30:00Z'), 'America/New_York')).toBe('2026-09-23');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(
      dayShift('2026-09-23T22:00:00Z', 'America/New_York', '2026-09-24T06:10:00Z', 'Europe/London'),
    ).toBe(1);
    expect(dayShift('2026-09-23T12:00:00Z', 'UTC', '2026-09-23T15:00:00Z', 'UTC')).toBe(0);
    expect(dayShift(null, 'UTC', '2026-09-23T15:00:00Z', 'UTC')).toBe(0);
  });
});

describe('formatCountdown', () => {
  it.each([
    [0, 'now'],
    [-5 * MINUTE, 'now'],
    [30_000, 'under 1 min'],
    [MINUTE, '1 min'],
    [45 * MINUTE + 59_000, '45 min'],
    [HOUR, '1 h'],
    [3 * HOUR + 5 * MINUTE, '3 h 5 min'],
    [23 * HOUR + 59 * MINUTE, '23 h 59 min'],
    [DAY, '1 d'],
    [2 * DAY + 4 * HOUR + 30 * MINUTE, '2 d 4 h'],
  ])('%d ms is "%s"', (ms, text) => {
    expect(formatCountdown(ms)).toBe(text);
  });
});

describe('delays, distances, ages', () => {
  it('describes a delay', () => {
    expect(formatDelay(null)).toBeNull();
    expect(formatDelay(20)).toBe('on time');
    expect(formatDelay(1500)).toBe('25 min late');
    expect(formatDelay(3900)).toBe('1 h 5 min late');
    expect(formatDelay(-300)).toBe('5 min early');
    expect(minutesBetween('2026-09-23T22:00:00Z', '2026-09-23T22:25:00Z')).toBe(25);
    expect(minutesBetween(null, '2026-09-23T22:25:00Z')).toBeNull();
  });

  it('shows distances in the chosen unit', () => {
    expect(formatDistance(5540, 'km')).toBe('5,540 km');
    expect(formatDistance(5540, 'mi')).toBe('3,442 mi');
    expect(formatDistance(12.4, 'km')).toBe('12 km');
  });

  it('says how old a snapshot is', () => {
    const now = Date.parse('2026-09-23T14:00:00Z');
    expect(formatAge('2026-09-23T13:59:30Z', now)).toBe('just now');
    expect(formatAge('2026-09-23T13:56:00Z', now)).toBe('4 min ago');
    expect(formatAge('2026-09-23T11:00:00Z', now)).toBe('3 h ago');
    expect(formatAge('2026-09-21T14:00:00Z', now)).toBe('2 d ago');
    expect(formatAge(null, now)).toBeNull();
  });
});

describe('labels and units', () => {
  it('labels every shared status value', () => {
    for (const status of FLIGHT_STATUS_VALUES) {
      expect(statusLabel(status)).toMatch(/^[A-Z][a-z ]+$/);
    }
    expect(statusLabel('en_route')).toBe('En route');
  });

  it('maps the unit systems onto the account preferences', () => {
    expect(unitSystemOf({ distanceUnit: 'km' })).toBe('metric');
    expect(unitSystemOf({ distanceUnit: 'mi' })).toBe('imperial');
    expect(unitSystemPatch('metric')).toEqual({ distanceUnit: 'km', temperatureUnit: 'c' });
    expect(unitSystemPatch('imperial')).toEqual({ distanceUnit: 'mi', temperatureUnit: 'f' });
  });

  it('names the providers for the attribution line', () => {
    expect(providerName('aerodatabox')).toBe('AeroDataBox');
    expect(providerName('aeroapi')).toBe('FlightAware AeroAPI');
    expect(providerName('something_new')).toBe('something_new');
    expect(providerName(null)).toBeNull();
  });
});
