/**
 * The DesignatorResolver: fifty concurrent searches cost one AeroDataBox call, the Worker-side
 * KV cache short-circuits the object, the tracker's `seed` is idempotent, a not-found is cached
 * like a hit, an existing tracker is adopted without a call when the origin is known, the object
 * deletes itself 24 hours after resolving (never before every provider call record was sent),
 * an unconfigured provider is a zero-cost error record, and the "generating too much load"
 * error gets one jittered retry before an `overloaded` answer. A search's call records carry the
 * resolved flight key, and a failed resolution's carry none (increment 12).
 */

import { listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_SCHEMA_VERSION, type ResolveResponseV1 } from '@planeahead/shared';
import {
  RESOLUTION_TTL_MS,
  RESOLVER_FLUSH_ALERT_AFTER_ATTEMPTS,
  RESOLVER_FLUSH_RETRY_MS,
  searchKvKey,
  type DesignatorResolver,
} from '../../src/do/designator-resolver';
import type { Env } from '../../src/env';
import { resolveDesignator } from '../../src/search/resolve';
import {
  HOUR_MS,
  adbCalls,
  adbOk,
  drainTouched,
  ofKind,
  openBudgetFor,
  resolverHarness,
  scriptAdb,
  testEnv,
  track,
  trackerHarness,
  uniqueFlight,
} from './helpers/flights';

afterEach(drainTouched);

describe('DesignatorResolver', () => {
  it('fifty concurrent resolves make one provider call and seed one tracker', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    const tracker = await trackerHarness(flight.flightKey, clock);
    await openBudgetFor(flight, clock);
    const resolver = await resolverHarness(flight, clock);
    const request = {
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    };

    const answers = await Promise.all(
      Array.from({ length: 50 }, () => resolver.stub.resolve(request)),
    );

    expect(await adbCalls(flight)).toBe(1);
    expect(new Set(answers.map((a) => a.outcome))).toEqual(new Set(['resolved']));
    expect(new Set(answers.map((a) => a.flightKey))).toEqual(new Set([flight.flightKey]));
    expect(answers.filter((a) => a.created === true)).toHaveLength(50);
    expect(answers.every((a) => a.cached === false)).toBe(true);
    // One tracker, seeded once, first alarm at the next slot.
    const health = await tracker.stub.health();
    expect(health.phase).toBe('scheduled');
    expect(health.version).toBe(1);
    expect(await tracker.alarmAt()).toBe(clock + HOUR_MS);
    // The resolver's own call record went to the persist queue AFTER resolution, stamped with
    // the resolved flight key (increment 12), so provider_calls attributes the search to its
    // flight; the tracker's own ledger is untouched by it (one call, the seed's status).
    const records = ofKind(resolver.outbox.sent, 'provider_call');
    expect(records).toHaveLength(1);
    expect(records[0]?.payload.trigger).toBe('user_search');
    expect(records[0]?.payload.flightKey).toBe(flight.flightKey);
    expect(records[0]?.origin).toMatch(/^designator_resolver:/);
    expect((await tracker.stub.getCostLedger()).calls).toBe(0);
    // A later search is answered from the stored resolution.
    const again = await resolver.stub.resolve(request);
    expect(again.cached).toBe(true);
    expect(await adbCalls(flight)).toBe(1);
    // And the object wrote the Worker-side cache once it had an answer.
    await runInDurableObject(resolver.stub, (instance: DesignatorResolver) => instance.kvSettled());
    const kv = await testEnv.CACHE.get<ResolveResponseV1>(
      searchKvKey(flight.designator, flight.dateLocal),
      'json',
    );
    expect(kv?.flightKey).toBe(flight.flightKey);
    expect(kv?.cached).toBe(true);
  });

  it('the Worker-side search answers from KV without touching the namespace', async () => {
    const flight = uniqueFlight();
    const cached: ResolveResponseV1 = {
      rpcVersion: RPC_SCHEMA_VERSION,
      outcome: 'resolved',
      flightKey: flight.flightKey,
      created: false,
      cached: true,
      resolvedAt: '2100-01-01T00:00:00.000Z',
      expiresAt: '2100-01-02T00:00:00.000Z',
    };
    await testEnv.CACHE.put(
      searchKvKey(flight.designator, flight.dateLocal),
      JSON.stringify(cached),
      {
        expirationTtl: 900,
      },
    );
    const before = (await listDurableObjectIds(testEnv.DESIGNATOR_RESOLVER)).length;

    const result = await resolveDesignator(testEnv, {
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });

    expect(result).toMatchObject({
      outcome: 'resolved',
      flightKey: flight.flightKey,
      cached: true,
    });
    expect((await listDurableObjectIds(testEnv.DESIGNATOR_RESOLVER)).length).toBe(before);
    expect(await adbCalls(flight)).toBe(0);
  });

  it('seed is idempotent and ignores a status older than the stored one', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    const tracker = await trackerHarness(flight.flightKey, clock);
    await openBudgetFor(flight, clock);
    const resolver = await resolverHarness(flight, clock);
    const resolved = await resolver.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });
    const status = resolved.status;
    expect(status).toBeDefined();
    if (status === undefined) {
      return;
    }
    const seed = (fetchedAt: string) =>
      tracker.stub.seed({
        rpcVersion: RPC_SCHEMA_VERSION,
        flightKey: flight.flightKey,
        status: { ...status, fetchedAt },
        designator: flight.designator,
      });

    expect((await seed(status.fetchedAt)).status).toBe('already');
    const older = await seed(new Date(clock - HOUR_MS).toISOString());
    expect(older.status).toBe('stale');
    expect(older.version).toBe(1);
    // A fresher status is applied as an update, on the same tracker. Its instance row carries the
    // fresher `fetchedAt` and `lastRefreshedAt`, so it goes out under a version of its own
    // (increment 15 review ruling Q1: never two different instance payloads under one version;
    // it reused version 1 before).
    const fresher = await seed(new Date(clock + 60_000).toISOString());
    expect(fresher.status).toBe('already');
    expect(fresher.version).toBe(2);
    expect((await tracker.stub.health()).version).toBe(2);
    expect(await tracker.alarmAt()).toBe(clock + HOUR_MS);
  });

  it('caches a not-found like a hit, so a typo does not cost a call per search', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    // Nothing scripted: the gateway answers 204 on every date of the plus or minus one retry.
    await openBudgetFor(flight, clock);
    const resolver = await resolverHarness(flight, clock);
    const request = {
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    };

    const first = await resolver.stub.resolve(request);
    const second = await resolver.stub.resolve(request);

    expect(first).toMatchObject({ outcome: 'not_found', cached: false });
    expect(second).toMatchObject({ outcome: 'not_found', cached: true });
    // A person-supplied date buys the day-before and day-after retry: three billed misses.
    expect(await adbCalls(flight)).toBe(1);
    expect(ofKind(resolver.outbox.sent, 'provider_call')).toHaveLength(3);
    expect(ofKind(resolver.outbox.sent, 'provider_call').map((m) => m.payload.result)).toEqual([
      'not_found',
      'not_found',
      'not_found',
    ]);
    // A failed resolution still records every attempt, without a key (increment 12).
    expect(ofKind(resolver.outbox.sent, 'provider_call').map((m) => m.payload.flightKey)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('adopts an existing tracker without a provider call when the origin is known', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    const tracker = await trackerHarness(flight.flightKey, clock);
    await openBudgetFor(flight, clock);
    // Created once, by a search that did not know the origin.
    const creator = await resolverHarness(flight, clock);
    await creator.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });
    expect(await adbCalls(flight)).toBe(1);
    // Expired and gone: the next search starts from nothing but knows the origin.
    await creator.setClock(clock + RESOLUTION_TTL_MS + 1);
    await runInDurableObject(creator.stub, (instance: DesignatorResolver) => instance.alarm());

    const again = await creator.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
      originIcao: 'KJFK',
    });

    expect(again).toMatchObject({
      outcome: 'resolved',
      flightKey: flight.flightKey,
      created: false,
    });
    expect(await adbCalls(flight)).toBe(1);
    expect((await tracker.stub.health()).phase).toBe('scheduled');
  });

  it('expires 24 hours after resolving: deleteAll, and a later search resolves again', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    await trackerHarness(flight.flightKey, clock);
    await openBudgetFor(flight, clock);
    const resolver = await resolverHarness(flight, clock);
    const request = {
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    };
    const first = await resolver.stub.resolve(request);
    expect(first.expiresAt).toBe(new Date(clock + RESOLUTION_TTL_MS).toISOString());
    expect(await resolver.alarmAt()).toBe(clock + RESOLUTION_TTL_MS);

    // Woken early (a duplicate delivery): the schedule is kept.
    await resolver.setClock(clock + HOUR_MS);
    await runInDurableObject(resolver.stub, (instance: DesignatorResolver) => instance.alarm());
    expect(await resolver.alarmAt()).toBe(clock + RESOLUTION_TTL_MS);

    await resolver.setClock(clock + RESOLUTION_TTL_MS);
    await runInDurableObject(resolver.stub, (instance: DesignatorResolver) => instance.alarm());
    const tables = await runInDurableObject(resolver.stub, (_instance, state) =>
      [
        ...state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ),
      ]
        .map((row) => row.name)
        .filter((name) => !name.startsWith('_cf_')),
    );
    expect(tables).toEqual([]);
    expect(await resolver.alarmAt()).toBeNull();

    // The tracker still exists, so the second resolution adopts it after one more call.
    const second = await resolver.stub.resolve(request);
    expect(second).toMatchObject({
      outcome: 'resolved',
      flightKey: flight.flightKey,
      created: false,
    });
    expect(await adbCalls(flight)).toBe(2);
  });

  it('retries "generating too much load" once with jitter, then answers overloaded', async () => {
    const flight = uniqueFlight();
    const loadError = () => new Error('Durable Object is generating too much load');
    const answer: ResolveResponseV1 = {
      rpcVersion: RPC_SCHEMA_VERSION,
      outcome: 'resolved',
      flightKey: flight.flightKey,
      cached: false,
      resolvedAt: '2100-01-01T00:00:00.000Z',
      expiresAt: '2100-01-02T00:00:00.000Z',
    };
    let calls = 0;
    const sleeps: number[] = [];
    const flaky = {
      resolve: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(loadError()) : Promise.resolve(answer);
      },
    };
    const recovered = await resolveDesignator(
      testEnv,
      { designator: flight.designator, dateLocal: flight.dateLocal },
      {
        stubFor: () => flaky,
        sleep: (ms: number) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(recovered).toMatchObject({ outcome: 'resolved', flightKey: flight.flightKey });
    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0] ?? 0).toBeGreaterThanOrEqual(50);
    expect(sleeps[0] ?? 0).toBeLessThan(250);

    // The default wait is `scheduler.wait` in the Worker (never a timer in an object): the
    // retry still happens, after the jitter, with no sleep injected.
    let defaultCalls = 0;
    const flakyDefault = {
      resolve: () => {
        defaultCalls += 1;
        return defaultCalls === 1 ? Promise.reject(loadError()) : Promise.resolve(answer);
      },
    };
    const started = Date.now();
    const recoveredByDefault = await resolveDesignator(
      testEnv,
      { designator: flight.designator, dateLocal: flight.dateLocal },
      { stubFor: () => flakyDefault },
    );
    expect(recoveredByDefault).toMatchObject({ outcome: 'resolved' });
    expect(defaultCalls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);

    const always = { resolve: () => Promise.reject(loadError()) };
    const overloaded = await resolveDesignator(
      testEnv,
      { designator: flight.designator, dateLocal: flight.dateLocal },
      { stubFor: () => always, sleep: () => Promise.resolve() },
    );
    expect(overloaded).toEqual({ outcome: 'overloaded', retryAfterSeconds: 2 });

    // Any other error is not retried and surfaces.
    const broken = { resolve: () => Promise.reject(new Error('something else')) };
    await expect(
      resolveDesignator(
        testEnv,
        { designator: flight.designator, dateLocal: flight.dateLocal },
        { stubFor: () => broken, sleep: () => Promise.resolve() },
      ),
    ).rejects.toThrow('something else');
    void track;
  });

  it('never deletes an unsent provider call record at expiry: hourly retries, one alert (L2)', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    await scriptAdb(flight, [adbOk(flight, { phase: 'expected' })]);
    await trackerHarness(flight.flightKey, clock);
    await openBudgetFor(flight, clock);
    const resolver = await resolverHarness(flight, clock);
    const alerts: string[] = [];
    await runInDurableObject(resolver.stub, (instance: DesignatorResolver) => {
      instance.capture = (message) => void alerts.push(message);
    });
    resolver.outbox.failSends = true;
    const resolved = await resolver.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });
    expect(resolved.outcome).toBe('resolved');
    // The billed call's record could not be sent: the first retry is an hour out, not a day.
    expect(await resolver.alarmAt()).toBe(clock + RESOLVER_FLUSH_RETRY_MS);
    const alarm = () =>
      runInDurableObject(resolver.stub, (instance: DesignatorResolver) => instance.alarm());
    const unsent = () =>
      runInDurableObject(
        resolver.stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE sent_at_ms IS NULL')
            .one().n,
      );
    // Before expiry the alarm keeps retrying hourly and keeps the schedule.
    await resolver.setClock(clock + RESOLVER_FLUSH_RETRY_MS);
    await alarm();
    expect(await unsent()).toBe(1);
    expect(await resolver.alarmAt()).toBe(clock + 2 * RESOLVER_FLUSH_RETRY_MS);

    // At expiry, six failed attempts: deferred hourly, one alert at the sixth, nothing deleted.
    let at = clock + RESOLUTION_TTL_MS;
    for (let attempt = 1; attempt <= RESOLVER_FLUSH_ALERT_AFTER_ATTEMPTS; attempt += 1) {
      await resolver.setClock(at);
      await alarm();
      expect(await unsent()).toBe(1);
      expect(await resolver.alarmAt()).toBe(at + RESOLVER_FLUSH_RETRY_MS);
      expect(alerts).toEqual(
        attempt < RESOLVER_FLUSH_ALERT_AFTER_ATTEMPTS ? [] : ['designator_resolver_outbox_stuck'],
      );
      at += RESOLVER_FLUSH_RETRY_MS;
    }

    // The queue is back: the next alarm sends the record and deletes everything.
    resolver.outbox.failSends = false;
    await resolver.setClock(at);
    await alarm();
    expect(ofKind(resolver.outbox.sent, 'provider_call')).toHaveLength(1);
    expect(ofKind(resolver.outbox.sent, 'provider_call')[0]?.payload.trigger).toBe('user_search');
    const tables = await runInDurableObject(resolver.stub, (_instance, state) =>
      [
        ...state.storage.sql.exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        ),
      ]
        .map((row) => row.name)
        .filter((name) => !name.startsWith('_cf_')),
    );
    expect(tables).toEqual([]);
    expect(await resolver.alarmAt()).toBeNull();
    expect(alerts).toHaveLength(1);
    expect(await adbCalls(flight)).toBe(1);
  });

  it('marks a backlog of 120 sent rows in bind-safe chunks, inside one transaction', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    // Nothing scripted: a cached not-found keeps the object alive with its resolution row while
    // the queue is down, and its three billed misses are the first unsent rows.
    await openBudgetFor(flight, clock);
    const resolver = await resolverHarness(flight, clock);
    resolver.outbox.failSends = true;
    const resolved = await resolver.stub.resolve({
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    });
    expect(resolved.outcome).toBe('not_found');
    // The records of 117 more failed searches pile up behind them.
    await runInDurableObject(resolver.stub, (_instance, state) => {
      for (let i = 0; i < 117; i += 1) {
        state.storage.sql.exec(
          'INSERT INTO outbox (kind, payload, created_at_ms) VALUES (?, ?, ?)',
          'provider_call',
          JSON.stringify({ kind: 'provider_call', payload: { id: `backlog-${String(i)}` } }),
          clock,
        );
      }
    });
    const unsent = () =>
      runInDurableObject(
        resolver.stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE sent_at_ms IS NULL')
            .one().n,
      );
    expect(await unsent()).toBe(120);

    // The queue is back: the retry alarm sends every row and marks all 120 sent, more seqs than
    // one statement can bind (this once threw `too many SQL variables` after the send, every
    // time, and re-sent the whole backlog on each later resolve).
    resolver.outbox.failSends = false;
    await resolver.setClock(clock + RESOLVER_FLUSH_RETRY_MS);
    await runInDurableObject(resolver.stub, (instance: DesignatorResolver) => instance.alarm());

    expect(resolver.outbox.batches).toEqual([100, 20]);
    expect(resolver.outbox.sent).toHaveLength(120);
    expect(await unsent()).toBe(0);
    // Before expiry the schedule is kept, nothing left to retry.
    expect(await resolver.alarmAt()).toBe(clock + RESOLUTION_TTL_MS);
  });

  it('records a provider that is not configured as a zero-cost error and alerts once (L17)', async () => {
    const flight = uniqueFlight();
    const clock = flight.scheduledOut.getTime() - 48 * HOUR_MS;
    await openBudgetFor(flight, clock);
    const resolver = await resolverHarness(flight, clock);
    const alerts: string[] = [];
    await runInDurableObject(resolver.stub, (instance: DesignatorResolver) => {
      const holder = instance as unknown as { env: Env };
      holder.env = { ...holder.env, AERODATABOX_API_KEY: '' };
      instance.capture = (message) => void alerts.push(message);
    });
    const request = {
      rpcVersion: RPC_SCHEMA_VERSION,
      designator: flight.designator,
      dateLocal: flight.dateLocal,
    };

    const first = await resolver.stub.resolve(request);
    const second = await resolver.stub.resolve(request);

    expect(first).toMatchObject({ outcome: 'error', cached: false, reason: 'config' });
    expect(second).toMatchObject({ outcome: 'error', cached: false, reason: 'config' });
    expect(await adbCalls(flight)).toBe(0);
    const records = ofKind(resolver.outbox.sent, 'provider_call');
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.payload).toMatchObject({
        result: 'error',
        costUnits: 0,
        trigger: 'user_search',
      });
      expect(record.payload.error).toMatch(/^config:AERODATABOX_API_KEY/);
      expect(record.payload.flightKey).toBeUndefined();
    }
    expect(alerts).toEqual(['provider_config_error']);
  });

  it('refuses an unknown rpcVersion with a typed error', async () => {
    const flight = uniqueFlight();
    const resolver = await resolverHarness(flight, flight.scheduledOut.getTime() - HOUR_MS);
    // Called on the instance: a throw across the pool's RPC boundary is also reported as an
    // unhandled rejection of the run, which is the plugin's doing, not the object's.
    const attempt = (input: unknown) =>
      runInDurableObject(resolver.stub, (instance: DesignatorResolver) => instance.resolve(input));
    await expect(
      attempt({ rpcVersion: 2, designator: flight.designator, dateLocal: flight.dateLocal }),
    ).rejects.toThrow(/^unsupported_rpc_version: /);
    await expect(
      attempt({ designator: flight.designator, dateLocal: 'yesterday' }),
    ).rejects.toThrow(/^invalid_request: /);
    expect(await adbCalls(flight)).toBe(0);
  });
});
