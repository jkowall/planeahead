/**
 * Airports from seed/data/airports.filtered.csv (OurAirports, filtered by the fetch script) with
 * timezones from mwgg/Airports (`tz_mwgg` column) and the curated airports.tz-overrides.json.
 *
 * The loader FAILS on an airport that ends up with no timezone: `scheduled_departure_date` is
 * origin-local and feeds the generated flight key, so a guessed zone would corrupt keys. The
 * only way past that rule is airports.tz-rejected.json, an explicit list of airports the
 * curation step could not resolve; those are skipped with a warning and counted.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidTimeZone } from '@planeahead/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { airports } from '../schema/reference';
import { BATCH_SIZE, SEED_DATA_DIR, count, type SeedOptions, type SeedResult } from './common';
import { chunk, column, optional, optionalInt, parseCsvRecords } from './csv';

export interface TzOverride {
  readonly tz: string;
  readonly source?: string;
  readonly note?: string;
}

export interface TzOverridesFile {
  readonly entries: Readonly<Record<string, TzOverride>>;
}

export interface TzRejectedFile {
  readonly entries: readonly { readonly icao: string; readonly reason: string }[];
}

export class MissingTimezoneError extends Error {
  override readonly name = 'MissingTimezoneError';
}

async function readJsonIfPresent<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function seedAirports(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const dataDir = options.dataDir ?? SEED_DATA_DIR;
  const log = options.log ?? (() => undefined);
  const records = parseCsvRecords(await readFile(join(dataDir, 'airports.filtered.csv'), 'utf8'));
  const overrides =
    (await readJsonIfPresent<TzOverridesFile>(join(dataDir, 'airports.tz-overrides.json')))
      ?.entries ?? {};
  const rejected = new Map(
    (
      (await readJsonIfPresent<TzRejectedFile>(join(dataDir, 'airports.tz-rejected.json')))
        ?.entries ?? []
    ).map((entry) => [entry.icao, entry.reason]),
  );

  const skipped: Record<string, number> = {};
  const seen = new Map<string, string>();
  const rows: (typeof airports.$inferInsert)[] = [];
  for (const record of records) {
    const ident = column(record, 'ident');
    const icaoCode = column(record, 'icao_code');
    const icao = icaoCode !== '' ? icaoCode : ident;
    const duplicateOf = seen.get(icao);
    if (duplicateOf !== undefined) {
      throw new Error(`airports: ${icao} is claimed by both ${duplicateOf} and ${ident}`);
    }
    seen.set(icao, ident);

    const tzMwgg = column(record, 'tz_mwgg');
    const override = overrides[icao];
    const tz = tzMwgg !== '' ? tzMwgg : (override?.tz ?? null);
    if (tz === null) {
      const reason = rejected.get(icao);
      if (reason === undefined) {
        throw new MissingTimezoneError(
          `airports: ${icao} (${column(record, 'name')}, ${column(record, 'iso_country')}) has no timezone; ` +
            'add it to airports.tz-overrides.json or list it in airports.tz-rejected.json',
        );
      }
      log(
        `WARNING airports: skipping ${icao} (${column(record, 'name')}): no timezone, rejected: ${reason}`,
      );
      count(skipped, 'rejected_no_timezone');
      continue;
    }
    if (!isValidTimeZone(tz)) {
      throw new MissingTimezoneError(`airports: ${icao} has an invalid IANA timezone "${tz}"`);
    }
    if (!/^[A-Z0-9-]{3,8}$/.test(icao)) {
      count(skipped, 'icao_unusable');
      continue;
    }
    if (icaoCode === '' && !/^[A-Z0-9]{4}$/.test(icao)) {
      count(skipped, 'ident_not_icao_shaped_kept');
    }
    const iata = optional(column(record, 'iata_code'));
    rows.push({
      ourairportsId: Number(column(record, 'id')),
      ident,
      icao,
      icaoSource: icaoCode !== '' ? 'icao_code' : 'ident',
      iata,
      gpsCode: optional(column(record, 'gps_code')),
      localCode: optional(column(record, 'local_code')),
      name: column(record, 'name'),
      type: column(record, 'type'),
      latitude: Number(column(record, 'latitude_deg')),
      longitude: Number(column(record, 'longitude_deg')),
      elevationFt: optionalInt(column(record, 'elevation_ft')),
      continent: optional(column(record, 'continent')),
      isoCountry: column(record, 'iso_country'),
      isoRegion: optional(column(record, 'iso_region')),
      municipality: optional(column(record, 'municipality')),
      scheduledService: column(record, 'scheduled_service') === 'yes',
      tz,
      tzSource: tzMwgg !== '' ? 'mwgg' : 'override',
    });
  }

  let upserted = 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await db
      .insert(airports)
      .values(batch)
      .onConflictDoUpdate({
        target: airports.icao,
        set: {
          ourairportsId: sql`excluded.ourairports_id`,
          ident: sql`excluded.ident`,
          icaoSource: sql`excluded.icao_source`,
          iata: sql`excluded.iata`,
          gpsCode: sql`excluded.gps_code`,
          localCode: sql`excluded.local_code`,
          name: sql`excluded.name`,
          type: sql`excluded.type`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          elevationFt: sql`excluded.elevation_ft`,
          continent: sql`excluded.continent`,
          isoCountry: sql`excluded.iso_country`,
          isoRegion: sql`excluded.iso_region`,
          municipality: sql`excluded.municipality`,
          scheduledService: sql`excluded.scheduled_service`,
          tz: sql`excluded.tz`,
          tzSource: sql`excluded.tz_source`,
        },
      });
    upserted += batch.length;
  }
  log(`airports: read ${records.length}, upserted ${upserted}, skipped ${JSON.stringify(skipped)}`);
  return { read: records.length, upserted, skipped };
}
