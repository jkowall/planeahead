import { ICAO_CARRIER_RE } from './carriers';
import { FlightKeyError, flightNumberToken, normalizeFlightNumber } from './flight-key';
import { tolerantEnum, type OperatorSource } from './flight-status';

/**
 * Operator resolution (ADR 0010). AeroDataBox never names an operating carrier: its `airline`
 * is "Airline owning the flight number" (the marketing carrier) and `codeshareStatus` is a
 * marker, not an identity. The only operator evidence it carries is the ATC `callSign`, which
 * its own coverage page rates "rare" before departure. `resolveOperator` turns that evidence
 * into the best-known OPERATING DESIGNATOR for the flight key (carrier and number together) and
 * records how it was decided, so the key can be reconciled later when AeroAPI's `operator_icao`
 * is available (the Phase 1 merge path). Pure: the caller looks up the regional hint
 * (`regionalOperatorHint`) and passes it in.
 *
 * The carrier and the number travel together because a key is `{operator}-{number}-...`: pairing
 * a callsign's carrier with the MARKETING number names a third, unrelated flight (`BA1512` flown
 * as `AAL100` would key as `AAL-1512-...`, which is American's own AA 1512), so a callsign
 * supplies both halves or neither (orchestrator ruling I3).
 */

/** AeroDataBox `CodeshareStatus` (direct-gateway OpenAPI 1.15.3.0). */
export const CODESHARE_STATUSES = ['Unknown', 'IsOperator', 'IsCodeshared'] as const;
export type CodeshareStatus = (typeof CODESHARE_STATUSES)[number];
/** A value AeroDataBox adds later parses as `Unknown`, which resolves to the marketing carrier. */
export const CodeshareStatusSchema = tolerantEnum(CODESHARE_STATUSES, 'Unknown');

export interface ResolveOperatorInput {
  /** ICAO code of the carrier that owns the flight number. */
  marketingIcao: string;
  /** The marketing flight number, normalised (`100`, `3456A`). */
  marketingNumber: string;
  codeshareStatus: CodeshareStatus;
  /** ATC callsign as the provider sends it (`AAL100`, `ENY 3456`); rare before departure. */
  callSign?: string | null | undefined;
  /** Probable operator from the regional hint table (`regionalOperatorHint`). */
  hint?: string | null | undefined;
}

export interface ResolvedOperator {
  operatingCarrierIcao: string;
  /**
   * The flight number that goes with `operatingCarrierIcao` in the key: the callsign's own number
   * when the operator came from a callsign (the callsign IS the operating designator), otherwise
   * the marketing number.
   */
  operatingFlightNumber: string;
  operatorSource: OperatorSource;
}

/** An airline callsign: a three-letter ICAO telephony designator followed by the flight digits. */
const AIRLINE_CALLSIGN_RE = /^([A-Z]{3})([0-9][0-9A-Z]*)$/;

/**
 * The ICAO prefix of an airline callsign (`AAL100`, `BAW12AB`), or undefined for a registration or
 * anything else. Evidence of the operating CARRIER only; `resolveOperator` keys by a callsign only
 * when `parseAirlineCallsign` also yields its number.
 */
export function callsignOperator(callSign: string | null | undefined): string | undefined {
  if (callSign === undefined || callSign === null) {
    return undefined;
  }
  return /^([A-Z]{3})[0-9]/.exec(callSign.replace(/\s+/g, '').toUpperCase())?.[1];
}

export interface AirlineCallsign {
  carrierIcao: string;
  /** Normalised like a key's number (`100`, `15L`): leading zeros dropped. */
  flightNumber: string;
}

/**
 * An airline callsign read as an operating designator: three letters, then a suffix that is a
 * flight number (1 to 4 digits, an optional letter). Undefined when the suffix is not a flight
 * number: alphanumeric ATC callsigns such as `BAW12AB` or `EZY83TL` carry the carrier but not the
 * flight, and half a designator is worse than none (see `resolveOperator`).
 */
export function parseAirlineCallsign(
  callSign: string | null | undefined,
): AirlineCallsign | undefined {
  if (callSign === undefined || callSign === null) {
    return undefined;
  }
  const match = AIRLINE_CALLSIGN_RE.exec(callSign.replace(/\s+/g, '').toUpperCase());
  const carrierIcao = match?.[1];
  const digits = match?.[2];
  if (carrierIcao === undefined || digits === undefined) {
    return undefined;
  }
  try {
    return { carrierIcao, flightNumber: flightNumberToken(normalizeFlightNumber(digits)) };
  } catch (error) {
    if (error instanceof FlightKeyError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The best-known operating designator and where it came from:
 *
 * - `IsOperator`: the marketing carrier flies it under the marketing number (`provider`).
 * - `Unknown`: nothing is known, so the marketing designator stands in (`marketing`).
 * - `IsCodeshared`: someone else flies it. The airline callsign's carrier AND number when the
 *   callsign parses as a designator (`callsign`: `BA1512` flown as `AAL100` is `AAL` `100`), else
 *   the regional hint's carrier with the marketing number (`hint`: regional flying keeps the
 *   number, `AA3456` flown as `ENY3456`), else the marketing designator (`marketing`), which then
 *   names a carrier known NOT to operate the flight and is exactly the case the merge path
 *   exists for. A callsign whose suffix is not a flight number (`BAW12AB`) is not used at all:
 *   its carrier with the marketing number could be someone else's real flight.
 */
export function resolveOperator(input: ResolveOperatorInput): ResolvedOperator {
  const marketing = {
    operatingCarrierIcao: input.marketingIcao,
    operatingFlightNumber: input.marketingNumber,
  };
  switch (input.codeshareStatus) {
    case 'IsOperator':
      return { ...marketing, operatorSource: 'provider' };
    case 'Unknown':
      return { ...marketing, operatorSource: 'marketing' };
    case 'IsCodeshared': {
      const callsign = parseAirlineCallsign(input.callSign);
      if (callsign !== undefined) {
        return {
          operatingCarrierIcao: callsign.carrierIcao,
          operatingFlightNumber: callsign.flightNumber,
          operatorSource: 'callsign',
        };
      }
      const hint = input.hint?.trim().toUpperCase();
      if (hint !== undefined && ICAO_CARRIER_RE.test(hint)) {
        return {
          operatingCarrierIcao: hint,
          operatingFlightNumber: input.marketingNumber,
          operatorSource: 'hint',
        };
      }
      return { ...marketing, operatorSource: 'marketing' };
    }
  }
}
