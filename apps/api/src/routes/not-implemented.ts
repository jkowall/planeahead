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
 * `/v1/devices` and `/v1/me`; increment 8 took `/v1/flights` and `/v1/sync`.
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
 * `/v1/*` beyond the account, flight, sync and webhook routes: today only `POST /v1/events`, the
 * first-party analytics endpoint of plan section 5, which no increment spec schedules yet.
 * Mounted last under `/v1` (src/routes/v1.ts), so a real route registered ahead of it answers
 * first.
 */
export const v1Stub = stub(
  'unscheduled (POST /v1/events)',
  'this part of the /v1 surface is not wired yet; see docs/plans/phase0-plan.md section 5',
);
