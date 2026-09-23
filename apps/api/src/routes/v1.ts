/**
 * The `/v1` surface: the per-principal rate limiter, then the account routes and the provider
 * webhook receivers (increment 6), then the stub for everything increments 7 and 8 still own.
 * The receivers are anonymous (the limiter skips them) and authenticate by path token.
 *
 * `principalLimiter` is mounted HERE, behind the auth middleware, and not in the global chain:
 * in the global rate-limit slot `c.var.user` is unset (ruling E6), so the limiter would skip
 * every request there. Under `/v1` the key selector sees the resolved user and counts against
 * `USER_RL` (600 per 60 s, per colo, an abuse damper; exact quotas live in `usage_counters`).
 */

import { Hono } from 'hono';
import type { AppBindings } from '../env';
import { principalLimiter } from '../middleware/rate-limit';
import { devicesRoutes } from './devices';
import { meRoutes } from './me';
import { v1Stub } from './not-implemented';
import { webhookRoutes } from './webhooks';

export const v1Routes = new Hono<AppBindings>()
  .use(principalLimiter())
  .route('/devices', devicesRoutes)
  .route('/me', meRoutes)
  .route('/webhooks', webhookRoutes)
  .route('/', v1Stub);
