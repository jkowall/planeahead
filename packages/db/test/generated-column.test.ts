import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FLIGHT_KEY_RE, FlightKeySchema } from '@planeahead/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flightInstances } from '../src/schema/flights';
import { createMigratedDatabase, type TestDatabase } from './helpers';

/**
 * drizzle-kit 0.31 drops and recreates a changed generated column and does not recreate the
 * indexes Postgres cascades away (drizzle-orm issue 4929). The expression is frozen; this test
 * proves the unique index is present after migration, that the generated value is exactly what
 * `@planeahead/shared` parses (the client, the FlightTracker Durable Object name and the
 * resolver all agree on FLIGHT_KEY_RE), and that the schema and the committed migrations agree
 * (`drizzle-kit generate` has nothing to emit).
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

  it.each([
    ['AAL', '1', '2026-01-01', 'KJFK', 1, 'AAL-1-2026-01-01-KJFK'],
    ['AAL', '9999A', '2026-12-31', 'EGLL', 1, 'AAL-9999A-2026-12-31-EGLL'],
    ['BAW', '5A', '1903-12-17', 'EGLL', 12, 'BAW-5A-1903-12-17-EGLL-L12'],
    ['DLH', '400', '2028-02-29', 'EDDF', 2, 'DLH-400-2028-02-29-EDDF-L2'],
    ['UAE', '1', '2099-01-05', 'OMDB', 32767, 'UAE-1-2099-01-05-OMDB-L32767'],
    ['ASA', '65', '2026-10-01', '05AK', 1, 'ASA-65-2026-10-01-05AK'],
  ])(
    'generates %s %s %s %s leg %i as a key shared parses',
    async (carrier, number, date, origin, leg, expected) => {
      const [row] = await tdb.db
        .insert(flightInstances)
        .values({
          operatingCarrierIcao: carrier,
          flightNumber: number,
          scheduledDepartureDate: date,
          originIcao: origin,
          legSeq: leg,
        })
        .returning({ flightKey: flightInstances.flightKey });
      expect(row?.flightKey).toBe(expected);
      expect(FLIGHT_KEY_RE.test(row!.flightKey)).toBe(true);
      expect(FlightKeySchema.safeParse(row?.flightKey).success).toBe(true);
    },
  );
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
