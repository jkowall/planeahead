import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REGIONAL_OPERATOR_SEED } from '@planeahead/shared';
import { eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index';
import {
  MissingTimezoneError,
  SEED_DATA_DIR,
  normaliseAlliance,
  seedAirports,
  seedAll,
  type SeedReport,
} from '../src/seed/index';
import { createMigratedDatabase, type TestDatabase } from './helpers';

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
