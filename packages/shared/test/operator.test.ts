import { describe, expect, it } from 'vitest';
import {
  CODESHARE_STATUSES,
  CodeshareStatusSchema,
  callsignOperator,
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
      'IsOperator: the marketing carrier flies it',
      { codeshareStatus: 'IsOperator', callSign: 'ENY3456', hint: 'ENY' },
      { operatingCarrierIcao: 'AAL', operatorSource: 'provider' },
    ],
    [
      'Unknown: the marketing carrier stands in, callsign and hint ignored',
      { codeshareStatus: 'Unknown', callSign: 'ENY3456', hint: 'ENY' },
      { operatingCarrierIcao: 'AAL', operatorSource: 'marketing' },
    ],
    [
      'IsCodeshared with an airline callsign: the callsign prefix',
      { codeshareStatus: 'IsCodeshared', callSign: 'ENY3456', hint: 'SKW' },
      { operatingCarrierIcao: 'ENY', operatorSource: 'callsign' },
    ],
    [
      'IsCodeshared with a spaced, lower-case callsign',
      { codeshareStatus: 'IsCodeshared', callSign: ' eny 3456 ' },
      { operatingCarrierIcao: 'ENY', operatorSource: 'callsign' },
    ],
    [
      'IsCodeshared with an alphanumeric callsign suffix',
      { codeshareStatus: 'IsCodeshared', callSign: 'BAW12AB' },
      { operatingCarrierIcao: 'BAW', operatorSource: 'callsign' },
    ],
    [
      'IsCodeshared without a callsign: the regional hint',
      { codeshareStatus: 'IsCodeshared', hint: 'ENY' },
      { operatingCarrierIcao: 'ENY', operatorSource: 'hint' },
    ],
    [
      'IsCodeshared with a registration for a callsign: the hint',
      { codeshareStatus: 'IsCodeshared', callSign: 'N123AA', hint: 'ENY' },
      { operatingCarrierIcao: 'ENY', operatorSource: 'hint' },
    ],
    [
      'IsCodeshared with a lower-case hint',
      { codeshareStatus: 'IsCodeshared', callSign: null, hint: 'eny' },
      { operatingCarrierIcao: 'ENY', operatorSource: 'hint' },
    ],
    [
      'IsCodeshared with a malformed hint: the marketing carrier',
      { codeshareStatus: 'IsCodeshared', hint: 'EN' },
      { operatingCarrierIcao: 'AAL', operatorSource: 'marketing' },
    ],
    [
      'IsCodeshared with nothing to go on: the marketing carrier',
      { codeshareStatus: 'IsCodeshared' },
      { operatingCarrierIcao: 'AAL', operatorSource: 'marketing' },
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
    }
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
