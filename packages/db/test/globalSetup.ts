/**
 * Vitest global setup: one embedded PostgreSQL 18.4 cluster per test run.
 *
 * When `TEST_DATABASE_URL` is already set (CI's `postgres:18` service container, or a developer
 * pointing the suite at a Neon branch through `.env.test`) the embedded server is skipped and that
 * URL is used as-is. Otherwise `embedded-postgres` runs `initdb` into a fresh temp directory,
 * starts `postgres` on a free port and creates the admin database. Every call is wrapped in a
 * 60 s timeout because the package has open reports of `initialise()`, `start()` and `stop()`
 * never settling (leinelissen/embedded-postgres issues 32 and 34).
 *
 * Test files never share a database: `test/helpers.ts` clones a fresh one per file from this
 * cluster, so the URL provided here is only the admin entry point.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { freePort, startEmbeddedPostgres, stopEmbeddedPostgres } from './embedded';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin URL (superuser, CREATEDB) for the cluster the suite runs against. */
    databaseUrl: string;
  }
}

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env['TEST_DATABASE_URL'];
  if (external !== undefined && external !== '') {
    project.provide('databaseUrl', external);
    return async () => {};
  }

  const databaseDir = await mkdtemp(join(tmpdir(), 'planeahead-pg-'));
  const port = await freePort();
  const started = await startEmbeddedPostgres({ databaseDir, port });
  process.env['TEST_DATABASE_URL'] = started.url;
  project.provide('databaseUrl', started.url);
  process.stdout.write(
    `[db test harness] embedded PostgreSQL ${started.serverVersion} on port ${port}: ` +
      `initdb ${started.timings.initialiseMs} ms, start ${started.timings.startMs} ms, ` +
      `createDatabase ${started.timings.createDatabaseMs} ms\n`,
  );

  return async () => {
    await stopEmbeddedPostgres(started);
  };
}
