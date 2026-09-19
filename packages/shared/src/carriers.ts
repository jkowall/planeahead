import { z } from 'zod';

/**
 * Carriers are identified by ICAO code in every flight key. Provider payloads and user input
 * mostly carry IATA codes, so the boundary shape allows either and the helpers below resolve
 * IATA to ICAO through an injected table. The authoritative table is the OPTD-derived
 * `airlines` seed in `packages/db`; `CARRIER_IATA_TO_ICAO_FALLBACK` exists only so the mobile
 * app can build a probable designator offline. It is a fallback, not a source of truth.
 */

export const ICAO_CARRIER_RE = /^[A-Z]{3}$/;
/** Two alphanumerics with at least one letter (`AA`, `B6`, `9W`). */
export const IATA_CARRIER_RE = /^(?=[0-9]*[A-Z])[A-Z0-9]{2}$/;

export const CarrierRefSchema = z
  .looseObject({
    icao: z
      .string()
      .regex(ICAO_CARRIER_RE, 'ICAO airline code must be 3 upper-case letters')
      .optional(),
    iata: z.string().regex(IATA_CARRIER_RE, 'IATA airline code must be 2 characters').optional(),
  })
  .refine((carrier) => carrier.icao !== undefined || carrier.iata !== undefined, {
    message: 'a carrier reference needs an ICAO or an IATA code',
  });

export type CarrierRef = z.infer<typeof CarrierRefSchema>;

export type CarrierIataToIcaoTable = Readonly<Record<string, string>>;

/**
 * FALLBACK ONLY. Roughly the top 60 carriers by passengers plus the US regional operators the
 * flight-key hint table refers to. `packages/db` overrides this with the OPTD-derived seed.
 * Hand-checked against each carrier's published codes on 2026-09-19.
 */
export const CARRIER_IATA_TO_ICAO_FALLBACK: CarrierIataToIcaoTable = Object.freeze({
  // North America mainline
  AA: 'AAL',
  DL: 'DAL',
  UA: 'UAL',
  WN: 'SWA',
  B6: 'JBU',
  AS: 'ASA',
  NK: 'NKS',
  F9: 'FFT',
  G4: 'AAY',
  HA: 'HAL',
  SY: 'SCX',
  AC: 'ACA',
  WS: 'WJA',
  AM: 'AMX',
  // North America regional operators (marketing carrier resolution needs these)
  MQ: 'ENY',
  OO: 'SKW',
  OH: 'JIA',
  PT: 'PDT',
  '9E': 'EDV',
  YX: 'RPA',
  YV: 'ASH',
  G7: 'GJS',
  C5: 'UCA',
  ZW: 'AWI',
  QX: 'QXE',
  // Europe
  BA: 'BAW',
  VS: 'VIR',
  AF: 'AFR',
  KL: 'KLM',
  LH: 'DLH',
  LX: 'SWR',
  OS: 'AUS',
  SN: 'BEL',
  IB: 'IBE',
  VY: 'VLG',
  FR: 'RYR',
  U2: 'EZY',
  W6: 'WZZ',
  AZ: 'ITY',
  TP: 'TAP',
  SK: 'SAS',
  AY: 'FIN',
  DY: 'NAX',
  EI: 'EIN',
  LO: 'LOT',
  TK: 'THY',
  // Middle East and Africa
  EK: 'UAE',
  EY: 'ETD',
  QR: 'QTR',
  SV: 'SVA',
  MS: 'MSR',
  ET: 'ETH',
  SA: 'SAA',
  KQ: 'KQA',
  // Asia Pacific
  QF: 'QFA',
  NZ: 'ANZ',
  VA: 'VOZ',
  JQ: 'JST',
  SQ: 'SIA',
  CX: 'CPA',
  JL: 'JAL',
  NH: 'ANA',
  KE: 'KAL',
  OZ: 'AAR',
  CI: 'CAL',
  BR: 'EVA',
  TG: 'THA',
  MH: 'MAS',
  GA: 'GIA',
  CZ: 'CSN',
  CA: 'CCA',
  MU: 'CES',
  AI: 'AIC',
  '6E': 'IGO',
  // Latin America
  LA: 'LAN',
  AV: 'AVA',
  CM: 'CMP',
  AR: 'ARG',
  G3: 'GLO',
  AD: 'AZU',
});

/**
 * Resolves an IATA airline code to ICAO through `table`. The table is injected on purpose:
 * the API passes the database seed, the mobile app passes `CARRIER_IATA_TO_ICAO_FALLBACK`.
 * Returns `undefined` when the code is unknown; callers decide whether that is an error.
 */
export function carrierIcaoFromIata(
  iata: string,
  table: CarrierIataToIcaoTable,
): string | undefined {
  const code = iata.trim().toUpperCase();
  if (!IATA_CARRIER_RE.test(code)) {
    return undefined;
  }
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;
}

/** ICAO code of a carrier reference, resolving IATA through `table` when ICAO is absent. */
export function resolveCarrierIcao(
  carrier: CarrierRef,
  table: CarrierIataToIcaoTable,
): string | undefined {
  if (carrier.icao !== undefined) {
    return carrier.icao;
  }
  return carrier.iata === undefined ? undefined : carrierIcaoFromIata(carrier.iata, table);
}
