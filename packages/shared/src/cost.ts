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

/**
 * The priced operations of provider `P`. Distributes over a union, so
 * `ProviderOperation<'aeroapi' | 'adsb_lol'>` is both providers' operations and
 * `ProviderOperation<ProviderId>` is every operation there is.
 */
export type ProviderOperation<P extends ProviderId> = P extends ProviderId
  ? keyof (typeof LIST_PRICE_USD_MICROS)[P] & string
  : never;
export type AnyProviderOperation = ProviderOperation<ProviderId>;

/**
 * The `operation` argument of the cost helpers. When the provider is known at compile time the
 * operation must be one of its priced operations; when it is a run-time `ProviderId` (a value
 * off the wire) any string is accepted and the table check throws `UnknownOperationError`.
 */
export type OperationOf<P extends ProviderId> = ProviderId extends P
  ? string
  : ProviderOperation<P>;

export class UnknownOperationError extends Error {
  override readonly name = 'UnknownOperationError';

  constructor(provider: ProviderId, operation: string) {
    super(`No price entry for ${provider}.${operation}; add it to LIST_PRICE_USD_MICROS first`);
  }
}

function priceOf(provider: ProviderId, operation: string): number {
  const table: Readonly<Record<string, number>> = LIST_PRICE_USD_MICROS[provider];
  if (!Object.prototype.hasOwnProperty.call(table, operation)) {
    throw new UnknownOperationError(provider, operation);
  }
  return table[operation] ?? 0;
}

/** List price of one call in USD micros. Throws for an operation that is not in the table. */
export function listPriceUsdMicros<P extends ProviderId>(
  provider: P,
  operation: OperationOf<P>,
): number {
  return priceOf(provider, operation);
}

/** Provider-native units one call consumes: AeroAPI result sets, AeroDataBox units, else 0. */
export function costUnits<P extends ProviderId>(provider: P, operation: OperationOf<P>): number {
  const op: string = operation;
  priceOf(provider, op);
  if (provider === 'aeroapi') {
    return op === 'alert_manage' ? 0 : 1;
  }
  if (provider === 'aerodatabox') {
    return ADB_UNITS[op as AeroDataBoxOperation];
  }
  return 0;
}

/**
 * Poll-equivalents: the budget currency. One PE is one AeroAPI status poll at list price, so
 * every other operation is its list price divided by that. The plan's table (alert delivery 4,
 * schedules 4, position 2, ADB status 0.1, ADB alert item 0.05, ADS-B 0) falls out of the
 * price table instead of being typed a second time.
 */
export function pollEquivalents<P extends ProviderId>(
  provider: P,
  operation: OperationOf<P>,
): number {
  return priceOf(provider, operation) / AEROAPI_STATUS_PRICE_USD_MICROS;
}

/** Estimated cost of a call in USD micros given the units it actually consumed. */
export function estimateCostUsdMicros<P extends ProviderId>(
  provider: P,
  operation: OperationOf<P>,
  units: number = costUnits(provider, operation),
): number {
  const price = priceOf(provider, operation);
  if (provider === 'aeroapi') {
    return price * units;
  }
  if (provider === 'aerodatabox') {
    return units * ADB_UNIT_PRICE_USD_MICROS;
  }
  return 0;
}
