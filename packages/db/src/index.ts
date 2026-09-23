/**
 * @planeahead/db: the Postgres schema (Drizzle pg-core) and the client helpers. This entry point
 * is safe to import from a Worker: it pulls in drizzle-orm and postgres.js only. Node-only
 * modules are separate subpaths: `@planeahead/db/migrate` (reads the migrations folder) and
 * `@planeahead/db/seed` (reads seed/data).
 *
 * Kept separate from @planeahead/shared so the mobile bundle never pulls in drizzle-orm/pg.
 */

import * as schema from './schema/index';

export { schema };
export * from './schema/index';
export {
  createNodeDb,
  openDb,
  withDb,
  WORKER_CLIENT_OPTIONS,
  type Db,
  type DbEnv,
  type HyperdriveBinding,
  type NodeDb,
  type NodeDbOptions,
} from './client';
export {
  destinationColumns,
  originColumns,
  resolveAirportEndpoint,
  type AirportEndpoint,
} from './queries/airports';

/**
 * Number of migrations in `migrations/meta/_journal.json`. A test keeps it in sync; `/health`
 * reports the journal's SHA-256 (`migrationHash()` in `@planeahead/db/migrate`) rather than this.
 */
export const DB_SCHEMA_VERSION = 3;
