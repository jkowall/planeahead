/**
 * The alarm under the REAL local scheduler (ruling L13): `runDurableObjectAlarm` never delivers
 * a platform retry, so these two tests arm the alarm a few hundred milliseconds out on the wall
 * clock, inject a one-shot `transactionSync` failure, and let workerd deliver the retry
 * (`isRetry: true`, backoff from 2 s). They are the only tracker tests that wait on the clock.
 *
 *   1. The LAST slot, interrupted after step 1 committed (the apply transaction fails): the
 *      retry finds the committed plan with no next slot, skips the provider, and runs the finish
 *      path. Before the fix the retry returned without finishing or re-arming, and the tracker
 *      was abandoned for good (review finding alarm-and-transactions-1).
 *   2. Step 1 itself fails: the retry finds the due slot still due (step 1 rolled back) and
 *      polls it. Before the fix the retry judged freshness against the PREVIOUS slot's attempt
 *      and skipped the slot with no alarm left (finding alarm-and-transactions-5).
 *
 * Observed while writing them (workerd 1.20260918.1, the pool's local scheduler): a handler that
 * COMMITTED a new alarm in step 1 and then threw is not retried at all; the committed alarm
 * stands and fires on its own. The retry exists only for a handler that left the alarm as it
 * found it (step 1 rolled back, or a last slot that arms nothing). Ruling L13 makes the schedule
 * independent of either behaviour: the committed plan decides on a retry, and the committed
 * alarm carries the cadence when there is none.
 */

import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_SCHEMA_VERSION } from '@planeahead/shared';
import { FINISH_ALARM_MS, type FlightTracker } from '../../src/do/flight-tracker';
import {
  HOUR_MS,
  MINUTE_MS,
  adbCalls,
  adbOk,
  drainTouched,
  onTimePhaseAt,
  openBudgetFor,
  resolverHarness,
  scriptAdb,
  trackerHarness,
  uniqueFlight,
  type TestFlight,
  type TrackerHarness,
} from './helpers/flights';

afterEach(drainTouched);

interface AlarmRun {
  retryCount: number;
  isRetry: boolean;
  error: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function seeded(flight: TestFlight, clock: number): Promise<TrackerHarness> {
  await scriptAdb(flight, [adbOk(flight, { phase: onTimePhaseAt(flight, clock) })]);
  const tracker = await trackerHarness(flight.flightKey, clock);
  await openBudgetFor(flight, clock);
  const resolver = await resolverHarness(flight, clock);
  const resolved = await resolver.stub.resolve({
    rpcVersion: RPC_SCHEMA_VERSION,
    designator: flight.designator,
    dateLocal: flight.dateLocal,
  });
  expect(resolved.outcome).toBe('resolved');
  return tracker;
}

/** Records every `alarm()` invocation on the instance, then arms the alarm `inMs` out. */
async function armWithRecorder(tracker: TrackerHarness, inMs: number): Promise<void> {
  await runInDurableObject(tracker.stub, async (instance: FlightTracker, state) => {
    const runs: AlarmRun[] = [];
    (instance as unknown as { runs: AlarmRun[] }).runs = runs;
    const original = instance.alarm.bind(instance);
    Object.defineProperty(instance, 'alarm', {
      configurable: true,
      writable: true,
      value: async (info?: AlarmInvocationInfo): Promise<void> => {
        const run: AlarmRun = {
          retryCount: info?.retryCount ?? 0,
          isRetry: info?.isRetry ?? false,
          error: null,
        };
        runs.push(run);
        try {
          await original(info);
        } catch (error) {
          run.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      },
    });
    await state.storage.setAlarm(Date.now() + inMs);
  });
}

/** The `nth` `transactionSync` call from now throws once, without running its callback. */
async function failNthTransaction(tracker: TrackerHarness, nth: number): Promise<void> {
  await runInDurableObject(tracker.stub, (_instance, state) => {
    const storage = state.storage as unknown as {
      transactionSync: <T>(fn: () => T) => T;
    };
    const original = storage.transactionSync.bind(state.storage);
    let calls = 0;
    Object.defineProperty(state.storage, 'transactionSync', {
      configurable: true,
      writable: true,
      value: <T>(fn: () => T): T => {
        calls += 1;
        if (calls === nth) {
          Object.defineProperty(state.storage, 'transactionSync', {
            configurable: true,
            writable: true,
            value: original,
          });
          throw new Error('injected storage failure');
        }
        return original(fn);
      },
    });
  });
}

async function runsOf(tracker: TrackerHarness): Promise<AlarmRun[]> {
  return runInDurableObject(tracker.stub, (instance: FlightTracker) => [
    ...(instance as unknown as { runs: AlarmRun[] }).runs,
  ]);
}

/** Polls until the platform has delivered `expected` invocations, or ten seconds pass. */
async function waitForRuns(tracker: TrackerHarness, expected: number): Promise<AlarmRun[]> {
  const deadline = Date.now() + 10_000;
  let runs: AlarmRun[] = [];
  while (Date.now() < deadline) {
    await sleep(200);
    runs = await runsOf(tracker);
    if (runs.length >= expected && (await tracker.alarmAt()) !== null) {
      break;
    }
  }
  return runs;
}

describe('FlightTracker under the real local scheduler', () => {
  it('finishes the last slot when its apply fails after step 1 committed and the platform retries', async () => {
    const flight = uniqueFlight();
    // Seeded half an hour after arrival: the cadence's one remaining tail poll is the last slot
    // (the finish below proves it: a slot with a successor would only re-arm).
    const creation = flight.scheduledIn.getTime() + 30 * MINUTE_MS;
    const tracker = await seeded(flight, creation);
    const tail = await tracker.alarmAt();
    expect(tail).not.toBeNull();
    if (tail === null) {
      return;
    }
    expect(await adbCalls(flight)).toBe(1);
    await tracker.setClock(tail);

    // The second transactionSync of the alarm is the apply (step 4); step 1 has committed the
    // attempt row and a plan with no next slot by then.
    await failNthTransaction(tracker, 2);
    await armWithRecorder(tracker, 300);
    const runs = await waitForRuns(tracker, 2);

    expect(runs.map((run) => ({ ...run, error: run.error !== null }))).toEqual([
      { retryCount: 0, isRetry: false, error: true },
      { retryCount: 1, isRetry: true, error: false },
    ]);
    // One provider call for the slot, then the finish path: archived, finished, +22 h alarm.
    expect(await adbCalls(flight)).toBe(2);
    const [row] = await tracker.rows<{
      phase: string;
      finish_reason: string | null;
      next_refresh_at_ms: number | null;
      events_r2_key: string | null;
    }>('SELECT phase, finish_reason, next_refresh_at_ms, events_r2_key FROM flight');
    expect(row).toMatchObject({ phase: 'finished', finish_reason: 'arrived' });
    expect(row?.events_r2_key).not.toBeNull();
    expect(await tracker.alarmAt()).toBe(tail + FINISH_ALARM_MS);
    const [attempt] = await tracker.rows<{ outcome: string; retry_count: number }>(
      'SELECT outcome, retry_count FROM attempts WHERE slot_ms = ?',
      tail,
    );
    expect(attempt).toEqual({ outcome: 'skipped_retry', retry_count: 1 });
  });

  it('polls the due slot when step 1 itself failed and the platform retries', async () => {
    const flight = uniqueFlight();
    const creation = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    const tracker = await seeded(flight, creation);
    const slot = creation + HOUR_MS;
    expect(await tracker.alarmAt()).toBe(slot);
    await tracker.setClock(slot);

    await failNthTransaction(tracker, 1);
    await armWithRecorder(tracker, 300);
    const runs = await waitForRuns(tracker, 2);

    expect(runs.map((run) => ({ ...run, error: run.error !== null }))).toEqual([
      { retryCount: 0, isRetry: false, error: true },
      { retryCount: 1, isRetry: true, error: false },
    ]);
    // The retry found the slot still due and polled it once; the cadence continues.
    expect(await adbCalls(flight)).toBe(2);
    expect(await tracker.alarmAt()).toBe(slot + HOUR_MS);
    expect((await tracker.stub.getState()).nextRefreshAt).toBe(
      new Date(slot + HOUR_MS).toISOString(),
    );
    const [attempt] = await tracker.rows<{ outcome: string; retry_count: number }>(
      'SELECT outcome, retry_count FROM attempts WHERE slot_ms = ?',
      slot,
    );
    expect(attempt).toEqual({ outcome: 'ok', retry_count: 1 });
  });
});
