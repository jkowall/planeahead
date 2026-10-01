import { DEFAULT_CADENCE_PARAMS, MINUTE_MS } from './cadence';
import {
  tolerantEnum,
  type FieldQuality,
  type FlightStatusValue,
  type FlightTimeField,
} from './flight-status';

/**
 * Status derivation (increment 6, facts sheet decision 9). Our nine-value `FlightStatusValue` is
 * derived from boolean flags and OOOI timestamps only. Neither provider's status STRING is ever
 * mapped onto it: AeroAPI's `status` has no enum and no example anywhere in the 4.17.1 spec, and
 * a mapping table built from FlightAware's web wording would be built on an undocumented
 * vocabulary. AeroDataBox's `FlightStatus` enum is used for two narrow things only, both here:
 * which of its single `revisedTime` values is an actual rather than an estimate
 * (`disambiguateRevisedTime`), and the `cancelled` and `diverted` flags the enum is the only
 * carrier of (`adbFlags`). Nothing here reads the wall clock; `now` is an input.
 */

/** AeroDataBox `FlightStatus` (direct-gateway OpenAPI 1.15.3.0), in the spec's order. */
export const ADB_STATUSES = [
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
] as const;
export type AdbStatus = (typeof ADB_STATUSES)[number];
/** A status AeroDataBox adds later parses as `Unknown`, which disambiguates as an estimate. */
export const AdbStatusSchema = tolerantEnum(ADB_STATUSES, 'Unknown');

/** An instant as providers and snapshots carry it: an ISO string, or a `Date`. */
export type Instant = string | Date;

function toMs(value: Instant | null | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export interface DeriveStatusInput {
  cancelled: boolean;
  diverted: boolean;
  actualOut?: Instant | undefined;
  actualOff?: Instant | undefined;
  actualOn?: Instant | undefined;
  actualIn?: Instant | undefined;
  /** Absent (or unparseable) with no actuals means the status is `unknown`. */
  scheduledOut?: Instant | undefined;
  /** The latest departure estimate, which moves the boarding window of a delayed flight. */
  estimatedOut?: Instant | undefined;
  now: Date;
  /** Defaults to the cadence's boarding anchor (`DEFAULT_CADENCE_PARAMS`, 40 minutes). */
  boardingMinutesBefore?: number | undefined;
}

/**
 * The nine-value status from flags and OOOI timestamps, first match wins:
 *
 * 1. `cancelled`, then `diverted` (a diverted flight keeps that status after it lands at the
 *    alternate; `actualDestination` says where).
 * 2. The furthest OOOI actual: `in` is `arrived`, `on` is `landed`, `off` is `en_route`, `out`
 *    is `departed` (pushed back, not yet airborne).
 * 3. No actuals: `boarding` from `boardingMinutesBefore` ahead of the departure estimate (or the
 *    schedule) onwards, `scheduled` before it, and `unknown` when there is no departure time.
 *
 * An actual that does not parse counts as absent. There is no boarding event in either
 * provider's data (AeroAPI has no boarding concept), so `boarding` is the cadence's own anchor.
 */
export function deriveStatus(input: DeriveStatusInput): FlightStatusValue {
  if (input.cancelled) {
    return 'cancelled';
  }
  if (input.diverted) {
    return 'diverted';
  }
  if (toMs(input.actualIn) !== undefined) {
    return 'arrived';
  }
  if (toMs(input.actualOn) !== undefined) {
    return 'landed';
  }
  if (toMs(input.actualOff) !== undefined) {
    return 'en_route';
  }
  if (toMs(input.actualOut) !== undefined) {
    return 'departed';
  }
  const reference = toMs(input.estimatedOut) ?? toMs(input.scheduledOut);
  if (reference === undefined) {
    return 'unknown';
  }
  const boardingMinutes =
    input.boardingMinutesBefore ?? DEFAULT_CADENCE_PARAMS.boardingMinutesBefore;
  return input.now.getTime() >= reference - boardingMinutes * MINUTE_MS ? 'boarding' : 'scheduled';
}

/**
 * The `cancelled` and `diverted` flags an AeroDataBox status carries. AeroDataBox has no
 * boolean flags of its own, so the enum is the only source. `CanceledUncertain` ("status of
 * the flight is uncertain, may be cancelled") is NOT a cancellation: the flight keeps being
 * polled and the next answer decides.
 */
export function adbFlags(status: AdbStatus): { cancelled: boolean; diverted: boolean } {
  return { cancelled: status === 'Canceled', diverted: status === 'Diverted' };
}

/**
 * Whether AeroDataBox marks its own status as uncertain: `CanceledUncertain`, and `Unknown`
 * (which is also what a status this build does not know parses as). The adapter sets
 * `FlightStatus.statusUncertain` from it, and the notification policy reads such an answer as
 * inconclusive: it neither confirms nor clears a suspicion (increment 15, review ruling Q11).
 */
export function adbStatusUncertain(status: AdbStatus): boolean {
  return status === 'CanceledUncertain' || status === 'Unknown';
}

/** Which end of the flight an AeroDataBox movement contract describes. */
export type AdbMovement = 'departure' | 'arrival';
/** `gate` is `revisedTime` (out or in); `runway` is `runwayTime` (off or on). */
export type AdbTimeKind = 'gate' | 'runway';

/** Statuses at which the aircraft has left the origin, so a departure time is an actual. */
const DEPARTED_STATUSES: ReadonlySet<AdbStatus> = new Set<AdbStatus>([
  'Departed',
  'EnRoute',
  'Approaching',
  'Arrived',
  'Diverted',
]);

/**
 * Statuses at which the aircraft is at the destination, so an arrival time is an actual. A
 * `Diverted` flight's arrival time is NOT treated as an actual: whether AeroDataBox rewrites
 * the arrival airport to the alternate is undocumented (facts sheet section 1, unverified).
 */
const ARRIVED_STATUSES: ReadonlySet<AdbStatus> = new Set<AdbStatus>(['Arrived']);

/** True when a time on `movement` is an actual at `status`, false when it is an estimate. */
export function isActualAt(movement: AdbMovement, status: AdbStatus): boolean {
  return movement === 'departure' ? DEPARTED_STATUSES.has(status) : ARRIVED_STATUSES.has(status);
}

const FIELDS: Readonly<
  Record<AdbMovement, Record<AdbTimeKind, { actual: FlightTimeField; estimated: FlightTimeField }>>
> = {
  departure: {
    gate: { actual: 'actualOut', estimated: 'estimatedOut' },
    runway: { actual: 'actualOff', estimated: 'estimatedOff' },
  },
  arrival: {
    gate: { actual: 'actualIn', estimated: 'estimatedIn' },
    runway: { actual: 'actualOn', estimated: 'estimatedOn' },
  },
};

export interface RevisedTime {
  /** The `FlightTimes` field the value belongs in. */
  field: FlightTimeField;
  /** The instant, as an ISO string in UTC. */
  value: string;
  /** `live` for an actual, `estimated` for an estimate; recorded in `fieldQuality`. */
  quality: Extract<FieldQuality, 'live' | 'estimated'>;
  /** `value` minus `scheduled` in whole seconds, when the schedule is known. */
  delaySec?: number | undefined;
}

/**
 * Maps AeroDataBox's single `revisedTime` (documented as "Actual / estimated time") or
 * `runwayTime` ("Actual / estimated time on the runway") to the estimated or the actual field of
 * one movement, decided by the status enum and nothing else: a departure time is an actual once
 * the flight has left (`Departed`, `EnRoute`, `Approaching`, `Arrived`, `Diverted`), an arrival
 * time once it has `Arrived`; every other status, including `Unknown` and any status this build
 * does not know, reads as an estimate. `revised` and `scheduled` are ISO instants (the parsed
 * `.utc` of the contract, never `.local`). Returns null when there is no revised time.
 *
 * `revisedTime` is treated as the gate time. The spec says it is the gate time when a
 * different `runwayTime` is present and "may either be time at the gate or on the runway"
 * otherwise, which no status can settle; the gate reading is the documented default.
 */
export function disambiguateRevisedTime(
  status: AdbStatus,
  revised: string | undefined,
  scheduled: string | undefined,
  movement: AdbMovement,
  kind: AdbTimeKind = 'gate',
): RevisedTime | null {
  const revisedMs = toMs(revised);
  if (revised === undefined || revisedMs === undefined) {
    return null;
  }
  const actual = isActualAt(movement, status);
  const fields = FIELDS[movement][kind];
  const scheduledMs = toMs(scheduled);
  const result: RevisedTime = {
    field: actual ? fields.actual : fields.estimated,
    value: new Date(revisedMs).toISOString(),
    quality: actual ? 'live' : 'estimated',
  };
  if (scheduledMs !== undefined) {
    result.delaySec = Math.round((revisedMs - scheduledMs) / 1_000);
  }
  return result;
}
