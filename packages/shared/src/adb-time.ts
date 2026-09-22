import { isValidIsoDate } from './flight-key';

/**
 * AeroDataBox date-times (increment 6). Every time in a response is a `DateTimeContract`,
 * `{ local, utc }`, and since the 2023-10 breaking change `local` carries a space separator and
 * no reliable offset (https://aerodatabox.com/breaking-changes-2023-10/). `new Date(local)` in
 * a Worker reads such a string as UTC and is silently wrong by the airport's offset, so the only
 * instant ever taken from a contract is `.utc`. `.local` contributes exactly two things: the
 * local calendar date (the key's `scheduledDepartureDateLocal`) and, compared with `.utc`, the
 * airport's offset at that instant. Nothing here reads the wall clock.
 */

/** The `DateTimeContract` shape; either side may be missing or null in a real payload. */
export interface AdbDateTime {
  local?: string | null | undefined;
  utc?: string | null | undefined;
}

export interface ParsedAdbDateTime {
  /** The instant, ISO-8601 in UTC with a trailing `Z`. Always from `.utc`. */
  instant: string;
  /** `YYYY-MM-DD` from the date part of `.local`, when `.local` is present and well formed. */
  localDate?: string | undefined;
  /** Local wall clock minus UTC, in minutes (`-240` at JFK in summer), when both are present. */
  offsetMinutes?: number | undefined;
}

/**
 * `2026-09-19 16:30Z`, `2026-09-19T16:30:00Z`, `2026-09-19 16:30:00.000Z`, with or without the
 * `Z` (the field is UTC by contract). An explicit non-zero offset on `.utc` is rejected rather
 * than guessed at.
 */
const UTC_RE =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?\s*(?:Z|[+-]00:?00)?$/i;

/** The wall-clock part of `.local`; anything after it (an offset, if present) is ignored. */
const LOCAL_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:[ T]([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?)?/;

/** No real UTC offset lies outside -12:00 to +14:00. */
const MAX_OFFSET_MINUTES = 14 * 60;

interface WallClock {
  date: string;
  ms: number;
  hasTime: boolean;
}

function wallClock(match: RegExpExecArray): WallClock | undefined {
  const [, year, month, day, hour, minute, second] = match;
  if (year === undefined || month === undefined || day === undefined) {
    return undefined;
  }
  const date = `${year}-${month}-${day}`;
  if (!isValidIsoDate(date)) {
    return undefined;
  }
  const h = hour === undefined ? 0 : Number(hour);
  const m = minute === undefined ? 0 : Number(minute);
  const s = second === undefined ? 0 : Number(second);
  if (h > 23 || m > 59 || s > 59) {
    return undefined;
  }
  return {
    date,
    ms: Date.UTC(Number(year), Number(month) - 1, Number(day), h, m, s),
    hasTime: hour !== undefined,
  };
}

/**
 * Parses an AeroDataBox `DateTimeContract`. Returns null when `.utc` is missing or malformed:
 * there is no fallback to `.local`, ever. The fractional seconds of `.utc` are kept to the
 * millisecond.
 */
export function parseAdbDateTime(value: AdbDateTime | null | undefined): ParsedAdbDateTime | null {
  const utc = value?.utc?.trim();
  if (utc === undefined || utc === '') {
    return null;
  }
  const utcMatch = UTC_RE.exec(utc);
  if (utcMatch === null) {
    return null;
  }
  const utcClock = wallClock(utcMatch);
  if (utcClock === undefined) {
    return null;
  }
  const fraction = utcMatch[7];
  const millis = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1_000);
  const instantMs = utcClock.ms + millis;
  const parsed: ParsedAdbDateTime = { instant: new Date(instantMs).toISOString() };

  const local = value?.local?.trim();
  const localMatch = local === undefined ? null : LOCAL_RE.exec(local);
  const localClock = localMatch === null ? undefined : wallClock(localMatch);
  if (localClock !== undefined) {
    parsed.localDate = localClock.date;
    if (localClock.hasTime) {
      const offset = Math.round((localClock.ms - utcClock.ms) / 60_000);
      if (Math.abs(offset) <= MAX_OFFSET_MINUTES) {
        parsed.offsetMinutes = offset;
      }
    }
  }
  return parsed;
}
