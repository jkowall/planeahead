/**
 * The offline store the screens read, as a `SqliteLike` (increment 10).
 *
 * In the app it is the one connection `onInitDatabase` published (src/lib/db/client.ts):
 * `SQLiteProvider` renders nothing until that has run, so every screen below it finds the store
 * ready. A test (or the development seeding route) wraps a screen in `StoreProvider` with its own
 * `SqliteLike`, the in-memory `node:sqlite` fake in Jest, so the screens run their real queries
 * against a real SQLite engine.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { currentStore } from './client';
import type { SqliteLike } from './sqlite-like';

const StoreContext = createContext<SqliteLike | null>(null);

export function StoreProvider({ value, children }: { value: SqliteLike; children: ReactNode }) {
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): SqliteLike {
  const provided = useContext(StoreContext);
  if (provided !== null) {
    return provided;
  }
  const store = currentStore();
  if (store === null) {
    throw new Error('the offline store is not open yet (render screens inside SQLiteProvider)');
  }
  return store.sqlite;
}
