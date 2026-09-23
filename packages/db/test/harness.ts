/**
 * The embedded PostgreSQL 18 harness as ONE reusable piece, for every package whose tests need a
 * real database. Node only.
 *
 * `packages/db` runs its own suite against this cluster through `test/globalSetup.ts`;
 * `apps/api` runs its Workers suite against it by starting it from its own global setup and
 * handing the URL to the Vitest Workers pool as the Hyperdrive binding's local connection
 * string. Both go through this module so the embedded lifecycle (the timeouts around the
 * package's open hang reports, the UTC guard, the `TEST_DATABASE_URL` override for CI) exists
 * exactly once. `test/embedded.ts` is the lifecycle itself; this file is the policy around it.
 */

import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { migrateDatabase, type MigrateResult } from '../src/migrate';
import { freePort, startEmbeddedPostgres, stopEmbeddedPostgres } from './embedded';
import { assertUtcServer, externalDatabaseUrl } from './globalSetup';

export interface TestCluster {
  /** Admin URL (superuser, CREATEDB) for the cluster. */
  readonly adminUrl: string;
  readonly source: 'shell' | '.env.test' | 'embedded';
  /** One line for the runner's stdout, so a slow start is attributable. */
  readonly description: string;
  /** Stops the embedded server; a no-op for an external cluster. */
  stop(): Promise<void>;
}

/**
 * Starts (or resolves) the cluster the suite runs against: `TEST_DATABASE_URL` from the shell,
 * then `packages/db/.env.test`, otherwise a fresh embedded PostgreSQL 18 on a free port. The
 * server's session time zone is asserted to be UTC before the cluster is handed out.
 */
export async function provisionTestCluster(): Promise<TestCluster> {
  const external = externalDatabaseUrl();
  if (external !== null) {
    await assertUtcServer(external.url, external.source);
    return {
      adminUrl: external.url,
      source: external.source,
      description: `using TEST_DATABASE_URL from ${external.source}; embedded server skipped`,
      stop: async () => {},
    };
  }

  const databaseDir = await mkdtemp(join(tmpdir(), 'planeahead-pg-'));
  const port = await freePort();
  const started = await startEmbeddedPostgres({ databaseDir, port });
  try {
    await assertUtcServer(started.url, 'embedded');
  } catch (error) {
    await stopEmbeddedPostgres(started);
    throw error;
  }
  return {
    adminUrl: started.url,
    source: 'embedded',
    description:
      `embedded PostgreSQL ${started.serverVersion} on port ${port}: ` +
      `initdb ${started.timings.initialiseMs} ms, start ${started.timings.startMs} ms, ` +
      `createDatabase ${started.timings.createDatabaseMs} ms`,
    stop: () => stopEmbeddedPostgres(started),
  };
}

export function urlForDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function runAsAdmin(adminUrl: string, statement: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1, fetch_types: false, prepare: false });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

export interface ProvisionedDatabase {
  readonly name: string;
  readonly url: string;
  readonly migration: MigrateResult;
  /** Drops the database. Every client that holds a connection to it must be closed first. */
  drop(): Promise<void>;
}

/**
 * Creates `planeahead_<label>_<random>` on the cluster and applies every migration with the real
 * migrator. Returns only the URL and a `drop()`; the caller opens whatever client it needs.
 */
export async function provisionMigratedDatabase(
  adminUrl: string,
  label: string,
): Promise<ProvisionedDatabase> {
  const name = `planeahead_${label}_${randomBytes(4).toString('hex')}`;
  await runAsAdmin(adminUrl, `create database "${name}"`);
  const url = urlForDatabase(adminUrl, name);
  const migration = await migrateDatabase(url);
  return {
    name,
    url,
    migration,
    drop: () => runAsAdmin(adminUrl, `drop database "${name}" with (force)`),
  };
}
