/**
 * `GET /v1/sync?cursor=` (increment 8, ADR 0012): the server-authoritative pull feed.
 *
 * The page is the rows of the two change tables that sit strictly after the cursor and strictly
 * below the watermark, ordered by `(xid, seq)`:
 *
 *   user_sync_changes   the caller's own rows
 *   flight_sync_changes the rows of the flights the caller is subscribed to
 *
 *   xid < pg_snapshot_xmin(pg_current_snapshot()) and (xid, seq) > ($1::xid8, $2::bigint)
 *
 * The watermark is the entire safety argument: every transaction below `xmin` has committed or
 * aborted, so a transaction that took its xid early and committed after a newer one (the
 * late-commit hazard) is still above the watermark when the newer one is served, and is replayed
 * on a later pull instead of skipped. The two tables share the watermark and one order; no
 * transaction writes both (the persist consumer writes only flight rows, the routes only user
 * rows), so an `(xid, seq)` pair names at most one row across them.
 *
 * `SYNC_PAGE_SIZE` (200) is server-enforced: each table is read with LIMIT 201, the two are
 * merged, and the 201st row, when there is one, is what sets `hasMore`. A truncated page's cursor
 * is its last row; a drained one is `(watermark, 0)`. `flights` carries the latest snapshot (below
 * the watermark) of every flight the page touches, once per flight however many rows name it:
 * the flights whose change rows are in the page and the flights of the subscriptions the page
 * upserts. No cursor means an empty client: the page is the current state of every entity the
 * caller owns, at the watermark.
 *
 * The route reads the PRIMARY. The Hyperdrive binding points at the Neon primary endpoint
 * (wrangler.jsonc, ADR 0002) and must stay there: whether a read replica's `xmin` can trail the
 * primary's is undocumented, and a watermark that moved backwards would re-serve or, worse, skip.
 * Every pull checks `transaction_read_only` on the connection in the same statement that reads
 * the watermark and refuses to serve from a read-only one.
 */

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  flightInstances,
  flightSubscriptions,
  notificationPreferences,
  toIsoInstant,
  userPreferences,
  type Db,
} from '@planeahead/db';
import {
  FlightStatusSchema,
  SYNC_ENVELOPE_VERSION,
  SYNC_PAGE_SIZE,
  type FlightKey,
  type SyncChangeV1,
  type SyncEntity,
  type SyncFlightV1,
  type SyncOp,
} from '@planeahead/shared';
import * as z from 'zod';
import { authRuntime } from '../auth/runtime';
import type { AppBindings } from '../env';
import { currentUser, requireScope } from '../middleware/auth';
import { type DbOrTx } from '../lib/flight-registry';
import {
  SyncCursorError,
  comparePositions,
  decodeSyncCursor,
  drainedCursor,
  encodeSyncCursor,
  isCursorStale,
  type SyncCursor,
} from '../lib/sync-cursor';
import {
  notificationPreferencesSyncRow,
  preferencesSyncRow,
  subscriptionSyncRow,
} from '../lib/sync-rows';
import { queryValue, validate } from '../lib/validate';

/** One more than the page, so the extra row can say `hasMore`. */
const FETCH_LIMIT = SYNC_PAGE_SIZE + 1;

export class ReadOnlyConnectionError extends Error {
  override readonly name = 'ReadOnlyConnectionError';
}

export interface SyncBounds {
  /** `pg_snapshot_xmin` of the current snapshot, as text. */
  readonly watermark: string;
  /** `pg_snapshot_xmax`: the next xid the cluster will assign. */
  readonly nextXid: string;
}

/** The watermark, read together with the primary check in one statement. */
export async function readSyncBounds(db: DbOrTx): Promise<SyncBounds> {
  const [row] = await db.execute<{ watermark: string; next_xid: string; read_only: string }>(sql`
    select pg_snapshot_xmin(pg_current_snapshot())::text as watermark,
           pg_snapshot_xmax(pg_current_snapshot())::text as next_xid,
           current_setting('transaction_read_only') as read_only
  `);
  if (row === undefined) {
    throw new Error('the watermark query returned no row');
  }
  if (row.read_only !== 'off') {
    throw new ReadOnlyConnectionError(
      'GET /v1/sync must read the primary: the connection is read-only (a replica?)',
    );
  }
  return { watermark: row.watermark, nextXid: row.next_xid };
}

/**
 * The oldest xid either change table still holds (by `seq`, the primary key, so O(1)), or null.
 * Rows are purged oldest first, so a cursor below it may have lost rows after it.
 */
export async function oldestRetainedXid(db: DbOrTx): Promise<string | null> {
  const [row] = await db.execute<{ oldest: string | null }>(sql`
    select least(
      (select xid from user_sync_changes order by seq limit 1),
      (select xid from flight_sync_changes order by seq limit 1)
    )::text as oldest
  `);
  return row?.oldest ?? null;
}

/**
 * The caller's own rows after `cursor` and below `watermark`. The row-value comparison is written
 * so the `(user_id, xid, seq)` index drives it (test/workers/sync.test.ts asserts the plan with
 * EXPLAIN on PostgreSQL 18: an index scan whose Index Cond carries the ROW comparison).
 */
export function userChangesQuery(
  userId: string,
  watermark: string,
  cursor: SyncCursor,
  limit: number = FETCH_LIMIT,
): SQL {
  return sql`
    select c.xid::text as xid, c.seq::text as seq, c.entity, c.op, c.entity_id, c.row,
           c.created_at::text as created_at
    from user_sync_changes c
    where c.user_id = ${userId}
      and c.xid < ${watermark}::xid8
      and (c.xid, c.seq) > (${cursor.xid}::xid8, ${cursor.seq}::bigint)
    order by c.xid, c.seq
    limit ${limit}
  `;
}

/** The rows of the caller's subscribed flights after `cursor` and below `watermark`. */
export function flightChangesQuery(
  userId: string,
  watermark: string,
  cursor: SyncCursor,
  limit: number = FETCH_LIMIT,
): SQL {
  return sql`
    select f.xid::text as xid, f.seq::text as seq, f.flight_instance_id
    from flight_sync_changes f
    where f.flight_instance_id in (
            select s.flight_instance_id from flight_subscriptions s
            where s.user_id = ${userId} and s.deleted_at is null
          )
      and f.xid < ${watermark}::xid8
      and (f.xid, f.seq) > (${cursor.xid}::xid8, ${cursor.seq}::bigint)
    order by f.xid, f.seq
    limit ${limit}
  `;
}

interface UserChangeRow extends Record<string, unknown> {
  xid: string;
  seq: string;
  entity: string;
  op: string;
  entity_id: string;
  row: unknown;
  created_at: string;
}

interface FlightChangeRow extends Record<string, unknown> {
  xid: string;
  seq: string;
  flight_instance_id: string;
}

type PageEntry =
  | { readonly kind: 'user'; readonly position: SyncCursor; readonly row: UserChangeRow }
  | { readonly kind: 'flight'; readonly position: SyncCursor; readonly row: FlightChangeRow };

/** The latest snapshot below the watermark of each instance, keyed by flight key. */
export async function latestFlightSnapshots(
  db: DbOrTx,
  instanceIds: readonly string[],
  watermark: string,
): Promise<SyncFlightV1[]> {
  if (instanceIds.length === 0) {
    return [];
  }
  const rows = await db.execute<{ flight_key: string; snapshot: unknown }>(sql`
    select distinct on (f.flight_instance_id) fi.flight_key, f.snapshot
    from flight_sync_changes f
    join flight_instances fi on fi.id = f.flight_instance_id
    where f.flight_instance_id in (${sql.join(
      instanceIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
      and f.xid < ${watermark}::xid8
    order by f.flight_instance_id, f.xid desc, f.seq desc
  `);
  const flights: SyncFlightV1[] = [];
  for (const row of rows) {
    const parsed = FlightStatusSchema.safeParse(row.snapshot);
    if (parsed.success) {
      flights.push({ ...parsed.data, key: row.flight_key as FlightKey });
    }
  }
  return flights;
}

function rowObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function changeFrom(row: UserChangeRow): SyncChangeV1 {
  const payload = rowObject(row.row);
  const updatedAt =
    typeof payload?.['updatedAt'] === 'string'
      ? payload['updatedAt']
      : toIsoInstant(row.created_at);
  return {
    entity: row.entity as SyncEntity,
    op: row.op as SyncOp,
    id: row.entity_id,
    updatedAt,
    row: payload,
  };
}

export interface SyncPage {
  readonly cursor: SyncCursor;
  readonly hasMore: boolean;
  readonly changes: SyncChangeV1[];
  readonly flights: SyncFlightV1[];
}

/** One page after `cursor`. */
export async function changePage(
  db: DbOrTx,
  userId: string,
  cursor: SyncCursor,
  watermark: string,
): Promise<SyncPage> {
  const userRows = await db.execute<UserChangeRow>(userChangesQuery(userId, watermark, cursor));
  const flightRows = await db.execute<FlightChangeRow>(
    flightChangesQuery(userId, watermark, cursor),
  );
  const merged: PageEntry[] = [
    ...[...userRows].map((row): PageEntry => ({
      kind: 'user',
      position: { xid: row.xid, seq: row.seq },
      row,
    })),
    ...[...flightRows].map((row): PageEntry => ({
      kind: 'flight',
      position: { xid: row.xid, seq: row.seq },
      row,
    })),
  ].sort((a, b) => comparePositions(a.position, b.position));
  const hasMore = merged.length > SYNC_PAGE_SIZE;
  const page = merged.slice(0, SYNC_PAGE_SIZE);
  const last = page.at(-1);
  const nextCursor = hasMore && last !== undefined ? last.position : drainedCursor(watermark);

  const changes: SyncChangeV1[] = [];
  const instanceIds = new Set<string>();
  for (const entry of page) {
    if (entry.kind === 'flight') {
      instanceIds.add(entry.row.flight_instance_id);
      continue;
    }
    const change = changeFrom(entry.row);
    changes.push(change);
    const instanceId = change.row?.['flightInstanceId'];
    if (
      change.entity === 'flight_subscriptions' &&
      change.op === 'upsert' &&
      typeof instanceId === 'string'
    ) {
      instanceIds.add(instanceId);
    }
  }
  return {
    cursor: nextCursor,
    hasMore,
    changes,
    flights: await latestFlightSnapshots(db, [...instanceIds], watermark),
  };
}

/**
 * The current state of everything the caller owns, for a client with no cursor: the live
 * subscriptions, the preference rows and their flights. `trips`, `trip_members` and
 * `logbook_entries` have no writer in Phase 0 and are not read; the increment that gives them one
 * adds them here. Bounded by the caps (at most 100 subscriptions plus two preference rows), so it
 * is served as one page; an entity set that can outgrow `SYNC_PAGE_SIZE` needs keyset paging here
 * first (the route logs `sync_snapshot_over_page_size` if that ever happens).
 */
export async function snapshotPage(db: Db, userId: string, watermark: string): Promise<SyncPage> {
  const subscriptions = await db
    .select({ row: flightSubscriptions, flightKey: flightInstances.flightKey })
    .from(flightSubscriptions)
    .innerJoin(flightInstances, eq(flightInstances.id, flightSubscriptions.flightInstanceId))
    .where(and(eq(flightSubscriptions.userId, userId), isNull(flightSubscriptions.deletedAt)))
    .orderBy(flightSubscriptions.createdAt);
  const preferences = await db
    .select()
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), isNull(userPreferences.deletedAt)));
  const notifications = await db
    .select()
    .from(notificationPreferences)
    .where(
      and(eq(notificationPreferences.userId, userId), isNull(notificationPreferences.deletedAt)),
    );
  const changes: SyncChangeV1[] = [
    ...subscriptions.map(({ row, flightKey }): SyncChangeV1 => ({
      entity: 'flight_subscriptions',
      op: 'upsert',
      id: row.id,
      updatedAt: row.updatedAt,
      row: subscriptionSyncRow(row, flightKey as FlightKey),
    })),
    ...preferences.map((row): SyncChangeV1 => ({
      entity: 'user_preferences',
      op: 'upsert',
      id: row.id,
      updatedAt: row.updatedAt,
      row: preferencesSyncRow(row),
    })),
    ...notifications.map((row): SyncChangeV1 => ({
      entity: 'notification_preferences',
      op: 'upsert',
      id: row.id,
      updatedAt: row.updatedAt,
      row: notificationPreferencesSyncRow(row),
    })),
  ];
  return {
    cursor: drainedCursor(watermark),
    hasMore: false,
    changes,
    flights: await latestFlightSnapshots(
      db,
      subscriptions.map(({ row }) => row.flightInstanceId),
      watermark,
    ),
  };
}

const SyncQuerySchema = z.object({
  cursor: queryValue(z.string().min(1).max(64)).optional(),
});

export const syncRoutes = new Hono<AppBindings>().get(
  '/',
  requireScope('user'),
  validate('query', SyncQuerySchema),
  async (c) => {
    const user = currentUser(c.var.user);
    const { cursor: wire } = c.req.valid('query');
    const { db, log } = authRuntime(c);

    let cursor: SyncCursor | null = null;
    if (wire !== undefined) {
      try {
        cursor = decodeSyncCursor(wire);
      } catch (error) {
        if (!(error instanceof SyncCursorError)) {
          throw error;
        }
        return c.json(
          {
            error: 'invalid_cursor',
            message: 'the cursor was not issued by this server; resync from scratch',
            requestId: c.var.requestId,
          },
          400,
        );
      }
    }

    const bounds = await readSyncBounds(db);
    let page: SyncPage;
    if (cursor === null) {
      page = await snapshotPage(db, user.id, bounds.watermark);
    } else {
      const oldest = await oldestRetainedXid(db);
      if (isCursorStale(cursor, { nextXid: bounds.nextXid, oldestRetainedXid: oldest })) {
        log.info('sync_resync_required', { cursor_xid: cursor.xid, oldest_xid: oldest });
        return c.json(
          {
            error: 'resync_required',
            message: 'the cursor is older than the change history; reset the store and pull again',
            requestId: c.var.requestId,
          },
          410,
        );
      }
      page = await changePage(db, user.id, cursor, bounds.watermark);
    }
    if (page.changes.length > SYNC_PAGE_SIZE) {
      // Only the no-cursor snapshot can exceed a page; the Phase 0 caps (100 subscriptions at
      // most, two preference rows) keep it under. Logged so a later entity set cannot outgrow it
      // silently.
      log.error('sync_snapshot_over_page_size', { changes: page.changes.length });
    }
    return c.json({
      rpcVersion: SYNC_ENVELOPE_VERSION,
      serverTime: new Date().toISOString(),
      cursor: encodeSyncCursor(page.cursor),
      hasMore: page.hasMore,
      changes: page.changes,
      flights: page.flights,
    });
  },
);
