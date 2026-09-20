import postgres from 'postgres';
import { describe, expect, inject, it } from 'vitest';

describe('test harness', () => {
  it('reaches a PostgreSQL 18 server through postgres.js with a UTC session', async () => {
    const url = inject('databaseUrl');
    expect(process.env['TEST_DATABASE_URL']).toBe(url);
    const sql = postgres(url, { max: 1, fetch_types: false, prepare: true });
    try {
      const [row] = await sql<{ version: string; num: string; offset: string }[]>`
        select version() as version, current_setting('server_version_num') as num,
               extract(timezone from now())::text as offset
      `;
      expect(row?.version).toMatch(/^PostgreSQL 18\./);
      expect(Number(row?.num)).toBeGreaterThanOrEqual(180000);
      // globalSetup refuses a server whose session zone is not at offset zero, whatever the
      // source of TEST_DATABASE_URL, so this is a restatement rather than the guard itself.
      expect(Number(row?.offset)).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
