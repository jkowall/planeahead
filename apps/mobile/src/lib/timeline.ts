/**
 * The detail screen's timeline (increment 10, ruling T4), built from the flight snapshot on the
 * subscription row: scheduled, estimated and actual out, off, on and in, the gates and
 * terminals, the baggage claim and the status. Not from `flight_events`: the sync feed's
 * `flights[]` carries `FlightStatus` snapshots and no event rows in Phase 0, so the snapshot is
 * all the device has (the spec's `timeline_summary` wording is recorded as a deviation in
 * docs/increments/10-verification.md, for increment 12's docs).
 *
 * Out and in are always shown (the row's own columns); off and on only when the snapshot has a
 * time for them, since most schedule-quality snapshots carry none. Pure.
 */

import type { FlightItem } from './flight-model';

export type TimelineStepKey = 'out' | 'off' | 'on' | 'in' | 'baggage';
export type TimelineStepState = 'done' | 'next' | 'upcoming' | 'cancelled';

export interface TimelineStep {
  readonly key: TimelineStepKey;
  readonly title: string;
  readonly scheduled: string | null;
  readonly estimated: string | null;
  readonly actual: string | null;
  /** The airport zone the step's times are shown in (origin for out and off). */
  readonly timeZone: string | null;
  /** `Terminal 8, gate B22`, `Baggage claim 5`, or null. */
  readonly place: string | null;
  readonly state: TimelineStepState;
  /** Best known time minus scheduled, in minutes; null when either is missing. */
  readonly deltaMinutes: number | null;
}

export function terminalAndGate(terminal: string | null, gate: string | null): string | null {
  const parts = [
    terminal === null ? null : `Terminal ${terminal}`,
    gate === null ? null : terminal === null ? `Gate ${gate}` : `gate ${gate}`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(', ');
}

function delta(scheduled: string | null, best: string | null): number | null {
  if (scheduled === null || best === null) {
    return null;
  }
  const a = Date.parse(scheduled);
  const b = Date.parse(best);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 60_000);
}

interface RawStep {
  readonly key: TimelineStepKey;
  readonly title: string;
  readonly scheduled: string | null;
  readonly estimated: string | null;
  readonly actual: string | null;
  readonly timeZone: string | null;
  readonly place: string | null;
  /** Happened, even without an actual time (a status that is past this step). */
  readonly reached: boolean;
}

const PAST_OUT = new Set(['departed', 'en_route', 'landed', 'arrived', 'diverted']);
const PAST_ON = new Set(['landed', 'arrived']);

export function buildTimeline(item: FlightItem): TimelineStep[] {
  const times = item.snapshot?.times ?? {};
  const status = item.status ?? 'unknown';
  const raw: RawStep[] = [
    {
      key: 'out',
      title: 'Gate departure',
      scheduled: item.scheduledOut,
      estimated: item.estimatedOut,
      actual: item.actualOut,
      timeZone: item.origin.tz,
      place: terminalAndGate(item.origin.terminal, item.origin.gate),
      reached: item.actualOut !== null || PAST_OUT.has(status),
    },
    {
      key: 'off',
      title: 'Takeoff',
      scheduled: times.scheduledOff ?? null,
      estimated: times.estimatedOff ?? null,
      actual: times.actualOff ?? null,
      timeZone: item.origin.tz,
      place: null,
      reached: times.actualOff !== undefined || status === 'en_route' || PAST_ON.has(status),
    },
    {
      key: 'on',
      title: 'Landing',
      scheduled: times.scheduledOn ?? null,
      estimated: times.estimatedOn ?? null,
      actual: times.actualOn ?? null,
      timeZone: item.destination.tz,
      place: null,
      reached: times.actualOn !== undefined || PAST_ON.has(status),
    },
    {
      key: 'in',
      title: 'Gate arrival',
      scheduled: item.scheduledIn,
      estimated: item.estimatedIn,
      actual: item.actualIn,
      timeZone: item.destination.tz,
      place: terminalAndGate(item.destination.terminal, item.destination.gate),
      reached: item.actualIn !== null || status === 'arrived',
    },
  ];
  const shown = raw.filter(
    (step) =>
      step.key === 'out' ||
      step.key === 'in' ||
      step.scheduled !== null ||
      step.estimated !== null ||
      step.actual !== null,
  );
  if (item.baggageClaim !== null) {
    shown.push({
      key: 'baggage',
      title: 'Baggage',
      scheduled: null,
      estimated: null,
      actual: null,
      timeZone: item.destination.tz,
      place: `Baggage claim ${item.baggageClaim}`,
      reached: status === 'arrived',
    });
  }

  let nextAssigned = false;
  return shown.map((step): TimelineStep => {
    let state: TimelineStepState;
    if (status === 'cancelled') {
      state = 'cancelled';
    } else if (step.reached) {
      state = 'done';
    } else if (!nextAssigned) {
      state = 'next';
      nextAssigned = true;
    } else {
      state = 'upcoming';
    }
    const best = step.actual ?? step.estimated;
    return {
      key: step.key,
      title: step.title,
      scheduled: step.scheduled,
      estimated: step.estimated,
      actual: step.actual,
      timeZone: step.timeZone,
      place: step.place,
      state,
      deltaMinutes: delta(step.scheduled, best),
    };
  });
}
