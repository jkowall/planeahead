/**
 * Auth. Last middleware before the routes, in the same slot the increment 4 placeholder held.
 *
 * Resolves the Better Auth session from the request (`auth.api.getSession({ headers })`; there
 * is no Expo session header, the Expo client replays the cookie) and sets `c.var.user`. Three
 * shortcuts keep it cheap where it must be:
 *
 *   - a request with no session cookie is anonymous without a database round trip, so `/health`
 *     stays I/O free and unauthenticated traffic costs nothing here;
 *   - `/api/auth/*` is left to Better Auth, which resolves the session itself where it needs it;
 *   - the runtime it builds (one database client, one Better Auth instance) is kept on the
 *     context, so the route that follows reuses it instead of opening a second client.
 *
 * The session read never refreshes (`query: { disableRefresh: true }`). Better Auth's sliding
 * refresh extends `sessions.expires_at` once a day AND re-issues the `session_token` cookie with
 * a fresh `Max-Age`, and the two halves must reach the client together: the Expo client expires
 * the cookie it holds by that `Max-Age`, and the only thing that writes its SecureStore cookie
 * is the Better Auth client, for requests made through it (`/api/auth/*`). The increment 9 `/v1`
 * client sends `Cookie` from that store and keeps nothing from a `/v1` response, so a refresh
 * performed here would extend the row, throw the cookie away, and leave `/get-session` seeing a
 * recently updated row for the rest of the day: thirty days after sign-in the app would be
 * signed out despite daily use (for an anonymous user, for good). An earlier fix forwarded the
 * refreshed cookie on the `/v1` response, which only moved the problem to a client that does not
 * store it, and would also have forwarded cookie DELETIONS for a revoked session, so a stale
 * anonymous `/v1` request finishing after an upgrade could wipe the new session. Refreshing
 * here is therefore off, `/v1` never emits `Set-Cookie`, and the refresh happens on
 * `GET /api/auth/get-session`, which the session gate calls on every launch and foreground
 * (docs/increments/09-mobile-scaffold.md) and whose cookies the Expo client stores.
 *
 * It fails closed. A missing `BETTER_AUTH_SECRET` or `TOKEN_KEK_V1` throws out of `authRuntime`
 * on the first request that presents a cookie and answers 500; an invalid or expired cookie
 * resolves to no session and the request continues anonymous, which `requireUser` then rejects.
 */

import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { AUTH_PATH_PREFIX } from '../auth/paths';
import { authRuntime } from '../auth/runtime';
import type { AuthScope, AuthenticatedUser } from '../auth/user';
import type { AppBindings } from '../env';

export { AUTH_PATH_PREFIX };
/** Both cookie names Better Auth can use carry this suffix (`__Secure-` prefixed over https). */
const SESSION_COOKIE_MARKER = 'session_token';

/** Whether the request presents anything that could resolve to a session. */
export function presentsSession(headers: Headers): boolean {
  const cookie = headers.get('cookie');
  return cookie !== null && cookie.includes(SESSION_COOKIE_MARKER);
}

export function authMiddleware(): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    c.set('user', null);
    const path = new URL(c.req.url).pathname;
    if (path.startsWith(AUTH_PATH_PREFIX) || !presentsSession(c.req.raw.headers)) {
      await next();
      return;
    }

    const runtime = authRuntime(c);
    const session = await runtime.auth.api.getSession({
      headers: c.req.raw.headers,
      query: { disableRefresh: true },
    });
    if (session !== null) {
      const user: AuthenticatedUser = {
        id: session.user.id,
        isAnonymous: (session.user as { isAnonymous?: boolean | null }).isAnonymous === true,
        sessionId: session.session.id,
        scopes: ['user'],
      };
      c.set('user', user);
    }
    await next();
  });
}

/**
 * Rejects with 401 unless a user is resolved.
 *
 * `c.var.user ?? null`, not `c.var.user === null`: a strict comparison treats an UNSET variable
 * as a resolved user and lets the request through, which is the dangerous direction for a guard.
 * Mounting this ahead of the auth middleware by mistake must fail closed.
 */
export function requireUser(): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    if ((c.var.user ?? null) === null) {
      return c.json(
        { error: 'unauthenticated', message: 'sign in first', requestId: c.var.requestId },
        401,
      );
    }
    await next();
  });
}

/** 401 without a principal, 403 when the principal lacks `scope`. */
export function requireScope(scope: AuthScope): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    const user = c.var.user ?? null;
    if (user === null) {
      return c.json(
        { error: 'unauthenticated', message: 'sign in first', requestId: c.var.requestId },
        401,
      );
    }
    if (!user.scopes.includes(scope)) {
      return c.json(
        {
          error: 'insufficient_scope',
          message: `this action needs the ${scope} scope`,
          requestId: c.var.requestId,
        },
        403,
      );
    }
    await next();
  });
}

/** Narrowing helper for handlers that ran behind `requireUser`. */
export function currentUser(user: AuthenticatedUser | null | undefined): AuthenticatedUser {
  if (user === null || user === undefined) {
    throw new Error('currentUser called on an unauthenticated request');
  }
  return user;
}
