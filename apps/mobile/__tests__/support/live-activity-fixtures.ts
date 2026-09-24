/**
 * Flight Live Activity content states for the increment 11 tests: the smallest state the shared
 * schema accepts, and a worst case (every field set, the longest flight key the key grammar
 * allows, generous gate, terminal and baggage strings, millisecond instants, a long float).
 */

import { LiveActivityContentStateV1 } from '@planeahead/shared';

export const MINIMAL_CONTENT_STATE = LiveActivityContentStateV1.parse({
  flightKey: 'AAL-100-2026-09-19-KJFK',
  status: 'scheduled',
  scheduledOut: '2026-09-20T03:50:00Z',
  scheduledIn: '2026-09-20T10:50:00Z',
  updatedAt: '2026-09-19T12:00:00Z',
});

export const WORST_CASE_CONTENT_STATE = LiveActivityContentStateV1.parse({
  // Four-digit number with a suffix letter and a two-digit leg: the key grammar's longest form.
  flightKey: 'AAL-9999A-2026-12-31-KJFK-L12',
  designator: 'AAL9999A',
  originIata: 'JFK',
  destinationIata: 'SIN',
  status: 'cancelled',
  gate: 'GATE-B22A-EAST01',
  terminal: 'Terminal 3 International Concour',
  scheduledOut: '2026-12-31T23:59:59.999Z',
  estimatedOut: '2026-12-31T23:59:59.999Z',
  actualOut: '2026-12-31T23:59:59.999Z',
  scheduledIn: '2027-01-01T18:59:59.999Z',
  estimatedIn: '2027-01-01T18:59:59.999Z',
  progressPercent: 33.33333333333333,
  baggageClaim: 'Belt 12 and oversize counter 4',
  updatedAt: '2026-12-31T23:59:59.999Z',
});
