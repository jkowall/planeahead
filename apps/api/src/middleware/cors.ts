/**
 * CORS. Third in the chain, after request-id and Sentry, before anything that can reject.
 *
 * The mobile client is not a browser and sends no `Origin`, so this exists for the Expo web
 * target, for the eventual marketing site and for local tooling. The allow list is explicit: a
 * reflecting `*` with credentials is rejected by browsers anyway, and Better Auth's cookie
 * transport in increment 5 needs credentials.
 *
 * The same list is Better Auth's `trustedOrigins` (its CSRF check on cookie-bearing POSTs), so
 * what is allowed here is allowed there. The two localhost origins are development tooling and
 * are on the list ONLY when `ENVIRONMENT` is `local`: a staging or production Worker that
 * treated `http://localhost:8081` as first-party would let any local server on a victim's
 * machine make credentialed requests.
 */

import { cors } from 'hono/cors';
import type { Context, MiddlewareHandler } from 'hono';
import { type AppBindings, type Env, environmentName } from '../env';
import { INSTALL_ID_HEADER } from './idempotency';
import { REQUEST_ID_HEADER } from './request-id';

/** The Expo app scheme. Allowed in every environment. */
export const APP_SCHEME_ORIGIN = 'planeahead://';

/** Expo's dev server and `wrangler dev`. Allowed in the local environment only. */
export const LOCAL_DEV_ORIGINS: readonly string[] = Object.freeze([
  'http://localhost:8081',
  'http://localhost:8787',
]);

export function allowedOrigins(env: Env): readonly string[] {
  const origins = [APP_SCHEME_ORIGIN];
  if (typeof env.API_PUBLIC_URL === 'string') {
    origins.push(env.API_PUBLIC_URL);
  }
  if (environmentName(env) === 'local') {
    origins.push(...LOCAL_DEV_ORIGINS);
  }
  return origins;
}

export function corsMiddleware(): MiddlewareHandler<AppBindings> {
  return cors({
    // `hono/cors` types its callback's context as `Context<any>`, so the app's own generic is
    // reapplied here rather than letting `c.env` decay to `any`.
    origin: (origin, c: Context<AppBindings>) =>
      allowedOrigins(c.env).includes(origin) ? origin : null,
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      INSTALL_ID_HEADER,
      REQUEST_ID_HEADER,
    ],
    exposeHeaders: [REQUEST_ID_HEADER, 'Retry-After'],
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
    maxAge: 600,
  });
}
