/**
 * The store's change signal: a per-table version, bumped ONCE per committed write, that live
 * queries listen to (src/lib/db/live-query.ts).
 *
 * Why not SQLite's update hook: expo-sqlite reports every changed ROW as its own event, and each
 * event reaches JavaScript as its own task on React Native's runtime scheduler, which drains
 * microtasks after every task. A trailing-microtask coalescer therefore collapses nothing on a
 * device: a 200-row sync page re-ran a list query 200 times (increment 9 review, finding
 * auth-and-store-2). The writers know when a transaction has committed and which tables it
 * touched, so they say so once, here, after the COMMIT.
 *
 * Every write to the offline store goes through a function that signals: the page apply, the
 * cursor reset, the owner wipe, the account wipe and every outbox write (src/lib/sync). A new
 * writer uses `commitWrite`, which runs the immediate transaction and signals after it; a write
 * that forgets to signal leaves every list on its table stale until the next signalled write.
 */

import type { SqliteLike } from './sqlite-like';

/** Every table a writer may name. */
export const STORE_TABLES = [
  'flight_subscriptions',
  'user_preferences',
  'notification_preferences',
  'trips',
  'trip_members',
  'logbook_entries',
  'sync_state',
  'outbox',
] as const;

export type StoreTable = (typeof STORE_TABLES)[number];

type Listener = () => void;

const versions = new Map<string, number>();
const listeners = new Map<string, Set<Listener>>();

/** How many committed writes have named `table` since the process started. */
export function tableVersion(table: string): number {
  return versions.get(table) ?? 0;
}

/**
 * Called by a writer AFTER its transaction committed (never inside it: a listener that read the
 * table from inside the transaction would see uncommitted rows). Each table is bumped once
 * however often it is named, and a listener that throws does not stop the others.
 */
export function notifyTablesChanged(tables: Iterable<StoreTable>): void {
  const unique = new Set(tables);
  for (const table of unique) {
    versions.set(table, tableVersion(table) + 1);
  }
  for (const table of unique) {
    for (const listener of [...(listeners.get(table) ?? [])]) {
      try {
        listener();
      } catch (error) {
        // A broken listener is its own screen's problem; the write already committed.
        console.error(`store-signal listener for ${table} threw`, error);
      }
    }
  }
}

/** Calls `listener` after every committed write that names `table`; returns the unsubscribe. */
export function subscribeToTable(table: string, listener: Listener): () => void {
  const set = listeners.get(table) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(table, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(table);
    }
  };
}

/**
 * Runs `fn` in one `BEGIN IMMEDIATE` transaction and, once it has committed, signals `tables`
 * once each. A throw rolls back and signals nothing.
 */
export function commitWrite<T>(db: SqliteLike, tables: readonly StoreTable[], fn: () => T): T {
  const result = db.transaction(fn, { behavior: 'immediate' });
  notifyTablesChanged(tables);
  return result;
}
