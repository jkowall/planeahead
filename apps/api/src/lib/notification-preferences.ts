/**
 * `notification_preferences` writes and reads for `/v1/me/preferences` (increment 15, ruling
 * N10). The row is one per user and a sync entity: every write appends its `user_sync_changes`
 * row in the caller's transaction (increment 8, ruling K4).
 *
 * A patch MERGES into the stored toggles in one statement (`events || patch`), so two devices
 * changing different toggles at once both win, and `push_enabled` changes only when the patch
 * names it. A tombstoned row is revived from the defaults, not from what it held: notify already
 * treats it as absent, and the client must not see toggles it never set come back.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { notificationPreferences } from '@planeahead/db';
import {
  effectiveNotificationPreferences,
  uuidv7,
  type NotificationPreferences,
  type NotificationPreferencesPatch,
} from '@planeahead/shared';
import type { DbOrTx } from './flight-registry';
import { appendUserChange, notificationPreferencesSyncRow } from './sync-rows';

/** The user's effective notification preferences (the defaults without a live row). */
export async function readNotificationPreferences(
  db: DbOrTx,
  userId: string,
): Promise<NotificationPreferences> {
  const [row] = await db
    .select({
      pushEnabled: notificationPreferences.pushEnabled,
      events: notificationPreferences.events,
    })
    .from(notificationPreferences)
    .where(
      and(eq(notificationPreferences.userId, userId), isNull(notificationPreferences.deletedAt)),
    )
    .limit(1);
  return effectiveNotificationPreferences(row ?? null);
}

/** Merges `patch` into the user's row (creating it), records the change, returns the result. */
export async function patchNotificationPreferences(
  tx: DbOrTx,
  userId: string,
  patch: NotificationPreferencesPatch,
): Promise<NotificationPreferences> {
  const t = notificationPreferences;
  const live = sql`${t.deletedAt} is null`;
  const events = JSON.stringify(patch.events ?? {});
  const [written] = await tx
    .insert(t)
    .values({
      id: uuidv7(),
      userId,
      pushEnabled: patch.pushEnabled ?? true,
      events: patch.events ?? {},
    })
    .onConflictDoUpdate({
      target: t.userId,
      set: {
        pushEnabled:
          patch.pushEnabled ?? sql`case when ${live} then ${t.pushEnabled} else true end`,
        events: sql`(case when ${live} and jsonb_typeof(${t.events}) = 'object'
          then ${t.events} else '{}'::jsonb end) || ${events}::jsonb`,
        deletedAt: null,
      },
    })
    .returning();
  if (written === undefined) {
    throw new Error('notification preferences upsert returned no row');
  }
  await appendUserChange(tx, {
    userId,
    entity: 'notification_preferences',
    entityId: written.id,
    op: 'upsert',
    row: notificationPreferencesSyncRow(written),
  });
  return effectiveNotificationPreferences(written);
}
