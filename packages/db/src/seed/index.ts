/**
 * Seed loaders for reference data. Node only (reads seed/data). Each loader is idempotent: it
 * upserts on the table's natural key, so running twice leaves the same rows.
 */

import type { Db } from '../client';
import { seedAircraftTypes } from './aircraft-types';
import { seedAirlines } from './airlines';
import { seedAirports } from './airports';
import type { SeedOptions, SeedResult } from './common';
import { seedRegionalOperators } from './regional-operators';

export { SEED_DATA_DIR, SeedCollisionError, type SeedOptions, type SeedResult } from './common';
export { seedAirports, MissingTimezoneError } from './airports';
export { seedAirlines, normaliseAlliance, normaliseAllianceStatus } from './airlines';
export { seedAircraftTypes } from './aircraft-types';
export { seedRegionalOperators } from './regional-operators';

export interface SeedReport {
  readonly airports: SeedResult;
  readonly airlines: SeedResult;
  readonly aircraftTypes: SeedResult;
  readonly regionalOperators: SeedResult;
}

export async function seedAll(db: Db, options: SeedOptions = {}): Promise<SeedReport> {
  return {
    airports: await seedAirports(db, options),
    airlines: await seedAirlines(db, options),
    aircraftTypes: await seedAircraftTypes(db, options),
    regionalOperators: await seedRegionalOperators(db, options),
  };
}
