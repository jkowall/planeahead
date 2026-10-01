/**
 * A suspected cancellation or diversion inside the FlightTracker, AeroDataBox only (mock mode),
 * as increment 15's review rulings Q1, Q3, Q4 and Q11 shape it:
 *
 *   - Q11 (1): a suspicion is evidence, not state: the stored snapshot, phase, instance rows and
 *     KV stay the last confirmed ones until a conclusive re-read; `cancelled` is shown only from
 *     the version its intent was written at, never two instance payloads under one version;
 *   - Q11 (2): `CanceledUncertain` is inconclusive and keeps the suspicion;
 *   - Q4 and Q11 (3): the fast re-reads hold the finish past the cadence's last slot, so a
 *     cancellation or a diversion first seen there is confirmed and pushed; still suspect once
 *     they are spent, the flight finishes without a push and says `cancel_unconfirmed`;
 *   - Q3: failed re-reads are counted by the policy, so provider calls stay bounded.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOUR_MS,
  MINUTE_MS,
  adbCalls,
  drainTouched,
  scriptAdb,
  uniqueFlight,
  type TestFlight,
} from './helpers/flights';
import {
  answer,
  captureKv,
  eventsOf,
  expectOnePayloadPerVersion,
  flightRow,
  instancesOf,
  intentsOf,
  kvSettled,
  nextAlarm,
  policyState,
  seeded,
} from './helpers/policy';

afterEach(async () => {
  vi.restoreAllMocks();
  await drainTouched();
});

const cancelled = (flight: TestFlight) =>
  answer(flight, { phase: 'expected' }, { status: 'Canceled' });

describe('Q11 in mock mode: a cancellation is evidence until AeroDataBox repeats it', () => {
  it('Canceled then Canceled: one intent, and nothing shows cancelled before it', async () => {
    const flight = uniqueFlight();
    const tracker = await seeded(flight, flight.scheduledOut.getTime() - 2 * HOUR_MS);
    const kv = await captureKv(tracker);
    await scriptAdb(flight, [cancelled(flight)]);
    const seen = await nextAlarm(tracker);
    expect(await tracker.alarmAt()).toBe(seen + 5 * MINUTE_MS);
    await nextAlarm(tracker);
    await kvSettled(tracker);

    const [intent, ...more] = intentsOf(tracker);
    expect(more).toEqual([]);
    expect(intent?.payload.intent).toMatchObject({ kind: 'cancellation', value: 'cancelled' });
    // The status and the intent commit at one version, and nothing said `cancelled` before it.
    const version = Number(/:v(\d+)$/.exec(intent?.payload.dedupeKey ?? '')?.[1]);
    const shown = instancesOf(tracker).filter((m) => m.payload.snapshot?.status === 'cancelled');
    expect(Math.min(...shown.map((m) => m.payload.version))).toBe(version);
    expect(Math.min(...shown.map((m) => m.seq))).toBeGreaterThan(intent?.seq ?? Infinity);
    const kvShown = kv.filter((value) => value.snapshot?.status === 'cancelled');
    expect(kvShown.length).toBeGreaterThan(0);
    expect(kvShown.every((value) => value.version >= version)).toBe(true);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'cancelled',
    });
    expect(await adbCalls(flight)).toBe(3);
    expectOnePayloadPerVersion(tracker);
  });

  it('Canceled then CanceledUncertain: the suspicion stays and the fast re-reads go on', async () => {
    const flight = uniqueFlight();
    const tracker = await seeded(flight, flight.scheduledOut.getTime() - 2 * HOUR_MS);
    await scriptAdb(flight, [cancelled(flight)]);
    const seen = await nextAlarm(tracker);
    expect(eventsOf(tracker, 'cancel_suspect')).toMatchObject([
      { field: 'cancellation', newValue: 'cancelled', source: 'aerodatabox' },
    ]);
    await scriptAdb(flight, [
      answer(flight, { phase: 'expected' }, { status: 'CanceledUncertain' }),
    ]);
    const reread = await nextAlarm(tracker);
    expect(reread).toBe(seen + 5 * MINUTE_MS);
    // Inconclusive: one fast re-read spent, the next 5 minutes on, nothing pushed or shown.
    expect(intentsOf(tracker)).toEqual([]);
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'suspect', provider: 'aerodatabox', reads: 1, fastLeft: 2 },
      fastRereadsLeft: 5,
    });
    expect((await flightRow(tracker))?.phase).not.toBe('cancelled');
    expect(await tracker.alarmAt()).toBe(reread + 5 * MINUTE_MS);
    // One suspicion, one event: the re-read that kept it wrote none.
    expect(eventsOf(tracker, 'cancel_suspect')).toHaveLength(1);
    // The next conclusive answer decides.
    await scriptAdb(flight, [cancelled(flight)]);
    await nextAlarm(tracker);
    expect(intentsOf(tracker).map((m) => m.payload.intent.value)).toEqual(['cancelled']);
    expect(await adbCalls(flight)).toBe(4);
    expectOnePayloadPerVersion(tracker);
  });
});

/** A flight that never leaves: its last slot is its lifetime, scheduled in plus 6 hours. */
const lastSlotOf = (flight: TestFlight) => flight.scheduledIn.getTime() + 6 * HOUR_MS;

describe('Q4 and Q11 (3): the fast re-reads hold the finish past the last slot', () => {
  it('confirms and pushes a cancellation first seen at the last slot (F4)', async () => {
    const flight = uniqueFlight();
    const last = lastSlotOf(flight);
    const tracker = await seeded(flight, last - 20 * MINUTE_MS);
    expect(await tracker.alarmAt()).toBe(last);
    await scriptAdb(flight, [cancelled(flight)]);
    await nextAlarm(tracker);
    // Held, not finished: the re-read 5 minutes past the cadence's end.
    expect(await flightRow(tracker)).toMatchObject({ finish_reason: null });
    expect(await tracker.alarmAt()).toBe(last + 5 * MINUTE_MS);
    await nextAlarm(tracker);
    expect(intentsOf(tracker).map((m) => m.payload.intent.value)).toEqual(['cancelled']);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'cancelled',
    });
    expect(await adbCalls(flight)).toBe(3);
    expectOnePayloadPerVersion(tracker);
  });

  it('still suspect once the fast re-reads are spent: finishes, pushes nothing, says so', async () => {
    const flight = uniqueFlight();
    const last = lastSlotOf(flight);
    const tracker = await seeded(flight, last - 20 * MINUTE_MS);
    const logs = vi.spyOn(console, 'log');
    await scriptAdb(flight, [cancelled(flight)]);
    await nextAlarm(tracker);
    await scriptAdb(flight, [
      answer(flight, { phase: 'expected' }, { status: 'CanceledUncertain' }),
    ]);
    const reads = [await nextAlarm(tracker), await nextAlarm(tracker), await nextAlarm(tracker)];
    expect(reads).toEqual([5, 10, 15].map((minutes) => last + minutes * MINUTE_MS));
    expect(intentsOf(tracker)).toEqual([]);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'lifetime',
    });
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'suspect', reads: 3, fastLeft: 0 },
    });
    const lines = logs.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes('"event":"cancel_unconfirmed"'))).toHaveLength(1);
    expect(await adbCalls(flight)).toBe(5);
  });

  it('confirms and pushes a diversion first seen at the last slot', async () => {
    const flight = uniqueFlight();
    // Off at scheduled out and never in: the lifetime is off plus twice the block.
    const last = flight.scheduledOut.getTime() + 6 * HOUR_MS;
    const tracker = await seeded(
      flight,
      last - 20 * MINUTE_MS,
      answer(flight, { phase: 'en_route' }),
    );
    expect(await tracker.alarmAt()).toBe(last);
    const diverted = answer(flight, { phase: 'en_route' }, { status: 'Diverted' });
    await scriptAdb(flight, [diverted]);
    await nextAlarm(tracker);
    expect(await flightRow(tracker)).toMatchObject({ phase: 'en_route', finish_reason: null });
    expect(eventsOf(tracker, 'diversion_suspect')).toHaveLength(1);
    expect(await tracker.alarmAt()).toBe(last + 5 * MINUTE_MS);
    await nextAlarm(tracker);
    expect(intentsOf(tracker).map((m) => m.payload.intent.kind)).toEqual(['diversion']);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'lifetime',
    });
    expectOnePayloadPerVersion(tracker);
  });
});

describe('Q3 and Q11 (3): failed re-reads are counted, never retried in a loop', () => {
  const failing = { status: 500, body: { message: 'unavailable' } };

  it('a suspicion whose re-reads all fail costs its fast re-reads, then rides the cadence (F3)', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    // The hourly band (T-48 h to T-6 h), where every extra read shows.
    const tracker = await seeded(flight, out - 10 * HOUR_MS - 30 * MINUTE_MS);
    await scriptAdb(flight, [cancelled(flight)]);
    const seen = await nextAlarm(tracker);
    await scriptAdb(flight, [failing]);
    const alarms: number[] = [];
    // Minutes after the suspicion; bounded so a regression fails rather than spins.
    while ((alarms.at(-1) ?? 0) < 180 && alarms.length < 20) {
      alarms.push(((await nextAlarm(tracker)) - seen) / MINUTE_MS);
    }
    // Three fast re-reads 5 minutes apart, then the cadence's own hourly slots are the re-reads.
    expect(alarms).toEqual([5, 10, 15, 60, 120, 180]);
    expect(await adbCalls(flight)).toBe(2 + alarms.length);
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'suspect', reads: 6, fastLeft: 0 },
      fastRereadsLeft: 3,
    });
    expect(intentsOf(tracker)).toEqual([]);
    expect((await flightRow(tracker))?.phase).not.toBe('cancelled');
  });

  it('a delay settle re-read fails at most twice at +5 minutes, then the next slot reads (Q3)', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const tracker = await seeded(flight, out - 2 * HOUR_MS);
    const delayed = answer(flight, { phase: 'expected' }, { departureRevisedMs: out + HOUR_MS });
    await scriptAdb(flight, [delayed]);
    const seen = await nextAlarm(tracker);
    await scriptAdb(flight, [failing]);
    const failed = [await nextAlarm(tracker), await nextAlarm(tracker)];
    expect(failed).toEqual([seen + 5 * MINUTE_MS, seen + 10 * MINUTE_MS]);
    // The pending delay stays due: the cadence's next slot (15 minutes on) is the re-read.
    expect(await tracker.alarmAt()).toBe(seen + 15 * MINUTE_MS);
    await scriptAdb(flight, [delayed]);
    await nextAlarm(tracker);
    expect(intentsOf(tracker).map((m) => m.payload.intent)).toMatchObject([
      { kind: 'delay', subject: 'departure', value: '60' },
    ]);
    expect(await adbCalls(flight)).toBe(5);
    expectOnePayloadPerVersion(tracker);
  });
});

describe('Q1: never two different instance payloads under one version', () => {
  it('a re-read that moves only the schedule sends its row under a new version', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const tracker = await seeded(flight, out - 2 * HOUR_MS);
    const delayed = answer(flight, { phase: 'expected' }, { departureRevisedMs: out + HOUR_MS });
    await scriptAdb(flight, [delayed]);
    const seen = await nextAlarm(tracker);
    // Nothing confirms the outbox here, so each flush re-sends older rows: count new seqs only.
    const before = Math.max(...instancesOf(tracker).map((m) => m.seq));
    // The settle re-read answers exactly what the poll did: step 1's row planned the next
    // re-read 5 minutes on, step 4's moves back to the cadence's slot. Before the fix both
    // went out under step 1's version, and persist kept the stale `nextRefreshAt`.
    await nextAlarm(tracker);
    const rows = instancesOf(tracker).filter((m) => m.seq > before);
    expect(rows.map((m) => m.payload.nextRefreshAt)).toEqual(
      [10, 15].map((minutes) => new Date(seen + minutes * MINUTE_MS).toISOString()),
    );
    const [first, second] = rows.map((m) => m.payload.version);
    expect(second).toBe((first ?? 0) + 1);
    expect(intentsOf(tracker).map((m) => m.payload.intent.value)).toEqual(['60']);
    expectOnePayloadPerVersion(tracker);
  });
});
