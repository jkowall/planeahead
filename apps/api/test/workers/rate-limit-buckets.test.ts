/**
 * Better Auth's rate limiter through the real Worker: provably ON (it defaults to off on Workers
 * because Better Auth keys the default on NODE_ENV), and keyed by `cf-connecting-ip`, so two
 * addresses get two buckets rather than one shared `no-trusted-ip` bucket.
 *
 * The rows are read back from `rate_limits` (storage `database`), which also settles two facts
 * carried over from increment 3: Better Auth's create path is happy with the table's column
 * default for `id`, and `last_request` survives the bigint round trip as a number (the window
 * arithmetic below would never produce a 429 otherwise).
 */

import { inArray } from 'drizzle-orm';
import { rateLimits, withDb } from '@planeahead/db';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_RULES } from '../../src/auth/create-auth';
import { jsonRequest, testEnv, uniqueIp, worker } from './helpers/auth';

const RULE = RATE_LIMIT_RULES['/sign-in/anonymous'];

async function anonymousSignIn(ip: string): Promise<Response> {
  return worker(jsonRequest('/api/auth/sign-in/anonymous', 'POST', {}, { ip, origin: null }));
}

describe('Better Auth rate limiting on the Worker', () => {
  it('is on: the request after the custom rule maximum is 429, and another address is not', async () => {
    const noisy = uniqueIp();
    const quiet = uniqueIp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < RULE.max + 1; attempt += 1) {
      statuses.push((await anonymousSignIn(noisy)).status);
    }
    const quietResponse = await anonymousSignIn(quiet);

    expect(statuses.slice(0, RULE.max)).toEqual(Array<number>(RULE.max).fill(200));
    expect(statuses.at(-1)).toBe(429);
    expect(quietResponse.status).toBe(200);
  });

  it('keeps one rate_limits row per address and path, keyed by cf-connecting-ip', async () => {
    const first = uniqueIp();
    const second = uniqueIp();
    await anonymousSignIn(first);
    await anonymousSignIn(second);
    await anonymousSignIn(second);

    const rows = await withDb(testEnv, (db) =>
      db
        .select({
          key: rateLimits.key,
          count: rateLimits.count,
          lastRequest: rateLimits.lastRequest,
        })
        .from(rateLimits)
        .where(
          inArray(rateLimits.key, [`${first}|/sign-in/anonymous`, `${second}|/sign-in/anonymous`]),
        ),
    );
    const firstRow = rows.find((row) => row.key === `${first}|/sign-in/anonymous`);
    const secondRow = rows.find((row) => row.key === `${second}|/sign-in/anonymous`);

    expect(firstRow?.count).toBe(1);
    expect(secondRow?.count).toBe(2);
    // The bigint column reads back as a JavaScript number the window arithmetic can use.
    expect(typeof firstRow?.lastRequest).toBe('number');
    expect(firstRow?.lastRequest).toBeGreaterThan(Date.now() - 60_000);
    expect(rows).toHaveLength(2);
  });

  it('answers the 429 as JSON with Retry-After, so a client can back off', async () => {
    const ip = uniqueIp();
    let last: Response | null = null;
    for (let attempt = 0; attempt < RULE.max + 1; attempt += 1) {
      last = await anonymousSignIn(ip);
    }

    expect(last?.status).toBe(429);
    expect(last?.headers.get('x-retry-after') ?? last?.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});
