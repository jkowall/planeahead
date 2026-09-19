import { z } from 'zod';
import { FlightStatusSchema, IsoInstantSchema } from './flight-status';

/**
 * Server-authoritative pull sync (`GET /v1/sync?since=`). The cursor is a Postgres `xid8`
 * transaction id plus a per-user change sequence; the feed returns rows committed after it
 * and below the current snapshot's xmin, which excludes in-flight transactions.
 */

export const SYNC_ENTITIES = [
  'flight_subscriptions',
  'trips',
  'trip_members',
  'user_preferences',
  'notification_preferences',
  'logbook_entries',
] as const;
export const SyncEntitySchema = z.enum(SYNC_ENTITIES);
export type SyncEntity = z.infer<typeof SyncEntitySchema>;

export interface SyncCursor {
  /** `xid8` as a decimal string; it does not fit a JS number. */
  xid: string;
  seq: number;
}

const SYNC_CURSOR_RE = /^([0-9]+):([0-9]+)$/;

export class SyncCursorError extends Error {
  override readonly name = 'SyncCursorError';
}

export function encodeSyncCursor(cursor: SyncCursor): string {
  if (!/^[0-9]+$/.test(cursor.xid) || !Number.isInteger(cursor.seq) || cursor.seq < 0) {
    throw new SyncCursorError(`invalid sync cursor ${JSON.stringify(cursor)}`);
  }
  return `${cursor.xid}:${String(cursor.seq)}`;
}

export function parseSyncCursor(encoded: string): SyncCursor {
  const match = SYNC_CURSOR_RE.exec(encoded);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new SyncCursorError(`"${encoded}" is not a sync cursor (expected "<xid>:<seq>")`);
  }
  const seq = Number(match[2]);
  if (!Number.isSafeInteger(seq)) {
    throw new SyncCursorError(`sync cursor sequence "${match[2]}" is not a safe integer`);
  }
  return { xid: match[1], seq };
}

/** The zero cursor: everything the user owns. */
export const SYNC_CURSOR_ORIGIN: Readonly<SyncCursor> = Object.freeze({ xid: '0', seq: 0 });

export const SyncCursorSchema = z
  .string()
  .regex(SYNC_CURSOR_RE, 'expected "<xid>:<seq>"')
  .transform((value) => parseSyncCursor(value));

export const SyncUpsertV1 = z.looseObject({
  entity: SyncEntitySchema,
  id: z.uuid(),
  row: z.unknown(),
  updatedAt: IsoInstantSchema,
});
export type SyncUpsertV1 = z.infer<typeof SyncUpsertV1>;

export const SyncTombstoneV1 = z.looseObject({
  entity: SyncEntitySchema,
  id: z.uuid(),
  deletedAt: IsoInstantSchema,
});
export type SyncTombstoneV1 = z.infer<typeof SyncTombstoneV1>;

export const SyncEnvelopeV1 = z.looseObject({
  /** Encoded `${xid}:${seq}` to pass back as `since` on the next pull. */
  cursor: z.string().regex(SYNC_CURSOR_RE),
  upserts: z.array(SyncUpsertV1),
  tombstones: z.array(SyncTombstoneV1),
  /** Flight state for the caller's active subscriptions, server wins. */
  flights: z.array(FlightStatusSchema),
  hasMore: z.boolean(),
});
export type SyncEnvelopeV1 = z.infer<typeof SyncEnvelopeV1>;
