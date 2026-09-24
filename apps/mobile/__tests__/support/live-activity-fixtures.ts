/**
 * Flight Live Activity content states for the increment 11 tests: the smallest state the shared
 * schema accepts, a full and readable one, and the schema's worst case for size.
 *
 * The worst case is built from the schema's own bounds (`LIVE_ACTIVITY_FIELD_MAX_LENGTH`, ruling
 * Z2), not picked by hand: every field at its longest, every free-text field filled with the
 * character whose double JSON encoding costs the most bytes. __tests__/content-state-size.test.ts
 * proves that no UTF-16 code unit costs more than that character, so no state the schema accepts
 * is larger.
 */

import {
  LIVE_ACTIVITY_FIELD_MAX_LENGTH as MAX,
  LiveActivityContentStateV1,
} from '@planeahead/shared';

export const MINIMAL_CONTENT_STATE = LiveActivityContentStateV1.parse({
  flightKey: 'AAL-100-2026-09-19-KJFK',
  status: 'scheduled',
  scheduledOut: '2026-09-20T03:50:00Z',
  scheduledIn: '2026-09-20T10:50:00Z',
  updatedAt: '2026-09-19T12:00:00Z',
});

/** Every field set with values a real flight has; what the layout tests read. */
export const FULL_CONTENT_STATE = LiveActivityContentStateV1.parse({
  flightKey: 'AAL-9999A-2026-12-31-KJFK-L12',
  designator: 'AAL9999A',
  originIata: 'JFK',
  destinationIata: 'SIN',
  status: 'en_route',
  gate: 'B22A',
  terminal: '8',
  destinationGate: 'C3',
  destinationTerminal: '3',
  scheduledOut: '2026-12-31T23:59:59.999Z',
  estimatedOut: '2026-12-31T23:59:59.999Z',
  actualOut: '2026-12-31T23:59:59.999Z',
  scheduledIn: '2027-01-01T18:59:59.999Z',
  estimatedIn: '2027-01-01T18:59:59.999Z',
  progressPercent: 33.33333333333333,
  baggageClaim: 'Belt 12',
  updatedAt: '2026-12-31T23:59:59.999Z',
});

/**
 * A control character: JSON escapes it as `\u0001` (6 bytes), and the second encoding escapes
 * that backslash again (7 bytes). A double quote costs 4 (`\\\"`), a lone surrogate 7 as well.
 */
export const COSTLIEST_CHARACTER = '\u0001';

function costliest(length: number): string {
  return COSTLIEST_CHARACTER.repeat(length);
}

/** An instant at the schema's longest: nanosecond precision. */
const LONGEST_INSTANT = '2026-12-31T23:59:59.999999999Z';

/** The number in 0 to 100 with the longest JSON form (24 characters). */
export const LONGEST_PROGRESS = 0.0000012345678901234567;

/** The schema's worst case for size: every field at its bound, the costliest characters. */
export const WORST_CASE_CONTENT_STATE = LiveActivityContentStateV1.parse({
  // A five-digit leg: the longest key the content-state bound admits.
  flightKey: 'AAL-9999A-2026-12-31-KJFK-L99999',
  designator: costliest(MAX.designator),
  originIata: 'JFK',
  destinationIata: 'SIN',
  // The longest status names (`scheduled` is as long).
  status: 'cancelled',
  gate: costliest(MAX.gate),
  terminal: costliest(MAX.terminal),
  destinationGate: costliest(MAX.gate),
  destinationTerminal: costliest(MAX.terminal),
  scheduledOut: LONGEST_INSTANT,
  estimatedOut: LONGEST_INSTANT,
  actualOut: LONGEST_INSTANT,
  scheduledIn: LONGEST_INSTANT,
  estimatedIn: LONGEST_INSTANT,
  progressPercent: LONGEST_PROGRESS,
  baggageClaim: costliest(MAX.baggageClaim),
  updatedAt: LONGEST_INSTANT,
});

/** The review's probe shape: the same bounds filled with double quotes (4 bytes each, twice encoded). */
export const QUOTE_HEAVY_CONTENT_STATE = LiveActivityContentStateV1.parse({
  ...WORST_CASE_CONTENT_STATE,
  designator: '"'.repeat(MAX.designator),
  gate: '"'.repeat(MAX.gate),
  terminal: '"'.repeat(MAX.terminal),
  destinationGate: '"'.repeat(MAX.gate),
  destinationTerminal: '"'.repeat(MAX.terminal),
  baggageClaim: '"'.repeat(MAX.baggageClaim),
});
