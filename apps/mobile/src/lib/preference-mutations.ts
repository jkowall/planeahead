/**
 * The units and time-format toggles (increment 10, ruling T6). The choice is the account's
 * (`user_preferences` on the server, mirrored into the settings store from the sync feed), so a
 * toggle does two things: the zustand settings store changes at once (persisted to the kv-store,
 * so it holds offline and across a relaunch), and a `PATCH /v1/me/preferences` goes through the
 * outbox like every other network write, so the account and its other devices follow.
 *
 * Until that PATCH drains, a sync page can still carry the account's OLDER preferences. The
 * settings store would flip back and then forward again when the PATCH lands and the next page
 * brings it. `withPendingPatches` lays the queued patches, oldest first, over whatever the
 * server sent, so the device keeps showing what the user chose.
 */

import { UserPreferencesPatchSchema, type UserPreferences } from '@planeahead/shared';
import type { SqliteLike } from './db/sqlite-like';
import { commitWrite } from './db/store-signal';
import { enqueueMutation } from './sync/outbox';

export const PREFERENCES_MUTATION = { method: 'PATCH', path: '/v1/me/preferences' } as const;

export type PreferencesPatch = Partial<
  Pick<UserPreferences, 'distanceUnit' | 'temperatureUnit' | 'timeFormat' | 'showLocalTimes'>
>;

/** Queues the PATCH (validated by the API's own schema first). */
export function queuePreferencesPatch(
  db: SqliteLike,
  patch: PreferencesPatch,
  options: { readonly now?: Date } = {},
): void {
  const body = UserPreferencesPatchSchema.parse(patch);
  commitWrite(db, ['outbox'], () => {
    enqueueMutation(
      db,
      { ...PREFERENCES_MUTATION, body },
      options.now === undefined ? {} : { now: options.now },
    );
  });
}

/** The server's preferences with every still-queued patch applied on top, oldest first. */
export function withPendingPatches(db: SqliteLike, server: UserPreferences): UserPreferences {
  const rows = db.all<{ body: string | null }>(
    'SELECT body FROM outbox WHERE method = ? AND path = ? ORDER BY seq, rowid',
    [PREFERENCES_MUTATION.method, PREFERENCES_MUTATION.path],
  );
  let merged = server;
  for (const row of rows) {
    if (row.body === null) {
      continue;
    }
    try {
      const patch = UserPreferencesPatchSchema.safeParse(JSON.parse(row.body));
      if (patch.success) {
        const { distanceUnit, temperatureUnit, timeFormat, showLocalTimes, settings } = patch.data;
        merged = {
          distanceUnit: distanceUnit ?? merged.distanceUnit,
          temperatureUnit: temperatureUnit ?? merged.temperatureUnit,
          timeFormat: timeFormat ?? merged.timeFormat,
          showLocalTimes: showLocalTimes ?? merged.showLocalTimes,
          settings: settings ?? merged.settings,
        };
      }
    } catch {
      // A body this build cannot read changes nothing locally.
    }
  }
  return merged;
}
