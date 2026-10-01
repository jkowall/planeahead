/**
 * Trips, subscriptions, logbook and per-user counters. Sync entities carry `deleted_at`.
 * `flight_subscriptions.id` is minted on the client (ADR 0006) so offline adds survive retries.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  AIRPORT_CODE_SQL_RE,
  FLIGHT_NUMBER_SQL_RE,
  ICAO_AIRCRAFT_TYPE_SQL_RE,
  ICAO_CARRIER_SQL_RE,
  encrypted,
  formatCheck,
  id,
  inList,
  instant,
  literal,
  softDelete,
  timestamps,
} from './columns';
import { flightInstances } from './flights';
import { users } from './identity';

export const trips = pgTable(
  'trips',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    notes: text('notes'),
    color: text('color'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    index('trips_user_id_idx')
      .on(t.userId, t.updatedAt)
      .where(sql`${t.deletedAt} is null`),
    check(
      'trips_dates_check',
      sql`${t.startDate} is null or ${t.endDate} is null or ${t.startDate} <= ${t.endDate}`,
    ),
  ],
);

export const TRIP_ROLES = ['owner', 'editor', 'viewer'] as const;

export const tripMembers = pgTable(
  'trip_members',
  {
    id: id(),
    tripId: uuid('trip_id')
      .notNull()
      .references(() => trips.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('viewer'),
    invitedByUserId: uuid('invited_by_user_id'),
    joinedAt: instant('joined_at'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('trip_members_trip_id_user_id_key')
      .on(t.tripId, t.userId)
      .where(sql`${t.deletedAt} is null`),
    index('trip_members_user_id_idx').on(t.userId, t.updatedAt),
    check('trip_members_role_check', sql`${t.role} in (${inList(TRIP_ROLES)})`),
  ],
);

export const SUBSCRIPTION_SOURCES = [
  'manual',
  'import',
  'email',
  'share',
  'calendar',
  'api',
] as const;

/**
 * A user's interest in a flight instance. Restrict on the instance side so a subscribed flight
 * can never vanish from under a user; the merge path moves subscriptions first.
 */
export const flightSubscriptions = pgTable(
  'flight_subscriptions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    flightInstanceId: uuid('flight_instance_id')
      .notNull()
      .references(() => flightInstances.id, { onDelete: 'restrict' }),
    tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'set null' }),
    label: text('label'),
    seat: text('seat'),
    cabin: text('cabin'),
    ...encrypted('confirmationCode', 'confirmation_code'),
    notificationOverrides: jsonb('notification_overrides')
      .notNull()
      .default(sql`'{}'::jsonb`),
    muted: boolean('muted').notNull().default(false),
    source: text('source').notNull().default('manual'),
    /**
     * Whether this subscription holds one of the user's `live_tracked` counter slots (migration
     * 0003, increment 8): set when the subscribe took the slot because the flight was inside its
     * live window, or by the persist consumer when the flight enters it (ruling O3; false when the
     * cap refused the slot), cleared by the consumer when the flight is over and by the
     * unsubscribe, each releasing exactly the slot the flag records. Sent to the client in the
     * sync row (`liveTracked`).
     */
    liveTracked: boolean('live_tracked').notNull().default(false),
    /**
     * When the persist consumer last released this subscription's live-tracking slot because the
     * flight was over (migration 0009, increment 15 ruling Q1): the releasing instance row's own
     * Durable Object instant (`finishedAt`, else `lastRefreshedAt`), written in the UPDATE that
     * clears `live_tracked`. Null while the slot is held and wherever a slot is taken again. The
     * notify consumer pushes to a subscription that is live-tracked or was released at or after
     * the intent's `producedAt`, so the intent and the release of one alarm cannot drop the push.
     * A subscription the cap refused is never stamped. Server-only: not in the sync row.
     */
    liveTrackedReleasedAt: instant('live_tracked_released_at'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    uniqueIndex('flight_subscriptions_user_id_flight_instance_id_key')
      .on(t.userId, t.flightInstanceId)
      .where(sql`${t.deletedAt} is null`),
    index('flight_subscriptions_flight_instance_id_idx')
      .on(t.flightInstanceId)
      .where(sql`${t.deletedAt} is null`),
    index('flight_subscriptions_user_id_updated_at_idx').on(t.userId, t.updatedAt),
    index('flight_subscriptions_trip_id_idx')
      .on(t.tripId)
      .where(sql`${t.tripId} is not null`),
    check(
      'flight_subscriptions_source_check',
      sql`${t.source} in (${inList(SUBSCRIPTION_SOURCES)})`,
    ),
  ],
);

export const CABINS = ['economy', 'premium_economy', 'business', 'first'] as const;
export const LOGBOOK_SOURCES = ['auto', 'manual', 'import'] as const;

/**
 * Flown flights for stats and year-in-review. A sync entity per SYNC_ENTITIES in shared. The
 * airport columns hold `airports.icao` as the user knows it, which may be an ident-derived
 * pseudo code (`03N`), so they use the airport-code pattern rather than the strict ICAO form.
 */
export const logbookEntries = pgTable(
  'logbook_entries',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    flightInstanceId: uuid('flight_instance_id').references(() => flightInstances.id, {
      onDelete: 'set null',
    }),
    flightSubscriptionId: uuid('flight_subscription_id'),
    flightDate: date('flight_date', { mode: 'string' }).notNull(),
    operatingCarrierIcao: text('operating_carrier_icao'),
    flightNumber: text('flight_number'),
    originIcao: text('origin_icao').notNull(),
    destinationIcao: text('destination_icao').notNull(),
    distanceKm: integer('distance_km'),
    durationMinutes: integer('duration_minutes'),
    aircraftTypeIcao: text('aircraft_type_icao'),
    registration: text('registration'),
    seat: text('seat'),
    cabin: text('cabin'),
    notes: text('notes'),
    source: text('source').notNull().default('auto'),
    ...timestamps(),
    ...softDelete(),
  },
  (t) => [
    index('logbook_entries_user_id_flight_date_idx').on(t.userId, t.flightDate),
    index('logbook_entries_user_id_updated_at_idx').on(t.userId, t.updatedAt),
    check(
      'logbook_entries_cabin_check',
      sql`${t.cabin} is null or ${t.cabin} in (${inList(CABINS)})`,
    ),
    check('logbook_entries_source_check', sql`${t.source} in (${inList(LOGBOOK_SOURCES)})`),
    formatCheck('logbook_entries_origin_icao_check', t.originIcao, AIRPORT_CODE_SQL_RE),
    formatCheck('logbook_entries_destination_icao_check', t.destinationIcao, AIRPORT_CODE_SQL_RE),
    formatCheck(
      'logbook_entries_operating_carrier_icao_check',
      t.operatingCarrierIcao,
      ICAO_CARRIER_SQL_RE,
    ),
    formatCheck('logbook_entries_flight_number_check', t.flightNumber, FLIGHT_NUMBER_SQL_RE),
    formatCheck(
      'logbook_entries_aircraft_type_icao_check',
      t.aircraftTypeIcao,
      ICAO_AIRCRAFT_TYPE_SQL_RE,
    ),
  ],
);

export const userStatsYearly = pgTable(
  'user_stats_yearly',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    year: smallint('year').notNull(),
    flights: integer('flights').notNull().default(0),
    distanceKm: integer('distance_km').notNull().default(0),
    minutesAirborne: integer('minutes_airborne').notNull().default(0),
    airports: integer('airports').notNull().default(0),
    airlines: integer('airlines').notNull().default(0),
    countries: integer('countries').notNull().default(0),
    delayedFlights: integer('delayed_flights').notNull().default(0),
    cancelledFlights: integer('cancelled_flights').notNull().default(0),
    details: jsonb('details'),
    computedAt: instant('computed_at')
      .notNull()
      .default(sql`now()`),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('user_stats_yearly_user_id_year_key').on(t.userId, t.year),
    check('user_stats_yearly_year_check', sql`${t.year} between 1900 and 2200`),
  ],
);

export const COUNTER_SCOPES = ['user', 'email', 'ip', 'token', 'install'] as const;
export const COUNTER_KINDS = [
  'active_subscriptions',
  'instances_created',
  'magic_links',
  'refreshes',
  'anonymous_creations',
  'imports',
  'exports',
  'mcp_calls',
  'share_links',
  // Increment 8 (migration 0003, ruling K2).
  'live_tracked',
  'tracker_creations',
] as const;
/**
 * The per-flight refresh counter (ruling K2): `refresh:{flightKey}` under scope `user`, so one
 * user's refreshes of one flight on one UTC day are one row. The constraint accepts the prefix
 * followed by a flight key's character set.
 */
export const REFRESH_COUNTER_SQL_RE = '^refresh:[A-Z0-9-]{10,40}$';

/**
 * Exact quotas (the ratelimit binding is per-colo and permissive). `subject` is the user id
 * for scope `user`, a SHA-256 hex for `email` and `token`, and for `ip` the base64url
 * HMAC-SHA-256 of the client IP under a daily salt derived from a Workers secret (increment 8),
 * so no PII is stored. No FK: email and IP subjects are not users; user-scoped rows are deleted
 * by subject at account deletion. Monotonic counters use the UTC day as `window_start`; the two
 * non-monotonic ones (`active_subscriptions`, `live_tracked`) use the epoch and are decremented
 * on unsubscribe.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    id: id(),
    scope: text('scope').notNull(),
    subject: text('subject').notNull(),
    counter: text('counter').notNull(),
    windowStart: instant('window_start').notNull(),
    count: integer('count').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('usage_counters_scope_subject_counter_window_start_key').on(
      t.scope,
      t.subject,
      t.counter,
      t.windowStart,
    ),
    index('usage_counters_window_start_idx').on(t.windowStart),
    check('usage_counters_scope_check', sql`${t.scope} in (${inList(COUNTER_SCOPES)})`),
    check(
      'usage_counters_counter_check',
      sql`${t.counter} in (${inList(COUNTER_KINDS)}) or ${t.counter} ~ ${literal(REFRESH_COUNTER_SQL_RE)}`,
    ),
    check('usage_counters_count_check', sql`${t.count} >= 0`),
  ],
);
