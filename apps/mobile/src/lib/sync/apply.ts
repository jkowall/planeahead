/**
 * Applies one `GET /v1/sync` page to the offline store (ADR 0012, docs/increments/09).
 *
 * One synchronous `BEGIN IMMEDIATE` transaction per page on the app's single connection: the
 * changes, then the page's flight snapshots, then the cursor. A crash between two pages leaves
 * the store at the last committed page with that page's cursor, never with rows past the cursor
 * or a cursor past the rows. The transaction is synchronous (expo-sqlite `*Sync`, Drizzle's Expo
 * session), so nothing else JavaScript does can interleave with it: no outbox write, no
 * live-query read (a live query's refresh is deferred to a trailing microtask, see
 * src/lib/db/live-query.ts).
 *
 * Writes follow the schema's hook rules (src/lib/db/schema.ts): `INSERT ... ON CONFLICT (id) DO
 * UPDATE` and `DELETE ... WHERE id = ?`, never `INSERT OR REPLACE`, never an unqualified delete.
 * A subscription upsert never touches the snapshot columns; the page's `flights` array is what
 * writes them, onto every subscription naming that flight key (the denormalisation `useLiveQuery`
 * needs, because it only hears about the root table).
 */

import {
  FlightSubscriptionRowV1,
  PreferenceSettingsSchema,
  UserPreferencesSchema,
  type SyncChangeV1,
  type SyncEnvelopeV1,
  type SyncFlightV1,
  type UserPreferences,
} from '@planeahead/shared';
import { z } from 'zod';
import { sqlBoolean, type SqliteLike } from '../db/sqlite-like';
import { writeCursor } from './store';

export interface ApplyOutcome {
  readonly changes: number;
  readonly flights: number;
  /** Changes whose row did not parse; reported (without the row) and skipped. */
  readonly skipped: readonly { readonly entity: string; readonly id: string }[];
  readonly cursor: string;
  /** The last `user_preferences` upsert of the page, for the settings store. */
  readonly preferences: UserPreferences | null;
}

const PreferencesRow = UserPreferencesSchema.extend({
  id: z.string().min(1),
  settings: PreferenceSettingsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
});

/** The loosely kept entities: stored whole, read by later increments. */
const OPAQUE_TABLES = {
  notification_preferences: 'notification_preferences',
  trips: 'trips',
  trip_members: 'trip_members',
  logbook_entries: 'logbook_entries',
} as const;

function upsertSubscription(db: SqliteLike, row: FlightSubscriptionRowV1): void {
  db.run(
    `INSERT INTO flight_subscriptions (
       id, flight_key, flight_instance_id, trip_id, label, seat, cabin, muted,
       notification_overrides, source, live_tracked, created_at, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       flight_key = excluded.flight_key,
       flight_instance_id = excluded.flight_instance_id,
       trip_id = excluded.trip_id,
       label = excluded.label,
       seat = excluded.seat,
       cabin = excluded.cabin,
       muted = excluded.muted,
       notification_overrides = excluded.notification_overrides,
       source = excluded.source,
       live_tracked = excluded.live_tracked,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`,
    [
      row.id,
      row.flightKey,
      row.flightInstanceId,
      row.tripId,
      row.label,
      row.seat,
      row.cabin,
      sqlBoolean(row.muted),
      JSON.stringify(row.notificationOverrides),
      row.source,
      sqlBoolean(row.liveTracked),
      row.createdAt,
      row.updatedAt,
      row.deletedAt,
    ],
  );
}

function upsertPreferences(db: SqliteLike, row: z.infer<typeof PreferencesRow>): void {
  db.run(
    `INSERT INTO user_preferences (
       id, distance_unit, temperature_unit, time_format, show_local_times, settings,
       created_at, updated_at, deleted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       distance_unit = excluded.distance_unit,
       temperature_unit = excluded.temperature_unit,
       time_format = excluded.time_format,
       show_local_times = excluded.show_local_times,
       settings = excluded.settings,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`,
    [
      row.id,
      row.distanceUnit,
      row.temperatureUnit,
      row.timeFormat,
      sqlBoolean(row.showLocalTimes),
      JSON.stringify(row.settings),
      row.createdAt,
      row.updatedAt,
      row.deletedAt,
    ],
  );
}

function upsertOpaque(db: SqliteLike, table: string, change: SyncChangeV1): void {
  const deletedAt = change.row?.['deletedAt'];
  db.run(
    `INSERT INTO ${table} (id, row_json, updated_at, deleted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       row_json = excluded.row_json,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`,
    [
      change.id,
      JSON.stringify(change.row ?? {}),
      change.updatedAt,
      typeof deletedAt === 'string' ? deletedAt : null,
    ],
  );
}

function tableFor(entity: SyncChangeV1['entity']): string {
  switch (entity) {
    case 'flight_subscriptions':
      return 'flight_subscriptions';
    case 'user_preferences':
      return 'user_preferences';
    default:
      return OPAQUE_TABLES[entity];
  }
}

function applySnapshot(db: SqliteLike, flight: SyncFlightV1): void {
  const { times } = flight;
  db.run(
    `UPDATE flight_subscriptions SET
       flight_status = ?, scheduled_out = ?, estimated_out = ?, actual_out = ?,
       scheduled_in = ?, estimated_in = ?, actual_in = ?,
       origin_icao = ?, origin_iata = ?, origin_tz = ?,
       destination_icao = ?, destination_iata = ?, destination_tz = ?,
       origin_terminal = ?, origin_gate = ?, destination_terminal = ?, destination_gate = ?,
       baggage_claim = ?, aircraft_type_icao = ?, departure_delay_sec = ?, arrival_delay_sec = ?,
       snapshot_json = ?, snapshot_fetched_at = ?, snapshot_source = ?
     WHERE flight_key = ?`,
    [
      flight.status,
      times.scheduledOut ?? null,
      times.estimatedOut ?? null,
      times.actualOut ?? null,
      times.scheduledIn ?? null,
      times.estimatedIn ?? null,
      times.actualIn ?? null,
      flight.origin.icao,
      flight.origin.iata ?? null,
      flight.origin.tz ?? null,
      flight.destination.icao,
      flight.destination.iata ?? null,
      flight.destination.tz ?? null,
      flight.originTerminal ?? null,
      flight.originGate ?? null,
      flight.destinationTerminal ?? null,
      flight.destinationGate ?? null,
      flight.baggageClaim ?? null,
      flight.aircraftTypeIcao ?? null,
      flight.departureDelaySec ?? null,
      flight.arrivalDelaySec ?? null,
      JSON.stringify(flight),
      flight.fetchedAt,
      flight.source,
      flight.key,
    ],
  );
}

/**
 * Applies `page` in one immediate transaction and returns what it did. A row that does not parse
 * is skipped and named in `skipped` (the caller reports it without the row's contents); the rest
 * of the page and the cursor still commit, because refusing the page would stall the feed on one
 * bad row for ever.
 */
export function applySyncPage(
  db: SqliteLike,
  page: SyncEnvelopeV1,
  now: () => Date = () => new Date(),
): ApplyOutcome {
  return db.transaction(
    () => {
      const skipped: { entity: string; id: string }[] = [];
      let preferences: UserPreferences | null = null;
      let changes = 0;

      for (const change of page.changes) {
        if (change.op === 'delete') {
          db.run(`DELETE FROM ${tableFor(change.entity)} WHERE id = ?`, [change.id]);
          changes += 1;
          continue;
        }
        if (change.entity === 'flight_subscriptions') {
          const row = FlightSubscriptionRowV1.safeParse(change.row);
          if (!row.success || row.data.id !== change.id) {
            skipped.push({ entity: change.entity, id: change.id });
            continue;
          }
          upsertSubscription(db, row.data);
        } else if (change.entity === 'user_preferences') {
          const row = PreferencesRow.safeParse(change.row);
          if (!row.success || row.data.id !== change.id) {
            skipped.push({ entity: change.entity, id: change.id });
            continue;
          }
          upsertPreferences(db, row.data);
          const { distanceUnit, temperatureUnit, timeFormat, showLocalTimes, settings } = row.data;
          preferences = { distanceUnit, temperatureUnit, timeFormat, showLocalTimes, settings };
        } else {
          upsertOpaque(db, OPAQUE_TABLES[change.entity], change);
        }
        changes += 1;
      }

      for (const flight of page.flights) {
        applySnapshot(db, flight);
      }

      writeCursor(db, page.cursor, now().toISOString());
      return { changes, flights: page.flights.length, skipped, cursor: page.cursor, preferences };
    },
    { behavior: 'immediate' },
  );
}
