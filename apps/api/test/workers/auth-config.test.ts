/**
 * The fail-closed configuration, proven rather than assumed.
 *
 * Better Auth keys three defaults on NODE_ENV, which a Worker never sets: the rate limiter is
 * off, a missing secret falls back to a PUBLIC default, and the client IP is read from
 * x-forwarded-for. Each of the three is asserted here against the built instance (`options`
 * is what `betterAuth()` received) and, for the limiter, against the running Worker.
 */

import { openDb } from '@planeahead/db';
import { describe, expect, it } from 'vitest';
import {
  AuthConfigError,
  EXPO_GO_ORIGIN,
  IP_ADDRESS_HEADERS,
  MIN_SECRET_LENGTH,
  RATE_LIMIT_RULES,
  assertBetterAuthSecret,
  createAuth,
  trustedOriginsFor,
} from '../../src/auth/create-auth';
import { Envelope } from '../../src/crypto/envelope';
import { createStaticKeyProvider } from '../../src/crypto/key-provider';
import type { Env } from '../../src/env';
import { NoopSender } from '../../src/mail/index';
import { createLogger } from '../../src/observability/log';
import { jsonRequest, testEnv, uniqueIp, worker } from './helpers/auth';

function buildAuth(env: Env) {
  const db = openDb(env);
  const log = createLogger({}, () => undefined);
  return createAuth(env, {
    db,
    envelope: new Envelope(db, createStaticKeyProvider(new Map(), 1)),
    mail: new NoopSender(log),
    log,
    queue: { send: () => Promise.resolve() },
  });
}

describe('assertBetterAuthSecret', () => {
  it('throws on a missing, blank, short or default secret', () => {
    expect(() => assertBetterAuthSecret(undefined)).toThrow(AuthConfigError);
    expect(() => assertBetterAuthSecret('   ')).toThrow(AuthConfigError);
    expect(() => assertBetterAuthSecret('a'.repeat(MIN_SECRET_LENGTH - 1))).toThrow(/32/);
    expect(() => assertBetterAuthSecret('better-auth-secret-12345678901234567890')).toThrow(
      /default/,
    );
    expect(assertBetterAuthSecret('b'.repeat(MIN_SECRET_LENGTH))).toBe(
      'b'.repeat(MIN_SECRET_LENGTH),
    );
  });

  it('makes createAuth throw before betterAuth() is ever called', () => {
    const withoutSecret = Object.fromEntries(
      Object.entries(testEnv).filter(([key]) => key !== 'BETTER_AUTH_SECRET'),
    ) as Env;
    expect(() => buildAuth({ ...testEnv, BETTER_AUTH_SECRET: 'short' })).toThrow(AuthConfigError);
    expect(() => buildAuth(withoutSecret)).toThrow(AuthConfigError);
  });
});

describe('the options handed to betterAuth()', () => {
  const auth = buildAuth(testEnv);

  it('turns the rate limiter on, on database storage, with the two custom rules', () => {
    expect(auth.options.rateLimit?.enabled).toBe(true);
    expect(auth.options.rateLimit?.storage).toBe('database');
    expect(auth.options.rateLimit?.customRules).toEqual(RATE_LIMIT_RULES);
  });

  it('reads the client IP from cf-connecting-ip only', () => {
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual([...IP_ADDRESS_HEADERS]);
  });

  it('keeps the cookie cache on, telemetry off, OAuth token encryption off (stated)', () => {
    expect(auth.options.session?.cookieCache?.enabled).toBe(true);
    expect(auth.options.session?.expiresIn).toBe(30 * 24 * 60 * 60);
    expect(auth.options.telemetry?.enabled).toBe(false);
    expect(auth.options.account?.encryptOAuthTokens).toBe(false);
    expect(auth.options.secret).toBe(testEnv.BETTER_AUTH_SECRET);
  });

  it('registers the four plugins and the two native endpoints under /sign-in', () => {
    const ids = (auth.options.plugins ?? []).map((plugin) => plugin.id);
    expect(ids).toEqual(['anonymous', 'magic-link', 'expo', 'planeahead']);
    const paths: (string | undefined)[] = (auth.options.plugins ?? [])
      .flatMap((plugin) => Object.values(plugin.endpoints ?? {}) as { path?: string }[])
      .map((endpoint) => endpoint.path);
    expect(paths).toContain('/sign-in/apple-native');
    expect(paths).toContain('/sign-in/google-native');
  });
});

describe('the Drizzle adapter over the five-key schema subset', () => {
  it('passes the runtime schema check and resolves no session for a cookieless request', async () => {
    // docs/increments/03-db-schema.facts.md: `validateSchema` throws SchemaMismatchError on
    // first use for any extra NOT NULL column without a default on the five tables. Resolving a
    // session runs init, the adapter and the check; a null answer means all three accepted the
    // schema (`is_anonymous`, `status`, `plan`, `refresh_token_enc` and friends included).
    const auth = buildAuth(testEnv);
    await expect(auth.api.getSession({ headers: new Headers() })).resolves.toBeNull();
  });
});

describe('trustedOrigins', () => {
  it('always lists the app scheme, and exp:// only in the local environment', () => {
    const local = trustedOriginsFor({ ...testEnv, ENVIRONMENT: 'local' });
    const staging = trustedOriginsFor({ ...testEnv, ENVIRONMENT: 'staging' });
    const test = trustedOriginsFor(testEnv);

    expect(local).toContain('planeahead://');
    expect(local).toContain(EXPO_GO_ORIGIN);
    expect(staging).toContain('planeahead://');
    expect(staging).not.toContain(EXPO_GO_ORIGIN);
    expect(test).not.toContain(EXPO_GO_ORIGIN);
  });
});

describe('the running Worker', () => {
  it('rejects an idToken body on /sign-in/social before the built-in path can run', async () => {
    const response = await worker(
      jsonRequest(
        '/api/auth/sign-in/social',
        'POST',
        { provider: 'google', idToken: { token: 'x', nonce: 'n' } },
        { origin: null },
      ),
    );
    const body = await response.json<{ code?: string }>();

    expect(response.status).toBe(400);
    expect(body.code).toBe('ID_TOKEN_SIGN_IN_DISABLED');
  });

  it('answers 404 for the Expo authorization proxy the Expo plugin registers', async () => {
    const response = await worker(
      jsonRequest(
        '/api/auth/expo-authorization-proxy?authorizationURL=https%3A%2F%2Fevil.example%2F',
        'GET',
        undefined,
        { origin: null },
      ),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  it('answers CORS preflight on the auth mount', async () => {
    const response = await worker(
      new Request('https://api.planeahead.test/api/auth/sign-in/anonymous', {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:8081',
          'access-control-request-method': 'POST',
          'cf-connecting-ip': uniqueIp(),
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:8081');
  });
});
