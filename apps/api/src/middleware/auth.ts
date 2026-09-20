/**
 * Auth placeholder. Last middleware before the routes.
 *
 * It sets `c.var.user = null` on every request and nothing else. That is deliberate: every later
 * middleware and route handler is written against `c.var.user` from day one, so increment 5
 * replaces the body of this one function with Better Auth session resolution and no call site
 * changes.
 *
 * `requireUser` is the guard routes will use. In increment 4 it always rejects, which is the
 * honest answer: there is no way to authenticate yet, and a route that silently treated an
 * anonymous caller as authorised would be the bug worth preventing.
 */

import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';
import type { AuthenticatedUser } from '../auth/user';

export function authPlaceholder(): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    c.set('user', null);
    await next();
  });
}

/**
 * Rejects with 401 unless a user is resolved. Increment 5 makes it reachable.
 *
 * `c.var.user ?? null`, not `c.var.user === null`: a strict comparison treats an UNSET variable
 * as a resolved user and lets the request through, which is the dangerous direction for a guard.
 * Mounting this ahead of the auth middleware by mistake must fail closed.
 */
export function requireUser(): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    if ((c.var.user ?? null) === null) {
      return c.json(
        {
          error: 'unauthenticated',
          message: 'sign-in arrives in increment 5',
          requestId: c.var.requestId,
        },
        401,
      );
    }
    await next();
  });
}

/** Narrowing helper for handlers that ran behind `requireUser`. */
export function currentUser(user: AuthenticatedUser | null): AuthenticatedUser {
  if (user === null) {
    throw new Error('currentUser called on an unauthenticated request');
  }
  return user;
}
