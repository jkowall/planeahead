/**
 * Keyed hashes for identifiers the database must never hold in the clear (increment 8): the
 * salted client-IP subject of the anonymous per-IP cap (ruling K2) and the provider subjects and
 * session tokens a deleted account leaves in `deleted_subjects` (ruling K8). HMAC-SHA-256 on
 * WebCrypto, base64url without padding (43 characters for a 32-byte MAC).
 *
 * The keys are Workers secrets and never reach Postgres, so a database dump alone cannot link a
 * hash back to an address or a subject by brute force over the (small) input space.
 */

import { utf8 } from '../crypto/hash';

export class MissingSecretError extends Error {
  override readonly name = 'MissingSecretError';
}

/** The minimum length a keying secret must have; shorter is treated as unset. */
export const MIN_SECRET_LENGTH = 32;

/** The secret, or a `MissingSecretError` naming it (the caller answers 500 before any write). */
export function requireSecret(value: string | undefined, name: string): string {
  if (value === undefined || value.length < MIN_SECRET_LENGTH) {
    throw new MissingSecretError(
      `${name} is not configured (at least ${String(MIN_SECRET_LENGTH)} characters)`,
    );
  }
  return value;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function hmacSha256(
  key: string | Uint8Array<ArrayBuffer>,
  message: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const raw = typeof key === 'string' ? utf8(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, utf8(message)));
}

/**
 * The per-IP counter subject for one UTC day: HMAC(HMAC(secret, day), ip). The salt rotates daily
 * without any stored state, and a subject from one day cannot be matched to the same address on
 * another day. `ip` should already be normalised (an IPv6 address to its /64).
 */
export async function saltedIpSubject(secret: string, ip: string, utcDay: string): Promise<string> {
  const salt = await hmacSha256(secret, `planeahead:ip-salt:${utcDay}`);
  return base64UrlEncode(await hmacSha256(salt, ip));
}

export type DeletedSubjectKind = 'apple' | 'google' | 'session';

/** `{kind}:{base64url HMAC(key, kind:value)}`, the `deleted_subjects.provider_subject_hash` form. */
export async function deletedSubjectHash(
  key: string,
  kind: DeletedSubjectKind,
  value: string,
): Promise<string> {
  return `${kind}:${base64UrlEncode(await hmacSha256(key, `${kind}:${value}`))}`;
}
