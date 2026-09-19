import { z } from 'zod';

/**
 * Airports are identified by ICAO code because AeroAPI idents and aviationweather.gov are
 * ICAO-keyed and OurAirports lists fields that have no IATA code. Airports without an ICAO code
 * (a handful of OurAirports rows) get a synthetic `ZZ` + two-character code minted by
 * `packages/db`; `ZZ` is unassigned in the ICAO location indicator scheme (ZZZZ is the
 * "no indicator" placeholder in flight plans), so a synthetic code can never collide with a real
 * one. Data lives in `packages/db` seeds; this module only ships the reference shape.
 */

export const ICAO_AIRPORT_RE = /^[A-Z0-9]{4}$/;
export const IATA_AIRPORT_RE = /^[A-Z0-9]{3}$/;
export const SYNTHETIC_ICAO_RE = /^ZZ[A-Z0-9]{2}$/;

export function isSyntheticIcao(icao: string): boolean {
  return SYNTHETIC_ICAO_RE.test(icao);
}

export const AirportRefSchema = z
  .looseObject({
    icao: z.string().regex(ICAO_AIRPORT_RE, 'ICAO airport code must be 4 upper-case characters'),
    iata: z.string().regex(IATA_AIRPORT_RE, 'IATA airport code must be 3 characters').optional(),
    /** IANA time zone name, e.g. `America/New_York`. Required to derive the origin-local date. */
    tz: z.string().min(1).optional(),
    /** True only for `ZZxx` codes minted for airports that have no ICAO code. */
    synthetic: z.boolean().optional(),
  })
  .refine((airport) => isSyntheticIcao(airport.icao) === (airport.synthetic === true), {
    message: 'synthetic must be true exactly when the ICAO code is a ZZxx placeholder',
    path: ['synthetic'],
  });

export type AirportRef = z.infer<typeof AirportRefSchema>;
export type AirportRefInput = z.input<typeof AirportRefSchema>;

/**
 * True when `tz` is an IANA zone the runtime knows. Uses `Intl.DateTimeFormat` (Node 24, Workers
 * and Hermes all ship the full ICU zone table); no date library.
 */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
