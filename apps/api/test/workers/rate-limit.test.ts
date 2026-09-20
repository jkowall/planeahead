/**
 * The rate limit middleware.
 *
 * Spike 3 settled the shape of this file: `env.PUBLIC_RL.limit()` DOES enforce inside the Workers
 * Vitest pool. 300 calls with one key against the 120-per-10-seconds binding returned 180
 * failures, so the 429 assertions below run against the real binding rather than a stub, and the
 * injectable limiter is used only for the fail-open and fail-closed paths that no binding can
 * produce on demand.
 *
 * What is deliberately NOT asserted: an exact allowed count. Cloudflare documents these bindings
 * as per-colo and "intentionally designed to not be used as an accurate accounting system". The
 * test asserts that a flood is eventually refused and that a single request is not, which is the
 * only contract the platform actually offers.
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppBindings } from '../../src/env';
import { authPlaceholder } from '../../src/middleware/auth';
import { ipLimiter, principalLimiter, rateLimit } from '../../src/middleware/rate-limit';
import { requestId } from '../../src/middleware/request-id';

/** The live binding's configured window, from wrangler.jsonc: PUBLIC_RL is 120 per 10 s. */
const PUBLIC_RL_LIMIT = 120;

function appWith(middleware: ReturnType<typeof ipLimiter>): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.use(requestId());
  app.use(authPlaceholder());
  app.use(middleware);
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
    const app = appWith(ipLimiter());

    const response = await app.fetch(requestFrom(`203.0.113.${1}-${crypto.randomUUID()}`), env);

    expect(response.status).toBe(200);
  });

  it('answers 429 with Retry-After once the window is spent', async () => {
    const app = appWith(ipLimiter());
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
    const app = appWith(ipLimiter());
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
    const app = appWith(ipLimiter());

    const response = await app.fetch(new Request('https://api.planeahead.test/ping'), env);

    expect(response.status).toBe(200);
  });
});

describe('rateLimit failure modes', () => {
  it('fails open when the binding is missing', async () => {
    const app = appWith(ipLimiter(() => undefined));

    const response = await app.fetch(requestFrom('203.0.113.99'), env);

    expect(response.status).toBe(200);
  });

  it('fails open when the binding throws', async () => {
    const app = appWith(
      ipLimiter(() => ({
        limit: () => Promise.reject(new Error('binding unavailable')),
      })),
    );

    const response = await app.fetch(requestFrom('203.0.113.98'), env);

    expect(response.status).toBe(200);
  });

  it('refuses immediately when the injected limiter says so', async () => {
    const app = appWith(ipLimiter(() => ({ limit: () => Promise.resolve({ success: false }) })));

    const response = await app.fetch(requestFrom('203.0.113.97'), env);

    expect(response.status).toBe(429);
  });

  it('uses the limiter name in the body so a 429 says which brake fired', async () => {
    const app = appWith(
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
  it('skips every request while the auth placeholder leaves c.var.user null', async () => {
    // Increment 5 turns this on. Until then the key selector returns null on every request, which
    // is what keeps USER_RL from counting anonymous traffic into one bucket.
    let calls = 0;
    const app = appWith(
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
});
