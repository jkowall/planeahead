/**
 * Applies one `GET /v1/sync` page to the offline store (ADR 0012, docs/increments/09).
 *
 * One synchronous `BEGIN IMMEDIATE` transaction per page on the app's single connection: the
 * changes, then the page's flight snapshots, then the cursor. A crash between two pages leaves
 * the store at the last committed page with that page's cursor, never with rows past the cursor
 * or a cursor past the rows. The transaction is synchronous (expo-sqlite `*Sync`, Drizzle's Expo
 * session), so nothing else JavaScript does can interleave with it: no outbox write, no
 * live-query read. After the COMMIT the page signals the tables it touched, once
 * (src/lib/db/store-signal.ts), which is what the live queries re-run on: a 200-row page is one
 * re-run, not 200.
 *
 * A page fetched WITHOUT a cursor is the snapshot of everything the user owns (increment 8 serves
 * it as one page): it replaces the synced rows, and the delete, the snapshot and its cursor are
 * the same transaction (increment 9 review, auth-and-store-4). The delete keeps every
 * subscription a QUEUED subscribe names (`outbox.entity_id`, src/lib/sync/store.ts): the server
 * has not seen that row, so the snapshot cannot carry it, and the store, not a later writer,
 * enforces that it stays (increment 9 re-review).
 *
 * Forward compatibility (auth-and-store-5): the page's shell (`rpcVersion`, `serverTime`,
 * `cursor`, `hasMore`) is parsed strictly by the caller, but `changes[]` and `flights[]` arrive
 * as arrays of unknown and each element is parsed here on its own. An element this build cannot
 * read (a provider id, an entity or an op a newer server added) is skipped and reported by
 * entity, id and the failing field, never by value; the rest of the page and the cursor still
 * commit, because refusing the page would stall the feed on one value for ever. The store's
 * schema version (src/lib/sync/version.ts) is written with the cursor, and a build with a
 * different one pulls the snapshot again, which brings the skipped rows back.
 *
 * Writes follow the schema's hook rules (src/lib/db/schema.ts): `INSERT ... ON CONFLICT (id) DO
 * UPDATE` and `DELETE ... WHERE id = ?`, never `INSERT OR REPLACE`, never an unqualified delete.
 * A subscription upsert never touches the snapshot columns; the page's `flights` array is what
 * writes them, onto every subscription naming that flight key (the denormalisation the live
 * query needs, because it is keyed by its root table).
 */

import {
  FlightSubscriptionRowV1,
  PreferenceSettingsSchema,
  SyncChangeV1,
  SyncEnvelopeV1,
  SyncFlightV1,
  UserPreferencesSchema,
  type UserPreferences,
} from '@planeahead/shared';
import { z } from 'zod';
import { sqlBoolean, type SqliteLike } from '../db/sqlite-like';
import { notifyTablesChanged, type StoreTable } from '../db/store-signal';
import { deleteSyncedRows, SUBSCRIBE_MUTATION, SYNCED_TABLES, writeSyncState } from './store';

/**
 * The page as the client parses it: the shell strictly, the elements as unknown. `SyncEnvelopeV1`
 * itself would refuse the whole page over one element it cannot read.
 */
export const SyncPageShell = SyncEnvelopeV1.extend({
  changes: z.array(z.unknown()),
  flights: z.array(z.unknown()),
});
export type SyncPageShell = z.infer<typeof SyncPageShell>;

/** An element that was not applied: named by entity, id and the failing field, never by value. */
export interface SkippedElement {
  readonly entity: string;
  readonly id: string;
  /** The path of the first field that did not parse, e.g. `source` or `entity`. */
  readonly field: string;
}

export interface ApplyOutcome {
  readonly changes: number;
  readonly flights: number;
  readonly skipped: readonly SkippedElement[];
  readonly cursor: string;
  /** The last `user_preferences` upsert of the page, for the settings store. */
  readonly preferences: UserPreferences | null;
  /** True when the page was a snapshot that replaced the synced rows. */
  readonly replaced: boolean;
}

export interface ApplyOptions {
  /** The page was pulled without a cursor: it replaces every synced row, in the same transaction. */
  readonly replace?: boolean;
  /** The session user the page was pulled for; recorded as the store's owner. */
  readonly ownerUserId?: string | null;
  /** The build's store version (src/lib/sync/version.ts), recorded with the cursor. */
  readonly storeVersion?: string | null;
  readonly now?: () => Date;
}

export const PreferencesRow = UserPreferencesSchema.extend({
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

function tableFor(entity: SyncChangeV1['entity']): StoreTable {
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

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstField(error: z.ZodError): string {
  const path = error.issues[0]?.path ?? [];
  return path.length === 0 ? '(root)' : path.map(String).join('.');
}

/** What a report may say about an element it could not parse: a known entity and a uuid, or less. */
function describe(raw: unknown): { entity: string; id: string } {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const entity = typeof record['entity'] === 'string' ? record['entity'].slice(0, 64) : 'unknown';
  const id = typeof record['id'] === 'string' && UUID_SHAPE.test(record['id']) ? record['id'] : '?';
  return { entity, id };
}

/**
 * Applies `page` in one immediate transaction and returns what it did; signals the touched tables
 * after the commit. A row or a flight that does not parse is skipped and named in `skipped`.
 */
export function applySyncPage(
  db: SqliteLike,
  page: SyncPageShell,
  options: ApplyOptions = {},
): ApplyOutcome {
  const replace = options.replace ?? false;
  const touched = new Set<StoreTable>(['sync_state']);
  if (replace) {
    for (const table of SYNCED_TABLES) {
      touched.add(table);
    }
  }
  const outcome = db.transaction(
    (): ApplyOutcome => {
      const skipped: SkippedElement[] = [];
      let preferences: UserPreferences | null = null;
      let changes = 0;
      let flights = 0;

      if (replace) {
        deleteSyncedRows(db);
      }

      for (const raw of page.changes) {
        const parsed = SyncChangeV1.safeParse(raw);
        if (!parsed.success) {
          skipped.push({ ...describe(raw), field: firstField(parsed.error) });
          continue;
        }
        const change = parsed.data;
        const table = tableFor(change.entity);
        if (change.op === 'delete') {
          db.run(`DELETE FROM ${table} WHERE id = ?`, [change.id]);
          touched.add(table);
          changes += 1;
          continue;
        }
        if (change.entity === 'flight_subscriptions') {
          const row = FlightSubscriptionRowV1.safeParse(change.row);
          if (!row.success || row.data.id !== change.id) {
            skipped.push({
              entity: change.entity,
              id: change.id,
              field: row.success ? 'row.id' : `row.${firstField(row.error)}`,
            });
            continue;
          }
          upsertSubscription(db, row.data);
        } else if (change.entity === 'user_preferences') {
          const row = PreferencesRow.safeParse(change.row);
          if (!row.success || row.data.id !== change.id) {
            skipped.push({
              entity: change.entity,
              id: change.id,
              field: row.success ? 'row.id' : `row.${firstField(row.error)}`,
            });
            continue;
          }
          upsertPreferences(db, row.data);
          const { distanceUnit, temperatureUnit, timeFormat, showLocalTimes, settings } = row.data;
          preferences = { distanceUnit, temperatureUnit, timeFormat, showLocalTimes, settings };
        } else {
          upsertOpaque(db, OPAQUE_TABLES[change.entity], change);
        }
        touched.add(table);
        changes += 1;
      }

      page.flights.forEach((raw, index) => {
        const flight = SyncFlightV1.safeParse(raw);
        if (!flight.success) {
          // The flight key names an itinerary, so a report carries the position only.
          skipped.push({
            entity: 'flight',
            id: `#${String(index)}`,
            field: firstField(flight.error),
          });
          return;
        }
        applySnapshot(db, flight.data);
        touched.add('flight_subscriptions');
        flights += 1;
      });

      if (replace) {
        // A kept optimistic row (one a queued subscribe names) whose flight the snapshot already
        // carries under the server's own id would show the flight twice: the server answers that
        // queued POST with its existing row (200, created false), never with the client's id, so
        // the duplicate goes now and the POST stays queued (final re-review of increment 9). A
        // qualified delete, like every other statement here.
        db.run(
          `DELETE FROM flight_subscriptions
             WHERE id IN (
               SELECT entity_id FROM outbox
               WHERE entity_id IS NOT NULL AND method = ? AND path = ?
             )
             AND EXISTS (
               SELECT 1 FROM flight_subscriptions AS live
               WHERE live.flight_key = flight_subscriptions.flight_key
                 AND live.id <> flight_subscriptions.id
                 AND live.deleted_at IS NULL
             )`,
          [SUBSCRIBE_MUTATION.method, SUBSCRIBE_MUTATION.path],
        );
      }

      writeSyncState(db, {
        cursor: page.cursor,
        pulledAt: (options.now ?? (() => new Date()))().toISOString(),
        ownerUserId: options.ownerUserId ?? null,
        storeVersion: options.storeVersion ?? null,
      });
      return { changes, flights, skipped, cursor: page.cursor, preferences, replaced: replace };
    },
    { behavior: 'immediate' },
  );
  notifyTablesChanged(touched);
  return outcome;
}
