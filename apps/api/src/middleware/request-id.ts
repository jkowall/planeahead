/**
 * Request id. First middleware in the chain, so everything after it can correlate.
 *
 * Source order: a caller supplied `X-Request-Id` (the mobile client sends one so a user-reported
 * problem can be found in the logs), then Cloudflare's `CF-Ray`, then a fresh UUID. A caller
 * supplied value is validated before it is used: it lands in a response header and in log lines,
 * so an unbounded or control-character-carrying string is a log injection and a header splitting
 * hazard, not a convenience.
 */

import { createMiddleware } from 'hono/factory';
import type { AppBindings } from '../env';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Conservative: hex, dashes and underscores, bounded length. Covers UUIDs and CF-Ray ids. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function isSafeRequestId(value: string | undefined): value is string {
  return value !== undefined && SAFE_REQUEST_ID.test(value);
}

export function requestId() {
  return createMiddleware<AppBindings>(async (c, next) => {
    const supplied = c.req.header(REQUEST_ID_HEADER);
    const ray = c.req.header('CF-Ray');
    const id = isSafeRequestId(supplied)
      ? supplied
      : isSafeRequestId(ray)
        ? ray
        : crypto.randomUUID();

    c.set('requestId', id);
    await next();
    c.header(REQUEST_ID_HEADER, id);
  });
}
