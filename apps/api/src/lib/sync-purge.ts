/**
 * The sync feed's retention purge (increment 12, housekeeping step 2; ADR 0012 item 6).
 *
 * The two change tables (`user_sync_changes`, `flight_sync_changes`) keep `SYNC_RETENTION_DAYS`
 * of history, purged by XID below ONE horizon H, both tables and the record of H in ONE
 * transaction, never by `seq` and never per table:
 *
 *   H = the smallest xid among the rows younger than the retention window, across BOTH tables;
 *       or, when no row is young, one above the largest xid among the old rows (every old row
 *       goes and a cursor at or above H lost nothing);
 *   H never exceeds `pg_snapshot_xmin(pg_current_snapshot())` (no transaction in flight holds an
 *       xid below it, so nothing still to be committed can land below H);
 *   H never moves backwards (a lower H would stop answering 410 to a cursor whose rows are
 *       already gone).
 *
 * Then `delete ... where xid < H` from both tables and `sync_horizon.horizon_xid = H`, committed
 * together, after locking the horizon row so two runs (a redelivered message) serialise. The sync
 * route answers 410 `resync_required` exactly when a cursor's xid is below H.
 *
 * Why not "older than 30 days": a row's xid is fixed at its transaction's FIRST write and its
 * `created_at` at the transaction's start, while a reader's cursor is an `(xid, seq)` position.
 * A transaction can hold a low xid and insert its change row late, so an old row can sit ABOVE a
 * young one in xid order (the late-commit inversion, test/workers/sync.late-commit.test.ts): a
 * purge by age would remove a row some cursor has not passed yet without that cursor ever being
 * told. Purging below the smallest young xid keeps every such row until nothing below it is young,
 * and H is exact by construction.
 *
 * xid8 values cross the driver as decimal strings (postgres.js has no xid8 parser); the
 * arithmetic here is BigInt, never Number.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '@planeahead/db';
import { SYNC_RETENTION_DAYS } from '@planeahead/shared';

/** The tables the purge touches; a test points them at its own copies (the horizon is global). */
export interface SyncPurgeTables {
  readonly userChanges: string;
  readonly flightChanges: string;
  readonly horizon: string;
}

export const SYNC_PURGE_TABLES: SyncPurgeTables = Object.freeze({
  userChanges: 'user_sync_changes',
  flightChanges: 'flight_sync_changes',
  horizon: 'sync_horizon',
});

export interface HorizonInputs {
  /** Smallest xid among rows younger than the window, both tables; null when none is young. */
  readonly youngMin: string | null;
  /** Largest xid among rows older than the window, both tables; null when none is old. */
  readonly oldMax: string | null;
  /** `pg_snapshot_xmin(pg_current_snapshot())`. */
  readonly xmin: string;
  /** The recorded horizon, null before the first purge. */
  readonly existing: string | null;
}

function minOf(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function maxOf(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/**
 * The horizon for one purge, or null when there is nothing to purge and nothing recorded.
 * Pure; the rules are the module comment's.
 */
export function chooseHorizon(inputs: HorizonInputs): string | null {
  const xmin = BigInt(inputs.xmin);
  let candidate: bigint | null = null;
  if (inputs.youngMin !== null) {
    candidate = BigInt(inputs.youngMin);
  } else if (inputs.oldMax !== null) {
    candidate = BigInt(inputs.oldMax) + 1n;
  }
  if (candidate !== null) {
    candidate = minOf(candidate, xmin);
  }
  const existing = inputs.existing === null ? null : BigInt(inputs.existing);
  if (candidate === null) {
    return existing === null ? null : existing.toString();
  }
  return (existing === null ? candidate : maxOf(candidate, existing)).toString();
}

export interface SyncPurgeResult {
  /** The horizon recorded by this run (unchanged when nothing moved); null before any purge. */
  readonly horizon: string | null;
  readonly previousHorizon: string | null;
  readonly userChangesDeleted: number;
  readonly flightChangesDeleted: number;
  readonly xmin: string;
}

/** Runs the purge: one transaction, both tables, the horizon recorded in it. */
export async function purgeSyncChanges(
  db: Db,
  tables: SyncPurgeTables = SYNC_PURGE_TABLES,
  retentionDays: number = SYNC_RETENTION_DAYS,
): Promise<SyncPurgeResult> {
  const users = sql.identifier(tables.userChanges);
  const flights = sql.identifier(tables.flightChanges);
  const horizonTable = sql.identifier(tables.horizon);
  const cutoff = sql`now() - make_interval(days => ${retentionDays})`;
  return db.transaction(async (tx) => {
    // The lock first: a second run waits here and then sees this run's horizon.
    const [locked] = await tx.execute<{ horizon: string | null }>(sql`
      select horizon_xid::text as horizon from ${horizonTable} where id = 1 for update
    `);
    const previous = locked?.horizon ?? null;
    const [bounds] = await tx.execute<{
      young_min: string | null;
      old_max: string | null;
      xmin: string;
    }>(sql`
      select
        (select min(m)::text from (
           select min(xid) as m from ${users} where created_at >= ${cutoff}
           union all
           select min(xid) from ${flights} where created_at >= ${cutoff}) young) as young_min,
        (select max(m)::text from (
           select max(xid) as m from ${users} where created_at < ${cutoff}
           union all
           select max(xid) from ${flights} where created_at < ${cutoff}) old) as old_max,
        pg_snapshot_xmin(pg_current_snapshot())::text as xmin
    `);
    if (bounds === undefined) {
      throw new Error('the sync purge bounds query returned no row');
    }
    const horizon = chooseHorizon({
      youngMin: bounds.young_min,
      oldMax: bounds.old_max,
      xmin: bounds.xmin,
      existing: previous,
    });
    if (horizon === null) {
      return {
        horizon: null,
        previousHorizon: null,
        userChangesDeleted: 0,
        flightChangesDeleted: 0,
        xmin: bounds.xmin,
      };
    }
    const [userGone] = await tx.execute<{ n: number }>(sql`
      with gone as (delete from ${users} where xid < ${horizon}::xid8 returning 1)
      select count(*)::int as n from gone
    `);
    const [flightGone] = await tx.execute<{ n: number }>(sql`
      with gone as (delete from ${flights} where xid < ${horizon}::xid8 returning 1)
      select count(*)::int as n from gone
    `);
    await tx.execute(sql`
      insert into ${horizonTable} (id, horizon_xid, purged_at)
      values (1, ${horizon}::xid8, now())
      on conflict (id) do update set horizon_xid = excluded.horizon_xid, purged_at = now()
    `);
    return {
      horizon,
      previousHorizon: previous,
      userChangesDeleted: userGone?.n ?? 0,
      flightChangesDeleted: flightGone?.n ?? 0,
      xmin: bounds.xmin,
    };
  });
}
