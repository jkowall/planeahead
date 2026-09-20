/**
 * `pnpm --filter @planeahead/db db:migrate [url]`: applies pending migrations to DATABASE_URL
 * (or the URL given as the first argument). Never point this at Hyperdrive or a -pooler host.
 */

import { migrateDatabase } from '../migrate';

const url = process.argv[2] ?? process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('usage: db:migrate <postgres url>   (or set DATABASE_URL)');
  process.exit(2);
}

try {
  const result = await migrateDatabase(url, { log: (line) => console.log(`[migrate] ${line}`) });
  console.log(
    `[migrate] done: ${result.migrations} migration(s), hash ${result.migrationHash.slice(0, 12)}, ` +
      `server_version_num ${result.serverVersionNum}`,
  );
} catch (error) {
  console.error(`[migrate] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
