import { getTableName } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index';
import { createMigratedDatabase, type TestDatabase } from './helpers';

/**
 * Better Auth 1.7.5's runtime validateSchema throws SchemaMismatchError for a column on its
 * tables that is NOT NULL, has no default, and it does not write. This test reads
 * information_schema and proves every PlaneAhead-owned extra is nullable or defaulted, and that
 * the columns Better Auth requires exist with the expected shapes.
 */

const REQUIRED: Record<string, Record<string, string>> = {
  users: {
    id: 'uuid',
    name: 'text',
    email: 'text',
    email_verified: 'boolean',
    image: 'text',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
    is_anonymous: 'boolean',
  },
  sessions: {
    id: 'uuid',
    expires_at: 'timestamp with time zone',
    token: 'text',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
    ip_address: 'text',
    user_agent: 'text',
    user_id: 'uuid',
  },
  accounts: {
    id: 'uuid',
    account_id: 'text',
    provider_id: 'text',
    user_id: 'uuid',
    access_token: 'text',
    refresh_token: 'text',
    id_token: 'text',
    access_token_expires_at: 'timestamp with time zone',
    refresh_token_expires_at: 'timestamp with time zone',
    scope: 'text',
    password: 'text',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
  },
  verifications: {
    id: 'uuid',
    identifier: 'text',
    value: 'text',
    expires_at: 'timestamp with time zone',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
  },
  rate_limits: { id: 'uuid', key: 'text', count: 'integer', last_request: 'bigint' },
};

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
}

let tdb: TestDatabase;
let columns: ColumnRow[];

beforeAll(async () => {
  tdb = await createMigratedDatabase('betterauth');
  columns = await tdb.sql<ColumnRow[]>`
    select table_name, column_name, data_type, is_nullable, column_default
    from information_schema.columns
    where table_schema = 'public' and table_name in ('users', 'sessions', 'accounts', 'verifications', 'rate_limits')
  `;
});

afterAll(async () => {
  await tdb.drop();
});

describe('Better Auth tables', () => {
  it('exports exactly the five keys Better Auth addresses with usePlural', () => {
    expect(schema.users).toBeDefined();
    expect(schema.sessions).toBeDefined();
    expect(schema.accounts).toBeDefined();
    expect(schema.verifications).toBeDefined();
    expect(schema.rateLimits).toBeDefined();
    expect(getTableName(schema.rateLimits)).toBe('rate_limits');
  });

  it.each(Object.keys(REQUIRED))('%s has every required column with the expected type', (table) => {
    const present = new Map(
      columns.filter((c) => c.table_name === table).map((c) => [c.column_name, c.data_type]),
    );
    for (const [name, type] of Object.entries(REQUIRED[table] ?? {})) {
      expect(present.get(name), `${table}.${name}`).toBe(type);
    }
  });

  it('has no issuer column on accounts (dropped in 1.7.5)', () => {
    expect(columns.some((c) => c.table_name === 'accounts' && c.column_name === 'issuer')).toBe(
      false,
    );
  });

  it.each(Object.keys(REQUIRED))('%s: every extra column is nullable or has a default', (table) => {
    const required = new Set(Object.keys(REQUIRED[table] ?? {}));
    const offenders = columns
      .filter((c) => c.table_name === table && !required.has(c.column_name))
      .filter((c) => c.is_nullable === 'NO' && c.column_default === null)
      .map((c) => c.column_name);
    expect(offenders).toEqual([]);
  });

  it('gives id a uuidv7() default on every table so Better Auth can omit it', () => {
    for (const table of Object.keys(REQUIRED)) {
      const id = columns.find((c) => c.table_name === table && c.column_name === 'id');
      expect(id?.column_default, table).toBe('uuidv7()');
    }
  });

  it('keeps sessions.token as plaintext unique text (documented exception)', async () => {
    const indexes = await tdb.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'sessions' and indexname = 'sessions_token_key'
    `;
    expect(indexes[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(token\)$/);
  });

  it('enforces unique email case-insensitively', async () => {
    const indexes = await tdb.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'users' and indexname = 'users_email_key'
    `;
    expect(indexes[0]?.indexdef).toMatch(/UNIQUE INDEX .* \(lower\(email\)\)$/);
  });
});
