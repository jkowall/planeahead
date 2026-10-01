/**
 * Ruling B9 (increment 18; plan section 3, R3 D11): who may open a board or search a route, and
 * how often.
 *
 *   - Both routes answer 404 `boards_disabled` while `BOARDS_ENABLED` is not `true` (increment
 *     18, R8: production, until AeroDataBox's written End Use answer and the per-user budget),
 *     before the session, the brakes or the database are touched.
 *   - Two brakes per board or route-search request: `BOARD_RL`, 30 per 60 s, keyed by the user,
 *     and `BOARD_IP_RL`, 300 per 60 s, keyed by the client's address reduced to its /64
 *     (`normaliseClientIp`, R11), so neither many accounts behind one address nor one account
 *     behind many addresses gets past them, while one NAT or IPv6 subnet of real installs is not
 *     starved by another's 30. Like every binding they are per colo and abuse brakes, never
 *     quotas, and they fail open (src/middleware/rate-limit.ts).
 *   - An anonymous account may open only the board of an airport one of its live subscriptions
 *     departs from or arrives at: one indexed query per anonymous request (the partial unique
 *     index on `flight_subscriptions (user_id, flight_instance_id) where deleted_at is null`,
 *     then the instance by primary key). A signed-in account may open any covered airport.
 *   - The route search is open to anonymous accounts (every install starts anonymous, and finding
 *     a flight by route is the onboarding path) within `usage_counters` caps: `route_searches`
 *     per user per UTC day, and for an anonymous account also per salted client IP per UTC day,
 *     the way `tracker_creations` caps creations (src/lib/flight-search.ts). The 403
 *     `cap_exceeded` names the allowance that ran out (`scope`: `user` or `ip`, R11), so the app
 *     can tell an anonymous account held by its network's cap to sign in.
 */

import { sql } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AuthenticatedUser } from '../auth/user';
import { boardsEnabled, type AppBindings, type Env } from '../env';
import { clientIp, rateLimit, type LimiterSelector } from '../middleware/rate-limit';
import type { Logger } from '../observability/log';
import { normaliseClientIp } from '../validation/client-ip';
import { ipRouteSearchCap, userCap, type CapSlot, type SqlExecutor } from '../lib/caps';
import { requireSecret, saltedIpSubject } from '../lib/hmac';

/** The bindings' own period, so a refused client backs off past it. */
export const BOARD_RL_PERIOD_SECONDS = 60;

/** Stand-ins for the two bindings (tests); each defaults to the Worker's own. */
export interface BoardLimiters {
  /** Replaces `BOARD_RL` (per user). */
  readonly user?: LimiterSelector | undefined;
  /** Replaces `BOARD_IP_RL` (per /64). */
  readonly ip?: LimiterSelector | undefined;
}

/** `BOARD_RL` by user, then `BOARD_IP_RL` by the /64; a request without an address skips it. */
export function boardRateLimits(
  limiters: BoardLimiters = {},
): [MiddlewareHandler<AppBindings>, MiddlewareHandler<AppBindings>] {
  return [
    rateLimit({
      name: 'BOARD_RL',
      limiter: limiters.user ?? ((env) => env.BOARD_RL),
      key: (c) => {
        const user = c.var.user ?? null;
        return user === null ? null : `user:${user.id}`;
      },
      retryAfterSeconds: BOARD_RL_PERIOD_SECONDS,
    }),
    rateLimit({
      name: 'BOARD_IP_RL',
      limiter: limiters.ip ?? ((env) => env.BOARD_IP_RL),
      key: (c) => {
        const ip = normaliseClientIp(clientIp(c));
        return ip === null ? null : `ip:${ip}`;
      },
      retryAfterSeconds: BOARD_RL_PERIOD_SECONDS,
    }),
  ];
}

/** 404 `boards_disabled` unless `BOARDS_ENABLED` is `true` (R8); first on both routes. */
export function requireBoardsEnabled(): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    if (!boardsEnabled(c.env)) {
      return c.json(
        {
          error: 'boards_disabled' as const,
          message: 'airport boards are not available yet',
          requestId: c.var.requestId,
        },
        404,
      );
    }
    await next();
  });
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
