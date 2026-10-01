/**
 * src/lib/boards.ts and src/components/BoardRow.tsx, the pure parts (increment 18, ruling B12):
 * every status and code the two routes answer maps to one failure (by code, never by message),
 * the airport-code check matches the API's, and a row's time line labels a revised time
 * cautiously ("Expected") and says nothing when it equals the schedule.
 *
 * The review round (increment 18): the shapes part S1 answers (404 `boards_disabled`, the cap's
 * `scope`, `BOARD_IP_RL`'s 429, the board's 72-hour bound) and what each says (R8, R11); an
 * arrival "Arrived" and no expected time on a cancelled row (R15); and when a route search is
 * asked again (R10).
 */

import { boardRowText } from '../src/components/BoardRow';
import {
  boardFailureMessage,
  failureOf,
  ROUTE_SEARCH_STALE_MS,
  routeSearchAsksAgain,
  routeSearchFailureMessage,
  validateAirportCode,
  validateRouteSearch,
} from '../src/lib/boards';
import { displayPrefsOf } from '../src/lib/display-prefs';
import { boardRow } from './support/board-fixtures';

jest.mock('../src/lib/services', () => ({ services: jest.fn() }));

const SEARCH = { origin: 'JFK', destination: 'LHR', date: '2026-09-23' };

describe('failureOf', () => {
  it.each([
    [400, 'validation_failed', 'invalid'],
    [401, 'unauthenticated', 'signed_out'],
    [403, 'board_requires_account', 'requires_account'],
    [403, 'cap_exceeded', 'cap_exceeded'],
    [403, 'forbidden', 'other'],
    [404, 'airport_not_found', 'airport_not_found'],
    [404, 'board_not_covered', 'not_covered'],
    [404, 'boards_disabled', 'boards_disabled'],
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

  it("reads part S1's shapes: the cap's scope, the address brake, the board's hour bound", () => {
    const cap = { error: 'cap_exceeded', cap: 'route_searches', limit: 30, message: 'm' };
    const ip = failureOf(403, { ...cap, scope: 'ip', requestId: 'r' }, null);
    expect([ip.failure, ip.limit, ip.scope]).toEqual(['cap_exceeded', 30, 'ip']);
    expect(failureOf(403, { ...cap, scope: 'user' }, null).scope).toBe('user');
    // A scope this build does not know is no scope: the account's own message.
    const odd = failureOf(403, { ...cap, scope: 'planet' }, null);
    expect([odd.failure, odd.limit, odd.scope]).toEqual(['cap_exceeded', 30, undefined]);
    // BOARD_IP_RL's 429 is the same brake to the app, with its Retry-After.
    const braked = failureOf(
      429,
      { error: 'rate_limited', limiter: 'BOARD_IP_RL', requestId: 'r' },
      '60',
    );
    expect([braked.failure, braked.retryAfterSeconds]).toEqual(['rate_limited', 60]);
    expect(boardFailureMessage(braked, 'JFK')).toBe(
      'Too many boards opened in a short time. Wait a minute and pull down to try again.',
    );
    // A board window past 72 hours names hours, not days: the generic out-of-range text.
    const far = failureOf(
      422,
      { error: 'date_out_of_range', message: 'm', requestId: 'r', maxHoursAhead: 72 },
      null,
    );
    expect([far.failure, far.maxDaysAhead]).toEqual(['out_of_range', undefined]);
    expect(boardFailureMessage(far, 'JFK')).toBe(
      'This board is outside the dates flight data covers.',
    );
    expect(routeSearchFailureMessage(far, SEARCH)).toBe(
      'That date is outside the dates flight data covers.',
    );
  });
});

describe('what a refusal says', () => {
  it('says boards are not available yet, on both screens (R8)', () => {
    const off = failureOf(
      404,
      { error: 'boards_disabled', message: 'airport boards are not available yet', requestId: 'r' },
      null,
    );
    expect(boardFailureMessage(off, 'JFK')).toBe('Airport boards are not available yet.');
    expect(routeSearchFailureMessage(off, SEARCH)).toBe(
      'Finding a flight by route is not available yet. Add the flight by its number instead.',
    );
  });

  it("tells an account held by its network's cap to sign in, and keeps its own cap's text (R11)", () => {
    const cap = { error: 'cap_exceeded', cap: 'route_searches', limit: 30, message: 'm' };
    expect(routeSearchFailureMessage(failureOf(403, { ...cap, scope: 'ip' }, null), SEARCH)).toBe(
      'Without an account, route searches are limited to 30 a day per network, and this network’s are used up today. Sign in to keep searching, or add the flight by its number.',
    );
    const own =
      'Route searches are limited to 30 a day, and today’s are used up. Search again tomorrow, or add the flight by its number.';
    expect(routeSearchFailureMessage(failureOf(403, { ...cap, scope: 'user' }, null), SEARCH)).toBe(
      own,
    );
    expect(routeSearchFailureMessage(failureOf(403, cap, null), SEARCH)).toBe(own);
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

  it('says an arrival arrived at its in-block time, not landed (R15)', () => {
    const text = boardRowText(
      boardRow({ status: 'arrived', actual: '2026-09-23T22:20:00Z' }),
      'arrivals',
      'America/New_York',
      prefs,
    );
    expect(text).toMatchObject({ later: 'Arrived 18:20', late: true, counterpart: 'from LHR' });
    expect(text.label).toContain('arrived 18:20');
    expect(text.label).not.toMatch(/landed/i);
  });

  it('shows no expected time on a cancelled flight, whatever estimate it kept (R15)', () => {
    // The fixture's estimate is 18:25, 25 minutes after the schedule.
    const text = boardRowText(
      boardRow({ status: 'cancelled' }),
      'departures',
      'America/New_York',
      prefs,
    );
    expect(text).toMatchObject({ scheduled: '18:00', later: null, late: false });
    expect(text.label).not.toMatch(/expected/i);
  });
});

describe('routeSearchAsksAgain (R10)', () => {
  const T0 = Date.parse('2026-09-23T14:00:00Z');
  const answered = { status: 'success', isFetching: false, dataUpdatedAt: T0 } as const;

  it.each([
    ['a fresh answer', answered, T0 + ROUTE_SEARCH_STALE_MS - 1, false],
    ['an answer as old as the stale time', answered, T0 + ROUTE_SEARCH_STALE_MS, true],
    ['a failed answer', { ...answered, status: 'error' }, T0, true],
    ['a search still running', { ...answered, status: 'error', isFetching: true }, T0, false],
    [
      'no answer yet (offline, it waits)',
      { ...answered, status: 'pending', dataUpdatedAt: 0 },
      T0,
      false,
    ],
  ] as const)('%s: %p', (_name, query, nowMs, expected) => {
    expect(routeSearchAsksAgain(query, nowMs)).toBe(expected);
  });
});
