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
 *
 * Increment 16 (ruling C11): the notification toggles take the same path. A toggle queues the
 * same PATCH with `{ notifications: { pushEnabled } }` or `{ notifications: { events: { ... } } }`
 * (increment 15's `PreferencesPatchSchema`), and `withPendingNotificationPatches` keeps it over
 * the older `notification_preferences` a sync page carries.
 */

import {
  PreferencesPatchSchema,
  UserPreferencesPatchSchema,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
  type PreferencesPatch as PreferencesPatchBody,
  type UserPreferences,
} from '@planeahead/shared';
import type { SqliteLike } from './db/sqlite-like';
import { commitWrite } from './db/store-signal';
import { withNotificationsPatch } from './settings';
import { enqueueMutation } from './sync/outbox';

export const PREFERENCES_MUTATION = { method: 'PATCH', path: '/v1/me/preferences' } as const;

export type PreferencesPatch = Partial<
  Pick<UserPreferences, 'distanceUnit' | 'temperatureUnit' | 'timeFormat' | 'showLocalTimes'>
>;

function enqueue(db: SqliteLike, body: PreferencesPatchBody, now: Date | undefined): void {
  commitWrite(db, ['outbox'], () => {
    enqueueMutation(db, { ...PREFERENCES_MUTATION, body }, now === undefined ? {} : { now });
  });
}

/** Queues the PATCH (validated by the API's own schema first). */
export function queuePreferencesPatch(
  db: SqliteLike,
  patch: PreferencesPatch,
  options: { readonly now?: Date } = {},
): void {
  enqueue(db, UserPreferencesPatchSchema.parse(patch), options.now);
}

/** Queues a notification toggle as `{ notifications: patch }`, validated the same way. */
export function queueNotificationsPatch(
  db: SqliteLike,
  patch: NotificationPreferencesPatch,
  options: { readonly now?: Date } = {},
): void {
  enqueue(db, PreferencesPatchSchema.parse({ notifications: patch }), options.now);
}

/**
 * Every still-queued preferences PATCH, oldest first, as the API's contract reads it. A body this
 * build cannot read changes nothing locally.
 */
function queuedPatches(db: SqliteLike): PreferencesPatchBody[] {
  const rows = db.all<{ body: string | null }>(
    'SELECT body FROM outbox WHERE method = ? AND path = ? ORDER BY seq, rowid',
    [PREFERENCES_MUTATION.method, PREFERENCES_MUTATION.path],
  );
  const patches: PreferencesPatchBody[] = [];
  for (const row of rows) {
    if (row.body === null) {
      continue;
    }
    try {
      const patch = PreferencesPatchSchema.safeParse(JSON.parse(row.body));
      if (patch.success) {
        patches.push(patch.data);
      }
    } catch {
      // Not JSON: skipped like any other unreadable body.
    }
  }
  return patches;
}

/** The server's preferences with every still-queued patch applied on top, oldest first. */
export function withPendingPatches(db: SqliteLike, server: UserPreferences): UserPreferences {
  let merged = server;
  for (const patch of queuedPatches(db)) {
    const { distanceUnit, temperatureUnit, timeFormat, showLocalTimes, settings } = patch;
    merged = {
      distanceUnit: distanceUnit ?? merged.distanceUnit,
      temperatureUnit: temperatureUnit ?? merged.temperatureUnit,
      timeFormat: timeFormat ?? merged.timeFormat,
      showLocalTimes: showLocalTimes ?? merged.showLocalTimes,
      settings: settings ?? merged.settings,
    };
  }
  return merged;
}

/** The same for the notification preferences: every queued `notifications` part, oldest first. */
export function withPendingNotificationPatches(
  db: SqliteLike,
  server: NotificationPreferences,
): NotificationPreferences {
  let merged = server;
  for (const { notifications } of queuedPatches(db)) {
    if (notifications !== undefined) {
      merged = withNotificationsPatch(merged, notifications);
    }
  }
  return merged;
}
