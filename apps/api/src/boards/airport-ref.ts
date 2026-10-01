/**
 * The Worker's half of ruling B2 (increment 18): the airport a board or route-search request
 * names, resolved BEFORE any Durable Object is touched, because objects never open Postgres
 * (ADR 0007). The `airports` table is the authority and KV `ref:airport:{code}` in `CACHE` keeps
 * the answer a day (an unknown code an hour), keyed by the code as the request named it: a
 * 4-character ICAO code and a 3-character IATA code cannot collide. A null answer is the route's
 * 404, so an `AirportState` object exists only for a real airport, named by its ICAO code, and
 * is handed the ICAO code and IANA zone resolved here.
 */

import { AIRPORT_REF_KV_TTL_SECONDS, airportRefKvKey } from '@planeahead/shared';
import { resolveBoardAirport, withDb, type BoardAirport, type DbEnv } from '@planeahead/db';
import { z } from 'zod';

/** How long an unknown code is remembered: a bad code costs one query an hour, not one a view. */
export const AIRPORT_REF_NEGATIVE_TTL_SECONDS = 60 * 60;

const CODE_RE = /^[A-Z0-9]{3,4}$/;

const AirportRefKvV1 = z.object({
  airport: z
    .object({
      icao: z.string().regex(/^[A-Z0-9]{4}$/),
      iata: z.string().nullable(),
      name: z.string(),
      tz: z.string().min(1),
    })
    .nullable(),
});

export interface AirportRefEnv extends DbEnv {
  readonly CACHE: Pick<KVNamespace, 'get' | 'put'>;
}

export interface AirportRefOptions {
  /** Takes the KV write off the request's path (`c.executionCtx.waitUntil`); else it is awaited. */
  readonly waitUntil?: ((promise: Promise<unknown>) => void) | undefined;
}

/** The board airport for `code` (ICAO or IATA, any case), or null for a 404. */
export async function resolveBoardAirportCached(
  env: AirportRefEnv,
  code: string,
  options: AirportRefOptions = {},
): Promise<BoardAirport | null> {
  const normalized = code.trim().toUpperCase();
  if (!CODE_RE.test(normalized)) {
    return null;
  }
  const key = airportRefKvKey(normalized);
  try {
    const cached = AirportRefKvV1.safeParse(await env.CACHE.get(key, 'json'));
    if (cached.success) {
      return cached.data.airport;
    }
  } catch {
    // An unreadable KV falls through to Postgres, the authority.
  }
  const airport = await withDb(env, (db) => resolveBoardAirport(db, normalized));
  const write = env.CACHE.put(key, JSON.stringify({ airport }), {
    expirationTtl: airport === null ? AIRPORT_REF_NEGATIVE_TTL_SECONDS : AIRPORT_REF_KV_TTL_SECONDS,
  }).catch(() => undefined);
  if (options.waitUntil === undefined) {
    await write;
  } else {
    options.waitUntil(write);
  }
  return airport;
}
