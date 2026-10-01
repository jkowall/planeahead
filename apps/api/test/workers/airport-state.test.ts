/**
 * AirportState, the board cache (increment 18, rulings B2 to B6), in the Workers pool against
 * real Durable Object storage, real KV and the real ProviderBudget object, with AeroDataBox a
 * counting fake `fetch` (no provider is ever called): N concurrent misses make one FIDS call; a
 * request inside `freshUntil` makes none; one between `freshUntil` and `staleUntil` gets the
 * stale copy while one refresh runs; a failed refresh never empties a board; the boards share
 * degrades the ladder at 70 and 90 percent and leaves stale copies only at 100; coverage gates
 * the call; a hub-sized bucket is chunked, read back and purged with its KV copy. From the
 * review round: a failure waits as long as its cause warrants (R6) and a copy that cannot be
 * stored keeps its record (R15); board calls leave the trackers their rate floor (R2); a copy
 * fetched weeks ahead is purged a week after its fetch (R4).
 */

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoardBucketResponseV1,
  boardBucketBounds,
  boardKvKey,
  type BoardBucketBounds,
  type BudgetRequest,
  type ProviderCallRecord,
} from '@planeahead/shared';
import { decodeBoardRows, joinChunks, readBoardKv } from '../../src/boards/cache';
import { readBoardBucket } from '../../src/boards/read';
import type { AirportState } from '../../src/do/airport-state';
import { HOUR_MS, MINUTE_MS, drainTouched, testEnv, track } from './helpers/flights';
import {
  airportHarness,
  feeds,
  syntheticFids,
  uniqueDay,
  type AirportHarness,
} from './helpers/airports';

afterEach(drainTouched);

const NY = 'America/New_York';

function boundsOf(bucket: string): BoardBucketBounds {
  const bounds = boardBucketBounds(bucket, NY);
  if (bounds === null) {
    throw new Error(`no bounds for ${bucket}`);
  }
  return bounds;
}

/** `YYYY-MM-DD HH:mmZ`, AeroDataBox's UTC form. */
function adbUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function ask(harness: AirportHarness, bucket: string, trigger: 'board' | 'route_search' = 'board') {
  return harness.stub
    .getBucket({ airportIcao: harness.icao, tz: harness.tz, bucketStartLocal: bucket, trigger })
    .then((answer) => BoardBucketResponseV1.parse(answer));
}

/** A PM bucket on a fresh day, the clock an hour into it (position `current`: 5 min fresh). */
async function currentBucket(rowsPerDirection = 3) {
  const bucket = `${uniqueDay()}T12:00`;
  const bounds = boundsOf(bucket);
  const now = bounds.startMs + HOUR_MS;
  const harness = await airportHarness(syntheticFids(rowsPerDirection, adbUtc(now)), now);
  return { bucket, bounds, now, harness };
}

/** The FIDS call records the object has sent to `persist`. */
function fidsRecords(harness: AirportHarness): ProviderCallRecord[] {
  return harness.sent.flatMap((message) =>
    message.kind === 'provider_call' && message.payload.operation === 'fids'
      ? [message.payload]
      : [],
  );
}

/** The object's armed alarm, or null. */
function alarmOf(harness: AirportHarness): Promise<number | null> {
  return runInDurableObject(harness.stub, (_instance, state) => state.storage.getAlarm());
}

describe('AirportState: coalescing and the read path (ruling B3)', () => {
  it('N concurrent misses for one cold bucket make one FIDS call; a request inside freshUntil makes none', async () => {
    const { bucket, now, harness } = await currentBucket();
    harness.adb.hold();
    const pending = Array.from({ length: 20 }, () => ask(harness, bucket));
    await harness.untilFids(1);
    // Every request has reached the object (delivery is in order) before the answer is let go.
    await runInDurableObject(harness.stub, () => undefined);
    await harness.release();
    const answers = await Promise.all(pending);
    expect(harness.adb.fidsCalls()).toBe(1);
    expect(harness.adb.healthCalls()).toBe(1);
    const fetchedAt = new Date(now).toISOString();
    for (const answer of answers) {
      expect(answer).toMatchObject({ state: 'ok', coverage: 'live', stale: false, fetchedAt });
      expect(answer.rows).toHaveLength(6);
    }
    expect(answers[0]?.freshUntil).toBe(new Date(now + 5 * MINUTE_MS).toISOString());
    expect(answers[0]?.staleUntil).toBe(new Date(now + 15 * MINUTE_MS).toISOString());

    await harness.setClock(now + 4 * MINUTE_MS);
    expect(await ask(harness, bucket)).toMatchObject({ fetchedAt, stale: false });
    expect(harness.adb.fidsCalls()).toBe(1);
    await harness.settled();
  });

  it('copies the bucket to KV with its limits and sends each call record with the airport', async () => {
    const { bucket, now, harness } = await currentBucket();
    const answer = await ask(harness, bucket, 'route_search');
    await harness.settled();
    const copy = await readBoardKv(testEnv.CACHE, harness.icao, bucket);
    expect(copy?.meta).toEqual({
      airportIcao: harness.icao,
      bucketStartLocal: bucket,
      fetchedAt: answer.fetchedAt,
      freshUntil: answer.freshUntil,
      staleUntil: answer.staleUntil,
      coverage: 'live',
      rowCount: 6,
    });
    expect(copy?.rows).toEqual(answer.rows);
    const calls = harness.sent.filter((message) => message.kind === 'provider_call');
    expect(
      calls.map((message) => (message.kind === 'provider_call' ? message.payload : null)),
    ).toEqual([
      expect.objectContaining({
        operation: 'health',
        trigger: 'route_search',
        airportIcao: harness.icao,
        costUnits: 0,
      }),
      expect.objectContaining({
        operation: 'fids',
        trigger: 'route_search',
        airportIcao: harness.icao,
        costUnits: 2,
      }),
    ]);
    expect(calls[0]?.origin).toBe(`airport_state:${harness.icao}@${String(now)}`);
    // The coverage answer stays in the object: no Worker reads a KV copy, so none is written.
    expect(await testEnv.CACHE.get(`adb:coverage:${harness.icao}`)).toBeNull();
  });

  it('between freshUntil and staleUntil serves the stale copy at once while ONE refresh runs', async () => {
    const { bucket, now, harness } = await currentBucket();
    const first = await ask(harness, bucket);
    await harness.settled();
    await harness.setClock(now + 6 * MINUTE_MS);
    harness.adb.fids = () => Response.json(syntheticFids(4, adbUtc(now)));
    harness.adb.hold();
    const stale = await Promise.all(Array.from({ length: 5 }, () => ask(harness, bucket)));
    for (const answer of stale) {
      expect(answer).toMatchObject({ state: 'ok', stale: true, fetchedAt: first.fetchedAt });
      expect(answer.rows).toHaveLength(6);
    }
    await harness.untilFids(2);
    await harness.release();
    await harness.settled();
    expect(harness.adb.fidsCalls()).toBe(2);
    const fresh = await ask(harness, bucket);
    expect(fresh).toMatchObject({
      stale: false,
      fetchedAt: new Date(now + 6 * MINUTE_MS).toISOString(),
    });
    expect(fresh.rows).toHaveLength(8);
    expect(harness.adb.fidsCalls()).toBe(2);
  });
});

describe('AirportState: failures never empty a board', () => {
  it('past staleUntil the caller waits; a failed refresh serves the old copy stale, then waits a minute', async () => {
    const { bucket, now, harness } = await currentBucket();
    const first = await ask(harness, bucket);
    await harness.settled();
    const later = now + 16 * MINUTE_MS;
    await harness.setClock(later);
    harness.adb.fids = () => Response.json({ message: 'boom' }, { status: 500 });
    const failed = await ask(harness, bucket);
    expect(failed).toMatchObject({ state: 'ok', stale: true, fetchedAt: first.fetchedAt });
    expect(failed.reason).toMatch(/^http_500/);
    expect(failed.rows).toEqual(first.rows);
    expect(harness.adb.fidsCalls()).toBe(2);
    // Not called again on every view while it fails.
    await harness.setClock(later + 59_000);
    expect((await ask(harness, bucket)).reason).toBe(failed.reason);
    expect(harness.adb.fidsCalls()).toBe(2);
    harness.adb.fids = () => Response.json(syntheticFids(2, adbUtc(now)));
    await harness.setClock(later + 61_000);
    const recovered = await ask(harness, bucket);
    expect(recovered).toMatchObject({
      stale: false,
      fetchedAt: new Date(later + 61_000).toISOString(),
    });
    expect(recovered.rows).toHaveLength(4);
    expect(harness.adb.fidsCalls()).toBe(3);
    await harness.settled();
  });

  it('a cold bucket whose fetch fails is unavailable, with the reason, and nothing is cached', async () => {
    const { bucket, harness } = await currentBucket();
    harness.adb.fids = () => new Response('<html>blocked</html>', { status: 403 });
    const answer = await ask(harness, bucket);
    expect(answer).toMatchObject({ state: 'unavailable', rows: [], stale: false });
    expect(answer.reason).toMatch(/^http_403/);
    expect(await readBoardKv(testEnv.CACHE, harness.icao, bucket)).toBeNull();
    await harness.settled();
  });

  it('stores a billed 200 whose items all fail mapping as an empty bucket on the ladder (R6)', async () => {
    const { bucket, now, harness } = await currentBucket();
    harness.adb.fids = () => Response.json({ departures: [{ number: 'AA 1' }], arrivals: [{}] });
    const answer = await ask(harness, bucket);
    expect(answer).toMatchObject({ state: 'ok', rows: [], stale: false });
    expect(answer.freshUntil).toBe(new Date(now + 5 * MINUTE_MS).toISOString());
    await harness.settled();
    // The record keeps its error: the mapping failed, and the call was billed.
    expect(fidsRecords(harness)).toEqual([
      expect.objectContaining({ result: 'error', httpStatus: 200, costUnits: 2 }),
    ]);
    expect(fidsRecords(harness)[0]?.error).toMatch(/^skipped 2: /);
    // Not billed again every minute: the empty copy is fresh like any other.
    await harness.setClock(now + 4 * MINUTE_MS);
    expect(await ask(harness, bucket)).toMatchObject({ state: 'ok', stale: false });
    expect(harness.adb.fidsCalls()).toBe(1);
  });

  it.each([
    ['a 400', () => Response.json({ message: 'bad range' }, { status: 400 }), /^http_400/],
    [
      'a 200 that is not a FIDS contract',
      () => Response.json({ departures: 'none' }),
      /^not_a_fids_contract$/,
    ],
  ])(
    '%s is asked again only when a copy would be stale, not in a minute (R6)',
    async (_, answer, why) => {
      const { bucket, now, harness } = await currentBucket();
      harness.adb.fids = answer;
      const failed = await ask(harness, bucket);
      expect(failed).toMatchObject({ state: 'unavailable', rows: [] });
      expect(failed.reason).toMatch(why);
      await harness.setClock(now + 5 * MINUTE_MS - 1);
      expect((await ask(harness, bucket)).reason).toMatch(why);
      expect(harness.adb.fidsCalls()).toBe(1);
      harness.adb.fids = () => Response.json(syntheticFids(1, adbUtc(now)));
      await harness.setClock(now + 5 * MINUTE_MS);
      expect(await ask(harness, bucket)).toMatchObject({ state: 'ok', stale: false });
      expect(harness.adb.fidsCalls()).toBe(2);
      await harness.settled();
    },
  );

  it.each([
    [
      'a push-back (429)',
      () => Response.json({ message: 'slow down' }, { status: 429 }),
      /^http_429/,
    ],
    [
      'a transport error',
      (): Response => {
        throw new TypeError('connection reset');
      },
      /^transport_/,
    ],
  ])('%s is retried after a minute, as a 5xx is (R6)', async (_, answer, why) => {
    const { bucket, now, harness } = await currentBucket();
    harness.adb.fids = answer;
    expect((await ask(harness, bucket)).reason).toMatch(why);
    await harness.setClock(now + 59_000);
    expect((await ask(harness, bucket)).reason).toMatch(why);
    expect(harness.adb.fidsCalls()).toBe(1);
    harness.adb.fids = () => Response.json(syntheticFids(1, adbUtc(now)));
    await harness.setClock(now + 61_000);
    expect(await ask(harness, bucket)).toMatchObject({ state: 'ok', stale: false });
    expect(harness.adb.fidsCalls()).toBe(2);
    await harness.settled();
  });
});

describe('AirportState: a copy that cannot be stored (R15)', () => {
  /** Breaks the object's storage: the bucket's chunks, and with `outbox` its records too. */
  async function dropTables(harness: AirportHarness, tables: readonly string[]): Promise<void> {
    await runInDurableObject(harness.stub, (_instance, state) => {
      for (const table of tables) {
        state.storage.sql.exec(`DROP TABLE ${table}`);
      }
    });
  }

  it("keeps the billed call's record and waits a minute before billing again", async () => {
    const { bucket, now, harness } = await currentBucket();
    await dropTables(harness, ['bucket_chunks']);
    expect(await ask(harness, bucket)).toMatchObject({
      state: 'unavailable',
      rows: [],
      reason: 'store_failed',
    });
    await harness.settled();
    expect(fidsRecords(harness)).toEqual([
      expect.objectContaining({ result: 'ok', httpStatus: 200, costUnits: 2 }),
    ]);
    await harness.setClock(now + 59_000);
    expect((await ask(harness, bucket)).reason).toBe('store_failed');
    expect(harness.adb.fidsCalls()).toBe(1);
    await harness.setClock(now + 61_000);
    await ask(harness, bucket);
    await harness.settled();
    expect(harness.adb.fidsCalls()).toBe(2);
    expect(fidsRecords(harness)).toHaveLength(2);
  });

  it('still waits a minute when even the record cannot be kept', async () => {
    const { bucket, now, harness } = await currentBucket();
    await ask(harness, `${bucket.slice(0, 10)}T00:00`); // the coverage check, recorded first
    await harness.settled();
    await dropTables(harness, ['bucket_chunks', 'outbox']);
    expect((await ask(harness, bucket)).reason).toBe('store_failed');
    await harness.setClock(now + 59_000);
    expect((await ask(harness, bucket)).reason).toBe('store_failed');
    expect(harness.adb.fidsCalls()).toBe(2);
  });
});

describe('AirportState: the boards share degrades the ladder (rulings B4 and B5)', () => {
  /** Configures the day's budget (35 percent of 60 units is 21) and spends `calls` board calls. */
  async function spend(now: number, airportIcao: string, calls: number): Promise<void> {
    const day = new Date(now).toISOString().slice(0, 10);
    const budget = track(
      testEnv.PROVIDER_BUDGET.getByName(`aerodatabox:${day}`, { locationHint: 'enam' }),
    );
    await budget.configure({ dailyUnitCap: 60, perSecondLimit: 1_000 });
    const request: BudgetRequest = {
      provider: 'aerodatabox',
      operation: 'fids',
      pollEquivalents: 0.1,
      trigger: 'board',
      airportIcao,
      utcDate: day,
    };
    for (let i = 0; i < calls; i += 1) {
      expect((await budget.reserve(request)).allowed).toBe(true);
    }
  }

  const minutes = (answer: BoardBucketResponseV1): number[] => {
    const fetched = Date.parse(answer.fetchedAt ?? '');
    return [answer.freshUntil, answer.staleUntil].map(
      (at) => (Date.parse(at ?? '') - fetched) / MINUTE_MS,
    );
  };

  it('doubles every limit from 70 percent of the share spent and quadruples it from 90', async () => {
    const at70 = await currentBucket();
    await spend(at70.now, at70.harness.icao, 7); // this call makes 16 of 21: 76 percent
    expect(minutes(await ask(at70.harness, at70.bucket))).toEqual([10, 30]);
    const at90 = await currentBucket();
    await spend(at90.now, at90.harness.icao, 9); // this call makes 20 of 21: 95 percent
    expect(minutes(await ask(at90.harness, at90.bucket))).toEqual([20, 60]);
    await at70.harness.settled();
    await at90.harness.settled();
  });

  it('at 100 percent the budget refuses: stale copies only, never an empty board while one exists', async () => {
    const { bucket, now, harness } = await currentBucket();
    await spend(now, harness.icao, 9);
    const copy = await ask(harness, bucket); // 20 of 21 spent: the next call cannot fit
    await harness.settled();
    await harness.setClock(now + 61 * MINUTE_MS); // past the quadrupled staleUntil
    const refused = await ask(harness, bucket);
    expect(refused).toMatchObject({
      state: 'ok',
      stale: true,
      fetchedAt: copy.fetchedAt,
      reason: 'budget_denied:boards_share',
    });
    expect(refused.rows).toEqual(copy.rows);
    // The morning bucket has no copy to fall back on.
    const morning = await ask(harness, `${bucket.slice(0, 10)}T00:00`);
    expect(morning).toMatchObject({
      state: 'unavailable',
      rows: [],
      reason: 'budget_denied:boards_share',
    });
    expect(harness.adb.fidsCalls()).toBe(1);
    await harness.settled();
  });
});

describe('AirportState: the trackers keep their rate floor (ruling R2)', () => {
  it('a cold open of three buckets at one instant leaves a tracker its token; the third waits a refill', async () => {
    const { bucket, now, harness } = await currentBucket();
    const morning = `${bucket.slice(0, 10)}T00:00`;
    const tomorrow = `${new Date(now + 24 * HOUR_MS).toISOString().slice(0, 10)}T00:00`;
    // Growth, at its real 10 a second: a burst of 5, of which board calls leave 2. The coverage
    // check and two buckets take three tokens; the third bucket meets the floor.
    expect((await ask(harness, morning)).state).toBe('ok');
    expect((await ask(harness, bucket)).state).toBe('ok');
    expect(await ask(harness, tomorrow)).toMatchObject({
      state: 'unavailable',
      reason: 'budget_denied:board_rate_floor',
    });
    // A per-second refusal, like the rate's own: nothing sent, nothing billed.
    await harness.settled();
    expect(fidsRecords(harness)[2]).toMatchObject({ result: 'rate_limited', costUnits: 0 });
    const utcDate = new Date(now).toISOString().slice(0, 10);
    const budget = testEnv.PROVIDER_BUDGET.getByName(`aerodatabox:${utcDate}`, {
      locationHint: 'enam',
    });
    const tracker: BudgetRequest = {
      provider: 'aerodatabox',
      operation: 'flight_status',
      pollEquivalents: 0.1,
      trigger: 'alarm',
      utcDate,
    };
    expect((await budget.reserve(tracker)).allowed).toBe(true);
    // The floored bucket waits for its refill (a second at least), not the failure minute.
    await harness.setClock(now + 999);
    expect((await ask(harness, tomorrow)).reason).toBe('budget_denied:board_rate_floor');
    expect(harness.adb.fidsCalls()).toBe(2);
    await harness.setClock(now + 1_000);
    expect(await ask(harness, tomorrow)).toMatchObject({ state: 'ok', stale: false });
    expect(harness.adb.fidsCalls()).toBe(3);
    await harness.settled();
  });
});

describe('AirportState: coverage, once per airport per day (ruling B6)', () => {
  it('neither schedules nor live: not_covered, no FIDS call, and one check a day for every bucket', async () => {
    const { bucket, now, harness } = await currentBucket();
    harness.adb.health = () => feeds('NoData', 'NoData');
    expect(await ask(harness, bucket)).toMatchObject({
      state: 'not_covered',
      rows: [],
      coverage: 'not_covered',
    });
    await harness.setClock(now + 23 * HOUR_MS);
    const tomorrow = `${new Date(now + 24 * HOUR_MS).toISOString().slice(0, 10)}T00:00`;
    expect(await ask(harness, tomorrow)).toMatchObject({ state: 'not_covered' });
    expect(harness.adb.fidsCalls()).toBe(0);
    expect(harness.adb.healthCalls()).toBe(1);
    // A day later the free check is asked again.
    harness.adb.health = () => feeds('OK', 'NoData');
    await harness.setClock(now + 24 * HOUR_MS + 1);
    expect(await ask(harness, tomorrow)).toMatchObject({ state: 'ok', coverage: 'schedules_only' });
    expect(harness.adb.healthCalls()).toBe(2);
    expect(harness.adb.fidsCalls()).toBe(1);
    await harness.settled();
  });

  it('schedules only: the board is served and says so; a failed check fetches anyway, asked again in an hour', async () => {
    const { bucket, harness } = await currentBucket();
    harness.adb.health = () => feeds('OKPartial', 'NoData');
    expect(await ask(harness, bucket)).toMatchObject({ state: 'ok', coverage: 'schedules_only' });
    const other = await currentBucket();
    other.harness.adb.health = () => Response.json({ message: 'down' }, { status: 500 });
    expect(await ask(other.harness, other.bucket)).toMatchObject({
      state: 'ok',
      coverage: 'unknown',
    });
    expect(other.harness.adb.fidsCalls()).toBe(1);
    await other.harness.setClock(other.now + 30 * MINUTE_MS);
    await ask(other.harness, `${other.bucket.slice(0, 10)}T00:00`);
    expect(other.harness.adb.healthCalls()).toBe(1);
    await other.harness.setClock(other.now + 61 * MINUTE_MS);
    await ask(other.harness, other.bucket);
    expect(other.harness.adb.healthCalls()).toBe(2);
    await harness.settled();
    await other.harness.settled();
  });
});

describe('AirportState: a hub-sized bucket (R3 F37, U4)', () => {
  it('stores thousands of rows in chunks under 1 MB, reads them back, and purges them with the KV copy', async () => {
    const bucket = `${uniqueDay()}T12:00`;
    const bounds = boundsOf(bucket);
    const now = bounds.startMs + HOUR_MS;
    // 4,000 rows whose aircraft models are random text: well over 1 MB even after gzip.
    const harness = await airportHarness(syntheticFids(2_000, adbUtc(now), 400), now);
    const answer = await ask(harness, bucket);
    expect(answer.rows).toHaveLength(4_000);
    await harness.settled();
    const stored = await runInDurableObject(harness.stub, (_instance, state) => ({
      bucket: state.storage.sql
        .exec<{ row_count: number; chunk_count: number; gzip_bytes: number }>(
          'SELECT row_count, chunk_count, gzip_bytes FROM buckets',
        )
        .one(),
      largest: state.storage.sql
        .exec<{ n: number }>('SELECT MAX(LENGTH(data)) AS n FROM bucket_chunks')
        .one().n,
    }));
    expect(stored.bucket.row_count).toBe(4_000);
    expect(stored.bucket.gzip_bytes).toBeGreaterThan(1_000_000);
    expect(stored.bucket.chunk_count).toBeGreaterThanOrEqual(2);
    expect(stored.largest).toBeLessThanOrEqual(1_000_000);

    // Read back: the stored chunks joined and decompressed, a second answer, and the KV copy.
    const chunks = await runInDurableObject(harness.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ data: ArrayBuffer }>('SELECT data FROM bucket_chunks ORDER BY idx')
        .toArray()
        .map((row) => new Uint8Array(row.data)),
    );
    expect(await decodeBoardRows(joinChunks(chunks))).toEqual(answer.rows);
    expect((await ask(harness, bucket)).rows).toEqual(answer.rows);
    const copy = await readBoardKv(testEnv.CACHE, harness.icao, bucket);
    expect(copy?.rows).toHaveLength(4_000);
    expect(copy?.rows[1_999]?.aircraftModel).toBe(answer.rows[1_999]?.aircraftModel);

    // 48 hours after the bucket ends the alarm deletes it, its chunks and its KV copy.
    await harness.setClock(bounds.endMs + 48 * HOUR_MS);
    expect(await runDurableObjectAlarm(harness.stub)).toBe(true);
    const tables = await runInDurableObject(harness.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'buckets'",
        )
        .toArray(),
    );
    expect(tables).toEqual([]);
    expect(await testEnv.CACHE.get(boardKvKey(harness.icao, bucket))).toBeNull();
  });
});

describe('AirportState: what is never fetched', () => {
  it('a bucket ended more than 24 hours ago, or beyond the lookahead, is out of range without a call', async () => {
    const { bucket, bounds, harness } = await currentBucket();
    await harness.setClock(bounds.endMs + 24 * HOUR_MS + 1);
    expect(await ask(harness, bucket)).toMatchObject({
      state: 'out_of_range',
      rows: [],
      reason: 'not_refreshed',
    });
    await harness.setClock(bounds.startMs - 400 * 24 * HOUR_MS);
    expect(await ask(harness, bucket)).toMatchObject({ state: 'out_of_range' });
    expect(harness.adb.calls).toEqual([]);
  });

  it('a copy is still served after its last refresh, until the purge', async () => {
    const { bucket, bounds, harness } = await currentBucket();
    await harness.setClock(bounds.endMs + 20 * HOUR_MS);
    const last = await ask(harness, bucket); // ended under 24 h ago: fetched, 6 h fresh
    await harness.settled();
    await harness.setClock(bounds.endMs + 30 * HOUR_MS);
    expect(await ask(harness, bucket)).toMatchObject({
      state: 'ok',
      stale: true,
      fetchedAt: last.fetchedAt,
      reason: 'not_refreshed',
    });
    expect(harness.adb.fidsCalls()).toBe(1);
  });

  it('refuses a request for another airport, a bad zone or a bad bucket', async () => {
    const { bucket, harness } = await currentBucket();
    const base = { airportIcao: harness.icao, tz: NY, bucketStartLocal: bucket, trigger: 'board' };
    // Called on the instance: a throw across the pool's RPC boundary is also reported as an
    // unhandled rejection of the run (the plugin's doing, as designator-resolver.test.ts notes).
    const attempt = (input: unknown) =>
      runInDurableObject(harness.stub, (instance: AirportState) => instance.getBucket(input));
    await expect(attempt({ ...base, airportIcao: 'KJFK' })).rejects.toThrow(
      /^invalid_request: .*serves/,
    );
    await expect(attempt({ ...base, tz: 'Mars/Olympus' })).rejects.toThrow(
      /^invalid_request: .*zone/,
    );
    await expect(attempt({ ...base, bucketStartLocal: '2101-01-01T06:00' })).rejects.toThrow(
      /^invalid_request: /,
    );
    expect(harness.adb.calls).toEqual([]);
  });
});

describe('AirportState: the purge alarm (Terms 5.5)', () => {
  it('purges only the buckets 48 hours past their end and re-arms for the next', async () => {
    const { bucket, bounds, harness } = await currentBucket();
    const morning = `${bucket.slice(0, 10)}T00:00`;
    await ask(harness, bucket);
    await ask(harness, morning);
    await harness.settled();
    const morningBounds = boundsOf(morning);
    expect(await runInDurableObject(harness.stub, (_i, state) => state.storage.getAlarm())).toBe(
      morningBounds.endMs + 48 * HOUR_MS,
    );
    await harness.setClock(morningBounds.endMs + 48 * HOUR_MS);
    expect(await runDurableObjectAlarm(harness.stub)).toBe(true);
    const left = await runInDurableObject(harness.stub, (_i, state) => ({
      buckets: state.storage.sql
        .exec<{ bucket_start_local: string }>('SELECT bucket_start_local FROM buckets')
        .toArray()
        .map((row) => row.bucket_start_local),
      alarm: state.storage.getAlarm(),
    }));
    expect(left.buckets).toEqual([bucket]);
    expect(await left.alarm).toBe(bounds.endMs + 48 * HOUR_MS);
    expect(await testEnv.CACHE.get(boardKvKey(harness.icao, morning))).toBeNull();
    expect(await testEnv.CACHE.get(boardKvKey(harness.icao, bucket))).not.toBeNull();
  });

  const DAY_MS = 24 * HOUR_MS;
  const WEEK_MS = 7 * DAY_MS;

  /** A fresh day's clock and its object, and the PM bucket `days` ahead (position `far`). */
  async function farBucket(days: number) {
    const now = Date.parse(`${uniqueDay()}T17:00:00Z`);
    const bucket = `${new Date(now + days * DAY_MS).toISOString().slice(0, 10)}T12:00`;
    const start = boundsOf(bucket).startMs;
    const harness = await airportHarness(syntheticFids(2, adbUtc(start + HOUR_MS)), now);
    return { bucket, now, harness };
  }

  it('purges a bucket fetched 30 days ahead, KV copy and all, 7 days after the fetch (ruling R4)', async () => {
    const { bucket, now, harness } = await farBucket(30);
    expect(await ask(harness, bucket)).toMatchObject({ state: 'ok', fetchedAt: iso(now) });
    await harness.settled();
    expect(await alarmOf(harness)).toBe(now + WEEK_MS);
    // KV expires the copy then too: its TTL is relative, so about 7 days on the wall clock.
    const { keys } = await testEnv.CACHE.list({ prefix: boardKvKey(harness.icao, bucket) });
    const expiresInMs = (keys[0]?.expiration ?? 0) * 1_000 - Date.now();
    expect(Math.abs(expiresInMs - WEEK_MS)).toBeLessThan(10 * MINUTE_MS);
    await harness.setClock(now + WEEK_MS);
    expect(await runDurableObjectAlarm(harness.stub)).toBe(true);
    expect(await testEnv.CACHE.get(boardKvKey(harness.icao, bucket))).toBeNull();
    const tables = await runInDurableObject(harness.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'buckets'")
        .toArray(),
    );
    expect(tables).toEqual([]);
    // The next view costs exactly one FIDS call (and the free coverage check).
    expect(await ask(harness, bucket)).toMatchObject({
      state: 'ok',
      fetchedAt: iso(now + WEEK_MS),
    });
    expect(harness.adb.fidsCalls()).toBe(2);
    await harness.settled();
  });

  it('a refetch moves the purge: refetched 3 days on, the bucket outlives the first purge (ruling R4)', async () => {
    const { bucket, now, harness } = await farBucket(30);
    await ask(harness, bucket);
    await harness.settled();
    // Past the far rung's 48 hours of stale, the view waits for the refetch.
    await harness.setClock(now + 3 * DAY_MS);
    expect(await ask(harness, bucket)).toMatchObject({ fetchedAt: iso(now + 3 * DAY_MS) });
    await harness.settled();
    // The alarm armed for the first purge is never postponed; it finds nothing due and re-arms.
    expect(await alarmOf(harness)).toBe(now + WEEK_MS);
    await harness.setClock(now + WEEK_MS);
    expect(await runDurableObjectAlarm(harness.stub)).toBe(true);
    const purges = await runInDurableObject(harness.stub, (_instance, state) =>
      state.storage.sql
        .exec<{ purge_at_ms: number }>('SELECT purge_at_ms FROM buckets')
        .toArray()
        .map((row) => row.purge_at_ms),
    );
    expect(purges).toEqual([now + 3 * DAY_MS + WEEK_MS]);
    expect(await alarmOf(harness)).toBe(now + 3 * DAY_MS + WEEK_MS);
    expect(await testEnv.CACHE.get(boardKvKey(harness.icao, bucket))).not.toBeNull();
    expect(harness.adb.fidsCalls()).toBe(2);
  });
});

describe('the Worker read path (ruling B3): KV first, the object on a miss or past freshUntil', () => {
  it('serves a fresh KV copy alone, asks the object past freshUntil, and falls back to KV without it', async () => {
    const { bucket, now, harness } = await currentBucket();
    const request = {
      airportIcao: harness.icao,
      tz: harness.tz,
      bucketStartLocal: bucket,
      trigger: 'board' as const,
    };
    const cold = await readBoardBucket(testEnv, request, now);
    expect(cold).toMatchObject({ source: 'object', state: 'ok', stale: false });
    await harness.settled();
    const warm = await readBoardBucket(testEnv, request, now + MINUTE_MS);
    expect(warm).toMatchObject({ source: 'kv', fetchedAt: cold.fetchedAt, stale: false });
    expect(warm.rows).toEqual(cold.rows);
    expect(harness.adb.fidsCalls()).toBe(1);
    // Past freshUntil the object decides: its copy, stale, while one refresh runs.
    await harness.setClock(now + 6 * MINUTE_MS);
    expect(await readBoardBucket(testEnv, request, now + 6 * MINUTE_MS)).toMatchObject({
      source: 'object',
      stale: true,
    });
    await harness.settled();
    // The object unreachable: the KV copy, stale, never nothing; with no copy the error stands.
    const down = {
      CACHE: testEnv.CACHE,
      AIRPORT_STATE: {
        getByName: () => ({ getBucket: () => Promise.reject(new Error('object down')) }),
      },
    };
    expect(await readBoardBucket(down, request, now + 20 * MINUTE_MS)).toMatchObject({
      source: 'kv',
      stale: true,
      reason: 'object_unreachable',
    });
    const nothing = {
      ...down,
      CACHE: {
        getWithMetadata: () => Promise.resolve({ value: null, metadata: null, cacheStatus: null }),
      },
    } as unknown as typeof down;
    await expect(readBoardBucket(nothing, request, now)).rejects.toThrow('object down');
  });
});
