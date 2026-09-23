/**
 * The app's live query (docs/increments/09, before any list uses it; ruling S9 item 2).
 *
 * Same contract as Drizzle's `useLiveQuery` (a query, `{ data, error, updatedAt }`, re-run when
 * its root table changes), with one difference that is the point of the wrapper: it re-runs on
 * the store's explicit per-table signal (src/lib/db/store-signal.ts), which the writers send ONCE
 * per committed transaction, never on SQLite's update hook, which fires once per changed row and
 * reaches JavaScript as one task per row. A 200-row sync page is one commit, so one signal and
 * one re-run, however the platform delivers its events.
 *
 * Signals are also coalesced within a task (a trailing microtask), so a writer that commits two
 * transactions back to back, or names several tables a query cares about, still costs one re-run,
 * and the re-run never happens inside the synchronous code that committed.
 *
 * The root table is named explicitly rather than read off the query builder's internals. The
 * query must still select FROM that table: a live query only hears its root table's signal,
 * which is why the flight snapshot is denormalised onto `flight_subscriptions`
 * (src/lib/db/schema.ts).
 */

import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { useEffect, useRef, useState, type DependencyList } from 'react';
import { subscribeToTable } from './store-signal';

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
            setError(undefined);
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
    const unsubscribe = subscribeToTable(getTableConfig(table).name, createCoalescer(run));
    run();
    return () => {
      active = false;
      unsubscribe();
    };
    // `deps` is the caller's contract, exactly as with Drizzle's hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, ...deps]);

  return { data, error, updatedAt };
}
