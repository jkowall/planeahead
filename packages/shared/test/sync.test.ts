import { describe, expect, it } from 'vitest';
import {
  SYNC_CURSOR_ORIGIN,
  SYNC_ENTITIES,
  SyncCursorError,
  SyncCursorSchema,
  SyncEnvelopeV1,
  encodeSyncCursor,
  parseSyncCursor,
} from '../src/sync';
import { AA100_INPUT } from './fixtures';

describe('sync cursor', () => {
  it('encodes as xid:seq and parses back', () => {
    expect(encodeSyncCursor({ xid: '12345', seq: 7 })).toBe('12345:7');
    expect(parseSyncCursor('12345:7')).toEqual({ xid: '12345', seq: 7 });
    expect(encodeSyncCursor(parseSyncCursor('0:0'))).toBe('0:0');
  });

  it('keeps a 64-bit xid8 as a string without losing precision', () => {
    const xid = '18446744073709551615';
    expect(parseSyncCursor(`${xid}:1`).xid).toBe(xid);
    expect(encodeSyncCursor({ xid, seq: 1 })).toBe(`${xid}:1`);
  });

  it('rejects malformed cursors', () => {
    for (const bad of ['', 'abc', '1', '1:', ':1', '1:2:3', '-1:0', '1:-1', '1:1.5', ' 1:1']) {
      expect(() => parseSyncCursor(bad)).toThrow(SyncCursorError);
    }
    expect(() => parseSyncCursor('1:99999999999999999')).toThrow(SyncCursorError);
  });

  it('refuses to encode an invalid cursor', () => {
    expect(() => encodeSyncCursor({ xid: 'x', seq: 0 })).toThrow(SyncCursorError);
    expect(() => encodeSyncCursor({ xid: '1', seq: -1 })).toThrow(SyncCursorError);
    expect(() => encodeSyncCursor({ xid: '1', seq: 1.5 })).toThrow(SyncCursorError);
  });

  it('the origin cursor is frozen and encodes to 0:0', () => {
    expect(Object.isFrozen(SYNC_CURSOR_ORIGIN)).toBe(true);
    expect(encodeSyncCursor(SYNC_CURSOR_ORIGIN)).toBe('0:0');
  });

  it('SyncCursorSchema parses the wire form into a cursor', () => {
    expect(SyncCursorSchema.parse('42:3')).toEqual({ xid: '42', seq: 3 });
    expect(SyncCursorSchema.safeParse('42').success).toBe(false);
  });
});

describe('SyncEnvelopeV1', () => {
  const envelope = {
    cursor: '42:3',
    upserts: [
      {
        entity: 'trips',
        id: '019968a7-4e00-7000-8000-000000000002',
        row: { name: 'London' },
        updatedAt: '2026-09-19T12:00:00Z',
      },
    ],
    tombstones: [
      {
        entity: 'flight_subscriptions',
        id: '019968a7-4e00-7000-8000-000000000003',
        deletedAt: '2026-09-19T12:00:01Z',
      },
    ],
    flights: [AA100_INPUT],
    hasMore: false,
  };

  it('lists the sync entities', () => {
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
    expect(parsed.upserts[0]?.row).toEqual({ name: 'London' });
  });

  it('rejects unknown entities, bad cursors and a missing hasMore', () => {
    expect(
      SyncEnvelopeV1.safeParse({
        ...envelope,
        upserts: [{ ...envelope.upserts[0], entity: 'users' }],
      }).success,
    ).toBe(false);
    expect(SyncEnvelopeV1.safeParse({ ...envelope, cursor: '42' }).success).toBe(false);
    const withoutHasMore = Object.fromEntries(
      Object.entries(envelope).filter(([field]) => field !== 'hasMore'),
    );
    expect(SyncEnvelopeV1.safeParse(withoutHasMore).success).toBe(false);
  });

  it('keeps unknown fields for forward compatibility', () => {
    expect(SyncEnvelopeV1.parse({ ...envelope, serverTime: 'x' })).toHaveProperty('serverTime');
  });
});
