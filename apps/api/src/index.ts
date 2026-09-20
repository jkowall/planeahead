/**
 * PlaneAhead API Worker.
 *
 * Three things leave this module and all three are load bearing:
 *
 *   - `default`: the Worker's handlers (`fetch`, `queue`, `scheduled`), wrapped by
 *     `withSentry` so queue and cron invocations are instrumented too.
 *   - the five Durable Object classes, which `exports` in wrangler.jsonc points at by name.
 *   - `AppType`, the Hono RPC type the mobile client's `hc<AppType>()` is built from (ADR 0004).
 *
 * `AppType` is the type of the CHAINED app. Hono's RPC types accumulate through the return value
 * of `.route()`, so a second statement `app.route(...)` on its own line throws the earlier route
 * types away and the client ends up with an empty surface. Add routes to the chain below, never
 * as separate statements.
 *
 * Middleware runs in registration order, which is why the order below is written out rather than
 * left to taste:
 *
 *   1. request-id   every later line of logging and every Sentry event needs the correlation id
 *   2. sentry       as early as possible, but after the id exists so it can be tagged
 *   3. cors         answer a preflight before anything that can reject it
 *   4. rate-limit   cheap abuse brake ahead of anything that reads a body
 *   5. idempotency  reads the body, so it must precede the handler that parses it
 *   6. auth         sets c.var.user; a placeholder until increment 5
 *
 * `app.onError` and `app.notFound` are registered BEFORE the Sentry middleware on purpose:
 * `withSentry` wraps whatever `app.errorHandler` is at the moment it runs, and a later
 * `app.onError()` would replace the wrapper and silently stop reporting handled route errors.
 */

import { withSentry } from '@sentry/cloudflare';
import { Hono } from 'hono';
import type { Env } from './env';
import type { AppBindings } from './env';
import { scheduled } from './cron/index';
import { authPlaceholder } from './middleware/auth';
import { corsMiddleware } from './middleware/cors';
import { idempotency } from './middleware/idempotency';
import { ipLimiter } from './middleware/rate-limit';
import { requestId } from './middleware/request-id';
import { sentryMiddleware, sentryOptions } from './middleware/sentry';
import { createLogger, errorFields } from './observability/log';
import { queue } from './queues/index';
import { health } from './routes/health';
import { authStub, v1Stub } from './routes/not-implemented';

export { AirportState } from './do/airport-state';
export { DesignatorResolver } from './do/designator-resolver';
export { FlightTracker } from './do/flight-tracker';
export { ProviderBudget } from './do/provider-budget';
export { UserInbox } from './do/user-inbox';

const app = new Hono<AppBindings>();

app.onError((error, c) => {
  const requestIdValue = c.var.requestId ?? 'unknown';
  createLogger({ request_id: requestIdValue }).error('unhandled_error', {
    path: new URL(c.req.url).pathname,
    method: c.req.method,
    ...errorFields(error),
  });
  return c.json({ error: 'internal_error', requestId: requestIdValue }, 500);
});

app.notFound((c) => c.json({ error: 'not_found', requestId: c.var.requestId ?? 'unknown' }, 404));

app.use(requestId());
app.use(sentryMiddleware(app));
app.use(corsMiddleware());
app.use(ipLimiter());
app.use(idempotency());
app.use(authPlaceholder());

/**
 * `route()` returns the same Hono instance, so `routes` and `app` are one object at run time.
 * The two names exist because only the chained expression carries the accumulated RPC types.
 */
const routes = app.route('/', health).route('/v1', v1Stub).route('/api/auth', authStub);

/** The RPC surface `hc<AppType>()` in apps/mobile is typed from. */
export type AppType = typeof routes;

export default withSentry(sentryOptions, {
  // Must be the app's own `fetch`, which `routes.fetch` is. Sentry keys "already instrumented"
  // off function identity, so handing it the same object makes this a no-op for fetch; a wrapper
  // or a `.bind()` would produce a second request transaction for every request. See
  // src/middleware/sentry.ts.
  fetch: routes.fetch,
  queue,
  scheduled,
} satisfies ExportedHandler<Env>);
