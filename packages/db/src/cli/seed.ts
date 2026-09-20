/**
 * `pnpm --filter @planeahead/db db:seed [url]`: loads the committed reference data into
 * DATABASE_URL (or the URL given as the first argument). Every loader is idempotent.
 */

import { createNodeDb } from '../client';
import { seedAll } from '../seed/index';

const url = process.argv[2] ?? process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('usage: db:seed <postgres url>   (or set DATABASE_URL)');
  process.exit(2);
}

const handle = createNodeDb(url, { max: 1 });
try {
  const report = await seedAll(handle.db, { log: (line) => console.log(`[seed] ${line}`) });
  for (const [name, result] of Object.entries(report)) {
    console.log(`[seed] ${name}: ${JSON.stringify(result)}`);
  }
} catch (error) {
  console.error(`[seed] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await handle.close();
}
