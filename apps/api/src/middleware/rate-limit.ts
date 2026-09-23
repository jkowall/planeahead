/**
 * Rate limiting on Cloudflare's rate limit bindings.
 *
 * Three facts drive the shape of this file:
 *
 *   - The bindings are per-colo and Cloudflare documents them as "intentionally designed to not
 *     be used as an accurate accounting system". They are a cheap abuse brake, not a quota. No
 *     test asserts a global request rate, and no billing decision reads them.
 *   - A `namespace_id` is an account-wide counter. Staging and production use different ids
 *     (wrangler.jsonc), or staging load would spend production's allowance.
 *   - A missing binding fails OPEN. A limiter that 500s when its binding is absent turns a
 *     configuration mistake into an outage; a limiter that lets traffic through logs loudly and
 *     the deploy dry run is what catches the mistake.
 *
 * The limiter is injected rather than read straight off `env`, so a test can supply a stub. That
 * matters because whether the binding enforces at all inside the Workers Vitest pool is decided
 * by the spike in `docs/increments/04-api-bootstrap.md`, not by this code.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppBindings, Env } from '../env';
import { createLogger } from '../observability/log';

export interface RateLimitOutcome {
  readonly success: boolean;
}

/** The subset of Cloudflare's rate limit binding this middleware uses. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<RateLimitOutcome>;
}

export type LimiterSelector = (env: Env) => RateLimitBinding | undefined;

/** Returns the key to count against, or null to skip this request entirely. */
export type KeySelector = (c: Context<AppBindings>) => string | null;

export interface RateLimitOptions {
  /** Identifies the limiter in logs and in the 429 body. Matches the binding name. */
  readonly name: string;
  readonly limiter: LimiterSelector;
  readonly key: KeySelector;
  /** `Retry-After` in seconds. Matches the binding's period so a client backs off past it. */
  readonly retryAfterSeconds: number;
}

/** The client IP as Cloudflare sees it. Absent under `wrangler dev` and in the test pool. */
export function clientIp(c: Context<AppBindings>): string | null {
  return c.req.header('CF-Connecting-IP') ?? null;
}

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    const log = createLogger({ request_id: c.var.requestId });
    const binding = options.limiter(c.env);
    if (binding === undefined) {
      log.warn('rate_limit_binding_missing', { limiter: options.name });
      return next();
    }

    const key = options.key(c);
    if (key === null) {
      return next();
    }

    let outcome: RateLimitOutcome;
    try {
      outcome = await binding.limit({ key });
    } catch (error) {
      // Fail open: the brake is not worth an outage.
      log.warn('rate_limit_call_failed', {
        limiter: options.name,
        error_message: error instanceof Error ? error.message : String(error),
      });
      return next();
    }

    if (outcome.success) {
      return next();
    }

    log.info('rate_limited', { limiter: options.name });
    c.header('Retry-After', String(options.retryAfterSeconds));
    return c.json(
      {
        error: 'rate_limited',
        limiter: options.name,
        requestId: c.var.requestId,
      },
      429,
    );
  });
}

/**
 * Per-IP limiter for the public surface: PUBLIC_RL, 120 requests per 10 seconds.
 *
 * Registered in the global chain, before auth resolves, so it counts every caller the same way.
 * When there is no client IP (local dev, the test pool) the request is skipped rather than
 * bucketed under a shared placeholder key, which would make one developer's machine rate limit
 * itself.
 */
export function ipLimiter(
  limiter: LimiterSelector = (env) => env.PUBLIC_RL,
): MiddlewareHandler<AppBindings> {
  return rateLimit({
    name: 'PUBLIC_RL',
    limiter,
    key: (c) => {
      const ip = clientIp(c);
      return ip === null ? null : `ip:${ip}`;
    },
    retryAfterSeconds: 10,
  });
}

/**
 * Per-principal limiter: USER_RL, 600 requests per 60 seconds.
 *
 * Not registered in increment 4's chain, because no session is resolved until increment 5.
 * Increment 5 mounts it under `/v1` after the auth middleware, where the key selector below
 * starts returning a user id instead of null.
 *
 * `c.var.user ?? null`, not `c.var.user`: the rate-limit slot in the global chain runs BEFORE the
 * auth middleware (ruling E6), so the variable is `undefined` there rather than `null`. Reading
 * `user.id` off a strict `=== null` test would throw on every request the day this limiter is
 * mounted anywhere ahead of auth, and a test that registers auth first would not notice.
 */
export function principalLimiter(
  limiter: LimiterSelector = (env) => env.USER_RL,
): MiddlewareHandler<AppBindings> {
  return rateLimit({
    name: 'USER_RL',
    limiter,
    key: (c) => {
      const user = c.var.user ?? null;
      return user === null ? null : `user:${user.id}`;
    },
    retryAfterSeconds: 60,
  });
}
