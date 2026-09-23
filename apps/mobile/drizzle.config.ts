import { defineConfig } from 'drizzle-kit';

/**
 * The offline store's migrations. `driver: 'expo'` makes drizzle-kit also write
 * `migrations/migrations.js`, which imports every `.sql` file so the app bundle carries them;
 * babel.config.js inlines those imports as strings. Generate with `pnpm db:generate`, never edit
 * a generated file by hand: scripts/mobile-migrations-guard.mjs fails CI when a committed one
 * changes. The migrations run in SQLiteProvider's `onInit` (src/lib/db/client.ts) before any
 * screen mounts.
 */
export default defineConfig({
  dialect: 'sqlite',
  driver: 'expo',
  schema: './src/lib/db/schema.ts',
  out: './src/lib/db/migrations',
  strict: true,
  verbose: true,
});
