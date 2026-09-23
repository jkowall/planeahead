/**
 * The cadence context a flight's OOOI instants and phase make (increment 7). Shared by the
 * FlightTracker (from its `flight` row scalars) and the DesignatorResolver (from a status it
 * just fetched, to decide whether a tracker is worth creating at all, ruling L9): the two must
 * agree on what "nothing left to schedule" means, so the derivation lives in one place.
 */

import {
  refreshIntervalFor,
  type CadenceContext,
  type CadenceDefinition,
  type FlightStatus,
  type TrackerPhase,
} from '@planeahead/shared';

/** Block time assumed when a flight carries no scheduled arrival. */
export const DEFAULT_BLOCK_MS = 3 * 60 * 60_000;
/** The tier interval assumed for a fixed-slot window when a freshness rule needs one. */
export const FIXED_SLOT_TIER_MS_DEFAULT = 15 * 60_000;

/** A flight whose status says it is over: the resolver seeds no tracker for one past its tail. */
export const TERMINAL_FLIGHT_STATUSES: readonly string[] = ['arrived', 'cancelled'];

export interface FlightInstants {
  readonly scheduledOutMs: number | null;
  readonly scheduledInMs: number | null;
  readonly estimatedInMs: number | null;
  readonly actualOffMs: number | null;
  readonly actualOnMs: number | null;
  readonly actualInMs: number | null;
  readonly phase: TrackerPhase;
}

export function instantMs(instant: string | undefined): number | null {
  if (instant === undefined) {
    return null;
  }
  const value = Date.parse(instant);
  return Number.isNaN(value) ? null : value;
}

/** The instants a status carries, in the shape the tracker stores them. */
export function instantsOf(status: FlightStatus): FlightInstants {
  return {
    scheduledOutMs: instantMs(status.times.scheduledOut),
    scheduledInMs: instantMs(status.times.scheduledIn),
    estimatedInMs: instantMs(status.times.estimatedIn),
    actualOffMs: instantMs(status.times.actualOff),
    actualOnMs: instantMs(status.times.actualOn),
    actualInMs: instantMs(status.times.actualIn),
    phase: status.status,
  };
}

/** The context `refreshIntervalFor` wants, or null when the flight has no scheduled departure. */
export function cadenceContextFor(instants: FlightInstants, now: number): CadenceContext | null {
  if (instants.scheduledOutMs === null) {
    return null;
  }
  const scheduledIn = instants.scheduledInMs ?? instants.scheduledOutMs + DEFAULT_BLOCK_MS;
  const context: CadenceContext = {
    now: new Date(now),
    scheduledOut: new Date(instants.scheduledOutMs),
    scheduledIn: new Date(scheduledIn),
    phase: instants.phase,
  };
  if (instants.estimatedInMs !== null) {
    context.estimatedIn = new Date(instants.estimatedInMs);
  }
  if (instants.actualOffMs !== null) {
    context.actualOff = new Date(instants.actualOffMs);
  }
  if (instants.actualOnMs !== null) {
    context.actualOn = new Date(instants.actualOnMs);
  }
  if (instants.actualInMs !== null) {
    context.actualIn = new Date(instants.actualInMs);
  }
  return context;
}

/**
 * True when the status is terminal AND the cadence has no slot left after `now` (the tail poll
 * included): the flight is over, and a tracker seeded from it would only finish and wait 22
 * hours to delete itself. The resolver answers such a search from the status instead (L9).
 */
export function flightIsOver(
  cadence: CadenceDefinition,
  status: FlightStatus,
  now: number,
): boolean {
  if (!TERMINAL_FLIGHT_STATUSES.includes(status.status)) {
    return false;
  }
  const context = cadenceContextFor(instantsOf(status), now);
  return context === null || refreshIntervalFor(cadence, context) === null;
}
