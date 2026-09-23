import { z } from 'zod';
import { IATA_AIRPORT_RE, ICAO_AIRPORT_RE } from './airports';
import type { ValidationIssue } from './errors';
import { FlightKeySchema, parseDesignator, type FlightKey } from './flight-key';
import { IsoDateSchema, type FlightStatus } from './flight-status';
import { NotificationOverridesSchema } from './rpc';

/**
 * Request contracts of the `/v1` flight routes (increment 8), shared so the mobile add-flight
 * sheet validates with the same rules the API does. The API wraps each in its validator helper
 * (apps/api/src/lib/validate.ts), which answers a failure with 400 `validation_failed`.
 */

/** A marketing designator as a person types it: `AA100`, `AA 100`, `AAL100`. */
export const DesignatorInputSchema = z
  .string()
  .trim()
  .min(3)
  .max(12)
  .refine(
    (value) => {
      try {
        parseDesignator(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'not a flight designator (expected a carrier code and a number, e.g. AA100)' },
  );

/** An origin airport as IATA (`JFK`) or ICAO (`KJFK`), upper-cased. */
export const OriginAirportInputSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => IATA_AIRPORT_RE.test(value) || ICAO_AIRPORT_RE.test(value), {
    message: 'origin must be a 3-character IATA or 4-character ICAO airport code',
  });

export const SUBSCRIPTION_CABINS = ['economy', 'premium_economy', 'business', 'first'] as const;

/** The subscription preferences `POST /v1/flights` accepts next to the flight. */
export const SubscriptionPrefsSchema = z.object({
  /**
   * Optional client-minted id (ADR 0006), so an offline add keeps one id through its retries.
   * Ignored when the user has a tombstoned subscription to the same flight: that row is restored
   * and its id is the one the response and the sync feed carry.
   */
  subscriptionId: z.uuid().optional(),
  label: z.string().trim().min(1).max(80).optional(),
  seat: z.string().trim().min(1).max(8).optional(),
  cabin: z.enum(SUBSCRIPTION_CABINS).optional(),
  muted: z.boolean().optional(),
  notificationOverrides: NotificationOverridesSchema.optional(),
});

/**
 * `POST /v1/flights`: exactly one way to name the flight, the canonical key a search returned or
 * the designator and origin-local date (resolved server-side, which may create the tracker).
 */
export const SubscribeFlightBodySchema = SubscriptionPrefsSchema.extend({
  flightKey: FlightKeySchema.optional(),
  number: DesignatorInputSchema.optional(),
  date: IsoDateSchema.optional(),
  origin: OriginAirportInputSchema.optional(),
})
  .strict()
  .superRefine((body, ctx) => {
    const byKey = body.flightKey !== undefined;
    const byNumber = body.number !== undefined || body.date !== undefined;
    if (byKey === byNumber) {
      ctx.addIssue({
        code: 'custom',
        message: 'name the flight with either flightKey or number and date',
        path: byKey ? ['flightKey'] : [],
      });
      return;
    }
    if (byNumber && (body.number === undefined || body.date === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'number and date go together',
        path: body.number === undefined ? ['number'] : ['date'],
      });
    }
  });
export type SubscribeFlightBody = z.infer<typeof SubscribeFlightBodySchema>;

// ---------------------------------------------------------------------------------------------
// Response shapes the typed client reads (increment 8, ruling O10). They live here, not in the
// API Worker, because the declaration `hcWithType` is emitted with (apps/api/dist/src/client.d.ts)
// may import only leaf types from this package: a type it had to import from the Worker would
// drag the server's type graph, and the Workers globals, into the mobile app's type check.
// ---------------------------------------------------------------------------------------------

/** The deployment an API answer came from (`GET /health`); the `ENVIRONMENT` var's values. */
export const DEPLOYMENT_ENVIRONMENTS = ['local', 'test', 'staging', 'production'] as const;
export type EnvironmentName = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

/** The 400 every `/v1` validator (and a malformed JSON body) answers. */
export interface ValidationFailedBody {
  readonly error: 'validation_failed';
  readonly message: string;
  readonly issues: ValidationIssue[];
  readonly requestId: string;
}

/** Where a route found the flight state it reports: the KV publication, the tracker, Postgres. */
export type SnapshotSource = 'kv' | 'tracker' | 'postgres';

/**
 * A flight as the flight routes report it next to a subscription: the detail route, the list,
 * subscribe, refresh (success, 504 `refresh_timeout` and 410 `flight_archived`) all use this one
 * shape, so the detail screen applies every answer the same way.
 */
export interface FlightView {
  readonly key: FlightKey;
  readonly phase: string;
  readonly version: number;
  readonly snapshot: FlightStatus | null;
  readonly source: SnapshotSource;
}

/**
 * A neighbouring date the client could offer after a 404 `flight_not_found`. Reserved (ruling O4):
 * the adapter already asked for the day before and the day after a user-supplied date, so Phase 0
 * always answers an empty list and the client names the dates in `triedDates` instead.
 */
export const FlightSearchSuggestionSchema = z.looseObject({
  date: IsoDateSchema,
  flightKey: FlightKeySchema.optional(),
});
export type FlightSearchSuggestion = z.infer<typeof FlightSearchSuggestionSchema>;

/**
 * `GET /v1/flights/search` and `POST /v1/flights { number, date }` when the provider knows no such
 * flight: 404 `flight_not_found` (distinct from the unknown-route `not_found`), with the
 * origin-local dates the adapter asked for (D, D-1, D+1 for a user search, the ones inside the
 * provider's lookahead) and the reserved `suggestions`.
 */
export interface FlightNotFoundBody {
  readonly error: 'flight_not_found';
  readonly message: string;
  readonly requestId: string;
  readonly triedDates: string[];
  readonly suggestions: FlightSearchSuggestion[];
}

/** `GET /v1/flights/search` 200. */
export interface FlightSearchResponse {
  readonly flightKey: FlightKey;
  readonly status: FlightStatus | null;
  /** `seeded` or `adopted`: a tracker holds the flight; `none`: it is over; null when unknown. */
  readonly tracker: 'seeded' | 'adopted' | 'none' | null;
  readonly cached: boolean;
}
