/**
 * The user half of the sync feed's write path (increment 8, ruling K4): the shape an entity takes
 * in a change row, and the one function that appends a `user_sync_changes` row. Every caller runs
 * it inside the SAME `db.transaction()` (one `sql.begin()` on one connection) as the entity write
 * it records: Hyperdrive may give one invocation several connections, and a change row committed
 * apart from its entity could be seen by a pull without it, or survive its rollback.
 */

import {
  flightSubscriptions,
  notificationPreferences,
  userPreferences,
  userSyncChanges,
} from '@planeahead/db';
import type { FlightKey, FlightSubscriptionRowV1, SyncEntity, SyncOp } from '@planeahead/shared';
import type { DbOrTx } from './flight-registry';

export type FlightSubscriptionRecord = typeof flightSubscriptions.$inferSelect;
export type UserPreferencesRecord = typeof userPreferences.$inferSelect;
export type NotificationPreferencesRecord = typeof notificationPreferences.$inferSelect;

/** `flight_subscriptions` as the client sees it; `live_tracked` is server bookkeeping and stays. */
export function subscriptionSyncRow(
  row: FlightSubscriptionRecord,
  flightKey: FlightKey,
): FlightSubscriptionRowV1 {
  const overrides = row.notificationOverrides;
  return {
    id: row.id,
    flightKey,
    flightInstanceId: row.flightInstanceId,
    tripId: row.tripId,
    label: row.label,
    seat: row.seat,
    cabin: row.cabin,
    muted: row.muted,
    notificationOverrides:
      typeof overrides === 'object' && overrides !== null && !Array.isArray(overrides)
        ? (overrides as Record<string, unknown>)
        : {},
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** `user_preferences` as the client sees it. */
export function preferencesSyncRow(row: UserPreferencesRecord): Record<string, unknown> {
  return {
    id: row.id,
    distanceUnit: row.distanceUnit,
    temperatureUnit: row.temperatureUnit,
    timeFormat: row.timeFormat,
    showLocalTimes: row.showLocalTimes,
    settings: row.settings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** `notification_preferences` as the client sees it. */
export function notificationPreferencesSyncRow(
  row: NotificationPreferencesRecord,
): Record<string, unknown> {
  return {
    id: row.id,
    pushEnabled: row.pushEnabled,
    emailEnabled: row.emailEnabled,
    liveActivitiesEnabled: row.liveActivitiesEnabled,
    quietHoursStartMinutes: row.quietHoursStartMinutes,
    quietHoursEndMinutes: row.quietHoursEndMinutes,
    quietHoursTz: row.quietHoursTz,
    events: row.events,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

export interface UserChange {
  readonly userId: string;
  readonly entity: SyncEntity;
  readonly entityId: string;
  readonly op: SyncOp;
  readonly row: Record<string, unknown>;
}

/**
 * Appends one change row. Insert only, never an upsert: `xid` is the column DEFAULT
 * `pg_current_xact_id()`, which fires on insert and never on the `DO UPDATE` branch.
 */
export async function appendUserChange(tx: DbOrTx, change: UserChange): Promise<void> {
  await tx.insert(userSyncChanges).values({
    userId: change.userId,
    entity: change.entity,
    entityId: change.entityId,
    op: change.op,
    row: change.row,
  });
}
