/**
 * Notifications. `notification_deliveries` has no FK to users (or to notifications, which
 * cascade from users): delivery evidence must outlive the account for abuse and billing
 * disputes, so it is keyed by a pseudonymous `subject_id`.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, createdOnly, id, inList, instant, softDelete, timestamps } from './columns';
import { flightInstances } from './flights';
import { devices, users } from './identity';
import { flightSubscriptions } from './trips';

/** Sync entity (tombstoned). One row per user; per-flight overrides live on the subscription. */
export const notificationPreferences = pgTable(
  'notification_preferences',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pushEnabled: boolean('push_enabled').notNull().default(true),
    emailEnabled: boolean('email_enabled').notNull().default(false),
    liveActivitiesEnabled: boolean('live_activities_enabled').notNull().default(true),
    quietHoursStartMinutes: smallint('quiet_hours_start_minutes'),
    quietHoursEndMinutes: smallint('quiet_hours_end_minutes'),
    quietHoursTz: text('quiet_hours_tz'),
    events: jsonb('events')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('notification_preferences_user_id_key').on(t.userId),
    check(
      'notification_preferences_quiet_hours_check',
      sql`(${t.quietHoursStartMinutes} is null or ${t.quietHoursStartMinutes} between 0 and 1439) and (${t.quietHoursEndMinutes} is null or ${t.quietHoursEndMinutes} between 0 and 1439)`,
    ),
  ],
);

/**
 * `apns_live_activity_push_to_start` (increment 11, migration 0004) is the ActivityKit
 * push-to-start token the app registers through `POST /v1/devices`: one per installation,
 * rotating rarely, so it fits this table's `(kind, token)` model. Per-activity update tokens do
 * NOT: they are N per device and rotate during an activity, and land in `live_activities` in
 * Phase 1. `apns_live_activity_start` is increment 3's name for the same idea, which no client
 * ever sent; ruling V5 added the new kind rather than renaming, so it stays accepted until a
 * later migration retires it (ADR 0008, open decisions).
 */
export const PUSH_TOKEN_KINDS = [
  'apns',
  'fcm',
  'apns_live_activity_start',
  'expo',
  'apns_live_activity_push_to_start',
] as const;
export const PUSH_ENVIRONMENTS = ['sandbox', 'production'] as const;

export const pushTokens = pgTable(
  'push_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    token: text('token').notNull(),
    environment: text('environment').notNull().default('production'),
    invalidatedAt: instant('invalidated_at'),
    lastUsedAt: instant('last_used_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('push_tokens_kind_token_key').on(t.kind, t.token),
    index('push_tokens_user_id_idx')
      .on(t.userId)
      .where(sql`${t.invalidatedAt} is null`),
    index('push_tokens_device_id_idx').on(t.deviceId),
    check('push_tokens_kind_check', sql`${t.kind} in (${inList(PUSH_TOKEN_KINDS)})`),
    check('push_tokens_environment_check', sql`${t.environment} in (${inList(PUSH_ENVIRONMENTS)})`),
  ],
);

/** One ActivityKit Live Activity per subscription per device; ends with the flight. */
export const liveActivities = pgTable(
  'live_activities',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    flightSubscriptionId: uuid('flight_subscription_id').notNull(),
    flightInstanceId: uuid('flight_instance_id')
      .notNull()
      .references(() => flightInstances.id, { onDelete: 'cascade' }),
    activityId: text('activity_id').notNull(),
    pushToken: text('push_token').notNull(),
    pushTokenUpdatedAt: instant('push_token_updated_at')
      .notNull()
      .default(sql`now()`),
    contentStateHash: bytea('content_state_hash'),
    lastPushedAt: instant('last_pushed_at'),
    staleAt: instant('stale_at'),
    endedAt: instant('ended_at'),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'live_activities_subscription_fk',
      columns: [t.flightSubscriptionId],
      foreignColumns: [flightSubscriptions.id],
    }).onDelete('cascade'),
    uniqueIndex('live_activities_activity_id_key').on(t.activityId),
    index('live_activities_flight_instance_id_idx')
      .on(t.flightInstanceId)
      .where(sql`${t.endedAt} is null`),
    index('live_activities_user_id_idx').on(t.userId),
  ],
);

export const NOTIFICATION_KINDS = [
  'schedule_change',
  'gate_change',
  'delay',
  'cancellation',
  'diversion',
  'boarding',
  'departure',
  'arrival',
  'baggage',
  'reminder',
  'trip_share',
  'system',
] as const;

/**
 * In-app inbox row; deliveries per channel are in notification_deliveries. `dedupe_key` is
 * unique per user, not globally: the notify consumer fans one flight event out to every
 * subscriber with the same key (flight key, event, value), and each of them must get a row.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    flightInstanceId: uuid('flight_instance_id'),
    flightSubscriptionId: uuid('flight_subscription_id'),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    data: jsonb('data'),
    readAt: instant('read_at'),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('notifications_user_id_dedupe_key_key').on(t.userId, t.dedupeKey),
    index('notifications_user_id_created_at_idx').on(t.userId, sql`${t.createdAt} desc`),
    check('notifications_kind_check', sql`${t.kind} in (${inList(NOTIFICATION_KINDS)})`),
  ],
);

export const DELIVERY_CHANNELS = ['apns', 'fcm', 'email', 'live_activity'] as const;
export const DELIVERY_STATUSES = [
  'queued',
  'sent',
  'failed',
  'invalid_token',
  'suppressed',
] as const;

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: id(),
    notificationId: uuid('notification_id').notNull(),
    subjectId: uuid('subject_id').notNull(),
    channel: text('channel').notNull(),
    pushTokenId: uuid('push_token_id'),
    status: text('status').notNull().default('queued'),
    attempts: smallint('attempts').notNull().default(0),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    sentAt: instant('sent_at'),
    ...createdOnly(),
  },
  (t) => [
    index('notification_deliveries_created_at_brin_idx').using('brin', t.createdAt),
    index('notification_deliveries_notification_id_idx').on(t.notificationId),
    index('notification_deliveries_subject_id_created_at_idx').on(t.subjectId, t.createdAt),
    check(
      'notification_deliveries_channel_check',
      sql`${t.channel} in (${inList(DELIVERY_CHANNELS)})`,
    ),
    check(
      'notification_deliveries_status_check',
      sql`${t.status} in (${inList(DELIVERY_STATUSES)})`,
    ),
  ],
);
