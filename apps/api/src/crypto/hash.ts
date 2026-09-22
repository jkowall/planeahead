/**
 * Hashing and constant-time comparison on WebCrypto. Token hashes use SHA-256 here and nowhere
 * else; there are no HKDF subkeys in this Worker (plan section 10).
 */

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  // A copy into a fresh ArrayBuffer: the encoder's own buffer is typed ArrayBufferLike.
  return new Uint8Array(new TextEncoder().encode(value));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

export async function sha256(data: Uint8Array | string): Promise<Uint8Array<ArrayBuffer>> {
  const input = typeof data === 'string' ? utf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return bytesToHex(await sha256(data));
}

/**
 * Constant-time equality. `crypto.subtle.timingSafeEqual` THROWS a TypeError on unequal byte
 * lengths rather than returning false, so a malformed token would turn into a 500 without the
 * length check first. The length comparison itself leaks only the length, which the attacker
 * chose.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  // Hash first so the comparison is over fixed-length digests and never over the secret itself.
  return timingSafeEqualBytes(await sha256(a), await sha256(b));
}
