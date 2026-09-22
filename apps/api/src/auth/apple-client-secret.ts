/**
 * The Sign in with Apple client secret: an ES256 JWT minted from the `.p8` key
 * (https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret).
 *
 * Header `{ alg: ES256, kid }`, payload `{ iss: teamId, iat, exp, aud: https://appleid.apple.com,
 * sub: clientId }`, one hour lifetime (Apple allows up to six months). It is cached per isolate
 * for 55 minutes so the signing cost is paid once per isolate lifetime rather than once per
 * sign-in; the cache holds the minted JWT, never the private key.
 */

import { SignJWT, importPKCS8 } from 'jose';
import { sha256Hex } from '../crypto/hash';

export const APPLE_AUDIENCE = 'https://appleid.apple.com';
export const CLIENT_SECRET_LIFETIME_SECONDS = 60 * 60;
export const CLIENT_SECRET_CACHE_SECONDS = 55 * 60;

export interface AppleClientSecretConfig {
  readonly teamId: string;
  readonly keyId: string;
  /** The iOS bundle id for native sign-in. */
  readonly clientId: string;
  /** PKCS8 PEM, with real newlines or the `\n` escape a secret store flattens them to. */
  readonly privateKeyPem: string;
}

export class AppleKeyError extends Error {
  override readonly name = 'AppleKeyError';
}

/** Restores the newlines a `.dev.vars` line or `wrangler secret put` flattened to `\n`. */
export function normalisePem(value: string): string {
  return value.replaceAll('\\n', '\n').trim();
}

/** Imports the `.p8` as an ES256 signing key (workerd accepts pkcs8 for ECDSA P-256, tested). */
export async function importApplePrivateKey(pem: string): Promise<CryptoKey> {
  const normalised = normalisePem(pem);
  if (!normalised.startsWith('-----BEGIN PRIVATE KEY-----')) {
    throw new AppleKeyError('APPLE_SIWA_P8 must be a PKCS8 PEM (-----BEGIN PRIVATE KEY-----)');
  }
  try {
    return await importPKCS8(normalised, 'ES256');
  } catch (error) {
    throw new AppleKeyError(
      `APPLE_SIWA_P8 could not be imported as an ES256 key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function mintAppleClientSecret(
  config: AppleClientSecretConfig,
  nowMs: number = Date.now(),
): Promise<string> {
  const key = await importApplePrivateKey(config.privateKeyPem);
  const issuedAt = Math.floor(nowMs / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(config.clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + CLIENT_SECRET_LIFETIME_SECONDS)
    .sign(key);
}

interface CachedSecret {
  readonly secret: string;
  readonly expiresAtMs: number;
}

export interface AppleClientSecretCache {
  get(config: AppleClientSecretConfig, nowMs?: number): Promise<string>;
}

/**
 * A cache keyed by a digest of the whole configuration, so two configurations that share ids
 * but not keys (which only happens in tests) never receive each other's secret.
 */
export function createAppleClientSecretCache(): AppleClientSecretCache {
  const entries = new Map<string, CachedSecret>();
  return {
    async get(config, nowMs = Date.now()) {
      const cacheKey = await sha256Hex(
        `${config.teamId}|${config.keyId}|${config.clientId}|${normalisePem(config.privateKeyPem)}`,
      );
      const cached = entries.get(cacheKey);
      if (cached !== undefined && cached.expiresAtMs > nowMs) {
        return cached.secret;
      }
      const secret = await mintAppleClientSecret(config, nowMs);
      entries.set(cacheKey, {
        secret,
        expiresAtMs: nowMs + CLIENT_SECRET_CACHE_SECONDS * 1000,
      });
      return secret;
    },
  };
}

/**
 * The isolate's cache. Module scope on purpose (a minted JWT, no I/O object, no per-request
 * state); see src/crypto/key-provider.ts for the same reasoning.
 */
export const appleClientSecrets = createAppleClientSecretCache();
