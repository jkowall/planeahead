/**
 * `/v1/airports` (increment 18, rulings B7 to B9): airport boards and the route search, served
 * from the per-airport bucket cache (`src/boards/read.ts`: KV first, `AirportState` on a miss),
 * never from a provider call of their own.
 *
 *   GET /v1/airports/{code}/board?direction=departures|arrivals&from=&to=&airline=
 *   GET /v1/airports/{origin}/flights/to/{destination}?date=YYYY-MM-DD
 *
 * Both need a user session (`requireScope('user')`; anonymous accounts included), take `BOARD_RL`
 * by user and by client IP, and answer UI-shaped rows with the buckets' `fetchedAt`, `stale`,
 * `partial` and coverage, and an ETag (`If-None-Match` answers 304). The airport is resolved in
 * the Worker (ruling B2): an unknown code is 404 `airport_not_found` and never reaches an object.
 * An airport AeroDataBox covers neither live nor by schedule is 404 `board_not_covered`; a range
 * or date beyond the plan's lookahead, or ended too long ago to be fetched, is 422
 * `date_out_of_range` (the designator search's answer); nothing readable is 503
 * `board_unavailable`.
 *
 * The board: an anonymous account may open only an airport of its live subscriptions (403
 * `board_requires_account`). `from` and `to` are instants (`Z` or an offset), at most 12 hours
 * apart; without them the window starts an hour before now, rounded down to 5 minutes, and runs
 * 12 hours. Rows are kept by the home leg's scheduled time in `[from, to)`.
 *
 * The route search: open to anonymous accounts within the `route_searches` caps (403
 * `cap_exceeded`; a search that answers no flights because nothing could be read gives its slots
 * back). It reads the origin's two buckets of the origin-local date and keeps the departures
 * whose arrival leg is the destination, grouped as on the board. `GET /v1/flights/search` stays
 * the designator search. Adding a flight from either list is the existing `POST /v1/flights` with
 * the row's `add` (designator, origin-local date, origin).
 *
 * Licence posture (ruling B9; R3 D11, plan section 10 item 3): boards and route results stay OUT
 * of share pages, public API tokens and MCP until AeroDataBox confirms in writing that they are
 * End Use. Nothing outside these two session-only routes may serve board rows, and no response
 * here may be stored by a shared cache (`Cache-Control: private, no-cache`).
 */

import { Hono, type Context } from 'hono';
import type { BoardAirport } from '@planeahead/db';
import {
  BOARD_DEFAULT_LOOKBACK_MS,
  BOARD_DEFAULT_STEP_MS,
  BOARD_DIRECTIONS,
  BOARD_MAX_RANGE_MS,
  DO_CALL_DEADLINE_MS,
  IATA_CARRIER_RE,
  ICAO_CARRIER_RE,
  IsoDateSchema,
  RPC_SCHEMA_VERSION,
  boardBucketAt,
  boardBucketsOfDate,
  nextBoardBucketStart,
  utcMsToLocalMinute,
  type AirportBoardResponse,
  type BoardAirportView,
  type BoardBucketResponseV1,
  type BoardCallTrigger,
  type RouteSearchResponse,
} from '@planeahead/shared';
import * as z from 'zod';
import { authRuntime } from '../auth/runtime';
import { boardRateLimits, routeSearchSlots, subscribedAtAirport } from '../boards/access';
import { resolveBoardAirportCached } from '../boards/airport-ref';
import { readBoardBucket } from '../boards/read';
import {
  boardEtag,
  boardViewRow,
  combineBuckets,
  etagMatches,
  filterGroups,
  groupCodeshares,
} from '../boards/view';
import type { AppBindings } from '../env';
import { CapLedger, capExceededBody } from '../lib/caps';
import { withDeadline } from '../lib/deadline';
import { beyondLookahead } from '../lib/flight-search';
import { queryValue, validate } from '../lib/validate';
import { currentUser, requireFreshSession, requireScope } from '../middleware/auth';
import { clientIp, type LimiterSelector } from '../middleware/rate-limit';
import { errorFields } from '../observability/log';
import { providerSettings } from '../providers/config';

export interface AirportRoutesOptions {
  /** The Worker's clock, in ms; the bucket and lookahead arithmetic read nothing else. */
  readonly now?: (() => number) | undefined;
  /** Replaces the `BOARD_RL` binding. */
  readonly limiter?: LimiterSelector | undefined;
  /** The deadline on each bucket read; `DO_CALL_DEADLINE_MS` (8 s) by default. */
  readonly deadlineMs?: number | undefined;
}

const CarrierCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => IATA_CARRIER_RE.test(value) || ICAO_CARRIER_RE.test(value), {
    message: 'airline must be a 2-character IATA or 3-character ICAO carrier code',
  });

const InstantInputSchema = z.iso.datetime({ offset: true });

export const AirportBoardQuerySchema = z
  .object({
    direction: queryValue(z.enum(BOARD_DIRECTIONS)).optional(),
    from: queryValue(InstantInputSchema).optional(),
    to: queryValue(InstantInputSchema).optional(),
    airline: queryValue(CarrierCodeSchema).optional(),
  })
  .superRefine((query, ctx) => {
    if (query.from === undefined || query.to === undefined) {
      return;
    }
    const span = Date.parse(query.to) - Date.parse(query.from);
    if (span <= 0) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must be after from' });
    } else if (span > BOARD_MAX_RANGE_MS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'the range is at most 12 hours' });
    }
  });

export const RouteSearchQuerySchema = z.object({ date: queryValue(IsoDateSchema) });

export interface BoardTimeWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * The window a board request shows. Given both ends, as given; given one, 12 hours from it; given
 * neither, from an hour before now rounded down to 5 minutes (so the window, and the ETag with
 * it, moves once per step), for 12 hours.
 */
export function boardTimeWindow(
  query: { readonly from?: string | undefined; readonly to?: string | undefined },
  nowMs: number,
): BoardTimeWindow {
  if (query.from !== undefined) {
    const fromMs = Date.parse(query.from);
    return {
      fromMs,
      toMs: query.to === undefined ? fromMs + BOARD_MAX_RANGE_MS : Date.parse(query.to),
    };
  }
  if (query.to !== undefined) {
    const toMs = Date.parse(query.to);
    return { fromMs: toMs - BOARD_MAX_RANGE_MS, toMs };
  }
  const start = nowMs - BOARD_DEFAULT_LOOKBACK_MS;
  const fromMs =
    start - (((start % BOARD_DEFAULT_STEP_MS) + BOARD_DEFAULT_STEP_MS) % BOARD_DEFAULT_STEP_MS);
  return { fromMs, toMs: fromMs + BOARD_MAX_RANGE_MS };
}

type Ctx = Context<AppBindings>;

function errorBody<Code extends string>(c: Ctx, error: Code, message: string) {
  return { error, message, requestId: c.var.requestId };
}

/** The buckets (airport-local starts) a window touches: one to three (a DST day's 11-hour one). */
export function bucketsCovering(window: BoardTimeWindow, tz: string): string[] {
  const first = boardBucketAt(window.fromMs, tz);
  const last = boardBucketAt(window.toMs - 1, tz);
  const buckets: string[] = [];
  for (let bucket = first; bucket !== null && buckets.length < 4;) {
    buckets.push(bucket);
    if (bucket === last) {
      break;
    }
    bucket = nextBoardBucketStart(bucket);
  }
  return last === null ? [] : buckets;
}

interface BucketReads {
  readonly answers: BoardBucketResponseV1[];
  /** Every bucket read ran past the deadline: the answer is 504, not 503. */
  readonly allTimedOut: boolean;
}

/**
 * The buckets, read in parallel, each under the route's deadline (a read that outlives it goes
 * on in `waitUntil`, so its refresh still lands in KV for the next request). A bucket whose read
 * failed or timed out counts as `unavailable`, so the other buckets are still served.
 */
async function readBuckets(
  c: Ctx,
  airport: BoardAirport,
  buckets: readonly string[],
  trigger: BoardCallTrigger,
  nowMs: number,
  options: AirportRoutesOptions,
): Promise<BucketReads> {
  const { log } = authRuntime(c);
  const waitUntil = (promise: Promise<unknown>): void => {
    c.executionCtx.waitUntil(promise);
  };
  let timedOut = 0;
  const answers = await Promise.all(
    buckets.map(async (bucketStartLocal): Promise<BoardBucketResponseV1> => {
      const unavailable = (reason: string): BoardBucketResponseV1 => ({
        rpcVersion: RPC_SCHEMA_VERSION,
        airportIcao: airport.icao,
        bucketStartLocal,
        state: 'unavailable',
        coverage: 'unknown',
        rows: [],
        stale: false,
        reason,
      });
      const request = {
        rpcVersion: RPC_SCHEMA_VERSION,
        airportIcao: airport.icao,
        tz: airport.tz,
        bucketStartLocal,
        trigger,
        requestId: c.var.requestId,
      };
      try {
        const outcome = await withDeadline(
          readBoardBucket(c.env, request, nowMs, log),
          options.deadlineMs ?? DO_CALL_DEADLINE_MS,
          { waitUntil },
        );
        if (outcome.kind === 'timeout') {
          timedOut += 1;
          log.warn('board_bucket_timeout', {
            airport_icao: airport.icao,
            bucket: bucketStartLocal,
          });
          return unavailable('timeout');
        }
        return outcome.value;
      } catch (error) {
        log.error('board_bucket_failed', { airport_icao: airport.icao, ...errorFields(error) });
        return unavailable('read_failed');
      }
    }),
  );
  return { answers, allTimedOut: buckets.length > 0 && timedOut === buckets.length };
}

/** The client keeps its copy and revalidates every time; no shared cache may store one. */
const BOARD_CACHE_CONTROL = 'private, no-cache';

/** Seconds a client should wait after a 503 before asking again. */
const BOARD_RETRY_AFTER_SECONDS = 30;

function airportNotFound(c: Ctx, code: string) {
  const named = code.trim().toUpperCase().slice(0, 16);
  return c.json(errorBody(c, 'airport_not_found', `no airport has the code ${named}`), 404);
}

function dateOutOfRange(c: Ctx, maxDaysAhead: number) {
  return c.json(
    {
      ...errorBody(
        c,
        'date_out_of_range',
        `the date must be at most ${String(maxDaysAhead)} days ahead, and not long past`,
      ),
      maxDaysAhead,
    },
    422,
  );
}

/** The answer for buckets that gave nothing to show. */
function bucketFailure(
  c: Ctx,
  kind: 'not_covered' | 'unavailable' | 'out_of_range',
  allTimedOut: boolean,
  maxDaysAhead: number,
) {
  if (kind === 'not_covered') {
    return c.json(
      errorBody(c, 'board_not_covered', 'flight data does not cover this airport'),
      404,
    );
  }
  if (kind === 'out_of_range') {
    return dateOutOfRange(c, maxDaysAhead);
  }
  if (allTimedOut) {
    return c.json(errorBody(c, 'upstream_timeout', 'the board did not load in time; retry'), 504);
  }
  c.header('Retry-After', String(BOARD_RETRY_AFTER_SECONDS));
  return c.json(errorBody(c, 'board_unavailable', 'the board is temporarily unavailable'), 503);
}

/** 200 with the body and its ETag, or 304 when `If-None-Match` already names that tag. */
async function withEtag<Body extends AirportBoardResponse | RouteSearchResponse>(
  c: Ctx,
  body: Body,
) {
  const etag = await boardEtag(body);
  c.header('ETag', etag);
  c.header('Cache-Control', BOARD_CACHE_CONTROL);
  if (etagMatches(c.req.header('If-None-Match'), etag)) {
    return c.body(null, 304);
  }
  return c.json(body, 200);
}

/** The airport as the answer names it. */
function airportView(airport: BoardAirport): BoardAirportView {
  return { icao: airport.icao, iata: airport.iata, name: airport.name, tz: airport.tz };
}

const DIRECTION_ROWS = { departures: 'dep', arrivals: 'arr' } as const;

export function createAirportRoutes(options: AirportRoutesOptions = {}) {
  const limits = boardRateLimits(options.limiter);
  const clock = (): number => options.now?.() ?? Date.now();
  const resolve = (c: Ctx, code: string) =>
    resolveBoardAirportCached(c.env, code, {
      waitUntil: (promise) => {
        c.executionCtx.waitUntil(promise);
      },
    });

  return (
    new Hono<AppBindings>()
      // ---------------------------------------------------------------------------------------
      // The board.
      // ---------------------------------------------------------------------------------------
      .get(
        '/:code/board',
        requireScope('user'),
        ...limits,
        validate('query', AirportBoardQuerySchema),
        async (c) => {
          const user = currentUser(c.var.user);
          const query = c.req.valid('query');
          const nowMs = clock();
          const code = c.req.param('code');
          const airport = await resolve(c, code);
          if (airport === null) {
            return airportNotFound(c, code);
          }
          if (
            user.isAnonymous &&
            !(await subscribedAtAirport(authRuntime(c).db, user.id, airport.icao))
          ) {
            return c.json(
              errorBody(
                c,
                'board_requires_account',
                'sign in to open the board of an airport none of your flights uses',
              ),
              403,
            );
          }
          const maxDaysAhead = providerSettings(c.env).adbPlan.maxDaysAhead;
          const window = boardTimeWindow(query, nowMs);
          const fromLocal = utcMsToLocalMinute(window.fromMs, airport.tz);
          if (
            fromLocal !== null &&
            beyondLookahead(fromLocal.slice(0, 10), new Date(nowMs), maxDaysAhead)
          ) {
            return dateOutOfRange(c, maxDaysAhead);
          }
          const read = await readBuckets(
            c,
            airport,
            bucketsCovering(window, airport.tz),
            'board',
            nowMs,
            options,
          );
          const combined = combineBuckets(read.answers);
          if (combined.kind !== 'ok') {
            return bucketFailure(c, combined.kind, read.allTimedOut, maxDaysAhead);
          }
          const direction = query.direction ?? 'departures';
          const groups = filterGroups(groupCodeshares(combined.rows), {
            direction: DIRECTION_ROWS[direction],
            fromMs: window.fromMs,
            toMs: window.toMs,
            airline: query.airline,
          });
          const body: AirportBoardResponse = {
            airport: airportView(airport),
            direction,
            from: new Date(window.fromMs).toISOString(),
            to: new Date(window.toMs).toISOString(),
            ...(query.airline === undefined ? {} : { airline: query.airline }),
            coverage: combined.coverage,
            fetchedAt: combined.fetchedAt,
            stale: combined.stale,
            partial: combined.partial,
            rows: groups.map((group) => boardViewRow(group, airport.icao)),
          };
          return withEtag(c, body);
        },
      )

      // ---------------------------------------------------------------------------------------
      // The route search. It takes caps, so it never acts on a cached session cookie; the brake
      // comes first, so a flood is refused before it costs a session-row read.
      // ---------------------------------------------------------------------------------------
      .get(
        '/:origin/flights/to/:destination',
        requireScope('user'),
        ...limits,
        requireFreshSession(),
        validate('query', RouteSearchQuerySchema),
        async (c) => {
          const user = currentUser(c.var.user);
          const { date } = c.req.valid('query');
          const now = new Date(clock());
          const maxDaysAhead = providerSettings(c.env).adbPlan.maxDaysAhead;
          if (beyondLookahead(date, now, maxDaysAhead)) {
            return dateOutOfRange(c, maxDaysAhead);
          }
          const [originCode, destinationCode] = [c.req.param('origin'), c.req.param('destination')];
          const [origin, destination] = await Promise.all([
            resolve(c, originCode),
            resolve(c, destinationCode),
          ]);
          if (origin === null || destination === null) {
            return airportNotFound(c, origin === null ? originCode : destinationCode);
          }
          if (origin.icao === destination.icao) {
            return c.json(
              {
                ...errorBody(c, 'validation_failed', 'the request path is invalid'),
                issues: [
                  {
                    path: ['destination'],
                    message: 'the destination is the origin',
                    code: 'custom',
                  },
                ],
              },
              400,
            );
          }
          const { db, log } = authRuntime(c);
          const ledger = new CapLedger(db);
          for (const slot of await routeSearchSlots(c.env, user, clientIp(c), now, log)) {
            const refused = await ledger.take(slot);
            if (refused !== null) {
              await ledger.releaseAll();
              return c.json(capExceededBody(refused, c.var.requestId), 403);
            }
          }
          const read = await readBuckets(
            c,
            origin,
            boardBucketsOfDate(date) ?? [],
            'route_search',
            now.getTime(),
            options,
          );
          const combined = combineBuckets(read.answers);
          if (combined.kind !== 'ok') {
            // Nothing was shown, so the search is not charged.
            await ledger.releaseAll();
            return bucketFailure(c, combined.kind, read.allTimedOut, maxDaysAhead);
          }
          const departures = filterGroups(groupCodeshares(combined.rows), {
            direction: 'dep',
            fromMs: Number.NEGATIVE_INFINITY,
            toMs: Number.POSITIVE_INFINITY,
          });
          const flights = departures
            .filter((group) => group.primary.counterpart.icao === destination.icao)
            .map((group) => boardViewRow(group, origin.icao));
          const body: RouteSearchResponse = {
            origin: airportView(origin),
            destination: airportView(destination),
            date,
            coverage: combined.coverage,
            fetchedAt: combined.fetchedAt,
            stale: combined.stale,
            partial: combined.partial,
            flights,
          };
          return withEtag(c, body);
        },
      )
  );
}

export const airportRoutes = createAirportRoutes();
