#!/usr/bin/env node
/**
 * Writes the body of migrations/0001_add_set_updated_at.sql from the migration 0000 snapshot:
 * the set_updated_at() function plus one BEFORE UPDATE trigger per table that has an
 * updated_at column. Run after `drizzle-kit generate --custom --name add_set_updated_at`
 * created the empty file. Re-run it if a later increment regenerates migration 0000 from
 * scratch (never after the migration has been applied anywhere: add a new migration instead).
 *
 * Tables with a STORED generated column get the trigger without the no-op WHEN clause, because
 * Postgres rejects `OLD.* IS DISTINCT FROM NEW.*` in a BEFORE trigger when NEW has generated
 * columns ("BEFORE trigger's WHEN condition cannot reference NEW generated columns").
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotPath = join(packageRoot, 'migrations', 'meta', '0000_snapshot.json');
const outPath = join(packageRoot, 'migrations', '0001_add_set_updated_at.sql');

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const tables = Object.values(snapshot.tables)
  .filter((table) => table.columns.updated_at !== undefined)
  .sort((a, b) => (a.name < b.name ? -1 : 1));

const parts = [
  `-- Custom migration (drizzle-kit generate --custom --name add_set_updated_at), body written by
-- scripts/gen-updated-at-migration.mjs. set_updated_at() stamps updated_at on every UPDATE so
-- writers that bypass Drizzle (queue consumers, raw SQL, admin tools) keep the column honest.
-- The WHEN clause skips no-op updates so the sync feed does not see phantom changes; tables
-- with a generated column cannot carry it (Postgres restriction) and always bump. The migrator
-- splits this file on the breakpoint marker: one marker separates the function from each
-- CREATE TRIGGER and none may appear inside the dollar-quoted body, not even in a comment.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;`,
];
for (const table of tables) {
  const hasGenerated = Object.values(table.columns).some(
    (column) => column.generated !== undefined,
  );
  const when = hasGenerated ? '' : ' WHEN (OLD.* IS DISTINCT FROM NEW.*)';
  parts.push(
    `CREATE TRIGGER "${table.name}_set_updated_at" BEFORE UPDATE ON "${table.name}" FOR EACH ROW${when} EXECUTE FUNCTION set_updated_at();`,
  );
}
writeFileSync(outPath, `${parts.join('\n--> statement-breakpoint\n')}\n`);
console.log(`wrote ${outPath}: ${tables.length} triggers`);
