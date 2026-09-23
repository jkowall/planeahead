/**
 * Google native sign-in: verification of the ID token the mobile app obtained from Google Sign
 * In (react-native-nitro-google-signin on both platforms, increment 9).
 *
 * Better Auth's built-in Google provider hardcodes the JWKS URL, refetches it on every
 * verification and skips the nonce check when the claim is absent, so this is PlaneAhead's own
 * verifier: jose over a memoised remote JWKS, RS256 only, `iss` in the two forms Google
 * documents, `aud` in the three client ids (web, iOS, Android), and the nonce REQUIRED and
 * compared exactly (Google returns the client's nonce verbatim).
 *
 * Two more rules, both from OpenID Connect Core 3.1.3.7 and Google's backend-auth guidance:
 *   - a token with several audiences must carry `azp`, and whenever `azp` is present it must be
 *     one of our client ids. jose's `audience` check passes when ANY `aud` entry matches, which
 *     on its own would accept a token minted for another client that merely lists ours too. On
 *     Android `azp` is the Android client id and `aud` the web client id, both ours;
 *   - `email_verified` must be true. Google says to rely on the email only when it is, and an
 *     unverified address would otherwise create a user row that blocks the address owner's own
 *     sign-in through every other provider.
 */

import { type JWTVerifyGetKey, jwtVerify } from 'jose';
import { timingSafeEqualStrings } from '../crypto/hash';
import { remoteJwks } from './jwks';

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
export const GOOGLE_JWKS_DEFAULT_URL = 'https://www.googleapis.com/oauth2/v3/certs';

export type GoogleTokenErrorCode =
  | 'invalid_token'
  | 'nonce_required'
  | 'nonce_mismatch'
  | 'email_required'
  | 'email_not_verified'
  | 'azp_required'
  | 'azp_mismatch';

export class GoogleTokenError extends Error {
  override readonly name = 'GoogleTokenError';

  constructor(
    readonly code: GoogleTokenErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface GoogleIdTokenClaims {
  readonly sub: string;
  readonly email: string;
  /** Always true: a token whose `email_verified` is not `true` is rejected. */
  readonly emailVerified: true;
  readonly name: string | null;
  readonly picture: string | null;
  /** The one of our client ids the token names (the first when it names several). */
  readonly aud: string;
  /** `exp`, seconds since the epoch; the replay marker lives this long. */
  readonly expiresAt: number;
  /** `jti` when Google sets one (it usually does not). */
  readonly jti: string | null;
}

export interface GoogleVerifyOptions {
  /** The JWKS resolver, `googleJwks(url)` in the Worker and a local JWKS in unit tests. */
  readonly getKey: JWTVerifyGetKey;
  /** The client ids a token may be issued to. */
  readonly audiences: readonly string[];
  /** The nonce the app generated for this sign-in; the token must carry exactly this value. */
  readonly rawNonce: string;
  /** Test seam for `exp` and `iat`. */
  readonly currentDate?: Date;
}

export function googleJwks(url: string = GOOGLE_JWKS_DEFAULT_URL): JWTVerifyGetKey {
  return remoteJwks(url);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export async function verifyGoogleIdToken(
  token: string,
  options: GoogleVerifyOptions,
): Promise<GoogleIdTokenClaims> {
  if (options.audiences.length === 0) {
    throw new GoogleTokenError('invalid_token', 'no Google client ids are configured');
  }
  let payload;
  try {
    const verified = await jwtVerify(token, options.getKey, {
      algorithms: ['RS256'],
      issuer: [...GOOGLE_ISSUERS],
      audience: [...options.audiences],
      ...(options.currentDate === undefined ? {} : { currentDate: options.currentDate }),
    });
    payload = verified.payload;
  } catch (error) {
    throw new GoogleTokenError(
      'invalid_token',
      `Google identity token rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const azp = optionalString(payload['azp']);
  if (audiences.length > 1 && azp === null) {
    throw new GoogleTokenError('azp_required', 'a multi-audience token carries no azp');
  }
  if (azp !== null && !options.audiences.includes(azp)) {
    throw new GoogleTokenError('azp_mismatch', 'the token was issued to another client (azp)');
  }
  const aud = audiences.find(
    (value): value is string => typeof value === 'string' && options.audiences.includes(value),
  );
  if (aud === undefined) {
    // jose accepted the token, so one of them matched; this branch only exists for the types.
    throw new GoogleTokenError('invalid_token', 'no configured audience on the token');
  }

  const nonce = optionalString(payload['nonce']);
  if (nonce === null) {
    throw new GoogleTokenError('nonce_required', 'the identity token carries no nonce');
  }
  if (!(await timingSafeEqualStrings(nonce, options.rawNonce))) {
    throw new GoogleTokenError('nonce_mismatch', 'the identity token nonce does not match');
  }

  const sub = optionalString(payload.sub);
  if (sub === null) {
    throw new GoogleTokenError('invalid_token', 'the identity token has no subject');
  }
  const email = optionalString(payload['email']);
  if (email === null) {
    throw new GoogleTokenError('email_required', 'the identity token carries no email');
  }
  if (payload['email_verified'] !== true) {
    throw new GoogleTokenError('email_not_verified', 'Google has not verified this email');
  }
  const expiresAt = typeof payload.exp === 'number' ? payload.exp : null;
  if (expiresAt === null) {
    throw new GoogleTokenError('invalid_token', 'the identity token has no exp');
  }
  return {
    sub,
    email: email.toLowerCase(),
    emailVerified: true,
    name: optionalString(payload['name']),
    picture: optionalString(payload['picture']),
    aud,
    expiresAt,
    jti: optionalString(payload.jti),
  };
}
