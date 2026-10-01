import { describe, expect, it } from 'vitest';
import { localMinuteToUtcMs, utcMsToLocalMinute } from '../src/local-time';

const NY = 'America/New_York';
const at = (iso: string): number => Date.parse(iso);

describe('localMinuteToUtcMs (moved from the AeroAPI adapter in increment 18)', () => {
  it('reads a wall clock in summer and in winter', () => {
    expect(localMinuteToUtcMs('2026-09-22T17:00', NY)).toBe(at('2026-09-22T21:00:00Z'));
    expect(localMinuteToUtcMs('2026-12-22T17:00', NY)).toBe(at('2026-12-22T22:00:00Z'));
  });

  it('crosses the November fall-back and the March spring-forward', () => {
    expect(localMinuteToUtcMs('2026-11-01T00:30', NY)).toBe(at('2026-11-01T04:30:00Z'));
    expect(localMinuteToUtcMs('2026-11-01T03:00', NY)).toBe(at('2026-11-01T08:00:00Z'));
    expect(localMinuteToUtcMs('2026-03-08T04:00', NY)).toBe(at('2026-03-08T08:00:00Z'));
  });

  it('lands a spring-forward gap time on the transition, so the mapping never runs backwards', () => {
    expect(localMinuteToUtcMs('2026-03-08T01:59', NY)).toBe(at('2026-03-08T06:59:00Z'));
    expect(localMinuteToUtcMs('2026-03-08T02:00', NY)).toBe(at('2026-03-08T07:00:00Z'));
    expect(localMinuteToUtcMs('2026-03-08T02:30', NY)).toBe(at('2026-03-08T07:00:00Z'));
    expect(localMinuteToUtcMs('2026-03-08T03:00', NY)).toBe(at('2026-03-08T07:00:00Z'));
  });

  it('reads an ambiguous fall-back time as its first occurrence', () => {
    expect(localMinuteToUtcMs('2026-11-01T01:30', NY)).toBe(at('2026-11-01T05:30:00Z'));
    expect(localMinuteToUtcMs('2026-11-01T02:00', NY)).toBe(at('2026-11-01T07:00:00Z'));
  });

  it('refuses a malformed time or zone', () => {
    expect(localMinuteToUtcMs('2026-09-22T17:00', 'Not/AZone')).toBeNull();
    expect(localMinuteToUtcMs('2026-13-22T17:00', NY)).toBeNull();
    expect(localMinuteToUtcMs('2026-09-22T17:00:00Z', NY)).toBeNull();
  });
});

describe('utcMsToLocalMinute', () => {
  it('formats an instant as the airport-local minute, dropping seconds', () => {
    expect(utcMsToLocalMinute(at('2026-09-22T21:00:59Z'), NY)).toBe('2026-09-22T17:00');
    expect(utcMsToLocalMinute(at('2026-12-22T04:59:00Z'), NY)).toBe('2026-12-21T23:59');
    expect(utcMsToLocalMinute(at('2026-09-22T23:30:00Z'), 'Asia/Kolkata')).toBe('2026-09-23T05:00');
  });

  it('is the inverse of localMinuteToUtcMs away from a DST gap', () => {
    for (const local of ['2026-03-08T01:59', '2026-03-08T03:00', '2026-11-01T00:30']) {
      const ms = localMinuteToUtcMs(local, NY);
      expect(ms === null ? null : utcMsToLocalMinute(ms, NY)).toBe(local);
    }
  });

  it('refuses an unknown zone and a non-finite instant', () => {
    expect(utcMsToLocalMinute(0, 'Not/AZone')).toBeNull();
    expect(utcMsToLocalMinute(Number.NaN, NY)).toBeNull();
  });
});
