/**
 * The text of a push (increment 15, ruling N9): one title and body per intent kind and subject,
 * plain and factual. Every push is self-contained: it names the flight, its route, the current
 * departure and arrival times and the gate, from the intent's `flight` summary (the flight as it
 * stood when the intent was produced), so a reader who saw no earlier push still knows where to
 * be. A correction says what changed back. Times are airport-local in the user's 12 or 24 hour
 * format (UTC, marked, when the airport's zone is unknown); the text never exceeds the shared
 * `PUSH_TITLE_MAX_LENGTH` and `PUSH_BODY_MAX_LENGTH`. Pure: no clock, no I/O.
 */

import {
  CARRIER_IATA_TO_ICAO_FALLBACK,
  DELAY_THRESHOLD_MINUTES,
  PUSH_BODY_MAX_LENGTH,
  PUSH_TITLE_MAX_LENGTH,
  type AirportRef,
  type NotifyIntentV1,
} from '@planeahead/shared';

export interface RenderedPush {
  readonly title: string;
  readonly body: string;
}

type Flight = NotifyIntentV1['flight'];
type Intent = NotifyIntentV1['intent'];

/** ICAO to IATA for display, from the fallback table the app also ships (first code wins). */
const IATA_BY_ICAO: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [iata, icao] of Object.entries(CARRIER_IATA_TO_ICAO_FALLBACK)) {
    if (!map.has(icao)) {
      map.set(icao, iata);
    }
  }
  return map;
})();

/** `AA 100` when the carrier's IATA code is known, else `AAL 100`. */
export function displayDesignator(flight: Flight): string {
  const carrier = IATA_BY_ICAO.get(flight.operatingCarrierIcao) ?? flight.operatingCarrierIcao;
  return `${carrier} ${flight.flightNumber}`;
}

function airportCode(airport: AirportRef | undefined, icao?: string): string {
  if (airport !== undefined && (icao === undefined || airport.icao === icao)) {
    return airport.iata ?? airport.icao;
  }
  return icao ?? '';
}

/** Clips to `max` characters, ending in an ellipsis when it had to cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}\u2026`;
}

/** The user's clock (`user_preferences.time_format`); the shared default is 12 hours. */
export type TimeFormat = '12h' | '24h';

/** `3:05 PM` or `15:05` at the airport; `15:05 UTC` when its zone is unknown or invalid. */
export function localTime(iso: string, tz: string | undefined, format: TimeFormat): string {
  const instant = new Date(iso);
  const options: Intl.DateTimeFormatOptions = {
    hour: format === '24h' ? '2-digit' : 'numeric',
    minute: '2-digit',
    hourCycle: format === '24h' ? 'h23' : 'h12',
  };
  // ICU separates the day period with a narrow no-break space; a plain space reads the same
  // on every device and keeps the text identical across runtimes.
  const plain = (text: string): string => text.replace(/[\u202f\u00a0]/g, ' ');
  if (tz !== undefined) {
    try {
      return plain(new Intl.DateTimeFormat('en-US', { ...options, timeZone: tz }).format(instant));
    } catch {
      // An invalid zone name falls through to UTC.
    }
  }
  const utc = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(instant);
  return `${plain(utc)} UTC`;
}

/** `Oct 3` at the airport (UTC when its zone is unknown). */
function localDate(iso: string, tz: string | undefined): string {
  const format = (timeZone: string): string =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(
      new Date(iso),
    );
  if (tz !== undefined) {
    try {
      return format(tz);
    } catch {
      // As above.
    }
  }
  return format('UTC');
}

/** The departure's best instant: actual, else estimated, else scheduled. */
function departureAt(flight: Flight): string | undefined {
  return flight.times.actualOut ?? flight.times.estimatedOut ?? flight.times.scheduledOut;
}

/** The arrival's best instant at the planned destination. */
function arrivalAt(flight: Flight): string | undefined {
  return flight.times.actualIn ?? flight.times.estimatedIn ?? flight.times.scheduledIn;
}

/** `45 min`, `1 h`, `2 h 5 min`. */
export function duration(minutes: number): string {
  const total = Math.abs(Math.round(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) {
    return `${String(rest)} min`;
  }
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/** `45 min late`, `on time`, `5 min early`. */
function lateness(minutes: number): string {
  if (minutes === 0) {
    return 'on time';
  }
  return minutes > 0 ? `${duration(minutes)} late` : `${duration(minutes)} early`;
}

/** `Terminal 8, gate B12`, `gate B12`, `Terminal 8`, or empty. */
function place(terminal: string | undefined, gate: string | undefined): string {
  return [
    terminal === undefined ? '' : `Terminal ${terminal}`,
    gate === undefined ? '' : `gate ${gate}`,
  ]
    .filter((part) => part !== '')
    .join(', ');
}

/** What every push ends with when it is about something else: where and when to be. */
interface Context {
  readonly designator: string;
  readonly origin: string;
  readonly destination: string;
  readonly format: TimeFormat;
  readonly flight: Flight;
}

function time(context: Context, iso: string | undefined, airport: AirportRef): string | undefined {
  return iso === undefined ? undefined : localTime(iso, airport.tz, context.format);
}

/** `Departs 3:05 PM from JFK, Terminal 8, gate B12.` (`Departed` once it has.) */
function departureSentence(context: Context, withPlace = true): string {
  const { flight } = context;
  const at = time(context, departureAt(flight), flight.origin);
  const verb = flight.times.actualOut === undefined ? 'Departs' : 'Departed';
  const where = withPlace ? place(flight.originTerminal, flight.originGate) : '';
  const head =
    at === undefined ? `${verb} from ${context.origin}` : `${verb} ${at} from ${context.origin}`;
  return `${head}${where === '' ? '' : `, ${where}`}.`;
}

/** `Arrives 7:10 PM at LAX, gate C3.` (`Arrived` once it has.) */
function arrivalSentence(context: Context, withPlace = true): string {
  const { flight } = context;
  const at = time(context, arrivalAt(flight), flight.destination);
  const verb = flight.times.actualIn === undefined ? 'Arrives' : 'Arrived';
  const where = withPlace ? place(flight.destinationTerminal, flight.destinationGate) : '';
  const head =
    at === undefined
      ? `${verb} at ${context.destination}`
      : `${verb} ${at} at ${context.destination}`;
  return `${head}${where === '' ? '' : `, ${where}`}.`;
}

function minutesOf(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** N2: a departure or arrival delay, a move of one, or its correction back under the line. */
function renderDelay(context: Context, intent: Intent): RenderedPush {
  const { designator, flight } = context;
  const minutes = minutesOf(intent.value) ?? 0;
  const before = minutesOf(intent.previousValue);
  // A previous value under the line is the creation baseline or a correction, never a delay the
  // user was told of as one.
  const earlier =
    before === null || before < DELAY_THRESHOLD_MINUTES
      ? ''
      : ` Earlier reported ${duration(before)} late.`;
  if (intent.subject === 'arrival') {
    const scheduled = time(context, flight.times.scheduledIn, flight.destination);
    const at = time(context, arrivalAt(flight), flight.destination);
    const title = intent.correction
      ? `${designator} no longer arriving late`
      : `${designator} arriving ${duration(minutes)} late`;
    const head =
      at === undefined
        ? `Arrival at ${context.destination} ${lateness(minutes)}.`
        : `Arrives ${at} at ${context.destination}, ${lateness(minutes)}${scheduled === undefined ? '' : ` (scheduled ${scheduled})`}.`;
    return { title, body: `${head}${earlier} ${departureSentence(context)}` };
  }
  const scheduled = time(context, flight.times.scheduledOut, flight.origin);
  const at = time(context, departureAt(flight), flight.origin);
  const title = intent.correction
    ? `${designator} no longer delayed`
    : `${designator} delayed ${duration(minutes)}`;
  const gate = place(flight.originTerminal, flight.originGate);
  const head =
    at === undefined
      ? `Departure from ${context.origin} ${lateness(minutes)}.`
      : `Departs ${at} from ${context.origin}, ${lateness(minutes)}${scheduled === undefined ? '' : ` (scheduled ${scheduled})`}.`;
  const where = gate === '' ? '' : ` ${gate.charAt(0).toUpperCase()}${gate.slice(1)}.`;
  return { title, body: `${head}${earlier}${where} ${arrivalSentence(context, false)}` };
}

/** N3: a gate change, a first assignment, or a flap reverted after its push. */
function renderGate(context: Context, intent: Intent): RenderedPush {
  const { designator, flight } = context;
  const gate = intent.value;
  const previous = intent.previousValue;
  const origin = intent.subject !== 'destination';
  const side = origin ? 'Departure' : 'Arrival';
  const airport = origin ? context.origin : context.destination;
  const terminal = origin ? flight.originTerminal : flight.destinationTerminal;
  const at = terminal === undefined ? `at ${airport}` : `at ${airport}, Terminal ${terminal}`;
  let title: string;
  let head: string;
  if (intent.firstAssignment || previous === null) {
    title = origin
      ? `${designator} departs from gate ${gate}`
      : `${designator} arrives at gate ${gate}`;
    head = `${side} gate ${gate} ${at}.`;
  } else if (intent.correction) {
    title = origin
      ? `${designator} gate back to ${gate}`
      : `${designator} arrival gate back to ${gate}`;
    head = `${side} gate changed back to ${gate} ${at}, earlier reported as ${previous}.`;
  } else {
    title = origin
      ? `${designator} gate change to ${gate}`
      : `${designator} arrival gate change to ${gate}`;
    head = `${side} gate changed from ${previous} to ${gate} ${at}.`;
  }
  const tail = origin
    ? `${departureSentence(context, false)} ${arrivalSentence(context, false)}`
    : `${arrivalSentence(context, false)}${flight.baggageClaim === undefined ? '' : ` Baggage claim ${flight.baggageClaim}.`}`;
  return { title, body: `${head} ${tail}` };
}

/** N4: a confirmed cancellation, or the correction when the flight operates again. */
function renderCancellation(context: Context, intent: Intent): RenderedPush {
  const { designator, flight } = context;
  const route = `${designator} from ${context.origin} to ${context.destination}`;
  if (intent.correction || intent.value === 'uncancelled') {
    return {
      title: `${designator} no longer cancelled`,
      body: `${route} is operating again, earlier reported cancelled. ${departureSentence(context)} ${arrivalSentence(context, false)}`,
    };
  }
  const scheduled = flight.times.scheduledOut;
  const when =
    scheduled === undefined
      ? ''
      : `, scheduled to depart ${localDate(scheduled, flight.origin.tz)} at ${localTime(scheduled, flight.origin.tz, context.format)},`;
  return { title: `${designator} cancelled`, body: `${route}${when} is cancelled.` };
}

/** N4: a confirmed diversion (`value` the airport's ICAO code, or `diverted` when unnamed). */
function renderDiversion(context: Context, intent: Intent): RenderedPush {
  const { designator, flight } = context;
  const named = intent.value !== 'diverted';
  const to = named ? airportCode(flight.actualDestination, intent.value) : '';
  if (intent.correction) {
    return {
      title: `${designator} no longer diverted`,
      body: `${designator} from ${context.origin} is expected at ${context.destination} again, earlier reported diverted. ${arrivalSentence(context)}`,
    };
  }
  return {
    title: named ? `${designator} diverted to ${to}` : `${designator} diverted`,
    body: `${designator} from ${context.origin}, planned to arrive at ${context.destination}, is diverting${named ? ` to ${to}` : ''}. ${departureSentence(context, false)}`,
  };
}

/** The title and body of an intent's push, for a user who reads times in `format`. */
export function renderPush(input: NotifyIntentV1, format: TimeFormat = '12h'): RenderedPush {
  const { flight, intent } = input;
  const context: Context = {
    designator: displayDesignator(flight),
    origin: airportCode(flight.origin),
    destination: airportCode(flight.destination),
    format,
    flight,
  };
  const rendered =
    intent.kind === 'delay'
      ? renderDelay(context, intent)
      : intent.kind === 'gate_change'
        ? renderGate(context, intent)
        : intent.kind === 'cancellation'
          ? renderCancellation(context, intent)
          : intent.kind === 'diversion'
            ? renderDiversion(context, intent)
            : { title: `${context.designator} update`, body: departureSentence(context) };
  return {
    title: clip(rendered.title, PUSH_TITLE_MAX_LENGTH),
    body: clip(rendered.body, PUSH_BODY_MAX_LENGTH),
  };
}
