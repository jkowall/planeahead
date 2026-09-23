/**
 * The slice of a synchronous SQLite connection the store code is written against (ruling P5).
 *
 * The sync apply, the outbox and the store reset take a `SqliteLike`, never expo-sqlite itself, so
 * Jest exercises them against an in-memory SQLite (test/support/memory-sqlite.ts, Node's built-in
 * `node:sqlite`) while the app hands them the real connection through `sqliteLikeFromExpo`. The
 * real binding is exercised only on a device.
 *
 * Every method is synchronous on purpose. expo-sqlite's `*Sync` calls and Drizzle's Expo session
 * run on the JS thread, so a page applied inside one synchronous transaction cannot interleave
 * with anything else JavaScript does: no outbox write, no live-query read, no second transaction
 * (docs/increments/08-flight-routes-and-sync.facts.md section 4).
 */

import type { SQLiteDatabase } from 'expo-sqlite';

export type SqlValue = string | number | null;

export interface RunResult {
  readonly changes: number;
}

export interface TransactionOptions {
  /**
   * `immediate` takes the write lock at BEGIN (in WAL mode the same as `exclusive`), so the
   * transaction can never fail half way with SQLITE_BUSY on its first write.
   */
  readonly behavior: 'immediate';
}

export interface SqliteLike {
  /** One or more statements, no parameters, no result (DDL, PRAGMA). */
  exec(source: string): void;
  run(source: string, params?: readonly SqlValue[]): RunResult;
  all<Row>(source: string, params?: readonly SqlValue[]): Row[];
  get<Row>(source: string, params?: readonly SqlValue[]): Row | null;
  /**
   * Runs `fn` inside BEGIN IMMEDIATE ... COMMIT on THIS connection and returns its result; a
   * throw rolls back and rethrows. `fn` must be synchronous: a promise returned from it would
   * commit before its work ran.
   */
  transaction<T>(fn: () => T, options: TransactionOptions): T;
}

/**
 * The seam's device side. `beginTransaction` is where the spec's
 * `db.transaction(cb, { behavior: 'immediate' })` lives: the app passes Drizzle's synchronous
 * transaction on the SAME expo-sqlite connection (src/lib/db/client.ts), never
 * `withExclusiveTransactionAsync`, which opens a second connection and issues a deferred BEGIN.
 */
export function sqliteLikeFromExpo(
  db: SQLiteDatabase,
  transaction: <T>(fn: () => T, options: TransactionOptions) => T,
): SqliteLike {
  return {
    exec: (source) => {
      db.execSync(source);
    },
    run: (source, params = []) => ({ changes: db.runSync(source, [...params]).changes }),
    all: <Row>(source: string, params: readonly SqlValue[] = []) =>
      db.getAllSync<Row>(source, [...params]),
    get: <Row>(source: string, params: readonly SqlValue[] = []) =>
      db.getFirstSync<Row>(source, [...params]),
    transaction,
  };
}

/** SQLite has no boolean; the store writes 0 and 1. */
export function sqlBoolean(value: boolean): number {
  return value ? 1 : 0;
}
