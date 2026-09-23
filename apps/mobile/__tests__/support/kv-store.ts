/**
 * `expo-sqlite/kv-store`'s synchronous `Storage`, rebuilt on the in-memory `SqliteLike` with the
 * statements expo-sqlite 57 uses (packages/expo-sqlite/src/Storage.ts), so the settings store's
 * persistence is exercised against a real SQLite table rather than a Map.
 */

import type { SqliteLike } from '../../src/lib/db/sqlite-like';

export interface SqliteKvStorage {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
  removeItemSync(key: string): boolean;
  getAllKeysSync(): string[];
}

export function sqliteKvStorage(db: SqliteLike): SqliteKvStorage {
  db.exec('CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY NOT NULL, value TEXT);');
  return {
    getItemSync(key) {
      return (
        db.get<{ value: string | null }>('SELECT value FROM storage WHERE key = ?;', [key])
          ?.value ?? null
      );
    },
    setItemSync(key, value) {
      db.run(
        'INSERT INTO storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
        [key, value],
      );
    },
    removeItemSync(key) {
      return db.run('DELETE FROM storage WHERE key = ?;', [key]).changes > 0;
    },
    getAllKeysSync() {
      return db.all<{ key: string }>('SELECT key FROM storage;').map((row) => row.key);
    },
  };
}
