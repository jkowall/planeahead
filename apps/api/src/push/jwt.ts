/**
 * The two JWTs the push transport signs, with WebCrypto and nothing else (increment 14, ruling P3):
 *
 *   - the APNs provider token, ES256 over P-256. The `.p8` Apple issues is a PKCS#8 PEM with the
 *     named curve (`prime256v1`), which `importKey('pkcs8', ...)` takes as it is. WebCrypto's
 *     ECDSA `sign()` returns r and s concatenated (IEEE P1363, 64 bytes for P-256), which is
 *     exactly the JWS ES256 signature (RFC 7518 section 3.4): no DER conversion (R1 F20).
 *   - the FCM service-account assertion, RS256 (RSASSA-PKCS1-v1_5 with SHA-256) over the account's
 *     PKCS#8 RSA key, exchanged at Google's token endpoint for an access token (R1 F30).
 *
 * `jose` could do both, and signs the Sign in with Apple client secret elsewhere; these stay on
 * the bare API so the signature format the spec names is the code's own, and so a test can
 * check the raw bytes.
 */

import { normalisePem } from '../auth/apple-client-secret';
import { utf8 } from '../crypto/hash';

export class PushKeyError extends Error {
  override readonly name = 'PushKeyError';
}

/** base64url without padding (RFC 7515 section 2). */
export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function base64UrlJson(value: unknown): string {
  return base64Url(utf8(JSON.stringify(value)));
}

/** Decodes base64url (padding optional). */
export function fromBase64Url(text: string): Uint8Array {
  const standard = text.replaceAll('-', '+').replaceAll('_', '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** The DER bytes of a `-----BEGIN PRIVATE KEY-----` PEM, with `\n` escapes restored first. */
export function pkcs8Der(pem: string, secretName: string): ArrayBuffer {
  const normalised = normalisePem(pem);
  const lines = normalised.split('\n').map((line) => line.trim());
  if (lines[0] !== '-----BEGIN PRIVATE KEY-----' || lines.at(-1) !== '-----END PRIVATE KEY-----') {
    throw new PushKeyError(`${secretName} must be a PKCS8 PEM (-----BEGIN PRIVATE KEY-----)`);
  }
  const body = lines.slice(1, -1).join('');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw new PushKeyError(`${secretName} is not base64 between its PEM armour lines`);
  }
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    der[index] = binary.charCodeAt(index);
  }
  return der.buffer;
}

/** The `.p8` as an ES256 signing key. */
export async function importApnsKey(pem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      pkcs8Der(pem, 'APNS_KEY_P8'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
  } catch (error) {
    if (error instanceof PushKeyError) {
      throw error;
    }
    throw new PushKeyError('APNS_KEY_P8 could not be imported as a P-256 key');
  }
}

/** The service account's RSA key as an RS256 signing key. */
export async function importFcmKey(pem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      pkcs8Der(pem, 'FCM_SERVICE_ACCOUNT_JSON private_key'),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch (error) {
    if (error instanceof PushKeyError) {
      throw error;
    }
    throw new PushKeyError('FCM_SERVICE_ACCOUNT_JSON private_key could not be imported as RSA');
  }
}

/** A compact JWS: `base64url(header).base64url(claims).base64url(signature)`. */
export async function signJwt(
  header: Readonly<Record<string, unknown>>,
  claims: Readonly<Record<string, unknown>>,
  key: CryptoKey,
): Promise<string> {
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const algorithm =
    header['alg'] === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  const signature = await crypto.subtle.sign(algorithm, key, utf8(signingInput));
  return `${signingInput}.${base64Url(signature)}`;
}
