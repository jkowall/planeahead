/**
 * Cursor and reset primitives over the offline store.
 *
 * Every delete names rows with a WHERE clause: an unqualified `DELETE FROM t` takes SQLite's
 * truncate optimisation, which fires no update hook, and every `useLiveQuery` on the table would
 * keep showing the rows it had (docs/increments/08-flight-routes-and-sync.facts.md section 4).
 * `WHERE id IS NOT NULL` visits each row, so each deletion reaches the listeners.
 */

import type { SqliteLike } from '../db/sqlite-like';

/** The tables `GET /v1/sync` fills: a reset empties exactly these, and the cursor. */
export const SYNCED_TABLES = [
  'flight_subscriptions',
  'user_preferences',
  'notification_preferences',
  'trips',
  'trip_members',
  'logbook_entries',
] as const;

export type SyncedTable = (typeof SYNCED_TABLES)[number];

export function readCursor(db: SqliteLike): string | null {
  return (
    db.get<{ cursor: string | null }>('SELECT cursor FROM sync_state WHERE id = 1')?.cursor ?? null
  );
}

/** Called inside the page's transaction, so the cursor commits with the rows it follows. */
export function writeCursor(db: SqliteLike, cursor: string, pulledAt: string): void {
  db.run(
    'INSERT INTO sync_state (id, cursor, last_pulled_at) VALUES (1, ?, ?) ' +
      'ON CONFLICT (id) DO UPDATE SET cursor = excluded.cursor, last_pulled_at = excluded.last_pulled_at',
    [cursor, pulledAt],
  );
}

function deleteSynced(db: SqliteLike): void {
  for (const table of SYNCED_TABLES) {
    db.run(`DELETE FROM ${table} WHERE id IS NOT NULL`);
  }
  db.run('DELETE FROM sync_state WHERE id = 1');
}

/**
 * 410 `resync_required`: forget every synced row and the cursor, keep the outbox. Whatever
 * caused it (an anonymous device signing in to an existing account, a restored database epoch, a
 * purged retention window), the next pull is the no-cursor snapshot, and the queued mutations are
 * still this user's intent.
 */
export function resetSyncedState(db: SqliteLike): void {
  db.transaction(() => deleteSynced(db), { behavior: 'immediate' });
}

/**
 * 401 `account_deleted` (and sign-out): nothing local survives, the outbox included; its
 * mutations belong to an account that no longer exists.
 */
export function wipeLocalStore(db: SqliteLike): void {
  db.transaction(
    () => {
      deleteSynced(db);
      db.run('DELETE FROM outbox WHERE id IS NOT NULL');
    },
    { behavior: 'immediate' },
  );
}
