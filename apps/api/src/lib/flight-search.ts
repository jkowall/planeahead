/**
 * Turning a designator and an origin-local date into a flight key (increment 8, ruling K10),
 * shared by `GET /v1/flights/search` and `POST /v1/flights { number, date }`.
 *
 * Cheapest answer first, and a provider call only when nothing else knows the flight:
 *
 *   1. the date must be inside the provider's lookahead (`maxDaysAhead` of the configured
 *      AeroDataBox plan), or 422 `date_out_of_range` with no call at all;
 *   2. KV `search:number:{designator}:{date}` (900 s, written by the DesignatorResolver);
 *   3. `flight_designators`, for a known mapping to an existing instance: it supplies the origin,
 *      which is what lets the resolver's existing-tracker probe run (without an origin the probe
 *      is structurally impossible, increment 7's open question);
 *   4. the increment 7 resolve helper (`src/search/resolve.ts`: KV again, then the
 *      DesignatorResolver object, which probes or makes the one AeroDataBox call and seeds the
 *      tracker), awaited under the route's deadline.
 *
 * Creating a tracker is what costs money, so it is what is capped, wherever a request creates
 * one (this search included, not only a subscribe): `instances_created` per user per UTC day, and
 * for an anonymous account (a Better Auth anonymous user, `isAnonymous`) also `tracker_creations`
 * per salted client IP per UTC day. When steps 2 and 3 found nothing the flight is presumed new: the slots are TAKEN before
 * the resolver runs (so a capped caller is refused without a provider call) and RELEASED when the
 * answer says no tracker was created (adopted, cached, not found, failed). When step 3 found the
 * flight, the resolver is expected to adopt it, so nothing is reserved; a creation that happens
 * anyway (the old tracker was gone) is charged after the fact.
 */

import {
  DAY_MS,
  ResolveResponseV1 as ResolveResponseSchema,
  parseFlightKey,
  type FlightKey,
  type FlightStatus,
  type ResolveResponseV1,
} from '@planeahead/shared';
import type { AuthenticatedUser } from '../auth/user';
import { normalizeDesignator, searchKvKey } from '../do/designator-resolver';
import type { Env } from '../env';
import { errorFields, type Logger } from '../observability/log';
import { providerSettings } from '../providers/config';
import { resolveDesignator, type DesignatorSearchResult } from '../search/resolve';
import { normaliseClientIp } from '../validation/client-ip';
import { CapLedger, ipTrackerCreationCap, takeCap, userCap, type CapSlot } from './caps';
import { withDeadline } from './deadline';
import {
  ensureInstanceRegistered,
  lookupDesignator,
  recordDesignator,
  resolveOriginIcao,
  type DbOrTx,
} from './flight-registry';
import { requireSecret, saltedIpSubject } from './hmac';
import { TRACKER_LOCATION_HINT } from './trackers';

export interface FlightQuery {
  readonly designator: string;
  readonly dateLocal: string;
  /** IATA or ICAO, already upper-cased by the validator. */
  readonly origin?: string | undefined;
}

export type Resolver = (
  env: Env,
  input: {
    designator: string;
    dateLocal: string;
    originIcao?: string | undefined;
    requestId?: string | undefined;
  },
) => Promise<DesignatorSearchResult>;

/**
 * The increment 7 helper with the resolver stub named at the one location hint every Durable
 * Object call site uses (a hint counts only on the call that creates the object, so every call
 * passes it).
 */
export const defaultResolver: Resolver = (env, input) =>
  resolveDesignator(env, input, {
    stubFor: (name) =>
      env.DESIGNATOR_RESOLVER.getByName(name, { locationHint: TRACKER_LOCATION_HINT }),
  });

export interface ResolveFlightContext {
  readonly env: Env;
  readonly db: DbOrTx;
  readonly user: AuthenticatedUser;
  /** `CF-Connecting-IP`; null under `wrangler dev` and in a test without the header. */
  readonly clientIp: string | null;
  readonly now: Date;
  readonly log: Logger;
  readonly requestId: string;
  readonly deadlineMs: number;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** The request's cap ledger, so a caller can release what this took on a later failure. */
  readonly ledger: CapLedger;
  /** Test seam; defaults to `defaultResolver`. */
  readonly resolve?: Resolver | undefined;
}

export type FlightResolution =
  | {
      readonly kind: 'resolved';
      readonly flightKey: FlightKey;
      readonly status: FlightStatus | null;
      /** `none`: the flight is over and no tracker exists (increment 7, ruling L9). */
      readonly tracker: 'seeded' | 'adopted' | 'none' | null;
      /** True when THIS request's resolution created the tracker. */
      readonly created: boolean;
      readonly cached: boolean;
    }
  | {
      readonly kind: 'not_found';
      /** The origin-local dates the adapter asked for (ruling O4): D, D-1, D+1 in the lookahead. */
      readonly triedDates: readonly string[];
    }
  | { readonly kind: 'cap_exceeded'; readonly slot: CapSlot }
  | { readonly kind: 'date_out_of_range'; readonly maxDaysAhead: number }
  | { readonly kind: 'unknown_origin' }
  | { readonly kind: 'overloaded'; readonly retryAfterSeconds: number }
  | { readonly kind: 'provider_unavailable'; readonly reason: string | undefined }
  | { readonly kind: 'provider_error'; readonly reason: string | undefined }
  | { readonly kind: 'timeout' };

/** Whether `dateLocal` is beyond the plan's lookahead from `now` (the adapter's own rule). */
export function beyondLookahead(dateLocal: string, now: Date, maxDaysAhead: number): boolean {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const target = Date.parse(`${dateLocal}T00:00:00Z`);
  return (target - today) / DAY_MS > maxDaysAhead;
}

function shiftDate(dateLocal: string, days: number): string {
  return new Date(Date.parse(`${dateLocal}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The dates a user search asks the provider for, in the adapter's order: the date as given, the
 * day before and the day after (the plus or minus one day retry of a person-supplied date), each
 * only while inside the lookahead, exactly as the adapter skips one beyond it.
 */
export function userSearchDates(dateLocal: string, now: Date, maxDaysAhead: number): string[] {
  return [dateLocal, shiftDate(dateLocal, -1), shiftDate(dateLocal, 1)].filter(
    (date) => !beyondLookahead(date, now, maxDaysAhead),
  );
}

type ResolvedOrMiss = Exclude<FlightResolution, { kind: 'not_found' }> | { readonly kind: 'miss' };

function fromResolveResponse(
  response: ResolveResponseV1,
  cachedAnswer: boolean,
): ResolvedOrMiss | null {
  if (response.outcome === 'not_found') {
    return { kind: 'miss' };
  }
  if (response.outcome !== 'resolved' || response.flightKey === undefined) {
    return null;
  }
  const cached = cachedAnswer || response.cached;
  return {
    kind: 'resolved',
    flightKey: response.flightKey,
    status: response.status ?? null,
    tracker: response.tracker ?? null,
    created: !cached && response.created === true && response.tracker === 'seeded',
    cached,
  };
}

/** The creation slots this caller pays: always its own, and the IP's for an anonymous account. */
async function creationSlots(ctx: ResolveFlightContext): Promise<CapSlot[]> {
  const slots = [userCap('instances_created', ctx.user.id, ctx.now)];
  if (ctx.user.isAnonymous) {
    const ip = normaliseClientIp(ctx.clientIp);
    if (ip === null) {
      // Cloudflare always sets CF-Connecting-IP; only `wrangler dev` and a bare test lack it.
      ctx.log.warn('anonymous_cap_without_client_ip');
    } else {
      const secret = requireSecret(ctx.env.IP_SALT_SECRET, 'IP_SALT_SECRET');
      const day = ctx.now.toISOString().slice(0, 10);
      slots.push(ipTrackerCreationCap(await saltedIpSubject(secret, ip, day), ctx.now));
    }
  }
  return slots;
}

export async function resolveFlight(
  ctx: ResolveFlightContext,
  query: FlightQuery,
): Promise<FlightResolution> {
  const maxDaysAhead = providerSettings(ctx.env).adbPlan.maxDaysAhead;
  if (beyondLookahead(query.dateLocal, ctx.now, maxDaysAhead)) {
    return { kind: 'date_out_of_range', maxDaysAhead };
  }
  const notFound: FlightResolution = {
    kind: 'not_found',
    triedDates: userSearchDates(query.dateLocal, ctx.now, maxDaysAhead),
  };
  let originIcao: string | undefined;
  if (query.origin !== undefined) {
    const resolved = await resolveOriginIcao(ctx.db, query.origin);
    if (resolved === null) {
      return { kind: 'unknown_origin' };
    }
    originIcao = resolved;
  }
  const designator = normalizeDesignator(query.designator);

  // 2. KV, the resolver's own publication.
  try {
    const cachedValue: unknown = await ctx.env.CACHE.get(
      searchKvKey(designator, query.dateLocal),
      'json',
    );
    const parsed = ResolveResponseSchema.safeParse(cachedValue);
    if (parsed.success) {
      const answer = fromResolveResponse(parsed.data, true);
      const keyOrigin =
        answer?.kind === 'resolved' ? parseFlightKey(answer.flightKey).originIcao : undefined;
      if (answer !== null && (originIcao === undefined || keyOrigin === originIcao)) {
        return answer.kind === 'miss' ? notFound : answer;
      }
    }
  } catch (error) {
    ctx.log.warn('flight_search_kv_read_failed', errorFields(error));
  }

  // 3. A known designator mapping supplies the origin for the existing-tracker probe.
  const known = await lookupDesignator(ctx.db, designator, query.dateLocal, originIcao);
  originIcao ??= known?.originIcao;

  // 4. The resolver. Slots are reserved only when the flight looks new.
  const slots = known === null ? await creationSlots(ctx) : [];
  for (const slot of slots) {
    const refused = await ctx.ledger.take(slot);
    if (refused !== null) {
      for (const taken of slots) {
        await ctx.ledger.release(taken.cap);
      }
      return { kind: 'cap_exceeded', slot: refused };
    }
  }
  const releaseCreation = async (): Promise<void> => {
    for (const slot of slots) {
      await ctx.ledger.release(slot.cap);
    }
  };

  let result: DesignatorSearchResult;
  try {
    const outcome = await withDeadline(
      (ctx.resolve ?? defaultResolver)(ctx.env, {
        designator,
        dateLocal: query.dateLocal,
        originIcao,
        requestId: ctx.requestId,
      }),
      ctx.deadlineMs,
      { waitUntil: ctx.waitUntil },
    );
    if (outcome.kind === 'timeout') {
      // The resolver keeps working and publishes to KV; the slots stay taken, because a tracker
      // may be created after the deadline and the cap exists to bound exactly that spend.
      ctx.log.warn('flight_search_timeout', { designator, after_ms: outcome.afterMs });
      return { kind: 'timeout' };
    }
    result = outcome.value;
  } catch (error) {
    await releaseCreation();
    throw error;
  }

  if (result.outcome === 'overloaded') {
    await releaseCreation();
    return { kind: 'overloaded', retryAfterSeconds: result.retryAfterSeconds };
  }
  if (result.outcome === 'denied') {
    await releaseCreation();
    return { kind: 'provider_unavailable', reason: result.reason };
  }
  if (result.outcome === 'error') {
    await releaseCreation();
    return { kind: 'provider_error', reason: result.reason };
  }
  const answer = fromResolveResponse(result, false);
  if (answer === null || answer.kind !== 'resolved') {
    await releaseCreation();
    return answer === null || answer.kind === 'miss' ? notFound : answer;
  }
  if (!answer.created) {
    await releaseCreation();
  } else if (slots.length === 0) {
    // A creation where an adoption was expected: charged after the fact, never refused (the
    // tracker exists either way).
    for (const slot of await creationSlots(ctx)) {
      if (!(await takeCap(ctx.db, slot))) {
        ctx.log.info('flight_creation_over_cap', { cap: slot.cap });
      }
    }
  }
  if (answer.tracker !== 'none') {
    // First sight: the registry row and the designator mapping, best effort (a failure only costs
    // the next search its shortcut).
    try {
      const instanceId = await ensureInstanceRegistered(ctx.db, answer.flightKey);
      await recordDesignator(
        ctx.db,
        designator,
        answer.flightKey,
        instanceId,
        answer.status ?? undefined,
      );
    } catch (error) {
      ctx.log.warn('flight_designator_record_failed', errorFields(error));
    }
  }
  return answer;
}
