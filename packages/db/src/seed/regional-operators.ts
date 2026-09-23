/**
 * Regional operator hints from `@planeahead/shared` regional-operators.seed.json, written with
 * confidence `hint`. The seed's own per-rule confidence (published, observed, assumed) is kept
 * in `source_confidence` for display; the table's `confidence` column distinguishes hints from
 * BTS-derived observed ranges that a later increment adds.
 */

import { REGIONAL_OPERATOR_SEED } from '@planeahead/shared';
import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { regionalOperators } from '../schema/reference';
import { BATCH_SIZE, type SeedOptions, type SeedResult } from './common';
import { chunk } from './csv';

export async function seedRegionalOperators(
  db: Db,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const log = options.log ?? (() => undefined);
  const rows: (typeof regionalOperators.$inferInsert)[] = REGIONAL_OPERATOR_SEED.map((rule) => ({
    marketingIata: rule.marketingIata,
    numberFrom: rule.from,
    numberTo: rule.to,
    operatingIcao: rule.operatingIcao,
    confidence: 'hint',
    observationCount: 0,
    source: rule.source,
    sourceConfidence: rule.confidence,
    sourceAsOf: rule.asOf,
    note: rule.note ?? null,
  }));
  let upserted = 0;
  for (const batch of chunk(rows, BATCH_SIZE)) {
    await db
      .insert(regionalOperators)
      .values(batch)
      .onConflictDoUpdate({
        target: [
          regionalOperators.marketingIata,
          regionalOperators.numberFrom,
          regionalOperators.numberTo,
        ],
        set: {
          operatingIcao: sql`excluded.operating_icao`,
          confidence: sql`excluded.confidence`,
          source: sql`excluded.source`,
          sourceConfidence: sql`excluded.source_confidence`,
          sourceAsOf: sql`excluded.source_as_of`,
          note: sql`excluded.note`,
        },
      });
    upserted += batch.length;
  }
  log(`regional_operators: read ${rows.length}, upserted ${upserted}`);
  return { read: rows.length, upserted, skipped: {} };
}
