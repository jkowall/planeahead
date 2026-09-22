/**
 * The gate in front of Better Auth's `POST /sign-in/magic-link`.
 *
 * Better Auth's endpoint always writes a verification row and always calls `sendMagicLink`, and
 * its own rate limit is per IP (3 per 60 s). A prober cycling addresses, one person tapping
 * "resend" ten times, and a stranger who wants to lock an address out all need something in
 * front of it, and the counts live in `usage_counters` because the rate limit bindings are per
 * colo and permissive (plan section 10). `magicLinkGate` runs for EVERY request to the route
 * (the idempotency middleware skips the auth mount, so a replayed key cannot answer ahead of it)
 * and does four things, in order:
 *
 *   1. Reads the body through Hono's cache and fails CLOSED: a non-JSON media type is 415, a
 *      body that is not JSON or carries a NUL (U+0000) anywhere is 400. An earlier version read
 *      `c.req.raw.clone()`, which throws once anything ahead of it has consumed the body, and
 *      answered that throw by letting the request through uncounted.
 *   2. Keeps `email` and drops everything else. Better Auth's schema also accepts `name` (stored
 *      on the verification row and written to `users.name` at verify time, unbounded and
 *      unsanitised: whoever requests a link for an address with no account would choose that
 *      account's display name) and three callback URLs PlaneAhead never uses.
 *   3. Counts only a request Better Auth would accept (the address passes the same `z.email()`),
 *      so a request it would refuse cannot burn anyone's budget. Two counters, four rows:
 *
 *        (scope 'email',  subject `${sha256(address)}:${sha256(requester)}:hour` and `:day`)
 *        (scope 'install' or 'ip', subject `${sha256(requester)}:hour` and `:day`)
 *
 *      The per-ADDRESS cap (3 per hour, 10 per UTC day) is keyed by the address AND the
 *      requester, the install id when the request carries a valid `X-Install-Id`, else the
 *      client IP: the address owner's own device keeps its own budget, so a stranger cannot
 *      exhaust it and silently lock the owner out for the day. Over it, the caller still gets
 *      the `{ status: true }` 200 Better Auth would have answered, and Better Auth is not
 *      invoked: nothing is written, nothing is sent, and neither the cap nor a mail outage
 *      reveals whether the address has an account.
 *
 *      The per-REQUESTER cap (20 per hour, 60 per UTC day, any address) is keyed by the client
 *      IP when there is one, else the install id: an install id is client-chosen and free to
 *      rotate, an IP is not, and this is the brake on a single origin mailing many addresses
 *      or one address under many install ids. Over it the answer is 429 with `Retry-After`.
 *
 *   4. Hands the caller the JSON to forward, `{ email }` and nothing else.
 *
 * The window rides in the SUBJECT as well as in `window_start` on purpose: at 00:00 UTC the
 * hour and the day start at the same instant, and two rows that differed only by `window_start`
 * would collide on the table's unique key inside one INSERT. The counter is incremented before
 * the check, so the 4th request in an hour reads 4 and is refused. A request Better Auth then
 * refuses itself (its per-IP limit, a CSRF failure) has still been counted against the
 * requester's own budget; that over-count only ever affects the requester.
 *
 * Neither the address nor the requester is stored or logged: subjects are SHA-256 hex, and the
 * log line carries counts and the requester KIND only.
 */

import { sql } from 'drizzle-orm';
import { usageCounters } from '@planeahead/db';
import type { Context } from 'hono';
import * as z from 'zod';
import { authRuntime } from '../auth/runtime';
import { sha256Hex } from '../crypto/hash';
import type { AppBindings } from '../env';
import { createLogger } from '../observability/log';
import { NUL, containsNul } from '../validation/nul';
import { INSTALL_ID_HEADER, isValidInstallId } from './idempotency';

export const MAGIC_LINK_HOUR_CAP = 3;
export const MAGIC_LINK_DAY_CAP = 10;
export const MAGIC_LINK_REQUESTER_HOUR_CAP = 20;
export const MAGIC_LINK_REQUESTER_DAY_CAP = 60;
export const MAGIC_LINK_COUNTER = 'magic_links';
export const MAGIC_LINK_SCOPE = 'email';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The same rule Better Auth's body schema applies, so what is counted is what it would send. */
const emailSchema = z.email();

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

/** Seconds until the window that overflowed rolls over, for `Retry-After`. */
export function secondsUntilWindowEnd(nowMs: number, window: 'hour' | 'day'): number {
  const length = window === 'hour' ? HOUR_MS : DAY_MS;
  return Math.max(1, Math.ceil((length - (nowMs % length)) / 1000));
}

export type RequesterKind = 'install' | 'ip' | 'unknown';

export interface MagicLinkRequester {
  readonly kind: RequesterKind;
  readonly id: string;
}

/**
 * Who is asking, for the two caps. The address cap prefers the install id (the owner's own
 * device); the requester cap prefers the IP (not client-chosen). Each falls back to the other,
 * and a request with neither lands in one shared `unknown` bucket rather than in none.
 */
export function requestersOf(headers: Headers): {
  readonly forAddress: MagicLinkRequester;
  readonly forRequester: MagicLinkRequester;
} {
  const installHeader = headers.get(INSTALL_ID_HEADER);
  const install: MagicLinkRequester | null =
    installHeader !== null && isValidInstallId(installHeader)
      ? { kind: 'install', id: installHeader }
      : null;
  const ipHeader = headers.get('cf-connecting-ip');
  const ip: MagicLinkRequester | null =
    ipHeader !== null && ipHeader.trim() !== '' ? { kind: 'ip', id: ipHeader.trim() } : null;
  const unknown: MagicLinkRequester = { kind: 'unknown', id: 'unknown' };
  return {
    forAddress: install ?? ip ?? unknown,
    forRequester: ip ?? install ?? unknown,
  };
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface MagicLinkSubjects {
  readonly address: { readonly scope: string; readonly hour: string; readonly day: string };
  readonly requester: { readonly scope: string; readonly hour: string; readonly day: string };
}

/** The four `usage_counters` rows one request touches. */
export async function magicLinkSubjects(
  email: string,
  requesters: ReturnType<typeof requestersOf>,
): Promise<MagicLinkSubjects> {
  const address = await sha256Hex(normaliseEmail(email));
  const forAddress = await sha256Hex(`${requesters.forAddress.kind}:${requesters.forAddress.id}`);
  const forRequester = await sha256Hex(
    `${requesters.forRequester.kind}:${requesters.forRequester.id}`,
  );
  return {
    address: {
      scope: MAGIC_LINK_SCOPE,
      hour: `${address}:${forAddress}:hour`,
      day: `${address}:${forAddress}:day`,
    },
    requester: {
      scope: requesters.forRequester.kind === 'install' ? 'install' : 'ip',
      hour: `${forRequester}:hour`,
      day: `${forRequester}:day`,
    },
  };
}

export type MagicLinkGate =
  /** Let Better Auth handle it, with exactly this JSON as the body. */
  | { readonly kind: 'forward'; readonly body: string }
  /** Answer without invoking Better Auth. */
  | { readonly kind: 'respond'; readonly response: Response };

function reject(c: Context<AppBindings>, status: 400 | 415, code: string, message: string) {
  return {
    kind: 'respond' as const,
    response: c.json({ code, message, requestId: c.var.requestId }, status),
  };
}

export async function magicLinkGate(c: Context<AppBindings>): Promise<MagicLinkGate> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return reject(c, 415, 'UNSUPPORTED_MEDIA_TYPE', 'send the request as application/json');
  }
  const text = await c.req.text();
  if (text.includes(NUL)) {
    return reject(c, 400, 'INVALID_BODY', 'NUL (U+0000) characters are not allowed');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reject(c, 400, 'INVALID_BODY', 'the body is not valid JSON');
  }
  if (containsNul(parsed)) {
    return reject(c, 400, 'INVALID_BODY', 'NUL (U+0000) characters are not allowed');
  }
  const rawEmail: unknown =
    typeof parsed === 'object' && parsed !== null ? (parsed as { email?: unknown }).email : null;
  const email = emailSchema.safeParse(rawEmail);
  if (!email.success) {
    // Not counted: Better Auth refuses it with its own validation error and sends nothing.
    return {
      kind: 'forward',
      body: JSON.stringify(typeof rawEmail === 'string' ? { email: rawEmail } : {}),
    };
  }

  const nowMs = Date.now();
  const requesters = requestersOf(c.req.raw.headers);
  const subjects = await magicLinkSubjects(email.data, requesters);
  const { db } = authRuntime(c);
  const { hourStart, dayStart } = windowsAt(nowMs);

  const counts = await db
    .insert(usageCounters)
    .values([
      {
        scope: subjects.address.scope,
        subject: subjects.address.hour,
        counter: MAGIC_LINK_COUNTER,
        windowStart: hourStart,
        count: 1,
      },
      {
        scope: subjects.address.scope,
        subject: subjects.address.day,
        counter: MAGIC_LINK_COUNTER,
        windowStart: dayStart,
        count: 1,
      },
      {
        scope: subjects.requester.scope,
        subject: subjects.requester.hour,
        counter: MAGIC_LINK_COUNTER,
        windowStart: hourStart,
        count: 1,
      },
      {
        scope: subjects.requester.scope,
        subject: subjects.requester.day,
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
  const countOf = (subject: string): number =>
    counts.find((row) => row.subject === subject)?.count ?? 0;
  const addressHour = countOf(subjects.address.hour);
  const addressDay = countOf(subjects.address.day);
  const requesterHour = countOf(subjects.requester.hour);
  const requesterDay = countOf(subjects.requester.day);
  const log = createLogger({ request_id: c.var.requestId });

  if (
    requesterHour > MAGIC_LINK_REQUESTER_HOUR_CAP ||
    requesterDay > MAGIC_LINK_REQUESTER_DAY_CAP
  ) {
    const window = requesterDay > MAGIC_LINK_REQUESTER_DAY_CAP ? 'day' : 'hour';
    log.info('magic_link_capped', {
      cap: 'requester',
      requester_kind: requesters.forRequester.kind,
      hour_count: requesterHour,
      day_count: requesterDay,
    });
    c.header('Retry-After', String(secondsUntilWindowEnd(nowMs, window)));
    return {
      kind: 'respond',
      response: c.json(
        {
          code: 'TOO_MANY_REQUESTS',
          message: 'too many sign-in links requested from this client; try again later',
          requestId: c.var.requestId,
        },
        429,
      ),
    };
  }
  if (addressHour > MAGIC_LINK_HOUR_CAP || addressDay > MAGIC_LINK_DAY_CAP) {
    log.info('magic_link_capped', {
      cap: 'address',
      requester_kind: requesters.forAddress.kind,
      hour_count: addressHour,
      day_count: addressDay,
    });
    return { kind: 'respond', response: c.json({ status: true }) };
  }
  return { kind: 'forward', body: JSON.stringify({ email: email.data }) };
}
