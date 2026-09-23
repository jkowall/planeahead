import { describe, expect, it } from 'vitest';
import { parseAdbDateTime, type AdbDateTime, type ParsedAdbDateTime } from '../src/adb-time';

describe('parseAdbDateTime', () => {
  it.each<[string, AdbDateTime | null | undefined, ParsedAdbDateTime | null]>([
    [
      'the post-2023-10 shape: space separator, no offset on local',
      { local: '2026-09-19 23:50:00', utc: '2026-09-20 03:50Z' },
      { instant: '2026-09-20T03:50:00.000Z', localDate: '2026-09-19', offsetMinutes: -240 },
    ],
    [
      'a local value that still carries an offset: the offset is ignored, the wall clock used',
      { local: '2026-09-19 23:50+05:00', utc: '2026-09-20T03:50:00Z' },
      { instant: '2026-09-20T03:50:00.000Z', localDate: '2026-09-19', offsetMinutes: -240 },
    ],
    [
      'east of Greenwich across midnight',
      { local: '2026-09-20 00:30', utc: '2026-09-19 22:30Z' },
      { instant: '2026-09-19T22:30:00.000Z', localDate: '2026-09-20', offsetMinutes: 120 },
    ],
    [
      'a half-hour zone',
      { local: '2026-09-19 18:45', utc: '2026-09-19 13:15Z' },
      { instant: '2026-09-19T13:15:00.000Z', localDate: '2026-09-19', offsetMinutes: 330 },
    ],
    [
      'fractional seconds on utc are kept to the millisecond',
      { local: '2026-09-19 12:00:00', utc: '2026-09-19T12:00:00.1234Z' },
      { instant: '2026-09-19T12:00:00.123Z', localDate: '2026-09-19', offsetMinutes: 0 },
    ],
    [
      'utc without the Z is still UTC by contract',
      { local: '2026-09-19 08:00', utc: '2026-09-19 12:00' },
      { instant: '2026-09-19T12:00:00.000Z', localDate: '2026-09-19', offsetMinutes: -240 },
    ],
    [
      'utc with an explicit +00:00',
      { utc: '2026-09-19T12:00:00+00:00' },
      { instant: '2026-09-19T12:00:00.000Z' },
    ],
    [
      'no local: no local date and no offset',
      { utc: '2026-09-19 12:00Z' },
      { instant: '2026-09-19T12:00:00.000Z' },
    ],
    [
      'a local date without a time: the date, no offset',
      { local: '2026-09-19', utc: '2026-09-19 12:00Z' },
      { instant: '2026-09-19T12:00:00.000Z', localDate: '2026-09-19' },
    ],
    [
      'an implausible offset is dropped, the instant kept',
      { local: '2026-09-21 12:00', utc: '2026-09-19 12:00Z' },
      { instant: '2026-09-19T12:00:00.000Z', localDate: '2026-09-21' },
    ],
    [
      'a malformed local is ignored',
      { local: 'yesterday', utc: '2026-09-19 12:00Z' },
      { instant: '2026-09-19T12:00:00.000Z' },
    ],
    ['no utc: null, never a fallback to local', { local: '2026-09-19 12:00' }, null],
    ['a null utc', { local: '2026-09-19 12:00', utc: null }, null],
    ['an empty utc', { utc: '  ' }, null],
    ['a non-zero offset on utc is refused', { utc: '2026-09-19T12:00:00+02:00' }, null],
    ['an impossible date', { utc: '2026-02-30 12:00Z' }, null],
    ['an impossible time', { utc: '2026-09-19 24:10Z' }, null],
    ['garbage', { utc: 'soon' }, null],
    ['a null contract', null, null],
    ['an absent contract', undefined, null],
  ])('%s', (_label, value, expected) => {
    expect(parseAdbDateTime(value)).toEqual(expected);
  });

  it('never reads .local as an instant: the same local with two utc values gives two instants', () => {
    const a = parseAdbDateTime({ local: '2026-09-19 12:00', utc: '2026-09-19 16:00Z' });
    const b = parseAdbDateTime({ local: '2026-09-19 12:00', utc: '2026-09-19 10:00Z' });
    expect(a?.instant).toBe('2026-09-19T16:00:00.000Z');
    expect(b?.instant).toBe('2026-09-19T10:00:00.000Z');
    // `new Date(local)` in a Worker would have read 12:00 UTC for both.
    expect(a?.instant).not.toBe(new Date('2026-09-19T12:00:00Z').toISOString());
  });
});
