import { uuidv7 } from '@planeahead/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WORKER_CLIENT_OPTIONS, withDb } from '../src/client';
import { airports } from '../src/schema/reference';
import { createMigratedDatabase, type TestDatabase } from './helpers';

/**
 * `withDb` is the only production entry point and ruling D3 freezes three things about it: the
 * option set, a client created inside the call, and no `end()` on the Hyperdrive path. The
 * binding is only `{ connectionString }`, so the embedded server stands in for Hyperdrive.
 */

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createMigratedDatabase('client');
});

afterAll(async () => {
  await tdb.drop();
});

/** Backends on this database other than the caller's own connection. */
async function otherBackends(): Promise<number> {
  const [row] = await tdb.sql<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
    where datname = ${tdb.name} and pid <> pg_backend_pid()
  `;
  return row?.n ?? -1;
}

describe('withDb', () => {
  it('uses exactly the Hyperdrive option set Cloudflare documents', () => {
    expect({ ...WORKER_CLIENT_OPTIONS }).toEqual({ max: 5, fetch_types: false, prepare: true });
    expect(Object.isFrozen(WORKER_CLIENT_OPTIONS)).toBe(true);
  });

  it('runs the callback on a client built from the binding and never calls end()', async () => {
    const env = { DB: { connectionString: tdb.url } };
    const id = uuidv7();
    await tdb.db.insert(airports).values({
      id,
      ourairportsId: 1,
      ident: 'KTST',
      icao: 'KTST',
      icaoSource: 'icao_code',
      name: 'Test',
      type: 'small_airport',
      latitude: 0,
      longitude: 0,
      isoCountry: 'US',
      tz: 'UTC',
      tzSource: 'override',
    });
    const before = await otherBackends();
    const rows = await withDb(env, (db) => db.select().from(airports));
    expect(rows.map((row) => row.id)).toEqual([id]);
    // The connection the callback used is still open after withDb returned: Hyperdrive, not
    // the helper, reclaims it at the end of the invocation.
    expect(await otherBackends()).toBeGreaterThan(before);

    // A second call opens its own client and works independently of the first.
    const count = await withDb(env, async (db) => (await db.select().from(airports)).length);
    expect(count).toBe(1);

    await tdb.sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${tdb.name} and pid <> pg_backend_pid()
    `;
  });

  it('propagates the callback error', async () => {
    const env = { DB: { connectionString: tdb.url } };
    await expect(withDb(env, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});
