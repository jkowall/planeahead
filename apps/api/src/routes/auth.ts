/**
 * `/api/auth/*`: Better Auth's handler, mounted after the global chain (so after CORS, which
 * answers the preflight Better Auth's own `app.on(['GET','POST'])` mount would drop).
 *
 * What sits in front of the handler, and why:
 *
 *   - `GET /expo-authorization-proxy` answers 404. The Expo server plugin registers that route
 *     for the browser-based OAuth flows PlaneAhead does not use (the Expo client sets
 *     `x-skip-oauth-proxy`), and its own source carries a FIXME about redirecting to unrelated
 *     https hosts. Blocked here at the Hono layer, and recorded in docs/security/threat-model.md.
 *   - `POST /sign-in/magic-link` goes through `magicLinkGate` (middleware/magic-link-cap.ts):
 *     the body is validated and reduced to `{ email }`, the two caps are counted, and Better
 *     Auth sees only what the gate forwards.
 *   - `GET /magic-link/verify` is wrapped. Without a `callbackURL` Better Auth answers success as
 *     JSON plus Set-Cookie, which is the shape the app relies on, but it answers FAILURE as a 302
 *     to the base URL with `?error=...`, which the app's fetch follows into a 404. The wrapper
 *     turns that redirect into a 400 JSON body with the code, and refuses the three callback
 *     query parameters outright (400): with them Better Auth would redirect on success too, and
 *     the Expo plugin decorates that redirect with the raw `Set-Cookie` as `?cookie=`.
 *   - `POST /magic-link/consume` is the browser fallback for the emailed landing page
 *     (src/routes/magic-link-landing.ts): it verifies the posted token server side through the
 *     same wrapper and answers a page plus the session cookie. A cross-site form post is refused
 *     by `consumePostAllowed` before the token is touched (browsers always send `Origin` on a
 *     POST, and `Sec-Fetch-Site` on every request).
 *   - Every body that reaches Better Auth is read through Hono's cache and checked for U+0000
 *     (400 `INVALID_BODY`): Postgres refuses a NUL in any text column, so a NUL in `name` or
 *     anywhere else would otherwise be a 500 from inside Better Auth.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { AUTH_BASE_PATH } from '../auth/paths';
import { authRuntime } from '../auth/runtime';
import type { AppBindings } from '../env';
import { allowedOrigins } from '../middleware/cors';
import { magicLinkGate } from '../middleware/magic-link-cap';
import { createLogger } from '../observability/log';
import { NUL, containsNul } from '../validation/nul';
import { MAGIC_LINK_TOKEN_SHAPE, magicLinkPageResponse } from './magic-link-landing';

const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const CALLBACK_QUERY_KEYS = ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL'] as const;
/** Request headers the server-side verify call carries over from the browser's form post. */
const FORWARDED_HEADERS = ['cookie', 'cf-connecting-ip', 'user-agent', 'accept-language'] as const;

type BodyGuard =
  | { readonly ok: true; readonly body: string | null }
  | { readonly ok: false; readonly response: Response };

/** Appends `Set-Cookie` lines to a response whose headers may be immutable. */
export function withSetCookies(response: Response, cookies: readonly string[]): Response {
  if (cookies.length === 0) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const cookie of cookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Whether a consume POST came from the landing page.
 *
 * Under the page's `strict-origin` referrer policy a browser sends the API origin as `Origin`.
 * `Origin: null` is what a browser sends from a page under `no-referrer` (the first version of
 * the landing page, whose own button was therefore answered 403), from a sandboxed frame and
 * from an opaque document; it is accepted only when `Sec-Fetch-Site` says the request is
 * same-origin, which a cross-site page cannot claim. `Sec-Fetch-Site` cross-site or same-site
 * (another host under planeahead.app) is refused whatever `Origin` says. An absent `Origin` is
 * a non-browser client, and the token it posts is the same secret the app presents to verify.
 */
export function consumePostAllowed(headers: Headers, allowed: readonly string[]): boolean {
  const site = headers.get('sec-fetch-site');
  if (site === 'cross-site' || site === 'same-site') {
    return false;
  }
  const origin = headers.get('origin');
  if (origin === null) {
    return true;
  }
  if (origin === 'null') {
    return site === 'same-origin';
  }
  return allowed.includes(origin);
}

/**
 * The request body, read through Hono's cache (so nothing ahead of this route can have consumed
 * it) and refused when it carries a NUL anywhere. `null` for a bodyless method.
 */
async function guardedBody(c: Context<AppBindings>): Promise<BodyGuard> {
  if (BODYLESS_METHODS.has(c.req.method)) {
    return { ok: true, body: null };
  }
  const text = await c.req.text();
  const reject = (): BodyGuard => ({
    ok: false,
    response: c.json(
      {
        code: 'INVALID_BODY',
        message: 'NUL (U+0000) characters are not allowed',
        requestId: c.var.requestId,
      },
      400,
    ),
  });
  if (text.includes(NUL)) {
    return reject();
  }
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (contentType.includes('application/json') && text !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON at all: Better Auth's own parser answers it.
      return { ok: true, body: text };
    }
    if (containsNul(parsed)) {
      return reject();
    }
  }
  return { ok: true, body: text };
}

/**
 * The request handed to Better Auth: the original for a bodyless method, otherwise a copy with
 * `body` (which may be what the gate rebuilt rather than what the client sent). The copy is
 * needed regardless: Hono has read the raw body into its cache, and a consumed body on
 * `c.req.raw` would reach Better Auth as empty.
 */
export function requestForBetterAuth(c: Context<AppBindings>, body: string | null): Request {
  const raw = c.req.raw;
  if (body === null) {
    return raw;
  }
  const headers = new Headers(raw.headers);
  headers.delete('content-length');
  return new Request(raw.url, { method: raw.method, headers, body });
}

async function handleAuth(c: Context<AppBindings>): Promise<Response> {
  const guard = await guardedBody(c);
  if (!guard.ok) {
    return guard.response;
  }
  return authRuntime(c).auth.handler(requestForBetterAuth(c, guard.body));
}

async function handleMagicLinkRequest(c: Context<AppBindings>): Promise<Response> {
  const gate = await magicLinkGate(c);
  if (gate.kind === 'respond') {
    return gate.response;
  }
  return authRuntime(c).auth.handler(requestForBetterAuth(c, gate.body));
}

export type VerifyOutcome =
  | { readonly ok: true; readonly response: Response }
  | { readonly ok: false; readonly code: string };

function errorCodeFromRedirect(response: Response): string | null {
  if (response.status < 300 || response.status >= 400) {
    return null;
  }
  const location = response.headers.get('location');
  if (location === null) {
    return null;
  }
  try {
    const error = new URL(location).searchParams.get('error');
    return error === null || error === '' ? null : error.toUpperCase();
  } catch {
    return null;
  }
}

/** Better Auth's verify, with its error redirect translated into a code. */
async function verifyThroughBetterAuth(
  c: Context<AppBindings>,
  request: Request,
): Promise<VerifyOutcome> {
  const response = await authRuntime(c).auth.handler(request);
  const code = errorCodeFromRedirect(response);
  if (code !== null) {
    createLogger({ request_id: c.var.requestId }).info('magic_link_verify_failed', { code });
    return { ok: false, code };
  }
  return { ok: true, response };
}

async function handleMagicLinkVerify(c: Context<AppBindings>): Promise<Response> {
  const url = new URL(c.req.url);
  if (CALLBACK_QUERY_KEYS.some((key) => url.searchParams.has(key))) {
    return c.json(
      {
        code: 'CALLBACK_URL_NOT_SUPPORTED',
        message: 'verify answers JSON; callback URLs are not supported',
        requestId: c.var.requestId,
      },
      400,
    );
  }
  const token = url.searchParams.get('token');
  if (token === null || !MAGIC_LINK_TOKEN_SHAPE.test(token)) {
    return c.json(
      {
        code: 'INVALID_TOKEN',
        message: 'the token is missing or malformed',
        requestId: c.var.requestId,
      },
      400,
    );
  }
  const outcome = await verifyThroughBetterAuth(c, c.req.raw);
  if (!outcome.ok) {
    return c.json(
      {
        code: outcome.code,
        message: 'the link is invalid, expired or already used',
        requestId: c.var.requestId,
      },
      400,
    );
  }
  return outcome.response;
}

async function handleMagicLinkConsume(c: Context<AppBindings>): Promise<Response> {
  if (!consumePostAllowed(c.req.raw.headers, allowedOrigins(c.env))) {
    return magicLinkPageResponse(c, 'forbidden', 403);
  }
  const form = await c.req.parseBody();
  const token = form['token'];
  if (typeof token !== 'string' || !MAGIC_LINK_TOKEN_SHAPE.test(token)) {
    return magicLinkPageResponse(c, 'invalid', 400);
  }

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = c.req.header(name);
    if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const verifyUrl = new URL(`${AUTH_BASE_PATH}/magic-link/verify`, c.req.url);
  verifyUrl.searchParams.set('token', token);
  const outcome = await verifyThroughBetterAuth(
    c,
    new Request(verifyUrl.toString(), { method: 'GET', headers }),
  );
  if (!outcome.ok) {
    return magicLinkPageResponse(c, 'invalid', 400);
  }
  return withSetCookies(
    magicLinkPageResponse(c, 'signed_in', 200),
    outcome.response.headers.getSetCookie(),
  );
}

export const authRoutes = new Hono<AppBindings>()
  .get('/expo-authorization-proxy', (c) =>
    c.json({ error: 'not_found', requestId: c.var.requestId }, 404),
  )
  .post('/sign-in/magic-link', handleMagicLinkRequest)
  .get('/magic-link/verify', handleMagicLinkVerify)
  .post('/magic-link/consume', handleMagicLinkConsume)
  .all('/*', handleAuth);
