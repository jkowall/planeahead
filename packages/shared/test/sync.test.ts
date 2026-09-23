import { describe, expect, it } from 'vitest';
import {
  SYNC_CURSOR_MAX_LENGTH,
  SYNC_ENTITIES,
  SyncCursorError,
  SyncCursorWireSchema,
  SyncEnvelopeV1,
  decodeSyncCursor,
  encodeSyncCursor,
} from '../src/sync';
import { AA100_INPUT } from './fixtures';

const BINDING = '0123456789abcdef';

function cursor(xid: string, seq: string, epoch = '1', binding = BINDING) {
  return { xid, seq, epoch, binding };
}

describe('sync cursor', () => {
  it('encodes "<xid>:<seq>:<epoch>:<hash8>" as unpadded base64url and decodes it back', () => {
    const wire = encodeSyncCursor(cursor('12345', '7'));
    expect(wire).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(wire).toBe(btoa(`12345:7:1:${BINDING}`).replaceAll('=', ''));
    expect(decodeSyncCursor(wire)).toEqual(cursor('12345', '7'));
  });

  it('keeps a 64-bit xid8, a 63-bit seq and epoch as strings without losing a digit', () => {
    const max = cursor('18446744073709551615', '9223372036854775807', '9223372036854775807');
    const wire = encodeSyncCursor(max);
    expect(wire.length).toBeLessThanOrEqual(SYNC_CURSOR_MAX_LENGTH);
    expect(decodeSyncCursor(wire)).toEqual(max);
  });

  it('refuses values past the xid8 and bigint ranges, epoch 0 and a malformed binding', () => {
    for (const bad of [
      cursor('18446744073709551616', '1'),
      cursor('1', '9223372036854775808'),
      cursor('1', '1', '0'),
      cursor('1', '1', '9223372036854775808'),
      cursor('1', '1', '1', '0123456789ABCDEF'),
      cursor('1', '1', '1', '0123456789abcde'),
    ]) {
      expect(() => encodeSyncCursor(bad), JSON.stringify(bad)).toThrow(SyncCursorError);
    }
  });

  it('refuses anything this server did not mint, the pre-binding two-part form included', () => {
    const plain = (text: string) => btoa(text).replaceAll('=', '').replaceAll('+', '-');
    for (const bad of [
      '',
      'not base64!',
      plain('abc'),
      plain('1'),
      plain('1:2'),
      plain(`1:2:3`),
      plain(`1:2:1:${BINDING}:x`),
      plain(`-1:0:1:${BINDING}`),
      plain(`01:0:1:${BINDING}`),
      plain(`1:1.5:1:${BINDING}`),
      plain(`1:1::${BINDING}`),
      'MTIzNDU6Nw==',
      'x'.repeat(200),
    ]) {
      expect(() => decodeSyncCursor(bad), bad).toThrow(SyncCursorError);
    }
  });

  it('refuses a non-canonical encoding of a valid cursor', () => {
    const wire = encodeSyncCursor(cursor('12', '3'));
    const text = `12:3:1:${BINDING}`;
    // Only a length that is not a multiple of three leaves unused low bits in the last character.
    expect(text.length % 3).not.toBe(0);
    // Flip one of those bits: the same bytes, a different string.
    const last = wire.at(-1) ?? '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const tweaked = wire.slice(0, -1) + alphabet.charAt(alphabet.indexOf(last) + 1);
    expect(() => decodeSyncCursor(tweaked)).toThrow(SyncCursorError);
  });

  it('SyncCursorWireSchema accepts exactly what decodes', () => {
    expect(SyncCursorWireSchema.safeParse(encodeSyncCursor(cursor('42', '3'))).success).toBe(true);
    expect(SyncCursorWireSchema.safeParse('42:3').success).toBe(false);
  });
});

describe('SyncEnvelopeV1', () => {
  const envelope = {
    rpcVersion: 1,
    serverTime: '2026-09-23T12:00:00Z',
    cursor: encodeSyncCursor(cursor('42', '3')),
    hasMore: false,
    changes: [
      {
        entity: 'flight_subscriptions',
        op: 'upsert',
        id: '019968a7-4e00-7000-8000-000000000002',
        updatedAt: '2026-09-19T12:00:00Z',
        row: { flightKey: 'AAL-100-2026-09-19-KJFK', muted: false },
      },
      {
        entity: 'flight_subscriptions',
        op: 'delete',
        id: '019968a7-4e00-7000-8000-000000000003',
        updatedAt: '2026-09-19T12:00:01Z',
        row: { deletedAt: '2026-09-19T12:00:01Z' },
      },
    ],
    flights: [{ ...AA100_INPUT, key: 'AAL-100-2026-09-19-KJFK' }],
  };

  it('lists the sync entities, trips and logbook entries included', () => {
    expect(SYNC_ENTITIES).toEqual([
      'flight_subscriptions',
      'trips',
      'trip_members',
      'user_preferences',
      'notification_preferences',
      'logbook_entries',
    ]);
  });

  it('parses an envelope and normalises the flight statuses inside it', () => {
    const parsed = SyncEnvelopeV1.parse(envelope);
    expect(parsed.flights[0]?.legSeq).toBe(1);
    expect(parsed.changes.map((change) => change.op)).toEqual(['upsert', 'delete']);
  });

  it('defaults rpcVersion so an envelope without one reads as V1', () => {
    const withoutVersion = Object.fromEntries(
      Object.entries(envelope).filter(([field]) => field !== 'rpcVersion'),
    );
    expect(SyncEnvelopeV1.parse(withoutVersion).rpcVersion).toBe(1);
  });

  it('rejects unknown entities and ops, bad cursors, keyless flights and a missing hasMore', () => {
    const [first] = envelope.changes;
    expect(
      SyncEnvelopeV1.safeParse({ ...envelope, changes: [{ ...first, entity: 'users' }] }).success,
    ).toBe(false);
    expect(
      SyncEnvelopeV1.safeParse({ ...envelope, changes: [{ ...first, op: 'patch' }] }).success,
    ).toBe(false);
    expect(SyncEnvelopeV1.safeParse({ ...envelope, cursor: '42:3' }).success).toBe(false);
    expect(SyncEnvelopeV1.safeParse({ ...envelope, flights: [AA100_INPUT] }).success).toBe(false);
    const withoutHasMore = Object.fromEntries(
      Object.entries(envelope).filter(([field]) => field !== 'hasMore'),
    );
    expect(SyncEnvelopeV1.safeParse(withoutHasMore).success).toBe(false);
  });

  it('keeps unknown fields for forward compatibility', () => {
    expect(SyncEnvelopeV1.parse({ ...envelope, watermarkLagMs: 12 })).toHaveProperty(
      'watermarkLagMs',
    );
  });
});
