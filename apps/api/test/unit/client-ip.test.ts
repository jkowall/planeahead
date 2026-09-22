/**
 * `normaliseClientIp` (src/validation/client-ip.ts) must key one client the way Better Auth's
 * limiter does, or the two caps in front of `/sign-in/magic-link` disagree about who is asking.
 * The expected values are the documented outputs of `@better-auth/core`'s `normalizeIP` with
 * its default `ipv6Subnet` of 64, plus the cases the re-review's probe used (25 addresses in one
 * /64 must be ONE requester).
 */

import { describe, expect, it } from 'vitest';
import { normaliseClientIp } from '../../src/validation/client-ip';

describe('normaliseClientIp', () => {
  it('keeps IPv4 as is, trimmed', () => {
    expect(normaliseClientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normaliseClientIp('  10.0.0.1 ')).toBe('10.0.0.1');
  });

  it('reduces IPv6 to its /64 in canonical form, exactly as Better Auth documents it', () => {
    expect(normaliseClientIp('2001:DB8::1')).toBe('2001:0db8:0000:0000:0000:0000:0000:0000');
    expect(normaliseClientIp('2001:db8::1')).toBe('2001:0db8:0000:0000:0000:0000:0000:0000');
  });

  it('maps every /128 of one /64 onto the same key, and a neighbouring /64 onto another', () => {
    const subnet = new Set<string | null>();
    for (let host = 1; host <= 25; host += 1) {
      subnet.add(normaliseClientIp(`2001:db8:1:2::${host.toString(16)}`));
    }
    subnet.add(normaliseClientIp('2001:db8:1:2:aaaa:bbbb:cccc:dddd'));
    subnet.add(normaliseClientIp('2001:DB8:0001:0002:FFFF:FFFF:FFFF:FFFF'));

    expect([...subnet]).toEqual(['2001:0db8:0001:0002:0000:0000:0000:0000']);
    expect(normaliseClientIp('2001:db8:1:3::9')).toBe('2001:0db8:0001:0003:0000:0000:0000:0000');
  });

  it('turns an IPv4-mapped IPv6 address into its IPv4', () => {
    expect(normaliseClientIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normaliseClientIp('0:0:0:0:0:ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normaliseClientIp('::ffff:c000:0201')).toBe('192.0.2.1');
  });

  it('treats anything that is not an address as absent', () => {
    expect(normaliseClientIp(null)).toBeNull();
    expect(normaliseClientIp(undefined)).toBeNull();
    expect(normaliseClientIp('')).toBeNull();
    expect(normaliseClientIp('   ')).toBeNull();
    expect(normaliseClientIp('not-an-ip')).toBeNull();
    expect(normaliseClientIp('203.0.113.7, 10.0.0.1')).toBeNull();
    expect(normaliseClientIp('2001:db8::1::2')).toBeNull();
  });
});
