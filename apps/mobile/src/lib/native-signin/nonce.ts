/**
 * Nonces for the native sign-in paths: 32 random bytes as 64 hex characters.
 *
 * The two providers use them DIFFERENTLY, and the difference is load bearing:
 * - Apple copies whatever nonce the app passes into the identity token verbatim. PlaneAhead's
 *   convention (increment 5) is to pass `sha256hex(rawNonce)` to Apple and `rawNonce` to the API,
 *   which recomputes the hash and compares it with the claim. The hashing is ours, not Apple's.
 * - Google compares the raw nonce: the value given to `configure({ nonce })` is the token's
 *   `nonce` claim, and the API checks `claims.nonce === rawNonce`.
 */

import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
  getRandomBytes,
} from 'expo-crypto';

export function randomNonce(): string {
  let hex = '';
  for (const byte of getRandomBytes(32)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function sha256Hex(value: string): Promise<string> {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, value, { encoding: CryptoEncoding.HEX });
}

export class NativeSignInError extends Error {
  override readonly name = 'NativeSignInError';
  readonly provider: 'apple' | 'google';
  /** The API's code (`NONCE_REQUIRED`, `IDENTITY_TOKEN_REPLAYED`...) or a local one. */
  readonly code: string;
  readonly status: number | null;

  constructor(provider: 'apple' | 'google', code: string, status: number | null = null) {
    super(`${provider} sign-in failed: ${code}`);
    this.provider = provider;
    this.code = code;
    this.status = status;
  }
}

/** Better Auth's error bodies carry a `code`; better-fetch's error type does not declare it. */
export function authErrorCode(error: { readonly message?: string | undefined }): string {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' && code !== '' ? code : 'sign_in_failed';
}

export type NativeSignInResult =
  { readonly status: 'signed_in' } | { readonly status: 'cancelled' };
