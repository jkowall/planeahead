/**
 * Embedded PostgreSQL 18 lifecycle for the test harness. Kept separate from the Vitest hooks so
 * the spike scripts under `scratch/` and the global setup share one implementation.
 */

import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import AsyncExitHook from 'async-exit-hook';
import EmbeddedPostgres from 'embedded-postgres';

// embedded-postgres registers `async-exit-hook` at MODULE SCOPE (dist/index.js:
// `AsyncExitHook(gracefulShutdown)`), and that library's first registration hooks `beforeExit`
// with exit code 0: when Node's event loop drains it calls `process.exit(0)`, which overrides the
// `process.exitCode = 1` Vitest sets on a failed run. The import above is enough to arm it, so a
// failing suite in this package and in apps/api (whose global setup imports this module through
// the test harness) exited 0, with or without an embedded cluster. Both process-end handlers are
// removed right here, before anything else runs: `beforeExit` for the exit code, and `exit`
// because without the first it would be the hook's first run and async-exit-hook runs `exit`
// handlers synchronously, without the `done` callback `gracefulShutdown(done)` calls after its
// awaits (a `TypeError: done is not a function` printed at the end of every run). Neither is
// needed: the harness teardown stops the cluster explicitly. The signal hooks stay, so a SIGINT
// still stops a running cluster. `async-exit-hook` is a devDependency of this package at the same
// catalog version so this import resolves to the one module instance embedded-postgres
// registered with; scripts/vitest-exit-guard.mjs proves the exit code in both packages.
for (const event of ['beforeExit', 'exit']) {
  if (AsyncExitHook.hookedEvents().includes(event)) {
    AsyncExitHook.unhookEvent(event);
  }
}

export const EMBEDDED_TIMEOUT_MS = 60_000;

export const TEST_DB_USER = 'planeahead';
export const TEST_DB_PASSWORD = 'planeahead';
export const TEST_ADMIN_DATABASE = 'planeahead_admin';

export interface EmbeddedTimings {
  initialiseMs: number;
  startMs: number;
  createDatabaseMs: number;
}

export interface StartedEmbeddedPostgres {
  server: EmbeddedPostgres;
  databaseDir: string;
  port: number;
  url: string;
  serverVersion: string;
  timings: EmbeddedTimings;
}

export class EmbeddedTimeoutError extends Error {
  override readonly name = 'EmbeddedTimeoutError';

  constructor(step: string, ms: number) {
    super(`embedded-postgres ${step}() did not settle within ${ms} ms`);
  }
}

/** Races a promise against a timer; the timer is always cleared so it cannot keep Node alive. */
export async function withTimeout<T>(
  step: string,
  promise: Promise<T>,
  ms: number = EMBEDDED_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new EmbeddedTimeoutError(step, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Asks the kernel for an unused TCP port on the loopback interface. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export interface StartOptions {
  databaseDir: string;
  port: number;
}

export async function startEmbeddedPostgres(
  options: StartOptions,
): Promise<StartedEmbeddedPostgres> {
  const log: string[] = [];
  const server = new EmbeddedPostgres({
    databaseDir: options.databaseDir,
    port: options.port,
    user: TEST_DB_USER,
    password: TEST_DB_PASSWORD,
    authMethod: 'scram-sha-256',
    // `persistent: false` makes stop() delete the data directory itself.
    persistent: false,
    // Durability is irrelevant for a throwaway cluster; these flags make initdb-heavy suites
    // noticeably faster on laptops and CI runners.
    postgresFlags: [
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
      '-c',
      'listen_addresses=127.0.0.1',
      // Pin the session TimeZone. Drizzle reads normalise timestamptz text to ISO UTC whatever
      // the zone is, but raw SQL reads and the globalSetup guard expect a zero offset, as CI
      // (TZ=UTC on the service container) and Neon (ALTER ROLE ... SET TimeZone, docs/
      // schema-review.md section 12) do.
      '-c',
      'timezone=UTC',
    ],
    onLog: (message) => {
      log.push(message);
    },
    onError: (message) => {
      log.push(String(message));
    },
  });

  const timings: EmbeddedTimings = { initialiseMs: 0, startMs: 0, createDatabaseMs: 0 };
  const describeFailure = (step: string, error: unknown): Error => {
    const detail =
      error instanceof Error ? error.message : error === undefined ? 'process exited' : 'failed';
    return new Error(
      `embedded-postgres ${step} failed: ${detail}\n--- postgres output ---\n${log.join('')}`,
    );
  };

  let t0 = performance.now();
  try {
    await withTimeout('initialise', server.initialise());
  } catch (error) {
    throw describeFailure('initialise', error);
  }
  timings.initialiseMs = Math.round(performance.now() - t0);

  t0 = performance.now();
  try {
    // start() rejects with `undefined` when the process exits early; normalise that.
    await withTimeout(
      'start',
      server.start().catch((error: unknown) => {
        throw error instanceof Error
          ? error
          : new Error('postgres process exited before it was ready');
      }),
    );
  } catch (error) {
    throw describeFailure('start', error);
  }
  timings.startMs = Math.round(performance.now() - t0);

  t0 = performance.now();
  try {
    await withTimeout('createDatabase', server.createDatabase(TEST_ADMIN_DATABASE));
  } catch (error) {
    await withTimeout('stop', server.stop()).catch(() => undefined);
    throw describeFailure('createDatabase', error);
  }
  timings.createDatabaseMs = Math.round(performance.now() - t0);

  const versionLine = log.find((line) => /PostgreSQL \d+\.\d+/.test(line));
  const serverVersion = /PostgreSQL (\d+\.\d+)/.exec(versionLine ?? '')?.[1] ?? 'unknown';

  const url =
    `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@127.0.0.1:${options.port}/` +
    TEST_ADMIN_DATABASE;

  return {
    server,
    databaseDir: options.databaseDir,
    port: options.port,
    url,
    serverVersion,
    timings,
  };
}

export async function stopEmbeddedPostgres(started: StartedEmbeddedPostgres): Promise<void> {
  try {
    await withTimeout('stop', started.server.stop());
  } catch (error) {
    // A hung stop() must not fail the run; the OS reclaims the process at exit. Report it.
    const detail = error instanceof Error ? error.message : 'stop() failed';
    process.stderr.write(`[db test harness] ${detail}\n`);
  } finally {
    await rm(started.databaseDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
