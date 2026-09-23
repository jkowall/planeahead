/**
 * The sync cursor on the Worker side (increment 8, ADR 0012, rulings O9 and O12).
 *
 * The wire form is `@planeahead/shared`'s: base64url of `"<xid8>:<seq>:<epoch>:<hash8>"`. The
 * position halves are decimal strings that never pass through a JavaScript number (an xid8 is 64
 * bits; postgres.js has no parser for it and hands it over as text, which is how every query here
 * selects it: `::text`). Comparisons use BigInt on those strings.
 *
 * A page that drains the feed answers `(watermark, 0)`: the next pull asks for `(xid, seq) >
 * (watermark, 0)`, which includes the watermark transaction's own rows (identity `seq` starts at
 * 1), the one transaction that was still running when this page was cut.
 *
 * 410 `resync_required` has exactly four causes, and every one of them means rows after the
 * cursor could be missed if it were served:
 *
 *   - `epoch`: the cursor was issued on another database timeline (`sync_epoch`, bumped by the
 *     restore runbook, because a point-in-time restore reuses xids the lost timeline issued);
 *   - `binding`: the cursor was issued to another principal (a device that upgraded from an
 *     anonymous user to an existing account holds the anonymous user's cursor, and the account's
 *     older rows sit below it);
 *   - `unassigned`: it names an xid this cluster has not assigned yet (a replaced database);
 *   - `horizon`: its xid is below the purge horizon H (`sync_horizon`), so rows after it may have
 *     been deleted. Checked AFTER the page is read, by the route: a purge that committed before
 *     the page's statement is visible to the later read of H, so no purged gap is ever served as
 *     complete.
 *
 * The binding is the first 8 bytes of SHA-256 over the user id, with no secret: forging another
 * user's binding still only pages the SESSION user's rows, so it is an identity check, not an
 * authorisation one.
 */

import {
  SyncCursorError,
  decodeSyncCursor,
  encodeSyncCursor,
  type SyncCursor,
  type SyncPosition,
} from '@planeahead/shared';
import { bytesToHex, sha256 } from '../crypto/hash';

export { SyncCursorError, decodeSyncCursor, encodeSyncCursor, type SyncCursor, type SyncPosition };

/** The cursor a drained page answers: the watermark, sequence 0. */
export function drainedCursor(watermark: string): SyncPosition {
  return { xid: watermark, seq: '0' };
}

/** Orders two `(xid, seq)` positions exactly (BigInt, never Number). */
export function comparePositions(a: SyncPosition, b: SyncPosition): number {
  const xa = BigInt(a.xid);
  const xb = BigInt(b.xid);
  if (xa !== xb) {
    return xa < xb ? -1 : 1;
  }
  const sa = BigInt(a.seq);
  const sb = BigInt(b.seq);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** The principal half of a cursor: SHA-256 over the user id, first 8 bytes, lower-case hex. */
export async function syncCursorBinding(userId: string): Promise<string> {
  return bytesToHex((await sha256(userId)).slice(0, 8));
}

export interface CursorContext {
  /** `pg_snapshot_xmax` of the current snapshot: the next xid the cluster will assign. */
  readonly nextXid: string;
  /** `sync_epoch.epoch` now. */
  readonly epoch: string;
  /** `syncCursorBinding(session user id)`. */
  readonly binding: string;
}

export type StaleCursorReason = 'epoch' | 'binding' | 'unassigned' | 'horizon';

/** The checks that need no page: timeline, principal, and an xid the cluster never assigned. */
export function staleBeforePage(
  cursor: SyncCursor,
  context: CursorContext,
): StaleCursorReason | null {
  if (cursor.epoch !== context.epoch) {
    return 'epoch';
  }
  if (cursor.binding !== context.binding) {
    return 'binding';
  }
  if (BigInt(cursor.xid) > BigInt(context.nextXid)) {
    return 'unassigned';
  }
  return null;
}

/**
 * Whether the purge horizon H may have removed rows after `cursor`: exactly when its xid is below
 * H (the purge deleted `xid < H` from both tables in the transaction that recorded H). Null H means
 * nothing was ever purged.
 */
export function isBelowHorizon(cursor: SyncPosition, horizon: string | null): boolean {
  return horizon !== null && BigInt(cursor.xid) < BigInt(horizon);
}
