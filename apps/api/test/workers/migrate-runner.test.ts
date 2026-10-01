/**
 * `src/do/migrate.ts` against real Durable Object SQLite storage.
 *
 * The runner is exercised through `runInDurableObject`, which hands the callback the object's own
 * `DurableObjectState`, rather than through a test-only Durable Object class. A test-only class
 * would have to be declared in `wrangler.jsonc`'s `exports` map, and `exports` is a one-way door:
 * a Durable Object class that ships once has a namespace on the account forever. Calling the
 * runner with a real `ctx` is the same code path a constructor takes, minus
 * `blockConcurrencyWhile`, which the do-ping tests cover.
 *
 * `UserInbox` is the host because its `MIGRATIONS` list is empty, so the object arrives with
 * the table created and no rows, which is exactly the "fresh object" state. (`AirportState` was
 * the host until increment 18 gave it real tables.)
 */

import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_SQL_STATEMENT_BYTES,
  MIGRATIONS_TABLE,
  SqlMigrationError,
  type SqlMigrations,
  runSqlMigrations,
} from '../../src/do/migrate';

const touched: DurableObjectStub[] = [];

function host(prefix: string): DurableObjectStub {
  const stub = env.USER_INBOX.getByName(`${prefix}-${crypto.randomUUID()}`);
  touched.push(stub);
  return stub;
}

afterEach(async () => {
  while (touched.length > 0) {
    const stub = touched.pop();
    if (stub !== undefined) {
      await runDurableObjectAlarm(stub);
    }
  }
});

/** Two independent migrations: one table each, so a partial apply is visible. */
const TWO: SqlMigrations = [
  ['CREATE TABLE alpha (id INTEGER PRIMARY KEY, note TEXT NOT NULL)'],
  [
    'CREATE TABLE beta (id INTEGER PRIMARY KEY, alpha_id INTEGER NOT NULL REFERENCES alpha(id))',
    'CREATE INDEX beta_alpha_id ON beta (alpha_id)',
  ],
];

function tableNames(state: DurableObjectState): string[] {
  return [
    ...state.storage.sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ),
  ].map((row) => row.name);
}

function appliedIds(state: DurableObjectState): number[] {
  return [
    ...state.storage.sql.exec<{ id: number }>(`SELECT id FROM ${MIGRATIONS_TABLE} ORDER BY id`),
  ].map((row) => row.id);
}

describe('runSqlMigrations', () => {
  it('reports MAX(id) as null on a fresh object and version 0 for an empty list', async () => {
    const result = await runInDurableObject(host('fresh'), (_instance, state) => {
      const rows = [
        ...state.storage.sql.exec<{ version: number | null }>(
          `SELECT MAX(id) AS version FROM ${MIGRATIONS_TABLE}`,
        ),
      ];
      return { rows, run: runSqlMigrations(state, []) };
    });

    // One row, and its value is SQL NULL. The runner turns that into 0; nothing else may.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.version).toBeNull();
    expect(result.run).toMatchObject({ version: 0, applied: [] });
    expect(typeof result.run.rowsWritten).toBe('number');
  });

  it('applies both migrations once and records their ids', async () => {
    const result = await runInDurableObject(host('apply'), (_instance, state) => ({
      run: runSqlMigrations(state, TWO),
      tables: tableNames(state),
      ids: appliedIds(state),
    }));

    expect(result.run).toMatchObject({ version: 2, applied: [1, 2] });
    expect(typeof result.run.rowsWritten).toBe('number');
    // DDL is billed as rows written like any other statement, and the runner reports it so a
    // Durable Object can add it to its lifetime meter.
    expect(result.run.rowsWritten).toBeGreaterThan(0);
    expect(result.tables).toContain('alpha');
    expect(result.tables).toContain('beta');
    expect(result.ids).toEqual([1, 2]);
  });

  it('applies nothing on a second run, which is what a re-construction does', async () => {
    const stub = host('reconstruct');

    const first = await runInDurableObject(stub, (_instance, state) =>
      runSqlMigrations(state, TWO),
    );
    // A second call with the same list is what the constructor does when the object is evicted
    // and rebuilt: the storage is still there, so the runner must be a no-op.
    const second = await runInDurableObject(stub, (_instance, state) => ({
      run: runSqlMigrations(state, TWO),
      ids: appliedIds(state),
    }));

    expect(first).toMatchObject({ version: 2, applied: [1, 2] });
    expect(typeof first.rowsWritten).toBe('number');
    expect(second.run).toMatchObject({ version: 2, applied: [] });
    expect(typeof second.run.rowsWritten).toBe('number');
    expect(second.run.rowsWritten).toBeLessThan(first.rowsWritten);
    expect(second.ids).toEqual([1, 2]);
  });

  it('applies only the pending migration when the list grows', async () => {
    const stub = host('append');

    await runInDurableObject(stub, (_instance, state) => runSqlMigrations(state, TWO));
    const grown = await runInDurableObject(stub, (_instance, state) =>
      runSqlMigrations(state, [...TWO, ['CREATE TABLE gamma (id INTEGER PRIMARY KEY)']]),
    );

    expect(grown).toMatchObject({ version: 3, applied: [3] });
    expect(typeof grown.rowsWritten).toBe('number');
  });

  it('rolls the whole migration back when one of its statements fails', async () => {
    const stub = host('rollback');

    const outcome = await runInDurableObject(stub, (_instance, state) => {
      let threw = false;
      try {
        runSqlMigrations(state, [
          ...TWO,
          [
            'CREATE TABLE gamma (id INTEGER PRIMARY KEY)',
            'INSERT INTO gamma (id) VALUES (1)',
            'THIS IS NOT SQL',
          ],
        ]);
      } catch {
        threw = true;
      }
      return { threw, tables: tableNames(state), ids: appliedIds(state) };
    });

    expect(outcome.threw).toBe(true);
    // Migrations 1 and 2 committed in their own transactions and stay. Migration 3 is gone in
    // full: no `gamma` table, and above all no id row claiming it ran.
    expect(outcome.ids).toEqual([1, 2]);
    expect(outcome.tables).not.toContain('gamma');
  });

  it('retries the rolled back migration on the next run', async () => {
    const stub = host('retry');

    await runInDurableObject(stub, (_instance, state) => {
      try {
        runSqlMigrations(state, [...TWO, ['CREATE TABLE gamma (id INTEGER PRIMARY KEY)', 'NOPE']]);
      } catch {
        // Expected: this is the failure the next run has to recover from.
      }
    });
    const fixed = await runInDurableObject(stub, (_instance, state) => ({
      run: runSqlMigrations(state, [...TWO, ['CREATE TABLE gamma (id INTEGER PRIMARY KEY)']]),
      tables: tableNames(state),
    }));

    expect(fixed.run).toMatchObject({ version: 3, applied: [3] });
    expect(typeof fixed.run.rowsWritten).toBe('number');
    expect(fixed.tables).toContain('gamma');
  });

  it('refuses to open an object migrated by a newer build', async () => {
    const stub = host('newer');

    const outcome = await runInDurableObject(stub, (_instance, state) => {
      runSqlMigrations(state, TWO);
      try {
        runSqlMigrations(state, [TWO[0] ?? []]);
        return 'no throw';
      } catch (error) {
        if (!(error instanceof SqlMigrationError)) {
          return 'other';
        }
        return { kind: error.kind, migrationId: error.migrationId, found: error.foundVersion };
      }
    });

    // The object is at version 2 and the build knows one migration, so the first id this build
    // cannot account for is 2 and the found version is 2. `migrationId` names the id that is
    // MISSING from this build, never a migration that ran: migration 1 applied cleanly here, and
    // reporting a clean migration in a field called `migrationId` is how an operator (or a Sentry
    // grouping rule keyed on it) ends up debugging a migration that worked. `kind` is what tells
    // the two cases apart.
    expect(outcome).toEqual({ kind: 'version_ahead', migrationId: 2, found: 2 });
  });

  it('reports a statement failure with the migration that actually failed', async () => {
    const stub = host('statement-kind');
    const oversized = `SELECT 1 -- ${'x'.repeat(MAX_SQL_STATEMENT_BYTES)}`;

    const outcome = await runInDurableObject(stub, (_instance, state) => {
      try {
        runSqlMigrations(state, [
          ...TWO,
          ['CREATE TABLE gamma (id INTEGER PRIMARY KEY)', oversized],
        ]);
        return 'no throw';
      } catch (error) {
        if (!(error instanceof SqlMigrationError)) {
          return 'other';
        }
        return { kind: error.kind, migrationId: error.migrationId, found: error.foundVersion };
      }
    });

    expect(outcome).toEqual({ kind: 'statement', migrationId: 3, found: null });
  });

  it('refuses a statement over the 100 KB limit before running any of the migration', async () => {
    const stub = host('oversize');
    const oversized = `CREATE TABLE big (id INTEGER PRIMARY KEY, note TEXT) -- ${'x'.repeat(
      MAX_SQL_STATEMENT_BYTES,
    )}`;

    const outcome = await runInDurableObject(stub, (_instance, state) => {
      try {
        runSqlMigrations(state, [['CREATE TABLE small (id INTEGER PRIMARY KEY)', oversized]]);
        return { threw: 'no throw', tables: tableNames(state) };
      } catch (error) {
        return {
          threw: error instanceof SqlMigrationError ? error.name : 'other',
          tables: tableNames(state),
        };
      }
    });

    expect(outcome.threw).toBe('SqlMigrationError');
    // The size check runs before the transaction, so not even the first statement was executed.
    expect(outcome.tables).not.toContain('small');
  });

  it('enforces foreign keys, which Durable Object SQLite has on by default', async () => {
    // Worth an explicit test because a bare sqlite3 CLI has them OFF unless the connection sets
    // `PRAGMA foreign_keys = ON`, and `foreign_keys` is not a settable pragma here. A migration
    // written against local sqlite3 habits would pass there and fail on the platform.
    const stub = host('fk');

    const outcome = await runInDurableObject(stub, (_instance, state) => {
      runSqlMigrations(state, TWO);
      try {
        state.storage.sql.exec('INSERT INTO beta (id, alpha_id) VALUES (1, 999)');
        return 'insert allowed';
      } catch {
        return 'foreign key enforced';
      }
    });

    expect(outcome).toBe('foreign key enforced');
  });
});
