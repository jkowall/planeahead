/**
 * Ruling B7 (increment 18): codeshare grouping, the filters after the cache, the UI row, the
 * combination of a request's buckets, and the ETag. From the review round: keyless codeshares
 * and each flight once (R12), delayed flights kept (R14), `partial` never for a range out of
 * reach (R10). Pure; synthetic rows only.
 */

import { describe, expect, it } from 'vitest';
import type { BoardBucketResponseV1, BoardRow } from '@planeahead/shared';
import {
  boardEtag,
  boardViewRow,
  combineBuckets,
  etagMatches,
  filterGroups,
  groupCodeshares,
} from '../../src/boards/view';

const T0 = '2026-10-02T13:00:00Z';
const LHR = { icao: 'EGLL', iata: 'LHR' };

function row(designator: string, overrides: Partial<BoardRow> = {}): BoardRow {
  const iata = designator.slice(0, 2);
  return {
    direction: 'dep',
    designator,
    flightNumber: designator.slice(2),
    marketingCarrierIata: iata,
    marketingCarrierIcao: { AA: 'AAL', BA: 'BAW', IB: 'IBE', QR: 'QTR', DL: 'DAL' }[iata] ?? 'XXX',
    counterpart: LHR,
    scheduled: T0,
    status: 'scheduled',
    codeshares: [],
    source: 'aerodatabox',
    ...overrides,
  };
}

/** AA100 to Heathrow with two codeshares, the codeshares listed first as FIDS may list them. */
function aa100(): BoardRow[] {
  const operated = { registration: 'N101NN', operatingCarrierIcao: 'AAL', flightNumber: '100' };
  return [
    row('BA1511', { ...operated, codeshareStatus: 'IsCodeshared' }),
    row('AA100', { ...operated, codeshareStatus: 'IsOperator' }),
    row('IB4218', { ...operated, codeshareStatus: 'IsCodeshared' }),
  ];
}

describe('groupCodeshares (R3 D7)', () => {
  it('groups by time, counterpart and registration, the IsOperator row first', () => {
    const groups = groupCodeshares(aa100());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.primary.designator).toBe('AA100');
    expect(groups[0]?.others.map((r) => r.designator)).toEqual(['BA1511', 'IB4218']);
  });

  it('groups by callsign when there is no registration, and joins chains of either key', () => {
    const groups = groupCodeshares([
      row('AA200', { callSign: 'AAL200', codeshareStatus: 'IsOperator' }),
      row('BA2000', { callSign: 'AAL200', registration: 'N202NN' }),
      row('QR3000', { registration: 'N202NN' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.others.map((r) => r.designator)).toEqual(['BA2000', 'QR3000']);
  });

  it('never merges across times, counterparts or directions, nor rows without either key', () => {
    const groups = groupCodeshares([
      row('AA1', { registration: 'N1' }),
      row('AA2', { registration: 'N1', scheduled: '2026-10-02T13:05:00Z' }),
      row('AA3', { registration: 'N1', counterpart: { icao: 'KJFK', iata: 'JFK' } }),
      row('AA4', { registration: 'N1', direction: 'arr' }),
      row('AA5'),
      row('BA5'),
    ]);
    expect(groups.map((g) => g.primary.designator)).toEqual([
      'AA1',
      'AA2',
      'AA3',
      'AA4',
      'AA5',
      'BA5',
    ]);
  });

  it('reads one instant however it is spelled', () => {
    const groups = groupCodeshares([
      row('AA9', { registration: 'N9', scheduled: '2026-10-02T13:00:00.000Z' }),
      row('BA9', { registration: 'N9' }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('without an IsOperator row, prefers the row its own operator markets, else the first', () => {
    const own = groupCodeshares([
      row('BA7', { registration: 'N7', operatingCarrierIcao: 'AAL' }),
      row('AA7', { registration: 'N7', operatingCarrierIcao: 'AAL' }),
    ]);
    expect(own[0]?.primary.designator).toBe('AA7');
    const first = groupCodeshares([
      row('QR8', { registration: 'N8' }),
      row('BA8', { registration: 'N8' }),
    ]);
    expect(first[0]?.primary.designator).toBe('QR8');
  });

  it("review B's case: keyless codeshares join the only IsOperator row of their slot (R12)", () => {
    const [group, ...rest] = groupCodeshares([
      row('BA1511', { codeshareStatus: 'IsCodeshared' }),
      row('AA100', { codeshareStatus: 'IsOperator', operatingCarrierIcao: 'AAL' }),
      row('IB4218', { codeshareStatus: 'IsCodeshared' }),
    ]);
    expect(rest).toEqual([]);
    expect(group?.primary.designator).toBe('AA100');
    expect(boardViewRow(group!, 'KJFK').codeshares).toEqual(['BA1511', 'IB4218']);
  });

  it('a keyless codeshare stays alone with no IsOperator row in its slot, or several (R12)', () => {
    const designators = (rows: BoardRow[]) =>
      groupCodeshares(rows).map((g) => [g.primary.designator, g.others.length]);
    expect(
      designators([
        row('BA1', { codeshareStatus: 'IsCodeshared' }),
        row('AA1', { codeshareStatus: 'Unknown' }),
      ]),
    ).toEqual([
      ['BA1', 0],
      ['AA1', 0],
    ]);
    expect(
      designators([
        row('AA2', { codeshareStatus: 'IsOperator' }),
        row('DL2', { codeshareStatus: 'IsOperator' }),
        row('BA2', { codeshareStatus: 'IsCodeshared' }),
      ]),
    ).toEqual([
      ['AA2', 0],
      ['DL2', 0],
      ['BA2', 0],
    ]);
    // Never across a minute, a counterpart or a direction.
    expect(
      designators([
        row('AA3', { codeshareStatus: 'IsOperator' }),
        row('BA3', { codeshareStatus: 'IsCodeshared', scheduled: '2026-10-02T13:01:00Z' }),
        row('IB3', { codeshareStatus: 'IsCodeshared', counterpart: { icao: 'KJFK', iata: 'JFK' } }),
        row('QR3', { codeshareStatus: 'IsCodeshared', direction: 'arr' }),
      ]),
    ).toHaveLength(4);
  });

  it('lists a flight two buckets return once, first copy kept, before grouping (R12)', () => {
    const evening = aa100().map((r) => ({ ...r, gate: 'B12' }));
    const keyless = row('DL40', { scheduled: '2026-10-02T14:00:00Z' });
    const at1330 = '2026-10-02T13:30:00Z';
    const groups = groupCodeshares([
      ...aa100(),
      keyless,
      row('AA200', { codeshareStatus: 'IsOperator', scheduled: at1330 }),
      row('BA2000', { codeshareStatus: 'IsCodeshared', scheduled: at1330 }),
      ...evening,
      { ...keyless },
      row('AA200', { codeshareStatus: 'IsOperator', scheduled: '2026-10-02T13:30:00.000Z' }),
    ]);
    expect(groups.map((g) => [g.primary.designator, g.others.map((r) => r.designator)])).toEqual([
      ['AA100', ['BA1511', 'IB4218']],
      ['DL40', []],
      // The doubled IsOperator row is still the only one of its slot.
      ['AA200', ['BA2000']],
    ]);
    expect(groups[0]?.primary.gate).toBeUndefined();
    const ids = groups.map((g) => boardViewRow(g, 'KJFK').id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('filterGroups (R3 D8)', () => {
  const groups = groupCodeshares([
    ...aa100(),
    row('DL50', { scheduled: '2026-10-02T12:59:00Z' }),
    row('DL60', { scheduled: '2026-10-02T15:00:00Z' }),
    row('DL40', { scheduled: '2026-10-02T14:00:00Z' }),
    row('BA80', { direction: 'arr', scheduled: '2026-10-02T13:30:00Z' }),
  ]);
  const from = Date.parse(T0);
  const window = { direction: 'dep' as const, fromMs: from, toMs: from + 2 * 3_600_000 };

  it('keeps [from, to) of one direction, by time', () => {
    const kept = filterGroups(groups, window).map((g) => g.primary.designator);
    expect(kept).toEqual(['AA100', 'DL40']);
    expect(
      filterGroups(groups, { ...window, direction: 'arr' }).map((g) => g.primary.designator),
    ).toEqual(['BA80']);
  });

  it('matches an airline as operator or as any marketing carrier of the group, IATA or ICAO', () => {
    const wide = { ...window, fromMs: 0, toMs: Number.MAX_SAFE_INTEGER };
    const by = (airline: string) =>
      filterGroups(groups, { ...wide, airline }).map((g) => g.primary.designator);
    expect(by('BA')).toEqual(['AA100']);
    expect(by('IBE')).toEqual(['AA100']);
    expect(by('AAL')).toEqual(['AA100']);
    expect(by('DL')).toEqual(['DL50', 'DL40', 'DL60']);
    expect(by('LH')).toEqual([]);
  });

  it('keeps a delayed flight: its best time in the window, or earlier and not yet moved (R14)', () => {
    const at = (hhmm: string) => `2026-10-02T${hhmm}:00Z`;
    const rows = [
      row('DL1', { scheduled: at('12:00'), estimated: at('13:30') }),
      row('DL2', { scheduled: at('11:00'), actual: at('13:10'), status: 'departed' }),
      row('DL3', { scheduled: at('11:00'), actual: at('12:30'), status: 'departed' }),
      row('DL4', { scheduled: at('10:00'), estimated: at('16:00') }),
      row('DL5', { scheduled: at('12:00'), status: 'boarding' }),
      row('DL6', { scheduled: at('12:00'), estimated: at('12:10'), status: 'en_route' }),
      row('DL8', { scheduled: at('15:30'), estimated: at('14:50') }),
      row('DL9', { scheduled: at('15:30'), estimated: at('16:00') }),
      row('BA1', { direction: 'arr', scheduled: at('11:00'), status: 'en_route' }),
      row('BA2', { direction: 'arr', scheduled: at('11:00'), status: 'landed' }),
      row('BA3', {
        direction: 'arr',
        scheduled: at('11:00'),
        actual: at('12:00'),
        status: 'arrived',
      }),
      row('BA4', { direction: 'arr', scheduled: at('11:00'), status: 'boarding' }),
    ];
    const kept = (direction: 'dep' | 'arr') =>
      filterGroups(groupCodeshares(rows), { ...window, direction }).map(
        (g) => g.primary.designator,
      );
    // DL4 waits on an estimate past the window, DL2 left in it, DL1 is expected in it and DL8
    // early into it. DL3 left before it, DL6 is airborne, and DL5's `boarding` is its timetable's
    // word alone; DL9 is due after the window.
    expect(kept('dep')).toEqual(['DL4', 'DL2', 'DL1', 'DL8']);
    // An arrival still in the air stays; one landed or in, or with only its timetable, does not.
    expect(kept('arr')).toEqual(['BA1']);
  });
});

describe('boardViewRow', () => {
  it('is UI-shaped: the primary, its codeshares as designators, and what POST /v1/flights takes', () => {
    const [group] = groupCodeshares(
      aa100().map((r) => ({
        ...r,
        estimated: '2026-10-02T13:20:00Z',
        gate: 'B12',
        terminal: '8',
        counterpartScheduled: '2026-10-03T01:10:00Z',
        aircraftModel: 'Boeing 777-300ER',
        scheduledDepartureDateLocal: '2026-10-02',
      })),
    );
    const view = boardViewRow(group!, 'KJFK');
    expect(view).toEqual({
      id: `dep:AA100:${T0}`,
      designator: 'AA100',
      airlineIata: 'AA',
      airlineIcao: 'AAL',
      operatingCarrierIcao: 'AAL',
      operatingFlightNumber: '100',
      codeshares: ['BA1511', 'IB4218'],
      counterpart: { icao: 'EGLL', iata: 'LHR' },
      status: 'scheduled',
      scheduled: T0,
      estimated: '2026-10-02T13:20:00Z',
      terminal: '8',
      gate: 'B12',
      counterpartScheduled: '2026-10-03T01:10:00Z',
      aircraftModel: 'Boeing 777-300ER',
      add: { number: 'AA100', date: '2026-10-02', origin: 'KJFK' },
    });
    expect(Object.keys(view)).not.toContain('registration');
  });

  it('adds an arrival by its origin, the counterpart, and cannot add a row without a date', () => {
    const arrival = row('BA117', { direction: 'arr', scheduledDepartureDateLocal: '2026-10-01' });
    expect(boardViewRow({ primary: arrival, others: [] }, 'KJFK').add).toEqual({
      number: 'BA117',
      date: '2026-10-01',
      origin: 'EGLL',
    });
    expect(boardViewRow({ primary: row('AA1'), others: [] }, 'KJFK')).not.toHaveProperty('add');
  });
});

function bucket(
  state: BoardBucketResponseV1['state'],
  overrides: Partial<BoardBucketResponseV1> = {},
): BoardBucketResponseV1 {
  return {
    rpcVersion: 1,
    airportIcao: 'KJFK',
    bucketStartLocal: '2026-10-02T00:00',
    state,
    coverage: 'live',
    rows: [],
    stale: false,
    ...(state === 'ok' ? { fetchedAt: '2026-10-02T10:00:00.000Z' } : {}),
    ...overrides,
  };
}

describe('combineBuckets', () => {
  it('is not covered when any bucket is, and out of range only when every bucket is', () => {
    expect(combineBuckets([bucket('ok'), bucket('not_covered')])).toEqual({ kind: 'not_covered' });
    expect(combineBuckets([bucket('out_of_range'), bucket('out_of_range')])).toEqual({
      kind: 'out_of_range',
    });
    expect(combineBuckets([bucket('out_of_range'), bucket('unavailable')])).toEqual({
      kind: 'unavailable',
    });
    expect(combineBuckets([bucket('unknown')])).toEqual({ kind: 'unavailable' });
  });

  it('joins the readable buckets: oldest fetchedAt, stale if any is, partial when one is missing', () => {
    const morning = bucket('ok', { rows: [row('AA1')], fetchedAt: '2026-10-02T10:05:00.000Z' });
    const evening = bucket('ok', {
      rows: [row('AA2')],
      fetchedAt: '2026-10-02T09:55:00.000Z',
      stale: true,
      coverage: 'schedules_only',
    });
    const both = combineBuckets([morning, evening]);
    expect(both).toMatchObject({
      kind: 'ok',
      coverage: 'schedules_only',
      fetchedAt: '2026-10-02T09:55:00.000Z',
      stale: true,
      partial: false,
    });
    expect(both.kind === 'ok' && both.rows.map((r) => r.designator)).toEqual(['AA1', 'AA2']);
    expect(combineBuckets([morning, bucket('unavailable')])).toMatchObject({
      kind: 'ok',
      coverage: 'live',
      stale: false,
      partial: true,
    });
    expect(combineBuckets([bucket('ok', { coverage: 'unknown' })])).toMatchObject({
      coverage: 'unknown',
    });
  });

  it('is partial only for a bucket that could not be read, never for one out of range (R10)', () => {
    const morning = bucket('ok', { rows: [row('AA1')] });
    const partialWith = (other: BoardBucketResponseV1): unknown => {
      const combined = combineBuckets([morning, other]);
      return combined.kind === 'ok' ? combined.partial : combined.kind;
    };
    // A range past the lookahead (or long past) has nothing a pull could add.
    expect(partialWith(bucket('out_of_range'))).toBe(false);
    expect(partialWith(bucket('unavailable', { reason: 'budget_denied:boards_share' }))).toBe(true);
    // The Worker's timed-out or failed read is `unavailable` too (routes/airports.ts).
    expect(partialWith(bucket('unavailable', { reason: 'timeout', coverage: 'unknown' }))).toBe(
      true,
    );
    expect(partialWith(bucket('unknown'))).toBe(true);
  });
});

describe('the ETag', () => {
  it('is stable for one body and changes with it', async () => {
    const body = { fetchedAt: '2026-10-02T10:00:00.000Z', stale: false, rows: [1, 2] };
    const tag = await boardEtag(body);
    expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/);
    expect(await boardEtag({ ...body })).toBe(tag);
    expect(await boardEtag({ ...body, stale: true })).not.toBe(tag);
    expect(await boardEtag({ ...body, fetchedAt: '2026-10-02T10:05:00.000Z' })).not.toBe(tag);
  });

  it('matches If-None-Match weakly, in a list, or as *', () => {
    const tag = 'W/"abc"';
    expect(etagMatches(undefined, tag)).toBe(false);
    expect(etagMatches('W/"abc"', tag)).toBe(true);
    expect(etagMatches('"abc"', tag)).toBe(true);
    expect(etagMatches('"x", W/"abc"', tag)).toBe(true);
    expect(etagMatches('*', tag)).toBe(true);
    expect(etagMatches('W/"abd"', tag)).toBe(false);
  });
});
