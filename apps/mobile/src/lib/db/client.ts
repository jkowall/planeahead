/**
 * The app's one SQLite connection and everything built on it.
 *
 * `SQLiteProvider` (src/app/_layout.tsx) opens `planeahead.db` with the change listener on (the
 * update hook `useLiveQuery` needs) and calls `onInitDatabase` before any child mounts. The
 * provider's memo compares `onInit` by reference, so it is this module-scope function, never an
 * inline closure (a new closure would reopen the database on every render of the root layout).
 *
 * The sync apply, the outbox and the store reset see the same connection through `SqliteLike`,
 * whose `transaction` is Drizzle's synchronous `db.transaction(cb, { behavior: 'immediate' })`
 * on that connection (never `withExclusiveTransactionAsync`, which opens a second connection
 * with a plain deferred BEGIN).
 */

import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import type { SQLiteDatabase, SQLiteOpenOptions } from 'expo-sqlite';
import migrations from './migrations/migrations';
import { schema } from './schema';
import { sqliteLikeFromExpo, type SqliteLike } from './sqlite-like';

export const DATABASE_NAME = 'planeahead.db';

/** `enableChangeListener` is what makes the update hook reach `useLiveQuery`. */
export const DATABASE_OPTIONS: SQLiteOpenOptions = { enableChangeListener: true };

export type StoreOrm = ExpoSQLiteDatabase<typeof schema>;

export interface Store {
  readonly db: SQLiteDatabase;
  readonly orm: StoreOrm;
  readonly sqlite: SqliteLike;
}

let current: Store | null = null;
const waiters: ((store: Store) => void)[] = [];

export function storeFor(db: SQLiteDatabase): Store {
  const orm = drizzle(db, { schema });
  const sqlite = sqliteLikeFromExpo(db, (fn, options) =>
    orm.transaction(() => fn(), { behavior: options.behavior }),
  );
  return { db, orm, sqlite };
}

/**
 * WAL first (readers never block the single writer, and IMMEDIATE equals EXCLUSIVE there), then
 * the bundled migrations, then the store is published to the code that runs outside React.
 */
export async function onInitDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL;');
  const store = storeFor(db);
  await migrate(store.orm, migrations);
  current = store;
  for (const resolve of waiters.splice(0)) {
    resolve(store);
  }
}

/** The store once `onInitDatabase` has run; the sync client and the outbox wait on it. */
export function whenStoreReady(): Promise<Store> {
  if (current !== null) {
    return Promise.resolve(current);
  }
  return new Promise((resolve) => {
    waiters.push(resolve);
  });
}

export function currentStore(): Store | null {
  return current;
}
