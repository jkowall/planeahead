/**
 * Push credentials (increment 14, ruling P3): what `PushAuth` mints, when, and how an isolate
 * holds what it was given.
 *
 * APNs. One ES256 provider token per APNs environment (`apns:sandbox`, `apns:production`), shared
 * by every isolate. Apple rejects a token whose `iat` is over an hour old (403
 * `ExpiredProviderToken`) and a new token more than once per 20 minutes on one connection (429
 * `TooManyProviderTokenUpdates`, R1 F18); how Cloudflare pools origin connections across isolates
 * is unknown (R1 U2), so one object mints for all of them: a token lives 30 minutes
 * (`APNS_TOKEN_WINDOW_MS`, so any token in use is at most 30 minutes old, well inside the hour),
 * and a new one is never minted within 20 minutes of the last (`APNS_MIN_MINT_GAP_MS`), even when
 * a provider refusal pulled the window in (`expire`). The one exception is a changed key: a token
 * signed by a key the Worker no longer holds is replaced at once.
 *
 * FCM. The service account's RS256 assertion is exchanged at Google's token endpoint for a
 * one-hour access token (R1 F30), cached until `FCM_EXPIRY_MARGIN_MS` before it expires, and not
 * re-exchanged within `FCM_MIN_EXCHANGE_GAP_MS` of the last exchange after a provider refused the
 * access token (`expire`). An exchange that FAILED (Google answered 4xx, 429 or 5xx, or the
 * request never completed) is not repeated within the same gap either: `PushAuth` answers the
 * stored failure until it has passed (review ruling R8).
 *
 * Isolates. `durableCredentialSource` keeps the token an object handed out in a module-scope map
 * until that token's window ends (`notAfterMs`), keyed by the credential and a fingerprint of the
 * key material (its DER bytes, ruling R9), so a rotated secret is a miss. The map holds minted
 * tokens only, never a key and never request state, like the Sign in with Apple secret cache
 * (src/auth/apple-client-secret.ts).
 *
 * Nothing here logs a token, a key or an assertion.
 */

import {
  PUSH_CREDENTIAL_FAILURES,
  RPC_SCHEMA_VERSION,
  type PushCredentialFailure,
  type PushCredentialName,
} from '@planeahead/shared';
import type { Env } from '../env';
import { normalisePem } from '../auth/apple-client-secret';
import { sha256Hex, utf8 } from '../crypto/hash';
import {
  apnsMaterial,
  fcmServiceAccount,
  type ApnsMaterial,
  type FcmServiceAccount,
  type Material,
} from './config';
import { PushKeyError, importApnsKey, importFcmKey, pkcs8Der, signJwt } from './jwt';

/** An APNs token is served for 30 minutes after it is minted. */
export const APNS_TOKEN_WINDOW_MS = 30 * 60_000;
/** Apple: "Refresh your token no more than once every 20 minutes". */
export const APNS_MIN_MINT_GAP_MS = 20 * 60_000;
/** Apple rejects an `iat` more than an hour old; no served token may come near it. */
export const APNS_MAX_TOKEN_AGE_MS = 60 * 60_000;
/** The FCM assertion's lifetime; Google refuses `exp` more than an hour after `iat`. */
export const FCM_ASSERTION_LIFETIME_SECONDS = 3600;
/** An FCM access token is replaced this long before it expires. */
export const FCM_EXPIRY_MARGIN_MS = 5 * 60_000;
/**
 * After a provider refused the access token, the next exchange waits at least this long after the
 * last one; after a failed exchange, at least this long after the failure (review ruling R8).
 */
export const FCM_MIN_EXCHANGE_GAP_MS = 60_000;
/** Google's token endpoint (the service account's `token_uri` is never followed). */
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** The one scope FCM HTTP v1 sends need (R1 F29). */
export const FCM_OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** The token exchange's timeout, like every push request's. */
export const PUSH_AUTH_TIMEOUT_MS = 10_000;

/** What `PushAuth` stores per credential. */
export interface StoredCredential {
  readonly token: string;
  readonly fingerprint: string;
  readonly mintedAtMs: number;
  readonly notAfterMs: number;
  readonly mintCount: number;
}

/** Whether a credential object serves its stored token or mints a new one. */
export function credentialDecision(
  name: PushCredentialName,
  row: StoredCredential | null,
  fingerprint: string,
  nowMs: number,
): 'serve' | 'mint' {
  if (row === null || row.fingerprint !== fingerprint) {
    return 'mint';
  }
  if (nowMs < row.notAfterMs) {
    return 'serve';
  }
  const floor = name === 'fcm' ? FCM_MIN_EXCHANGE_GAP_MS : APNS_MIN_MINT_GAP_MS;
  if (nowMs - row.mintedAtMs < floor) {
    // Only reachable after `expire` pulled the window in: the floor still holds.
    return 'serve';
  }
  return 'mint';
}

/**
 * Whether `PushAuth` answers a stored failure instead of trying again (review ruling R8): an FCM
 * exchange that failed at `failedAtMs` is not repeated within `FCM_MIN_EXCHANGE_GAP_MS`, so a
 * burst of sends during Google's outage or quota refusal asks Google once a minute, not once a
 * send. An APNs mint is local (no request to Apple) and is never held back.
 */
export function withinFailureGap(
  name: PushCredentialName,
  failedAtMs: number,
  nowMs: number,
): boolean {
  return name === 'fcm' && nowMs - failedAtMs < FCM_MIN_EXCHANGE_GAP_MS;
}

/** The earliest time a new token may be minted for a credential that minted at `mintedAtMs`. */
export function remintAtMs(name: PushCredentialName, mintedAtMs: number, nowMs: number): number {
  const floor = name === 'fcm' ? FCM_MIN_EXCHANGE_GAP_MS : APNS_MIN_MINT_GAP_MS;
  return Math.max(nowMs, mintedAtMs + floor);
}

/** The key material a credential is minted from, or why there is none. */
export type CredentialMaterial =
  | { readonly kind: 'apns'; readonly value: ApnsMaterial }
  | { readonly kind: 'fcm'; readonly value: FcmServiceAccount };

export function credentialMaterial(
  env: Env,
  name: PushCredentialName,
): Material<CredentialMaterial> {
  if (name === 'fcm') {
    const account = fcmServiceAccount(env);
    return account.ok ? { ok: true, value: { kind: 'fcm', value: account.value } } : account;
  }
  const material = apnsMaterial(env);
  return material.ok ? { ok: true, value: { kind: 'apns', value: material.value } } : material;
}

/**
 * A short digest of the key material: a rotated secret changes it. Never the material itself.
 * It hashes the private key's DER bytes, not its PEM text (review ruling R9): the same key put
 * with real newlines or with `\n` escapes (both accepted) is one key, and must not look like a
 * rotation that mints inside Apple's 20 minutes. With the key id and the team id for APNs, and
 * with the client email and the project id for FCM. A PEM whose body does not decode stands in
 * as its normalised text; its first mint fails as `credentials_rejected` anyway.
 */
export async function materialFingerprint(material: CredentialMaterial): Promise<string> {
  const [label, pem, secretName] =
    material.kind === 'apns'
      ? [
          `apns|${material.value.keyId}|${material.value.teamId}|`,
          material.value.keyPem,
          'APNS_KEY_P8',
        ]
      : [
          `fcm|${material.value.clientEmail}|${material.value.projectId}|`,
          material.value.privateKeyPem,
          'FCM_SERVICE_ACCOUNT_JSON private_key',
        ];
  let key: Uint8Array;
  try {
    key = new Uint8Array(pkcs8Der(pem, secretName));
  } catch {
    key = utf8(`pem:${normalisePem(pem)}`);
  }
  const prefix = utf8(label);
  const input = new Uint8Array(prefix.length + key.length);
  input.set(prefix);
  input.set(key, prefix.length);
  return (await sha256Hex(input)).slice(0, 32);
}

/** The APNs provider token: header `alg` ES256 and `kid`, claims `iss` (team id) and `iat`. */
export async function mintApnsProviderToken(
  material: ApnsMaterial,
  nowMs: number,
): Promise<string> {
  const key = await importApnsKey(material.keyPem);
  return signJwt(
    { alg: 'ES256', kid: material.keyId },
    { iss: material.teamId, iat: Math.floor(nowMs / 1000) },
    key,
  );
}

/** The service account's RS256 assertion for the FCM scope. */
export async function signFcmAssertion(account: FcmServiceAccount, nowMs: number): Promise<string> {
  const key = await importFcmKey(account.privateKeyPem);
  const iat = Math.floor(nowMs / 1000);
  return signJwt(
    {
      alg: 'RS256',
      typ: 'JWT',
      ...(account.privateKeyId === null ? {} : { kid: account.privateKeyId }),
    },
    {
      iss: account.clientEmail,
      scope: FCM_OAUTH_SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat,
      exp: iat + FCM_ASSERTION_LIFETIME_SECONDS,
    },
    key,
  );
}

export type ExchangeResult =
  | { readonly ok: true; readonly accessToken: string; readonly expiresInSeconds: number }
  | {
      readonly ok: false;
      readonly failure: Exclude<PushCredentialFailure, 'not_configured'>;
      readonly httpStatus: number | null;
    };

/**
 * The OAuth 2.0 JWT-bearer exchange (RFC 7523) at Google's token endpoint. A 4xx means the account
 * or its key is refused (`credentials_rejected`, not worth a retry); a 5xx, a 429, a timeout or a
 * network failure is `exchange_unavailable`. Every response body is read or cancelled.
 */
export async function exchangeFcmAccessToken(
  account: FcmServiceAccount,
  nowMs: number,
  fetchImpl: typeof fetch,
): Promise<ExchangeResult> {
  const assertion = await signFcmAssertion(account, nowMs);
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(PUSH_AUTH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, failure: 'exchange_unavailable', httpStatus: null };
  }
  if (!response.ok) {
    await response.body?.cancel();
    const retryable = response.status === 429 || response.status >= 500;
    return {
      ok: false,
      failure: retryable ? 'exchange_unavailable' : 'credentials_rejected',
      httpStatus: response.status,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, failure: 'exchange_unavailable', httpStatus: response.status };
  }
  const token = (body as { access_token?: unknown } | null)?.access_token;
  const expiresIn = (body as { expires_in?: unknown } | null)?.expires_in;
  if (
    typeof token !== 'string' ||
    token === '' ||
    typeof expiresIn !== 'number' ||
    expiresIn <= 0
  ) {
    return { ok: false, failure: 'exchange_unavailable', httpStatus: response.status };
  }
  return { ok: true, accessToken: token, expiresInSeconds: Math.floor(expiresIn) };
}

/** When a freshly minted token stops being served. */
export function notAfterFor(kind: 'apns' | 'fcm', nowMs: number, expiresInSeconds = 0): number {
  if (kind === 'apns') {
    return nowMs + APNS_TOKEN_WINDOW_MS;
  }
  const lifetimeMs = expiresInSeconds * 1000;
  // Shortly before expiry; a lifetime shorter than the margin is served for half of it.
  return (
    nowMs +
    (lifetimeMs > FCM_EXPIRY_MARGIN_MS * 2 ? lifetimeMs - FCM_EXPIRY_MARGIN_MS : lifetimeMs / 2)
  );
}

/** Why a mint failed, for the object's status and the caller. */
export function mintFailureOf(error: unknown): Exclude<PushCredentialFailure, 'not_configured'> {
  return error instanceof PushKeyError ? 'credentials_rejected' : 'exchange_unavailable';
}

/** What `PushAuth.current` answers. */
export type PushCredentialResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly mintedAtMs: number;
      readonly notAfterMs: number;
      readonly fingerprint: string;
    }
  | {
      readonly ok: false;
      readonly failure: PushCredentialFailure;
      readonly retryable: boolean;
      readonly problems: readonly string[];
    };

/** What `PushAuth.expire` answers: when a new token may be minted. */
export interface PushCredentialExpireResult {
  readonly remintAtMs: number;
}

/** What `PushAuth.status` answers, for the admin page: never the token. */
export interface PushCredentialStatus {
  readonly name: PushCredentialName;
  readonly mintedAtMs: number | null;
  readonly notAfterMs: number | null;
  readonly mintCount: number;
  readonly lastFailure: { readonly failure: string; readonly atMs: number } | null;
}

/** The three RPCs a credential source needs, narrowed so a test can hand in a fake. */
export interface PushAuthStub {
  current(input: unknown): Promise<PushCredentialResult>;
  expire(input: unknown): Promise<PushCredentialExpireResult>;
}

/** A credential failure the transport maps to an outcome. */
export class PushCredentialError extends Error {
  override readonly name = 'PushCredentialError';
  readonly failure: PushCredentialFailure;
  readonly retryable: boolean;

  constructor(failure: PushCredentialFailure, retryable: boolean) {
    super(`push credential unavailable: ${failure}`);
    this.failure = failure;
    this.retryable = retryable;
  }
}

export function isPushCredentialFailure(value: unknown): value is PushCredentialFailure {
  return (PUSH_CREDENTIAL_FAILURES as readonly unknown[]).includes(value);
}

/** A token an isolate holds, until `notAfterMs`. */
export interface CachedCredential {
  readonly token: string;
  readonly notAfterMs: number;
}

export type CredentialCache = Map<string, CachedCredential>;

/**
 * The isolate's cache. Module scope on purpose: minted tokens with their expiry, no key material,
 * no I/O object, no request state.
 */
export const isolateCredentialCache: CredentialCache = new Map();

/** Where the transport gets its bearer tokens. */
export interface PushCredentialSource {
  /** The current token for a credential; throws `PushCredentialError` when there is none. */
  token(name: PushCredentialName): Promise<string>;
  /** A provider refused `token`: drop it here and in the object; answers when a new one may be minted. */
  expire(name: PushCredentialName, token: string): Promise<number>;
}

export interface DurableCredentialSourceOptions {
  readonly cache?: CredentialCache | undefined;
  readonly now?: (() => number) | undefined;
  /** The object for a credential; the default is `PUSH_AUTH.getByName` at `enam`. */
  readonly stubFor?: ((name: PushCredentialName) => PushAuthStub) | undefined;
}

/** The `PushAuth` object for a credential, at the location hint every object call site uses. */
export function defaultPushAuthStub(env: Env): (name: PushCredentialName) => PushAuthStub {
  return (name) => env.PUSH_AUTH.getByName(name, { locationHint: 'enam' });
}

export function durableCredentialSource(
  env: Env,
  options: DurableCredentialSourceOptions = {},
): PushCredentialSource {
  const cache = options.cache ?? isolateCredentialCache;
  const now = options.now ?? Date.now;
  const stubFor = options.stubFor ?? defaultPushAuthStub(env);
  const cacheKey = async (name: PushCredentialName): Promise<string | null> => {
    const material = credentialMaterial(env, name);
    return material.ok ? `${name}|${await materialFingerprint(material.value)}` : null;
  };
  return {
    async token(name) {
      const key = await cacheKey(name);
      if (key === null) {
        throw new PushCredentialError('not_configured', false);
      }
      const hit = cache.get(key);
      if (hit !== undefined && now() < hit.notAfterMs) {
        return hit.token;
      }
      const result = await stubFor(name).current({ rpcVersion: RPC_SCHEMA_VERSION, name });
      if (!result.ok) {
        throw new PushCredentialError(result.failure, result.retryable);
      }
      cache.set(key, { token: result.token, notAfterMs: result.notAfterMs });
      return result.token;
    },
    async expire(name, token) {
      const key = await cacheKey(name);
      if (key !== null && cache.get(key)?.token === token) {
        cache.delete(key);
      }
      const result = await stubFor(name).expire({ rpcVersion: RPC_SCHEMA_VERSION, name, token });
      return result.remintAtMs;
    },
  };
}
