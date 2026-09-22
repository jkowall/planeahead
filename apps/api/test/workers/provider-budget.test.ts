/**
 * The ProviderBudget Durable Object against real Durable Object SQLite storage: serialised
 * debits under concurrency, the daily unit cap, the per-second rate, the kill switch (and its
 * alert), release and backoff, the 60 second KV copy the Worker reads, and the daily alarm that
 * writes the final counters and calls `deleteAll()`.
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
import type { BudgetRequest } from '@planeahead/shared';
import {
  persistentKillKey,
  type ProviderBudget,
  type ProviderBudgetMessage,
} from '../../src/do/provider-budget';
import { MIGRATIONS_TABLE } from '../../src/do/migrate';
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
  readonly sent: ProviderBudgetMessage[];
  readonly setClock: (ms: number) => Promise<void>;
}

async function budget(
  provider: 'aerodatabox' | 'aeroapi' = 'aerodatabox',
  options: { readonly nowMs?: number; readonly failSends?: boolean } = {},
): Promise<Harness> {
  const date = uniqueDate();
  const stub = testEnv.PROVIDER_BUDGET.getByName(`${provider}:${date}`);
  touched.push(stub);
  const sent: ProviderBudgetMessage[] = [];
  const nowMs = options.nowMs ?? Date.parse(`${date}T12:00:00Z`);
  await runInDurableObject(stub, (instance: ProviderBudget) => {
    instance.clock = () => nowMs;
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
    sent,
    setClock: async (ms) => {
      await runInDurableObject(stub, (instance: ProviderBudget) => {
        instance.clock = () => ms;
      });
    },
  };
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
    const { stub, sent, date } = await budget();
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
        origin: `provider_budget:aerodatabox:${date}`,
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

  it('holds the per-second rate from a bucket refilled on read', async () => {
    const start = Date.parse('2400-01-01T12:00:00Z');
    const { stub, setClock } = await budget('aerodatabox', { nowMs: start });
    await stub.configure({ dailyUnitCap: 1_000, perSecondLimit: 5 });

    const burst = await Promise.all(Array.from({ length: 7 }, () => stub.reserve(ADB_STATUS)));
    expect(burst.filter((d) => d.allowed)).toHaveLength(5);
    expect(burst.filter((d) => !d.allowed)).toEqual([
      { allowed: false, reason: 'provider_rate_limit', retryAfterMs: 200 },
      { allowed: false, reason: 'provider_rate_limit', retryAfterMs: 200 },
    ]);
    await setClock(start + 199);
    expect((await stub.reserve(ADB_STATUS)).allowed).toBe(false);
    await setClock(start + 200);
    expect((await stub.reserve(ADB_STATUS)).allowed).toBe(true);
    // A rate refusal never spends units.
    expect((await stub.snapshot()).units).toBe(12);
  });

  it('backs the bucket off on a provider push-back', async () => {
    const start = Date.parse('2400-01-01T12:00:00Z');
    const { stub, setClock } = await budget('aerodatabox', { nowMs: start });
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
    const { stub, date } = await budget();
    await stub.configure({ dailyUnitCap: 2, perSecondLimit: 1_000 });
    await stub.reserve(ADB_STATUS);
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
    expect(await testEnv.CACHE.get<BudgetKvCopy>(key, 'json')).toMatchObject({
      killSwitch: true,
      blocked: true,
    });
  });

  it('lets the Worker-side guard refuse without reaching the object', async () => {
    const { stub, date } = await budget();
    await stub.configure({ dailyUnitCap: 2, perSecondLimit: 1_000 });
    await stub.reserve(ADB_STATUS);
    await stub.reserve(ADB_STATUS);
    const before = await stub.snapshot();
    const guard = budgetGuardFor(testEnv, () => new Date(`${date}T15:00:00Z`));
    expect(await guard.reserve(ADB_STATUS)).toEqual({
      allowed: false,
      reason: 'provider_kill_switch',
    });
    // Refused from KV: the object saw no new request, so no new denial was counted.
    expect((await stub.snapshot()).denials).toEqual(before.denials);
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
      expect(snapshot).toMatchObject({ killSwitch: true, killReason: 'manual:runaway spend' });
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
        message('m1', {
          kind: PROVIDER_BUDGET_OUTBOX_KINDS.killSwitch,
          seq: 1,
          origin: 'provider_budget:aerodatabox:2026-09-22',
          payload: {
            provider: 'aerodatabox',
            utcDate: '2026-09-22',
            reason: 'daily_cap',
            spentUnits: 13_333,
          },
        }),
        message('m2', {
          kind: PROVIDER_BUDGET_OUTBOX_KINDS.daily,
          seq: 2,
          origin: 'provider_budget:aerodatabox:2026-09-22',
          payload: { units: 13_333 },
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
    const { stub, date, sent, setClock } = await budget();
    await stub.configure({ dailyUnitCap: 100, perSecondLimit: 1_000 });
    await stub.reserve(ADB_STATUS);
    await stub.reserve({ ...ADB_STATUS, trigger: 'user_search' });
    await setClock(finaliseAtMs(date) + 60_000);

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(sent).toEqual([
      {
        kind: PROVIDER_BUDGET_OUTBOX_KINDS.daily,
        seq: 1,
        origin: `provider_budget:aerodatabox:${date}`,
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
    // A late call on the same instance recreates the schema instead of failing.
    expect(await stub.snapshot()).toMatchObject({ units: 0, calls: 0 });
    const migrations = await runInDurableObject(stub, (_i, state) =>
      [...state.storage.sql.exec<{ id: number }>(`SELECT id FROM ${MIGRATIONS_TABLE}`)].map(
        (row) => row.id,
      ),
    );
    expect(migrations).toEqual([1]);
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
