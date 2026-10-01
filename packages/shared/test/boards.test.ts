import { describe, expect, it } from 'vitest';
import {
  BOARD_FRESHNESS_LADDER,
  BOARD_PURGE_AFTER_FETCH_MS,
  BoardBucketRequestV1,
  BoardBucketResponseV1,
  BoardKvMetaV1,
  boardBucketAt,
  boardBucketBounds,
  boardBucketStartOf,
  boardBucketWindow,
  boardBucketsOfDate,
  boardDegradeMultiplier,
  boardFreshness,
  boardKvKey,
  boardPosition,
  boardPurgeAtMs,
  boardRefreshable,
  isBoardBucketStart,
  nextBoardBucketStart,
  type BoardBucketBounds,
} from '../src/boards';

const NY = 'America/New_York';
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso: string): number => Date.parse(iso);

describe('board buckets (R3 D3: 12 airport-local hours)', () => {
  it('names a bucket by its local start, 00:00 or 12:00', () => {
    expect(isBoardBucketStart('2026-09-22T00:00')).toBe(true);
    expect(isBoardBucketStart('2026-09-22T12:00')).toBe(true);
    expect(isBoardBucketStart('2026-09-22T06:00')).toBe(false);
    expect(isBoardBucketStart('2026-02-30T00:00')).toBe(false);
    expect(boardBucketStartOf('2026-09-22T11:59')).toBe('2026-09-22T00:00');
    expect(boardBucketStartOf('2026-09-22T12:00')).toBe('2026-09-22T12:00');
    expect(boardBucketStartOf('2026-09-22T24:00')).toBeNull();
    expect(boardBucketsOfDate('2026-09-22')).toEqual(['2026-09-22T00:00', '2026-09-22T12:00']);
    expect(boardBucketsOfDate('22/09/2026')).toBeNull();
    expect(nextBoardBucketStart('2026-09-22T00:00')).toBe('2026-09-22T12:00');
    expect(nextBoardBucketStart('2026-12-31T12:00')).toBe('2027-01-01T00:00');
  });

  it('finds the bucket holding an instant in the airport zone', () => {
    // 03:30Z on the 23rd is 23:30 on the 22nd in New York.
    expect(boardBucketAt(at('2026-09-23T03:30:00Z'), NY)).toBe('2026-09-22T12:00');
    expect(boardBucketAt(at('2026-09-23T04:00:00Z'), NY)).toBe('2026-09-23T00:00');
    expect(boardBucketAt(at('2026-09-23T04:00:00Z'), 'Not/AZone')).toBeNull();
  });

  it('asks FIDS for the bucket from its first minute to its last', () => {
    expect(boardBucketWindow('2026-09-22T00:00', NY)).toEqual({
      from: '2026-09-22T00:00',
      to: '2026-09-22T11:59',
      tz: NY,
    });
    expect(boardBucketWindow('2026-09-22T12:00', NY)?.to).toBe('2026-09-22T23:59');
    expect(boardBucketWindow('2026-09-22T13:00', NY)).toBeNull();
  });

  it('turns a bucket into instants, 11 or 13 real hours on a DST change day', () => {
    expect(boardBucketBounds('2026-09-22T12:00', NY)).toEqual({
      startMs: at('2026-09-22T16:00:00Z'),
      endMs: at('2026-09-23T04:00:00Z'),
    });
    const fallBack = boardBucketBounds('2026-11-01T00:00', NY);
    expect(fallBack === null ? null : (fallBack.endMs - fallBack.startMs) / HOUR).toBe(13);
    const springForward = boardBucketBounds('2026-03-08T00:00', NY);
    expect(
      springForward === null ? null : (springForward.endMs - springForward.startMs) / HOUR,
    ).toBe(11);
    expect(boardBucketBounds('2026-09-22T12:00', 'Not/AZone')).toBeNull();
    expect(boardKvKey('KJFK', '2026-09-22T12:00')).toBe('board:v2:KJFK:2026-09-22T12:00');
  });
});

describe('the freshness ladder (R3 D5, normative: one test per row)', () => {
  // The PM bucket of 2026-09-22 at JFK: 16:00Z to 04:00Z the next day.
  const bounds: BoardBucketBounds = {
    startMs: at('2026-09-22T16:00:00Z'),
    endMs: at('2026-09-23T04:00:00Z'),
  };
  const limits = (nowMs: number) => {
    const f = boardFreshness(bounds, nowMs);
    return [f.position, (f.freshUntilMs - nowMs) / MIN, (f.staleUntilMs - nowMs) / MIN];
  };

  it('row 1: contains now, or starts within 3 h: fresh 5 min, stale until 15 min', () => {
    expect(limits(bounds.startMs + 4 * HOUR)).toEqual(['current', 5, 15]);
    expect(limits(bounds.endMs - 1)).toEqual(['current', 5, 15]);
    expect(limits(bounds.startMs - 3 * HOUR)).toEqual(['current', 5, 15]);
    expect(BOARD_FRESHNESS_LADDER.current).toEqual({ freshMs: 5 * MIN, staleMs: 15 * MIN });
  });

  it('row 2: starts 3 h to 24 h ahead: fresh 30 min, stale until 2 h', () => {
    expect(limits(bounds.startMs - 3 * HOUR - 1)).toEqual(['near', 30, 120]);
    expect(limits(bounds.startMs - 24 * HOUR)).toEqual(['near', 30, 120]);
  });

  it('row 3: starts 24 h to 72 h ahead: fresh 3 h, stale until 12 h', () => {
    expect(limits(bounds.startMs - 24 * HOUR - 1)).toEqual(['ahead', 180, 720]);
    expect(limits(bounds.startMs - 72 * HOUR)).toEqual(['ahead', 180, 720]);
  });

  it('row 4: starts more than 72 h ahead: fresh 12 h, stale until 48 h', () => {
    expect(limits(bounds.startMs - 72 * HOUR - 1)).toEqual(['far', 720, 2_880]);
    expect(limits(bounds.startMs - 180 * 24 * HOUR)).toEqual(['far', 720, 2_880]);
  });

  it('row 5: ended less than 3 h ago: fresh 15 min, stale until 1 h', () => {
    expect(limits(bounds.endMs)).toEqual(['just_ended', 15, 60]);
    expect(limits(bounds.endMs + 3 * HOUR - 1)).toEqual(['just_ended', 15, 60]);
  });

  it('row 6: ended more than 3 h ago: fresh 6 h, no refresh after 24 h, purge 48 h after the end', () => {
    const now = bounds.endMs + 3 * HOUR;
    const f = boardFreshness(bounds, now);
    expect(f.position).toBe('ended');
    expect(f.freshUntilMs - now).toBe(6 * HOUR);
    // Served stale until the purge, never beyond it.
    expect(f.staleUntilMs).toBe(bounds.endMs + 48 * HOUR);
    expect(f.purgeAtMs).toBe(boardPurgeAtMs(bounds));
    expect(boardRefreshable(bounds, bounds.endMs + 24 * HOUR)).toBe(true);
    expect(boardRefreshable(bounds, bounds.endMs + 24 * HOUR + 1)).toBe(false);
    expect(boardRefreshable(bounds, bounds.startMs - 400 * HOUR)).toBe(true);
    // Six hours before the purge, the fresh limit is cut at the purge.
    const late = boardFreshness(bounds, bounds.endMs + 44 * HOUR);
    expect(late.freshUntilMs).toBe(bounds.endMs + 48 * HOUR);
  });

  it('positions every instant in exactly one row', () => {
    const seen = new Set<string>();
    for (let t = bounds.startMs - 100 * HOUR; t <= bounds.endMs + 30 * HOUR; t += 30 * MIN) {
      seen.add(boardPosition(bounds, t));
    }
    expect([...seen].sort()).toEqual(Object.keys(BOARD_FRESHNESS_LADDER).sort());
  });
});

describe('the degrade steps of the boards share (ruling B5)', () => {
  const bounds: BoardBucketBounds = {
    startMs: at('2026-09-22T16:00:00Z'),
    endMs: at('2026-09-23T04:00:00Z'),
  };
  const now = bounds.startMs + HOUR;

  it('doubles every time from 70 percent and quadruples from 90', () => {
    expect([0, 0.69, 0.7, 0.89, 0.9, 1, undefined, Number.NaN].map(boardDegradeMultiplier)).toEqual(
      [1, 1, 2, 2, 4, 4, 1, 1],
    );
    const at70 = boardFreshness(bounds, now, 0.7);
    expect([at70.freshUntilMs - now, at70.staleUntilMs - now]).toEqual([10 * MIN, 30 * MIN]);
    const at90 = boardFreshness(bounds, now, 0.95);
    expect([at90.freshUntilMs - now, at90.staleUntilMs - now]).toEqual([20 * MIN, 60 * MIN]);
  });

  it('never degrades the purge', () => {
    const ended = boardFreshness(bounds, bounds.endMs + 40 * HOUR, 0.9);
    expect(ended.freshUntilMs).toBe(bounds.endMs + 48 * HOUR);
    expect(ended.staleUntilMs).toBe(bounds.endMs + 48 * HOUR);
  });
});

describe('the purge: 48 h after the end or 7 days after the fetch, whichever is sooner (ruling R4)', () => {
  const DAY = 24 * HOUR;
  const fetchedAt = at('2026-09-22T17:00:00Z');
  /** A 12-hour bucket starting `leadMs` after the fetch. */
  const ahead = (leadMs: number): BoardBucketBounds => ({
    startMs: fetchedAt + leadMs,
    endMs: fetchedAt + leadMs + 12 * HOUR,
  });

  it('purges copies of buckets 30 and 365 days ahead 7 days after the fetch', () => {
    expect(BOARD_PURGE_AFTER_FETCH_MS).toBe(7 * DAY);
    for (const days of [30, 365]) {
      const f = boardFreshness(ahead(days * DAY), fetchedAt);
      expect(f.position).toBe('far');
      expect(f.purgeAtMs).toBe(fetchedAt + 7 * DAY);
      // The far row itself is unchanged: fresh 12 h, stale until 48 h.
      expect([f.freshUntilMs - fetchedAt, f.staleUntilMs - fetchedAt]).toEqual([
        12 * HOUR,
        48 * HOUR,
      ]);
    }
  });

  it('cuts in for a bucket starting more than 108 h after the fetch, and no sooner', () => {
    // At 108 h both rules agree: the end is 120 h out, plus 48 h is 168 h, which is 7 days.
    expect(boardFreshness(ahead(108 * HOUR), fetchedAt).purgeAtMs).toBe(fetchedAt + 7 * DAY);
    expect(boardFreshness(ahead(108 * HOUR + MIN), fetchedAt).purgeAtMs).toBe(fetchedAt + 7 * DAY);
    const sooner = ahead(108 * HOUR - MIN);
    expect(boardFreshness(sooner, fetchedAt).purgeAtMs).toBe(boardPurgeAtMs(sooner));
    expect(boardPurgeAtMs(sooner)).toBe(fetchedAt + 7 * DAY - MIN);
  });

  it('never keeps a copy more than 7 days after its fetch, wherever the bucket lies', () => {
    for (let lead = -72 * HOUR; lead <= 400 * DAY; lead += 7 * HOUR) {
      const bucket = ahead(lead);
      for (const share of [undefined, 0.7, 0.95]) {
        const f = boardFreshness(bucket, fetchedAt, share);
        expect(f.purgeAtMs - fetchedAt).toBeLessThanOrEqual(7 * DAY);
        expect(f.purgeAtMs).toBeLessThanOrEqual(boardPurgeAtMs(bucket));
        expect(f.staleUntilMs).toBeLessThanOrEqual(f.purgeAtMs);
      }
    }
  });

  it('stops the far row at the purge: 168 h of stale at 95 percent, 96 h at 70 percent', () => {
    const far = ahead(30 * DAY);
    const at95 = boardFreshness(far, fetchedAt, 0.95);
    expect([at95.freshUntilMs - fetchedAt, at95.staleUntilMs - fetchedAt]).toEqual([
      48 * HOUR,
      168 * HOUR,
    ]);
    const at70 = boardFreshness(far, fetchedAt, 0.7);
    expect([at70.freshUntilMs - fetchedAt, at70.staleUntilMs - fetchedAt]).toEqual([
      24 * HOUR,
      96 * HOUR,
    ]);
  });
});

describe('the AirportState contract', () => {
  it('parses a bucket request and refuses a bucket that is not one', () => {
    const request = {
      airportIcao: 'KJFK',
      tz: NY,
      bucketStartLocal: '2026-09-22T12:00',
      trigger: 'board',
    };
    expect(BoardBucketRequestV1.parse(request).rpcVersion).toBe(1);
    expect(
      BoardBucketRequestV1.safeParse({ ...request, bucketStartLocal: '2026-09-22T13:00' }).success,
    ).toBe(false);
    expect(BoardBucketRequestV1.safeParse({ ...request, airportIcao: 'JFK' }).success).toBe(false);
    expect(BoardBucketRequestV1.safeParse({ ...request, trigger: 'alarm' }).success).toBe(false);
  });

  it('reads a state or coverage a newer object adds as unknown', () => {
    const response = BoardBucketResponseV1.parse({
      airportIcao: 'KJFK',
      bucketStartLocal: '2026-09-22T12:00',
      state: 'warming',
      coverage: 'ads_b_only',
      rows: [],
      stale: false,
    });
    expect([response.state, response.coverage, response.rpcVersion]).toEqual([
      'unknown',
      'unknown',
      1,
    ]);
    expect(
      BoardKvMetaV1.safeParse({
        airportIcao: 'KJFK',
        bucketStartLocal: '2026-09-22T12:00',
        fetchedAt: '2026-09-22T20:00:00Z',
        freshUntil: '2026-09-22T20:05:00Z',
        staleUntil: '2026-09-22T20:15:00Z',
        coverage: 'live',
        rowCount: 0,
      }).success,
    ).toBe(true);
  });
});
