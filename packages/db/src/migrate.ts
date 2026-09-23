/**
 * Programmatic migrator for CI, deploy and tests. Node only (reads the migrations folder).
 *
 * Rules:
 *   - takes a URL string, never a binding: migrations run against the Neon direct endpoint over
 *     `DATABASE_URL`, never through Hyperdrive (transaction-mode pooling and the 60 s statement
 *     cap are wrong for DDL) and never through Neon's `-pooler` endpoint;
 *   - asserts `server_version_num >= 180000` first: the schema needs PG18's `uuidv7()`, and a
 *     `postgres:17` service container or a misconfigured Neon project must fail with a clear
 *     message, not a syntax error halfway through migration 0000;
 *   - holds a session advisory lock for the duration so two deploy jobs cannot interleave.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate as drizzleMigrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));
export const MINIMUM_SERVER_VERSION_NUM = 180000;
/** Arbitrary 64-bit key for `pg_advisory_lock`; shared by every migration runner of this app. */
export const MIGRATION_LOCK_KEY = 7_311_925_420_260_919n;

export class MigrationTargetError extends Error {
  override readonly name = 'MigrationTargetError';
}

export class PostgresVersionError extends Error {
  override readonly name = 'PostgresVersionError';

  constructor(readonly serverVersionNum: number) {
    super(
      `PostgreSQL ${describeVersion(serverVersionNum)} is not supported: PlaneAhead needs 18 or ` +
        `newer (server_version_num >= ${MINIMUM_SERVER_VERSION_NUM}) for native uuidv7(). ` +
        'Create the Neon project with Postgres 18 selected, or use the postgres:18 image.',
    );
  }
}

function describeVersion(num: number): string {
  return `${Math.floor(num / 10000)}.${num % 10000}`;
}

/** Accepts only a plain Postgres URL whose host is not a Neon pooler endpoint. */
export function assertMigrationUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MigrationTargetError('migration target must be a postgres:// URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new MigrationTargetError(
      `migration target must use the postgres:// scheme, got ${parsed.protocol}`,
    );
  }
  if (parsed.hostname === '') {
    throw new MigrationTargetError('migration target URL has no host');
  }
  if (parsed.hostname.includes('-pooler')) {
    throw new MigrationTargetError(
      `refusing to migrate through the Neon pooler endpoint ${parsed.hostname}; use the direct endpoint`,
    );
  }
  return parsed;
}

/** The minimal client surface the version guard needs, so a test can stub it. */
export type VersionClient = Pick<Sql, 'unsafe'>;

export async function readServerVersionNum(client: VersionClient): Promise<number> {
  const rows = await client.unsafe(
    "select current_setting('server_version_num') as server_version_num",
  );
  const value: unknown = rows[0]?.['server_version_num'];
  const num = Number(value);
  if (!Number.isInteger(num)) {
    throw new MigrationTargetError(`could not read server_version_num (got ${String(value)})`);
  }
  return num;
}

export async function assertServerVersion(client: VersionClient): Promise<number> {
  const num = await readServerVersionNum(client);
  if (num < MINIMUM_SERVER_VERSION_NUM) {
    throw new PostgresVersionError(num);
  }
  return num;
}

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export function readJournal(migrationsFolder: string = MIGRATIONS_FOLDER): Journal {
  return JSON.parse(
    readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;
}

/** SHA-256 of `meta/_journal.json`; `/health` reports it so a deploy can prove which schema is live. */
export function migrationHash(migrationsFolder: string = MIGRATIONS_FOLDER): string {
  const journal = readFileSync(join(migrationsFolder, 'meta', '_journal.json'));
  return createHash('sha256').update(journal).digest('hex');
}

export interface MigrateOptions {
  readonly migrationsFolder?: string;
  /** Test seam: returns the client to use for the given URL. Defaults to postgres.js, max 1. */
  readonly connect?: (url: string) => Sql;
  readonly log?: (line: string) => void;
}

export interface MigrateResult {
  readonly serverVersionNum: number;
  readonly migrationHash: string;
  readonly migrations: number;
}

/**
 * Applies every pending migration. Throws `MigrationTargetError` for a pooler or non-Postgres
 * URL and `PostgresVersionError` below PG18 before touching the schema.
 */
export async function migrateDatabase(
  url: string,
  options: MigrateOptions = {},
): Promise<MigrateResult> {
  assertMigrationUrl(url);
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER;
  const log = options.log ?? (() => undefined);
  const client =
    options.connect?.(url) ?? postgres(url, { max: 1, fetch_types: false, prepare: true });
  try {
    const serverVersionNum = await assertServerVersion(client);
    log(`server_version_num ${serverVersionNum}`);
    await client.unsafe(`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
    try {
      await drizzleMigrate(drizzle(client), { migrationsFolder });
    } finally {
      await client.unsafe(`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
    }
    const journal = readJournal(migrationsFolder);
    log(`applied ${journal.entries.length} migration(s)`);
    return {
      serverVersionNum,
      migrationHash: migrationHash(migrationsFolder),
      migrations: journal.entries.length,
    };
  } finally {
    await client.end();
  }
}
