/**
 * The offline store's schema (expo-sqlite, Drizzle). `drizzle-kit generate` (drizzle.config.ts,
 * driver `expo`) turns it into the SQL files and the bundled `migrations/migrations.js`; a
 * committed migration never changes (scripts/mobile-migrations-guard.mjs), a new one is appended.
 *
 * Shape rules. The app's live queries refresh on an explicit per-table signal sent after each
 * commit (src/lib/db/store-signal.ts), not on SQLite's per-row update hook, but the store keeps
 * the hook's rules anyway (ruling P6), so a hook-driven reader (Drizzle's own `useLiveQuery`,
 * a debugging session) never sees a silent write
 * (docs/increments/08-flight-routes-and-sync.facts.md section 4):
 *
 * - Every table is a rowid table. `WITHOUT ROWID` tables never fire the update hook.
 * - Writes are `INSERT ... ON CONFLICT (id) DO UPDATE`, never `INSERT OR REPLACE`: the REPLACE
 *   conflict path deletes the old row without firing the hook.
 * - Deletes always carry a WHERE clause: an unqualified `DELETE FROM t` takes the truncate
 *   optimisation and fires no hook at all (src/lib/sync/store.ts qualifies the reset too).
 * - A live query is keyed by its ROOT table, so the flight snapshot is denormalised onto
 *   `flight_subscriptions` (the list's root table) instead of living in a joined `flights`
 *   table whose signal the list would not listen to.
 *
 * Booleans are integers (0/1) and instants are ISO-8601 UTC strings, as the sync feed sends them.
 * JSON-shaped fields are stored as TEXT and parsed at the edge.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** The entities of `GET /v1/sync` (SYNC_ENTITIES in @planeahead/shared) plus the snapshot. */
export const flightSubscriptions = sqliteTable(
  'flight_subscriptions',
  {
    id: text('id').primaryKey(),
    flightKey: text('flight_key').notNull(),
    flightInstanceId: text('flight_instance_id'),
    tripId: text('trip_id'),
    label: text('label'),
    seat: text('seat'),
    cabin: text('cabin'),
    muted: integer('muted', { mode: 'boolean' }).notNull().default(false),
    /** JSON object (`notificationOverrides` on the wire). */
    notificationOverrides: text('notification_overrides').notNull().default('{}'),
    source: text('source').notNull().default('app'),
    liveTracked: integer('live_tracked', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),

    // The flight snapshot, denormalised from the page's `flights` array (keyed by flight key).
    // The columns the list sorts and renders by are their own columns; the rest of the snapshot
    // (timeline, codeshares, provider refs) rides in `snapshot_json` for the detail screen.
    flightStatus: text('flight_status'),
    scheduledOut: text('scheduled_out'),
    estimatedOut: text('estimated_out'),
    actualOut: text('actual_out'),
    scheduledIn: text('scheduled_in'),
    estimatedIn: text('estimated_in'),
    actualIn: text('actual_in'),
    originIcao: text('origin_icao'),
    originIata: text('origin_iata'),
    originTz: text('origin_tz'),
    destinationIcao: text('destination_icao'),
    destinationIata: text('destination_iata'),
    destinationTz: text('destination_tz'),
    originTerminal: text('origin_terminal'),
    originGate: text('origin_gate'),
    destinationTerminal: text('destination_terminal'),
    destinationGate: text('destination_gate'),
    baggageClaim: text('baggage_claim'),
    aircraftTypeIcao: text('aircraft_type_icao'),
    departureDelaySec: integer('departure_delay_sec'),
    arrivalDelaySec: integer('arrival_delay_sec'),
    snapshotJson: text('snapshot_json'),
    snapshotFetchedAt: text('snapshot_fetched_at'),
    snapshotSource: text('snapshot_source'),
  },
  (table) => [
    index('flight_subscriptions_flight_key_idx').on(table.flightKey),
    // The home list: live rows by scheduled departure (increment 10).
    index('flight_subscriptions_live_scheduled_out_idx').on(table.deletedAt, table.scheduledOut),
  ],
);

/** One row per account (`user_preferences` on the wire). */
export const userPreferences = sqliteTable('user_preferences', {
  id: text('id').primaryKey(),
  distanceUnit: text('distance_unit').notNull(),
  temperatureUnit: text('temperature_unit').notNull(),
  timeFormat: text('time_format').notNull(),
  showLocalTimes: integer('show_local_times', { mode: 'boolean' }).notNull(),
  /** JSON object: the app-owned extension bag. */
  settings: text('settings').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

/** One row per account (`notification_preferences` on the wire), kept whole as JSON. */
export const notificationPreferences = sqliteTable('notification_preferences', {
  id: text('id').primaryKey(),
  rowJson: text('row_json').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

/**
 * Entities in the feed's enum that have no writer in Phase 0. The tables exist now so the wire
 * format and the apply code do not change when they fill (increment 8 decision 10).
 */
export const trips = sqliteTable('trips', {
  id: text('id').primaryKey(),
  rowJson: text('row_json').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const tripMembers = sqliteTable('trip_members', {
  id: text('id').primaryKey(),
  rowJson: text('row_json').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

export const logbookEntries = sqliteTable('logbook_entries', {
  id: text('id').primaryKey(),
  rowJson: text('row_json').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
});

/**
 * The sync cursor, in the SAME database as the rows, so a page and the cursor that follows it
 * commit together (the kv-store is a separate file and cannot join that transaction). One row.
 */
export const syncState = sqliteTable(
  'sync_state',
  {
    id: integer('id').primaryKey(),
    /** Opaque; sent back unchanged as `?cursor=`. NULL means "pull the no-cursor snapshot". */
    cursor: text('cursor'),
    lastPulledAt: text('last_pulled_at'),
    /**
     * Set when the server refused the cursor (410 `resync_required`, 400 `invalid_cursor`): the
     * rows are kept and still shown, and the next page (the no-cursor snapshot) replaces them in
     * its own transaction. Cleared by that page.
     */
    resetPending: integer('reset_pending', { mode: 'boolean' }).notNull().default(false),
    /** The user whose session pulled the rows. A different session user empties the store first. */
    ownerUserId: text('owner_user_id'),
    /**
     * The store schema version of the build that wrote the rows (src/lib/sync/version.ts). A
     * build with a different one pulls the no-cursor snapshot, so rows an older build skipped
     * (a value it could not parse) come back.
     */
    storeVersion: text('store_version'),
  },
  (table) => [check('sync_state_single_row', sql`${table.id} = 1`)],
);

/**
 * Mutations waiting for the network. Drained oldest first with the row's `Idempotency-Key`, so
 * a retry after a lost response replays the stored answer instead of acting twice.
 */
export const outbox = sqliteTable(
  'outbox',
  {
    /** UUIDv7. Never the drain order: its clock can step backwards across a restart. */
    id: text('id').primaryKey(),
    method: text('method').notNull(),
    /** Path under the API origin, e.g. `/v1/flights`. */
    path: text('path').notNull(),
    /** JSON request body, or NULL for none. */
    body: text('body'),
    idempotencyKey: text('idempotency_key').notNull(),
    attempts: integer('attempts').notNull().default(0),
    /** Epoch milliseconds before which the item is not retried. */
    nextAttemptAt: integer('next_attempt_at').notNull().default(0),
    lastStatus: integer('last_status'),
    lastError: text('last_error'),
    createdAt: text('created_at').notNull(),
    /**
     * The drain order: one more than the largest queued `seq` at insert time, so it only grows
     * while anything is queued. Rows queued before this column existed keep 0 and drain first,
     * in rowid (insertion) order (src/lib/sync/outbox.ts).
     */
    seq: integer('seq').notNull().default(0),
    /**
     * The id of the row the mutation creates or changes (the client-minted `subscriptionId` of a
     * `POST /v1/flights`), or NULL. A snapshot that replaces the synced rows keeps every
     * `flight_subscriptions` row a queued subscribe names here: the server has not seen that row
     * yet, so the snapshot cannot carry it (src/lib/sync/store.ts).
     */
    entityId: text('entity_id'),
  },
  (table) => [
    index('outbox_next_attempt_idx').on(table.nextAttemptAt, table.id),
    index('outbox_seq_idx').on(table.seq),
  ],
);

export const schema = {
  flightSubscriptions,
  userPreferences,
  notificationPreferences,
  trips,
  tripMembers,
  logbookEntries,
  syncState,
  outbox,
};

export type FlightSubscriptionRow = typeof flightSubscriptions.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
