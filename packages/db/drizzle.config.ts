import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads the schema and writes SQL migrations to ./migrations. It never needs a
 * database: `db:generate` diffs against the snapshot in migrations/meta and `db:check` verifies
 * the snapshots are consistent. Applying migrations is `src/migrate.ts` (URL only, Neon direct
 * endpoint, never the Hyperdrive binding).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
