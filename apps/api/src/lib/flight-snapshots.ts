/**
 * Where a route finds a flight's state without waking its tracker when it does not have to
 * (increment 8, ruling K7).
 *
 *   1. KV `flight:snapshot:{key}`: the tracker publishes it (180 s, debounced; src/kv/snapshot.ts).
 *   2. On a miss, the tracker itself (`getState`, under the route's deadline), and the answer is
 *      written back to KV with `executionCtx.waitUntil`, so the next read is a KV hit. Only a
 *      tracker answer is written: a Postgres row may trail the tracker by the persist lag and must
 *      not be published as current.
 *   3. When the tracker is gone (finished and deleted) or does not answer in time, Postgres: the
 *      latest `flight_sync_changes` snapshot and the instance row's phase and version.
 *
 * `lastKnownFlight` is the refresh route's 504 fallback: KV, then Postgres, never the tracker (the
 * tracker is the thing that did not answer).
 */

import { sql } from 'drizzle-orm';
import {
  FlightStatusSchema,
  type FlightKey,
  type FlightStatus,
  type GetStateResponseV1,
  type SnapshotSource,
} from '@planeahead/shared';
import type { Env } from '../env';
import { snapshotKvKey, writeSnapshotKv, type SnapshotKvValue } from '../kv/snapshot';
import { errorFields, type Logger } from '../observability/log';
import { withDeadline } from './deadline';
import type { DbOrTx } from './flight-registry';
import { getTrackerState, isAbsentTrackerError, type TrackerFor } from './trackers';

export type { SnapshotSource };

export interface KnownFlight {
  readonly flightKey: FlightKey;
  readonly phase: string;
  readonly version: number;
  readonly snapshot: FlightStatus | null;
  readonly source: SnapshotSource;
}

function parseStatus(value: unknown): FlightStatus | null {
  const parsed = FlightStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The tracker's KV publication, or null on a miss or a value this build cannot read. */
export async function readKvSnapshot(
  kv: Pick<KVNamespace, 'get'>,
  flightKey: FlightKey,
  log: Logger,
): Promise<KnownFlight | null> {
  try {
    const value: unknown = await kv.get(snapshotKvKey(flightKey), 'json');
    if (typeof value !== 'object' || value === null) {
      return null;
    }
    const record = value as Partial<SnapshotKvValue>;
    if (typeof record.phase !== 'string' || typeof record.version !== 'number') {
      return null;
    }
    return {
      flightKey,
      phase: record.phase,
      version: record.version,
      snapshot: record.snapshot === null ? null : parseStatus(record.snapshot),
      source: 'kv',
    };
  } catch (error) {
    log.warn('flight_snapshot_kv_read_failed', errorFields(error));
    return null;
  }
}

interface PostgresSnapshotRow extends Record<string, unknown> {
  flight_key: string;
  status: string;
  tracking_state: string;
  version: number;
  snapshot: unknown;
}

const FINISHED_STATES: ReadonlySet<string> = new Set(['finished', 'archived', 'superseded']);

/** The latest stored snapshot of each key that Postgres knows. */
export async function postgresSnapshots(
  db: DbOrTx,
  flightKeys: readonly FlightKey[],
): Promise<Map<FlightKey, KnownFlight>> {
  const found = new Map<FlightKey, KnownFlight>();
  if (flightKeys.length === 0) {
    return found;
  }
  const rows = await db.execute<PostgresSnapshotRow>(sql`
    select fi.flight_key, fi.status, fi.tracking_state, fi.version, latest.snapshot
    from flight_instances fi
    left join lateral (
      select f.snapshot from flight_sync_changes f
      where f.flight_instance_id = fi.id
      order by f.xid desc, f.seq desc
      limit 1
    ) latest on true
    where fi.flight_key in (${sql.join(
      flightKeys.map((key) => sql`${key}`),
      sql`, `,
    )})
  `);
  for (const row of rows) {
    const key = row.flight_key as FlightKey;
    found.set(key, {
      flightKey: key,
      phase: FINISHED_STATES.has(row.tracking_state) ? 'finished' : row.status,
      version: Number(row.version),
      snapshot: row.snapshot === null ? null : parseStatus(row.snapshot),
      source: 'postgres',
    });
  }
  return found;
}

/** KV, then Postgres: the 504 answer's "last known state". Null when neither has one. */
export async function lastKnownFlight(
  env: Pick<Env, 'CACHE'>,
  db: DbOrTx,
  flightKey: FlightKey,
  log: Logger,
): Promise<KnownFlight | null> {
  const cached = await readKvSnapshot(env.CACHE, flightKey, log);
  if (cached !== null) {
    return cached;
  }
  try {
    return (await postgresSnapshots(db, [flightKey])).get(flightKey) ?? null;
  } catch (error) {
    log.warn('flight_snapshot_postgres_read_failed', errorFields(error));
    return null;
  }
}

export interface ReadThroughOptions {
  readonly env: Pick<Env, 'CACHE'>;
  readonly db: DbOrTx;
  readonly trackerFor: TrackerFor;
  readonly deadlineMs: number;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly log: Logger;
  /** How many trackers are asked at once on KV misses. */
  readonly concurrency?: number;
  /**
   * Keys whose flight Postgres already records as over: read from Postgres on a KV miss, never
   * from the tracker, which is gone (or finishing) and would only be woken as an empty object.
   */
  readonly finished?: ReadonlySet<FlightKey>;
}

function kvValueFrom(state: GetStateResponseV1): SnapshotKvValue {
  return {
    rpcVersion: 1,
    flightKey: state.flightKey,
    phase: state.phase,
    version: state.version ?? 0,
    snapshot: state.snapshot,
    nextRefreshAt: state.nextRefreshAt,
    writtenAt: new Date().toISOString(),
  };
}

/** KV, then the tracker (written back to KV), then Postgres, for every key. */
export async function readThroughSnapshots(
  flightKeys: readonly FlightKey[],
  options: ReadThroughOptions,
): Promise<Map<FlightKey, KnownFlight>> {
  const unique = [...new Set(flightKeys)];
  const found = new Map<FlightKey, KnownFlight>();
  const cached = await Promise.all(
    unique.map((key) => readKvSnapshot(options.env.CACHE, key, options.log)),
  );
  const misses: FlightKey[] = [];
  const unresolved: FlightKey[] = [];
  unique.forEach((key, index) => {
    const hit = cached[index];
    if (hit !== null && hit !== undefined) {
      found.set(key, hit);
    } else if (options.finished?.has(key) === true) {
      unresolved.push(key);
    } else {
      misses.push(key);
    }
  });

  const concurrency = Math.max(1, options.concurrency ?? 8);
  for (let start = 0; start < misses.length; start += concurrency) {
    const batch = misses.slice(start, start + concurrency);
    const answers = await Promise.all(
      batch.map(async (key) => {
        try {
          const result = await withDeadline(
            getTrackerState(options.trackerFor(key)),
            options.deadlineMs,
            { waitUntil: options.waitUntil },
          );
          return result.kind === 'ok' ? result.value : null;
        } catch (error) {
          if (!isAbsentTrackerError(error)) {
            options.log.warn('flight_snapshot_tracker_read_failed', {
              flight_key: key,
              ...errorFields(error),
            });
          }
          return null;
        }
      }),
    );
    batch.forEach((key, index) => {
      const state = answers[index];
      if (state === null || state === undefined) {
        unresolved.push(key);
        return;
      }
      found.set(key, {
        flightKey: key,
        phase: state.phase,
        version: state.version ?? 0,
        snapshot: state.snapshot,
        source: 'tracker',
      });
      options.waitUntil(writeSnapshotKv(options.env.CACHE, kvValueFrom(state), options.log));
    });
  }

  if (unresolved.length > 0) {
    try {
      for (const [key, flight] of await postgresSnapshots(options.db, unresolved)) {
        found.set(key, flight);
      }
    } catch (error) {
      options.log.warn('flight_snapshot_postgres_read_failed', errorFields(error));
    }
  }
  return found;
}
