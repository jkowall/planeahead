/**
 * The flight screens' reads (increment 10, ruling T5): every one through the increment 9
 * `useLiveQuery` on `flight_subscriptions`, so a committed write re-runs it once, however many
 * rows it touched (src/lib/db/store-signal.ts). Plain SQL on the `SqliteLike` seam, so Jest runs
 * the same statements against the in-memory SQLite that the device runs against expo-sqlite.
 *
 * The list leaves out a superseded pending add (its flight is already a live row; see
 * src/lib/sync/local-intent.ts). The detail follows an optimistic id the outbox's success hook
 * replaced with the server's (src/lib/flight-replacements.ts), so a screen opened on an "Adding"
 * row shows the flight rather than "Flight not found" once the server answers under its own id.
 */

import { useRef } from 'react';
import type { SqliteLike } from './db/sqlite-like';
import { useLiveQuery } from './db/live-query';
import { flightSubscriptions } from './db/schema';
import { useStore } from './db/store-context';
import { toFlightItem, type FlightItem, type FlightRowRecord } from './flight-model';
import { forgetReplacement, readReplacement } from './flight-replacements';

/** The list's one statement (the coalescing test counts how often it runs). */
export const LIST_FLIGHTS_SQL =
  'SELECT * FROM flight_subscriptions WHERE deleted_at IS NULL AND superseded = 0 ORDER BY scheduled_out, id';

/** Every live (not tombstoned) subscription, pending adds included, superseded ones not. */
export function listFlights(db: SqliteLike): FlightItem[] {
  return db.all<FlightRowRecord>(LIST_FLIGHTS_SQL).map(toFlightItem);
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

/** How many recorded replacements one read follows (an id is replaced at most once in practice). */
const MAX_HOPS = 3;

/**
 * `readFlight`, following a recorded replacement when `id` is gone: returns the id it ended on
 * and the row there. Once a row is found, the replacements followed to it are forgotten (ruling
 * Y5), so the caller keeps the id it ended on.
 */
export function readFlightFollowing(
  db: SqliteLike,
  id: string,
): { readonly id: string; readonly item: FlightItem | null } {
  const followed: string[] = [];
  let current = id;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const item = readFlight(db, current);
    if (item !== null) {
      for (const from of followed) {
        forgetReplacement(from);
      }
      return { id: current, item };
    }
    const next = hop < MAX_HOPS ? readReplacement(current) : null;
    if (next === null) {
      return { id: current, item: null };
    }
    followed.push(current);
    current = next;
  }
  return { id: current, item: null };
}

export function useFlight(id: string): Loaded<FlightItem | null> {
  const db = useStore();
  // The route's id, and the id each read ended on after following replacements.
  const followed = useRef(new Map<string, string>());
  const result = useLiveQuery(
    flightSubscriptions,
    () =>
      new Promise<FlightItem | null>((resolve) => {
        const found = readFlightFollowing(db, followed.current.get(id) ?? id);
        if (found.id !== id) {
          followed.current.set(id, found.id);
        }
        resolve(found.item);
      }),
    null as FlightItem | null,
    [db, id],
  );
  return {
    data: result.updatedAt === undefined ? undefined : result.data,
    error: result.error,
  };
}
