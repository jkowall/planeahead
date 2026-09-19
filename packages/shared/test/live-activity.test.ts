import { describe, expect, it } from 'vitest';
import {
  LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES,
  LiveActivityContentStateV1,
} from '../src/live-activity';

const MINIMAL = {
  flightKey: 'AAL-100-2026-09-19-KJFK',
  status: 'scheduled',
  scheduledOut: '2026-09-20T03:50:00Z',
  scheduledIn: '2026-09-20T10:50:00Z',
  updatedAt: '2026-09-19T12:00:00Z',
};

describe('LiveActivityContentStateV1', () => {
  it('parses the minimal state', () => {
    const parsed = LiveActivityContentStateV1.parse(MINIMAL);
    expect(parsed.gate).toBeUndefined();
    expect(parsed.progressPercent).toBeUndefined();
  });

  it('rejects out-of-range progress, bad instants and malformed keys', () => {
    expect(LiveActivityContentStateV1.safeParse({ ...MINIMAL, progressPercent: 101 }).success).toBe(
      false,
    );
    expect(LiveActivityContentStateV1.safeParse({ ...MINIMAL, progressPercent: -1 }).success).toBe(
      false,
    );
    expect(
      LiveActivityContentStateV1.safeParse({ ...MINIMAL, estimatedIn: '2026-09-20 10:50' }).success,
    ).toBe(false);
    expect(LiveActivityContentStateV1.safeParse({ ...MINIMAL, flightKey: 'AA100' }).success).toBe(
      false,
    );
    expect(LiveActivityContentStateV1.safeParse({ ...MINIMAL, status: 'delayed' }).success).toBe(
      false,
    );
  });

  it('stays well inside the ActivityKit payload limit even with every field set', () => {
    const full = LiveActivityContentStateV1.parse({
      ...MINIMAL,
      flightKey: 'AAL-1000A-2026-09-19-KJFK-L12',
      status: 'en_route',
      gate: 'X'.repeat(16),
      terminal: 'T'.repeat(32),
      estimatedOut: '2026-09-20T04:05:00.000Z',
      actualOut: '2026-09-20T04:07:00.000Z',
      estimatedIn: '2026-09-20T10:58:00.000Z',
      progressPercent: 57.5,
      baggageClaim: 'B'.repeat(32),
    });
    const bytes = new TextEncoder().encode(JSON.stringify(full)).length;
    expect(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES).toBe(4_096);
    expect(bytes).toBeLessThan(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES / 4);
  });
});
