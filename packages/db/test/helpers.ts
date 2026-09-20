/**
 * Per-file database isolation. Every test file that touches Postgres creates its own database
 * on the shared cluster (embedded or CI service container), migrates it with the real
 * `migrateDatabase`, and drops it at the end. Files therefore run in parallel without sharing
 * rows, and every file re-proves that the migrations apply from scratch.
 */

import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { inject } from 'vitest';
import { createNodeDb, type NodeDb } from '../src/client';
import { migrateDatabase, type MigrateResult } from '../src/migrate';

export interface TestDatabase extends NodeDb {
  readonly name: string;
  readonly url: string;
  readonly migration: MigrateResult;
  drop(): Promise<void>;
}

export function adminUrl(): string {
  return inject('databaseUrl');
}

export function urlForDatabase(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

async function runAsAdmin(statement: string): Promise<void> {
  const admin = postgres(adminUrl(), { max: 1, fetch_types: false, prepare: false });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

/** Creates `planeahead_<label>_<random>`, migrates it and returns a client bound to it. */
export async function createMigratedDatabase(label: string): Promise<TestDatabase> {
  const name = `planeahead_${label}_${randomBytes(4).toString('hex')}`;
  await runAsAdmin(`create database "${name}"`);
  const url = urlForDatabase(adminUrl(), name);
  const migration = await migrateDatabase(url);
  const handle = createNodeDb(url, { max: 1 });
  return {
    ...handle,
    name,
    url,
    migration,
    drop: async () => {
      await handle.close();
      await runAsAdmin(`drop database "${name}" with (force)`);
    },
  };
}

/** Unwraps Drizzle's query error to the underlying Postgres SQLSTATE. */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let i = 0; i < 4 && current instanceof Error; i += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
    current = current.cause;
  }
  return undefined;
}
