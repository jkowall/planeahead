import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  MigrationTargetError,
  PostgresVersionError,
  assertMigrationUrl,
  migrateDatabase,
} from '../src/migrate';

/** A client that answers the version query with a fixed number and records every statement. */
function stubClient(serverVersionNum: number) {
  const statements: string[] = [];
  let ended = false;
  const client = {
    unsafe: (query: string) => {
      statements.push(query);
      return Promise.resolve([{ server_version_num: String(serverVersionNum) }]);
    },
    end: () => {
      ended = true;
      return Promise.resolve();
    },
  };
  return {
    client: client as unknown as Sql,
    statements,
    ended: () => ended,
  };
}

describe('migration target guard', () => {
  it('accepts a direct Neon endpoint', () => {
    const url = assertMigrationUrl('postgres://u:p@ep-cool-name-123456.us-east-1.aws.neon.tech/db');
    expect(url.hostname).toBe('ep-cool-name-123456.us-east-1.aws.neon.tech');
  });

  it('refuses a -pooler host', () => {
    expect(() =>
      assertMigrationUrl('postgres://u:p@ep-cool-name-123456-pooler.us-east-1.aws.neon.tech/db'),
    ).toThrow(MigrationTargetError);
  });

  it('refuses a non-postgres URL and a binding-shaped value', () => {
    expect(() => assertMigrationUrl('https://example.com/db')).toThrow(MigrationTargetError);
    expect(() => assertMigrationUrl('not a url')).toThrow(MigrationTargetError);
    expect(() => assertMigrationUrl('postgres:///db')).toThrow(MigrationTargetError);
  });
});

describe('PostgreSQL version guard', () => {
  it('refuses PG17 with a clear message before running any migration', async () => {
    const stub = stubClient(170006);
    await expect(
      migrateDatabase('postgres://u:p@db.example.test/planeahead', { connect: () => stub.client }),
    ).rejects.toThrow(PostgresVersionError);
    await expect(
      migrateDatabase('postgres://u:p@db.example.test/planeahead', { connect: () => stub.client }),
    ).rejects.toThrow(/PostgreSQL 17\.6 is not supported/);
    expect(stub.statements).toHaveLength(2);
    expect(stub.statements[0]).toContain('server_version_num');
    expect(stub.statements.some((s) => /advisory_lock|CREATE|create/.test(s))).toBe(false);
    expect(stub.ended()).toBe(true);
  });

  it('refuses every PG17 minor and accepts 18.0', async () => {
    for (const num of [170000, 170004, 179999]) {
      const stub = stubClient(num);
      await expect(
        migrateDatabase('postgres://u:p@db.example.test/planeahead', {
          connect: () => stub.client,
        }),
      ).rejects.toThrow(PostgresVersionError);
    }
    const ok = stubClient(180000);
    // 18.0 passes the guard; the stub then fails inside drizzle's migrator because it is not a
    // real client, which proves the guard was the only thing standing in the way.
    await expect(
      migrateDatabase('postgres://u:p@db.example.test/planeahead', { connect: () => ok.client }),
    ).rejects.not.toThrow(PostgresVersionError);
    expect(ok.statements[1]).toContain('pg_advisory_lock');
  });
});
