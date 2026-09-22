import { ICAO_CARRIER_RE } from './carriers';
import { tolerantEnum, type OperatorSource } from './flight-status';

/**
 * Operator resolution (ADR 0010). AeroDataBox never names an operating carrier: its `airline`
 * is "Airline owning the flight number" (the marketing carrier) and `codeshareStatus` is a
 * marker, not an identity. The only operator evidence it carries is the ATC `callSign`, which
 * its own coverage page rates "rare" before departure. `resolveOperator` turns that evidence
 * into the best-known operator for the flight key and records how it was decided, so the key
 * can be reconciled later when AeroAPI's `operator_icao` is available (the Phase 1 merge path).
 * Pure: the caller looks up the regional hint (`regionalOperatorHint`) and passes it in.
 */

/** AeroDataBox `CodeshareStatus` (direct-gateway OpenAPI 1.15.3.0). */
export const CODESHARE_STATUSES = ['Unknown', 'IsOperator', 'IsCodeshared'] as const;
export type CodeshareStatus = (typeof CODESHARE_STATUSES)[number];
/** A value AeroDataBox adds later parses as `Unknown`, which resolves to the marketing carrier. */
export const CodeshareStatusSchema = tolerantEnum(CODESHARE_STATUSES, 'Unknown');

export interface ResolveOperatorInput {
  /** ICAO code of the carrier that owns the flight number. */
  marketingIcao: string;
  /** The marketing flight number, normalised (`100`, `3456A`). Carried for the caller's logs. */
  marketingNumber: string;
  codeshareStatus: CodeshareStatus;
  /** ATC callsign as the provider sends it (`AAL100`, `ENY 3456`); rare before departure. */
  callSign?: string | null | undefined;
  /** Probable operator from the regional hint table (`regionalOperatorHint`). */
  hint?: string | null | undefined;
}

export interface ResolvedOperator {
  operatingCarrierIcao: string;
  operatorSource: OperatorSource;
}

/** An airline callsign: a three-letter ICAO telephony designator followed by the flight digits. */
const AIRLINE_CALLSIGN_RE = /^([A-Z]{3})[0-9]/;

/** The ICAO prefix of an airline callsign, or undefined for a registration or anything else. */
export function callsignOperator(callSign: string | null | undefined): string | undefined {
  if (callSign === undefined || callSign === null) {
    return undefined;
  }
  const match = AIRLINE_CALLSIGN_RE.exec(callSign.replace(/\s+/g, '').toUpperCase());
  return match?.[1];
}

/**
 * The best-known operating carrier and where it came from:
 *
 * - `IsOperator`: the marketing carrier flies it (`provider`).
 * - `Unknown`: nothing is known, so the marketing carrier stands in (`marketing`).
 * - `IsCodeshared`: someone else flies it. The callsign's three-letter prefix when there is an
 *   airline callsign (`callsign`), else the regional hint (`hint`), else the marketing carrier
 *   (`marketing`), which then names a carrier known NOT to operate the flight and is exactly the
 *   case the merge path exists for.
 */
export function resolveOperator(input: ResolveOperatorInput): ResolvedOperator {
  switch (input.codeshareStatus) {
    case 'IsOperator':
      return { operatingCarrierIcao: input.marketingIcao, operatorSource: 'provider' };
    case 'Unknown':
      return { operatingCarrierIcao: input.marketingIcao, operatorSource: 'marketing' };
    case 'IsCodeshared': {
      const fromCallsign = callsignOperator(input.callSign);
      if (fromCallsign !== undefined) {
        return { operatingCarrierIcao: fromCallsign, operatorSource: 'callsign' };
      }
      const hint = input.hint?.trim().toUpperCase();
      if (hint !== undefined && ICAO_CARRIER_RE.test(hint)) {
        return { operatingCarrierIcao: hint, operatorSource: 'hint' };
      }
      return { operatingCarrierIcao: input.marketingIcao, operatorSource: 'marketing' };
    }
  }
}
