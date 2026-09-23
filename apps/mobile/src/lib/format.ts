/**
 * Times, dates, durations and distances as the screens show them, in the user's time format and
 * units from the settings store (increment 10). Pure: every function takes what it needs as
 * arguments (the instant, the zone, the format, "now"), so __tests__/format.test.ts pins every
 * form, the 12 h and 24 h clocks and the countdown included.
 *
 * Zones. A flight time is shown in its airport's zone (the departure in the origin's, the arrival
 * in the destination's) when the account's `showLocalTimes` is on, the default; otherwise in the
 * device's zone. The zone conversion is `Intl.DateTimeFormat` with `timeZone` (the only zone
 * arithmetic the app does; Hermes, Node and Workers all support it, see
 * packages/shared/src/flight-key.ts), but the TEXT is assembled here from numeric parts, never
 * taken from a locale's formatted string, so "3:50 PM" is the same on Hermes, in Jest and on
 * every ICU version (newer ICU puts a narrow no-break space before "PM").
 */

import type { FlightStatusValue, UserPreferences } from '@planeahead/shared';

export type TimeFormat = UserPreferences['timeFormat'];
export type DistanceUnit = UserPreferences['distanceUnit'];

export interface ClockOptions {
  readonly timeFormat: TimeFormat;
  /** IANA zone; undefined (or one this runtime does not know) means the device's zone. */
  readonly timeZone?: string | null | undefined;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;
const KM_PER_MILE = 1.609344;

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const DEVICE_ZONE = '(device)';
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string | null | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? DEVICE_ZONE;
  const cached = formatters.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const options: Intl.DateTimeFormatOptions = {
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(
      'en-US',
      timeZone === null || timeZone === undefined ? options : { ...options, timeZone },
    );
  } catch {
    // A zone this runtime does not know: the device's zone rather than a crash.
    formatter = formatterFor(undefined);
  }
  formatters.set(key, formatter);
  return formatter;
}

function zonedParts(ms: number, timeZone: string | null | undefined): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') {
      values[part.type] = Number(part.value);
    }
  }
  return {
    year: values['year'] ?? 1970,
    month: values['month'] ?? 1,
    day: values['day'] ?? 1,
    // Some engines print midnight as 24 under h23 in older ICU; normalise.
    hour: (values['hour'] ?? 0) % 24,
    minute: values['minute'] ?? 0,
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function instantMs(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) {
    return null;
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** `15:50` or `3:50 PM`; `--:--` when the instant is missing or unreadable. */
export function formatClock(iso: string | null | undefined, options: ClockOptions): string {
  const ms = instantMs(iso);
  if (ms === null) {
    return '--:--';
  }
  const { hour, minute } = zonedParts(ms, options.timeZone);
  if (options.timeFormat === '24h') {
    return `${pad2(hour)}:${pad2(minute)}`;
  }
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(twelve)}:${pad2(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

function dayLabel(year: number, month: number, day: number): string {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday] ?? ''} ${String(day)} ${MONTHS[month - 1] ?? ''}`;
}

/** `Thu 24 Sep` for an instant in a zone. */
export function formatDay(iso: string | null | undefined, timeZone?: string | null): string {
  const ms = instantMs(iso);
  if (ms === null) {
    return '';
  }
  const { year, month, day } = zonedParts(ms, timeZone);
  return dayLabel(year, month, day);
}

/** `Thu 24 Sep` for a calendar date `YYYY-MM-DD` (no zone: it already is a local date). */
export function formatIsoDate(date: string): string {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(date);
  if (match === null) {
    return date;
  }
  return dayLabel(Number(match[1]), Number(match[2]), Number(match[3]));
}

/** `Wed 23 Sep`, `Wed 23 Sep or Thu 24 Sep`, `Wed 23 Sep, Thu 24 Sep or Fri 25 Sep`. */
export function formatDateList(dates: readonly string[]): string {
  const labels = [...dates].sort().map(formatIsoDate);
  if (labels.length <= 1) {
    return labels[0] ?? '';
  }
  return `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1] ?? ''}`;
}

/** The calendar date `YYYY-MM-DD` of an instant in a zone (the device's by default). */
export function localDate(ms: number, timeZone?: string | null): string {
  const { year, month, day } = zonedParts(ms, timeZone);
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** `YYYY-MM-DD` plus `days` calendar days. */
export function addDays(date: string, days: number): string {
  const ms = Date.parse(`${date}T12:00:00Z`) + days * DAY_MINUTES * MINUTE_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * How many calendar days the second instant's local date lies after the first's (each in its own
 * zone): the `+1` of an overnight arrival. 0 when either is missing.
 */
export function dayShift(
  fromIso: string | null | undefined,
  fromZone: string | null | undefined,
  toIso: string | null | undefined,
  toZone: string | null | undefined,
): number {
  const from = instantMs(fromIso);
  const to = instantMs(toIso);
  if (from === null || to === null) {
    return 0;
  }
  const a = Date.parse(`${localDate(from, fromZone)}T00:00:00Z`);
  const b = Date.parse(`${localDate(to, toZone)}T00:00:00Z`);
  return Math.round((b - a) / (DAY_MINUTES * MINUTE_MS));
}

/**
 * The countdown's text for a duration: `under 1 min`, `45 min`, `3 h`, `3 h 5 min`, `2 d`,
 * `2 d 4 h`, and `now` at or past zero. Whole minutes, rounded down, so the text never runs ahead
 * of the clock.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) {
    return 'now';
  }
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 1) {
    return 'under 1 min';
  }
  if (minutes < HOUR_MINUTES) {
    return `${String(minutes)} min`;
  }
  if (minutes < DAY_MINUTES) {
    const hours = Math.floor(minutes / HOUR_MINUTES);
    const rest = minutes % HOUR_MINUTES;
    return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
  }
  const days = Math.floor(minutes / DAY_MINUTES);
  const hours = Math.floor((minutes % DAY_MINUTES) / HOUR_MINUTES);
  return hours === 0 ? `${String(days)} d` : `${String(days)} d ${String(hours)} h`;
}

function durationText(minutes: number): string {
  if (minutes < HOUR_MINUTES) {
    return `${String(minutes)} min`;
  }
  const hours = Math.floor(minutes / HOUR_MINUTES);
  const rest = minutes % HOUR_MINUTES;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/** A delay in seconds as `on time`, `25 min late`, `1 h 5 min late`, `5 min early`; null if unknown. */
export function formatDelay(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return null;
  }
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (minutes === 0) {
    return 'on time';
  }
  return `${durationText(minutes)} ${seconds > 0 ? 'late' : 'early'}`;
}

/** The signed minutes between a scheduled and a later time, or null when either is missing. */
export function minutesBetween(
  scheduledIso: string | null | undefined,
  actualIso: string | null | undefined,
): number | null {
  const scheduled = instantMs(scheduledIso);
  const actual = instantMs(actualIso);
  if (scheduled === null || actual === null) {
    return null;
  }
  return Math.round((actual - scheduled) / MINUTE_MS);
}

function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** `5,540 km` or `3,442 mi`. */
export function formatDistance(km: number, unit: DistanceUnit): string {
  const value = unit === 'km' ? km : km / KM_PER_MILE;
  return `${groupThousands(Math.round(value))} ${unit}`;
}

/** `just now`, `5 min ago`, `2 h ago`, `3 d ago`: how old a snapshot is. */
export function formatAge(iso: string | null | undefined, nowMs: number): string | null {
  const ms = instantMs(iso);
  if (ms === null) {
    return null;
  }
  const minutes = Math.floor(Math.max(0, nowMs - ms) / MINUTE_MS);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < HOUR_MINUTES) {
    return `${String(minutes)} min ago`;
  }
  if (minutes < DAY_MINUTES) {
    return `${String(Math.floor(minutes / HOUR_MINUTES))} h ago`;
  }
  return `${String(Math.floor(minutes / DAY_MINUTES))} d ago`;
}

const STATUS_LABELS: Readonly<Record<FlightStatusValue, string>> = {
  scheduled: 'Scheduled',
  boarding: 'Boarding',
  departed: 'Departed',
  en_route: 'En route',
  landed: 'Landed',
  arrived: 'Arrived',
  cancelled: 'Cancelled',
  diverted: 'Diverted',
  unknown: 'Unknown',
};

export function statusLabel(status: FlightStatusValue): string {
  return STATUS_LABELS[status];
}

/** The settings screen's two unit systems, over the account's distance and temperature units. */
export type UnitSystem = 'metric' | 'imperial';

export function unitSystemOf(preferences: Pick<UserPreferences, 'distanceUnit'>): UnitSystem {
  return preferences.distanceUnit === 'km' ? 'metric' : 'imperial';
}

/** What choosing a unit system changes in the account's preferences. */
export function unitSystemPatch(
  system: UnitSystem,
): Pick<UserPreferences, 'distanceUnit' | 'temperatureUnit'> {
  return system === 'metric'
    ? { distanceUnit: 'km', temperatureUnit: 'c' }
    : { distanceUnit: 'mi', temperatureUnit: 'f' };
}

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  aerodatabox: 'AeroDataBox',
  aeroapi: 'FlightAware AeroAPI',
  adsb_lol: 'ADS-B (adsb.lol)',
  adsb_fi: 'ADS-B (adsb.fi)',
  airplanes_live: 'ADS-B (airplanes.live)',
  mock: 'test data',
};

/** The attribution line's provider name; the raw id for one this build does not know. */
export function providerName(source: string | null | undefined): string | null {
  if (source === null || source === undefined || source === '') {
    return null;
  }
  return PROVIDER_NAMES[source] ?? source;
}
