/**
 * Cursor, owner and reset primitives over the offline store.
 *
 * Every delete names rows with a WHERE clause: an unqualified `DELETE FROM t` takes SQLite's
 * truncate optimisation, which fires no update hook (docs/increments/08-flight-routes-and-sync.facts.md
 * section 4). `WHERE id IS NOT NULL` visits each row. Every function that commits a write signals
 * the tables it touched once, after the commit (src/lib/db/store-signal.ts); the live queries
 * refresh on that signal.
 *
 * Resets, and when rows are deleted (increment 9 review, finding auth-and-store-4):
 *
 * - The server refusing the cursor (410 `resync_required`, 400 `invalid_cursor`) clears ONLY the
 *   cursor and marks `reset_pending`. The rows stay on screen and in the offline store; the
 *   no-cursor snapshot that follows deletes them and writes the snapshot and its cursor in ONE
 *   immediate transaction (src/lib/sync/apply.ts). A snapshot request that fails (offline, the
 *   infrequent traveller on airport wifi) leaves the last known rows, not an empty store.
 * - A session user who is not the store's owner (sync_state.owner_user_id) empties the synced
 *   tables at once, before any request: one account's rows are never shown under another.
 * - 401 `account_deleted` and sign-out wipe everything, the outbox included.
 *
 * What a delete of the synced rows keeps (increment 9 re-review, auth-and-store-4): every
 * `flight_subscriptions` row whose id a QUEUED subscribe names (`outbox.entity_id` on a
 * `POST /v1/flights`). The server has not seen that row, so no snapshot carries it; deleting it
 * would drop the flight from the list while its mutation still waits for the network, and bring
 * it back only after the POST drains and a later pull. Like the outbox, it is this installation's
 * own intent, so it also survives the owner wipe; the account wipe empties the outbox FIRST, so
 * nothing is named and nothing survives.
 *
 * Increment 10 review (ruling X7): a row a queued `DELETE /v1/flights/:id` names is kept too, as
 * the local tombstone it is. The server has not seen the unsubscribe yet, so a snapshot pulled
 * while the DELETE waits in its backoff still carries the row as live; the page apply re-stamps
 * the tombstone after it wrote the page (src/lib/sync/local-intent.ts), and the row goes for good
 * when the DELETE settles (src/lib/flights.ts). Rows a queued PATCH names are not kept: the
 * snapshot carries the server's version of those, and the PATCH overlay is the settings store's.
 */

import { notifyTablesChanged, type StoreTable } from '../db/store-signal';
import type { SqliteLike } from '../db/sqlite-like';

/** The tables `GET /v1/sync` fills: a snapshot replaces exactly these. */
export const SYNCED_TABLES = [
  'flight_subscriptions',
  'user_preferences',
  'notification_preferences',
  'trips',
  'trip_members',
  'logbook_entries',
] as const satisfies readonly StoreTable[];

export type SyncedTable = (typeof SYNCED_TABLES)[number];

export interface SyncState {
  readonly cursor: string | null;
  readonly resetPending: boolean;
  readonly ownerUserId: string | null;
  readonly storeVersion: string | null;
}

interface SyncStateDbRow {
  cursor: string | null;
  reset_pending: number;
  owner_user_id: string | null;
  store_version: string | null;
}

export function readSyncState(db: SqliteLike): SyncState | null {
  const row = db.get<SyncStateDbRow>(
    'SELECT cursor, reset_pending, owner_user_id, store_version FROM sync_state WHERE id = 1',
  );
  return row === null
    ? null
    : {
        cursor: row.cursor,
        resetPending: row.reset_pending !== 0,
        ownerUserId: row.owner_user_id,
        storeVersion: row.store_version,
      };
}

export function readCursor(db: SqliteLike): string | null {
  return readSyncState(db)?.cursor ?? null;
}

export interface SyncStateWrite {
  readonly cursor: string;
  readonly pulledAt: string;
  /** The session user the page was pulled for; null keeps the stored owner. */
  readonly ownerUserId: string | null;
  /** The build's store version; null keeps the stored one. */
  readonly storeVersion: string | null;
}

/** Called inside the page's transaction, so the cursor commits with the rows it follows. */
export function writeSyncState(db: SqliteLike, state: SyncStateWrite): void {
  db.run(
    'INSERT INTO sync_state (id, cursor, last_pulled_at, reset_pending, owner_user_id, store_version) ' +
      'VALUES (1, ?, ?, 0, ?, ?) ' +
      'ON CONFLICT (id) DO UPDATE SET cursor = excluded.cursor, ' +
      'last_pulled_at = excluded.last_pulled_at, reset_pending = 0, ' +
      'owner_user_id = coalesce(excluded.owner_user_id, sync_state.owner_user_id), ' +
      'store_version = coalesce(excluded.store_version, sync_state.store_version)',
    [state.cursor, state.pulledAt, state.ownerUserId, state.storeVersion],
  );
}

/** The one mutation whose row the server cannot know until it drains (see the header). */
export const SUBSCRIBE_MUTATION = { method: 'POST', path: '/v1/flights' } as const;

/** An unsubscribe: `DELETE /v1/flights/:id`, naming the row it tombstones as `entity_id`. */
export const UNSUBSCRIBE_METHOD = 'DELETE';
export const UNSUBSCRIBE_PATH_PREFIX = '/v1/flights/';

export function isUnsubscribe(item: { readonly method: string; readonly path: string }): boolean {
  return item.method === UNSUBSCRIBE_METHOD && item.path.startsWith(UNSUBSCRIBE_PATH_PREFIX);
}

/**
 * The ids of the subscriptions this installation's queued mutations still hold locally: a
 * subscribe's optimistic row and an unsubscribe's tombstone (see the header). A SQL fragment with
 * its four parameters, for `id IN (...)`.
 */
const QUEUED_FLIGHT_INTENT_SQL = `SELECT entity_id FROM outbox
   WHERE entity_id IS NOT NULL
     AND ((method = ? AND path = ?) OR (method = ? AND substr(path, 1, ?) = ?))`;

function queuedFlightIntentParams(): [string, string, string, number, string] {
  return [
    SUBSCRIBE_MUTATION.method,
    SUBSCRIBE_MUTATION.path,
    UNSUBSCRIBE_METHOD,
    UNSUBSCRIBE_PATH_PREFIX.length,
    UNSUBSCRIBE_PATH_PREFIX,
  ];
}

/**
 * Deletes every synced row except a subscription a queued subscribe or unsubscribe names (see
 * the header); the caller holds the transaction.
 */
export function deleteSyncedRows(db: SqliteLike): void {
  for (const table of SYNCED_TABLES) {
    if (table === 'flight_subscriptions') {
      db.run(
        `DELETE FROM flight_subscriptions WHERE id IS NOT NULL AND id NOT IN (${QUEUED_FLIGHT_INTENT_SQL})`,
        queuedFlightIntentParams(),
      );
      continue;
    }
    db.run(`DELETE FROM ${table} WHERE id IS NOT NULL`);
  }
}

/**
 * The server refused the cursor: forget it and mark the reset, keep every row. The next pull has
 * no cursor, and its snapshot replaces the rows in one transaction. One statement, so it needs no
 * transaction of its own; with no sync_state row there is no cursor to forget.
 */
export function requestSnapshot(db: SqliteLike): void {
  db.run('UPDATE sync_state SET cursor = NULL, reset_pending = 1 WHERE id = 1');
  notifyTablesChanged(['sync_state']);
}

/**
 * The session user is not the store's owner: the synced rows and the sync state go at once. The
 * outbox stays: it only ever holds this installation's own intent, and signing out (a different
 * person) already wiped it.
 */
export function wipeSyncedRows(db: SqliteLike): void {
  db.transaction(
    () => {
      deleteSyncedRows(db);
      db.run('DELETE FROM sync_state WHERE id = 1');
    },
    { behavior: 'immediate' },
  );
  notifyTablesChanged([...SYNCED_TABLES, 'sync_state']);
}

/**
 * 401 `account_deleted` (and sign-out): nothing local survives, the outbox included; its
 * mutations belong to an account that no longer exists. The outbox goes first, so the delete of
 * the synced rows finds no queued subscribe to keep a row for.
 */
export function wipeLocalStore(db: SqliteLike): void {
  db.transaction(
    () => {
      db.run('DELETE FROM outbox WHERE id IS NOT NULL');
      deleteSyncedRows(db);
      db.run('DELETE FROM sync_state WHERE id = 1');
    },
    { behavior: 'immediate' },
  );
  notifyTablesChanged([...SYNCED_TABLES, 'sync_state', 'outbox']);
}
