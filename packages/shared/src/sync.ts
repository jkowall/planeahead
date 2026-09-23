import { z } from 'zod';
import { FlightKeySchema } from './flight-key';
import { FlightStatusSchema, IsoInstantSchema } from './flight-status';

/**
 * Server-authoritative pull sync, `GET /v1/sync?cursor=` (increment 8, ADR 0012).
 *
 * Two append-only change tables share one watermark: `user_sync_changes` (a user's own entities,
 * written in the same transaction as the entity) and `flight_sync_changes` (a flight's snapshot,
 * written by the persist consumer in the same transaction as its `flight_instances` upsert). A
 * page returns the rows ordered by `(xid, seq)` that sit strictly after the cursor AND strictly
 * below `pg_snapshot_xmin(pg_current_snapshot())`, the watermark: every transaction below it has
 * committed or aborted, so a transaction that took its xid early and committed late is replayed
 * on the next pull instead of being skipped (the late-commit hazard).
 *
 * The cursor is opaque on the wire: base64url of `"<xid8>:<seq>:<epoch>:<hash8>"` (ruling O12).
 * `xid8` and `seq` are the position; they stay decimal STRINGS everywhere: an xid8 is 64 bits
 * and does not fit a JavaScript number, and postgres.js has no parser for it. `epoch` names the
 * database timeline (`sync_epoch`, bumped after a point-in-time restore, which reuses xids) and
 * `hash8` binds the cursor to its principal (the first 8 bytes of SHA-256 over the user id, 16
 * lower-case hex digits). A cursor from another epoch or issued to another user answers 410
 * `resync_required`, which the client handles by resetting its store and pulling without a
 * cursor: a device that signs in from anonymous to an existing account therefore receives that
 * account's older rows. A client stores the cursor it was given and sends it back unchanged; it
 * never builds one. No cursor means "I have nothing": the server answers with the current state
 * of every entity and a cursor at the watermark.
 */

/**
 * The envelope's own version; a breaking change gets a V2 envelope, never an edit of V1. V1 itself
 * was redefined in place once, by increment 8 (before any client shipped): the cursor gained its
 * epoch and principal binding, the subscription row `liveTracked`, and the entity enum keeps
 * `trip_members`.
 */
export const SYNC_ENVELOPE_VERSION = 1;

/**
 * The entities the feed carries. `trips`, `trip_members` and `logbook_entries` are empty in Phase
 * 0 but in the enum now, so the wire format does not change when they fill. Mirrors
 * `SYNC_CHANGE_ENTITIES` in @planeahead/db (the `user_sync_changes_entity_check` constraint); a
 * test asserts the two lists agree.
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

export const SYNC_OPS = ['upsert', 'delete'] as const;
export const SyncOpSchema = z.enum(SYNC_OPS);
export type SyncOp = z.infer<typeof SyncOpSchema>;

// ---------------------------------------------------------------------------------------------
// Cursor.
// ---------------------------------------------------------------------------------------------

/** A position in the feed: `(xid, seq)`, both decimal strings. */
export interface SyncPosition {
  /** `xid8` as a decimal string (0 to 2^64 - 1). */
  readonly xid: string;
  /** The change table's identity `seq` as a decimal string (0 to 2^63 - 1). */
  readonly seq: string;
}

/** What the opaque cursor carries: the position, the timeline it is valid on, its principal. */
export interface SyncCursor extends SyncPosition {
  /** `sync_epoch.epoch` when the cursor was issued, a decimal string (1 to 2^63 - 1). */
  readonly epoch: string;
  /** The first 8 bytes of SHA-256 over the user id, as 16 lower-case hex digits. */
  readonly binding: string;
}

export class SyncCursorError extends Error {
  override readonly name = 'SyncCursorError';
}

const XID8_MAX = 18_446_744_073_709_551_615n;
const BIGINT_MAX = 9_223_372_036_854_775_807n;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/;
const BINDING_RE = /^[0-9a-f]{16}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * The longest wire form: 20 + 19 + 19 + 16 digits and three colons (77 characters), 103 in
 * base64url. Anything longer was not minted here.
 */
export const SYNC_CURSOR_MAX_LENGTH = 128;

/**
 * Range check without ever turning the value into a Number: BigInt holds any xid8 exactly.
 * The value itself travels as the original string.
 */
function isDecimalWithin(value: string, max: bigint, min = 0n): boolean {
  return DECIMAL_RE.test(value) && BigInt(value) <= max && BigInt(value) >= min;
}

function isValidCursor(cursor: SyncCursor): boolean {
  return (
    isDecimalWithin(cursor.xid, XID8_MAX) &&
    isDecimalWithin(cursor.seq, BIGINT_MAX) &&
    isDecimalWithin(cursor.epoch, BIGINT_MAX, 1n) &&
    BINDING_RE.test(cursor.binding)
  );
}

/** base64url without padding, for the ASCII the cursor consists of (digits, hex and `:`). */
function base64UrlEncodeAscii(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 3) {
    const a = text.charCodeAt(index);
    const b = index + 1 < text.length ? text.charCodeAt(index + 1) : Number.NaN;
    const c = index + 2 < text.length ? text.charCodeAt(index + 2) : Number.NaN;
    const triple = (a << 16) | ((Number.isNaN(b) ? 0 : b) << 8) | (Number.isNaN(c) ? 0 : c);
    out += ALPHABET.charAt((triple >> 18) & 63) + ALPHABET.charAt((triple >> 12) & 63);
    if (!Number.isNaN(b)) {
      out += ALPHABET.charAt((triple >> 6) & 63);
    }
    if (!Number.isNaN(c)) {
      out += ALPHABET.charAt(triple & 63);
    }
  }
  return out;
}

function base64UrlDecodeAscii(encoded: string): string | null {
  if (!BASE64URL_RE.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }
  let out = '';
  for (let index = 0; index < encoded.length; index += 4) {
    const chunk = encoded.slice(index, index + 4);
    const values = [...chunk].map((char) => ALPHABET.indexOf(char));
    const triple =
      ((values[0] ?? 0) << 18) |
      ((values[1] ?? 0) << 12) |
      ((values[2] ?? 0) << 6) |
      (values[3] ?? 0);
    out += String.fromCharCode((triple >> 16) & 255);
    if (chunk.length > 2) {
      out += String.fromCharCode((triple >> 8) & 255);
    }
    if (chunk.length > 3) {
      out += String.fromCharCode(triple & 255);
    }
  }
  // Round trip: a non-canonical encoding (stray low bits in the last character) is refused, so
  // one cursor has exactly one wire form.
  return base64UrlEncodeAscii(out) === encoded ? out : null;
}

/** The opaque wire form of a cursor. Throws `SyncCursorError` on an out-of-range part. */
export function encodeSyncCursor(cursor: SyncCursor): string {
  if (!isValidCursor(cursor)) {
    throw new SyncCursorError(`invalid sync cursor ${JSON.stringify(cursor)}`);
  }
  return base64UrlEncodeAscii(`${cursor.xid}:${cursor.seq}:${cursor.epoch}:${cursor.binding}`);
}

/** Parses the opaque wire form. Throws `SyncCursorError` on anything this server did not mint. */
export function decodeSyncCursor(encoded: string): SyncCursor {
  const text = encoded.length > SYNC_CURSOR_MAX_LENGTH ? null : base64UrlDecodeAscii(encoded);
  if (text === null) {
    throw new SyncCursorError('the sync cursor is not base64url');
  }
  const parts = text.split(':');
  const [xid = '', seq = '', epoch = '', binding = ''] = parts;
  const cursor: SyncCursor = { xid, seq, epoch, binding };
  if (parts.length !== 4 || !isValidCursor(cursor)) {
    throw new SyncCursorError(
      'the sync cursor does not name an xid8, a sequence, an epoch and a binding',
    );
  }
  return cursor;
}

/** The wire form, validated: a base64url string that decodes to a cursor. */
export const SyncCursorWireSchema = z
  .string()
  .min(1)
  .max(SYNC_CURSOR_MAX_LENGTH)
  .refine(
    (value) => {
      try {
        decodeSyncCursor(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'not a sync cursor' },
  );

// ---------------------------------------------------------------------------------------------
// Rows.
// ---------------------------------------------------------------------------------------------

/**
 * `flight_subscriptions` as the feed carries it (the `row` of a change). `flightKey` rides on the
 * row so the client can join it to `flights` without a second table; the mobile store
 * denormalises the snapshot onto this row because `useLiveQuery` only watches its root table.
 */
export const FlightSubscriptionRowV1 = z.looseObject({
  id: z.uuid(),
  flightKey: FlightKeySchema,
  flightInstanceId: z.uuid(),
  tripId: z.uuid().nullable(),
  label: z.string().nullable(),
  seat: z.string().nullable(),
  cabin: z.string().nullable(),
  muted: z.boolean(),
  notificationOverrides: z.record(z.string(), z.unknown()),
  source: z.string(),
  /**
   * Whether the subscription holds one of the user's live-tracked slots (ruling O3): taken at
   * subscribe for a flight already inside its live window, or by the persist consumer when the
   * flight enters it; false when the cap refused it (the flight is still tracked; from Phase 1
   * the flag gates notifications and the Live Activity) and after the flight is over.
   */
  liveTracked: z.boolean(),
  createdAt: IsoInstantSchema,
  updatedAt: IsoInstantSchema,
  deletedAt: IsoInstantSchema.nullable(),
});
export type FlightSubscriptionRowV1 = z.infer<typeof FlightSubscriptionRowV1>;

export const SyncChangeV1 = z.looseObject({
  entity: SyncEntitySchema,
  op: SyncOpSchema,
  /** The entity's id. */
  id: z.uuid(),
  updatedAt: IsoInstantSchema,
  /** The entity as of the change; for `delete`, the tombstone (carrying `deletedAt`). */
  row: z.record(z.string(), z.unknown()).nullable(),
});
export type SyncChangeV1 = z.infer<typeof SyncChangeV1>;

/** One flight's latest snapshot, sent once per page however many subscriptions name it. */
export const SyncFlightV1 = FlightStatusSchema.extend({ key: FlightKeySchema });
export type SyncFlightV1 = z.infer<typeof SyncFlightV1>;

export const SyncEnvelopeV1 = z.looseObject({
  rpcVersion: z.int().min(1).default(SYNC_ENVELOPE_VERSION),
  serverTime: IsoInstantSchema,
  /** Opaque; send it back as `?cursor=` on the next pull. */
  cursor: SyncCursorWireSchema,
  /** True when the page was cut at `SYNC_PAGE_SIZE`: pull again at once with the new cursor. */
  hasMore: z.boolean(),
  changes: z.array(SyncChangeV1),
  /** Keyed by `key` (the flight key); the latest snapshot of every flight the page touches. */
  flights: z.array(SyncFlightV1),
});
export type SyncEnvelopeV1 = z.infer<typeof SyncEnvelopeV1>;
