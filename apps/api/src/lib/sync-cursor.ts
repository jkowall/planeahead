/**
 * The sync cursor on the Worker side (increment 8, ADR 0012).
 *
 * The wire form is `@planeahead/shared`'s: base64url of `"<xid8>:<seq>"`, both halves decimal
 * strings that never pass through a JavaScript number (an xid8 is 64 bits; postgres.js has no
 * parser for it and hands it over as text, which is how every query here selects it: `::text`).
 * Comparisons use BigInt on those strings.
 *
 * A page that drains the feed answers `(watermark, 0)`: the next pull asks for `(xid, seq) >
 * (watermark, 0)`, which includes the watermark transaction's own rows (identity `seq` starts at
 * 1), the one transaction that was still running when this page was cut.
 *
 * Staleness (410 `resync_required`) has two causes: the cursor names an xid this cluster has not
 * assigned yet (a restored or replaced database), or it predates the oldest row the change tables
 * still hold (the housekeeping cron purges rows after `SYNC_RETENTION_DAYS`), in which case rows
 * after it may be gone and the page would silently skip them.
 */

import {
  SyncCursorError,
  decodeSyncCursor,
  encodeSyncCursor,
  type SyncCursor,
} from '@planeahead/shared';

export { SyncCursorError, decodeSyncCursor, encodeSyncCursor, type SyncCursor };

/** The cursor a drained page answers: the watermark, sequence 0. */
export function drainedCursor(watermark: string): SyncCursor {
  return { xid: watermark, seq: '0' };
}

/** Orders two `(xid, seq)` positions exactly (BigInt, never Number). */
export function comparePositions(a: SyncCursor, b: SyncCursor): number {
  const xa = BigInt(a.xid);
  const xb = BigInt(b.xid);
  if (xa !== xb) {
    return xa < xb ? -1 : 1;
  }
  const sa = BigInt(a.seq);
  const sb = BigInt(b.seq);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

export interface RetentionBounds {
  /** `pg_snapshot_xmax` of the current snapshot: the next xid the cluster will assign. */
  readonly nextXid: string;
  /** The xid of the oldest row either change table still holds; null when both are empty. */
  readonly oldestRetainedXid: string | null;
}

/** Whether the rows after `cursor` can no longer all be served. */
export function isCursorStale(cursor: SyncCursor, bounds: RetentionBounds): boolean {
  const xid = BigInt(cursor.xid);
  if (xid > BigInt(bounds.nextXid)) {
    return true;
  }
  return bounds.oldestRetainedXid !== null && xid < BigInt(bounds.oldestRetainedXid);
}
