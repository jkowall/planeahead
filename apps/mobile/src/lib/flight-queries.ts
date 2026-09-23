/**
 * The flight screens' reads (increment 10, ruling T5): every one through the increment 9
 * `useLiveQuery` on `flight_subscriptions`, so a committed write re-runs it once, however many
 * rows it touched (src/lib/db/store-signal.ts). Plain SQL on the `SqliteLike` seam, so Jest runs
 * the same statements against the in-memory SQLite that the device runs against expo-sqlite.
 */

import type { SqliteLike } from './db/sqlite-like';
import { useLiveQuery } from './db/live-query';
import { flightSubscriptions } from './db/schema';
import { useStore } from './db/store-context';
import { toFlightItem, type FlightItem, type FlightRowRecord } from './flight-model';

/** Every live (not tombstoned) subscription, pending adds included. */
export function listFlights(db: SqliteLike): FlightItem[] {
  return db
    .all<FlightRowRecord>(
      'SELECT * FROM flight_subscriptions WHERE deleted_at IS NULL ORDER BY scheduled_out, id',
    )
    .map(toFlightItem);
}

/** One live subscription by id, or null (unknown, or removed). */
export function readFlight(db: SqliteLike, id: string): FlightItem | null {
  const row = db.get<FlightRowRecord>(
    'SELECT * FROM flight_subscriptions WHERE id = ? AND deleted_at IS NULL',
    [id],
  );
  return row === null ? null : toFlightItem(row);
}

export interface Loaded<T> {
  /** Undefined until the first query answered (the screen shows nothing rather than a flash). */
  readonly data: T | undefined;
  readonly error: Error | undefined;
}

export function useFlightList(): Loaded<FlightItem[]> {
  const db = useStore();
  const result = useLiveQuery(
    flightSubscriptions,
    // The executor turns a synchronous throw (a bad row, a closed database) into `error`.
    () => new Promise<FlightItem[]>((resolve) => resolve(listFlights(db))),
    [] as FlightItem[],
    [db],
  );
  return {
    data: result.updatedAt === undefined ? undefined : result.data,
    error: result.error,
  };
}

export function useFlight(id: string): Loaded<FlightItem | null> {
  const db = useStore();
  const result = useLiveQuery(
    flightSubscriptions,
    () => new Promise<FlightItem | null>((resolve) => resolve(readFlight(db, id))),
    null as FlightItem | null,
    [db, id],
  );
  return {
    data: result.updatedAt === undefined ? undefined : result.data,
    error: result.error,
  };
}
