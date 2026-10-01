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

import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REREAD_TOLERANCE_MS, policyWants, readPolicyState } from '@planeahead/shared';
import { ROWS_WRITTEN_BUDGET_PER_FLIGHT, type FlightTracker } from '../../src/do/flight-tracker';
import {
  HOUR_MS,
  MINUTE_MS,
  adbCalls,
  drainTouched,
  scriptAdb,
  uniqueFlight,
  type TestFlight,
  type TrackerHarness,
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

const enRoute = (flight: TestFlight) => answer(flight, { phase: 'en_route' });
const diverted = (flight: TestFlight) =>
  answer(flight, { phase: 'en_route' }, { status: 'Diverted' });
const cancelledAirborne = (flight: TestFlight) =>
  answer(flight, { phase: 'en_route' }, { status: 'Canceled' });

describe('Q19 (a): a cancellation supersedes an open diversion suspicion (the re-review regression)', () => {
  it('Diverted, then Canceled on the re-read: the next alarm 5 minutes on, one intent, finished cancelled', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const tracker = await seeded(flight, out + 30 * MINUTE_MS, enRoute(flight));
    await scriptAdb(flight, [diverted(flight)]);
    const t0 = await nextAlarm(tracker);
    expect(await policyState(tracker)).toMatchObject({
      diversion: { status: 'suspect', value: 'diverted', fastLeft: 3 },
    });
    expect(await tracker.alarmAt()).toBe(t0 + 5 * MINUTE_MS);
    await scriptAdb(flight, [cancelledAirborne(flight)]);
    const t1 = await nextAlarm(tracker);
    // The diversion is dropped without an intent or a unit of the budget; nothing is owed at a
    // past instant: the cancellation's own re-read is 5 minutes on. Before the fix the open
    // diversion kept `wants.at` at t0 + 5 and the alarm landed at `now` after every read.
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'suspect', value: 'cancelled', fastLeft: 3 },
      diversion: { status: 'none' },
      fastRereadsLeft: 6,
    });
    expect(await tracker.alarmAt()).toBe(t1 + 5 * MINUTE_MS);
    expect(intentsOf(tracker)).toEqual([]);
    expect(await flightRow(tracker)).toMatchObject({ phase: 'en_route', finish_reason: null });
    const t2 = await nextAlarm(tracker);
    expect(t2 - t0).toBe(10 * MINUTE_MS);
    expect(intentsOf(tracker).map((m) => m.payload.intent.value)).toEqual(['cancelled']);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'cancelled',
    });
    expect(eventsOf(tracker, 'diversion_suspect')).toHaveLength(1);
    expect(eventsOf(tracker, 'cancel_suspect')).toHaveLength(1);
    // The seed, the cadence poll and two re-reads: before the fix, about 4,900 calls.
    expect(await adbCalls(flight)).toBe(4);
    expectOnePayloadPerVersion(tracker);
  });

  it('the re-reviewer probe: the clock 1 s per alarm, the loop ends at the confirming alarm', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const tracker = await seeded(flight, out + 30 * MINUTE_MS, enRoute(flight));
    await scriptAdb(flight, [diverted(flight)]);
    const t0 = await nextAlarm(tracker);
    await scriptAdb(flight, [cancelledAirborne(flight)]);
    let clock = t0;
    let alarms = 0;
    // Before the fix: 900 alarms and 900 provider calls in 20 simulated minutes.
    while (alarms < 900 && (await flightRow(tracker))?.phase !== 'finished') {
      const at = await tracker.alarmAt();
      expect(at).not.toBeNull();
      clock = Math.max(at ?? 0, clock + 1000);
      await tracker.setClock(clock);
      expect(await tracker.runAlarm()).toBe(true);
      alarms += 1;
      const next = await tracker.alarmAt();
      expect(next === null || next > clock + REREAD_TOLERANCE_MS).toBe(true);
    }
    expect({ alarms, minutes: (clock - t0) / MINUTE_MS }).toEqual({ alarms: 2, minutes: 10 });
    expect(intentsOf(tracker).map((m) => m.payload.intent.value)).toEqual(['cancelled']);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'cancelled',
    });
    expect(await adbCalls(flight)).toBe(4);
    const written = await runInDurableObject(
      tracker.stub,
      (instance: FlightTracker) => instance.rowsWrittenLifetime,
    );
    expect(written).toBeLessThan(ROWS_WRITTEN_BUDGET_PER_FLIGHT);
  });
  it('the re-read clears the cancellation but still shows Diverted: suspected afresh, then confirmed', async () => {
    const flight = uniqueFlight();
    const out = flight.scheduledOut.getTime();
    const tracker = await seeded(flight, out + 30 * MINUTE_MS, enRoute(flight));
    await scriptAdb(flight, [diverted(flight)]);
    const t0 = await nextAlarm(tracker);
    await scriptAdb(flight, [cancelledAirborne(flight)]);
    await nextAlarm(tracker);
    await scriptAdb(flight, [diverted(flight)]);
    const cleared = await nextAlarm(tracker);
    expect(cleared).toBe(t0 + 10 * MINUTE_MS);
    // The clearing read decided the cancellation (one unit) and raised the diversion afresh.
    expect(await policyState(tracker)).toMatchObject({
      cancellation: { status: 'none' },
      diversion: { status: 'suspect', value: 'diverted', since: cleared, fastLeft: 3 },
      fastRereadsLeft: 5,
    });
    expect(await tracker.alarmAt()).toBe(cleared + 5 * MINUTE_MS);
    expect(intentsOf(tracker)).toEqual([]);
    await nextAlarm(tracker);
    expect(intentsOf(tracker).map((m) => m.payload.intent.kind)).toEqual(['diversion']);
    expect(await policyState(tracker)).toMatchObject({
      diversion: { status: 'pushed', value: 'diverted' },
      fastRereadsLeft: 4,
    });
    expect(await flightRow(tracker)).toMatchObject({ phase: 'diverted', finish_reason: null });
    expect(await adbCalls(flight)).toBe(5);
    expectOnePayloadPerVersion(tracker);
  });
});

describe('Q19 (c): the backstop when the policy leaves a re-read due at the read itself', () => {
  /** The policy as the regression had it: the re-read decides nothing and moves no window. */
  const freeze = (tracker: TrackerHarness) =>
    runInDurableObject(tracker.stub, (instance: FlightTracker) => {
      instance.policy = {
        ...instance.policy,
        evaluateReread: (input) => ({
          intents: [],
          state: input.state,
          wants: policyWants(input.state),
        }),
      };
    });

  it('floors the next alarm to the read plus 5 minutes and logs policy_wants_overdue', async () => {
    const flight = uniqueFlight();
    const tracker = await seeded(flight, flight.scheduledOut.getTime() - 2 * HOUR_MS);
    await scriptAdb(flight, [cancelled(flight)]);
    const seen = await nextAlarm(tracker);
    await freeze(tracker);
    const logs = vi.spyOn(console, 'log');
    const reread = await nextAlarm(tracker);
    expect(reread).toBe(seen + 5 * MINUTE_MS);
    // The stored state still owes the re-read at `reread` itself; never an alarm at `now`.
    expect(await policyState(tracker)).toMatchObject({ cancellation: { lastReadAt: seen } });
    expect(await tracker.alarmAt()).toBe(reread + 5 * MINUTE_MS);
    const lines = logs.mock.calls.map(([line]) => String(line));
    const overdue = lines.filter((line) => line.includes('"event":"policy_wants_overdue"'));
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toContain('"level":"error"');
    expect(intentsOf(tracker)).toEqual([]);
    expect((await flightRow(tracker))?.phase).not.toBe('cancelled');
  });
  it('holds no finish on a frozen suspicion: past the last slot the flight finishes', async () => {
    const flight = uniqueFlight();
    const last = lastSlotOf(flight);
    const tracker = await seeded(flight, last - 20 * MINUTE_MS);
    await scriptAdb(flight, [cancelled(flight)]);
    await nextAlarm(tracker);
    expect(await tracker.alarmAt()).toBe(last + 5 * MINUTE_MS);
    await freeze(tracker);
    const logs = vi.spyOn(console, 'log');
    await nextAlarm(tracker);
    expect(await flightRow(tracker)).toMatchObject({
      phase: 'finished',
      finish_reason: 'lifetime',
    });
    expect(intentsOf(tracker)).toEqual([]);
    const lines = logs.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes('"event":"policy_wants_overdue"'))).toHaveLength(1);
    expect(await adbCalls(flight)).toBe(3);
  });
});

/** mulberry32: a small seeded generator, so a failing walk is reproducible by its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Q19: random answer sequences never leave a re-read in the past', () => {
  it('over five seeded walks, wants.at is after every read and the alarm after it', async () => {
    // Seeds 6 and 15 answer Canceled while a diversion suspicion is open, the re-review's
    // regression (the other three never do); the walks must meet that case at least once.
    let cancelledOverOpenDiversion = 0;
    for (const seed of [6, 11, 15, 23, 37]) {
      const random = prng(seed);
      const flight = uniqueFlight();
      const out = flight.scheduledOut.getTime();
      const tracker = await seeded(flight, out + 30 * MINUTE_MS, enRoute(flight));
      const cancelledAnswer = () => cancelledAirborne(flight);
      const answers = [
        () => enRoute(flight),
        () => diverted(flight),
        cancelledAnswer,
        () => answer(flight, { phase: 'en_route' }, { status: 'CanceledUncertain' }),
        () => answer(flight, { phase: 'en_route' }, { arrivalRevisedMs: out + 4 * HOUR_MS }),
        () => ({ status: 500, body: { message: 'unavailable' } }),
      ];
      let budget = 6;
      let before = readPolicyState(await policyState(tracker));
      for (let i = 0; i < 25 && (await flightRow(tracker))?.phase !== 'finished'; i += 1) {
        const next = answers[Math.floor(random() * answers.length)]!;
        if (next === cancelledAnswer && before?.diversion.status === 'suspect') {
          cancelledOverOpenDiversion += 1;
        }
        await scriptAdb(flight, [next()]);
        // `nextAlarm` asserts the alarm after this one is later than the read itself.
        const at = await nextAlarm(tracker);
        const state = readPolicyState(await policyState(tracker));
        expect(state).not.toBeNull();
        const wants = state === null ? null : policyWants(state);
        expect(wants === null || wants.at > at + REREAD_TOLERANCE_MS).toBe(true);
        const both = state?.cancellation.status !== 'none' && state?.diversion.status === 'suspect';
        expect(both).toBe(false);
        expect(budget - (state?.fastRereadsLeft ?? 0)).toBeLessThanOrEqual(1);
        budget = state?.fastRereadsLeft ?? 0;
        before = state;
      }
    }
    expect(cancelledOverOpenDiversion).toBeGreaterThan(0);
  });
});
