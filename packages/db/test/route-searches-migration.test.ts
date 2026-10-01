import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { uuidv7 } from '@planeahead/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, migrateDatabase, readJournal } from '../src/migrate';
import { adminUrl, sqlState, urlForDatabase } from './helpers';

/**
 * Migration 0011 (increment 18, rulings B9 and B10) against a database that already holds counter
 * rows: 0000 to 0010 from a copy of the folder whose journal stops at 0010, then the real folder.
 * Before it the `usage_counters` check refuses `route_searches`; after it the counter is accepted
 * for both scopes the route search takes (user, and salted IP), the rows written before survive,
 * and every counter the old check refused is still refused.
 */

const DATABASE = `planeahead_route_searches_${randomBytes(4).toString('hex')}`;
const DAY = '2026-10-01T00:00:00Z';
let sql: postgres.Sql;
let partialFolder: string;

async function asAdmin(statement: string): Promise<void> {
  const admin = postgres(adminUrl(), { max: 1, fetch_types: false, prepare: false });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end();
  }
}

function counter(scope: string, subject: string, name: string) {
  return sql`insert into usage_counters (id, scope, subject, counter, window_start, count)
    values (${uuidv7()}, ${scope}, ${subject}, ${name}, ${DAY}::timestamptz, 1)`;
}

beforeAll(async () => {
  await asAdmin(`create database "${DATABASE}"`);
  const url = urlForDatabase(adminUrl(), DATABASE);
  partialFolder = mkdtempSync(join(tmpdir(), 'planeahead-migrations-'));
  cpSync(MIGRATIONS_FOLDER, partialFolder, { recursive: true });
  const journal = readJournal(partialFolder);
  const cut = journal.entries.findIndex((entry) => entry.tag === '0011_route_searches');
  const before = journal.entries.slice(0, cut);
  expect(before.at(-1)?.tag).toBe('0010_board_calls');
  writeFileSync(
    join(partialFolder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: before }, null, 2),
  );
  await migrateDatabase(url, { migrationsFolder: partialFolder });
  sql = postgres(url, { max: 1, fetch_types: false, prepare: false });
});

afterAll(async () => {
  await sql?.end();
  rmSync(partialFolder, { recursive: true, force: true });
  await asAdmin(`drop database if exists "${DATABASE}" with (force)`);
});

describe('migration 0011: the route_searches counter', () => {
  it('is refused before the migration and accepted after it, keeping the old rows', async () => {
    await counter('user', 'kept-user', 'tracker_creations');
    await counter('user', 'kept-user', 'refresh:AAL-100-2026-10-01-KJFK');
    await expect(counter('user', 'early-user', 'route_searches')).rejects.toSatisfy(
      (error) => sqlState(error) === '23514',
    );

    await migrateDatabase(urlForDatabase(adminUrl(), DATABASE), {
      migrationsFolder: MIGRATIONS_FOLDER,
    });

    await counter('user', 'searcher', 'route_searches');
    await counter('ip', 'c2FsdGVkLWlw', 'route_searches');
    const rows = await sql<{ counter: string; n: number }[]>`
      select counter, count(*)::int as n from usage_counters group by counter order by counter`;
    expect(rows).toEqual([
      { counter: 'refresh:AAL-100-2026-10-01-KJFK', n: 1 },
      { counter: 'route_searches', n: 2 },
      { counter: 'tracker_creations', n: 1 },
    ]);
    for (const refused of ['route_search', 'board_views', 'refresh:x']) {
      await expect(counter('user', 'other', refused), refused).rejects.toSatisfy(
        (error) => sqlState(error) === '23514',
      );
    }
  });
});
