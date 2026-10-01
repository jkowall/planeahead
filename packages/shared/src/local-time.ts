import { isValidTimeZone } from './airports';

/**
 * Airport-local wall clock against instants (increment 18; moved from the AeroAPI adapter, whose
 * board method it served). Boards are cut into buckets of airport-local time, so the cache needs
 * both directions: a local minute as an instant, and an instant as a local minute. Pure: only
 * `Intl.DateTimeFormat` and `Date.UTC`, never the wall clock.
 */

const LOCAL_MINUTE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$/;

/** Wall clock minus UTC at `utcMs` in `tz`, in milliseconds. */
function zoneOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? Number.NaN);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return wall - Math.floor(utcMs / 1_000) * 1_000;
}

/**
 * The instant at which the zone's offset changes, searched to the second between `lo` and `hi`
 * (whose offsets differ). Only ever called for a wall time inside a spring-forward gap.
 */
function transitionBetween(lo: number, hi: number, tz: string): number {
  const before = zoneOffsetMs(lo, tz);
  let low = lo;
  let high = hi;
  while (high - low > 1_000) {
    const mid = low + Math.floor((high - low) / 2_000) * 1_000;
    if (zoneOffsetMs(mid, tz) === before) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return high;
}

/**
 * An airport-local wall-clock minute (`YYYY-MM-DDTHH:mm`) in `tz` as a UTC instant in ms, or null
 * for a malformed time or zone. Two passes over the zone's offset, so the answer is right on both
 * sides of a DST change; an ambiguous fall-back time is its first occurrence. A wall time inside
 * a spring-forward gap exists on no clock, and it lands ON the transition (the first instant after
 * the gap): the mapping stays monotonic, so a local `from < to` window that straddles the gap
 * stays ordered as UTC, and one lying entirely inside the gap collapses to an empty window. The
 * earlier two-pass result put a gap time an hour BEFORE the gap, which reversed such a window.
 */
export function localMinuteToUtcMs(local: string, tz: string): number | null {
  const match = LOCAL_MINUTE_RE.exec(local);
  if (match === null || !isValidTimeZone(tz)) {
    return null;
  }
  const [, y, mo, d, h, mi] = match;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  if (Number.isNaN(wall) || new Date(wall).toISOString().slice(0, 16) !== local) {
    return null;
  }
  const guessOffset = zoneOffsetMs(wall, tz);
  const first = wall - guessOffset;
  const offset = zoneOffsetMs(first, tz);
  const candidate = wall - offset;
  if (offset === guessOffset || zoneOffsetMs(candidate, tz) === offset) {
    return candidate;
  }
  return transitionBetween(Math.min(first, candidate), Math.max(first, candidate), tz);
}

/**
 * The airport-local wall-clock minute (`YYYY-MM-DDTHH:mm`) of the instant `utcMs` in `tz`, or
 * null for a zone the runtime does not know. Seconds are dropped, never rounded.
 */
export function utcMsToLocalMinute(utcMs: number, tz: string): string | null {
  if (!Number.isFinite(utcMs) || !isValidTimeZone(tz)) {
    return null;
  }
  const seconds = Math.floor(utcMs / 1_000) * 1_000;
  return new Date(seconds + zoneOffsetMs(utcMs, tz)).toISOString().slice(0, 16);
}
