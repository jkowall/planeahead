/**
 * The database reaches the Worker. Increment 4 never dialled Postgres from the pool; increment 5
 * must, so this is the first thing to prove and the first thing to look at when the auth suite
 * fails wholesale: if `env.DB` does not answer here, nothing downstream can.
 *
 * `withDb` is the real helper over the real Hyperdrive binding, which the Workers plugin points
 * at the database `test/globalSetup.ts` migrated (`miniflare.hyperdrives` in vitest.config.ts).
 */

import { sql } from 'drizzle-orm';
import { withDb } from '@planeahead/db';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('env.DB through the Workers pool', () => {
  it('answers a trivial query on PostgreSQL 18 with the migrated schema', async () => {
    const result = await withDb(env, async (db) => {
      const [row] = await db.execute<{ version_num: string; users: string }>(sql`
        select current_setting('server_version_num') as version_num,
               (select count(*) from users)::text as users
      `);
      return row;
    });

    expect(Number(result?.version_num)).toBeGreaterThanOrEqual(180000);
    expect(result?.users).toMatch(/^\d+$/);
  });

  it('reads the connection string from the binding the plugin overrode', () => {
    expect(env.DB.connectionString).toMatch(/^postgres(ql)?:\/\//);
    expect(env.DB.connectionString).not.toContain('planeahead_local');
  });
});
