#!/usr/bin/env node
/**
 * Writes the body of migrations/0001_add_set_updated_at.sql from the migration 0000 snapshot:
 * the set_updated_at() function plus one BEFORE UPDATE trigger per table that has an
 * updated_at column. Run after `drizzle-kit generate --custom --name add_set_updated_at`
 * created the empty file. Re-run it if a later increment regenerates migration 0000 from
 * scratch (never after the migration has been applied anywhere: add a new migration instead).
 *
 * Every trigger carries a WHEN clause so a no-op UPDATE (an identical upsert replayed by an
 * at-least-once queue consumer) does not move updated_at, which is the sync feed's change
 * detector. Tables without a generated column use `OLD.* IS DISTINCT FROM NEW.*`. Postgres
 * rejects that form when NEW has a STORED generated column ("BEFORE trigger's WHEN condition
 * cannot reference NEW generated columns"), so those tables get an explicit disjunction over
 * every non-generated column instead. The list is derived from the snapshot, not typed by hand,
 * and test/trigger.test.ts fails if a column is missing from it; a later increment that adds a
 * column to such a table must drop and recreate its trigger in a new custom migration.
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
-- Every trigger has a WHEN clause that skips no-op updates, so a replayed identical upsert does
-- not move updated_at and the sync feed sees no phantom change. A table with a STORED generated
-- column cannot use OLD.* IS DISTINCT FROM NEW.* (Postgres restriction), so its clause names
-- every non-generated column explicitly; the generator derives that list from the snapshot.
-- The function pins search_path so the trigger cannot be redirected by a session setting.
-- The migrator splits this file on the breakpoint marker: one marker separates the function
-- from each CREATE TRIGGER and none may appear inside the dollar-quoted body, not even in a
-- comment.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;`,
];

/** @param {{ columns: Record<string, { name: string; generated?: unknown }> }} table */
function whenClause(table) {
  const columns = Object.values(table.columns);
  const hasGenerated = columns.some((column) => column.generated !== undefined);
  if (!hasGenerated) {
    return 'WHEN (OLD.* IS DISTINCT FROM NEW.*)';
  }
  const terms = columns
    .filter((column) => column.generated === undefined)
    .map((column) => `OLD."${column.name}" IS DISTINCT FROM NEW."${column.name}"`);
  return `WHEN (${terms.join(' OR ')})`;
}

for (const table of tables) {
  parts.push(
    `CREATE TRIGGER "${table.name}_set_updated_at" BEFORE UPDATE ON "${table.name}" FOR EACH ROW ${whenClause(table)} EXECUTE FUNCTION set_updated_at();`,
  );
}
writeFileSync(outPath, `${parts.join('\n--> statement-breakpoint\n')}\n`);
console.log(`wrote ${outPath}: ${tables.length} triggers`);
