/**
 * Key-encryption keys (KEKs) from Workers Secrets.
 *
 * `TOKEN_KEK_V{n}` holds version `n` of the KEK as standard padded base64 of 32 bytes. The
 * highest configured version is `currentVersion`, the one new per-user data-encryption keys
 * (DEKs) are wrapped under; older versions stay configured for as long as any `user_keys` row is
 * still wrapped by them, which is what makes rotation a re-wrap and not a re-encrypt.
 *
 * The KEK is imported ONCE PER ISOLATE as a non-extractable AES-KW key through the memo below.
 * That memo is module-scope state, which the Workers best practices and this repository's own
 * rule (`planeahead/no-module-scope-drizzle`, extended to `betterAuth(`) otherwise forbid. It is
 * allowed here because a `CryptoKey` is not an I/O object (SubtleCrypto acquires no IoContext,
 * so it is safe to hold across requests), the secret is the same for every request in the
 * isolate, and importing it per request would cost a WebCrypto round trip for nothing. The memo
 * is populated lazily on first use inside a handler, never at module evaluation. Nothing
 * user-specific is ever memoised: a DEK is unwrapped per request and dropped.
 */

export interface KeyProvider {
  /** The version new DEKs are wrapped under. */
  readonly currentVersion: number;
  /** The KEK for `version`, rejecting with `UnknownKeyVersionError` when it is not configured. */
  getKek(version: number): Promise<CryptoKey>;
}

export class KekConfigError extends Error {
  override readonly name = 'KekConfigError';
}

export class UnknownKeyVersionError extends Error {
  override readonly name = 'UnknownKeyVersionError';

  constructor(readonly version: number) {
    super(`no KEK is configured for key version ${version} (TOKEN_KEK_V${version})`);
  }
}

export const KEK_BYTES = 32;
/** Versions are scanned 1..MAX; a Worker may hold at most this many KEKs at once. */
export const MAX_KEK_VERSIONS = 32;

const STANDARD_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type KekSecretName = `TOKEN_KEK_V${number}`;

export function kekSecretName(version: number): KekSecretName {
  return `TOKEN_KEK_V${version}`;
}

/** The shape this module reads: the KEK secrets and nothing else. */
export type KekSecrets = { readonly [key in KekSecretName]?: string | undefined };

/**
 * Copies the `TOKEN_KEK_V{n}` values out of a Worker `env` (or any object) into a plain record,
 * so callers hand this module only the secrets it needs rather than the whole environment.
 */
export function readKekSecrets(source: object): KekSecrets {
  const out: Record<string, string | undefined> = {};
  for (let version = 1; version <= MAX_KEK_VERSIONS; version += 1) {
    const name = kekSecretName(version);
    const value: unknown = (source as Record<string, unknown>)[name];
    if (typeof value === 'string') {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Decodes a KEK secret. Standard base64 only: `atob` rejects the base64url alphabet, and a key
 * pasted from a tool that emits base64url would otherwise fail deep inside `importKey` with a
 * message that names neither the secret nor the cause.
 */
export function decodeKekBase64(value: string, name: string): Uint8Array<ArrayBuffer> {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new KekConfigError(`${name} is empty`);
  }
  if (trimmed.includes('-') || trimmed.includes('_')) {
    throw new KekConfigError(
      `${name} is base64url, not standard base64: the value contains '-' or '_'. Encode the 32 ` +
        'key bytes with standard padded base64 (for example `openssl rand -base64 32`).',
    );
  }
  if (!STANDARD_BASE64.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new KekConfigError(`${name} is not standard padded base64`);
  }
  const binary = atob(trimmed);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.length !== KEK_BYTES) {
    throw new KekConfigError(`${name} must decode to ${KEK_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** Imports a KEK as a non-extractable AES-KW key that can only wrap and unwrap. */
export function importKek(base64: string, name: string): Promise<CryptoKey> {
  const raw = decodeKekBase64(base64, name);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-KW' }, false, ['wrapKey', 'unwrapKey']);
}

/** Every version that has a non-empty secret, ascending. */
export function configuredKekVersions(env: KekSecrets): number[] {
  const versions: number[] = [];
  for (let version = 1; version <= MAX_KEK_VERSIONS; version += 1) {
    const value = env[kekSecretName(version)];
    if (typeof value === 'string' && value.trim() !== '') {
      versions.push(version);
    }
  }
  return versions;
}

/**
 * Per-isolate memo of imported KEKs. See the module comment for why this module-scope Map is
 * allowed. Keyed by version AND secret value so a test that constructs providers with different
 * secrets for the same version in one isolate never reads another test's key.
 */
const kekMemo = new Map<string, Promise<CryptoKey>>();

export function createWorkersSecretKeyProvider(env: KekSecrets): KeyProvider {
  const versions = configuredKekVersions(env);
  const currentVersion = versions.at(-1);
  if (currentVersion === undefined) {
    throw new KekConfigError(
      'no TOKEN_KEK_V{n} secret is configured; set TOKEN_KEK_V1 with wrangler secret put',
    );
  }
  // Validate every configured version eagerly, so a malformed secret fails at construction (the
  // first request) rather than on the first row that happens to need that version.
  for (const version of versions) {
    decodeKekBase64(env[kekSecretName(version)] ?? '', kekSecretName(version));
  }
  return {
    currentVersion,
    getKek(version) {
      const name = kekSecretName(version);
      const value = env[name];
      if (typeof value !== 'string' || value.trim() === '') {
        return Promise.reject(new UnknownKeyVersionError(version));
      }
      const memoKey = `${version}:${value}`;
      let pending = kekMemo.get(memoKey);
      if (pending === undefined) {
        pending = importKek(value, name);
        kekMemo.set(memoKey, pending);
        pending.catch(() => {
          kekMemo.delete(memoKey);
        });
      }
      return pending;
    },
  };
}

/** A provider over keys the caller already holds. Tests use it; the Worker never does. */
export function createStaticKeyProvider(
  keys: ReadonlyMap<number, CryptoKey>,
  currentVersion: number,
): KeyProvider {
  return {
    currentVersion,
    getKek(version) {
      const key = keys.get(version);
      return key === undefined
        ? Promise.reject(new UnknownKeyVersionError(version))
        : Promise.resolve(key);
    },
  };
}
