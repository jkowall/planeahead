/**
 * Ruling B9 (increment 18; plan section 3, R3 D11): who may open a board or search a route, and
 * how often.
 *
 *   - `BOARD_RL`, 30 requests per 60 s, is taken TWICE per board or route-search request: once
 *     keyed by the user, once by the client IP, so neither many accounts behind one address nor
 *     one account behind many addresses gets past it. Like every binding it is per colo and an
 *     abuse brake, never a quota, and it fails open (src/middleware/rate-limit.ts).
 *   - An anonymous account may open only the board of an airport one of its live subscriptions
 *     departs from or arrives at: one indexed query per anonymous request (the partial unique
 *     index on `flight_subscriptions (user_id, flight_instance_id) where deleted_at is null`,
 *     then the instance by primary key). A signed-in account may open any covered airport.
 *   - The route search is open to anonymous accounts (every install starts anonymous, and finding
 *     a flight by route is the onboarding path) within `usage_counters` caps: `route_searches`
 *     per user per UTC day, and for an anonymous account also per salted client IP per UTC day,
 *     the way `tracker_creations` caps creations (src/lib/flight-search.ts).
 */

import { sql } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { AuthenticatedUser } from '../auth/user';
import type { AppBindings, Env } from '../env';
import { clientIp, rateLimit, type LimiterSelector } from '../middleware/rate-limit';
import type { Logger } from '../observability/log';
import { normaliseClientIp } from '../validation/client-ip';
import { ipRouteSearchCap, userCap, type CapSlot, type SqlExecutor } from '../lib/caps';
import { requireSecret, saltedIpSubject } from '../lib/hmac';

/** The binding's own period, so a refused client backs off past it. */
export const BOARD_RL_PERIOD_SECONDS = 60;

/** `BOARD_RL` by user, then by client IP; a request without an address skips the second. */
export function boardRateLimits(
  limiter: LimiterSelector = (env) => env.BOARD_RL,
): [MiddlewareHandler<AppBindings>, MiddlewareHandler<AppBindings>] {
  return [
    rateLimit({
      name: 'BOARD_RL',
      limiter,
      key: (c) => {
        const user = c.var.user ?? null;
        return user === null ? null : `user:${user.id}`;
      },
      retryAfterSeconds: BOARD_RL_PERIOD_SECONDS,
    }),
    rateLimit({
      name: 'BOARD_RL',
      limiter,
      key: (c) => {
        const ip = clientIp(c);
        return ip === null ? null : `ip:${ip}`;
      },
      retryAfterSeconds: BOARD_RL_PERIOD_SECONDS,
    }),
  ];
}

/** Whether one of the user's live subscriptions departs from or arrives at the airport. */
export async function subscribedAtAirport(
  db: SqlExecutor,
  userId: string,
  airportIcao: string,
): Promise<boolean> {
  const rows = await db.execute<{ found: number }>(sql`
    select 1 as found
    from flight_subscriptions s
    join flight_instances i on i.id = s.flight_instance_id
    where s.user_id = ${userId} and s.deleted_at is null
      and (i.origin_icao = ${airportIcao} or i.destination_icao = ${airportIcao})
    limit 1
  `);
  return rows.length > 0;
}

/** The route-search slots a caller pays: its own, and the salted IP's for an anonymous account. */
export async function routeSearchSlots(
  env: Pick<Env, 'IP_SALT_SECRET'>,
  user: AuthenticatedUser,
  rawIp: string | null,
  now: Date,
  log: Logger,
): Promise<CapSlot[]> {
  const slots = [userCap('route_searches', user.id, now)];
  if (user.isAnonymous) {
    const ip = normaliseClientIp(rawIp);
    if (ip === null) {
      // Cloudflare always sets CF-Connecting-IP; only `wrangler dev` and a bare test lack it.
      log.warn('anonymous_cap_without_client_ip', { cap: 'route_searches' });
    } else {
      const secret = requireSecret(env.IP_SALT_SECRET, 'IP_SALT_SECRET');
      const day = now.toISOString().slice(0, 10);
      slots.push(ipRouteSearchCap(await saltedIpSubject(secret, ip, day), now));
    }
  }
  return slots;
}
