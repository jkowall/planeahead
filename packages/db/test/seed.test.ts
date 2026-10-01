import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REGIONAL_OPERATOR_SEED } from '@planeahead/shared';
import { eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  originColumns,
  resolveAirportEndpoint,
  resolveBoardAirport,
} from '../src/queries/airports';
import * as schema from '../src/schema/index';
import {
  MissingTimezoneError,
  SEED_DATA_DIR,
  SeedCollisionError,
  normaliseAlliance,
  seedAirports,
  seedAll,
  type SeedReport,
} from '../src/seed/index';
import { createMigratedDatabase, sqlState, type TestDatabase } from './helpers';

let tdb: TestDatabase;
let first: SeedReport;
const warnings: string[] = [];

beforeAll(async () => {
  tdb = await createMigratedDatabase('seed');
  first = await seedAll(tdb.db, {
    log: (line) => {
      if (line.startsWith('WARNING')) {
        warnings.push(line);
      }
    },
  });
}, 120_000);

afterAll(async () => {
  await tdb.drop();
});

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [name, table] of Object.entries({
    airports: schema.airports,
    airlines: schema.airlines,
    aircraftTypes: schema.aircraftTypes,
    regionalOperators: schema.regionalOperators,
  })) {
    const [row] = await tdb.db.select({ n: sql<number>`count(*)::int` }).from(table);
    out[name] = row?.n ?? -1;
  }
  return out;
}

describe('seed loaders', () => {
  it('load the committed reference data', async () => {
    const c = await counts();
    expect(first.airports.upserted).toBe(c['airports']);
    expect(c['airports']).toBeGreaterThan(6000);
    expect(first.airlines.upserted).toBe(c['airlines']);
    expect(c['airlines']).toBeGreaterThan(5000);
    expect(first.aircraftTypes.upserted).toBe(c['aircraftTypes']);
    expect(c['aircraftTypes']).toBeGreaterThan(2500);
    expect(c['regionalOperators']).toBe(REGIONAL_OPERATOR_SEED.length);
  });

  it('are idempotent: a second run changes no row counts and no rows', async () => {
    const before = await counts();
    const [beforeStamp] = await tdb.sql<
      { max: string }[]
    >`select max(updated_at)::text as max from airports`;
    const second = await seedAll(tdb.db);
    expect(second.airports.upserted).toBe(first.airports.upserted);
    expect(second.airlines.upserted).toBe(first.airlines.upserted);
    expect(second.aircraftTypes.upserted).toBe(first.aircraftTypes.upserted);
    expect(second.regionalOperators.upserted).toBe(first.regionalOperators.upserted);
    expect(await counts()).toEqual(before);
    // The updated_at trigger's WHEN clause means an identical upsert is a no-op.
    const [afterStamp] = await tdb.sql<
      { max: string }[]
    >`select max(updated_at)::text as max from airports`;
    expect(afterStamp?.max).toBe(beforeStamp?.max);
  }, 120_000);

  it('never writes an airport without a timezone and records where each tz came from', async () => {
    const [nulls] = await tdb.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.airports)
      .where(isNull(schema.airports.tz));
    expect(nulls?.n).toBe(0);
    const sources = await tdb.db
      .select({ source: schema.airports.tzSource, n: sql<number>`count(*)::int` })
      .from(schema.airports)
      .groupBy(schema.airports.tzSource);
    const bySource = Object.fromEntries(sources.map((r) => [r.source, r.n]));
    expect(bySource['mwgg']).toBeGreaterThan(5000);
    expect(bySource['override']).toBeGreaterThan(500);
    // The five airports the curation step rejected are skipped loudly, not guessed.
    expect(first.airports.skipped['rejected_no_timezone']).toBe(5);
    expect(warnings.filter((w) => w.includes('rejected')).length).toBe(5);
  });

  it('patched wake turbulence J on exactly the designators ColtJD45 lists as J', async () => {
    const rows = await tdb.db
      .select({ icao: schema.aircraftTypes.icao, source: schema.aircraftTypes.wakeSource })
      .from(schema.aircraftTypes)
      .where(eq(schema.aircraftTypes.wakeTurbulence, 'J'));
    expect(rows).toEqual([{ icao: 'A388', source: 'coltjd45' }]);
    const manifest = JSON.parse(await readFile(join(SEED_DATA_DIR, 'MANIFEST.json'), 'utf8')) as {
      outputs: Record<string, { patched_j?: number; patched_j_designators?: string[] }>;
    };
    expect(manifest.outputs['aircraft-types.csv']?.patched_j).toBe(rows.length);
    expect(manifest.outputs['aircraft-types.csv']?.patched_j_designators).toEqual(
      rows.map((r) => r.icao),
    );
    // ColtJD45 does not list the An-225 at all and has the An-124 as H, so both keep VRS's H.
    const heavies = await tdb.db
      .select({ icao: schema.aircraftTypes.icao, wake: schema.aircraftTypes.wakeTurbulence })
      .from(schema.aircraftTypes)
      .where(sql`${schema.aircraftTypes.icao} in ('A225', 'A124')`);
    expect(heavies.map((r) => r.wake)).toEqual(['H', 'H']);
  });

  it('spot-checks known airports, airlines and aircraft types', async () => {
    const [jfk] = await tdb.db
      .select()
      .from(schema.airports)
      .where(eq(schema.airports.icao, 'KJFK'));
    expect(jfk?.iata).toBe('JFK');
    expect(jfk?.tz).toBe('America/New_York');
    expect(jfk?.icaoSource).toBe('icao_code');
    const [lhr] = await tdb.db
      .select()
      .from(schema.airports)
      .where(eq(schema.airports.icao, 'EGLL'));
    expect(lhr?.tz).toBe('Europe/London');
    const [rpa] = await tdb.db
      .select()
      .from(schema.airlines)
      .where(eq(schema.airlines.icao, 'RPA'));
    expect(rpa?.name).toMatch(/Republic/);
    const [aal] = await tdb.db
      .select()
      .from(schema.airlines)
      .where(eq(schema.airlines.icao, 'AAL'));
    expect(aal?.iata).toBe('AA');
    expect(aal?.alliance).toBe('oneworld');
    const [a388] = await tdb.db
      .select()
      .from(schema.aircraftTypes)
      .where(eq(schema.aircraftTypes.icao, 'A388'));
    expect(a388?.wakeTurbulence).toBe('J');
    expect(a388?.wakeSource).toBe('coltjd45');
    const [b738] = await tdb.db
      .select()
      .from(schema.aircraftTypes)
      .where(eq(schema.aircraftTypes.icao, 'B738'));
    expect(b738?.wakeTurbulence).toBe('M');
    const fake = await tdb.db
      .select()
      .from(schema.aircraftTypes)
      .where(eq(schema.aircraftTypes.icao, '-GND'));
    expect(fake).toHaveLength(0);
    const [hint] = await tdb.db
      .select()
      .from(schema.regionalOperators)
      .where(eq(schema.regionalOperators.numberFrom, 4700));
    expect(hint?.operatingIcao).toBe('PDT');
    expect(hint?.confidence).toBe('hint');
    expect(hint?.sourceConfidence).toBe('published');
  });

  it('normalises dirty OPTD alliance names', () => {
    expect(normaliseAlliance('OneWorld')).toBe('oneworld');
    expect(normaliseAlliance('Oneworld')).toBe('oneworld');
    expect(normaliseAlliance('SkyTeam')).toBe('skyteam');
    expect(normaliseAlliance('Star Alliance')).toBe('star_alliance');
    expect(normaliseAlliance('2018-01-02')).toBeNull();
    expect(normaliseAlliance('')).toBeNull();
  });

  it('fails loudly on an airport with no timezone that is not explicitly rejected', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'planeahead-seed-'));
    const header = (await readFile(join(SEED_DATA_DIR, 'airports.filtered.csv'), 'utf8')).split(
      '\n',
    )[0];
    await writeFile(
      join(dir, 'airports.filtered.csv'),
      `${header}\n1,XXXX,small_airport,No Zone,0,0,,OC,ZZ,,,yes,XXXX,,,,\n`,
    );
    await expect(seedAirports(tdb.db, { dataDir: dir })).rejects.toThrow(MissingTimezoneError);
  });

  it('pins the ident-derived airports the flight origin check excludes (schema-review section 16)', async () => {
    const [counts] = await tdb.sql<
      { non_four: number; non_four_scheduled: number; four_char: number; total_ident: number }[]
    >`
      select
        count(*) filter (where icao_source = 'ident' and icao !~ '^[A-Z0-9]{4}$')::int as non_four,
        count(*) filter (where icao_source = 'ident' and icao !~ '^[A-Z0-9]{4}$' and scheduled_service)::int as non_four_scheduled,
        count(*) filter (where icao_source = 'ident' and icao ~ '^[A-Z0-9]{4}$')::int as four_char,
        count(*) filter (where icao_source = 'ident')::int as total_ident
      from airports
    `;
    // These numbers are quoted in docs/schema-review.md section 16; a seed refresh that moves
    // them must update the document too.
    expect(counts).toEqual({
      non_four: 426,
      non_four_scheduled: 181,
      four_char: 403,
      total_ident: 829,
    });
    expect(first.airports.skipped['ident_not_icao_shaped_kept']).toBe(426);

    // A scheduled-service airport with a three-character ident is searchable but cannot be a
    // flight origin: the strict origin check rejects it, so POST /v1/flights must refuse such
    // an origin with a clear error rather than surface SQLSTATE 23514.
    const utirik = await resolveAirportEndpoint(tdb.db, '03N');
    expect(utirik?.tz).toBe('Pacific/Majuro');
    await expect(
      tdb.db.insert(schema.flightInstances).values({
        operatingCarrierIcao: 'ASA',
        flightNumber: '1234',
        scheduledDepartureDate: '2026-10-01',
        ...originColumns(utirik!),
      }),
    ).rejects.toSatisfy((error) => sqlState(error) === '23514');

    // A four-character ident-derived code passes the origin check although the facts sheet
    // says it will not resolve against AeroAPI: the check is on shape, not provenance (the
    // asymmetry section 16 records).
    const [fourChar] = await tdb.sql<{ icao: string }[]>`
      select icao from airports where icao_source = 'ident' and icao ~ '^[A-Z0-9]{4}$'
      order by icao limit 1
    `;
    const pseudo = await resolveAirportEndpoint(tdb.db, fourChar!.icao);
    const [accepted] = await tdb.db
      .insert(schema.flightInstances)
      .values({
        operatingCarrierIcao: 'ASA',
        flightNumber: '1235',
        scheduledDepartureDate: '2026-10-01',
        ...originColumns(pseudo!),
      })
      .returning({ flightKey: schema.flightInstances.flightKey });
    expect(accepted?.flightKey).toBe(`ASA-1235-2026-10-01-${fourChar!.icao}`);

    // A synthetic ZZxx code (shared SYNTHETIC_ICAO_RE) already satisfies the origin check, so
    // assigning one is a seed-data decision, not a schema change.
    const [synthetic] = await tdb.db
      .insert(schema.flightInstances)
      .values({
        operatingCarrierIcao: 'ASA',
        flightNumber: '1236',
        scheduledDepartureDate: '2026-10-01',
        originIcao: 'ZZ01',
      })
      .returning({ flightKey: schema.flightInstances.flightKey });
    expect(synthetic?.flightKey).toBe('ASA-1236-2026-10-01-ZZ01');
    await tdb.db.delete(schema.flightInstances);
  });

  it('resolves a board airport by ICAO or IATA, only when it has a real ICAO code (increment 18)', async () => {
    expect(await resolveBoardAirport(tdb.db, 'kjfk')).toMatchObject({
      icao: 'KJFK',
      iata: 'JFK',
      tz: 'America/New_York',
    });
    expect((await resolveBoardAirport(tdb.db, 'LHR'))?.icao).toBe('EGLL');
    expect((await resolveBoardAirport(tdb.db, ' atl '))?.icao).toBe('KATL');
    const [fourChar] = await tdb.sql<{ icao: string }[]>`
      select icao from airports where icao_source = 'ident' and icao ~ '^[A-Z0-9]{4}$'
      order by icao limit 1
    `;
    // An ident-derived pseudo code exists for display but cannot be asked of FIDS.
    expect(await resolveAirportEndpoint(tdb.db, fourChar!.icao)).not.toBeNull();
    expect(await resolveBoardAirport(tdb.db, fourChar!.icao)).toBeNull();
    expect(await resolveBoardAirport(tdb.db, '03N')).toBeNull();
    expect(await resolveBoardAirport(tdb.db, 'ZZZZ')).toBeNull();
    expect(await resolveBoardAirport(tdb.db, 'NYC')).toBeNull();
    expect(await resolveBoardAirport(tdb.db, 'K')).toBeNull();
  });

  it('refuses a refresh where two source rows claim one ident, before writing anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'planeahead-seed-'));
    const header = (await readFile(join(SEED_DATA_DIR, 'airports.filtered.csv'), 'utf8')).split(
      '\n',
    )[0];
    await writeFile(
      join(dir, 'airports.filtered.csv'),
      [
        header,
        '9000001,QQQ1,small_airport,First,0,0,,OC,ZZ,,,yes,QQA1,,,,UTC',
        '9000002,QQQ1,small_airport,Second,0,0,,OC,ZZ,,,yes,QQA2,,,,UTC',
        '',
      ].join('\n'),
    );
    const failure = await seedAirports(tdb.db, { dataDir: dir }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SeedCollisionError);
    expect((failure as SeedCollisionError).column).toBe('ident');
    expect((failure as Error).message).toContain('9000001 (QQQ1)');
    expect((failure as Error).message).toContain('9000002 (QQQ1)');
    const [written] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from airports where icao in ('QQA1', 'QQA2')
    `;
    expect(written?.n).toBe(0);
  });

  it('loads all or nothing: a bad row in the second batch rolls the first batch back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'planeahead-seed-'));
    const header = (await readFile(join(SEED_DATA_DIR, 'airports.filtered.csv'), 'utf8')).split(
      '\n',
    )[0];
    const rows = Array.from({ length: 501 }, (_, i) => {
      const code = `Q${i.toString(36).toUpperCase().padStart(3, '0')}`;
      const type = i === 500 ? 'spaceport' : 'small_airport';
      return `${9_100_000 + i},${code},${type},Batch ${i},0,0,,OC,ZZ,,,yes,${code},,,,UTC`;
    });
    await writeFile(join(dir, 'airports.filtered.csv'), [header, ...rows, ''].join('\n'));
    await expect(seedAirports(tdb.db, { dataDir: dir })).rejects.toSatisfy(
      (error) => sqlState(error) === '23514',
    );
    const [written] = await tdb.sql<{ n: number }[]>`
      select count(*)::int as n from airports where ourairports_id >= 9100000
    `;
    expect(written?.n).toBe(0);
  });

  it('has a manifest that lists every committed file with its row count', async () => {
    const manifest = JSON.parse(await readFile(join(SEED_DATA_DIR, 'MANIFEST.json'), 'utf8')) as {
      sources: Record<
        string,
        { status: string; sha256?: string; bytes?: number; content_length?: number }
      >;
      outputs: Record<string, { rows: number; bytes: number; sha256: string }>;
    };
    for (const [id, source] of Object.entries(manifest.sources)) {
      expect(source.status, id).toBe('fetched');
      expect(source.bytes, id).toBe(source.content_length);
      expect(source.sha256, id).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(manifest.outputs['airports.filtered.csv']?.rows).toBe(first.airports.read);
    expect(manifest.outputs['airlines.csv']?.rows).toBe(first.airlines.read);
    expect(manifest.outputs['aircraft-types.csv']?.rows).toBe(first.aircraftTypes.read);
    for (const [name, output] of Object.entries(manifest.outputs)) {
      expect(output.bytes, name).toBeLessThan(3 * 1024 * 1024);
      const bytes = await readFile(join(SEED_DATA_DIR, name));
      expect(bytes.byteLength, name).toBe(output.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(output.sha256);
    }
  });
});
