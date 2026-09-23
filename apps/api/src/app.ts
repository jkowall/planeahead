/**
 * The Hono app: its error handlers and its middleware chain, in the one order allowed to exist.
 *
 * This module exists so the chain has exactly one definition. Hono resolves middleware strictly in
 * registration order, which makes the list below a runtime contract rather than a style choice: a
 * middleware that reads `c.var.user` behaves differently depending on whether the auth middleware
 * has already run. A test that builds its own app in a different order therefore does not test the
 * Worker, it tests a Worker that does not exist, and it will stay green while the deployed one
 * fails. `src/index.ts` and every test that needs the chain call `createApp()`.
 *
 * The order (ruling E6, and `docs/increments/04-api-bootstrap.md`):
 *
 *   1. request-id   every later log line and every Sentry event needs the correlation id
 *   2. sentry       as early as possible, but after the id exists so it can be tagged
 *   3. cors         answer a preflight before anything that can reject it
 *   4. rate-limit   cheap abuse brake ahead of anything that reads a body
 *   5. idempotency  reads the body, so it must precede the handler that parses it
 *   6. auth         resolves the Better Auth session and sets c.var.user
 *
 * Note what follows from 5 running before 6: nothing in the idempotency middleware may assume
 * `c.var.user` has been assigned. It reads the variable as `?? null`, scopes anonymous keys by the
 * `X-Install-Id` header because there is no user to scope them by, and so must anything else that
 * lands in a slot ahead of auth. The principal limiter is therefore mounted under `/v1`
 * (src/routes/v1.ts), behind this chain, where the user is resolved.
 *
 * `app.onError` and `app.notFound` are registered BEFORE the Sentry middleware on purpose:
 * `withSentry` wraps whatever `app.errorHandler` is at the moment it runs, and a later
 * `app.onError()` would replace the wrapper and silently stop reporting handled route errors.
 */

import { Hono } from 'hono';
import type { CloudflareOptions } from '@sentry/cloudflare';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppBindings } from './env';
import { authMiddleware } from './middleware/auth';
import { corsMiddleware } from './middleware/cors';
import { type IdempotencyStore, idempotency } from './middleware/idempotency';
import { type LimiterSelector, ipLimiter } from './middleware/rate-limit';
import { requestId } from './middleware/request-id';
import { sentryMiddleware } from './middleware/sentry';
import { createLogger, errorFields } from './observability/log';

/**
 * Seams, all of them optional and all of them defaulting to what the Worker itself uses. They
 * exist so a test can stub one dependency without rebuilding the chain around it, which is the
 * thing that went wrong before: the stubs were cheap and a hand-built chain was not.
 */
export interface ChainOptions {
  /** Replaces the binding `ipLimiter` reads, for the fail-open and fail-closed paths. */
  readonly limiter?: LimiterSelector;
  /** Replaces the whole rate-limit slot, for a test of a different limiter in that position. */
  readonly rateLimit?: MiddlewareHandler<AppBindings>;
  /** Replaces the idempotency store selector, so no test needs Postgres to exercise a replay. */
  readonly idempotencyStore?: (c: Context<AppBindings>) => IdempotencyStore;
  /**
   * Merged over `sentryOptions()`. The suite passes a DSN and a capturing transport so that what
   * actually leaves the Worker can be asserted on, rather than only what the scrubber does to an
   * event the test built by hand.
   */
  readonly sentry?: Partial<CloudflareOptions>;
}

/**
 * The chain's registration order, as data.
 *
 * Building the slot list before the first `app.use()` means the Sentry middleware's `app.use`
 * patch is installed ahead of every registration, so request-id and the Sentry middleware itself
 * appear as `middleware.hono` spans too. Accepted: the extra spans are harmless and the trace
 * reads the same for every slot.
 *
 * Documentation with a check behind it, not the source of truth: `registerChain` below is the
 * source of truth, and it returns the names of the slots it registered in the order it registered
 * them. test/workers/chain.test.ts asserts that return value equals this list, so the two cannot
 * drift apart silently. Beyond the list, the suite pins the two positions that carry behaviour:
 * sentry after request-id (the `request_id` tag) and idempotency ahead of auth (`c.var.user`
 * unset in that slot).
 */
export const MIDDLEWARE_ORDER = [
  'request-id',
  'sentry',
  'cors',
  'rate-limit',
  'idempotency',
  'auth',
] as const;

export type MiddlewareName = (typeof MIDDLEWARE_ORDER)[number];

/**
 * Translates a thrown error into a response.
 *
 * The `HTTPException` branch is the one Hono's own default handler has, and dropping it is how a
 * custom `onError` turns every 401, 403 and 413 that a middleware or a validator signals by
 * throwing into an opaque 500. Increment 4 throws none of those (the house convention is to
 * return the response), but `hono/body-limit`, `hono/bearer-auth` and Better Auth's handler all
 * throw, and increment 5 mounts the first of them.
 *
 * Under `/v1` an `HTTPException` is answered with the PlaneAhead envelope and its own status
 * (increment 8, ruling O10), because the mobile client parses every non-2xx `/v1` answer as the
 * envelope and branches on `error`: `@hono/zod-validator` throws `HTTPException(400, 'Malformed
 * JSON in request body')` BEFORE the validator's hook runs, so a truncated body would otherwise
 * reach the outbox as `text/plain`. A 400 becomes `validation_failed` with one `invalid_json`
 * issue, a 413 `payload_too_large`, anything else the generic code for its status; each carries
 * the request id. Outside `/v1` (Better Auth's mount throws its own) the exception's response is
 * kept as Hono would answer it.
 *
 * Everything else really is unhandled, so it is logged with the request id and answered with a
 * body that carries the same id back to the caller.
 */
export function handleError(error: Error, c: Context<AppBindings>): Response {
  if (error instanceof HTTPException) {
    const path = new URL(c.req.url).pathname;
    if (path === '/v1' || path.startsWith('/v1/')) {
      return httpExceptionEnvelope(error, c);
    }
    return error.getResponse();
  }
  const requestIdValue = c.var.requestId ?? 'unknown';
  createLogger({ request_id: requestIdValue }).error('unhandled_error', {
    path: new URL(c.req.url).pathname,
    method: c.req.method,
    ...errorFields(error),
  });
  return c.json({ error: 'internal_error', requestId: requestIdValue }, 500);
}

/** The envelope for an `HTTPException` thrown under `/v1`, keeping its status. */
export function httpExceptionEnvelope(error: HTTPException, c: Context<AppBindings>): Response {
  const requestIdValue = c.var.requestId ?? 'unknown';
  const status = error.status;
  if (status === 400) {
    return c.json(
      {
        error: 'validation_failed',
        message: 'the request body is not valid JSON',
        issues: [{ path: [], message: 'malformed JSON', code: 'invalid_json' }],
        requestId: requestIdValue,
      },
      400,
    );
  }
  if (status === 413) {
    return c.json(
      {
        error: 'payload_too_large',
        message: 'the request body is too large',
        requestId: requestIdValue,
      },
      413,
    );
  }
  const code =
    status === 401
      ? 'unauthenticated'
      : status === 403
        ? 'insufficient_scope'
        : status === 404
          ? 'not_found'
          : status === 429
            ? 'rate_limited'
            : status >= 500
              ? 'internal_error'
              : 'invalid_payload';
  return c.json(
    { error: code, message: error.message || 'request refused', requestId: requestIdValue },
    status,
  );
}

export function handleNotFound(c: Context<AppBindings>): Response {
  return c.json({ error: 'not_found', requestId: c.var.requestId ?? 'unknown' }, 404);
}

/**
 * Registers the chain on `app`, in order, and returns the slot names in the order they were
 * registered. Nothing else may call `app.use()` on the root app.
 *
 * Each slot is a `[name, handler]` pair and the loop registers from that list, so the returned
 * names are the registration order by construction rather than a second copy of it.
 */
export function registerChain(
  app: Hono<AppBindings>,
  options: ChainOptions = {},
): readonly MiddlewareName[] {
  const slots: readonly (readonly [MiddlewareName, MiddlewareHandler<AppBindings>])[] = [
    ['request-id', requestId()],
    ['sentry', sentryMiddleware(app, options.sentry ?? {})],
    ['cors', corsMiddleware()],
    ['rate-limit', options.rateLimit ?? ipLimiter(options.limiter)],
    [
      'idempotency',
      idempotency(
        options.idempotencyStore === undefined ? {} : { store: options.idempotencyStore },
      ),
    ],
    ['auth', authMiddleware()],
  ];
  for (const [, handler] of slots) {
    app.use(handler);
  }
  return slots.map(([name]) => name);
}

/**
 * A Hono app with the error handlers and the chain already on it, and no routes. `src/index.ts`
 * chains the routes onto the result, because only the chained expression carries the RPC types.
 */
export function createApp(options: ChainOptions = {}): Hono<AppBindings> {
  const app = new Hono<AppBindings>();
  app.onError(handleError);
  app.notFound(handleNotFound);
  registerChain(app, options);
  return app;
}
