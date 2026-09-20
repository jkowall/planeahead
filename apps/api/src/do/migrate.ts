/**
 * SQLite schema migrations for Durable Objects.
 *
 * Five facts shape this file, all of them verified against primary sources on 2026-09-19 and
 * recorded in docs/increments/04-api-bootstrap.facts.md:
 *
 *  1. `PRAGMA user_version` does NOT work in Durable Object SQLite storage. workerd's SQLite
 *     authorizer allowlists pragmas by name and `user_version` is not on the list, so both the
 *     read and the write fail. The documented replacement is an ordinary table, which is what
 *     `_sql_schema_migrations` is. Never reintroduce the pragma.
 *  2. `ctx.storage.transactionSync(cb)` is SQLite only, rolls back if `cb` throws, and the
 *     callback must complete synchronously. Nothing in this file is async, and nothing in a
 *     migration may await.
 *  3. One SQL statement may be at most 100 KB. A migration is therefore a list of statements,
 *     one `sql.exec` per statement, not one blob with semicolons in it.
 *  4. Foreign keys are ENFORCED by default in Durable Object SQLite (unlike a bare sqlite3 CLI,
 *     where they are off unless `PRAGMA foreign_keys = ON`). A migration that creates tables in
 *     an order that violates a reference, or deletes rows a child still points at, fails. Order
 *     the statements, or open the migration with `PRAGMA defer_foreign_keys = ON` (that pragma is
 *     on the authorizer's allowlist; `foreign_keys` itself is not settable).
 *  5. Dynamic `import()` does not work inside Durable Object handlers under the Workers Vitest
 *     pool, so every Durable Object class imports this module statically.
 *
 * The runner is deliberately hand written rather than taken from `durable-utils` or
 * `@cloudflare/actors`: about forty lines against a closed dependency budget, and the rollback
 * semantics are the part that has to be tested anyway (ADR 0004 records the trade-off).
 */

/** Table that records which migration ids an object has applied. */
export const MIGRATIONS_TABLE = '_sql_schema_migrations';

/** Documented maximum length of a single SQL statement in Durable Object SQLite storage. */
export const MAX_SQL_STATEMENT_BYTES = 100 * 1024;

/**
 * Migrations for one Durable Object class, in order. Index 0 is migration id 1. Each entry is the
 * list of statements that migration runs, and the whole entry commits or rolls back as a unit.
 *
 * Migrations are append only. Editing an already released entry changes nothing on objects that
 * have run it and silently diverges their schema from a fresh object's.
 */
export type SqlMigrations = readonly (readonly string[])[];

export interface MigrationResult {
  /** `MAX(id)` in `_sql_schema_migrations` after the run. 0 when the object has no migrations. */
  readonly version: number;
  /** Migration ids this call applied, in order. Empty when the object was already current. */
  readonly applied: readonly number[];
}

export const EMPTY_MIGRATION_RESULT: MigrationResult = Object.freeze({
  version: 0,
  applied: Object.freeze([]),
});

/**
 * Why a migration run refused.
 *
 *  - `statement`: a migration's own SQL is the problem, and `migrationId` is that migration.
 *  - `version_ahead`: the object carries a schema this build does not have. No migration failed;
 *    `migrationId` is the first id this build cannot account for and `foundVersion` is what the
 *    object is actually at.
 *
 * The discriminator exists because a single `migrationId` field cannot carry both meanings. It
 * used to hold the found version on the `version_ahead` path, which told an operator (and any
 * Sentry grouping rule keyed on it) that migration N had failed when migration N had in fact
 * applied cleanly on a newer deployment.
 */
export type SqlMigrationErrorKind = 'statement' | 'version_ahead';

export interface SqlMigrationErrorInit extends ErrorOptions {
  readonly kind: SqlMigrationErrorKind;
  /** The migration this error is about. Never a migration that ran successfully. */
  readonly migrationId: number;
  /** Only on `version_ahead`: `MAX(id)` found in `_sql_schema_migrations`. */
  readonly foundVersion?: number;
}

export class SqlMigrationError extends Error {
  override readonly name = 'SqlMigrationError';
  readonly kind: SqlMigrationErrorKind;
  readonly migrationId: number;
  readonly foundVersion: number | null;

  constructor(message: string, init: SqlMigrationErrorInit) {
    super(message, init);
    this.kind = init.kind;
    this.migrationId = init.migrationId;
    this.foundVersion = init.foundVersion ?? null;
  }
}

interface VersionRow {
  readonly version: number | null;
  readonly [key: string]: string | number | ArrayBuffer | null;
}

function readVersion(sql: SqlStorage): number {
  const row = sql.exec<VersionRow>(`SELECT MAX(id) AS version FROM ${MIGRATIONS_TABLE}`).one();
  return row.version ?? 0;
}

function assertStatementSizes(migrationId: number, statements: readonly string[]): void {
  const encoder = new TextEncoder();
  for (const [index, statement] of statements.entries()) {
    const bytes = encoder.encode(statement).length;
    if (bytes > MAX_SQL_STATEMENT_BYTES) {
      throw new SqlMigrationError(
        `migration ${migrationId} statement ${index + 1} is ${bytes} bytes, over the ` +
          `${MAX_SQL_STATEMENT_BYTES} byte limit for one Durable Object SQL statement; split it`,
        { kind: 'statement', migrationId },
      );
    }
  }
}

/**
 * Brings the object's SQLite schema up to date and returns what it did.
 *
 * Synchronous on purpose: call it from the constructor inside `ctx.blockConcurrencyWhile`, which
 * is the documented migration point. A throw from that callback terminates and resets the object
 * rather than leaving it half migrated, and the callback has a 30 second budget.
 *
 * Each pending migration runs in its own `transactionSync`, with the `_sql_schema_migrations` row
 * inserted inside the same transaction. A statement that throws rolls the whole migration back,
 * including the id row, so the next construction retries it from the beginning.
 */
export function runSqlMigrations(
  ctx: DurableObjectState,
  migrations: SqlMigrations,
): MigrationResult {
  const sql = ctx.storage.sql;

  // Idempotent and outside the per-migration transaction: the table must exist before the version
  // probe, and creating it is not part of any migration's rollback unit.
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (` +
      'id INTEGER PRIMARY KEY, ' +
      "applied_at TEXT NOT NULL DEFAULT (datetime('now'))" +
      ')',
  );

  let version = readVersion(sql);
  if (version > migrations.length) {
    // The object was migrated by a newer deployment. Writing against it with the old schema is
    // how data gets corrupted, so refuse to construct instead.
    //
    // `migrationId` is the first id this build cannot account for, NOT the found version: every
    // migration up to `migrations.length` applied cleanly here and naming one of them as the
    // failure is how an operator ends up debugging a migration that worked.
    throw new SqlMigrationError(
      `object is at schema version ${version} but this build only knows ${migrations.length}; ` +
        'this Worker is older than the data it was asked to open',
      { kind: 'version_ahead', migrationId: migrations.length + 1, foundVersion: version },
    );
  }

  const applied: number[] = [];
  for (const [index, statements] of migrations.entries()) {
    const id = index + 1;
    if (id <= version) {
      continue;
    }
    assertStatementSizes(id, statements);
    ctx.storage.transactionSync(() => {
      for (const statement of statements) {
        sql.exec(statement);
      }
      sql.exec(`INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES (?)`, id);
    });
    applied.push(id);
    version = id;
  }

  return { version, applied };
}
