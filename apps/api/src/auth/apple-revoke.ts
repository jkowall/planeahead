/**
 * Sign in with Apple token revocation, `POST https://appleid.apple.com/auth/revoke` (increment 8,
 * ruling K8), called by account deletion with the refresh token increment 5 stored
 * envelope-encrypted in `accounts.refresh_token_enc`.
 *
 * Best effort by design. Apple's TN3194: an app must complete an account deletion even without a
 * usable token, and `/auth/revoke` answers 200 with no body whether it revoked something or the
 * token was already invalid, so a 200 proves nothing and a retry is always safe. Nothing here
 * throws: every outcome, a transport failure or a 500 included, comes back as a value the caller
 * writes to `audit_log`, and deletion proceeds. Apple's 4xx error enumeration is unverified
 * (facts sheet section 3), so no code branches on it beyond recording the status.
 */

import type { Env } from '../env';
import { appleClientSecrets, type AppleClientSecretCache } from './apple-client-secret';

export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
/** Apple's revoke answers quickly or not at all; deletion does not wait longer than this. */
export const APPLE_REVOKE_TIMEOUT_MS = 5_000;

export type AppleRevokeOutcome =
  | { readonly outcome: 'revoked'; readonly status: number }
  | { readonly outcome: 'failed'; readonly status: number | null; readonly reason: string }
  | { readonly outcome: 'skipped'; readonly reason: 'no_token' | 'not_configured' };

export interface AppleRevokeDeps {
  readonly fetch?: typeof fetch;
  readonly secrets?: AppleClientSecretCache;
  readonly now?: () => number;
}

type AppleRevokeEnv = Pick<
  Env,
  | 'APPLE_SIWA_P8'
  | 'APPLE_SIWA_KEY_ID'
  | 'APPLE_SIWA_TEAM_ID'
  | 'APPLE_BUNDLE_ID'
  | 'APPLE_REVOKE_URL'
>;

export async function revokeAppleRefreshToken(
  env: AppleRevokeEnv,
  refreshToken: string | null,
  deps: AppleRevokeDeps = {},
): Promise<AppleRevokeOutcome> {
  if (refreshToken === null || refreshToken === '') {
    return { outcome: 'skipped', reason: 'no_token' };
  }
  const { APPLE_SIWA_P8, APPLE_SIWA_KEY_ID, APPLE_SIWA_TEAM_ID, APPLE_BUNDLE_ID } = env;
  if (
    APPLE_SIWA_P8 === undefined ||
    APPLE_SIWA_KEY_ID === undefined ||
    APPLE_SIWA_TEAM_ID === undefined ||
    APPLE_BUNDLE_ID === undefined
  ) {
    return { outcome: 'skipped', reason: 'not_configured' };
  }
  try {
    const clientSecret = await (deps.secrets ?? appleClientSecrets).get(
      {
        teamId: APPLE_SIWA_TEAM_ID,
        keyId: APPLE_SIWA_KEY_ID,
        clientId: APPLE_BUNDLE_ID,
        privateKeyPem: APPLE_SIWA_P8,
      },
      (deps.now ?? Date.now)(),
    );
    const response = await (deps.fetch ?? fetch)(env.APPLE_REVOKE_URL ?? APPLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: APPLE_BUNDLE_ID,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(APPLE_REVOKE_TIMEOUT_MS),
    });
    // Drain the body so the connection is released; Apple sends none on success.
    await response.arrayBuffer().catch(() => undefined);
    if (response.ok) {
      return { outcome: 'revoked', status: response.status };
    }
    return {
      outcome: 'failed',
      status: response.status,
      reason: `http_${String(response.status)}`,
    };
  } catch (error) {
    return {
      outcome: 'failed',
      status: null,
      reason: error instanceof Error ? error.name : 'unknown',
    };
  }
}
