/**
 * Sign in with Apple, native flow: the identity token from `expo-apple-authentication`, the
 * authorization code exchanged at Apple's token endpoint for the refresh token that account
 * deletion (increment 8) needs to revoke, and the out-of-band `fullName`.
 *
 * Facts this file encodes (docs/increments/05-auth.facts.md section 3):
 *   - identity tokens are RS256 (the live JWKS serves RSA keys; "ES256" applies only to the
 *     client secret we mint), `iss` https://appleid.apple.com, `aud` the bundle id, and they are
 *     accepted for at most one hour after `iat`;
 *   - Apple passes the nonce through verbatim, and the client convention is to hand Apple
 *     `sha256hex(rawNonce)` and the API `rawNonce`; the claim is compared against the lowercase
 *     hex digest;
 *   - `email_verified` and `is_private_email` arrive as booleans OR the strings "true"/"false";
 *   - `email` may be absent (managed Apple IDs, and every sign-in after the first);
 *   - the token endpoint takes form-encoded `client_id`, `client_secret`, `code`,
 *     `grant_type=authorization_code`, no `redirect_uri` for a native flow, and returns the
 *     refresh token only on this first exchange, together with an `id_token` for the same
 *     authorization;
 *   - `fullName` never rides in the token. It is attacker-controlled request input.
 *
 * The exchange is BOUND to the identity token. Apple's token response carries an `id_token` for
 * the authorization the code came from; it is verified with the same JWKS, issuer and audience
 * and its `sub` (and its `nonce`, when Apple includes one) must equal the identity token's. A
 * code from one authorization presented with the identity token of another (a captured token
 * replayed with the attacker's own fresh code) is refused before any sign-in happens, and the
 * refresh token that would have landed on the victim's account row is never stored.
 */

import { type JWTVerifyGetKey, jwtVerify } from 'jose';
import { sha256Hex, timingSafeEqualStrings } from '../crypto/hash';
import { remoteJwks } from './jwks';

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_DEFAULT_URL = 'https://appleid.apple.com/auth/keys';
export const APPLE_TOKEN_DEFAULT_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_MAX_TOKEN_AGE = '1h';
export const FULL_NAME_MAX_LENGTH = 100;

export type AppleTokenErrorCode = 'invalid_token' | 'nonce_mismatch';

export class AppleTokenError extends Error {
  override readonly name = 'AppleTokenError';

  constructor(
    readonly code: AppleTokenErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type AppleExchangeReason =
  | 'unparsed_error'
  | 'no_refresh_token'
  | 'no_id_token'
  | 'id_token_invalid'
  | 'id_token_subject_mismatch'
  | 'id_token_nonce_mismatch'
  | (string & {});

export class AppleExchangeError extends Error {
  override readonly name = 'AppleExchangeError';

  constructor(
    readonly status: number,
    /** Apple's `error` field when the body parsed, otherwise a short label. Never the body. */
    readonly reason: AppleExchangeReason,
  ) {
    super(`Apple token endpoint answered ${status} (${reason})`);
  }
}

export interface AppleIdentityClaims {
  readonly sub: string;
  /** Lower-cased, or null when the token carries none. */
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly isPrivateEmail: boolean;
  /** The token's `nonce` claim (the lowercase SHA-256 hex of `rawNonce`), as verified. */
  readonly nonce: string;
  /** `exp`, seconds since the epoch; the replay marker lives this long. */
  readonly expiresAt: number;
  /** `jti` when Apple sets one (it does not today). */
  readonly jti: string | null;
  /**
   * The token's `aud`: which of the accepted bundle ids the app that signed in carries. The code
   * exchange must name the same `client_id` (increment 12).
   */
  readonly audience: string;
}

export interface AppleVerifyOptions {
  readonly getKey: JWTVerifyGetKey;
  /**
   * The accepted bundle ids (increment 12: a list, `appleBundleIds`, so the preview variant signs
   * in against production and the development variant against staging). A single id is accepted
   * too.
   */
  readonly audience: string | readonly string[];
  /** The nonce the app generated; the token must carry its lowercase SHA-256 hex. */
  readonly rawNonce: string;
  readonly currentDate?: Date;
}

const BUNDLE_ID_SHAPE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)+$/;

/**
 * The bundle ids a native Apple identity token may name as `aud` (increment 12, increment 9's
 * open question): `APPLE_BUNDLE_IDS`, a comma-separated var, else the environment's variants as
 * the association files name them (`BUNDLE_IDS_BY_ENVIRONMENT`: production and preview against
 * production, the development build against staging), plus `APPLE_BUNDLE_ID` (the primary app,
 * which also signs the revocation) so a deployment that sets only the secret keeps working.
 * Malformed entries are dropped. The order is the list's, the primary last when it was not in it.
 */
export function appleBundleIds(
  listVar: string | undefined,
  defaults: readonly string[],
  primary: string | undefined,
): string[] {
  const listed =
    listVar === undefined || listVar.trim() === ''
      ? [...defaults]
      : listVar
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => BUNDLE_ID_SHAPE.test(entry));
  const primaryId = primary?.trim() ?? '';
  const all = primaryId === '' ? listed : [...listed, primaryId];
  return [...new Set(all)];
}

export function appleJwks(url: string = APPLE_JWKS_DEFAULT_URL): JWTVerifyGetKey {
  return remoteJwks(url);
}

/** Apple emits `true`, `"true"`, `false` and `"false"` for the same claim. */
export function parseBoolClaim(value: unknown): boolean {
  return value === true || value === 'true';
}

export async function verifyAppleIdentityToken(
  token: string,
  options: AppleVerifyOptions,
): Promise<AppleIdentityClaims> {
  let payload;
  try {
    const verified = await jwtVerify(token, options.getKey, {
      algorithms: ['RS256'],
      issuer: APPLE_ISSUER,
      audience: typeof options.audience === 'string' ? options.audience : [...options.audience],
      maxTokenAge: APPLE_MAX_TOKEN_AGE,
      ...(options.currentDate === undefined ? {} : { currentDate: options.currentDate }),
    });
    payload = verified.payload;
  } catch (error) {
    throw new AppleTokenError(
      'invalid_token',
      `Apple identity token rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const nonce = payload['nonce'];
  const expected = await sha256Hex(options.rawNonce);
  if (
    typeof nonce !== 'string' ||
    nonce === '' ||
    !(await timingSafeEqualStrings(nonce.toLowerCase(), expected))
  ) {
    throw new AppleTokenError('nonce_mismatch', 'the identity token nonce does not match');
  }

  const sub = typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : null;
  if (sub === null) {
    throw new AppleTokenError('invalid_token', 'the identity token has no subject');
  }
  const expiresAt = typeof payload.exp === 'number' ? payload.exp : null;
  if (expiresAt === null) {
    throw new AppleTokenError('invalid_token', 'the identity token has no exp');
  }
  const accepted = typeof options.audience === 'string' ? [options.audience] : options.audience;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  const audience = audiences.find(
    (value): value is string => typeof value === 'string' && accepted.includes(value),
  );
  if (audience === undefined) {
    // jose already refused a token naming none of them; kept so the type is a string.
    throw new AppleTokenError('invalid_token', 'the identity token names no accepted bundle id');
  }
  const rawEmail = payload['email'];
  const email = typeof rawEmail === 'string' && rawEmail !== '' ? rawEmail.toLowerCase() : null;
  return {
    audience,
    sub,
    email,
    emailVerified: parseBoolClaim(payload['email_verified']),
    isPrivateEmail: parseBoolClaim(payload['is_private_email']),
    nonce: nonce.toLowerCase(),
    expiresAt,
    jti: typeof payload.jti === 'string' && payload.jti !== '' ? payload.jti : null,
  };
}

/** The shape `expo-apple-authentication` returns, or a plain string. Everything optional. */
export interface AppleFullNameInput {
  readonly givenName?: string | null | undefined;
  readonly middleName?: string | null | undefined;
  readonly familyName?: string | null | undefined;
}

// Everything outside the printable range, including C0 and C1 controls, line separators,
// bidi overrides and the zero-width family. Letters, marks, digits, punctuation and plain
// spaces of every script stay.
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;

function cleanPart(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  // Whitespace first: tab and newline are control characters and would otherwise be stripped
  // rather than collapsed, gluing two words together.
  return value.replace(/\s+/g, ' ').replace(NON_PRINTABLE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Trims, strips non-printable characters, collapses whitespace and caps the length. Returns
 * null when nothing usable is left, so a caller stores nothing rather than an empty string.
 */
export function sanitizeFullName(
  input: AppleFullNameInput | string | null | undefined,
): string | null {
  const joined =
    typeof input === 'string'
      ? cleanPart(input)
      : [input?.givenName, input?.middleName, input?.familyName]
          .map(cleanPart)
          .filter((part) => part !== '')
          .join(' ');
  if (joined === '') {
    return null;
  }
  return [...joined].slice(0, FULL_NAME_MAX_LENGTH).join('').trim() || null;
}

/** What the `id_token` in the token response must agree with: the identity token, verified. */
export interface AppleExchangeBinding {
  /** The same JWKS resolver the identity token was verified with. */
  readonly getKey: JWTVerifyGetKey;
  /** The bundle id: `aud` of both tokens. */
  readonly audience: string;
  /** The identity token's `sub`; the exchanged token must name the same subject. */
  readonly expectedSub: string;
  /** The identity token's `nonce`; checked only when Apple puts a nonce on the exchanged token. */
  readonly expectedNonce?: string;
  readonly currentDate?: Date;
}

export interface AppleExchangeOptions {
  readonly code: string;
  /** The bundle id. Must match the `client_id` the authorization used. */
  readonly clientId: string;
  readonly clientSecret: string;
  readonly binding: AppleExchangeBinding;
  readonly tokenUrl?: string;
  readonly fetch?: typeof fetch;
}

export interface AppleExchangeResult {
  readonly refreshToken: string;
  readonly accessToken: string | null;
  readonly expiresIn: number | null;
  /** The exchanged `id_token`'s subject, equal to `binding.expectedSub` by construction. */
  readonly idTokenSub: string;
}

/**
 * Verifies the `id_token` Apple returned with the code exchange against the identity token the
 * request presented. Throws `AppleExchangeError` with a reason that names the check that failed
 * and never quotes either token.
 */
async function verifyExchangedIdToken(
  idToken: unknown,
  binding: AppleExchangeBinding,
  status: number,
): Promise<string> {
  if (typeof idToken !== 'string' || idToken === '') {
    throw new AppleExchangeError(status, 'no_id_token');
  }
  let payload;
  try {
    const verified = await jwtVerify(idToken, binding.getKey, {
      algorithms: ['RS256'],
      issuer: APPLE_ISSUER,
      audience: binding.audience,
      ...(binding.currentDate === undefined ? {} : { currentDate: binding.currentDate }),
    });
    payload = verified.payload;
  } catch {
    throw new AppleExchangeError(status, 'id_token_invalid');
  }
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (sub === '' || !(await timingSafeEqualStrings(sub, binding.expectedSub))) {
    throw new AppleExchangeError(status, 'id_token_subject_mismatch');
  }
  const nonce = payload['nonce'];
  if (
    binding.expectedNonce !== undefined &&
    typeof nonce === 'string' &&
    nonce !== '' &&
    !(await timingSafeEqualStrings(nonce.toLowerCase(), binding.expectedNonce))
  ) {
    throw new AppleExchangeError(status, 'id_token_nonce_mismatch');
  }
  return sub;
}

/**
 * Exchanges the single-use authorization code and binds the result to the identity token. The
 * body is never logged or included in an error: it may carry tokens on success and Apple's
 * error text on failure.
 */
export async function exchangeAppleAuthorizationCode(
  options: AppleExchangeOptions,
): Promise<AppleExchangeResult> {
  const doFetch = options.fetch ?? fetch;
  const form = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    code: options.code,
    grant_type: 'authorization_code',
  });
  const response = await doFetch(options.tokenUrl ?? APPLE_TOKEN_DEFAULT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (!response.ok) {
    const reason = typeof record['error'] === 'string' ? record['error'] : 'unparsed_error';
    throw new AppleExchangeError(response.status, reason);
  }
  const refreshToken = record['refresh_token'];
  if (typeof refreshToken !== 'string' || refreshToken === '') {
    throw new AppleExchangeError(response.status, 'no_refresh_token');
  }
  const idTokenSub = await verifyExchangedIdToken(
    record['id_token'],
    options.binding,
    response.status,
  );
  const accessToken = record['access_token'];
  const expiresIn = record['expires_in'];
  return {
    refreshToken,
    accessToken: typeof accessToken === 'string' ? accessToken : null,
    expiresIn: typeof expiresIn === 'number' ? expiresIn : null,
    idTokenSub,
  };
}
