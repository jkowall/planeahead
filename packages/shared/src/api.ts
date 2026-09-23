import { z } from 'zod';
import { IATA_AIRPORT_RE, ICAO_AIRPORT_RE } from './airports';
import { FlightKeySchema, parseDesignator } from './flight-key';
import { IsoDateSchema } from './flight-status';
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
