/**
 * Mount points for the routes later increments own.
 *
 * Every path the mobile client and the providers will call is reserved here and answers 501 with
 * a body that names the increment that fills it in. Reserving them now is worth the twenty lines:
 * a 501 with an increment number is a far better answer than a 404 when someone points a client
 * at staging early, and the mounts fix the URL shape before anything depends on it.
 *
 * `all()` is used rather than a method list because these stubs contribute nothing to `AppType`
 * worth narrowing. Increment 5 replaced the `/api/auth` stub with Better Auth's handler and took
 * `/v1/devices` and `/v1/me`; increments 7 and 8 replace the rest of `/v1` route by route.
 */

import { Hono } from 'hono';
import type { AppBindings } from '../env';

export interface NotImplementedBody {
  readonly error: 'not_implemented';
  readonly increment: string;
  readonly message: string;
  readonly requestId: string;
}

function stub(increment: string, message: string) {
  return new Hono<AppBindings>().all('/*', (c) =>
    c.json<NotImplementedBody>(
      {
        error: 'not_implemented',
        increment,
        message,
        requestId: c.var.requestId,
      },
      501,
    ),
  );
}

/**
 * `/v1/*` beyond the account routes and the webhook receivers: `/v1/flights`, `/v1/sync` and
 * `/v1/events`. Increment 6 added the webhook receivers (src/routes/webhooks.ts, which answers
 * every other `/v1/webhooks/*` path with 404); increments 7 and 8 add the flight and sync routes. Mounted last under `/v1` (src/routes/v1.ts), so a real route registered ahead of
 * it answers first.
 */
export const v1Stub = stub(
  '06-providers through 08-routes',
  'this part of the /v1 surface is not wired yet; see docs/plans/phase0-plan.md section 5',
);
