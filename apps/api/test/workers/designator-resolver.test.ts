/**
 * The DesignatorResolver: fifty concurrent searches cost one AeroDataBox call, the Worker-side
 * KV cache short-circuits the object, the tracker's `seed` is idempotent, a not-found is cached
 * like a hit, an existing tracker is adopted without a call when the origin is known, the object
 * deletes itself 24 hours after resolving, and the "generating too much load" error gets one
 * jittered retry before an `overloaded` answer.
 */

import { listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { RPC_SCHEMA_VERSION, type ResolveResponseV1 } from '@planeahead/shared';
import {
  RESOLUTION_TTL_MS,
  resolveDesignator,
  searchKvKey,
  type DesignatorResolver,
} from '../../src/do/designator-resolver';
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
    // The resolver's own call record went to the persist queue with no flight key.
    const records = ofKind(resolver.outbox.sent, 'provider_call');
    expect(records).toHaveLength(1);
    expect(records[0]?.payload.trigger).toBe('user_search');
    expect(records[0]?.origin).toMatch(/^designator_resolver:/);
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
    // A fresher status is applied as an update, on the same tracker.
    const fresher = await seed(new Date(clock + 60_000).toISOString());
    expect(fresher.status).toBe('already');
    expect(fresher.version).toBe(1);
    expect((await tracker.stub.health()).version).toBe(1);
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
        sleep: (ms) => {
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
