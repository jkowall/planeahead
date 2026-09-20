import postgres from 'postgres';
import { describe, expect, inject, it } from 'vitest';

describe('test harness', () => {
  it('reaches a PostgreSQL 18 server through postgres.js', async () => {
    const url = inject('databaseUrl');
    expect(process.env['TEST_DATABASE_URL']).toBe(url);
    const sql = postgres(url, { max: 1, fetch_types: false, prepare: true });
    try {
      const [row] = await sql<{ version: string; num: string }[]>`
        select version() as version, current_setting('server_version_num') as num
      `;
      expect(row?.version).toMatch(/^PostgreSQL 18\./);
      expect(Number(row?.num)).toBeGreaterThanOrEqual(180000);
    } finally {
      await sql.end();
    }
  });
});
