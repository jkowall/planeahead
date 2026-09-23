/**
 * Increment 7 spikes (orchestrator ruling J1). Four facts the FlightTracker design rests on,
 * each pinned by a test so a workerd upgrade that changes one fails loudly here rather than in
 * an alarm handler at 03:00:
 *
 *   1. `setAlarm()` inside `transactionSync()` is covered by the rollback: a throw after it
 *      leaves `getAlarm()` at its previous value. The alarm handler's step 1 (attempt row, budget
 *      debit, outbox intent, next alarm, one commit) depends on this; ADR 0011 records it.
 *      1b (the review's in-handler case): inside a scheduler-invoked handler the "previous
 *      value" is the running alarm's own time, and a handler that swallows the rolled-back
 *      transaction and returns leaves that stale time visible, so the tracker never swallows one.
 *   2. Whether an alarm scheduled from a test fires on its own wall clock under the Vitest pool.
 *      It does (200 ms out, no `runDurableObjectAlarm` call), so the `afterEach` drain in every
 *      Durable Object test is a guard against cross-test interference, not the only trigger.
 *      This is the ONE test in the suite that sleeps: the whole point is to watch the clock.
 *   3. Whether a floating rejected promise inside `alarm()` fails the invocation. The handler
 *      catches everything explicitly regardless; the observation says what the platform would do
 *      if one slipped through.
 *   4. `PRAGMA foreign_keys` is ON in workerd's build: a child insert without its parent fails, a
 *      parent delete under a child fails, and deleting the child first works. The FlightTracker's
 *      schema orders its deletes accordingly.
 *
 * Hosts: `AirportState` (empty migrations, no alarm handler) for the storage spikes, and
 * `ProviderBudget` (a real `alarm()` that calls `deleteAll()` on an object nothing was reserved
 * on) for the two that need the platform to invoke a handler. No test-only Durable Object class:
 * `exports` in wrangler.jsonc is a one-way door.
 */

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderBudget } from '../../src/do/provider-budget';
import type { Env } from '../../src/env';

const testEnv = env as Env;
const touched: DurableObjectStub[] = [];

function airportHost(prefix: string): DurableObjectStub {
  const stub = testEnv.AIRPORT_STATE.getByName(`spike-${prefix}-${crypto.randomUUID()}`);
  touched.push(stub);
  return stub;
}

/** A ProviderBudget on a valid, unused, far-future day (its name must be `${provider}:${date}`). */
function budgetHost(): DurableObjectStub<ProviderBudget> {
  const year = 2150 + Math.floor(Math.random() * 30);
  const day = 1 + Math.floor(Math.random() * 28);
  const month = 1 + Math.floor(Math.random() * 12);
  const date = `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const stub = testEnv.PROVIDER_BUDGET.getByName(`aerodatabox:${date}`);
  touched.push(stub);
  return stub;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

afterEach(async () => {
  while (touched.length > 0) {
    const stub = touched.pop();
    if (stub !== undefined) {
      // Cancel rather than run: the storage hosts have no alarm handler, and the spikes below
      // leave nothing that should be executed.
      await runInDurableObject(stub, (_instance, state) => state.storage.deleteAlarm());
      await runDurableObjectAlarm(stub);
    }
  }
});

describe('spike 1: setAlarm inside transactionSync rolls back with the transaction', () => {
  it('a throw after setAlarm leaves getAlarm() at null when no alarm was set', async () => {
    const outcome = await runInDurableObject(airportHost('rollback-null'), async (_i, state) => {
      const before = await state.storage.getAlarm();
      let threw = false;
      try {
        state.storage.transactionSync(() => {
          void state.storage.setAlarm(Date.now() + 60 * 60_000);
          throw new Error('rolled back on purpose');
        });
      } catch {
        threw = true;
      }
      return { before, threw, after: await state.storage.getAlarm() };
    });

    expect(outcome).toEqual({ before: null, threw: true, after: null });
  });

  it('a throw after setAlarm leaves getAlarm() at the previously committed time', async () => {
    const outcome = await runInDurableObject(airportHost('rollback-prev'), async (_i, state) => {
      const first = Date.now() + 60 * 60_000;
      const second = first + 60 * 60_000;
      await state.storage.setAlarm(first);
      try {
        state.storage.transactionSync(() => {
          void state.storage.setAlarm(second);
          throw new Error('rolled back on purpose');
        });
      } catch {
        // expected
      }
      const after = await state.storage.getAlarm();
      await state.storage.deleteAlarm();
      return { first, second, after };
    });

    expect(outcome.after).toBe(outcome.first);
    expect(outcome.after).not.toBe(outcome.second);
  });

  it('positive control: setAlarm inside a committed transactionSync is visible afterwards', async () => {
    const outcome = await runInDurableObject(airportHost('commit'), async (_i, state) => {
      const at = Date.now() + 60 * 60_000;
      state.storage.transactionSync(() => {
        void state.storage.setAlarm(at);
      });
      const after = await state.storage.getAlarm();
      await state.storage.deleteAlarm();
      return { at, after };
    });

    expect(outcome.after).toBe(outcome.at);
  });
});

/**
 * Spike 1 inside a scheduler-invoked handler (increment 7 review, alarm-and-transactions-9):
 * replaces the host's `alarm()` with one that reads `getAlarm()`, runs
 * `transactionSync(() => { setAlarm(target); throw })`, reads `getAlarm()` again and returns
 * normally; then arms the alarm 100 ms out and samples afterwards.
 */
function scheduleRollbackProbe(
  stub: DurableObjectStub<ProviderBudget>,
): Promise<{ scheduledFor: number; target: number }> {
  return runInDurableObject(stub, async (instance: ProviderBudget, state) => {
    state.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS spike_probe (id INTEGER PRIMARY KEY, before INTEGER, after INTEGER)',
    );
    const target = Date.now() + 6 * 60 * 60_000;
    Object.defineProperty(instance, 'alarm', {
      configurable: true,
      writable: true,
      value: async () => {
        const before = await state.storage.getAlarm();
        try {
          state.storage.transactionSync(() => {
            void state.storage.setAlarm(target);
            throw new Error('rolled back inside the handler on purpose');
          });
        } catch {
          // swallowed on purpose: the probe is about what the handler then sees
        }
        const after = await state.storage.getAlarm();
        state.storage.sql.exec(
          'INSERT INTO spike_probe (id, before, after) VALUES (NULL, ?, ?)',
          before,
          after,
        );
      },
    });
    const scheduledFor = Date.now() + 100;
    await state.storage.setAlarm(scheduledFor);
    return { scheduledFor, target };
  });
}

describe('spike 1b: a rolled-back setAlarm inside a scheduler-invoked handler', () => {
  // Observed on 2026-09-22 (workerd 1.20260918.1): inside the running handler `getAlarm()`
  // reads null (the alarm being delivered is no longer pending); after the rolled-back
  // `setAlarm` it reads the RUNNING alarm's own, already past, scheduled time; and once the
  // handler returns normally that stale time stays visible and is not re-fired. The rollback
  // restores the metadata cache to "the alarm being delivered", which the handler's normal
  // completion then does not clear. The consequence for the FlightTracker (ADR 0011): inside
  // `alarm()` a transaction that set an alarm must never be swallowed. Rethrow it, or call
  // `deleteAlarm()` or `setAlarm` afterwards. `#tx` failures in the tracker propagate.
  it("leaves the running alarm's stale time visible after the handler completes", async () => {
    const stub = budgetHost();
    const { scheduledFor, target } = await scheduleRollbackProbe(stub);

    const deadline = Date.now() + 3_500;
    let probe: { before: number | null; after: number | null }[] = [];
    let alarm: number | null = null;
    let runs = 0;
    while (Date.now() < deadline) {
      await sleep(250);
      const sample = await runInDurableObject(stub, async (_instance, state) => ({
        probe: state.storage.sql
          .exec<{ before: number | null; after: number | null }>(
            'SELECT before, after FROM spike_probe ORDER BY id',
          )
          .toArray(),
        alarm: await state.storage.getAlarm(),
      }));
      probe = sample.probe;
      alarm = sample.alarm;
      runs = probe.length;
    }

    expect(runs).toBe(1);
    expect(probe[0]?.before).toBeNull();
    expect(probe[0]?.after).toBe(scheduledFor);
    expect(probe[0]?.after).not.toBe(target);
    // The ghost: reported after the handler returned, in the past, and never re-fired.
    expect(alarm).toBe(scheduledFor);
    console.log(
      `[spike 1b] in-handler getAlarm(): before=${String(probe[0]?.before)} after=${String(probe[0]?.after)} ` +
        `(running alarm ${String(scheduledFor)}, rolled-back target ${String(target)}); after return: ${String(alarm)}`,
    );
  });
});

describe('spike 2: a test-scheduled alarm fires on its own wall clock under the pool', () => {
  it('runs the alarm handler about 200 ms later without runDurableObjectAlarm', async () => {
    // ProviderBudget's handler on an object with no config row calls deleteAll(), which drops
    // every table and clears the alarm: two independent signals that the platform invoked it.
    const stub = budgetHost();
    const scheduledFor = await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS spike_marker (id INTEGER PRIMARY KEY)');
      state.storage.sql.exec('INSERT INTO spike_marker (id) VALUES (1)');
      const at = Date.now() + 200;
      await state.storage.setAlarm(at);
      return at;
    });

    const deadline = Date.now() + 5_000;
    let observed: { alarm: number | null; tables: string[] } | null = null;
    while (Date.now() < deadline) {
      await sleep(100);
      observed = await runInDurableObject(stub, async (_instance, state) => ({
        alarm: await state.storage.getAlarm(),
        tables: [
          ...state.storage.sql.exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spike_marker'",
          ),
        ].map((row) => row.name),
      }));
      if (observed.alarm === null && observed.tables.length === 0) {
        break;
      }
    }

    expect(Date.now()).toBeGreaterThanOrEqual(scheduledFor);
    // Fired on its own: the handler ran, deleted the marker table and cleared the alarm.
    expect(observed).toEqual({ alarm: null, tables: [] });
  });
});

/**
 * Replaces the instance's `alarm()` for the life of this in-memory object with a handler that
 * records each run in `spike_runs`, calls `leak()` to leave a rejected promise behind, and
 * returns normally; then schedules the alarm 100 ms out. Returns the scheduled time.
 */
function scheduleLeakingAlarm(
  stub: DurableObjectStub<ProviderBudget>,
  leak: (state: DurableObjectState) => void,
): Promise<number> {
  return runInDurableObject(stub, async (instance: ProviderBudget, state) => {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS spike_runs (id INTEGER PRIMARY KEY)');
    Object.defineProperty(instance, 'alarm', {
      configurable: true,
      writable: true,
      value: () => {
        state.storage.sql.exec('INSERT INTO spike_runs (id) VALUES (NULL)');
        leak(state);
        return Promise.resolve();
      },
    });
    const at = Date.now() + 100;
    await state.storage.setAlarm(at);
    return at;
  });
}

/** Samples the alarm and the run count every 250 ms until past where a 2 s retry would land. */
async function watchForRetry(
  stub: DurableObjectStub<ProviderBudget>,
): Promise<{ at: number; alarm: number | null; runs: number }[]> {
  const samples: { at: number; alarm: number | null; runs: number }[] = [];
  const deadline = Date.now() + 3_500;
  while (Date.now() < deadline) {
    await sleep(250);
    samples.push(
      await runInDurableObject(stub, async (_instance, state) => ({
        at: Date.now(),
        alarm: await state.storage.getAlarm(),
        runs: state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM spike_runs').one().n,
      })),
    );
  }
  return samples;
}

function expectRanOnceWithoutRetry(
  samples: { at: number; alarm: number | null; runs: number }[],
  scheduledFor: number,
): void {
  const last = samples.at(-1);
  expect(last).toBeDefined();
  expect(last?.at ?? 0).toBeGreaterThan(scheduledFor);
  // The replaced handler ran (so the observation is about the leaked rejection, not the class's
  // own handler), ran exactly once, and left no retry alarm behind at any sample.
  expect(last?.runs).toBe(1);
  expect(samples.every((sample) => sample.alarm === null || sample.alarm === scheduledFor)).toBe(
    true,
  );
  expect(last?.alarm).toBeNull();
}

describe('spike 3: a floating rejected promise inside alarm()', () => {
  // Observed on the first run (2026-09-22, workerd 1.20260918.1): the invocation is NOT failed
  // by either form below. The handler runs once and no retry is scheduled. The difference is in
  // how the rejection surfaces: a promise handed to `waitUntil` is logged by workerd ("uncaught
  // exception; source = Uncaught (in promise)") and nothing else; a bare floating rejection
  // reaches the isolate's `unhandledrejection` event, which the Vitest pool reports as an
  // "Unhandled Rejection" run error, so `vitest run` exits non-zero even though every test
  // passes and `event.preventDefault()` does not stop the report. That is why the bare form is
  // gated: it stays in the suite, runs on demand (`SPIKE_UNHANDLED_REJECTION=true pnpm test`),
  // and is expected to fail the run when it does. The tracker's handler catches everything and
  // hands its fire-and-forget KV write to `waitUntil` with its own catch, so neither form occurs.
  it('a rejected waitUntil promise does not fail the invocation and is not retried', async () => {
    const stub = budgetHost();
    const scheduledFor = await scheduleLeakingAlarm(stub, (state) => {
      state.waitUntil(Promise.reject(new Error('spike 3a: rejected waitUntil inside alarm()')));
    });

    const samples = await watchForRetry(stub);

    expectRanOnceWithoutRetry(samples, scheduledFor);
  });

  const bareForm = (env as unknown as Record<string, string>)['SPIKE_UNHANDLED_REJECTION'];
  it.runIf(bareForm === 'true')(
    'a bare floating rejection does not fail the invocation either (surfaces as a pool run error)',
    async () => {
      const stub = budgetHost();
      const scheduledFor = await scheduleLeakingAlarm(stub, () => {
        void Promise.reject(new Error('spike 3b: floating rejection inside alarm()'));
      });

      const samples = await watchForRetry(stub);

      expectRanOnceWithoutRetry(samples, scheduledFor);
    },
  );
});

describe('spike 4: foreign keys are enforced in Durable Object SQLite', () => {
  it('refuses an orphan child, refuses a parent delete under a child, allows child-first deletes', async () => {
    const outcome = await runInDurableObject(airportHost('fk'), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
      sql.exec(
        'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))',
      );
      sql.exec("INSERT INTO parent (id, note) VALUES (1, 'p1')");
      sql.exec('INSERT INTO child (id, parent_id) VALUES (1, 1)');

      let orphan = 'allowed';
      try {
        sql.exec('INSERT INTO child (id, parent_id) VALUES (2, 999)');
      } catch (error) {
        orphan = error instanceof Error ? error.message : String(error);
      }
      let parentFirst = 'allowed';
      try {
        sql.exec('DELETE FROM parent WHERE id = 1');
      } catch (error) {
        parentFirst = error instanceof Error ? error.message : String(error);
      }
      sql.exec('DELETE FROM child WHERE parent_id = 1');
      sql.exec('DELETE FROM parent WHERE id = 1');
      const remaining =
        sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM parent').one().n +
        sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM child').one().n;

      let pragma: string;
      try {
        pragma = String(
          sql.exec<{ foreign_keys: number }>('PRAGMA foreign_keys').one().foreign_keys,
        );
      } catch (error) {
        pragma = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { orphan, parentFirst, remaining, pragma };
    });

    expect(outcome.orphan).toMatch(/FOREIGN KEY constraint failed/i);
    expect(outcome.parentFirst).toMatch(/FOREIGN KEY constraint failed/i);
    expect(outcome.remaining).toBe(0);
    // Recorded, not asserted: whether the pragma is readable is not load bearing, enforcement is.
    console.log(`[spike 4] PRAGMA foreign_keys reads as: ${outcome.pragma}`);
  });
});
