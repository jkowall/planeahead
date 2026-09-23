/**
 * Identity-provider test helpers: mint the tokens Apple and Google would have issued, signed
 * with keys the suite controls.
 *
 * Two sources of keys:
 *   - `localIdp()` generates an RSA key pair inside the test and exposes it as a local JWKS, for
 *     unit tests that never leave the isolate;
 *   - `fakeProviderIdp(env)` uses the private key `test/globalSetup.ts` injected as
 *     `TEST_IDP_PRIVATE_KEY_PEM`, whose public half the fake provider server publishes at
 *     `APPLE_JWKS_URL` and `GOOGLE_JWKS_URL`, for tests that drive the Worker end to end.
 */

import {
  type JWTPayload,
  type JWTVerifyGetKey,
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  importPKCS8,
} from 'jose';

export const APPLE_TEST_KID = 'planeahead-test-apple-kid';
export const GOOGLE_TEST_KID = 'planeahead-test-google-kid';

export interface TestIdp {
  readonly privateKey: CryptoKey;
  readonly kid: string;
  readonly getKey: JWTVerifyGetKey;
}

export async function localIdp(kid: string = 'local-test-kid'): Promise<TestIdp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    kid,
    getKey: createLocalJWKSet({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }),
  };
}

export interface MintOptions {
  readonly issuer: string;
  readonly audience: string | string[];
  readonly subject: string;
  readonly claims?: JWTPayload;
  /** Seconds since the epoch; defaults to now. */
  readonly issuedAt?: number;
  /** Seconds after `issuedAt`; defaults to 10 minutes. */
  readonly lifetime?: number;
  /** Overrides the key id in the header, to simulate an unknown key. */
  readonly kid?: string;
  readonly alg?: 'RS256' | 'none';
}

export async function mintToken(
  privateKey: CryptoKey,
  kid: string,
  options: MintOptions,
): Promise<string> {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  return new SignJWT({ ...options.claims })
    .setProtectedHeader({ alg: 'RS256', kid: options.kid ?? kid })
    .setIssuer(options.issuer)
    .setAudience(options.audience)
    .setSubject(options.subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + (options.lifetime ?? 600))
    .sign(privateKey);
}

export interface FakeProviderIdp {
  readonly privateKey: CryptoKey;
  mintApple(options: Omit<MintOptions, 'issuer'>): Promise<string>;
  mintGoogle(options: Omit<MintOptions, 'issuer'> & { issuer?: string }): Promise<string>;
}

/** Tokens the fake provider server's JWKS endpoints will validate. */
export async function fakeProviderIdp(env: {
  readonly TEST_IDP_PRIVATE_KEY_PEM?: string;
}): Promise<FakeProviderIdp> {
  const pem = env.TEST_IDP_PRIVATE_KEY_PEM;
  if (pem === undefined) {
    throw new Error('TEST_IDP_PRIVATE_KEY_PEM is not bound; is test/globalSetup.ts running?');
  }
  const privateKey = await importPKCS8(pem, 'RS256');
  return {
    privateKey,
    mintApple: (options) =>
      mintToken(privateKey, APPLE_TEST_KID, { issuer: 'https://appleid.apple.com', ...options }),
    mintGoogle: (options) =>
      mintToken(privateKey, GOOGLE_TEST_KID, {
        issuer: 'https://accounts.google.com',
        ...options,
      }),
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
