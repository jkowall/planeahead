/**
 * Per-email magic-link caps, in front of Better Auth's handler for `POST /sign-in/magic-link`.
 *
 * Better Auth's endpoint always writes a verification row and always calls `sendMagicLink`, and
 * its own rate limit is per IP. A prober cycling addresses, or one person tapping "resend" ten
 * times, needs a per-ADDRESS cap, and it lives in `usage_counters` because the rate limit
 * bindings are per colo and permissive (plan section 10). Two rows per address:
 *
 *   (scope 'email', subject `${sha256hex(lower(email))}:hour`, counter 'magic_links', window_start = the current UTC hour)
 *   (scope 'email', subject `${sha256hex(lower(email))}:day`,  counter 'magic_links', window_start = the current UTC day)
 *
 * with caps 3 and 10. The window rides in the SUBJECT as well as in `window_start` on purpose:
 * at 00:00 UTC the hour and the day start at the same instant, and two rows that differed only
 * by `window_start` would then collide on the table's unique key inside one INSERT ("ON CONFLICT
 * DO UPDATE command cannot affect row a second time"). The `counter` stays `magic_links`, which
 * is what the table's check constraint allows.
 *
 * Over the cap the caller still gets the same `{ status: true }` 200 Better Auth would have
 * answered, and the handler is not invoked: nothing is written, nothing is sent. The counter is
 * incremented before the check, so the 4th request in an hour reads 4 and is refused.
 *
 * The email is never stored or logged: the subject is a SHA-256 hex, the log line carries the
 * counts only.
 */

import { sql } from 'drizzle-orm';
import { usageCounters } from '@planeahead/db';
import type { MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { authRuntime } from '../auth/runtime';
import { sha256Hex } from '../crypto/hash';
import type { AppBindings } from '../env';
import { createLogger } from '../observability/log';

export const MAGIC_LINK_HOUR_CAP = 3;
export const MAGIC_LINK_DAY_CAP = 10;
export const MAGIC_LINK_COUNTER = 'magic_links';
export const MAGIC_LINK_SCOPE = 'email';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface MagicLinkWindows {
  readonly hourStart: string;
  readonly dayStart: string;
}

export function windowsAt(nowMs: number): MagicLinkWindows {
  return {
    hourStart: new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS).toISOString(),
    dayStart: new Date(Math.floor(nowMs / DAY_MS) * DAY_MS).toISOString(),
  };
}

/** The two `usage_counters.subject` values for one address. */
export async function magicLinkSubjects(
  email: string,
): Promise<{ readonly hour: string; readonly day: string }> {
  const digest = await sha256Hex(email.trim().toLowerCase());
  return { hour: `${digest}:hour`, day: `${digest}:day` };
}

/** The address Better Auth will see, or null when the body is not a magic-link request. */
export async function emailFromBody(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.clone().json();
    if (typeof body !== 'object' || body === null) {
      return null;
    }
    const email = (body as { email?: unknown }).email;
    return typeof email === 'string' && email.includes('@') ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

export function magicLinkCap(): MiddlewareHandler<AppBindings> {
  return createMiddleware<AppBindings>(async (c, next) => {
    const email = await emailFromBody(c.req.raw);
    if (email === null) {
      // Not a well-formed request; Better Auth's own validation answers it.
      await next();
      return;
    }
    const subjects = await magicLinkSubjects(email);
    const { db } = authRuntime(c);
    const { hourStart, dayStart } = windowsAt(Date.now());

    const counts = await db
      .insert(usageCounters)
      .values([
        {
          scope: MAGIC_LINK_SCOPE,
          subject: subjects.hour,
          counter: MAGIC_LINK_COUNTER,
          windowStart: hourStart,
          count: 1,
        },
        {
          scope: MAGIC_LINK_SCOPE,
          subject: subjects.day,
          counter: MAGIC_LINK_COUNTER,
          windowStart: dayStart,
          count: 1,
        },
      ])
      .onConflictDoUpdate({
        target: [
          usageCounters.scope,
          usageCounters.subject,
          usageCounters.counter,
          usageCounters.windowStart,
        ],
        set: { count: sql`${usageCounters.count} + 1` },
      })
      .returning({ subject: usageCounters.subject, count: usageCounters.count });

    // Matched by subject, not by window start: the `instant` column renders `10:00:00Z` where
    // `toISOString()` wrote `10:00:00.000Z`, and a string comparison there silently read 0.
    const hourCount = counts.find((row) => row.subject === subjects.hour)?.count ?? 0;
    const dayCount = counts.find((row) => row.subject === subjects.day)?.count ?? 0;
    if (hourCount > MAGIC_LINK_HOUR_CAP || dayCount > MAGIC_LINK_DAY_CAP) {
      createLogger({ request_id: c.var.requestId }).info('magic_link_capped', {
        hour_count: hourCount,
        day_count: dayCount,
      });
      return c.json({ status: true });
    }
    await next();
  });
}
