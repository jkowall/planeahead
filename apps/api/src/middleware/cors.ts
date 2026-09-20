/**
 * CORS. Third in the chain, after request-id and Sentry, before anything that can reject.
 *
 * The mobile client is not a browser and sends no `Origin`, so this exists for the Expo web
 * target, for the eventual marketing site and for local tooling. The allow list is explicit: a
 * reflecting `*` with credentials is rejected by browsers anyway, and Better Auth's cookie
 * transport in increment 5 needs credentials.
 */

import { cors } from 'hono/cors';
import type { Context, MiddlewareHandler } from 'hono';
import type { AppBindings, Env } from '../env';
import { REQUEST_ID_HEADER } from './request-id';

/** Origins allowed in every environment. `planeahead://` is the Expo app scheme. */
export const STATIC_ALLOWED_ORIGINS: readonly string[] = Object.freeze([
  'planeahead://',
  'http://localhost:8081',
  'http://localhost:8787',
]);

export function allowedOrigins(env: Env): readonly string[] {
  const configured = typeof env.API_PUBLIC_URL === 'string' ? [env.API_PUBLIC_URL] : [];
  return [...STATIC_ALLOWED_ORIGINS, ...configured];
}

export function corsMiddleware(): MiddlewareHandler<AppBindings> {
  return cors({
    // `hono/cors` types its callback's context as `Context<any>`, so the app's own generic is
    // reapplied here rather than letting `c.env` decay to `any`.
    origin: (origin, c: Context<AppBindings>) =>
      allowedOrigins(c.env).includes(origin) ? origin : null,
    allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', REQUEST_ID_HEADER],
    exposeHeaders: [REQUEST_ID_HEADER, 'Retry-After'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    maxAge: 600,
  });
}
