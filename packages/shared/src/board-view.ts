import { z } from 'zod';
import { BoardCoverageSchema } from './boards';
import { FlightStatusValueSchema, IsoDateSchema, IsoInstantSchema } from './flight-status';

/**
 * What the board and route-search routes answer (increment 18, rulings B7 and B8): UI-shaped
 * rows, never the provider's JSON. The Worker groups each bucket's codeshares (one row per
 * operated flight, R3 D7), filters after the cache (R3 D8) and sends the bucket's `fetchedAt`
 * ("as of", R3 D13), whether it is stale, and the airport's coverage (`schedules_only` is the
 * screen's badge). Every answer carries an `ETag`; `If-None-Match` with it answers 304.
 *
 *   GET /v1/airports/{code}/board?direction=&from=&to=&airline=      `AirportBoardResponse`
 *   GET /v1/airports/{origin}/flights/to/{destination}?date=         `RouteSearchResponse`
 */

/** The widest time range one board request may ask for. */
export const BOARD_MAX_RANGE_MS = 12 * 60 * 60_000;

/** With no `from`, a board starts this long before now, so recent movements stay on it. */
export const BOARD_DEFAULT_LOOKBACK_MS = 60 * 60_000;

/**
 * A default `from` is rounded down to this step, so the window (and with it the ETag) changes
 * once per step rather than on every request.
 */
export const BOARD_DEFAULT_STEP_MS = 5 * 60_000;

export const BOARD_DIRECTIONS = ['departures', 'arrivals'] as const;
export type BoardDirection = (typeof BOARD_DIRECTIONS)[number];

/** An airport as the routes name it: resolved from the `airports` table (ruling B2). */
export const BoardAirportViewSchema = z.looseObject({
  icao: z.string(),
  iata: z.string().nullable(),
  name: z.string(),
  /** IANA zone: the board's times are instants, shown in this zone. */
  tz: z.string(),
});
export type BoardAirportView = z.infer<typeof BoardAirportViewSchema>;

/** What `POST /v1/flights` takes to add the row's flight: designator, origin-local date, origin. */
export const BoardAddSchema = z.looseObject({
  number: z.string(),
  date: IsoDateSchema,
  origin: z.string(),
});

/**
 * One operated flight on a board. The HOME leg is the board's airport (the departure on a
 * departures board, the arrival on an arrivals board), the COUNTERPART the other end. Times are
 * UTC instants; `estimated` may be a gate or runway time (R3 F8), so label it cautiously.
 */
export const BoardViewRowSchema = z.looseObject({
  /** Stable for the flight within its bucket, for list keys. */
  id: z.string(),
  /** The primary designator: the operating carrier's own number when the provider marks one. */
  designator: z.string(),
  airlineIata: z.string().optional(),
  airlineIcao: z.string().optional(),
  /** The operating designator (ADR 0010), when an operator is known. */
  operatingCarrierIcao: z.string().optional(),
  operatingFlightNumber: z.string(),
  /** The other marketing designators of the same flight, e.g. `["BA1511", "IB4218"]`. */
  codeshares: z.array(z.string()),
  counterpart: z.looseObject({ icao: z.string(), iata: z.string().optional() }),
  status: FlightStatusValueSchema,
  scheduled: IsoInstantSchema,
  estimated: IsoInstantSchema.optional(),
  actual: IsoInstantSchema.optional(),
  terminal: z.string().optional(),
  gate: z.string().optional(),
  baggageClaim: z.string().optional(),
  counterpartScheduled: IsoInstantSchema.optional(),
  counterpartEstimated: IsoInstantSchema.optional(),
  counterpartActual: IsoInstantSchema.optional(),
  counterpartTerminal: z.string().optional(),
  counterpartGate: z.string().optional(),
  aircraftModel: z.string().optional(),
  /** Absent when the provider gave no origin-local date: such a row cannot be added. */
  add: BoardAddSchema.optional(),
});
export type BoardViewRow = z.infer<typeof BoardViewRowSchema>;

/** What both answers say about the buckets they were built from. */
const BoardFreshnessFields = {
  /**
   * `live`, `schedules_only` (show the badge: times are the published schedule, no live status)
   * or `unknown` (the free coverage check failed; the board was fetched anyway).
   */
  coverage: BoardCoverageSchema,
  /** The oldest `fetchedAt` of the buckets shown: the board is "as of" this instant. */
  fetchedAt: IsoInstantSchema.nullable(),
  /** True when a bucket shown is past its freshness: one refresh runs, or none can. */
  stale: z.boolean(),
  /** True when part of the range could not be read (no copy and the provider unavailable). */
  partial: z.boolean(),
};

/** `GET /v1/airports/{code}/board`. */
export const AirportBoardResponseSchema = z.looseObject({
  airport: BoardAirportViewSchema,
  direction: z.enum(BOARD_DIRECTIONS),
  /** The window shown, `[from, to)`, by the home leg's scheduled time. */
  from: IsoInstantSchema,
  to: IsoInstantSchema,
  /** The airline filter as given (operating or marketing carrier, IATA or ICAO). */
  airline: z.string().optional(),
  ...BoardFreshnessFields,
  rows: z.array(BoardViewRowSchema),
});
export type AirportBoardResponse = z.infer<typeof AirportBoardResponseSchema>;

/** `GET /v1/airports/{origin}/flights/to/{destination}?date=`. */
export const RouteSearchResponseSchema = z.looseObject({
  origin: BoardAirportViewSchema,
  destination: BoardAirportViewSchema,
  /** The origin-local date searched. */
  date: IsoDateSchema,
  ...BoardFreshnessFields,
  /** The origin's departures to the destination that date, codeshares grouped, by time. */
  flights: z.array(BoardViewRowSchema),
});
export type RouteSearchResponse = z.infer<typeof RouteSearchResponseSchema>;
