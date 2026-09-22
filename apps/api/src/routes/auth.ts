/**
 * `/api/auth/*`: Better Auth's handler, mounted after the global chain (so after CORS, which
 * answers the preflight Better Auth's own `app.on(['GET','POST'])` mount would drop).
 *
 * Two things sit in front of the handler:
 *
 *   - `GET /expo-authorization-proxy` answers 404. The Expo server plugin registers that route
 *     for the browser-based OAuth flows PlaneAhead does not use (the Expo client sets
 *     `x-skip-oauth-proxy`), and its own source carries a FIXME about redirecting to unrelated
 *     https hosts. Blocked here at the Hono layer, and recorded in docs/security/threat-model.md.
 *   - the per-email cap on `POST /sign-in/magic-link` (`middleware/magic-link-cap.ts`).
 *
 * The request handed to Better Auth is rebuilt from the Hono request rather than passed as
 * `c.req.raw`: the idempotency middleware ahead of this route reads the body of every keyed
 * mutating request, and a consumed body on the raw `Request` would reach Better Auth as empty.
 * Hono caches what it read; the copy below is built from that cache.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { authRuntime } from '../auth/runtime';
import type { AppBindings } from '../env';
import { magicLinkCap } from '../middleware/magic-link-cap';

const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function requestForBetterAuth(c: Context<AppBindings>): Promise<Request> {
  const raw = c.req.raw;
  if (BODYLESS_METHODS.has(raw.method)) {
    return raw;
  }
  return new Request(raw.url, {
    method: raw.method,
    headers: raw.headers,
    body: await c.req.arrayBuffer(),
  });
}

async function handleAuth(c: Context<AppBindings>): Promise<Response> {
  const runtime = authRuntime(c);
  return runtime.auth.handler(await requestForBetterAuth(c));
}

export const authRoutes = new Hono<AppBindings>()
  .get('/expo-authorization-proxy', (c) =>
    c.json({ error: 'not_found', requestId: c.var.requestId }, 404),
  )
  .post('/sign-in/magic-link', magicLinkCap(), handleAuth)
  .all('/*', handleAuth);
