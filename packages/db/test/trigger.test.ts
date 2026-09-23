import { uuidv7 } from '@planeahead/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { originColumns, resolveAirportEndpoint } from '../src/queries/airports';
import { flightInstances } from '../src/schema/flights';
import { airports } from '../src/schema/reference';
import { createMigratedDatabase, type TestDatabase } from './helpers';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createMigratedDatabase('trigger');
});

afterAll(async () => {
  await tdb.drop();
});

async function insertAirport(icao: string): Promise<string> {
  const id = uuidv7();
  await tdb.db.insert(airports).values({
    id,
    ourairportsId: Math.floor(Math.random() * 1_000_000),
    ident: icao,
    icao,
    icaoSource: 'icao_code',
    name: `${icao} test`,
    type: 'small_airport',
    latitude: 0,
    longitude: 0,
    isoCountry: 'US',
    tz: 'UTC',
    tzSource: 'override',
  });
  return id;
}

describe('set_updated_at trigger', () => {
  it('bumps updated_at on a real UPDATE and leaves it alone on a no-op UPDATE', async () => {
    const id = await insertAirport('KTST');
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

  it('carries a no-op WHEN clause on every trigger; a table with a generated column names every other column in it', async () => {
    const rows = await tdb.sql<{ table_name: string; has_when: boolean; def: string }[]>`
      select c.relname as table_name, t.tgqual is not null as has_when,
             pg_get_triggerdef(t.oid) as def
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_proc p on p.oid = t.tgfoid
      where not t.tgisinternal and p.proname = 'set_updated_at'
    `;
    expect(rows.filter((r) => !r.has_when).map((r) => r.table_name)).toEqual([]);

    const generated = await tdb.sql<{ table_name: string }[]>`
      select distinct c.relname as table_name from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      where c.relnamespace = 'public'::regnamespace and a.attgenerated <> '' order by 1
    `;
    expect(generated.map((r) => r.table_name)).toEqual(['flight_instances']);

    for (const { table_name } of generated) {
      const def = rows.find((r) => r.table_name === table_name)?.def ?? '';
      expect(def).not.toContain('old.* IS DISTINCT FROM new.*');
      const columns = await tdb.sql<{ attname: string; attgenerated: string }[]>`
        select attname, attgenerated from pg_attribute
        where attrelid = ${table_name}::regclass and attnum > 0 and not attisdropped
      `;
      const missing = columns
        .filter((c) => c.attgenerated === '')
        .filter((c) => !def.includes(`old.${c.attname} IS DISTINCT FROM new.${c.attname}`))
        .map((c) => c.attname);
      // A column added to this table later must be added to the trigger in a new custom
      // migration (docs/schema-review.md section 12); this is the check that notices.
      expect(missing, `${table_name} trigger WHEN clause is missing columns`).toEqual([]);
      for (const c of columns.filter((c) => c.attgenerated !== '')) {
        expect(def).not.toContain(`new.${c.attname}`);
      }
    }
  });

  it('does not move flight_instances.updated_at on a byte-identical persist replay, and moves it on a real change', async () => {
    await insertAirport('KJFK');
    const origin = await resolveAirportEndpoint(tdb.db, 'KJFK');
    const row = {
      operatingCarrierIcao: 'AAL',
      flightNumber: '100',
      scheduledDepartureDate: '2026-09-19',
      ...originColumns(origin!),
      status: 'scheduled',
      originGate: 'B31',
      trackingState: 'tracking',
    };
    const replay = () =>
      tdb.db
        .insert(flightInstances)
        .values(row)
        .onConflictDoUpdate({
          target: flightInstances.flightKey,
          set: {
            status: sql`excluded.status`,
            originGate: sql`excluded.origin_gate`,
            trackingState: sql`excluded.tracking_state`,
          },
        })
        .returning({ updatedAt: flightInstances.updatedAt, flightKey: flightInstances.flightKey });
    const [first] = await replay();
    const stamps = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      await tdb.sql`select pg_sleep(0.005)`;
      const [again] = await replay();
      stamps.add(again!.updatedAt);
    }
    expect([...stamps]).toEqual([first!.updatedAt]);

    // A no-op UPDATE statement is equally silent.
    await tdb.db
      .update(flightInstances)
      .set({ status: 'scheduled' })
      .where(eq(flightInstances.flightKey, first!.flightKey));
    const [unchanged] = await tdb.db
      .select({ updatedAt: flightInstances.updatedAt })
      .from(flightInstances)
      .where(eq(flightInstances.flightKey, first!.flightKey));
    expect(unchanged?.updatedAt).toBe(first?.updatedAt);

    await tdb.sql`select pg_sleep(0.005)`;
    const [changed] = await tdb.db
      .insert(flightInstances)
      .values({ ...row, status: 'departed' })
      .onConflictDoUpdate({
        target: flightInstances.flightKey,
        set: { status: sql`excluded.status` },
      })
      .returning({ updatedAt: flightInstances.updatedAt, status: flightInstances.status });
    expect(changed?.status).toBe('departed');
    expect(new Date(changed!.updatedAt).getTime()).toBeGreaterThan(
      new Date(first!.updatedAt).getTime(),
    );
  });

  it('pins search_path on set_updated_at() and runs as the invoker', async () => {
    // proconfig is text[]; fetch_types is off, so read it through array_to_string.
    const [fn] = await tdb.sql<{ proconfig: string | null; prosecdef: boolean }[]>`
      select array_to_string(proconfig, '|') as proconfig, prosecdef
      from pg_proc where proname = 'set_updated_at'
    `;
    expect(fn?.proconfig).toBe('search_path=pg_catalog, public');
    expect(fn?.prosecdef).toBe(false);
  });
});
