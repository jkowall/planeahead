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
 * Paged (increment 12, ruling AA15). The app role runs under a 10 s `statement_timeout` (the
 * runbook's Neon role settings), and one unpaged purge of a month's backlog would pass it, fail,
 * retry and restart every night while the tables grew. So each queue message advances the horizon
 * by one bounded step: it reads the oldest `SYNC_PURGE_ROWS_PER_STEP + 1` rows of both tables in
 * xid order (the btree on `xid`, migration 0005), and picks H_i as
 *
 *   - the xid of the first YOUNG row among them, when there is one: that is the smallest young
 *     xid of both tables, the target H above, and the purge is done;
 *   - otherwise the xid of the (N+1)-th row, so at most N rows fall below it (or one above the
 *     first xid when all N+1 share it: the rows of one transaction are never split), and a
 *     continuation follows;
 *   - otherwise (fewer than N+1 rows, all old) one above the last xid, and the purge is done;
 *
 * each capped at `pg_snapshot_xmin` and never below the recorded horizon, exactly as H is. Every
 * H_i is therefore at most the target H computed in one pass, the last one equals it, and each is
 * a valid horizon in its own right: its step deletes `xid < H_i` from both tables and records H_i
 * in one transaction, so a cursor below H_i answers 410 and a cursor at or above it lost nothing.
 * No step scans the young rows: the walk stops at the first one.
 *
 * xid8 values cross the driver as decimal strings (postgres.js has no xid8 parser); the
 * arithmetic here is BigInt, never Number.
 */

import { sql } from 'drizzle-orm';
import type { Db } from '@planeahead/db';
import { SYNC_RETENTION_DAYS } from '@planeahead/shared';

/**
 * The most change rows one purge step deletes (ruling AA15): a few index pages and one short
 * transaction, far inside the 10 s `statement_timeout` at any table size.
 */
export const SYNC_PURGE_ROWS_PER_STEP = 10_000;

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
 * The target horizon H of a whole purge computed in one pass, or null when there is nothing to
 * purge and nothing recorded: what the paged steps (`stepHorizon`) converge on, never pass, and
 * reach on the last step. Pure; the rules are the module comment's. The steps never compute it
 * (it needs the young rows' minimum); the suite compares their final horizon with it.
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

/** One of the oldest rows, in merged xid order: its xid and whether it is inside the window. */
export interface OldestRow {
  readonly xid: string;
  readonly young: boolean;
}

/**
 * The horizon of one purge step, or null when there is nothing to purge and nothing recorded.
 * `rows` are the oldest `rowsPerStep + 1` rows of both tables in xid order (fewer when the tables
 * hold fewer). Pure; the rules are the module comment's.
 */
export function stepHorizon(inputs: {
  readonly rows: readonly OldestRow[];
  readonly rowsPerStep: number;
  readonly xmin: string;
  readonly existing: string | null;
}): { readonly horizon: string | null; readonly done: boolean } {
  const xmin = BigInt(inputs.xmin);
  const existing = inputs.existing === null ? null : BigInt(inputs.existing);
  const first = inputs.rows[0];
  let candidate: bigint | null = null;
  let done = true;
  const young = inputs.rows.find((row) => row.young);
  if (young !== undefined) {
    candidate = BigInt(young.xid);
  } else if (first !== undefined) {
    const next = inputs.rows[inputs.rowsPerStep];
    if (next === undefined) {
      candidate = BigInt(inputs.rows[inputs.rows.length - 1]?.xid ?? first.xid) + 1n;
    } else {
      candidate =
        BigInt(next.xid) === BigInt(first.xid) ? BigInt(first.xid) + 1n : BigInt(next.xid);
      done = false;
    }
  }
  if (candidate !== null && candidate >= xmin) {
    candidate = xmin;
    done = true;
  }
  if (candidate === null) {
    return { horizon: existing === null ? null : existing.toString(), done: true };
  }
  if (existing !== null && candidate <= existing) {
    return { horizon: existing.toString(), done: true };
  }
  return { horizon: candidate.toString(), done };
}

export interface SyncPurgeResult {
  /** The horizon recorded by this step (unchanged when nothing moved); null before any purge. */
  readonly horizon: string | null;
  readonly previousHorizon: string | null;
  readonly userChangesDeleted: number;
  readonly flightChangesDeleted: number;
  readonly xmin: string;
  /** False when rows below the target remain: the caller sends a continuation. */
  readonly done: boolean;
}

/** Runs ONE purge step: one transaction, both tables, the step's horizon recorded in it. */
export async function purgeSyncChanges(
  db: Db,
  tables: SyncPurgeTables = SYNC_PURGE_TABLES,
  options: { readonly retentionDays?: number; readonly rowsPerStep?: number } = {},
): Promise<SyncPurgeResult> {
  const users = sql.identifier(tables.userChanges);
  const flights = sql.identifier(tables.flightChanges);
  const horizonTable = sql.identifier(tables.horizon);
  const retentionDays = options.retentionDays ?? SYNC_RETENTION_DAYS;
  const rowsPerStep = Math.max(1, options.rowsPerStep ?? SYNC_PURGE_ROWS_PER_STEP);
  const cutoff = sql`now() - make_interval(days => ${retentionDays}::int)`;
  return db.transaction(async (tx) => {
    // The lock first: a second run waits here and then sees this run's horizon.
    const [locked] = await tx.execute<{ horizon: string | null }>(sql`
      select horizon_xid::text as horizon from ${horizonTable} where id = 1 for update
    `);
    const previous = locked?.horizon ?? null;
    const [snapshot] = await tx.execute<{ xmin: string }>(sql`
      select pg_snapshot_xmin(pg_current_snapshot())::text as xmin
    `);
    if (snapshot === undefined) {
      throw new Error('the sync purge snapshot query returned no row');
    }
    // The oldest N+1 rows of each table by the xid btree, merged: N+1 in all.
    const oldest = await tx.execute<{ xid: string; young: boolean }>(sql`
      select xid::text as xid, young from (
        (select xid, created_at >= ${cutoff} as young from ${users}
         order by xid limit ${rowsPerStep + 1})
        union all
        (select xid, created_at >= ${cutoff} as young from ${flights}
         order by xid limit ${rowsPerStep + 1})
      ) merged
      order by merged.xid
      limit ${rowsPerStep + 1}
    `);
    const step = stepHorizon({
      rows: oldest.map((row) => ({ xid: row.xid, young: row.young })),
      rowsPerStep,
      xmin: snapshot.xmin,
      existing: previous,
    });
    if (step.horizon === null) {
      return {
        horizon: null,
        previousHorizon: null,
        userChangesDeleted: 0,
        flightChangesDeleted: 0,
        xmin: snapshot.xmin,
        done: true,
      };
    }
    const [userGone] = await tx.execute<{ n: number }>(sql`
      with gone as (delete from ${users} where xid < ${step.horizon}::xid8 returning 1)
      select count(*)::int as n from gone
    `);
    const [flightGone] = await tx.execute<{ n: number }>(sql`
      with gone as (delete from ${flights} where xid < ${step.horizon}::xid8 returning 1)
      select count(*)::int as n from gone
    `);
    await tx.execute(sql`
      insert into ${horizonTable} (id, horizon_xid, purged_at)
      values (1, ${step.horizon}::xid8, now())
      on conflict (id) do update set horizon_xid = excluded.horizon_xid, purged_at = now()
    `);
    return {
      horizon: step.horizon,
      previousHorizon: previous,
      userChangesDeleted: userGone?.n ?? 0,
      flightChangesDeleted: flightGone?.n ?? 0,
      xmin: snapshot.xmin,
      done: step.done,
    };
  });
}
