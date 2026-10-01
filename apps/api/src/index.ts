/**
 * PlaneAhead API Worker.
 *
 * Three things leave this module and all three are load bearing:
 *
 *   - `default`: the Worker's handlers (`fetch`, `queue`, `scheduled`), wrapped by
 *     `withSentry` so queue and cron invocations are instrumented too.
 *   - the six Durable Object classes, which `exports` in wrangler.jsonc points at by name.
 *   - `AppType`, the Hono RPC type the mobile client's `hc<AppType>()` is built from (ADR 0004).
 *
 * `AppType` is the type of the CHAINED app. Hono's RPC types accumulate through the return value
 * of `.route()`, so a second statement `app.route(...)` on its own line throws the earlier route
 * types away and the client ends up with an empty surface. Add routes to the chain below, never
 * as separate statements.
 *
 * `/api/auth` is NOT in the chain (increment 8, ruling K9): it is mounted by a separate
 * statement whose return value is discarded. `route()` returns the same instance at run time, so
 * the mount is live, but only the chained expression's type is `AppType`, and Better Auth's
 * catch-all stays out of it. The mobile client reaches those paths through the Better Auth client,
 * never through `hc`. `hcWithType` (src/client.ts) is the typed client the app builds from
 * `AppType`.
 *
 * The error handlers and the middleware chain live in `src/app.ts` and are applied by
 * `createApp()`. They are not inlined here so that the tests can build the same chain instead of
 * a hand-written approximation of it; the order is a runtime contract and a second copy of it is
 * a second thing to get wrong.
 */

import { withSentry } from '@sentry/cloudflare';
import { createApp } from './app';
import { MAGIC_LINK_LANDING_PATH } from './auth/paths';
import type { Env } from './env';
import { scheduled } from './cron/index';
import { sentryOptions } from './middleware/sentry';
import { queue } from './queues/index';
import { accountDeletePage } from './routes/account-delete-page';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { health } from './routes/health';
import { magicLinkLanding } from './routes/magic-link-landing';
import { v1Routes } from './routes/v1';
import { wellKnownRoutes } from './routes/well-known';

export { AirportState } from './do/airport-state';
export { DesignatorResolver } from './do/designator-resolver';
export { FlightTracker } from './do/flight-tracker';
export { ProviderBudget } from './do/provider-budget';
export { PushAuth } from './do/push-auth';
export { UserInbox } from './do/user-inbox';

const app = createApp();

/**
 * `route()` returns the same Hono instance, so `routes` and `app` are one object at run time.
 * The two names exist because only the chained expression carries the accumulated RPC types.
 */
const routes = app
  .route('/', health)
  .route('/v1', v1Routes)
  // The browser landing page for the emailed magic link: outside the Better Auth mount so a
  // GET can never consume the token (src/routes/magic-link-landing.ts).
  .route(MAGIC_LINK_LANDING_PATH, magicLinkLanding);

// Discarded on purpose: live at run time, absent from `AppType` (see the file header).
app.route('/api/auth', authRoutes);
// The universal-link and App Links association files (increment 9). Discarded for the same
// reason: Apple's and Google's crawlers fetch them, no client of `AppType` does.
app.route('/.well-known', wellKnownRoutes);
// The operator page behind Cloudflare Access and the public account-deletion page (increment
// 12). Browsers fetch them, no client of `AppType` does, so both are discarded mounts too.
app.route('/admin', adminRoutes);
app.route('/account', accountDeletePage);

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
