import type { ProviderId } from './flight-status';

/**
 * List prices per provider operation in USD micros (1 USD = 1,000,000 micros), from the
 * Phase 0 plan section 7. Prices are inputs to budgeting and cost attribution, never to
 * billing; the invoice comes from the provider.
 *
 * AeroAPI: https://www.flightaware.com/commercial/aeroapi/ (per result set).
 * AeroDataBox: https://aerodatabox.com/pricing/ (units; Growth plan $99 for 400,000 units,
 * which is 247.5 micros per unit, rounded up to 250 as the plan does).
 * Community ADS-B feeds, aviationweather.gov, NWS, Open-Meteo and the FAA NAS status are free
 * but every call is still counted. `llm` is priced per token by the extraction pipeline, not
 * per call, so its entry is zero here.
 */

export const AEROAPI_STATUS_PRICE_USD_MICROS = 5_000;
export const ADB_UNIT_PRICE_USD_MICROS = 250;

export const AEROAPI_OPERATIONS = [
  'flight_by_ident',
  'flight_by_id',
  'position',
  'track',
  'schedules',
  'airport_flights',
  'alert_delivery',
  'alert_manage',
] as const;
export type AeroApiOperation = (typeof AEROAPI_OPERATIONS)[number];

export const AERODATABOX_OPERATIONS = ['flight_status', 'fids', 'airport', 'alert_item'] as const;
export type AeroDataBoxOperation = (typeof AERODATABOX_OPERATIONS)[number];

/** AeroDataBox units per call by operation (tier 2 = 2 units, tier 1 = 1 unit, alert item = 1). */
export const ADB_UNITS: Readonly<Record<AeroDataBoxOperation, number>> = Object.freeze({
  flight_status: 2,
  fids: 2,
  airport: 1,
  alert_item: 1,
});

export const LIST_PRICE_USD_MICROS = {
  aeroapi: {
    flight_by_ident: 5_000,
    flight_by_id: 5_000,
    position: 10_000,
    track: 12_000,
    schedules: 20_000,
    airport_flights: 20_000,
    alert_delivery: 20_000,
    alert_manage: 0,
  },
  aerodatabox: {
    flight_status: ADB_UNITS.flight_status * ADB_UNIT_PRICE_USD_MICROS,
    fids: ADB_UNITS.fids * ADB_UNIT_PRICE_USD_MICROS,
    airport: ADB_UNITS.airport * ADB_UNIT_PRICE_USD_MICROS,
    alert_item: ADB_UNITS.alert_item * ADB_UNIT_PRICE_USD_MICROS,
  },
  adsb_lol: { positions: 0 },
  adsb_fi: { positions: 0 },
  airplanes_live: { positions: 0 },
  aviationweather: { metar: 0, taf: 0 },
  nws: { alerts: 0, forecast: 0 },
  open_meteo: { forecast: 0 },
  faa_nas: { status: 0 },
  llm: { completion: 0 },
  mock: { flight_status: 0, fids: 0, alert_delivery: 0, alert_manage: 0, positions: 0 },
} as const satisfies Record<ProviderId, Readonly<Record<string, number>>>;

export type ProviderOperation<P extends ProviderId = ProviderId> =
  keyof (typeof LIST_PRICE_USD_MICROS)[P] & string;

export class UnknownOperationError extends Error {
  override readonly name = 'UnknownOperationError';

  constructor(provider: ProviderId, operation: string) {
    super(`No price entry for ${provider}.${operation}; add it to LIST_PRICE_USD_MICROS first`);
  }
}

function priceTable(provider: ProviderId): Readonly<Record<string, number>> {
  return LIST_PRICE_USD_MICROS[provider];
}

/** List price of one call in USD micros. Throws for an operation that is not in the table. */
export function listPriceUsdMicros(provider: ProviderId, operation: string): number {
  const table = priceTable(provider);
  if (!Object.prototype.hasOwnProperty.call(table, operation)) {
    throw new UnknownOperationError(provider, operation);
  }
  return table[operation] ?? 0;
}

/** Provider-native units one call consumes: AeroAPI result sets, AeroDataBox units, else 0. */
export function costUnits(provider: ProviderId, operation: string): number {
  listPriceUsdMicros(provider, operation);
  if (provider === 'aeroapi') {
    return operation === 'alert_manage' ? 0 : 1;
  }
  if (provider === 'aerodatabox') {
    return ADB_UNITS[operation as AeroDataBoxOperation];
  }
  return 0;
}

/**
 * Poll-equivalents: the budget currency. One PE is one AeroAPI status poll at list price, so
 * every other operation is its list price divided by that. The plan's table (alert delivery 4,
 * schedules 4, position 2, ADB status 0.1, ADB alert item 0.05, ADS-B 0) falls out of the
 * price table instead of being typed a second time.
 */
export function pollEquivalents(provider: ProviderId, operation: string): number {
  return listPriceUsdMicros(provider, operation) / AEROAPI_STATUS_PRICE_USD_MICROS;
}

/** Estimated cost of a call in USD micros given the units it actually consumed. */
export function estimateCostUsdMicros(
  provider: ProviderId,
  operation: string,
  units: number = costUnits(provider, operation),
): number {
  if (provider === 'aeroapi') {
    return listPriceUsdMicros(provider, operation) * units;
  }
  if (provider === 'aerodatabox') {
    listPriceUsdMicros(provider, operation);
    return units * ADB_UNIT_PRICE_USD_MICROS;
  }
  listPriceUsdMicros(provider, operation);
  return 0;
}
