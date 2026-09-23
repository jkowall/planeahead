/**
 * Drizzle's `useLiveQuery` with coalescing (docs/increments/09, before any list uses it).
 *
 * Drizzle's hook (drizzle-orm/expo-sqlite/query) re-runs its query on EVERY change event that
 * names its root table, and SQLite's update hook fires once per changed row: a 200-row sync page
 * would re-run the list query 200 times and re-render 200 times. This hook has the same
 * contract (same listener, same root-table rule, same `{ data, error, updatedAt }`), except that
 * events are collapsed into ONE re-run on a trailing microtask. The microtask also means a
 * refresh can never run inside a synchronous transaction: even an event delivered while the page
 * applies is only acted on after the transaction has returned.
 *
 * The root table is named explicitly rather than read off the query builder's internals. The
 * query must still select FROM that table: a live query only hears about its root table, which is
 * why the flight snapshot is denormalised onto `flight_subscriptions` (src/lib/db/schema.ts).
 */

import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { addDatabaseChangeListener } from 'expo-sqlite';
import { useEffect, useRef, useState, type DependencyList } from 'react';

/** Collapses every call made before the scheduled callback runs into one `run()`. */
export function createCoalescer(
  run: () => void,
  schedule: (callback: () => void) => void = queueMicrotask,
): () => void {
  let pending = false;
  return () => {
    if (pending) {
      return;
    }
    pending = true;
    schedule(() => {
      pending = false;
      run();
    });
  };
}

export interface LiveQueryResult<T> {
  readonly data: T;
  readonly error: Error | undefined;
  readonly updatedAt: Date | undefined;
}

export function useLiveQuery<T>(
  table: SQLiteTable,
  query: () => PromiseLike<T>,
  initial: T,
  deps: DependencyList = [],
): LiveQueryResult<T> {
  const [data, setData] = useState<T>(initial);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [updatedAt, setUpdatedAt] = useState<Date | undefined>(undefined);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    let active = true;
    const run = (): void => {
      queryRef.current().then(
        (rows) => {
          if (active) {
            setData(rows);
            setUpdatedAt(new Date());
          }
        },
        (reason: unknown) => {
          if (active) {
            setError(reason instanceof Error ? reason : new Error(String(reason)));
          }
        },
      );
    };
    const refresh = createCoalescer(run);
    const { name } = getTableConfig(table);
    run();
    const subscription = addDatabaseChangeListener(({ tableName }) => {
      if (tableName === name) {
        refresh();
      }
    });
    return () => {
      active = false;
      subscription.remove();
    };
    // `deps` is the caller's contract, exactly as with Drizzle's hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, ...deps]);

  return { data, error, updatedAt };
}
