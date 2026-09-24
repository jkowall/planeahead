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
 *
 * Account deletion (increment 8, ruling K8) adds one distinction and nothing else. A deleted
 * account's sessions die with its `users` row, so another device of that user presents a cookie
 * that no longer resolves, exactly like an expired one. The deletion kept a keyed hash of every
 * session token it removed (`deleted_subjects`, kind `session`), so when a presented cookie does
 * not resolve the middleware looks its token up there and marks the request `accountDeleted`;
 * `requireUser` and `requireScope` then answer 401 `account_deleted` (wipe the local store)
 * instead of `unauthenticated` (sign in again). One indexed read, only on the rare request that
 * presents a dead cookie.
 *
 * The cookie cache (increment 12, ruling W2 step 8, replacing increment 8's ruling O5). Every
 * MUTATING request skips Better Auth's 300 s cookie cache and reads the `sessions` row, so a write
 * never acts for a revoked or deleted session, and so does `GET /v1/flights/search`
 * (`ROW_READ_GET_PATHS`, ruling AA11): a GET that takes creation caps and can seed a tracker,
 * which spends a provider call, is a write in all but method. The other GETs and HEADs, the
 * read-only paths, may be answered from the signed session cookie cache again (increment 8 had
 * disabled that for every `/v1` request, at one indexed read each): whenever such a request
 * resolves a session through that cacheable read, whatever the cache cookie is called (Better Auth
 * also accepts it in chunks, `session_data.0`, `.1`, ...; ruling AA14), its session token's keyed
 * hash is looked up as a KV tombstone (src/lib/session-tombstone.ts), which the account deletion
 * writes for every session it removes, and a hit answers 401 `account_deleted`: one KV read per
 * cacheable GET, by design. So a deleted account's other device is still told `account_deleted`
 * on its next GET without a database read per GET. When the tombstone cannot be checked (no
 * `DELETED_SUBJECT_HMAC_KEY`, or the KV read fails) the request reads the row as before. What the
 * cache still allows, and the threat model records: a session revoked WITHOUT an account deletion
 * (sign-out elsewhere, the anonymous merge's revocation) keeps the read-only paths, never a write
 * or a search, until its cache cookie expires (at most 300 s); and KV's propagation (about 60 s)
 * bounds how soon another location sees a new tombstone. `/api/auth/*` is untouched: Better
 * Auth's own `get-session` keeps its cache.
 */

import { and, eq, gt, sql } from 'drizzle-orm';
import { deletedSubjects } from '@planeahead/db';
import type { Context, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { AUTH_PATH_PREFIX } from '../auth/paths';
import { authRuntime } from '../auth/runtime';
import type { AuthScope, AuthenticatedUser } from '../auth/user';
import type { AppBindings } from '../env';
import { MIN_SECRET_LENGTH, deletedSubjectHash } from '../lib/hmac';
import { lookupSessionTombstone } from '../lib/session-tombstone';
import { errorFields } from '../observability/log';

export { AUTH_PATH_PREFIX };
/** Both cookie names Better Auth can use carry this suffix (`__Secure-` prefixed over https). */
const SESSION_COOKIE_MARKER = 'session_token';

/** The methods that may be answered from the cookie cache (increment 12); everything else reads. */
const CACHEABLE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/**
 * GETs that read the session row like a mutating request (ruling AA11): the flight search takes
 * `usage_counters` slots and may spend a provider call through the DesignatorResolver.
 */
export const ROW_READ_GET_PATHS: ReadonlySet<string> = new Set(['/v1/flights/search']);

/**
 * Whether this request must read the session row itself rather than the cookie cache: every
 * method but GET and HEAD, and the GETs of `ROW_READ_GET_PATHS`. Every other path is read-only
 * and may use the cache, checked against the KV tombstone below.
 */
export function bypassesCookieCache(method: string, path: string): boolean {
  if (!CACHEABLE_METHODS.has(method)) {
    return true;
  }
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return ROW_READ_GET_PATHS.has(trimmed);
}

/** Whether the request presents anything that could resolve to a session. */
export function presentsSession(headers: Headers): boolean {
  const cookie = headers.get('cookie');
  return cookie !== null && cookie.includes(SESSION_COOKIE_MARKER);
}

/**
 * The session token a cookie header carries, unverified: Better Auth signs the cookie as
 * `{token}.{signature}` (URL-encoded). The signature is not checked here because the token is only
 * used to look up a keyed hash, and a forged cookie can at worst learn that a token it already
 * holds belonged to a deleted account.
 */
export function sessionTokenFromCookie(cookieHeader: string | null): string | null {
  if (cookieHeader === null) {
    return null;
  }
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    const name = eq < 0 ? '' : pair.slice(0, eq).trim();
    if (!name.endsWith(SESSION_COOKIE_MARKER)) {
      continue;
    }
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(eq + 1).trim());
    } catch {
      return null;
    }
    const dot = value.lastIndexOf('.');
    const token = dot <= 0 ? value : value.slice(0, dot);
    return token === '' ? null : token;
  }
  return null;
}

/** Whether a presented, unresolvable session token belonged to a deleted account. */
async function presentedSessionWasDeleted(c: Context<AppBindings>): Promise<boolean> {
  const key = c.env.DELETED_SUBJECT_HMAC_KEY;
  const token = sessionTokenFromCookie(c.req.header('cookie') ?? null);
  if (key === undefined || key.length < MIN_SECRET_LENGTH || token === null) {
    return false;
  }
  try {
    const hash = await deletedSubjectHash(key, 'session', token);
    const rows = await authRuntime(c)
      .db.select({ id: deletedSubjects.id })
      .from(deletedSubjects)
      .where(
        and(
          eq(deletedSubjects.providerSubjectHash, hash),
          gt(deletedSubjects.expiresAt, sql`now()`),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch (error) {
    // The distinction is a courtesy to the client; a failed lookup is an ordinary 401.
    authRuntime(c).log.warn('account_deleted_lookup_failed', errorFields(error));
    return false;
  }
}

/**
 * The tombstone check for a session that may have come from the cookie cache: `present` means the
 * account was deleted, `absent` that the cached session stands, `unknown` that the check could not
 * be made (no HMAC key, no token, a KV failure) and the row must be read instead.
 */
async function cachedSessionTombstone(
  c: Context<AppBindings>,
): Promise<'present' | 'absent' | 'unknown'> {
  const key = c.env.DELETED_SUBJECT_HMAC_KEY;
  const token = sessionTokenFromCookie(c.req.header('cookie') ?? null);
  if (key === undefined || key.length < MIN_SECRET_LENGTH || token === null) {
    return 'unknown';
  }
  const hash = await deletedSubjectHash(key, 'session', token);
  return lookupSessionTombstone(c.env.CACHE, hash, authRuntime(c).log);
}

/** Whether the tombstone check is possible at all; without it the cache is never used. */
function tombstonesCheckable(c: Context<AppBindings>): boolean {
  const key = c.env.DELETED_SUBJECT_HMAC_KEY;
  return key !== undefined && key.length >= MIN_SECRET_LENGTH;
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
    const readRow = (): ReturnType<typeof runtime.auth.api.getSession> =>
      runtime.auth.api.getSession({
        headers: c.req.raw.headers,
        query: { disableRefresh: true, disableCookieCache: true },
      });
    const cacheable = !bypassesCookieCache(c.req.method, path) && tombstonesCheckable(c);
    let session = cacheable
      ? await runtime.auth.api.getSession({
          headers: c.req.raw.headers,
          query: { disableRefresh: true },
        })
      : await readRow();
    // Any session the cacheable read resolved may have come from the cache cookie, whatever it is
    // called (ruling AA14), so every one is checked: one KV read per cacheable GET.
    if (session !== null && cacheable) {
      const tombstone = await cachedSessionTombstone(c);
      if (tombstone === 'present') {
        c.set('accountDeleted', true);
        await next();
        return;
      }
      if (tombstone === 'unknown') {
        session = await readRow();
      }
    }
    if (session === null) {
      if (await presentedSessionWasDeleted(c)) {
        c.set('accountDeleted', true);
      }
    } else {
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
      return unauthenticated(c);
    }
    await next();
  });
}

/**
 * The 401 for a request without a principal: `account_deleted` when the cookie it presented
 * belonged to a deleted account (the client wipes its store), `unauthenticated` otherwise.
 */
export function unauthenticated(c: Context<AppBindings>): Response {
  if (c.var.accountDeleted === true) {
    return c.json(
      {
        error: 'account_deleted',
        message: 'this account was deleted; clear the data stored on this device',
        requestId: c.var.requestId,
      },
      401,
    );
  }
  return c.json(
    { error: 'unauthenticated', message: 'sign in first', requestId: c.var.requestId },
    401,
  );
}

/** 401 without a principal, 403 when the principal lacks `scope`. */
export function requireScope(scope: AuthScope): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    const user = c.var.user ?? null;
    if (user === null) {
      return unauthenticated(c);
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
