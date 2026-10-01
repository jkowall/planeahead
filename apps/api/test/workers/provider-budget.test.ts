/**
 * The ProviderBudget Durable Object against real Durable Object SQLite storage: serialised
 * debits under concurrency, the daily unit cap, the per-second rate, the kill switch (and its
 * alert, and failing closed when the persistent switch cannot be read), release and backoff, the
 * 60 second KV copy the Worker reads (written off the debit path), the daily alarm that writes
 * the final counters and calls `deleteAll()`, and the closed day that a late call never
 * recreates.
 *
 * Hygiene, as in do-ping.test.ts: every object has a unique name (storage isolation is per file,
 * not per test), and every touched object's alarm is drained in `afterEach`. A budget name must
 * be `${provider}:${utcDate}`, so uniqueness comes from consecutive dates in the next century
 * (`uniqueDate`); the object's clock is a test seam set through `runInDurableObject`, and so is
 * its outbox sink, so the wall clock never decides a result.
 */

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { BudgetDecision, BudgetRequest } from '@planeahead/shared';
import {
  PERSISTENT_KILL_UNKNOWN,
  persistentKillKey,
  type ProviderBudget,
  type ProviderBudgetMessage,
} from '../../src/do/provider-budget';
import type { Env } from '../../src/env';
import { createLogger } from '../../src/observability/log';
import {
  PROVIDER_BUDGET_OUTBOX_KINDS,
  budgetKvKey,
  finaliseAtMs,
  type BudgetKvCopy,
} from '../../src/providers/budget';
import { budgetGuardFor } from '../../src/providers/router';
import { handlePersistBatch, type PersistMessage } from '../../src/queues/persist';

/** `expect.objectContaining`, typed: the matcher is `any`, which the lint rules forbid assigning. */
function containing(value: object): unknown {
  return expect.objectContaining(value) as unknown;
}

const testEnv = env as Env;
const DAY_MS = 86_400_000;

const touched: DurableObjectStub<ProviderBudget>[] = [];

afterEach(async () => {
  while (touched.length > 0) {
    const stub = touched.pop();
    if (stub !== undefined) {
      await runDurableObjectAlarm(stub);
    }
  }
});

/**
 * A valid, unused UTC date: the name must be `${provider}:${utcDate}`. Far enough ahead that the
 * finalising alarm never fires on the wall clock during the run, and before 2189, the last year
 * `setAlarm` accepts. Consecutive days from a random start, so no two objects in this file share
 * a name.
 */
let nextDay = Date.UTC(2100 + Math.floor(Math.random() * 80), 0, 1);
function uniqueDate(): string {
  nextDay += DAY_MS;
  return new Date(nextDay).toISOString().slice(0, 10);
}

interface Harness {
  readonly stub: DurableObjectStub<ProviderBudget>;
  readonly date: string;
  /** The object's clock at the start: noon on its own day. */
  readonly nowMs: number;
  readonly sent: ProviderBudgetMessage[];
  readonly setClock: (ms: number) => Promise<void>;
  /** Waits for the background KV copy write, which a reservation never waits for. */
  readonly kvSettled: () => Promise<void>;
}

async function budget(
  provider: 'aerodatabox' | 'aeroapi' = 'aerodatabox',
  options: {
    readonly failSends?: boolean;
    readonly configKv?: Pick<KVNamespace, 'get' | 'put' | 'delete'>;
    readonly kv?: Pick<KVNamespace, 'put'>;
  } = {},
): Promise<Harness> {
  const date = uniqueDate();
  const stub = testEnv.PROVIDER_BUDGET.getByName(`${provider}:${date}`);
  touched.push(stub);
  const sent: ProviderBudgetMessage[] = [];
  const nowMs = Date.parse(`${date}T12:00:00Z`);
  await runInDurableObject(stub, (instance: ProviderBudget) => {
    instance.clock = () => nowMs;
    if (options.configKv !== undefined) {
      instance.configKv = options.configKv;
    }
    if (options.kv !== undefined) {
      instance.kv = options.kv;
    }
    instance.outboxSink = {
      sendBatch: (messages: Iterable<MessageSendRequest<unknown>>) => {
        if (options.failSends === true) {
          return Promise.reject(new Error('queue unavailable'));
        }
        for (const message of messages) {
          sent.push(message.body as ProviderBudgetMessage);
        }
        return Promise.resolve();
      },
    } as Pick<Queue, 'sendBatch'>;
  });
  return {
    stub,
    date,
    nowMs,
    sent,
    setClock: async (ms) => {
      await runInDurableObject(stub, (instance: ProviderBudget) => {
        instance.clock = () => ms;
      });
    },
    kvSettled: async () => {
      await runInDurableObject(stub, (instance: ProviderBudget) => instance.kvCopySettled());
    },
  };
}

/** The origin a harness object's outbox messages carry: its name plus its lifetime epoch. */
function originOf(harness: Harness, provider = 'aerodatabox'): string {
  return `provider_budget:${provider}:${harness.date}@${String(harness.nowMs)}`;
}

const ADB_STATUS: BudgetRequest = {
  provider: 'aerodatabox',
  operation: 'flight_status',
  pollEquivalents: 0.1,
  trigger: 'alarm',
};

describe('ProviderBudget: reserve', () => {
  it('serialises concurrent debits: 40 reservations against a 20-unit cap grant exactly 10', async () => {
    const { stub } = await budget();
    await stub.configure({ dailyUnitCap: 20, perSecondLimit: 1_000 });

    const decisions = await Promise.all(Array.from({ length: 40 }, () => stub.reserve(ADB_STATUS)));

    expect(decisions.filter((d) => d.allowed)).toHaveLength(10);
    const refusals = decisions.filter((d) => !d.allowed).map((d) => (d.allowed ? '' : d.reason));
    // The first refusal trips the kill switch; the rest meet it.
    expect(refusals.filter((r) => r === 'provider_daily_cap')).toHaveLength(1);
    expect(refusals.filter((r) => r === 'provider_kill_switch')).toHaveLength(29);
    const snapshot = await stub.snapshot();
    expect(snapshot).toMatchObject({
      units: 20,
      calls: 10,
      dailyUnitCap: 20,
      killSwitch: true,
      killReason: 'daily_cap',
      byTrigger: { alarm: { units: 20, calls: 10 } },
      denials: { provider_daily_cap: 1, provider_kill_switch: 29 },
    });
    expect(snapshot.pollEquivalents).toBeCloseTo(1, 10);
  });

  it('walks the 70 / 90 / 100 ladder and trips the kill switch at the cap, alerting through the outbox', async () => {
    const harness = await budget();
    const { stub, sent, date } = harness;
    await stub.configure({ dailyUnitCap: 10, perSecondLimit: 1_000 });
    const rungs: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const decision = await stub.reserve(ADB_STATUS);
      rungs.push(decision.allowed ? decision.ladder : decision.reason);
    }
    // 2, 4, 6 units are normal; 8 is 80 percent (warn); 10 is 100 percent (degraded).
    expect(rungs).toEqual(['normal', 'normal', 'normal', 'warn', 'degraded']);
    expect(sent).toEqual([]);

    const refused = await stub.reserve(ADB_STATUS);
    expect(refused).toEqual({ allowed: false, reason: 'provider_daily_cap' });
    expect(sent).toEqual([
      {
        kind: PROVIDER_BUDGET_OUTBOX_KINDS.killSwitch,
        seq: 1,
        origin: originOf(harness),
        payload: containing({
          provider: 'aerodatabox',
          utcDate: date,
          reason: 'daily_cap',
          spentUnits: 10,
          dailyUnitCap: 10,
        }),
      },
    ]);
    expect(await stub.reserve(ADB_STATUS)).toEqual({
      allowed: false,
      reason: 'provider_kill_switch',
    });
    // The alert went once.
    expect(sent).toHaveLength(1);
  });

  it('holds the per-second rate from a bucket refilled on read, never more than the limit in a second', async () => {
    const { stub, setClock, nowMs: start } = await budget('aerodatabox');
    await stub.configure({ dailyUnitCap: 1_000, perSecondLimit: 5 });
    expect(await stub.snapshot()).toMatchObject({ perSecondLimit: 5, tokens: 2 });

    // Limit 5: a burst of 2 refilled at 3 a second, so no second holds more than 5 grants.
    const burst = await Promise.all(Array.from({ length: 7 }, () => stub.reserve(ADB_STATUS)));
    expect(burst.filter((d) => d.allowed)).toHaveLength(2);
    expect(burst.filter((d) => !d.allowed)).toEqual(
      Array.from({ length: 5 }, () => ({
        allowed: false,
        reason: 'provider_rate_limit',
        retryAfterMs: 334,
      })),
    );
    await setClock(start + 333);
    expect((await stub.reserve(ADB_STATUS)).allowed).toBe(false);
    await setClock(start + 334);
    expect((await stub.reserve(ADB_STATUS)).allowed).toBe(true);
    let granted = 3;
    for (let ms = 335; ms <= 1_000; ms += 1) {
      await setClock(start + ms);
      granted += (await stub.reserve(ADB_STATUS)).allowed ? 1 : 0;
    }
    // Within [start, start + 1000]: the burst of 2 and three refills.
    expect(granted).toBe(5);
    // A rate refusal never spends units.
    expect((await stub.snapshot()).units).toBe(10);
    // Some 670 clock-set and reserve round trips: past the 60 s file default under full host
    // parallelism, so the test carries its own budget. The code under test is unchanged.
  }, 180_000);

  it('backs the bucket off on a provider push-back', async () => {
    const { stub, setClock, nowMs: start } = await budget('aerodatabox');
    await stub.configure({ dailyUnitCap: 1_000, perSecondLimit: 10 });
    await stub.backoff(1_500);
    expect(await stub.reserve(ADB_STATUS)).toEqual({
      allowed: false,
      reason: 'provider_rate_limit',
      retryAfterMs: 1_500,
    });
    await setClock(start + 1_500);
    expect((await stub.reserve(ADB_STATUS)).allowed).toBe(true);
  });

  it('release gives back what the provider did not bill; the call still counts', async () => {
    const { stub } = await budget();
    await stub.configure({ dailyUnitCap: 100, perSecondLimit: 1_000 });
    await stub.reserve(ADB_STATUS);
    await stub.reserve(ADB_STATUS);
    await stub.release(ADB_STATUS, 0.1);
    expect(await stub.snapshot()).toMatchObject({ units: 2, calls: 2, releasedUnits: 2 });
    // Releasing more than a reservation never takes the ledger below zero.
    await stub.release(ADB_STATUS, 5);
    await stub.release(ADB_STATUS, 5);
    expect((await stub.snapshot()).units).toBe(0);
  });

  it('refuses a reservation for another day and ignores a refund of one', async () => {
    const { stub, date } = await budget();
    await stub.configure({ dailyUnitCap: 100, perSecondLimit: 1_000 });
    expect((await stub.reserve({ ...ADB_STATUS, utcDate: date })).allowed).toBe(true);
    // Yesterday's reservation released after midnight must not refund today.
    await stub.release({ ...ADB_STATUS, utcDate: '2001-01-01' }, 0.1);
    expect(await stub.snapshot()).toMatchObject({ units: 2, releasedUnits: 0 });
    expect(await stub.reserve({ ...ADB_STATUS, utcDate: '2001-01-01' })).toEqual({
      allowed: false,
      reason: 'routing_rule',
    });
  });

  it('refuses a request for another provider or an unpriced operation, without throwing', async () => {
    const { stub } = await budget();
    expect(
      await stub.reserve({ ...ADB_STATUS, provider: 'aeroapi', operation: 'flight_by_id' }),
    ).toEqual({
      allowed: false,
      reason: 'routing_rule',
    });
    expect(await stub.reserve({ ...ADB_STATUS, operation: 'flight_plan' })).toEqual({
      allowed: false,
      reason: 'routing_rule',
    });
    expect((await stub.snapshot()).units).toBe(0);
  });

  it('starts the day at the plan defaults (growth under test), AeroAPI at its provisional cap', async () => {
    const adb = await budget('aerodatabox');
    expect(await adb.stub.snapshot()).toMatchObject({
      dailyUnitCap: 13_333,
      perSecondLimit: 10,
      units: 0,
    });
    const aeroapi = await budget('aeroapi');
    expect(await aeroapi.stub.snapshot()).toMatchObject({
      dailyUnitCap: 10_000,
      perSecondLimit: 5,
    });
    const result = await aeroapi.stub.reserve({
      provider: 'aeroapi',
      operation: 'flight_by_id',
      pollEquivalents: 1,
      trigger: 'alarm',
    });
    expect(result).toEqual({ allowed: true, granted: 1, ladder: 'normal' });
  });
});

describe('ProviderBudget: the KV copy the Worker reads', () => {
  it('is written after a debit and says blocked once the kill switch trips', async () => {
    const { stub, date, kvSettled } = await budget();
    await stub.configure({ dailyUnitCap: 2, perSecondLimit: 1_000 });
    await stub.reserve(ADB_STATUS);
    await kvSettled();
    const key = budgetKvKey('aerodatabox', date);
    const first = await testEnv.CACHE.get<BudgetKvCopy>(key, 'json');
    expect(first).toMatchObject({
      provider: 'aerodatabox',
      utcDate: date,
      units: 2,
      dailyUnitCap: 2,
      killSwitch: false,
      blocked: true,
      ladder: 'degraded',
    });
    await stub.reserve(ADB_STATUS);
    await kvSettled();
    expect(await testEnv.CACHE.get<BudgetKvCopy>(key, 'json')).toMatchObject({
      killSwitch: true,
      blocked: true,
    });
  });

  it('lets the Worker-side guard refuse without reaching the object', async () => {
    const { stub, date, kvSettled } = await budget();
    await stub.configure({ dailyUnitCap: 2, perSecondLimit: 1_000 });
    await stub.reserve(ADB_STATUS);
    await stub.reserve(ADB_STATUS);
    await kvSettled();
    const before = await stub.snapshot();
    const guard = budgetGuardFor(testEnv, () => new Date(`${date}T15:00:00Z`));
    expect(await guard.reserve(ADB_STATUS)).toEqual({
      allowed: false,
      reason: 'provider_kill_switch',
    });
    // Refused from KV: the object saw no new request, so no new denial was counted.
    expect((await stub.snapshot()).denials).toEqual(before.denials);
  });

  it('never makes a reservation wait for KV, and a failing KV costs at most one write a second', async () => {
    let puts = 0;
    let release: () => void = () => undefined;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const failing: Pick<KVNamespace, 'put'> = {
      put: () => {
        puts += 1;
        return hanging.then(() => Promise.reject(new Error('KV 429: too many writes')));
      },
    };
    const { stub, setClock, nowMs, kvSettled } = await budget('aerodatabox', { kv: failing });
    await stub.configure({ dailyUnitCap: 1_000, perSecondLimit: 1_000 });
    // The first write is still in flight: 20 reservations at one instant all answer at once.
    const decisions = await Promise.race([
      Promise.all(Array.from({ length: 20 }, () => stub.reserve(ADB_STATUS))),
      new Promise<'waited on KV'>((resolve) => {
        setTimeout(() => resolve('waited on KV'), 2_000);
      }),
    ]);
    expect(decisions).not.toBe('waited on KV');
    expect(puts).toBe(1);
    release();
    await kvSettled();
    // The write failed; more reservations in the same second do not retry it.
    for (let i = 0; i < 20; i += 1) {
      await stub.reserve(ADB_STATUS);
    }
    await kvSettled();
    expect(puts).toBe(1);
    // A second later exactly one more attempt is made.
    await setClock(nowMs + 1_000);
    for (let i = 0; i < 5; i += 1) {
      await stub.reserve(ADB_STATUS);
    }
    await kvSettled();
    expect(puts).toBe(2);
    expect((await stub.snapshot()).calls).toBe(45);
  });
});

describe('ProviderBudget: the kill switch', () => {
  it('a manual kill switch refuses everything, persists across days in CONFIG KV, and clears', async () => {
    const today = await budget('aeroapi');
    const request: BudgetRequest = {
      provider: 'aeroapi',
      operation: 'flight_by_id',
      pollEquivalents: 1,
      trigger: 'user_refresh',
    };
    try {
      const snapshot = await today.stub.setKillSwitch(true, 'runaway spend');
      expect(snapshot).toMatchObject({
        killSwitch: true,
        killReason: 'manual:runaway spend',
        persisted: true,
      });
      expect(today.sent.map((m) => m.kind)).toEqual([PROVIDER_BUDGET_OUTBOX_KINDS.killSwitch]);
      expect(await today.stub.reserve(request)).toEqual({
        allowed: false,
        reason: 'provider_kill_switch',
      });
      expect(await testEnv.CONFIG.get(persistentKillKey('aeroapi'), 'json')).toMatchObject({
        reason: 'runaway spend',
      });

      // Tomorrow's object starts killed.
      const tomorrow = await budget('aeroapi');
      expect(await tomorrow.stub.reserve(request)).toEqual({
        allowed: false,
        reason: 'provider_kill_switch',
      });
      expect((await tomorrow.stub.snapshot()).killReason).toBe('persistent:runaway spend');
    } finally {
      await today.stub.setKillSwitch(false);
    }
    expect(await testEnv.CONFIG.get(persistentKillKey('aeroapi'))).toBeNull();
    expect((await today.stub.reserve(request)).allowed).toBe(true);
    const after = await budget('aeroapi');
    expect((await after.stub.reserve(request)).allowed).toBe(true);
  });

  it('fails CLOSED when the persistent switch cannot be read, alerts, and lifts itself once it can', async () => {
    let reads = 0;
    let down = true;
    const flaky: Pick<KVNamespace, 'get' | 'put' | 'delete'> = {
      get: (() => {
        reads += 1;
        return down ? Promise.reject(new Error('CONFIG unavailable')) : Promise.resolve(null);
      }) as unknown as KVNamespace['get'],
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    const harness = await budget('aerodatabox', { configKv: flaky });
    const { stub, sent, setClock, nowMs } = harness;
    // The emergency brake could not be read: the day starts killed rather than spending blind.
    expect(await stub.reserve(ADB_STATUS)).toEqual({
      allowed: false,
      reason: 'provider_kill_switch',
    });
    expect((await stub.snapshot()).killReason).toBe(PERSISTENT_KILL_UNKNOWN);
    // And the operators hear about it, through the same alert as any kill switch.
    expect(sent).toEqual([
      {
        kind: PROVIDER_BUDGET_OUTBOX_KINDS.killSwitch,
        seq: 1,
        origin: originOf(harness),
        payload: containing({ reason: PERSISTENT_KILL_UNKNOWN, configReadFailed: 1 }),
      },
    ]);
    // It retries the read at most every 30 s, not on every call.
    const readsSoFar = reads;
    await stub.reserve(ADB_STATUS);
    expect(reads).toBe(readsSoFar);
    down = false;
    await setClock(nowMs + 30_000);
    // The read now says there is no persistent stop: the day runs.
    expect((await stub.reserve(ADB_STATUS)).allowed).toBe(true);
    expect(await stub.snapshot()).toMatchObject({ killSwitch: false, killReason: null });
  });

  it('a stop the read DOES find keeps the day killed under its real reason', async () => {
    let down = true;
    const store: Pick<KVNamespace, 'get' | 'put' | 'delete'> = {
      get: (() =>
        down
          ? Promise.reject(new Error('CONFIG unavailable'))
          : Promise.resolve({ reason: 'overage' })) as unknown as KVNamespace['get'],
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    };
    const { stub, setClock, nowMs } = await budget('aerodatabox', { configKv: store });
    expect((await stub.reserve(ADB_STATUS)).allowed).toBe(false);
    down = false;
    await setClock(nowMs + 30_000);
    expect(await stub.reserve(ADB_STATUS)).toEqual({
      allowed: false,
      reason: 'provider_kill_switch',
    });
    expect((await stub.snapshot()).killReason).toBe('persistent:overage');
  });

  it('says so when the kill switch could not be persisted for tomorrow', async () => {
    const broken: Pick<KVNamespace, 'get' | 'put' | 'delete'> = {
      get: (() => Promise.resolve(null)) as unknown as KVNamespace['get'],
      put: () => Promise.reject(new Error('CONFIG write failed')),
      delete: () => Promise.reject(new Error('CONFIG write failed')),
    };
    const { stub } = await budget('aeroapi', { configKv: broken });
    const result = await stub.setKillSwitch(true, 'overage');
    // It holds today; the admin page is told it will not carry into tomorrow's object.
    expect(result).toMatchObject({ killSwitch: true, persisted: false });
    expect((await stub.setKillSwitch(false)).persisted).toBe(false);
  });

  it('the persist consumer turns the kill-switch row into a fatal Sentry event', async () => {
    const captured: { message: string; context: unknown }[] = [];
    const acked: string[] = [];
    const message = (id: string, body: PersistMessage): Message<PersistMessage> => ({
      id,
      timestamp: new Date(),
      body,
      attempts: 1,
      ack: () => acked.push(id),
      retry: () => undefined,
    });
    const batch = {
      queue: 'planeahead-persist-local',
      messages: [
        // Increment 7: the persist consumer validates every message against the shared
        // `PersistMessageV1` union, so the fixtures carry what the object really sends.
        message('m1', {
          kind: PROVIDER_BUDGET_OUTBOX_KINDS.killSwitch,
          seq: 1,
          origin: 'provider_budget:aerodatabox:2026-09-22',
          payload: {
            provider: 'aerodatabox',
            utcDate: '2026-09-22',
            reason: 'daily_cap',
            atMs: 1_758_542_400_000,
            spentUnits: 13_333,
          },
        }),
        message('m2', {
          kind: PROVIDER_BUDGET_OUTBOX_KINDS.daily,
          seq: 2,
          origin: 'provider_budget:aerodatabox:2026-09-22',
          payload: {
            provider: 'aerodatabox',
            utcDate: '2026-09-22',
            units: 13_333,
            pollEquivalents: 666.65,
            calls: 6_667,
          },
        }),
      ],
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as unknown as MessageBatch<PersistMessage>;

    await handlePersistBatch(
      batch,
      { env: testEnv, ctx: {} as ExecutionContext, log: createLogger({}, () => undefined) },
      {
        capture: (text, context) => {
          captured.push({ message: text, context });
        },
      },
    );

    expect(acked).toEqual(['m1', 'm2']);
    expect(captured).toEqual([
      {
        message: 'provider_kill_switch_tripped',
        context: {
          level: 'fatal',
          tags: {
            ops_alert: 'provider_kill_switch_tripped',
            provider: 'aerodatabox',
            reason: 'daily_cap',
            utcDate: '2026-09-22',
          },
          extra: containing({
            spentUnits: 13_333,
            origin: 'provider_budget:aerodatabox:2026-09-22',
          }),
        },
      },
    ]);
  });
});

describe('ProviderBudget: the day ends', () => {
  it('arms the finalising alarm on first use, never in the constructor', async () => {
    const { stub, date } = await budget();
    await stub.ping();
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
    await stub.reserve(ADB_STATUS);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBe(
      finaliseAtMs(date),
    );
  });

  it('before 00:05 the alarm only flushes and re-arms', async () => {
    const { stub, date, sent } = await budget();
    await stub.reserve(ADB_STATUS);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(sent).toEqual([]);
    expect((await stub.snapshot()).units).toBe(2);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBe(
      finaliseAtMs(date),
    );
  });

  it('at 00:05 the next day it sends the final counters and deletes everything', async () => {
    const harness = await budget();
    const { stub, date, sent, setClock } = harness;
    await stub.configure({ dailyUnitCap: 100, perSecondLimit: 1_000 });
    await stub.reserve(ADB_STATUS);
    await stub.reserve({ ...ADB_STATUS, trigger: 'user_search' });
    await setClock(finaliseAtMs(date) + 60_000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(sent).toEqual([
      {
        kind: PROVIDER_BUDGET_OUTBOX_KINDS.daily,
        seq: 1,
        origin: originOf(harness),
        payload: containing({
          provider: 'aerodatabox',
          utcDate: date,
          units: 4,
          calls: 2,
          dailyUnitCap: 100,
          byTrigger: {
            alarm: { units: 2, pe: 0.1, calls: 1 },
            user_search: { units: 2, pe: 0.1, calls: 1 },
          },
          finalised: false,
        }),
      },
    ]);
    const tables = await runInDurableObject(stub, (_i, state) =>
      [
        ...state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ),
      ].map((row) => row.name),
    );
    expect(tables.filter((name) => !name.startsWith('_cf_'))).toEqual([]);
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBeNull();
  });

  it('a closed day stays closed: a late call writes nothing, arms nothing and sends nothing', async () => {
    const { stub, date, sent, setClock } = await budget();
    await stub.reserve(ADB_STATUS);
    await stub.reserve(ADB_STATUS);
    const late = finaliseAtMs(date) + 60_000;
    await setClock(late);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(sent.map((m) => [m.kind, m.seq])).toEqual([[PROVIDER_BUDGET_OUTBOX_KINDS.daily, 1]]);

    // Every entry point after the day is final: none recreates the day.
    expect(await stub.snapshot()).toMatchObject({
      units: 0,
      calls: 0,
      finalised: true,
      dayClosed: true,
    });
    expect(await stub.reserve(ADB_STATUS)).toEqual({ allowed: false, reason: 'routing_rule' });
    await stub.release(ADB_STATUS, 0.1);
    await stub.backoff(1_000);
    // Admin writes change nothing and say so.
    expect(await stub.configure({ dailyUnitCap: 5 })).toMatchObject({
      dayClosed: true,
      dailyUnitCap: 0,
    });
    expect(await stub.setKillSwitch(true)).toMatchObject({
      dayClosed: true,
      killSwitch: false,
      persisted: false,
    });
    expect(await testEnv.CONFIG.get(persistentKillKey('aerodatabox'))).toBeNull();
    const storage = await runInDurableObject(stub, async (_i, state) => ({
      alarm: await state.storage.getAlarm(),
      tables: [
        ...state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ),
      ]
        .map((row) => row.name)
        .filter((name) => !name.startsWith('_cf_')),
    }));
    expect(storage).toEqual({ alarm: null, tables: [] });
    // No second daily row with a colliding (origin, seq): nothing more was ever sent.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('a closed day touched for the first time is read-only too, and its recreated schema is cleaned up', async () => {
    const { stub, date, sent, setClock } = await budget();
    const late = finaliseAtMs(date) + 60_000;
    await setClock(late);
    expect(await stub.reserve(ADB_STATUS)).toEqual({ allowed: false, reason: 'routing_rule' });
    expect(await stub.snapshot()).toMatchObject({ units: 0, dayClosed: true });
    // The constructor created the (empty) schema; a cleanup alarm, in the future, removes it.
    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm ?? 0).toBeGreaterThan(late);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const tables = await runInDurableObject(stub, (_i, state) =>
      [
        ...state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ),
      ]
        .map((row) => row.name)
        .filter((name) => !name.startsWith('_cf_')),
    );
    expect(tables).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('keeps the rows and retries when the final send fails', async () => {
    const { stub, date, setClock } = await budget('aerodatabox', { failSends: true });
    await stub.reserve(ADB_STATUS);
    const after = finaliseAtMs(date) + 60_000;
    await setClock(after);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.snapshot()).toMatchObject({ units: 2, finalised: true });
    expect(await runInDurableObject(stub, (_i, state) => state.storage.getAlarm())).toBe(
      after + 60_000,
    );
  });
});

describe('ProviderBudget: the boards share and the hourly airport cap (increment 18)', () => {
  const board = (
    airportIcao?: string,
    trigger: 'board' | 'route_search' = 'board',
  ): BudgetRequest => ({
    provider: 'aerodatabox',
    operation: 'fids',
    pollEquivalents: 0.1,
    trigger,
    ...(airportIcao === undefined ? {} : { airportIcao }),
  });

  it('refuses board calls past 35 percent of the cap, reports the share, and never touches trackers', async () => {
    const { stub } = await budget();
    // 35 percent of 40 units is 14: seven 2-unit FIDS calls, board and route search together.
    await stub.configure({ dailyUnitCap: 40, perSecondLimit: 1_000 });
    const shares: (number | undefined)[] = [];
    for (let i = 0; i < 7; i += 1) {
      const decision = await stub.reserve(board('KJFK', i % 2 === 0 ? 'board' : 'route_search'));
      expect(decision.allowed).toBe(true);
      shares.push(decision.boardsShareSpent);
    }
    expect(shares.map((share) => Math.round((share ?? -1) * 14))).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(await stub.reserve(board('KJFK'))).toEqual({
      allowed: false,
      reason: 'boards_share',
      boardsShareSpent: 1,
    });
    // The trackers keep the other 26 units, and never see a board figure.
    const trackers = await Promise.all(Array.from({ length: 13 }, () => stub.reserve(ADB_STATUS)));
    expect(trackers.every((d) => d.allowed && d.boardsShareSpent === undefined)).toBe(true);
    expect(await stub.reserve(ADB_STATUS)).toEqual({
      allowed: false,
      reason: 'provider_daily_cap',
    });
    const snapshot = await stub.snapshot();
    expect(snapshot.boards).toEqual({
      spentUnits: 14,
      capUnits: 14,
      shareSpent: 1,
      airportsPerHourCap: 60,
      airportsThisHour: ['KJFK'],
    });
    expect(snapshot.denials).toMatchObject({ boards_share: 1, provider_daily_cap: 1 });
    expect(snapshot.byTrigger).toMatchObject({
      board: { units: 8, calls: 4 },
      route_search: { units: 6, calls: 3 },
      alarm: { units: 26, calls: 13 },
    });
  });

  it('caps distinct airports per UTC hour at 60, keyed by the airport the request names', async () => {
    const harness = await budget();
    const { stub } = harness;
    await stub.configure({ dailyUnitCap: 100_000, perSecondLimit: 1_000 });
    const airports = Array.from({ length: 60 }, (_, i) => `K${String(i).padStart(3, '0')}`);
    for (const airport of airports) {
      expect((await stub.reserve(board(airport))).allowed).toBe(true);
    }
    expect(await stub.reserve(board('EGLL'))).toMatchObject({
      allowed: false,
      reason: 'board_airports_per_hour',
    });
    // An airport already counted this hour costs nothing more against the cap.
    expect((await stub.reserve(board('K007', 'route_search'))).allowed).toBe(true);
    // A board call that names no airport is never uncounted: it is refused.
    expect(await stub.reserve(board())).toMatchObject({ allowed: false, reason: 'routing_rule' });
    // Tracker calls never see the airport cap.
    expect((await stub.reserve(ADB_STATUS)).allowed).toBe(true);
    expect((await stub.snapshot()).boards.airportsThisHour).toHaveLength(60);
    // The next UTC hour starts its own count.
    await harness.setClock(harness.nowMs + 60 * 60_000);
    expect((await stub.reserve(board('EGLL'))).allowed).toBe(true);
    expect((await stub.snapshot()).boards.airportsThisHour).toEqual(['EGLL']);
    expect((await stub.snapshot()).denials).toMatchObject({
      board_airports_per_hour: 1,
      routing_rule: 1,
    });
  });

  it('the free coverage check takes no airport slot, even with the hour full (R5, ma4)', async () => {
    const { stub } = await budget();
    await stub.configure({ dailyUnitCap: 100_000, perSecondLimit: 1_000 });
    const check = (airportIcao: string): BudgetRequest => ({
      ...board(airportIcao),
      operation: 'health',
      pollEquivalents: 0,
    });
    // Checks alone never fill the cap, and a checked airport is not counted.
    for (let i = 0; i < 70; i += 1) {
      expect((await stub.reserve(check(`E${String(i).padStart(3, '0')}`))).allowed).toBe(true);
    }
    expect((await stub.snapshot()).boards.airportsThisHour).toEqual([]);
    for (let i = 0; i < 60; i += 1) {
      expect((await stub.reserve(board(`K${String(i).padStart(3, '0')}`))).allowed).toBe(true);
    }
    // With the hour full, a new airport's check still passes; its FIDS call does not.
    expect((await stub.reserve(check('EGLL'))).allowed).toBe(true);
    expect(await stub.reserve(board('EGLL'))).toMatchObject({
      allowed: false,
      reason: 'board_airports_per_hour',
    });
    const snapshot = await stub.snapshot();
    expect(snapshot.boards.airportsThisHour).toHaveLength(60);
    expect(snapshot.boards.airportsThisHour).not.toContain('EGLL');
    expect(snapshot.byTrigger).toMatchObject({ board: { units: 120, calls: 131 } });
  });
});

describe('ProviderBudget: board calls leave the trackers a rate floor (ruling R2)', () => {
  const boardCall = (operation: 'health' | 'fids', airportIcao: string): BudgetRequest => ({
    provider: 'aerodatabox',
    operation,
    pollEquivalents: operation === 'fids' ? 0.1 : 0,
    trigger: 'board',
    airportIcao,
  });
  const outcome = (decision: BudgetDecision): string =>
    decision.allowed ? 'allowed' : decision.reason;

  it("review A's probe on Growth: two cold opens at one instant, then a tracker alarm is allowed", async () => {
    const { stub, setClock, nowMs } = await budget();
    await stub.configure({ perSecondLimit: 10 }); // Growth: a burst of 5, 5 a second, a floor of 2
    const opens: BudgetDecision[] = [];
    for (const icao of ['KJFK', 'EGLL']) {
      for (const operation of ['health', 'fids', 'fids'] as const) {
        opens.push(await stub.reserve(boardCall(operation, icao)));
      }
    }
    expect(opens.map(outcome)).toEqual([
      ...Array.from({ length: 3 }, () => 'allowed'),
      ...Array.from({ length: 3 }, () => 'board_rate_floor'),
    ]);
    // The wait folds the floor in: one token short at 5 a second.
    expect(opens[3]).toEqual({ allowed: false, reason: 'board_rate_floor', retryAfterMs: 200 });
    // Before the floor, the probe's next tracker alarm was refused. Now the trackers have 2.
    const trackers = [];
    for (let i = 0; i < 3; i += 1) {
      trackers.push(await stub.reserve(ADB_STATUS));
    }
    expect(trackers.map(outcome)).toEqual(['allowed', 'allowed', 'provider_rate_limit']);
    // Once three tokens are back, a board call passes again; refusals never spent a unit.
    await setClock(nowMs + 600);
    expect((await stub.reserve(boardCall('fids', 'EGLL'))).allowed).toBe(true);
    const snapshot = await stub.snapshot();
    expect(snapshot.denials).toMatchObject({ board_rate_floor: 3, provider_rate_limit: 1 });
    expect(snapshot.byTrigger).toMatchObject({
      board: { units: 6, calls: 4 },
      alarm: { units: 4, calls: 2 },
    });
  });

  it('the free coverage check, outside the airport cap (R5), still keeps the floor on Growth', async () => {
    const { stub } = await budget();
    await stub.configure({ perSecondLimit: 10 }); // Growth: a burst of 5, 5 a second, a floor of 2
    const checks: BudgetDecision[] = [];
    for (const icao of ['KJFK', 'EGLL', 'LFPG', 'EDDF']) {
      checks.push(await stub.reserve(boardCall('health', icao)));
    }
    expect(checks.map(outcome)).toEqual(['allowed', 'allowed', 'allowed', 'board_rate_floor']);
    expect(checks[3]).toEqual({ allowed: false, reason: 'board_rate_floor', retryAfterMs: 200 });
    const trackers: BudgetDecision[] = [];
    for (let i = 0; i < 3; i += 1) {
      trackers.push(await stub.reserve(ADB_STATUS));
    }
    expect(trackers.map(outcome)).toEqual(['allowed', 'allowed', 'provider_rate_limit']);
    expect((await stub.snapshot()).boards.airportsThisHour).toEqual([]);
  });

  it.each([
    ['Starter', 5, 2, 1],
    ['Scale', 20, 10, 5],
  ] as const)(
    'on %s (%i a second, a burst of %i) board calls stop at a floor of %i, which the trackers keep',
    async (_plan, limit, burst, floor) => {
      const { stub } = await budget();
      await stub.configure({ perSecondLimit: limit });
      // From a full bucket, board calls take it down to the floor and no further.
      const boards: BudgetDecision[] = [];
      for (let i = 0; i < burst - floor + 2; i += 1) {
        boards.push(await stub.reserve(boardCall('fids', 'KJFK')));
      }
      expect(boards.map(outcome)).toEqual([
        ...Array.from({ length: burst - floor }, () => 'allowed'),
        'board_rate_floor',
        'board_rate_floor',
      ]);
      const trackers: BudgetDecision[] = [];
      for (let i = 0; i <= floor; i += 1) {
        trackers.push(await stub.reserve(ADB_STATUS));
      }
      expect(trackers.map(outcome)).toEqual([
        ...Array.from({ length: floor }, () => 'allowed'),
        'provider_rate_limit',
      ]);
    },
  );
});
