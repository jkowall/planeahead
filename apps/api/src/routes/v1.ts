/**
 * The `/v1` surface: the `Cache-Control: no-store` default (increment 18, R1), the per-principal
 * rate limiter, then the `/v1` idempotency instance, then the airport (boards and route search,
 * increment 18), account, flight, sync, events and webhook routes. The provider receivers are anonymous (the
 * limiter skips them) and authenticate by path token; `POST /v1/events` (increment 12) is
 * anonymous by design and brakes on `EVENTS_RL` per client IP. Increment 12 also retired the 501
 * stub that reserved `/v1/events`. Two `/v1` paths still answer 501 on purpose, reserved for
 * Phase 1 (src/routes/webhooks.ts): `POST /v1/webhooks/apple` (Sign in with Apple server-to-server
 * notifications) and `POST /v1/webhooks/revenuecat`; every other `/v1` path is real or an
 * ordinary 404.
 *
 * `principalLimiter` is mounted HERE, behind the auth middleware, and not in the global chain:
 * in the global rate-limit slot `c.var.user` is unset (ruling E6), so the limiter would skip
 * every request there. Under `/v1` the key selector sees the resolved user and counts against
 * `USER_RL` (600 per 60 s, per colo, an abuse damper; exact quotas live in `usage_counters`).
 *
 * The idempotency instance comes AFTER the limiter (ruling K1: a 429 must never consume a key)
 * and after auth, so a key is scoped by the resolved user and stored in Postgres. It resolves the
 * scope and the store only; each keyed route reserves through `idempotencyGate()` after its
 * validator, because the request hash covers the validated body.
 *
 * `noStoreByDefault` is FIRST, so it sees every `/v1` answer last, the limiter's 429 and the error
 * handler's included, and adds `no-store` to each that names no `Cache-Control` of its own: no
 * `/v1` answer may sit in the phone's HTTP disk cache past sign-out (src/middleware/no-store.ts).
 *
 * `createV1Routes` exists for tests that inject a slow tracker or a failing transaction into the
 * flight routes, a purge horizon into the sync route, a dataset into the events route, or a clock
 * and `BOARD_RL` and `BOARD_IP_RL` stubs into the airport routes; the Worker mounts `v1Routes`,
 * built with no options.
 */

import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { idempotency } from '../middleware/idempotency';
import { noStoreByDefault } from '../middleware/no-store';
import { principalLimiter } from '../middleware/rate-limit';
import { createAirportRoutes, type AirportRoutesOptions } from './airports';
import { devicesRoutes } from './devices';
import { createEventsRoutes, type EventsRoutesOptions } from './events';
import { createFlightRoutes, type FlightRoutesOptions } from './flights';
import { meRoutes } from './me';
import { createSyncRoutes, type SyncRoutesOptions } from './sync';
import { webhookRoutes } from './webhooks';

export interface V1RoutesOptions {
  readonly airports?: AirportRoutesOptions;
  readonly flights?: FlightRoutesOptions;
  readonly sync?: SyncRoutesOptions;
  readonly events?: EventsRoutesOptions;
}

export function createV1Routes(options: V1RoutesOptions = {}) {
  return new Hono<AppBindings>()
    .use(noStoreByDefault())
    .use(principalLimiter())
    .use(idempotency({ mode: 'v1' }))
    .route('/airports', createAirportRoutes(options.airports))
    .route('/devices', devicesRoutes)
    .route('/flights', createFlightRoutes(options.flights))
    .route('/me', meRoutes)
    .route('/sync', createSyncRoutes(options.sync))
    .route('/events', createEventsRoutes(options.events))
    .route('/webhooks', webhookRoutes);
}

export const v1Routes = createV1Routes();
