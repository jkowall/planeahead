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
 * The error handlers and the middleware chain live in `src/app.ts` and are applied by
 * `createApp()`. They are not inlined here so that the tests can build the same chain instead of
 * a hand-written approximation of it; the order is a runtime contract and a second copy of it is
 * a second thing to get wrong.
 */

import { withSentry } from '@sentry/cloudflare';
import { createApp } from './app';
import type { Env } from './env';
import { scheduled } from './cron/index';
import { sentryOptions } from './middleware/sentry';
import { queue } from './queues/index';
import { health } from './routes/health';
import { authStub, v1Stub } from './routes/not-implemented';

export { AirportState } from './do/airport-state';
export { DesignatorResolver } from './do/designator-resolver';
export { FlightTracker } from './do/flight-tracker';
export { ProviderBudget } from './do/provider-budget';
export { UserInbox } from './do/user-inbox';

const app = createApp();

/**
 * `route()` returns the same Hono instance, so `routes` and `app` are one object at run time.
 * The two names exist because only the chained expression carries the accumulated RPC types.
 */
const routes = app.route('/', health).route('/v1', v1Stub).route('/api/auth', authStub);

/** The RPC surface `hc<AppType>()` in apps/mobile is typed from. */
export type AppType = typeof routes;

// The arrow rather than `sentryOptions` itself: the function takes an optional second argument
// (the suite's transport and DSN overrides), and handing it straight to a callback whose arity
// may grow would silently bind whatever that callback passes second to `overrides`.
export default withSentry((env: Env) => sentryOptions(env), {
  // Must be the app's own `fetch`, which `routes.fetch` is. Sentry keys "already instrumented"
  // off function identity, so handing it the same object makes this a no-op for fetch; a wrapper
  // or a `.bind()` would produce a second request transaction for every request. See
  // src/middleware/sentry.ts.
  fetch: routes.fetch,
  queue,
  scheduled,
} satisfies ExportedHandler<Env>);
