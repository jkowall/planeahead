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
 * `trustedOrigins` are listed explicitly, including `planeahead://` (without it a deep-link
 * redirect carries no cookie) and `exp://` in the local environment only (the Expo server plugin
 * adds it under NODE_ENV=development, which again never happens on Workers).
 */

import { expo } from '@better-auth/expo';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { betterAuth } from 'better-auth/minimal';
import { anonymous, magicLink } from 'better-auth/plugins';
import { accounts, rateLimits, sessions, users, verifications, type Db } from '@planeahead/db';
import { uuidv7 } from '@planeahead/shared';
import type { Envelope } from '../crypto/envelope';
import { type Env, environmentName } from '../env';
import { buildMagicLinkEmail, type MailSender } from '../mail/index';
import { allowedOrigins } from '../middleware/cors';
import { type Logger, errorFields } from '../observability/log';
import { type MergeQueue, type MergeSource, mergeUsers } from './merge';
import { planeaheadPlugin } from './plugin';

export const AUTH_BASE_PATH = '/api/auth';
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

/** Better Auth's own fallback. Never accepted, even if someone sets it on purpose. */
const BETTER_AUTH_DEFAULT_SECRET = 'better-auth-secret-12345678901234567890';

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
}

type BetterAuthLogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

function routeBetterAuthLog(
  log: Logger,
): (level: BetterAuthLogLevel, message: string, ...args: unknown[]) => void {
  return (level, message, ...args) => {
    // Only the message and a thrown error's name and message. The extra arguments Better Auth
    // passes can be whole request contexts, which is exactly what must not reach a log line.
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
    telemetry: { enabled: false },
    logger: { level: 'warn', log: routeBetterAuthLog(deps.log) },
    hooks: {
      // The built-in ID-token path on `/sign-in/social` skips the nonce check when the claim is
      // absent and writes the raw ID token into `accounts.id_token`. Nothing in PlaneAhead uses
      // it; make sure nothing can by accident.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/social') {
          return;
        }
        const body: unknown = ctx.body;
        if (typeof body === 'object' && body !== null && 'idToken' in body) {
          throw new APIError('BAD_REQUEST', {
            code: 'ID_TOKEN_SIGN_IN_DISABLED',
            message:
              'ID-token sign-in is not available on this path; use /sign-in/apple-native or ' +
              '/sign-in/google-native',
          });
        }
        await Promise.resolve();
      }),
    },
    plugins: [
      anonymous({
        // Fires after the new session is committed, outside any transaction. The merge is the
        // idempotent function above; the anonymous row is deleted by the queue consumer once
        // nothing references it (increment 8), never here.
        onLinkAccount: async ({ anonymousUser, newUser }) => {
          await merge(anonymousUser.user.id, newUser.user.id, 'anonymous_hook');
        },
        disableDeleteAnonymousUser: true,
      }),
      magicLink({
        storeToken: 'hashed',
        expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
        sendMagicLink: async ({ email, token }) => {
          // Our own URL, never Better Auth's: its `url` always carries `callbackURL`, and the
          // verify request must return JSON plus Set-Cookie, not a redirect (see sender.ts).
          const message = buildMagicLinkEmail({ token, apiPublicUrl: env.API_PUBLIC_URL });
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
