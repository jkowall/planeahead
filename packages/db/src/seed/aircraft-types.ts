/**
 * Aircraft types from seed/data/aircraft-types.csv: vradarserver model-type CSVs deduped on
 * ICAO preferring IsActive, fake `-` designators dropped, wake turbulence J patched from
 * ColtJD45 (all done by the fetch script; this loader only validates and upserts).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { WAKE_TURBULENCE_CATEGORIES, aircraftTypes } from '../schema/reference';
import { BATCH_SIZE, SEED_DATA_DIR, count, type SeedOptions, type SeedResult } from './common';
import { chunk, column, optional, parseCsvRecords } from './csv';

const WAKE = new Set<string>(WAKE_TURBULENCE_CATEGORIES);

export async function seedAircraftTypes(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const dataDir = options.dataDir ?? SEED_DATA_DIR;
  const log = options.log ?? (() => undefined);
  const records = parseCsvRecords(await readFile(join(dataDir, 'aircraft-types.csv'), 'utf8'));
  const skipped: Record<string, number> = {};
  const rows: (typeof aircraftTypes.$inferInsert)[] = [];
  for (const record of records) {
    const icao = column(record, 'icao').trim();
    if (icao === '' || icao.startsWith('-')) {
      count(skipped, 'fake_designator');
      continue;
    }
    const wake = optional(column(record, 'wake_turbulence'));
    if (wake !== null && !WAKE.has(wake)) {
      throw new Error(`aircraft_types: ${icao} has an unknown wake turbulence category "${wake}"`);
    }
    rows.push({
      icao,
      manufacturer: optional(column(record, 'manufacturer')),
      model: column(record, 'model'),
      engines: optional(column(record, 'engines')),
      engineTypeCode: optional(column(record, 'engine_type_code')),
      enginePlacementCode: optional(column(record, 'engine_placement_code')),
      speciesCode: optional(column(record, 'species_code')),
      wakeTurbulence: wake,
      wakeSource: wake === null ? null : optional(column(record, 'wake_source')),
      isActive: column(record, 'is_active') === '1',
    });
  }
  let upserted = 0;
  await db.transaction(async (tx) => {
    for (const batch of chunk(rows, BATCH_SIZE)) {
      await tx
        .insert(aircraftTypes)
        .values(batch)
        .onConflictDoUpdate({
          target: aircraftTypes.icao,
          set: {
            manufacturer: sql`excluded.manufacturer`,
            model: sql`excluded.model`,
            engines: sql`excluded.engines`,
            engineTypeCode: sql`excluded.engine_type_code`,
            enginePlacementCode: sql`excluded.engine_placement_code`,
            speciesCode: sql`excluded.species_code`,
            wakeTurbulence: sql`excluded.wake_turbulence`,
            wakeSource: sql`excluded.wake_source`,
            isActive: sql`excluded.is_active`,
          },
        });
      upserted += batch.length;
    }
  });
  log(
    `aircraft_types: read ${records.length}, upserted ${upserted}, skipped ${JSON.stringify(skipped)}`,
  );
  return { read: records.length, upserted, skipped };
}
