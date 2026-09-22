/**
 * The Better Auth instance, built PER REQUEST and fail closed.
 *
 * Per request because `betterAuth()` does no I/O at construction (init is eager but CPU only;
 * the handler awaits it on first use) and because the Drizzle adapter needs the request's own
 * database handle: a module-scope instance would hold a Hyperdrive client across requests, which
 * the ESLint rule `planeahead/no-module-scope-drizzle` now flags for `betterAuth(` too.
 *
 * Fail closed because Better Auth keys three defaults on `NODE_ENV === 'production'`, which a
 * Worker never sets (docs/increments/05-auth.facts.md section 1):
 *
 *   - `rateLimit.enabled` would resolve to false, so it is set to true here, on `database`
 *     storage (an accepted Phase 0 interim: one read and one write on `rate_limits` per auth
 *     request; the `PUBLIC_RL` and `USER_RL` bindings damp abuse in front of it, and a Durable
 *     Object `customStorage` is the Phase 1 hardening item);
 *   - a missing `BETTER_AUTH_SECRET` would silently fall back to a PUBLIC default secret that
 *     signs every session cookie, so `assertBetterAuthSecret` throws before `betterAuth()` is
 *     called, on a missing, short or default value;
 *   - the client IP would be read from `x-forwarded-for`, which is not what Cloudflare sets, and
 *     every request would share one `no-trusted-ip` rate-limit bucket. `cf-connecting-ip` is the
 *     header, always a single address.
 *
 * Three more settings are load bearing and easy to lose:
 *
 *   - `transaction: true` on the Drizzle adapter. Without it Better Auth's `runWithTransaction`
 *     is a pass-through (`createAsIsTransaction`), and `handleOAuthUserInfo` writes the user
 *     and the account of a new native sign-in as two autocommit statements: a failure between
 *     them leaves a user row with the provider's email and no account, and every retry then
 *     answers 403 ACCOUNT_NOT_LINKED for good. `auth-transaction.test.ts` proves the rollback.
 *   - `onAPIError.throw: true`. Otherwise better-call answers a non-API error with a bare 500
 *     AND prints the whole error object through `console.error` (`# SERVER_ERROR:`), which for
 *     a failed statement is the SQL plus every bound value. Thrown, the error reaches Hono's
 *     `handleError`, which logs it through `errorFields` (sanitised) and answers the house 500
 *     with the request id. `APIError`s are unaffected: they still become their JSON responses.
 *   - the magic-link requester binding (`magic-link-requester.ts`): the anonymous merge on
 *     `/magic-link/verify` runs only for the anonymous user who requested the link.
 *
 * `trustedOrigins` are the CORS allow list (`planeahead://`, `API_PUBLIC_URL`, the localhost
 * origins only when `ENVIRONMENT` is `local`) plus `exp://` in the local environment only (the
 * Expo server plugin adds it under NODE_ENV=development, which again never happens on Workers).
 */

import { expo } from '@better-auth/expo';
import type { BetterAuthOptions } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { betterAuth } from 'better-auth/minimal';
import { anonymous, magicLink } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { accounts, rateLimits, sessions, users, verifications, type Db } from '@planeahead/db';
import { uuidv7 } from '@planeahead/shared';
import type { Envelope } from '../crypto/envelope';
import { type Env, environmentName } from '../env';
import { buildMagicLinkEmail, type MailSender } from '../mail/index';
import { allowedOrigins } from '../middleware/cors';
import { type Logger, errorFields } from '../observability/log';
import { consumeMagicLinkRequester, recordMagicLinkRequester } from './magic-link-requester';
import { type MergeQueue, type MergeSource, mergeUsers } from './merge';
import { AUTH_BASE_PATH } from './paths';
import { planeaheadPlugin } from './plugin';

export { AUTH_BASE_PATH };
export const MIN_SECRET_LENGTH = 32;
export const SESSION_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;
export const MAGIC_LINK_EXPIRES_IN_SECONDS = 600;
/** Per IP, `basePath`-relative keys; these win over Better Auth's built-in `/sign-in*` rule. */
export const RATE_LIMIT_RULES = {
  '/sign-in/magic-link': { window: 60, max: 3 },
  '/sign-in/anonymous': { window: 60, max: 5 },
} as const;
export const IP_ADDRESS_HEADERS = ['cf-connecting-ip'] as const;
export const EXPO_GO_ORIGIN = 'exp://';
export const MAGIC_LINK_VERIFY_PATH = '/magic-link/verify';
export const UNLINK_ACCOUNT_PATH = '/unlink-account';

/** Better Auth's own fallback. Never accepted, even if someone sets it on purpose. */
const BETTER_AUTH_DEFAULT_SECRET = 'better-auth-secret-12345678901234567890';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AuthConfigError extends Error {
  override readonly name = 'AuthConfigError';
}

export function assertBetterAuthSecret(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new AuthConfigError(
      'BETTER_AUTH_SECRET is not set. Better Auth would fall back to a public default secret; ' +
        'set it with `wrangler secret put BETTER_AUTH_SECRET` (at least 32 random characters).',
    );
  }
  if (value.length < MIN_SECRET_LENGTH) {
    throw new AuthConfigError(
      `BETTER_AUTH_SECRET is ${value.length} characters; at least ${MIN_SECRET_LENGTH} are required.`,
    );
  }
  if (value === BETTER_AUTH_DEFAULT_SECRET) {
    throw new AuthConfigError('BETTER_AUTH_SECRET is Better Auth’s published default value.');
  }
  return value;
}

/** The CORS allow list plus Expo Go, the latter only where `wrangler dev` runs. */
export function trustedOriginsFor(env: Env): string[] {
  const origins = [...allowedOrigins(env)];
  if (environmentName(env) === 'local') {
    origins.push(EXPO_GO_ORIGIN);
  }
  return origins;
}

export interface AuthDeps {
  readonly db: Db;
  readonly envelope: Envelope;
  readonly mail: MailSender;
  readonly log: Logger;
  readonly queue: MergeQueue;
  /** Test seam for the Apple token exchange. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /**
   * Test seam, and nothing else uses it: Better Auth database hooks, which
   * `auth-transaction.test.ts` uses to make the account INSERT of a new sign-in fail after the
   * user INSERT, so the rollback can be observed. The Worker passes none.
   */
  readonly databaseHooks?: BetterAuthOptions['databaseHooks'];
}

type BetterAuthLogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

function routeBetterAuthLog(
  log: Logger,
): (level: BetterAuthLogLevel, message: string, ...args: unknown[]) => void {
  return (level, message, ...args) => {
    // Only the message and a thrown error's sanitised fields (`errorFields` cuts a failed
    // statement's bound values and keeps the stack frames only). The extra arguments Better
    // Auth passes can be whole request contexts, which is exactly what must not reach a line.
    const thrown = args.find((arg): arg is Error => arg instanceof Error);
    const fields = {
      message,
      ...(thrown === undefined ? {} : errorFields(thrown)),
    };
    switch (level) {
      case 'error':
        log.error('better_auth', fields);
        return;
      case 'warn':
        log.warn('better_auth', fields);
        return;
      case 'debug':
        log.debug('better_auth', fields);
        return;
      default:
        log.info('better_auth', fields);
    }
  };
}

export function createAuth(env: Env, deps: AuthDeps) {
  const secret = assertBetterAuthSecret(env.BETTER_AUTH_SECRET);

  // One merge per (anonymous, target) pair per request. The native endpoints call `merge`
  // directly and Better Auth's anonymous after-hook calls `onLinkAccount` for the same request
  // (it matches every `/sign-in*` path, and a test proves it fires for the plugin endpoints);
  // `mergeUsers` is idempotent in the database as well, but the queue message must go out once.
  const merged = new Set<string>();
  const merge = async (from: string, to: string, source: MergeSource): Promise<void> => {
    // One line per caller, before the dedupe: it is how the suite proves that the anonymous
    // after-hook fires for a plugin endpoint reached over HTTP (docs/increments/05-auth.facts.md
    // section 2 left that unverified) and that the merge itself still ran exactly once.
    deps.log.info('merge_requested', { source, merge_from: from, merge_to: to });
    const key = `${from}>${to}`;
    if (merged.has(key)) {
      return;
    }
    merged.add(key);
    await mergeUsers(deps.db, { from, to }, { queue: deps.queue, log: deps.log });
  };

  return betterAuth({
    baseURL: env.API_PUBLIC_URL,
    basePath: AUTH_BASE_PATH,
    secret,
    database: drizzleAdapter(deps.db, {
      provider: 'pg',
      usePlural: true,
      // Real transactions, so `handleOAuthUserInfo`'s user-plus-account write is atomic.
      transaction: true,
      // The five-key subset, never the whole schema: the adapter's schema check is an in-memory
      // diff over this object (zero SQL), and the export keys are what it addresses tables by.
      schema: { users, sessions, accounts, verifications, rateLimits },
    }),
    advanced: {
      database: {
        // A custom function, not the literal 'uuid': that one validates supplied ids against a
        // v1-to-v5 regex and silently replaces a UUIDv7 (docs/increments/03-db-schema.facts.md).
        generateId: () => uuidv7(),
      },
      ipAddress: { ipAddressHeaders: [...IP_ADDRESS_HEADERS] },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      // `compact` strategy and 300 s maxAge are the defaults; only `enabled` is load bearing.
      // A cached session skips the database read, so revocation lags by up to 300 s.
      cookieCache: { enabled: true },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      customRules: { ...RATE_LIMIT_RULES },
    },
    trustedOrigins: trustedOriginsFor(env),
    account: {
      // Off, and stated: PlaneAhead's plugin endpoints never hand provider tokens to Better
      // Auth, so `accounts.access_token`, `refresh_token` and `id_token` stay NULL (tested), and
      // the one encrypted store is `refresh_token_enc` under `TOKEN_KEK_V{n}`. Turning this on
      // would add a second, independent key scheme (XChaCha20-Poly1305 keyed on the secret).
      encryptOAuthTokens: false,
    },
    onAPIError: { throw: true },
    telemetry: { enabled: false },
    logger: { level: 'warn', log: routeBetterAuthLog(deps.log) },
    ...(deps.databaseHooks === undefined ? {} : { databaseHooks: deps.databaseHooks }),
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const body: unknown = ctx.body;
        // The built-in ID-token path on `/sign-in/social` skips the nonce check when the claim
        // is absent and writes the raw ID token into `accounts.id_token`. Nothing in PlaneAhead
        // uses it; make sure nothing can by accident.
        if (ctx.path === '/sign-in/social') {
          if (typeof body === 'object' && body !== null && 'idToken' in body) {
            throw new APIError('BAD_REQUEST', {
              code: 'ID_TOKEN_SIGN_IN_DISABLED',
              message:
                'ID-token sign-in is not available on this path; use /sign-in/apple-native or ' +
                '/sign-in/google-native',
            });
          }
          return;
        }
        // Better Auth's built-in `/unlink-account` deletes the account row, and for Apple that
        // row holds the encrypted refresh token increment 8's deletion revokes with. Until that
        // increment wires the revocation, an Apple row cannot be unlinked; Google can (Better
        // Auth still refuses to unlink the last account).
        if (ctx.path === UNLINK_ACCOUNT_PATH) {
          const accountId =
            typeof body === 'object' && body !== null
              ? (body as { accountId?: unknown }).accountId
              : undefined;
          if (typeof accountId !== 'string' || !UUID_SHAPE.test(accountId)) {
            return;
          }
          const [row] = await deps.db
            .select({ providerId: accounts.providerId })
            .from(accounts)
            .where(eq(accounts.id, accountId))
            .limit(1);
          if (row?.providerId === 'apple') {
            throw new APIError('BAD_REQUEST', {
              code: 'UNLINK_NOT_SUPPORTED',
              message: 'unlinking an Apple account is not supported yet',
            });
          }
        }
      }),
    },
    plugins: [
      anonymous({
        // Fires after the new session is committed, outside any transaction. The merge is the
        // idempotent function above; the anonymous row is deleted by the queue consumer once
        // nothing references it (increment 8), never here.
        onLinkAccount: async ({ anonymousUser, newUser, ctx }) => {
          if (ctx.path === MAGIC_LINK_VERIFY_PATH) {
            // The link is bound to the anonymous user who requested it (magic-link-requester.ts).
            // A different anonymous user verifying it (a forwarded link, a login CSRF) is signed
            // in, and nothing of theirs is merged into the address owner's account.
            const token = (ctx.query as { token?: unknown } | undefined)?.token;
            const requester =
              typeof token === 'string' ? await consumeMagicLinkRequester(deps.db, token) : null;
            if (requester === null || requester.anonymousUserId !== anonymousUser.user.id) {
              deps.log.info('merge_skipped', {
                reason: 'requester_mismatch',
                merge_from: anonymousUser.user.id,
                merge_to: newUser.user.id,
                had_requester: requester !== null,
              });
              return;
            }
          }
          await merge(anonymousUser.user.id, newUser.user.id, 'anonymous_hook');
        },
        disableDeleteAnonymousUser: true,
      }),
      magicLink({
        storeToken: 'hashed',
        expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
        sendMagicLink: async ({ email, token }, ctx) => {
          // Who asked: the anonymous user whose cookie rode on the request, if any. Recorded
          // before the send so a link that reaches its owner is already bound.
          const session =
            ctx === undefined ? null : await getSessionFromCtx(ctx, { disableRefresh: true });
          const anonymousUserId =
            session !== null && session.user['isAnonymous'] === true ? session.user.id : null;
          await recordMagicLinkRequester(
            deps.db,
            token,
            { anonymousUserId },
            new Date(Date.now() + MAGIC_LINK_EXPIRES_IN_SECONDS * 1000),
          );

          // Our own URL, never Better Auth's: its `url` always carries `callbackURL` and points
          // at the consuming verify endpoint (see sender.ts).
          const message = await buildMagicLinkEmail({ token, apiPublicUrl: env.API_PUBLIC_URL });
          const result = await deps.mail.send({
            to: email,
            subject: message.subject,
            text: message.text,
            html: message.html,
            idempotencyKey: message.idempotencyKey,
          });
          if (!result.ok) {
            // Already logged by the sender with the reason. The caller still gets 200: a
            // provider outage must not tell a prober which addresses have accounts.
            deps.log.warn('magic_link_not_sent', { reason: result.reason });
          }
        },
      }),
      expo(),
      planeaheadPlugin({
        env,
        db: deps.db,
        envelope: deps.envelope,
        log: deps.log,
        merge,
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      }),
    ],
  });
}

export type PlaneaheadAuth = ReturnType<typeof createAuth>;
