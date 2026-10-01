import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { uuidv7 } from '@planeahead/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, migrateDatabase, readJournal } from '../src/migrate';
import { adminUrl, sqlState, urlForDatabase } from './helpers';

/**
 * Migration 0007 (increment 14) against a database that already holds rows from before it: the
 * migration is applied in two steps, 0000 to 0006 from a copy of the folder whose journal stops
 * at 0006, then the real folder. Existing push tokens get the production app id, a `registered_at`
 * backfilled from the registration time they recorded, and no permission; the delivery key
 * refuses a second row for the same notification and token; the check constraints hold.
 */

const DATABASE = `planeahead_push_migration_${randomBytes(4).toString('hex')}`;
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

const ids = {
  user: uuidv7(),
  device: uuidv7(),
  registered: uuidv7(),
  never: uuidv7(),
};
const REGISTERED_AT = '2026-09-20 10:00:00+00';

beforeAll(async () => {
  await asAdmin(`create database "${DATABASE}"`);
  const url = urlForDatabase(adminUrl(), DATABASE);
  // A copy of the migrations whose journal ends at 0006: the schema production has today.
  partialFolder = mkdtempSync(join(tmpdir(), 'planeahead-migrations-'));
  cpSync(MIGRATIONS_FOLDER, partialFolder, { recursive: true });
  const journal = readJournal(partialFolder);
  // Cut at 0007, not merely without it: drizzle applies only migrations newer than the last one
  // applied, so a later migration (0008) applied here would make it skip 0007.
  const cut = journal.entries.findIndex((entry) => entry.tag === '0007_push_transport');
  const before = journal.entries.slice(0, cut);
  expect(before.at(-1)?.tag).toBe('0006_ledger_calls');
  writeFileSync(
    join(partialFolder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: before }, null, 2),
  );
  await migrateDatabase(url, { migrationsFolder: partialFolder });

  sql = postgres(url, { max: 1, fetch_types: false, prepare: false });
  await sql`insert into users (id, email, email_verified, name) values
    (${ids.user}, ${`push-migration-${ids.user}@example.test`}, true, 'Push')`;
  await sql`insert into devices (id, user_id, install_id, platform)
    values (${ids.device}, ${ids.user}, ${`install-${ids.device}`}, 'ios')`;
  // A token registered by an increment 5 to 13 client (last_used_at is its registration time),
  // and one written with no last_used_at at all.
  await sql`insert into push_tokens (id, user_id, device_id, kind, token, environment, last_used_at,
      created_at)
    values (${ids.registered}, ${ids.user}, ${ids.device}, 'apns', ${`tok-${ids.registered}`},
      'sandbox', ${REGISTERED_AT}, '2026-09-01 08:00:00+00')`;
  await sql`insert into push_tokens (id, user_id, device_id, kind, token, created_at)
    values (${ids.never}, ${ids.user}, ${ids.device}, 'fcm', ${`tok-${ids.never}`},
      '2026-09-02 09:30:00+00')`;

  await migrateDatabase(url);
});

afterAll(async () => {
  await sql?.end();
  rmSync(partialFolder, { recursive: true, force: true });
  await asAdmin(`drop database if exists "${DATABASE}" with (force)`);
});

describe('migration 0007 (push transport)', () => {
  it('gives existing tokens the production app id, their registration time and no permission', async () => {
    const rows = await sql<
      { id: string; app_id: string; registered_at: string; permission: string | null }[]
    >`select id::text as id, app_id, registered_at::text as registered_at, permission
      from push_tokens where user_id = ${ids.user} order by created_at`;

    expect(rows).toEqual([
      {
        id: ids.registered,
        app_id: 'app.planeahead.mobile',
        registered_at: REGISTERED_AT,
        permission: null,
      },
      {
        id: ids.never,
        app_id: 'app.planeahead.mobile',
        registered_at: '2026-09-02 09:30:00+00',
        permission: null,
      },
    ]);
  });

  it('refuses a second delivery row for the same notification and token, not for another token', async () => {
    const notification = uuidv7();
    await sql`insert into notification_deliveries (notification_id, subject_id, channel,
        push_token_id) values (${notification}, ${ids.user}, 'apns', ${ids.registered})`;
    const again = sql`insert into notification_deliveries (notification_id, subject_id, channel,
        push_token_id) values (${notification}, ${ids.user}, 'apns', ${ids.registered})`;

    await expect(again).rejects.toSatisfy((error) => sqlState(error) === '23505');
    await sql`insert into notification_deliveries (notification_id, subject_id, channel,
        push_token_id) values (${notification}, ${ids.user}, 'fcm', ${ids.never})`;
    const [row] = await sql<{ is_test: boolean; attempt_log: unknown }[]>`
      select is_test, attempt_log from notification_deliveries
      where notification_id = ${notification} and push_token_id = ${ids.registered}`;
    expect(row).toEqual({ is_test: false, attempt_log: {} });
  });

  it('checks the app id and the permission state', async () => {
    const bad = (column: 'app_id' | 'permission', value: string) =>
      sql.unsafe(`update push_tokens set ${column} = $1 where id = $2`, [value, ids.registered]);

    for (const value of [
      'noDots',
      'app..double',
      'app.planeahead.mobile/../x',
      `${'a'.repeat(153)}.bc`,
    ]) {
      await expect(bad('app_id', value), value).rejects.toSatisfy(
        (error) => sqlState(error) === '23514',
      );
    }
    await expect(bad('permission', 'maybe')).rejects.toSatisfy(
      (error) => sqlState(error) === '23514',
    );
    await bad('app_id', 'app.planeahead.mobile.dev');
    await bad('permission', 'provisional');
    const [row] = await sql<{ app_id: string; permission: string }[]>`
      select app_id, permission from push_tokens where id = ${ids.registered}`;
    expect(row).toEqual({ app_id: 'app.planeahead.mobile.dev', permission: 'provisional' });
  });

  it('ships the backfill as the last statement of the generated file', () => {
    const text = readFileSync(join(MIGRATIONS_FOLDER, '0007_push_transport.sql'), 'utf8');
    expect(
      text
        .trimEnd()
        .endsWith(
          'UPDATE "push_tokens" SET "registered_at" = COALESCE("last_used_at", "created_at");',
        ),
    ).toBe(true);
  });
});
