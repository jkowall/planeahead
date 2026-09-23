/**
 * Mount points for the routes later increments own.
 *
 * Every path the mobile client and the providers will call is reserved here and answers 501 with
 * a body that names the increment that fills it in. Reserving them now is worth the twenty lines:
 * a 501 with an increment number is a far better answer than a 404 when someone points a client
 * at staging early, and the mounts fix the URL shape before anything depends on it.
 *
 * `all()` is used rather than a method list because these stubs contribute nothing to `AppType`
 * worth narrowing. Increment 5 replaces the `/api/auth` sub-app with Better Auth's handler, and
 * increments 5, 7 and 8 replace `/v1` route by route.
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
 * `/api/auth/*`: Better Auth's handler (anonymous, magic link, Google ID token, the Expo
 * transport) plus the custom `POST /api/auth/apple/native` route.
 */
export const authStub = stub(
  '05-auth',
  'authentication is not wired yet; see docs/increments/05-auth.md',
);

/**
 * `/v1/*`: `/v1/me`, `/v1/devices`, `/v1/flights`, `/v1/sync`, `/v1/events` and
 * `/v1/webhooks/*`. Increment 5 adds the account routes, increment 6 the webhook receivers,
 * increment 7 the flight routes.
 */
export const v1Stub = stub(
  '05-auth through 08-routes',
  'the /v1 surface is not wired yet; see docs/plans/phase0-plan.md section 5',
);
