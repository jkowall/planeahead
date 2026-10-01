/**
 * src/lib/boards.ts and src/components/BoardRow.tsx, the pure parts (increment 18, ruling B12):
 * every status and code the two routes answer maps to one failure (by code, never by message),
 * the airport-code check matches the API's, and a row's time line labels a revised time
 * cautiously ("Expected") and says nothing when it equals the schedule.
 */

import { boardRowText } from '../src/components/BoardRow';
import { failureOf, validateAirportCode, validateRouteSearch } from '../src/lib/boards';
import { displayPrefsOf } from '../src/lib/display-prefs';
import { boardRow } from './support/board-fixtures';

jest.mock('../src/lib/services', () => ({ services: jest.fn() }));

describe('failureOf', () => {
  it.each([
    [400, 'validation_failed', 'invalid'],
    [401, 'unauthenticated', 'signed_out'],
    [403, 'board_requires_account', 'requires_account'],
    [403, 'cap_exceeded', 'cap_exceeded'],
    [403, 'forbidden', 'other'],
    [404, 'airport_not_found', 'airport_not_found'],
    [404, 'board_not_covered', 'not_covered'],
    [422, 'date_out_of_range', 'out_of_range'],
    [422, 'validation_failed', 'invalid'],
    [429, 'rate_limited', 'rate_limited'],
    [503, 'board_unavailable', 'unavailable'],
    [504, 'upstream_timeout', 'timeout'],
    [500, 'internal', 'other'],
  ] as const)('%p %s is %s', (status, error, failure) => {
    expect(failureOf(status, { error, message: 'm' }, null).failure).toBe(failure);
  });

  it('keeps the limit, the lookahead and Retry-After; ignores an unreadable Retry-After', () => {
    const capped = failureOf(403, { error: 'cap_exceeded', limit: 30 }, null);
    expect(capped.limit).toBe(30);
    expect(failureOf(422, { error: 'date_out_of_range', maxDaysAhead: 7 }, null).maxDaysAhead).toBe(
      7,
    );
    expect(failureOf(429, null, '45').retryAfterSeconds).toBe(45);
    expect(failureOf(429, null, 'soon').retryAfterSeconds).toBeUndefined();
  });
});

describe('airport codes', () => {
  it.each([
    [' jfk ', 'JFK'],
    ['katl', 'KATL'],
    ['JF', null],
    ['KJFKX', null],
    ['', null],
  ])('reads %p as %p', (input, code) => {
    const checked = validateAirportCode(input);
    expect(checked.ok ? checked.code : null).toBe(code);
  });

  it('refuses a route from an airport to itself, as typed', () => {
    const result = validateRouteSearch({ origin: 'lhr', destination: 'LHR', date: '2026-09-23' });
    expect(result.ok ? null : result.errors).toEqual({
      destination: 'The destination cannot be the origin.',
    });
  });
});

describe('boardRowText', () => {
  const prefs = displayPrefsOf({ timeFormat: '24h', distanceUnit: 'km', showLocalTimes: true });

  it('says nothing more when the revised time is the scheduled one', () => {
    const text = boardRowText(
      boardRow({ estimated: '2026-09-23T22:00:30Z', codeshares: [] }),
      'departures',
      'America/New_York',
      prefs,
    );
    expect(text).toMatchObject({ scheduled: '18:00', later: null, late: false });
    expect(text.detail).toBe('Terminal 8, gate 12');
  });

  it('labels an earlier revised time as expected, not late', () => {
    const text = boardRowText(
      boardRow({ estimated: '2026-09-23T21:50:00Z' }),
      'departures',
      'America/New_York',
      prefs,
    );
    expect(text).toMatchObject({ later: 'Expected 17:50', late: false, counterpart: 'to LHR' });
  });
});
