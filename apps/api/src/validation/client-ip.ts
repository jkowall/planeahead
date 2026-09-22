/**
 * The client address as the magic-link gate keys it.
 *
 * Cloudflare sets `cf-connecting-ip` to exactly one address, IPv4 or IPv6. An IPv6 client is
 * handed a whole /64 by any ISP or VPS and can present a different /128 on every request, so a
 * cap keyed by the raw address is no cap for such a client: the re-review's probe sent 25
 * requests for one inbox from 25 addresses in one /64 and every one was counted as a new
 * requester. The address is therefore reduced the way Better Auth's own limiter reduces it
 * (`@better-auth/core`'s `normalizeIP`, `ipv6Subnet` 64, which `better-auth` does not
 * re-export): IPv4 as is, an IPv4-mapped IPv6 address as its IPv4, and IPv6 to its /64 prefix
 * in canonical form (eight zero-padded lower-case groups). Both limiters then see one client.
 * Anything that is not a valid address is treated as absent rather than as a fresh bucket per
 * junk value; the unit test pins the outputs to Better Auth's documented examples.
 */

import * as z from 'zod';

const ipv4 = z.ipv4();
const ipv6 = z.ipv6();

/** A /64: the first four 16-bit groups identify the subnet, the rest are zeroed. */
export const IPV6_SUBNET_GROUPS = 4;
const IPV6_GROUPS = 8;

function expandIpv6(address: string): string[] {
  // Validated already: at most one `::`, each group one to four hex digits (or, in the last
  // position, an embedded dotted quad, which the /64 reduction zeroes out anyway).
  const [head = '', tail = ''] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const missing = address.includes('::') ? IPV6_GROUPS - left.length - right.length : 0;
  return [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right].map((group) =>
    group.padStart(4, '0').toLowerCase(),
  );
}

/** `::ffff:192.0.2.1`, `0:0:0:0:0:ffff:192.0.2.1` or `::ffff:c000:0201` as `192.0.2.1`. */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /(?:^::ffff:|:ffff:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted?.[1] !== undefined && ipv4.safeParse(dotted[1]).success) {
    return dotted[1];
  }
  const groups = expandIpv6(address);
  const prefixIsMapped =
    groups.slice(0, 5).every((group) => group === '0000') && groups[5] === 'ffff';
  const [high, low] = [groups[6], groups[7]];
  if (!prefixIsMapped || high === undefined || low === undefined || high.includes('.')) {
    return null;
  }
  const octet = (hex: string) => Number.parseInt(hex, 16);
  return [
    octet(high.slice(0, 2)),
    octet(high.slice(2)),
    octet(low.slice(0, 2)),
    octet(low.slice(2)),
  ].join('.');
}

/**
 * The address one client is counted under, or null when the header carries no valid address.
 */
export function normaliseClientIp(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const value = raw.trim();
  if (value === '') {
    return null;
  }
  if (ipv4.safeParse(value).success) {
    return value;
  }
  if (!ipv6.safeParse(value).success) {
    return null;
  }
  const mapped = mappedIpv4(value);
  if (mapped !== null) {
    return mapped;
  }
  return expandIpv6(value)
    .map((group, index) => (index < IPV6_SUBNET_GROUPS ? group : '0000'))
    .join(':');
}
