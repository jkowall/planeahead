/**
 * The PlaneAhead Better Auth plugin: native Apple and native Google sign-in as Better Auth
 * endpoints, so both reuse its cookie signing, session creation and the anonymous after-hook
 * (which matches paths under `/sign-in`, hence `/sign-in/apple-native` and not `/apple/native`).
 *
 * Neither endpoint hands a provider token to Better Auth: `handleOAuthUserInfo` is called with
 * the profile and the account key only, so `accounts.access_token`, `refresh_token` and
 * `id_token` are never written. Apple's refresh token, the one secret worth keeping (account
 * deletion revokes with it), is envelope-encrypted into `accounts.refresh_token_enc` AFTER the
 * sign-in transaction; that window is not atomic and is documented in the threat model.
 *
 * Both endpoints refuse a token they have seen before (`used-tokens.ts`): the nonce binds a
 * token to its request, the KV marker stops the request itself from being replayed. Apple's
 * authorization code is bound to the identity token too: the `id_token` Apple returns with the
 * exchange must name the same subject (`apple-native.ts`), so a captured identity token cannot
 * be signed in with an attacker's own fresh code.
 *
 * Body keys are `identityToken`, never `idToken`: the Expo client strips the stored session
 * cookie from any request whose body has an `idToken` key, and the anonymous merge needs that
 * cookie to find the account being upgraded.
 *
 * Every response is JSON. Errors are Better Auth `APIError`s with a stable `code`:
 *   400 NONCE_REQUIRED, EMAIL_REQUIRED, VALIDATION (from the body schema)
 *   401 INVALID_IDENTITY_TOKEN, NONCE_MISMATCH, CODE_EXCHANGE_FAILED, IDENTITY_TOKEN_REPLAYED
 *   403 ACCOUNT_NOT_LINKED (an existing account with that email that policy will not link),
 *       EMAIL_NOT_VERIFIED (Google has not verified the address; no account is created)
 *   503 PROVIDER_NOT_CONFIGURED (a missing secret; logged at error level)
 */

import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint, getSessionFromCtx } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { handleOAuthUserInfo } from 'better-auth/oauth2';
import { and, eq } from 'drizzle-orm';
import { accounts, type Db, users } from '@planeahead/db';
import * as z from 'zod';
import type { Envelope } from '../crypto/envelope';
import type { Env } from '../env';
import { type Logger, errorFields } from '../observability/log';
import { AppleKeyError, appleClientSecrets } from './apple-client-secret';
import {
  AppleExchangeError,
  AppleTokenError,
  appleJwks,
  exchangeAppleAuthorizationCode,
  sanitizeFullName,
  verifyAppleIdentityToken,
} from './apple-native';
import { GoogleTokenError, googleJwks, verifyGoogleIdToken } from './google-verify';
import type { MergeSource } from './merge';
import { identityTokenReplayKey, markIdentityTokenUsed, wasIdentityTokenUsed } from './used-tokens';

export const PLUGIN_ID = 'planeahead';
export const APPLE_NATIVE_PATH = '/sign-in/apple-native';
export const GOOGLE_NATIVE_PATH = '/sign-in/google-native';

export interface PlaneaheadPluginDeps {
  readonly env: Env;
  readonly db: Db;
  readonly envelope: Envelope;
  readonly log: Logger;
  /** The idempotent, once-per-request merge from create-auth.ts. */
  readonly merge: (from: string, to: string, source: MergeSource) => Promise<void>;
  readonly fetch?: typeof fetch;
}

const appleNativeBody = z.object({
  identityToken: z.string().min(1).max(8192),
  authorizationCode: z.string().min(1).max(2048),
  rawNonce: z.string().min(1).max(256).optional(),
  fullName: z
    .object({
      givenName: z.string().max(256).nullable().optional(),
      middleName: z.string().max(256).nullable().optional(),
      familyName: z.string().max(256).nullable().optional(),
    })
    .optional(),
});

const googleNativeBody = z.object({
  identityToken: z.string().min(1).max(8192),
  rawNonce: z.string().min(1).max(256).optional(),
});

function fail(
  status:
    'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE' | 'INTERNAL_SERVER_ERROR',
  code: string,
  message: string,
): never {
  throw new APIError(status, { code, message });
}

interface SignedInUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly image?: string | null | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function publicUser(user: SignedInUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    image: user.image ?? null,
    isAnonymous: false,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function planeaheadPlugin(deps: PlaneaheadPluginDeps): BetterAuthPlugin {
  const { env, db, envelope, log } = deps;

  /** 401 when this exact token was presented before; best effort (KV failures do not block). */
  async function refuseReplay(key: string): Promise<void> {
    if (await wasIdentityTokenUsed(env.CACHE, key, log)) {
      log.info('identity_token_replayed', {});
      fail('UNAUTHORIZED', 'IDENTITY_TOKEN_REPLAYED', 'this identity token was already used');
    }
  }

  return {
    id: PLUGIN_ID,
    endpoints: {
      signInAppleNative: createAuthEndpoint(
        APPLE_NATIVE_PATH,
        {
          method: 'POST',
          body: appleNativeBody,
          metadata: {
            openapi: {
              description:
                'Sign in with Apple, native flow (identity token plus authorization code)',
              responses: { 200: { description: 'Signed in' } },
            },
          },
        },
        async (ctx) => {
          const bundleId = env.APPLE_BUNDLE_ID;
          const teamId = env.APPLE_SIWA_TEAM_ID;
          const keyId = env.APPLE_SIWA_KEY_ID;
          const privateKeyPem = env.APPLE_SIWA_P8;
          if (
            bundleId === undefined ||
            teamId === undefined ||
            keyId === undefined ||
            privateKeyPem === undefined
          ) {
            log.error('apple_native_not_configured', {
              has_bundle_id: bundleId !== undefined,
              has_team_id: teamId !== undefined,
              has_key_id: keyId !== undefined,
              has_p8: privateKeyPem !== undefined,
            });
            fail(
              'SERVICE_UNAVAILABLE',
              'PROVIDER_NOT_CONFIGURED',
              'Sign in with Apple is not configured',
            );
          }

          const { identityToken, authorizationCode, rawNonce, fullName } = ctx.body;
          if (rawNonce === undefined) {
            fail('BAD_REQUEST', 'NONCE_REQUIRED', 'rawNonce is required');
          }

          const getKey = appleJwks(env.APPLE_JWKS_URL);
          let claims;
          try {
            claims = await verifyAppleIdentityToken(identityToken, {
              getKey,
              audience: bundleId,
              rawNonce,
            });
          } catch (error) {
            if (error instanceof AppleTokenError) {
              log.info('apple_identity_token_rejected', { code: error.code });
              fail(
                'UNAUTHORIZED',
                error.code === 'nonce_mismatch' ? 'NONCE_MISMATCH' : 'INVALID_IDENTITY_TOKEN',
                error.code === 'nonce_mismatch'
                  ? 'the identity token nonce does not match rawNonce'
                  : 'the identity token could not be verified',
              );
            }
            throw error;
          }
          const replayKey = await identityTokenReplayKey('apple', identityToken, claims.jti);
          await refuseReplay(replayKey);

          // The account being upgraded, if the request carries an anonymous session cookie.
          // Read before the sign-in changes the context's notion of the current session.
          const existing = await getSessionFromCtx(ctx, { disableRefresh: true });
          const anonymousUserId =
            existing !== null && existing.user['isAnonymous'] === true ? existing.user.id : null;

          // Returning users FIRST: Apple sends `email` only on the first authorization, so a
          // token without one is normal for a known subject and fatal only for a new one.
          const owner = await ctx.context.internalAdapter.findAccountOwnerByKey({
            providerId: 'apple',
            accountId: claims.sub,
          });
          let email: string;
          let emailVerified: boolean;
          let name: string;
          const suppliedName = sanitizeFullName(fullName);
          if (owner?.kind === 'owned') {
            email = owner.user.email;
            emailVerified = owner.user.emailVerified || claims.emailVerified;
            name = owner.user.name;
          } else {
            if (claims.email === null) {
              log.warn('apple_email_required', { has_owner: owner !== null });
              fail(
                'BAD_REQUEST',
                'EMAIL_REQUIRED',
                'Apple provided no email for a new account (managed Apple ID?)',
              );
            }
            email = claims.email;
            emailVerified = claims.emailVerified;
            name = suppliedName ?? '';
          }

          // The authorization code is single use and valid for five minutes; exchanging it
          // before the sign-in keeps a rejected code from leaving a half-made account, and the
          // exchanged id_token must name the identity token's subject (a mismatch is a captured
          // token with someone else's code).
          let refreshToken: string;
          try {
            const clientSecret = await appleClientSecrets.get({
              teamId,
              keyId,
              clientId: bundleId,
              privateKeyPem,
            });
            const exchanged = await exchangeAppleAuthorizationCode({
              code: authorizationCode,
              clientId: bundleId,
              clientSecret,
              binding: {
                getKey,
                audience: bundleId,
                expectedSub: claims.sub,
                expectedNonce: claims.nonce,
              },
              ...(env.APPLE_TOKEN_URL === undefined ? {} : { tokenUrl: env.APPLE_TOKEN_URL }),
              ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
            });
            refreshToken = exchanged.refreshToken;
          } catch (error) {
            if (error instanceof AppleKeyError) {
              log.error('apple_native_key_invalid', errorFields(error));
              fail(
                'SERVICE_UNAVAILABLE',
                'PROVIDER_NOT_CONFIGURED',
                'Sign in with Apple is not configured',
              );
            }
            if (error instanceof AppleExchangeError) {
              log.warn('apple_code_exchange_failed', {
                status: error.status,
                reason: error.reason,
              });
              fail('UNAUTHORIZED', 'CODE_EXCHANGE_FAILED', 'Apple rejected the authorization code');
            }
            throw error;
          }

          // Everything about the request is verified; from here it must not be replayable.
          await markIdentityTokenUsed(env.CACHE, replayKey, claims.expiresAt, log);

          const result = await handleOAuthUserInfo(ctx, {
            userInfo: { id: claims.sub, email, emailVerified, name, image: null },
            account: { providerId: 'apple', accountId: claims.sub },
          });
          if (result.error !== null || result.data === null) {
            log.warn('apple_native_sign_in_refused', { reason: result.error });
            if (result.error === 'account not linked') {
              fail(
                'FORBIDDEN',
                'ACCOUNT_NOT_LINKED',
                'an account with this email exists and cannot be linked',
              );
            }
            fail('INTERNAL_SERVER_ERROR', 'SIGN_IN_FAILED', 'sign-in failed');
          }
          await setSessionCookie(ctx, result.data);
          const userId = result.data.user.id;

          // After the sign-in transaction. Not atomic with it: a crash here leaves an Apple
          // account with a session and a NULL refresh_token_enc, which increment 8's deletion
          // treats as "nothing to revoke" and logs.
          try {
            const [account] = await db
              .select({ id: accounts.id })
              .from(accounts)
              .where(and(eq(accounts.providerId, 'apple'), eq(accounts.accountId, claims.sub)))
              .limit(1);
            if (account === undefined) {
              throw new Error('apple account row not found after sign-in');
            }
            const sealed = await envelope.encrypt(
              userId,
              'accounts',
              'refresh_token',
              account.id,
              refreshToken,
            );
            await db
              .update(accounts)
              .set({
                refreshTokenEnc: sealed.ciphertext,
                refreshTokenKeyVersion: sealed.keyVersion,
                // Belt and braces: nothing writes these, and nothing may keep them.
                idToken: null,
                accessToken: null,
                refreshToken: null,
              })
              .where(eq(accounts.id, account.id));
          } catch (error) {
            log.error('apple_refresh_token_store_failed', errorFields(error));
          }

          if (suppliedName !== null && result.data.user.name === '') {
            await db.update(users).set({ name: suppliedName }).where(eq(users.id, userId));
          }

          if (anonymousUserId !== null && anonymousUserId !== userId) {
            await deps.merge(anonymousUserId, userId, 'apple_native');
          }

          log.info('apple_native_signed_in', {
            is_register: result.isRegister,
            merged_anonymous: anonymousUserId !== null && anonymousUserId !== userId,
            private_email: claims.isPrivateEmail,
          });
          return ctx.json({
            token: result.data.session.token,
            user: publicUser({
              ...result.data.user,
              name:
                suppliedName !== null && result.data.user.name === ''
                  ? suppliedName
                  : result.data.user.name,
            }),
            isRegister: result.isRegister,
          });
        },
      ),

      signInGoogleNative: createAuthEndpoint(
        GOOGLE_NATIVE_PATH,
        {
          method: 'POST',
          body: googleNativeBody,
          metadata: {
            openapi: {
              description: 'Sign in with Google, native flow (identity token with nonce)',
              responses: { 200: { description: 'Signed in' } },
            },
          },
        },
        async (ctx) => {
          const audiences = [
            env.GOOGLE_CLIENT_ID_WEB,
            env.GOOGLE_CLIENT_ID_IOS,
            env.GOOGLE_CLIENT_ID_ANDROID,
          ].filter((value): value is string => typeof value === 'string' && value !== '');
          if (audiences.length === 0) {
            log.error('google_native_not_configured', {});
            fail(
              'SERVICE_UNAVAILABLE',
              'PROVIDER_NOT_CONFIGURED',
              'Google sign-in is not configured',
            );
          }

          const { identityToken, rawNonce } = ctx.body;
          if (rawNonce === undefined) {
            fail('BAD_REQUEST', 'NONCE_REQUIRED', 'rawNonce is required');
          }

          let claims;
          try {
            claims = await verifyGoogleIdToken(identityToken, {
              getKey: googleJwks(env.GOOGLE_JWKS_URL),
              audiences,
              rawNonce,
            });
          } catch (error) {
            if (error instanceof GoogleTokenError) {
              log.info('google_identity_token_rejected', { code: error.code });
              switch (error.code) {
                case 'nonce_required':
                  fail('BAD_REQUEST', 'NONCE_REQUIRED', 'the identity token carries no nonce');
                  break;
                case 'nonce_mismatch':
                  fail(
                    'UNAUTHORIZED',
                    'NONCE_MISMATCH',
                    'the identity token nonce does not match rawNonce',
                  );
                  break;
                case 'email_required':
                  fail('BAD_REQUEST', 'EMAIL_REQUIRED', 'the identity token carries no email');
                  break;
                case 'email_not_verified':
                  fail(
                    'FORBIDDEN',
                    'EMAIL_NOT_VERIFIED',
                    'Google has not verified this email address',
                  );
                  break;
                default:
                  fail(
                    'UNAUTHORIZED',
                    'INVALID_IDENTITY_TOKEN',
                    'the identity token could not be verified',
                  );
              }
            }
            throw error;
          }
          const replayKey = await identityTokenReplayKey('google', identityToken, claims.jti);
          await refuseReplay(replayKey);

          const existing = await getSessionFromCtx(ctx, { disableRefresh: true });
          const anonymousUserId =
            existing !== null && existing.user['isAnonymous'] === true ? existing.user.id : null;

          await markIdentityTokenUsed(env.CACHE, replayKey, claims.expiresAt, log);

          const result = await handleOAuthUserInfo(ctx, {
            userInfo: {
              id: claims.sub,
              email: claims.email,
              emailVerified: claims.emailVerified,
              name: claims.name ?? '',
              image: claims.picture,
            },
            account: { providerId: 'google', accountId: claims.sub },
          });
          if (result.error !== null || result.data === null) {
            log.warn('google_native_sign_in_refused', { reason: result.error });
            if (result.error === 'account not linked') {
              fail(
                'FORBIDDEN',
                'ACCOUNT_NOT_LINKED',
                'an account with this email exists and cannot be linked',
              );
            }
            fail('INTERNAL_SERVER_ERROR', 'SIGN_IN_FAILED', 'sign-in failed');
          }
          await setSessionCookie(ctx, result.data);
          const userId = result.data.user.id;

          if (anonymousUserId !== null && anonymousUserId !== userId) {
            await deps.merge(anonymousUserId, userId, 'google_native');
          }

          log.info('google_native_signed_in', {
            is_register: result.isRegister,
            merged_anonymous: anonymousUserId !== null && anonymousUserId !== userId,
          });
          return ctx.json({
            token: result.data.session.token,
            user: publicUser(result.data.user),
            isRegister: result.isRegister,
          });
        },
      ),
    },
  };
}
