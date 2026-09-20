import { uuidv7 } from '@planeahead/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { airports } from '../src/schema/reference';
import { createMigratedDatabase, type TestDatabase } from './helpers';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createMigratedDatabase('trigger');
});

afterAll(async () => {
  await tdb.drop();
});

describe('set_updated_at trigger', () => {
  it('bumps updated_at on a real UPDATE and leaves it alone on a no-op UPDATE', async () => {
    const id = uuidv7();
    await tdb.db.insert(airports).values({
      id,
      ourairportsId: 1,
      ident: 'KTST',
      icao: 'KTST',
      icaoSource: 'icao_code',
      name: 'Test',
      type: 'small_airport',
      latitude: 0,
      longitude: 0,
      isoCountry: 'US',
      tz: 'UTC',
      tzSource: 'override',
    });
    const [inserted] = await tdb.db.select().from(airports).where(eq(airports.id, id));
    expect(inserted?.updatedAt).toBe(inserted?.createdAt);

    await tdb.sql`select pg_sleep(0.02)`;
    await tdb.db.update(airports).set({ name: 'Renamed' }).where(eq(airports.id, id));
    const [renamed] = await tdb.db.select().from(airports).where(eq(airports.id, id));
    expect(renamed?.name).toBe('Renamed');
    expect(new Date(renamed!.updatedAt).getTime()).toBeGreaterThan(
      new Date(inserted!.updatedAt).getTime(),
    );

    // An UPDATE that changes nothing does not touch updated_at (WHEN clause).
    await tdb.db.update(airports).set({ name: 'Renamed' }).where(eq(airports.id, id));
    const [same] = await tdb.db.select().from(airports).where(eq(airports.id, id));
    expect(same?.updatedAt).toBe(renamed?.updatedAt);

    // An explicit updated_at in the UPDATE is overridden by the trigger.
    await tdb.db
      .update(airports)
      .set({ name: 'Renamed twice', updatedAt: '2000-01-01T00:00:00Z' })
      .where(eq(airports.id, id));
    const [overridden] = await tdb.db.select().from(airports).where(eq(airports.id, id));
    expect(new Date(overridden!.updatedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it('is attached to every table that has an updated_at column, and only those', async () => {
    const withColumn = await tdb.sql<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'updated_at' order by table_name
    `;
    const withTrigger = await tdb.sql<{ table_name: string }[]>`
      select c.relname as table_name from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and p.proname = 'set_updated_at' order by c.relname
    `;
    expect(withTrigger.map((r) => r.table_name)).toEqual(withColumn.map((r) => r.table_name));
    expect(withColumn.length).toBe(45);
  });

  it('carries the no-op WHEN clause everywhere except on the table with a generated column', async () => {
    const rows = await tdb.sql<{ table_name: string; has_when: boolean }[]>`
      select c.relname as table_name, t.tgqual is not null as has_when from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and p.proname = 'set_updated_at'
    `;
    const without = rows.filter((r) => !r.has_when).map((r) => r.table_name);
    expect(without).toEqual(['flight_instances']);
  });
});
