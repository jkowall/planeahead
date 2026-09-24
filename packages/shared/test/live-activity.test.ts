import { describe, expect, it } from 'vitest';
import {
  LIVE_ACTIVITY_FIELD_MAX_LENGTH as MAX,
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
  });

  it('carries the designator and the two IATA codes the Lock Screen and Dynamic Island print', () => {
    const parsed = LiveActivityContentStateV1.parse({
      ...MINIMAL,
      designator: 'AA100',
      originIata: 'JFK',
      destinationIata: 'LHR',
    });
    expect([parsed.designator, parsed.originIata, parsed.destinationIata]).toEqual([
      'AA100',
      'JFK',
      'LHR',
    ]);
    // Optional, like every field added to a loose schema later: an older state still parses.
    expect(LiveActivityContentStateV1.parse(MINIMAL).designator).toBeUndefined();
    expect(LiveActivityContentStateV1.safeParse({ ...MINIMAL, originIata: 'KJFK' }).success).toBe(
      false,
    );
    expect(LiveActivityContentStateV1.safeParse({ ...MINIMAL, designator: 'A' }).success).toBe(
      false,
    );
    expect(
      LiveActivityContentStateV1.safeParse({ ...MINIMAL, designator: 'AAL1000AB' }).success,
    ).toBe(false);
  });

  it('degrades a status it does not know to unknown, like every other status on the wire', () => {
    expect(LiveActivityContentStateV1.parse({ ...MINIMAL, status: 'delayed' }).status).toBe(
      'unknown',
    );
  });

  it('bounds every free-text field, so the schema has a worst case with a size (ruling Z2)', () => {
    const atBound = {
      ...MINIMAL,
      gate: 'G'.repeat(MAX.gate),
      terminal: 'T'.repeat(MAX.terminal),
      destinationGate: 'G'.repeat(MAX.gate),
      destinationTerminal: 'T'.repeat(MAX.terminal),
      baggageClaim: 'B'.repeat(MAX.baggageClaim),
    };
    expect(LiveActivityContentStateV1.safeParse(atBound).success).toBe(true);
    expect([MAX.gate, MAX.terminal, MAX.baggageClaim]).toEqual([16, 32, 32]);
    for (const [field, max] of [
      ['gate', MAX.gate],
      ['terminal', MAX.terminal],
      ['destinationGate', MAX.gate],
      ['destinationTerminal', MAX.terminal],
      ['baggageClaim', MAX.baggageClaim],
    ] as const) {
      expect(
        LiveActivityContentStateV1.safeParse({ ...atBound, [field]: 'x'.repeat(max + 1) }).success,
        field,
      ).toBe(false);
    }
  });

  it('bounds the flight key and the instants, whose grammars alone allow any length', () => {
    const longestKey = 'AAL-9999A-2026-12-31-KJFK-L99999';
    expect(longestKey).toHaveLength(MAX.flightKey);
    expect(
      LiveActivityContentStateV1.safeParse({ ...MINIMAL, flightKey: longestKey }).success,
    ).toBe(true);
    expect(
      LiveActivityContentStateV1.safeParse({ ...MINIMAL, flightKey: `${longestKey}9` }).success,
    ).toBe(false);
    const nanos = '2026-12-31T23:59:59.999999999Z';
    expect(nanos).toHaveLength(MAX.instant);
    expect(LiveActivityContentStateV1.safeParse({ ...MINIMAL, updatedAt: nanos }).success).toBe(
      true,
    );
    expect(
      LiveActivityContentStateV1.safeParse({
        ...MINIMAL,
        updatedAt: '2026-12-31T23:59:59.9999999999Z',
      }).success,
    ).toBe(false);
  });

  it('carries the destination gate and terminal next to the origin pair, both optional', () => {
    const parsed = LiveActivityContentStateV1.parse({
      ...MINIMAL,
      gate: 'B22',
      terminal: '8',
      destinationGate: 'C3',
      destinationTerminal: '5',
    });
    expect([parsed.gate, parsed.terminal]).toEqual(['B22', '8']);
    expect([parsed.destinationGate, parsed.destinationTerminal]).toEqual(['C3', '5']);
    // Backward compatible: a state without the arrival pair still parses.
    expect(LiveActivityContentStateV1.parse(MINIMAL).destinationGate).toBeUndefined();
  });

  it("stays loose: a newer producer's extra key parses (the encoder strips it)", () => {
    const parsed = LiveActivityContentStateV1.parse({ ...MINIMAL, providerRefs: { aeroapi: 'x' } });
    expect(parsed).toHaveProperty('providerRefs');
  });

  it('stays well inside the ActivityKit payload limit with every field at its bound', () => {
    const full = LiveActivityContentStateV1.parse({
      ...MINIMAL,
      flightKey: 'AAL-9999A-2026-12-31-KJFK-L99999',
      designator: 'AAL1000A',
      originIata: 'JFK',
      destinationIata: 'LHR',
      status: 'en_route',
      gate: 'X'.repeat(MAX.gate),
      terminal: 'T'.repeat(MAX.terminal),
      destinationGate: 'Y'.repeat(MAX.gate),
      destinationTerminal: 'U'.repeat(MAX.terminal),
      estimatedOut: '2026-09-20T04:05:00.000000000Z',
      actualOut: '2026-09-20T04:07:00.000000000Z',
      estimatedIn: '2026-09-20T10:58:00.000000000Z',
      progressPercent: 57.5,
      baggageClaim: 'B'.repeat(MAX.baggageClaim),
    });
    const bytes = new TextEncoder().encode(JSON.stringify(full)).length;
    expect(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES).toBe(4_096);
    expect(bytes).toBeLessThan(LIVE_ACTIVITY_PAYLOAD_LIMIT_BYTES / 4);
  });
});
