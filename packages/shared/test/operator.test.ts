import { describe, expect, it } from 'vitest';
import { buildFlightKey } from '../src/flight-key';
import { CODESHARE_STATUSES, CodeshareStatusSchema } from '../src/flight-status';
import {
  callsignOperator,
  parseAirlineCallsign,
  resolveOperator,
  type ResolveOperatorInput,
  type ResolvedOperator,
} from '../src/operator';

const AA3456: ResolveOperatorInput = {
  marketingIcao: 'AAL',
  marketingNumber: '3456',
  codeshareStatus: 'Unknown',
};

describe('resolveOperator (ADR 0010)', () => {
  it.each<[string, Partial<ResolveOperatorInput>, ResolvedOperator]>([
    [
      'IsOperator: the marketing carrier flies it under the marketing number',
      { codeshareStatus: 'IsOperator', callSign: 'ENY3456', hint: 'ENY' },
      { operatingCarrierIcao: 'AAL', operatingFlightNumber: '3456', operatorSource: 'provider' },
    ],
    [
      'Unknown: the marketing designator stands in, callsign and hint ignored',
      { codeshareStatus: 'Unknown', callSign: 'ENY3456', hint: 'ENY' },
      { operatingCarrierIcao: 'AAL', operatingFlightNumber: '3456', operatorSource: 'marketing' },
    ],
    [
      'IsCodeshared with an airline callsign: the callsign carrier and number',
      { codeshareStatus: 'IsCodeshared', callSign: 'ENY3456', hint: 'SKW' },
      { operatingCarrierIcao: 'ENY', operatingFlightNumber: '3456', operatorSource: 'callsign' },
    ],
    [
      'IsCodeshared flown under another number: the callsign number, never the marketing one',
      { codeshareStatus: 'IsCodeshared', callSign: 'AAL100', hint: 'ENY' },
      { operatingCarrierIcao: 'AAL', operatingFlightNumber: '100', operatorSource: 'callsign' },
    ],
    [
      'IsCodeshared with a spaced, lower-case, zero-padded callsign',
      { codeshareStatus: 'IsCodeshared', callSign: ' eny 03456 ' },
      { operatingCarrierIcao: 'ENY', operatingFlightNumber: '3456', operatorSource: 'callsign' },
    ],
    [
      'IsCodeshared with a single-letter callsign suffix, which is a flight number',
      { codeshareStatus: 'IsCodeshared', callSign: 'BAW15L' },
      { operatingCarrierIcao: 'BAW', operatingFlightNumber: '15L', operatorSource: 'callsign' },
    ],
    [
      'IsCodeshared with an alphanumeric ATC callsign: not a designator, so the hint',
      { codeshareStatus: 'IsCodeshared', callSign: 'BAW12AB', hint: 'ENY' },
      { operatingCarrierIcao: 'ENY', operatingFlightNumber: '3456', operatorSource: 'hint' },
    ],
    [
      'IsCodeshared with an alphanumeric ATC callsign and no hint: the marketing designator',
      { codeshareStatus: 'IsCodeshared', callSign: 'BAW12AB' },
      { operatingCarrierIcao: 'AAL', operatingFlightNumber: '3456', operatorSource: 'marketing' },
    ],
    [
      'IsCodeshared without a callsign: the regional hint with the marketing number',
      { codeshareStatus: 'IsCodeshared', hint: 'ENY' },
      { operatingCarrierIcao: 'ENY', operatingFlightNumber: '3456', operatorSource: 'hint' },
    ],
    [
      'IsCodeshared with a registration for a callsign: the hint',
      { codeshareStatus: 'IsCodeshared', callSign: 'N123AA', hint: 'ENY' },
      { operatingCarrierIcao: 'ENY', operatingFlightNumber: '3456', operatorSource: 'hint' },
    ],
    [
      'IsCodeshared with a lower-case hint',
      { codeshareStatus: 'IsCodeshared', callSign: null, hint: 'eny' },
      { operatingCarrierIcao: 'ENY', operatingFlightNumber: '3456', operatorSource: 'hint' },
    ],
    [
      'IsCodeshared with a malformed hint: the marketing designator',
      { codeshareStatus: 'IsCodeshared', hint: 'EN' },
      { operatingCarrierIcao: 'AAL', operatingFlightNumber: '3456', operatorSource: 'marketing' },
    ],
    [
      'IsCodeshared with nothing to go on: the marketing designator',
      { codeshareStatus: 'IsCodeshared' },
      { operatingCarrierIcao: 'AAL', operatingFlightNumber: '3456', operatorSource: 'marketing' },
    ],
  ])('%s', (_label, overrides, expected) => {
    expect(resolveOperator({ ...AA3456, ...overrides })).toEqual(expected);
  });

  it('covers every codeshare status of the vendored spec, and parses a new one as Unknown', () => {
    expect(CODESHARE_STATUSES).toEqual(['Unknown', 'IsOperator', 'IsCodeshared']);
    expect(CodeshareStatusSchema.parse('IsWetLeased')).toBe('Unknown');
    expect(CodeshareStatusSchema.safeParse(2).success).toBe(false);
    for (const codeshareStatus of CODESHARE_STATUSES) {
      const resolved = resolveOperator({ ...AA3456, codeshareStatus });
      expect(resolved.operatingCarrierIcao).toMatch(/^[A-Z]{3}$/);
      expect(resolved.operatingFlightNumber).toMatch(/^[1-9][0-9]{0,3}[A-Z]?$/);
    }
  });

  it('never pairs a callsign carrier with the marketing number (the collision ruling I3 closes)', () => {
    // BA 1512 is a codeshare on American's AA 100 (callsign AAL100); AA 1512 is an unrelated
    // American flight from the same airport on the same day. Keyed by callsign carrier plus the
    // MARKETING number, the codeshare would take AA 1512's key and its tracker.
    const key = (resolved: ResolvedOperator): string =>
      buildFlightKey({
        operatingCarrierIcao: resolved.operatingCarrierIcao,
        flightNumber: resolved.operatingFlightNumber,
        scheduledDepartureDateLocal: '2026-09-22',
        originIcao: 'KJFK',
      });
    const codeshare = resolveOperator({
      marketingIcao: 'BAW',
      marketingNumber: '1512',
      codeshareStatus: 'IsCodeshared',
      callSign: 'AAL100',
    });
    const unrelated = resolveOperator({
      marketingIcao: 'AAL',
      marketingNumber: '1512',
      codeshareStatus: 'IsOperator',
      callSign: 'AAL1512',
    });
    const metal = resolveOperator({
      marketingIcao: 'AAL',
      marketingNumber: '100',
      codeshareStatus: 'IsOperator',
    });
    expect(key(codeshare)).toBe('AAL-100-2026-09-22-KJFK');
    expect(key(unrelated)).toBe('AAL-1512-2026-09-22-KJFK');
    expect(key(codeshare)).not.toBe(key(unrelated));
    // And the codeshare lands on the operator's own instance: one tracker for one aircraft.
    expect(key(codeshare)).toBe(key(metal));
  });
});

describe('callsignOperator', () => {
  it.each<[string | null | undefined, string | undefined]>([
    ['AAL100', 'AAL'],
    ['ENY 3456', 'ENY'],
    ['swa1234', 'SWA'],
    ['BAW12AB', 'BAW'],
    ['N123AB', undefined],
    ['GABCD', undefined],
    ['AAL', undefined],
    ['', undefined],
    [null, undefined],
    [undefined, undefined],
  ])('%s -> %s', (callSign, expected) => {
    expect(callsignOperator(callSign)).toBe(expected);
  });
});

describe('parseAirlineCallsign', () => {
  it.each<[string | null | undefined, { carrierIcao: string; flightNumber: string } | undefined]>([
    ['AAL100', { carrierIcao: 'AAL', flightNumber: '100' }],
    ['ENY 3456', { carrierIcao: 'ENY', flightNumber: '3456' }],
    ['aal0100', { carrierIcao: 'AAL', flightNumber: '100' }],
    ['BAW15L', { carrierIcao: 'BAW', flightNumber: '15L' }],
    ['BAW12AB', undefined],
    ['EZY83TL', undefined],
    ['AAL12345', undefined],
    ['AAL0', undefined],
    ['N123AB', undefined],
    ['', undefined],
    [null, undefined],
    [undefined, undefined],
  ])('%s -> %j', (callSign, expected) => {
    expect(parseAirlineCallsign(callSign)).toEqual(expected);
  });
});
