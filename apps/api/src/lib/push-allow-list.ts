/**
 * `PUSH_INJECT_ALLOWED_USER_IDS`: the user ids production may send a test push to. Three readers
 * share this one parse: the admin test push (increment 14, ruling P8) accepts only their tokens,
 * the `notify` consumer sends a test intent only to them (increment 15, ruling N11), and the
 * admin event injector refuses a flight none of them follows. Staging and local development
 * ignore the list.
 *
 * The value is a comma-separated list; each entry is trimmed and lower-cased, and an entry that
 * is not shaped like a UUID is ignored, so a typo narrows the list rather than widening it.
 */

import type { Env } from '../env';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The user ids a production test push or test intent may reach, lower case. */
export function allowedTestPushUserIds(env: Env): ReadonlySet<string> {
  return new Set(
    (env.PUSH_INJECT_ALLOWED_USER_IDS ?? '')
      .split(',')
      .map((id) => id.trim().toLowerCase())
      .filter((id) => UUID_SHAPE.test(id)),
  );
}
