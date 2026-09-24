/**
 * `POST /v1/events`: first-party product analytics (increment 12; increment 9 assigned it here,
 * fix-round ruling S6; ADR 0005 item 4).
 *
 * Anonymous and install-scoped by design: the mobile client (apps/mobile/src/lib/analytics.ts)
 * sends `{ analyticsId, events: [{ name, at, props? }] }` with `credentials: 'omit'` and no
 * `X-Install-Id`, so nothing here can join an event to an account, and nothing requires a
 * session. The contract is `ProductEventsBatchV1` in `@planeahead/shared`, which matches that
 * shape as the client already sends it: the envelope is validated whole (400 `validation_failed`
 * with the envelope), then each event on its own (`ProductEventV1`: a name from
 * `PRODUCT_EVENT_NAMES`, an ISO time, an optional flat props bag under its key, count and byte
 * caps), and an event that fails is dropped and counted, so an app one release ahead of the API
 * never loses its whole batch to one event this build does not know.
 *
 * Each accepted event becomes one `PRODUCT_EVENTS` Analytics Engine point (index the analytics
 * id, blobs the name, the environment, the props and the client time; `productEventPoint`),
 * through the invocation's 200-point `AnalyticsBudget` (a batch holds at most 100 events). The
 * answer is 202 `{ accepted, dropped }`. Nothing is stored in Postgres.
 *
 * Abuse brakes, in order, before the body is read: the global per-IP `PUBLIC_RL`, then
 * `EVENTS_RL` (300 batches per 60 s, ruling AA4: carrier NAT puts many installs behind one
 * address) keyed by the client IP, never by the analytics id (a value
 * the client chooses and rotates cannot key a brake, increment 5's rule), then a 256 KiB body
 * limit (413 `payload_too_large` with the envelope). Local dev and the test pool have no
 * `CF-Connecting-IP` unless a request sets it, and a request without one is not counted, like
 * `ipLimiter`.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  PRODUCT_EVENTS_MAX_BODY_BYTES,
  ProductEventV1,
  ProductEventsBatchV1,
  productEventPoint,
  type ProductEventsAcceptedV1,
} from '@planeahead/shared';
import { environmentName, type AppBindings } from '../env';
import { validate } from '../lib/validate';
import { clientIp, rateLimit, type LimiterSelector } from '../middleware/rate-limit';
import { createLogger } from '../observability/log';
import { AnalyticsBudget } from '../queues/analytics';

export interface EventsRoutesOptions {
  /** Replaces the `PRODUCT_EVENTS` binding, so a test can read the points written. */
  readonly dataset?: AnalyticsEngineDataset | undefined;
  /** Replaces the `EVENTS_RL` binding. */
  readonly limiter?: LimiterSelector | undefined;
}

export function createEventsRoutes(options: EventsRoutesOptions = {}) {
  return new Hono<AppBindings>().post(
    '/',
    rateLimit({
      name: 'EVENTS_RL',
      limiter: options.limiter ?? ((env) => env.EVENTS_RL),
      key: (c) => {
        const ip = clientIp(c);
        return ip === null ? null : `events:ip:${ip}`;
      },
      retryAfterSeconds: 60,
    }),
    bodyLimit({ maxSize: PRODUCT_EVENTS_MAX_BODY_BYTES }),
    validate('json', ProductEventsBatchV1),
    (c) => {
      const batch = c.req.valid('json');
      const log = createLogger({ request_id: c.var.requestId });
      const analytics = new AnalyticsBudget(options.dataset ?? c.env.PRODUCT_EVENTS, log);
      const environment = environmentName(c.env);
      let accepted = 0;
      let dropped = 0;
      for (const raw of batch.events) {
        const event = ProductEventV1.safeParse(raw);
        if (!event.success) {
          dropped += 1;
          continue;
        }
        if (analytics.write(productEventPoint(batch.analyticsId, event.data, environment))) {
          accepted += 1;
        } else {
          dropped += 1;
        }
      }
      analytics.report('product_events_analytics');
      if (dropped > 0) {
        log.info('product_events_dropped', { accepted, dropped });
      }
      return c.json<ProductEventsAcceptedV1, 202>({ accepted, dropped }, 202);
    },
  );
}

export const eventsRoutes = createEventsRoutes();
