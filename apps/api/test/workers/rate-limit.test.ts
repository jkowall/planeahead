/**
 * The rate limit middleware, in its real slot.
 *
 * Spike 3 settled the shape of this file: `env.PUBLIC_RL.limit()` DOES enforce inside the Workers
 * Vitest pool. 300 calls with one key against the 120-per-10-seconds binding returned 180
 * failures, so the 429 assertions below run against the real binding rather than a stub, and the
 * injectable limiter is used only for the fail-open and fail-closed paths that no binding can
 * produce on demand.
 *
 * Every app comes from `createApp()`, so the limiter under test runs in the position
 * `src/index.ts` gives it: after cors and BEFORE idempotency and auth. That matters for more than
 * tidiness. The previous version of this file registered `authPlaceholder()` first, which made
 * `c.var.user` null where the Worker leaves it undefined, and the `principalLimiter` assertion at
 * the bottom passed for the wrong reason: increment 5 mounts that limiter in this slot, and the
 * key selector would have thrown on every request while this test stayed green.
 *
 * What is deliberately NOT asserted: an exact allowed count. Cloudflare documents these bindings
 * as per-colo and "intentionally designed to not be used as an accurate accounting system". The
 * test asserts that a flood is eventually refused and that a single request is not, which is the
 * only contract the platform actually offers.
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import type { AppBindings } from '../../src/env';
import {
  type LimiterSelector,
  ipLimiter,
  principalLimiter,
  rateLimit,
} from '../../src/middleware/rate-limit';

/** The live binding's configured window, from wrangler.jsonc: PUBLIC_RL is 120 per 10 s. */
const PUBLIC_RL_LIMIT = 120;

/** The chain with its own ipLimiter, optionally reading a stubbed binding. */
function appWithLimiter(limiter?: LimiterSelector): Hono<AppBindings> {
  const app = createApp(limiter === undefined ? {} : { limiter });
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

/** The chain with a different middleware occupying the rate-limit slot entirely. */
function appWithSlot(middleware: MiddlewareHandler<AppBindings>): Hono<AppBindings> {
  const app = createApp({ rateLimit: middleware });
  app.get('/ping', (c) => c.json({ ok: true }));
  return app;
}

function requestFrom(ip: string): Request {
  return new Request('https://api.planeahead.test/ping', {
    headers: { 'CF-Connecting-IP': ip },
  });
}

describe('ipLimiter against the live PUBLIC_RL binding', () => {
  it('lets a single request through', async () => {
    const app = appWithLimiter();

    const response = await app.fetch(requestFrom(`203.0.113.${1}-${crypto.randomUUID()}`), env);

    expect(response.status).toBe(200);
  });

  it('answers 429 with Retry-After once the window is spent', async () => {
    const app = appWithLimiter();
    const ip = `198.51.100.7-${crypto.randomUUID()}`;

    let limited: Response | undefined;
    for (let attempt = 0; attempt < PUBLIC_RL_LIMIT * 2; attempt += 1) {
      const response = await app.fetch(requestFrom(ip), env);
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited).toBeDefined();
    if (limited === undefined) {
      return;
    }
    expect(limited.headers.get('Retry-After')).toBe('10');
    const body = await limited.json<{ error: string; limiter: string; requestId: string }>();
    expect(body.error).toBe('rate_limited');
    expect(body.limiter).toBe('PUBLIC_RL');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('counts each client IP separately', async () => {
    const app = appWithLimiter();
    const noisy = `192.0.2.10-${crypto.randomUUID()}`;
    const quiet = `192.0.2.11-${crypto.randomUUID()}`;

    for (let attempt = 0; attempt < PUBLIC_RL_LIMIT + 5; attempt += 1) {
      await app.fetch(requestFrom(noisy), env);
    }
    const response = await app.fetch(requestFrom(quiet), env);

    expect(response.status).toBe(200);
  });

  it('skips the limiter when there is no client IP', async () => {
    // `wrangler dev` and the test pool do not set CF-Connecting-IP. Bucketing those requests
    // under one placeholder key would make a single developer rate limit their own machine.
    const app = appWithLimiter();

    const response = await app.fetch(new Request('https://api.planeahead.test/ping'), env);

    expect(response.status).toBe(200);
  });
});

describe('rateLimit failure modes', () => {
  it('fails open when the binding is missing', async () => {
    const app = appWithLimiter(() => undefined);

    const response = await app.fetch(requestFrom('203.0.113.99'), env);

    expect(response.status).toBe(200);
  });

  it('fails open when the binding throws', async () => {
    const app = appWithLimiter(() => ({
      limit: () => Promise.reject(new Error('binding unavailable')),
    }));

    const response = await app.fetch(requestFrom('203.0.113.98'), env);

    expect(response.status).toBe(200);
  });

  it('refuses immediately when the injected limiter says so', async () => {
    const app = appWithLimiter(() => ({ limit: () => Promise.resolve({ success: false }) }));

    const response = await app.fetch(requestFrom('203.0.113.97'), env);

    expect(response.status).toBe(429);
  });

  it('uses the limiter name in the body so a 429 says which brake fired', async () => {
    const app = appWithSlot(
      rateLimit({
        name: 'EVENTS_RL',
        limiter: () => ({ limit: () => Promise.resolve({ success: false }) }),
        key: () => 'fixed',
        retryAfterSeconds: 60,
      }),
    );

    const response = await app.fetch(requestFrom('203.0.113.96'), env);
    const body = await response.json<{ limiter: string }>();

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(body.limiter).toBe('EVENTS_RL');
  });
});

describe('principalLimiter', () => {
  it('skips every request while no session is resolved, in the real pre-auth slot', async () => {
    // Increment 5's spec mounts `principalLimiter` keyed by user id in exactly this slot, which
    // runs BEFORE the auth middleware in the global chain. `c.var.user` is therefore `undefined`
    // here, not `null`; a strict `user === null` key selector reads `user.id` off it and every
    // request 500s the day the limiter is added. The mount below is the real position, so this
    // test fails if that guard is ever removed.
    let calls = 0;
    const app = appWithSlot(
      principalLimiter(() => ({
        limit: () => {
          calls += 1;
          return Promise.resolve({ success: false });
        },
      })),
    );

    const response = await app.fetch(requestFrom('203.0.113.95'), env);

    expect(response.status).toBe(200);
    expect(calls).toBe(0);
  });

  it('counts once a user is resolved, which is what increment 5 turns on', async () => {
    // The other half of the contract: the `?? null` guard must not make the limiter a permanent
    // no-op. This one is a two-middleware PROBE, not a chain, and says so: increment 5 mounts
    // `principalLimiter` under `/v1` behind its own auth middleware, and nothing in increment 4
    // can produce a resolved user in the global chain. Read the test above for the real slot.
    let seenKey: string | null = null;
    const probe = new Hono<AppBindings>();
    probe.use(async (c, next) => {
      c.set('user', {
        id: 'user-123',
        isAnonymous: false,
        kind: 'session',
        sessionId: 'session-123',
        scopes: ['user'],
      });
      await next();
    });
    probe.use(
      principalLimiter(() => ({
        limit: ({ key }) => {
          seenKey = key;
          return Promise.resolve({ success: false });
        },
      })),
    );
    probe.get('/ping', (c) => c.json({ ok: true }));

    const response = await probe.fetch(requestFrom('203.0.113.94'), env);

    expect(response.status).toBe(429);
    expect(seenKey).toBe('user:user-123');
  });

  it('is exported but not registered in increment 4', () => {
    expect(typeof principalLimiter).toBe('function');
    expect(typeof ipLimiter).toBe('function');
  });
});
