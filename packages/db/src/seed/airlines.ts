/**
 * Airlines: vradarserver standing-data airlines.csv is the spine (CC0, has the right ICAO for
 * Republic Airways); OPTD (CC BY 4.0) is left-joined on ICAO for alliance and validity dates.
 * OPTD alliance names are dirty (`OneWorld` and `Oneworld`, one row with a date as the code), so
 * they are normalised and anything unknown becomes null.
 *
 * `vrs_code` is unique in the table while the upsert conflicts on `icao`, so the loader checks
 * it across the source rows before writing and loads inside one transaction.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { airlines } from '../schema/reference';
import {
  BATCH_SIZE,
  SEED_DATA_DIR,
  UniqueTracker,
  count,
  type SeedOptions,
  type SeedResult,
} from './common';
import { chunk, column, optional, parseCsvRecords } from './csv';

const ALLIANCES: Readonly<Record<string, string>> = {
  oneworld: 'oneworld',
  skyteam: 'skyteam',
  staralliance: 'star_alliance',
};
const ALLIANCE_STATUSES = new Set(['member', 'affiliate', 'former', 'future']);

export function normaliseAlliance(raw: string): string | null {
  const key = raw.toLowerCase().replace(/[^a-z]/g, '');
  return key === '' ? null : (ALLIANCES[key] ?? null);
}

export function normaliseAllianceStatus(raw: string): string | null {
  const key = raw.toLowerCase().trim();
  return ALLIANCE_STATUSES.has(key) ? key : null;
}

interface OptdRow {
  pk: string;
  validFrom: string | null;
  validTo: string | null;
  alliance: string | null;
  allianceStatus: string | null;
}

/** One OPTD row per ICAO: prefer the row still valid (no validity_to), then the latest start. */
function pickOptd(rows: readonly OptdRow[]): OptdRow | undefined {
  return [...rows].sort((a, b) => {
    const openA = a.validTo === null ? 0 : 1;
    const openB = b.validTo === null ? 0 : 1;
    if (openA !== openB) {
      return openA - openB;
    }
    return (b.validFrom ?? '').localeCompare(a.validFrom ?? '');
  })[0];
}

export async function seedAirlines(db: Db, options: SeedOptions = {}): Promise<SeedResult> {
  const dataDir = options.dataDir ?? SEED_DATA_DIR;
  const log = options.log ?? (() => undefined);
  const spine = parseCsvRecords(await readFile(join(dataDir, 'airlines.csv'), 'utf8'));
  const optd = parseCsvRecords(await readFile(join(dataDir, 'optd_airlines.subset.csv'), 'utf8'));

  const optdByIcao = new Map<string, OptdRow[]>();
  const skipped: Record<string, number> = {};
  for (const record of optd) {
    const icao = column(record, '3char_code');
    if (icao === '') {
      continue;
    }
    const allianceRaw = column(record, 'alliance_code');
    const alliance = normaliseAlliance(allianceRaw);
    if (allianceRaw !== '' && alliance === null) {
      count(skipped, 'optd_alliance_unrecognised');
    }
    const list = optdByIcao.get(icao) ?? [];
    list.push({
      pk: column(record, 'pk'),
      validFrom: optional(column(record, 'validity_from')),
      validTo: optional(column(record, 'validity_to')),
      alliance,
      allianceStatus: normaliseAllianceStatus(column(record, 'alliance_status')),
    });
    optdByIcao.set(icao, list);
  }

  const seen = new Set<string>();
  const uniqueVrsCode = new UniqueTracker('airlines', 'vrs_code');
  const rows: (typeof airlines.$inferInsert)[] = [];
  for (const record of spine) {
    const icao = column(record, 'ICAO').trim().toUpperCase();
    if (icao === '') {
      count(skipped, 'no_icao');
      continue;
    }
    if (!/^[A-Z]{3}$/.test(icao)) {
      count(skipped, 'icao_not_three_letters');
      continue;
    }
    if (seen.has(icao)) {
      count(skipped, 'duplicate_icao');
      continue;
    }
    seen.add(icao);
    uniqueVrsCode.claim(column(record, 'Code'), `Code ${column(record, 'Code')} (${icao})`);
    const picked = pickOptd(optdByIcao.get(icao) ?? []);
    rows.push({
      icao,
      iata: optional(column(record, 'IATA').trim().toUpperCase()),
      vrsCode: column(record, 'Code'),
      name: column(record, 'Name'),
      positioningFlightPattern: optional(column(record, 'PositioningFlightPattern')),
      charterFlightPattern: optional(column(record, 'CharterFlightPattern')),
      alliance: picked?.alliance ?? null,
      allianceStatus: picked?.allianceStatus ?? null,
      validFrom: picked?.validFrom ?? null,
      validTo: picked?.validTo ?? null,
      optdPk: picked?.pk ?? null,
    });
  }

  let upserted = 0;
  await db.transaction(async (tx) => {
    for (const batch of chunk(rows, BATCH_SIZE)) {
      await tx
        .insert(airlines)
        .values(batch)
        .onConflictDoUpdate({
          target: airlines.icao,
          set: {
            iata: sql`excluded.iata`,
            vrsCode: sql`excluded.vrs_code`,
            name: sql`excluded.name`,
            positioningFlightPattern: sql`excluded.positioning_flight_pattern`,
            charterFlightPattern: sql`excluded.charter_flight_pattern`,
            alliance: sql`excluded.alliance`,
            allianceStatus: sql`excluded.alliance_status`,
            validFrom: sql`excluded.valid_from`,
            validTo: sql`excluded.valid_to`,
            optdPk: sql`excluded.optd_pk`,
          },
        });
      upserted += batch.length;
    }
  });
  log(`airlines: read ${spine.length}, upserted ${upserted}, skipped ${JSON.stringify(skipped)}`);
  return { read: spine.length, upserted, skipped };
}
