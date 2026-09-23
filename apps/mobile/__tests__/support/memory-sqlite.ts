/**
 * The in-memory `SqliteLike` the store tests run against (ruling P5): a real SQLite engine, Node's
 * built-in `node:sqlite`, synchronous like expo-sqlite's `*Sync` API, with the app's own
 * drizzle-kit migrations applied. It records every statement and every transaction, so a test
 * can assert HOW the store wrote, not only what ended up in it.
 *
 * `node:sqlite` is reached through `process.getBuiltinModule`: Jest 29's module registry does not
 * know the prefix-only `node:sqlite` built-in, and a plain `require` would be resolved as a file.
 */

import type { SqliteLike, SqlValue, TransactionOptions } from '../../src/lib/db/sqlite-like';
import bundledMigrations from '../../src/lib/db/migrations/migrations';

/** migrations.js is generated JavaScript; this is the shape Drizzle's Expo migrator reads. */
const migrations = bundledMigrations as {
  readonly journal: { readonly entries: readonly { readonly idx: number; readonly tag: string }[] };
  readonly migrations: Readonly<Record<string, string>>;
};

interface NodeStatement {
  run(...params: SqlValue[]): { changes: number | bigint };
  all(...params: SqlValue[]): unknown[];
  get(...params: SqlValue[]): unknown;
}

export interface NodeDatabase {
  exec(source: string): void;
  prepare(source: string): NodeStatement;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => NodeDatabase;
}

export function openNodeDatabase(path = ':memory:'): NodeDatabase {
  const getBuiltinModule = (process as unknown as { getBuiltinModule?: (id: string) => unknown })
    .getBuiltinModule;
  if (getBuiltinModule === undefined) {
    throw new Error(
      'process.getBuiltinModule is missing: the mobile tests need Node 22.3 or newer',
    );
  }
  const { DatabaseSync } = getBuiltinModule('node:sqlite') as NodeSqliteModule;
  return new DatabaseSync(path);
}

/** The bundled migrations, split the way Drizzle's Expo migrator splits them. */
export function migrationStatements(): string[] {
  return migrations.journal.entries.flatMap((entry) => {
    const source = migrations.migrations[`m${String(entry.idx).padStart(4, '0')}`];
    if (source === undefined) {
      throw new Error(`missing migration ${entry.tag}`);
    }
    return source
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');
  });
}

export interface RecordedTransaction {
  readonly behavior: TransactionOptions['behavior'];
  readonly statements: string[];
  outcome: 'open' | 'committed' | 'rolled_back';
}

export interface MemorySqlite extends SqliteLike {
  readonly raw: NodeDatabase;
  /** Every statement run through the seam, in order. */
  readonly statements: string[];
  readonly transactions: RecordedTransaction[];
  readonly inTransaction: boolean;
  /** Throw from the next statement whose SQL matches (simulates a failure mid-page). */
  failNext(pattern: RegExp): void;
}

function normalise(row: unknown): unknown {
  return row === undefined ? null : row;
}

export function createMemorySqlite(
  options: { readonly raw?: NodeDatabase; readonly migrate?: boolean } = {},
): MemorySqlite {
  const raw = options.raw ?? openNodeDatabase();
  if (options.migrate ?? true) {
    for (const statement of migrationStatements()) {
      raw.exec(statement);
    }
  }
  const statements: string[] = [];
  const transactions: RecordedTransaction[] = [];
  let current: RecordedTransaction | null = null;
  let failure: RegExp | null = null;

  const record = (source: string): void => {
    statements.push(source);
    current?.statements.push(source);
    if (failure !== null && failure.test(source)) {
      failure = null;
      throw new Error(`injected failure on: ${source.slice(0, 60)}`);
    }
  };

  const fake: MemorySqlite = {
    raw,
    statements,
    transactions,
    get inTransaction() {
      return current !== null;
    },
    failNext(pattern) {
      failure = pattern;
    },
    exec(source) {
      record(source);
      raw.exec(source);
    },
    run(source, params = []) {
      record(source);
      const { changes } = raw.prepare(source).run(...params);
      return { changes: Number(changes) };
    },
    all<Row>(source: string, params: readonly SqlValue[] = []) {
      record(source);
      return raw.prepare(source).all(...params) as Row[];
    },
    get<Row>(source: string, params: readonly SqlValue[] = []) {
      record(source);
      return normalise(raw.prepare(source).get(...params)) as Row | null;
    },
    transaction<T>(fn: () => T, transactionOptions: TransactionOptions): T {
      if (current !== null) {
        throw new Error('nested transaction: the store never nests them');
      }
      const recorded: RecordedTransaction = {
        behavior: transactionOptions.behavior,
        statements: [],
        outcome: 'open',
      };
      transactions.push(recorded);
      raw.exec(`BEGIN ${transactionOptions.behavior.toUpperCase()}`);
      current = recorded;
      try {
        const result = fn();
        if (result instanceof Promise) {
          throw new Error('a SqliteLike transaction callback must be synchronous');
        }
        current = null;
        raw.exec('COMMIT');
        recorded.outcome = 'committed';
        return result;
      } catch (error) {
        current = null;
        raw.exec('ROLLBACK');
        recorded.outcome = 'rolled_back';
        throw error;
      }
    },
  };
  return fake;
}
