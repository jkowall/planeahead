/**
 * Vitest global setup: one embedded PostgreSQL 18.4 cluster per test run.
 *
 * `TEST_DATABASE_URL` decides the target. The shell environment wins; otherwise
 * `packages/db/.env.test` (gitignored) is read for a developer pointing the suite at a Neon
 * branch; otherwise `embedded-postgres` runs `initdb` into a fresh temp directory, starts
 * `postgres` on a free port and creates the admin database. CI sets the variable to its
 * `postgres:18` service container. Every embedded call is wrapped in a 60 s timeout because the
 * package has open reports of `initialise()`, `start()` and `stop()` never settling
 * (leinelissen/embedded-postgres issues 32 and 34).
 *
 * Whatever the source, the server's session time zone must have a zero UTC offset before any
 * test runs: `instant()` columns normalise reads, but raw SQL text comparisons in the suite and
 * the documented environment rule (`ALTER ROLE ... SET TimeZone = 'UTC'`) assume it, and a
 * drifted server would otherwise fail with a confusing string mismatch instead of a diagnosis.
 *
 * Test files never share a database: `test/helpers.ts` clones a fresh one per file from this
 * cluster, so the URL provided here is only the admin entry point.
 */

import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { freePort, startEmbeddedPostgres, stopEmbeddedPostgres } from './embedded';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin URL (superuser, CREATEDB) for the cluster the suite runs against. */
    databaseUrl: string;
  }
}

export const ENV_TEST_FILE = resolve(import.meta.dirname, '..', '.env.test');

/** Minimal `KEY=VALUE` parser: comments, blank lines and optional single or double quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export interface ExternalDatabase {
  readonly url: string;
  readonly source: 'shell' | '.env.test';
}

/** The external database URL, if any: shell first, then `.env.test`. */
export function externalDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  envFile: string = ENV_TEST_FILE,
): ExternalDatabase | null {
  const fromShell = env['TEST_DATABASE_URL'];
  if (fromShell !== undefined && fromShell !== '') {
    return { url: fromShell, source: 'shell' };
  }
  let text: string;
  try {
    text = readFileSync(envFile, 'utf8');
  } catch {
    return null;
  }
  const fromFile = parseEnvFile(text)['TEST_DATABASE_URL'];
  if (fromFile !== undefined && fromFile !== '') {
    return { url: fromFile, source: '.env.test' };
  }
  return null;
}

export class ServerTimeZoneError extends Error {
  override readonly name = 'ServerTimeZoneError';
}

/** Fails with a diagnosis if the server's session time zone is not at UTC offset zero. */
export async function assertUtcServer(url: string, source: string): Promise<void> {
  const sql = postgres(url, { max: 1, fetch_types: false, prepare: false });
  try {
    const [row] = await sql<{ tz: string; offset: string }[]>`
      select current_setting('TimeZone') as tz, extract(timezone from now())::text as offset
    `;
    if (row === undefined || Number(row.offset) !== 0) {
      throw new ServerTimeZoneError(
        `the ${source} database session TimeZone is ${row?.tz ?? 'unknown'} (offset ${row?.offset ?? '?'} s). ` +
          'The suite and the environment rule need UTC: run ' +
          "`ALTER ROLE <role> SET TimeZone = 'UTC'` on the target (Neon), set TZ=UTC on the " +
          'postgres:18 service container (CI), or pass -c timezone=UTC to the server.',
      );
    }
  } finally {
    await sql.end();
  }
}

export async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = externalDatabaseUrl();
  if (external !== null) {
    await assertUtcServer(external.url, external.source);
    process.env['TEST_DATABASE_URL'] = external.url;
    project.provide('databaseUrl', external.url);
    process.stdout.write(
      `[db test harness] using TEST_DATABASE_URL from ${external.source}; embedded server skipped\n`,
    );
    return async () => {};
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
