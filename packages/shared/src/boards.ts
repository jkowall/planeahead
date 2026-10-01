import { z } from 'zod';
import { ICAO_AIRPORT_RE } from './airports';
import { isValidIsoDate } from './flight-key';
import { BoardRowSchema, IsoInstantSchema, tolerantEnum } from './flight-status';
import { localMinuteToUtcMs, utcMsToLocalMinute } from './local-time';
import type { BoardWindow } from './providers';
import { RPC_SCHEMA_VERSION } from './rpc';

/**
 * Airport boards (increment 18): the bucket arithmetic, R3 D5's freshness ladder (normative,
 * ruling B4), the degrade steps of the boards share (ruling B5), the KV keys, and the contract
 * between the Worker and `AirportState`. Pure: nothing here reads the wall clock.
 *
 * A bucket is 12 airport-local hours, 00:00 to 11:59 or 12:00 to 23:59 (R3 D3), named by its
 * local start (`2026-09-22T12:00`) and fetched with one FIDS call. Its instants come from the
 * airport's zone, so a bucket on a DST change day is 11 or 13 real hours long.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Hours of airport-local wall clock in one bucket. */
export const BOARD_BUCKET_HOURS = 12;

const BUCKET_START_RE = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T(00|12):00$/;
const LOCAL_MINUTE_RE = /^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}):([0-9]{2})$/;

/** Whether `value` names a bucket: `YYYY-MM-DDT00:00` or `YYYY-MM-DDT12:00` on a real date. */
export function isBoardBucketStart(value: string): boolean {
  const match = BUCKET_START_RE.exec(value);
  return match !== null && isValidIsoDate(match[1] ?? '');
}

/** The bucket holding an airport-local minute (`YYYY-MM-DDTHH:mm`), or null for a bad minute. */
export function boardBucketStartOf(localMinute: string): string | null {
  const match = LOCAL_MINUTE_RE.exec(localMinute);
  const date = match?.[1];
  if (match === null || date === undefined || !isValidIsoDate(date)) {
    return null;
  }
  const hour = Number(match[2]);
  if (hour > 23 || Number(match[3]) > 59) {
    return null;
  }
  return `${date}T${hour < BOARD_BUCKET_HOURS ? '00' : '12'}:00`;
}

/** The bucket holding an instant at an airport, or null for an unknown zone. */
export function boardBucketAt(utcMs: number, tz: string): string | null {
  const local = utcMsToLocalMinute(utcMs, tz);
  return local === null ? null : boardBucketStartOf(local);
}

/** The two buckets of an airport-local date, morning first. */
export function boardBucketsOfDate(dateLocal: string): [string, string] | null {
  return isValidIsoDate(dateLocal) ? [`${dateLocal}T00:00`, `${dateLocal}T12:00`] : null;
}

/** The bucket after `bucketStartLocal`. */
export function nextBoardBucketStart(bucketStartLocal: string): string | null {
  const match = BUCKET_START_RE.exec(bucketStartLocal);
  const date = match?.[1];
  if (match === null || date === undefined || !isValidIsoDate(date)) {
    return null;
  }
  if (match[2] === '00') {
    return `${date}T12:00`;
  }
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 24 * HOUR_MS).toISOString();
  return `${next.slice(0, 10)}T00:00`;
}

/** The FIDS window of a bucket: its first minute to its last (11:59 or 23:59), local time. */
export function boardBucketWindow(bucketStartLocal: string, tz: string): BoardWindow | null {
  const match = BUCKET_START_RE.exec(bucketStartLocal);
  if (match === null || !isBoardBucketStart(bucketStartLocal)) {
    return null;
  }
  const last = match[2] === '00' ? '11:59' : '23:59';
  return { from: bucketStartLocal, to: `${match[1] ?? ''}T${last}`, tz };
}

export interface BoardBucketBounds {
  /** The bucket's first instant. */
  readonly startMs: number;
  /** The next bucket's first instant: the bucket is `[startMs, endMs)`. */
  readonly endMs: number;
}

/** A bucket's instants in the airport's zone, or null for a bad bucket or zone. */
export function boardBucketBounds(bucketStartLocal: string, tz: string): BoardBucketBounds | null {
  const next = nextBoardBucketStart(bucketStartLocal);
  const startMs = localMinuteToUtcMs(bucketStartLocal, tz);
  const endMs = next === null ? null : localMinuteToUtcMs(next, tz);
  return startMs === null || endMs === null || endMs <= startMs ? null : { startMs, endMs };
}

/** Where a bucket sits relative to now: one row of R3 D5 each. */
export const BOARD_POSITIONS = ['current', 'near', 'ahead', 'far', 'just_ended', 'ended'] as const;
export type BoardPosition = (typeof BOARD_POSITIONS)[number];

export interface BoardLadderRung {
  /** How long a copy is served as fresh, from its `fetchedAt`. */
  readonly freshMs: number;
  /** How long a copy may be served stale while one refresh runs; null: until the purge. */
  readonly staleMs: number | null;
}

/**
 * R3 D5, normative (ruling B4). `current`: contains now, or starts within 3 h. `near`: starts
 * 3 h to 24 h ahead. `ahead`: 24 h to 72 h ahead. `far`: more than 72 h ahead. `just_ended`:
 * ended less than 3 h ago. `ended`: ended more than 3 h ago, never refreshed once it ended
 * more than 24 h ago, and served until its purge 48 h after it ended (Terms 5.5). A copy is also
 * purged 7 days after its fetch at the latest (ruling R4); only the `far` row feels it, for a
 * bucket starting more than 108 h after the fetch.
 */
export const BOARD_FRESHNESS_LADDER: Readonly<Record<BoardPosition, BoardLadderRung>> =
  Object.freeze({
    current: { freshMs: 5 * MINUTE_MS, staleMs: 15 * MINUTE_MS },
    near: { freshMs: 30 * MINUTE_MS, staleMs: 2 * HOUR_MS },
    ahead: { freshMs: 3 * HOUR_MS, staleMs: 12 * HOUR_MS },
    far: { freshMs: 12 * HOUR_MS, staleMs: 48 * HOUR_MS },
    just_ended: { freshMs: 15 * MINUTE_MS, staleMs: HOUR_MS },
    ended: { freshMs: 6 * HOUR_MS, staleMs: null },
  });

/** The position boundaries of R3 D5, as a bucket's lead (start minus now) or age (now minus end). */
export const BOARD_POSITION_BOUNDS = Object.freeze({
  currentLeadMs: 3 * HOUR_MS,
  nearLeadMs: 24 * HOUR_MS,
  aheadLeadMs: 72 * HOUR_MS,
  justEndedMs: 3 * HOUR_MS,
});

/** A bucket that ended this long ago is never refreshed again (R3 D5 row 6). */
export const BOARD_NO_REFRESH_AFTER_END_MS = 24 * HOUR_MS;

/**
 * A bucket's rows, and its KV copy, are deleted this long after it ends at the latest (Terms
 * 5.5); a copy fetched long before goes sooner (`BOARD_PURGE_AFTER_FETCH_MS`).
 */
export const BOARD_PURGE_AFTER_END_MS = 48 * HOUR_MS;

/**
 * A bucket's copy is also deleted this long after its fetch at the latest (ruling R4). Route
 * search reaches the plan's lookahead, and a copy fetched months ahead would otherwise live until
 * its date, against the Terms 5.5 duty to minimise volume and duration (7 days is also what the
 * Terms allow once a subscription ends, and Starter's term). For a 12-hour bucket it cuts in when
 * the bucket starts more than 108 h after the fetch.
 */
export const BOARD_PURGE_AFTER_FETCH_MS = 7 * 24 * HOUR_MS;

/** The bucket's position at `nowMs`. */
export function boardPosition(bounds: BoardBucketBounds, nowMs: number): BoardPosition {
  if (nowMs >= bounds.endMs) {
    return nowMs - bounds.endMs < BOARD_POSITION_BOUNDS.justEndedMs ? 'just_ended' : 'ended';
  }
  const lead = bounds.startMs - nowMs;
  if (lead <= BOARD_POSITION_BOUNDS.currentLeadMs) {
    return 'current';
  }
  if (lead <= BOARD_POSITION_BOUNDS.nearLeadMs) {
    return 'near';
  }
  return lead <= BOARD_POSITION_BOUNDS.aheadLeadMs ? 'ahead' : 'far';
}

/** Whether the bucket may still be fetched at `nowMs` (not once it ended more than 24 h ago). */
export function boardRefreshable(bounds: BoardBucketBounds, nowMs: number): boolean {
  return nowMs - bounds.endMs <= BOARD_NO_REFRESH_AFTER_END_MS;
}

/**
 * The latest the bucket's rows and KV copy may live, 48 h after it ends; a copy's own purge is
 * sooner when it was fetched long before (`boardFreshness`, ruling R4).
 */
export function boardPurgeAtMs(bounds: BoardBucketBounds): number {
  return bounds.endMs + BOARD_PURGE_AFTER_END_MS;
}

/**
 * The degrade steps of the boards share (ruling B5, R3 D9), highest first: from 70 percent of
 * the share spent every fresh and stale time doubles, from 90 percent it quadruples. At 100
 * percent (`BOARD_STALE_ONLY_SHARE`) the budget refuses board calls and the object serves stale
 * copies only: a copy that exists is served whatever its age, never an empty board instead.
 */
export const BOARD_DEGRADE_STEPS: readonly {
  readonly atShare: number;
  readonly multiplier: number;
}[] = Object.freeze([
  Object.freeze({ atShare: 0.9, multiplier: 4 }),
  Object.freeze({ atShare: 0.7, multiplier: 2 }),
]);

/** The share spent at which board calls stop and only stale copies are served. */
export const BOARD_STALE_ONLY_SHARE = 1;

/** The multiplier on every fresh and stale time for a share spent (0 to 1; unknown is 1). */
export function boardDegradeMultiplier(shareSpent: number | undefined): number {
  if (shareSpent === undefined || !Number.isFinite(shareSpent)) {
    return 1;
  }
  for (const step of BOARD_DEGRADE_STEPS) {
    if (shareSpent >= step.atShare) {
      return step.multiplier;
    }
  }
  return 1;
}

export interface BoardFreshness {
  readonly position: BoardPosition;
  readonly freshUntilMs: number;
  readonly staleUntilMs: number;
  readonly purgeAtMs: number;
}

/**
 * The limits of a copy fetched at `fetchedAtMs`: the rung of the bucket's position at that
 * moment, times the degrade multiplier of the boards share spent then. The purge is the sooner
 * of 48 h after the bucket ends and 7 days after the fetch (ruling R4); it is never degraded, and
 * neither limit passes it (the far row's quadrupled 192 h stale stops there, 168 h at most).
 */
export function boardFreshness(
  bounds: BoardBucketBounds,
  fetchedAtMs: number,
  shareSpent?: number,
): BoardFreshness {
  const position = boardPosition(bounds, fetchedAtMs);
  const rung = BOARD_FRESHNESS_LADDER[position];
  const multiplier = boardDegradeMultiplier(shareSpent);
  const purgeAtMs = Math.min(boardPurgeAtMs(bounds), fetchedAtMs + BOARD_PURGE_AFTER_FETCH_MS);
  const staleUntilMs = rung.staleMs === null ? purgeAtMs : fetchedAtMs + rung.staleMs * multiplier;
  return {
    position,
    freshUntilMs: Math.min(fetchedAtMs + rung.freshMs * multiplier, purgeAtMs),
    staleUntilMs: Math.min(staleUntilMs, purgeAtMs),
    purgeAtMs,
  };
}

// ---------------------------------------------------------------------------------------------
// KV (the `CACHE` namespace) and coverage.
// ---------------------------------------------------------------------------------------------

/** A bucket's KV copy: value the gzip of its rows' JSON array, metadata `BoardKvMetaV1`. */
export function boardKvKey(airportIcao: string, bucketStartLocal: string): string {
  return `board:v2:${airportIcao}:${bucketStartLocal}`;
}

/** The Worker's airport reference, keyed by the code a request named (4-letter ICAO or 3-letter IATA). */
export function airportRefKvKey(code: string): string {
  return `ref:airport:${code}`;
}

/** The edge cache on a Worker's KV read of a board (`cacheTtl`, the KV minimum). */
export const BOARD_KV_CACHE_TTL_SECONDS = 30;

/**
 * How long a coverage answer stands before the object asks again (ruling B6: once a day). It
 * lives in the AirportState object only (R15: the KV copy it used to have had no reader).
 */
export const ADB_COVERAGE_TTL_MS = 24 * HOUR_MS;

/** How long the Worker keeps an airport reference in KV. */
export const AIRPORT_REF_KV_TTL_SECONDS = 24 * 60 * 60;

/**
 * An airport's coverage (R3 F10, D6): `live` (live updates, so status and gates), `schedules_only`
 * (static schedules: the board says so and the screen shows a badge), `not_covered` (neither: no
 * FIDS call, the route answers 404 `board_not_covered`), `unknown` (the free check failed, so the
 * board is fetched anyway). A value a newer object adds parses as `unknown`.
 */
export const BOARD_COVERAGES = ['live', 'schedules_only', 'not_covered', 'unknown'] as const;
export const BoardCoverageSchema = tolerantEnum(BOARD_COVERAGES, 'unknown');
export type BoardCoverage = (typeof BOARD_COVERAGES)[number];

/** The KV metadata of a bucket's copy (at most 1,024 bytes); the rows are the value. */
export const BoardKvMetaV1 = z.looseObject({
  airportIcao: z.string().regex(ICAO_AIRPORT_RE),
  bucketStartLocal: z.string(),
  fetchedAt: IsoInstantSchema,
  freshUntil: IsoInstantSchema,
  staleUntil: IsoInstantSchema,
  coverage: BoardCoverageSchema,
  rowCount: z.int().nonnegative(),
});
export type BoardKvMetaV1 = z.infer<typeof BoardKvMetaV1>;

// ---------------------------------------------------------------------------------------------
// The AirportState RPC (`getBucket`). Versioned like `rpc.ts`: loose objects, `rpcVersion`.
// ---------------------------------------------------------------------------------------------

const rpcVersion = z.int().min(1).default(RPC_SCHEMA_VERSION);

/** The provider-call triggers a bucket fetch may carry (ruling B5's sub-cap covers both). */
export const BOARD_CALL_TRIGGERS = ['board', 'route_search'] as const;
export type BoardCallTrigger = (typeof BOARD_CALL_TRIGGERS)[number];

/**
 * One bucket of one airport. The Worker resolves the airport from Postgres (ruling B2: objects
 * never open Postgres, ADR 0007) and passes its ICAO code and IANA zone; the object is named by
 * the same ICAO code (`AIRPORT_STATE.getByName(airportIcao)`), which it checks.
 */
export const BoardBucketRequestV1 = z.looseObject({
  rpcVersion,
  airportIcao: z.string().regex(ICAO_AIRPORT_RE),
  tz: z.string().min(1),
  bucketStartLocal: z.string().refine(isBoardBucketStart, 'not a bucket start'),
  trigger: z.enum(BOARD_CALL_TRIGGERS),
  requestId: z.string().min(1).max(200).optional(),
});
export type BoardBucketRequestV1 = z.input<typeof BoardBucketRequestV1>;

/**
 * `ok`: rows from a copy (fresh, or `stale`). `not_covered`: coverage says neither schedules nor
 * live, so no call was made. `unavailable`: no copy exists and the fetch failed or was refused
 * (`reason`). `out_of_range`: the bucket ended more than 24 hours ago with no copy (never fetched
 * again), or lies beyond the plan's lookahead. A state a newer object adds parses as `unknown`.
 */
export const BOARD_BUCKET_STATES = [
  'ok',
  'not_covered',
  'unavailable',
  'out_of_range',
  'unknown',
] as const;
export const BoardBucketStateSchema = tolerantEnum(BOARD_BUCKET_STATES, 'unknown');

export const BoardBucketResponseV1 = z.looseObject({
  rpcVersion,
  airportIcao: z.string(),
  bucketStartLocal: z.string(),
  state: BoardBucketStateSchema,
  coverage: BoardCoverageSchema,
  /** Normalised rows, both directions, in the provider's order; never the provider's JSON. */
  rows: z.array(BoardRowSchema),
  fetchedAt: IsoInstantSchema.optional(),
  freshUntil: IsoInstantSchema.optional(),
  staleUntil: IsoInstantSchema.optional(),
  /** True when the copy is past `freshUntil`: one refresh runs, or none can (`reason`). */
  stale: z.boolean(),
  /** Why the state is `unavailable`, or why a stale copy was not refreshed. */
  reason: z.string().optional(),
});
export type BoardBucketResponseV1 = z.infer<typeof BoardBucketResponseV1>;
