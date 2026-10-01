/**
 * Every Durable Object class is reachable, runs its migration runner in the constructor and
 * reports the version this build expects.
 *
 * Two test-hygiene rules are load bearing here and both come from a spike recorded in
 * docs/increments/04-api-bootstrap.md:
 *
 *   1. A unique object name per test. Storage isolation in @cloudflare/vitest-plugin 1.1.13 is
 *      per test FILE, not per test, so two tests in this file that used the same name would share
 *      SQLite state and the second one would see a warm object.
 *   2. An `afterEach` alarm drain. A scheduled alarm fires on its own wall clock inside the test
 *      pool (spike 2 measured it firing 200 ms after it was set, with no `runDurableObjectAlarm`
 *      call), so an alarm left pending by one test runs during another. From increment 7 the
 *      FlightTracker and DesignatorResolver do schedule alarms, so the drain is load bearing.
 */

import { listDurableObjectIds, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { DurableObjectPing } from '../../src/do/base';
import { MIGRATIONS_TABLE } from '../../src/do/migrate';

/** Every stub a test touched, so `afterEach` can drain whatever it left scheduled. */
const touched: DurableObjectStub[] = [];

function track<T extends DurableObjectStub>(stub: T): T {
  touched.push(stub);
  return stub;
}

/** Unique per test: storage isolation is per file, so names cannot be reused within one. */
function uniqueName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

afterEach(async () => {
  while (touched.length > 0) {
    const stub = touched.pop();
    if (stub !== undefined) {
      await runDurableObjectAlarm(stub);
    }
  }
});

interface PingCase {
  readonly className: string;
  readonly ping: (name: string) => Promise<DurableObjectPing>;
  /**
   * The class's migrations: one for ProviderBudget (increment 6), three for FlightTracker
   * (increment 7, its final re-review round, increment 15's policy state), two for
   * DesignatorResolver (increment 7 and its review fix round), one for PushAuth (increment 14);
   * none for the two shells.
   */
  readonly version: number;
}

const CLASSES: readonly PingCase[] = [
  {
    className: 'FlightTracker',
    ping: (name) => track(env.FLIGHT_TRACKER.getByName(name, { locationHint: 'enam' })).ping(),
    version: 3,
  },
  {
    className: 'DesignatorResolver',
    ping: (name) => track(env.DESIGNATOR_RESOLVER.getByName(name)).ping(),
    version: 2,
  },
  {
    // Increment 18: the board buckets, their chunks, coverage and the outbox; then the stored
    // waits of buckets whose fetch failed deterministically (close-out, M1).
    className: 'AirportState',
    ping: (name) => track(env.AIRPORT_STATE.getByName(name)).ping(),
    version: 2,
  },
  {
    className: 'UserInbox',
    ping: (name) => track(env.USER_INBOX.getByName(name)).ping(),
    version: 0,
  },
  {
    // Increment 18: the distinct airports refreshed per hour.
    className: 'ProviderBudget',
    ping: (name) => track(env.PROVIDER_BUDGET.getByName(name)).ping(),
    version: 2,
  },
  {
    // Increment 14: the credential table and the last mint failure.
    className: 'PushAuth',
    ping: (name) => track(env.PUSH_AUTH.getByName(name)).ping(),
    version: 1,
  },
];

describe('Durable Object shells', () => {
  it.each(CLASSES)(
    '$className answers ping() at schema version $version and applies its migrations on first touch',
    async ({ className, ping, version }) => {
      const result = await ping(uniqueName(`ping-${className}`));

      expect(result.className).toBe(className);
      expect(result.schemaVersion).toBe(version);
      expect(result.appliedVersion).toBe(version);
      expect(result.applied).toEqual(Array.from({ length: version }, (_value, index) => index + 1));
    },
  );

  it('creates the migrations table in the constructor, before the first RPC returns', async () => {
    const stub = track(env.AIRPORT_STATE.getByName(uniqueName('table')));

    const tables = await runInDurableObject(stub, (_instance, state) => [
      ...state.storage.sql.exec<{ name: string }>(
        'SELECT name FROM sqlite_master WHERE type = ? AND name = ?',
        'table',
        MIGRATIONS_TABLE,
      ),
    ]);

    expect(tables).toHaveLength(1);
  });

  it('gives a class declared only through the wrangler exports map real SQLite storage', async () => {
    // Spike 1. `exports` in wrangler.jsonc does not create the binding (durable_objects.bindings
    // does), but it is what decides the storage backend, and local-dev support for it is not
    // documented anywhere. A class that silently got "legacy-kv" storage would have no
    // `state.storage.sql` at all and every later increment's schema would fail at run time.
    const stub = track(
      env.FLIGHT_TRACKER.getByName(uniqueName('sqlite'), { locationHint: 'enam' }),
    );

    const note = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE spike (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
      state.storage.sql.exec('INSERT INTO spike (id, note) VALUES (1, ?)', 'sqlite-backed');
      return [...state.storage.sql.exec<{ note: string }>('SELECT note FROM spike')][0]?.note;
    });

    expect(note).toBe('sqlite-backed');
  });

  it('creates an object only when it is touched', async () => {
    // Counted as a delta, not from zero: storage isolation is per file, so earlier tests in this
    // file have already created objects in this namespace.
    const before = await listDurableObjectIds(env.PROVIDER_BUDGET);
    const stub = track(env.PROVIDER_BUDGET.getByName(uniqueName('count')));
    const untouched = await listDurableObjectIds(env.PROVIDER_BUDGET);

    await stub.ping();

    expect(untouched).toHaveLength(before.length);
    expect(await listDurableObjectIds(env.PROVIDER_BUDGET)).toHaveLength(before.length + 1);
  });
});
