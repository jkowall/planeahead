/**
 * Replay markers for native identity tokens.
 *
 * The nonce on both native endpoints binds a token to the request that carries it, and nothing
 * more: whoever captured one request body (a compromised device, an interception proxy, a client
 * log) could replay it for the token's lifetime and mint a session each time. So a presented
 * token is recorded in the `CACHE` KV namespace under its `jti` (or, absent one, the SHA-256 of
 * the token) for the token's remaining lifetime, and a second presentation is refused.
 *
 * Best effort, by design. KV is eventually consistent, its minimum TTL is 60 seconds, and two
 * presentations racing through different colos can both pass the read. A KV failure is logged
 * and does NOT block the sign-in: the marker is a brake on replay, the signature, issuer,
 * audience, expiry and nonce checks are the authentication. Increment 9 should also treat the
 * server-issued nonce as the stronger long-term option (docs/security/threat-model.md).
 */

import { sha256Hex } from '../crypto/hash';
import { type Logger, errorFields } from '../observability/log';

export const USED_ID_TOKEN_PREFIX = 'used_id_tokens';
/** Workers KV refuses an `expirationTtl` under 60 seconds. */
export const KV_MIN_TTL_SECONDS = 60;

export type IdentityProvider = 'apple' | 'google';

/** The subset of a KV namespace the markers use, so a test can hand in a stub. */
export interface ReplayMarkerStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** `used_id_tokens:<provider>:<jti or sha256hex(token)>`. The token itself never becomes a key. */
export async function identityTokenReplayKey(
  provider: IdentityProvider,
  token: string,
  jti: string | null,
): Promise<string> {
  const id = jti !== null && jti !== '' ? jti : await sha256Hex(token);
  return `${USED_ID_TOKEN_PREFIX}:${provider}:${id}`;
}

/** Whether the token was presented before. A failed read answers false and logs. */
export async function wasIdentityTokenUsed(
  store: ReplayMarkerStore,
  key: string,
  log: Logger,
): Promise<boolean> {
  try {
    return (await store.get(key)) !== null;
  } catch (error) {
    log.warn('used_id_token_check_failed', errorFields(error));
    return false;
  }
}

/** Records the token until it expires. A failed write is logged and does not block. */
export async function markIdentityTokenUsed(
  store: ReplayMarkerStore,
  key: string,
  expiresAtSeconds: number,
  log: Logger,
  nowMs: number = Date.now(),
): Promise<void> {
  const remaining = Math.ceil(expiresAtSeconds - nowMs / 1000);
  const expirationTtl = Math.max(KV_MIN_TTL_SECONDS, remaining);
  try {
    await store.put(key, '1', { expirationTtl });
  } catch (error) {
    log.warn('used_id_token_mark_failed', errorFields(error));
  }
}
