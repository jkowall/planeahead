/**
 * This installation's own intent over a sync page (increment 10 review, rulings X3 and X7): what
 * the page apply (src/lib/sync/apply.ts) re-applies inside the page's transaction, after it wrote
 * the page, so a pull never undoes something the user did on this phone and the server has not
 * heard about yet. Every function runs inside the caller's transaction and never opens its own.
 *
 * - Local-only columns (`finished_at`, `added_as`, `superseded`, src/lib/db/schema.ts) are not on
 *   the wire, so a snapshot replace, which deletes the synced rows and writes the page's, would
 *   drop them. `readLocalOnly` reads them before the delete and `restoreLocalOnly` writes them
 *   back onto the page's rows with the same id.
 * - A row a queued `DELETE /v1/flights/:id` names is this phone's tombstone. The snapshot's copy
 *   of that row is still live (the server has not seen the DELETE, which may be waiting in its 5xx
 *   backoff), so `reapplyQueuedUnsubscribes` stamps `deleted_at` again; the row is kept through a
 *   replace (src/lib/sync/store.ts) and goes for good when the DELETE settles.
 * - A pending add (the optimistic row of a queued `POST /v1/flights`) carries a placeholder key
 *   that never equals a canonical one, so it cannot be matched to a server row by key. It is
 *   matched by designator and origin-local date instead (`pendingMatchesLive`): a pending row the
 *   store already holds as a live row is marked `superseded` and hidden from the list, and its POST
 *   stays queued, so the server's 200 `created: false` settles it (src/lib/flights.ts).
 */

import type { SqliteLike } from '../db/sqlite-like';
import {
  PENDING_KEY_PREFIX,
  pendingMatchesLive,
  toFlightItem,
  type FlightRowRecord,
} from '../flight-model';
import { UNSUBSCRIBE_METHOD, UNSUBSCRIBE_PATH_PREFIX } from './store';

export interface LocalOnlyColumns {
  readonly id: string;
  readonly finished_at: string | null;
  readonly added_as: string | null;
  readonly superseded: number;
}

/** The local-only columns of every row that has one set; read before a replace deletes rows. */
export function readLocalOnly(db: SqliteLike): LocalOnlyColumns[] {
  return db.all<LocalOnlyColumns>(
    `SELECT id, finished_at, added_as, superseded FROM flight_subscriptions
       WHERE finished_at IS NOT NULL OR added_as IS NOT NULL OR superseded <> 0`,
  );
}

/** Writes them back onto the rows with the same id (a row the page did not carry is gone). */
export function restoreLocalOnly(db: SqliteLike, rows: readonly LocalOnlyColumns[]): number {
  let changed = 0;
  for (const row of rows) {
    changed += db.run(
      `UPDATE flight_subscriptions SET
         finished_at = coalesce(finished_at, ?),
         added_as = coalesce(added_as, ?),
         superseded = ?
       WHERE id = ?`,
      [row.finished_at, row.added_as, row.superseded, row.id],
    ).changes;
  }
  return changed;
}

/** Re-stamps the tombstone of every row a queued unsubscribe names; returns the rows changed. */
export function reapplyQueuedUnsubscribes(db: SqliteLike, now: Date): number {
  return db.run(
    `UPDATE flight_subscriptions SET deleted_at = ?
       WHERE deleted_at IS NULL AND id IN (
         SELECT entity_id FROM outbox
         WHERE entity_id IS NOT NULL AND method = ? AND substr(path, 1, ?) = ?
       )`,
    [
      now.toISOString(),
      UNSUBSCRIBE_METHOD,
      UNSUBSCRIBE_PATH_PREFIX.length,
      UNSUBSCRIBE_PATH_PREFIX,
    ],
  ).changes;
}

/**
 * Marks each live pending row superseded when a live synced row names the same flight (same
 * designator and date), and clears the mark when none does any more; returns the rows changed.
 */
export function markSupersededPending(db: SqliteLike): number {
  const prefix = [PENDING_KEY_PREFIX.length, PENDING_KEY_PREFIX] as const;
  const pending = db.all<FlightRowRecord>(
    'SELECT * FROM flight_subscriptions WHERE deleted_at IS NULL AND substr(flight_key, 1, ?) = ?',
    [...prefix],
  );
  if (pending.length === 0) {
    return 0;
  }
  const live = db
    .all<FlightRowRecord>(
      'SELECT * FROM flight_subscriptions WHERE deleted_at IS NULL AND substr(flight_key, 1, ?) <> ?',
      [...prefix],
    )
    .map(toFlightItem);
  let changed = 0;
  for (const row of pending) {
    const item = toFlightItem(row);
    const superseded = live.some((candidate) => pendingMatchesLive(item, candidate));
    if (superseded !== item.superseded) {
      changed += db.run('UPDATE flight_subscriptions SET superseded = ? WHERE id = ?', [
        superseded ? 1 : 0,
        row.id,
      ]).changes;
    }
  }
  return changed;
}
