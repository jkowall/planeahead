import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type TestDatabase } from './helpers';

/**
 * drizzle-kit 0.31 drops and recreates a changed generated column and does not recreate the
 * indexes Postgres cascades away (drizzle-orm issue 4929). The expression is frozen; this test
 * proves the unique index is present after migration and that the schema and the committed
 * migrations agree (`drizzle-kit generate` has nothing to emit).
 */

const PACKAGE_ROOT = resolve(import.meta.dirname, '..');

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createMigratedDatabase('generated');
});

afterAll(async () => {
  await tdb.drop();
});

describe('flight_instances.flight_key', () => {
  it('is a stored generated column with a unique index after migration', async () => {
    const [column] = await tdb.sql<{ attgenerated: string; expression: string }[]>`
      select a.attgenerated, pg_get_expr(d.adbin, d.adrelid) as expression
      from pg_attribute a
      join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = 'flight_instances'::regclass and a.attname = 'flight_key'
    `;
    expect(column?.attgenerated).toBe('s');
    expect(column?.expression).toContain('lpad');
    expect(column?.expression).toContain('leg_seq');
    const indexes = await tdb.sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_indexes
      where tablename = 'flight_instances' and indexname = 'flight_instances_flight_key_key'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexdef).toMatch(/^CREATE UNIQUE INDEX .* USING btree \(flight_key\)$/);
  });

  it('has no unique constraint on the generated column (Drizzle forbids one; the index is enough)', async () => {
    const constraints = await tdb.sql<{ conname: string }[]>`
      select conname from pg_constraint
      where conrelid = 'flight_instances'::regclass and contype = 'u'
    `;
    expect(constraints).toHaveLength(0);
  });
});

describe('schema and migrations agree', () => {
  it('drizzle-kit generate emits nothing and leaves the migrations folder unchanged', () => {
    const before = snapshotFolder();
    const output = execFileSync('pnpm', ['exec', 'drizzle-kit', 'generate'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toContain('No schema changes');
    expect(snapshotFolder()).toEqual(before);
  }, 60_000);

  it('drizzle-kit check finds the snapshots consistent', () => {
    const output = execFileSync('pnpm', ['exec', 'drizzle-kit', 'check'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(output).toContain("Everything's fine");
  }, 60_000);
});

function snapshotFolder(): Record<string, string> {
  const folder = resolve(PACKAGE_ROOT, 'migrations');
  const out: Record<string, string> = {};
  for (const name of readdirSync(folder).sort()) {
    if (name.endsWith('.sql')) {
      out[name] = readFileSync(resolve(folder, name), 'utf8');
    }
  }
  out['meta/_journal.json'] = readFileSync(resolve(folder, 'meta', '_journal.json'), 'utf8');
  for (const name of readdirSync(resolve(folder, 'meta')).sort()) {
    if (name.endsWith('_snapshot.json')) {
      out[`meta/${name}`] = readFileSync(resolve(folder, 'meta', name), 'utf8');
    }
  }
  return out;
}
