/**
 * Provider calls, budgets, alerts, webhooks, delay models, airport conditions and BTS
 * aggregates. Nothing here references users: `provider_calls` and `provider_call_daily` must
 * survive account deletion and are keyed by flight, never by person.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  FLIGHT_NUMBER_SQL_RE,
  IATA_AIRPORT_SQL_RE,
  ICAO_AIRPORT_SQL_RE,
  bytea,
  createdOnly,
  formatCheck,
  id,
  inList,
  instant,
  jsonbArrayOfCheck,
  timestamps,
} from './columns';
import { flightInstances } from './flights';

/** Mirrors PROVIDER_IDS in @planeahead/shared; a test asserts the lists agree. */
export const PROVIDERS = [
  'aeroapi',
  'aerodatabox',
  'adsb_lol',
  'adsb_fi',
  'airplanes_live',
  'aviationweather',
  'nws',
  'open_meteo',
  'faa_nas',
  'llm',
  'mock',
] as const;

/** Mirrors PROVIDER_CALL_TRIGGERS in @planeahead/shared. */
export const CALL_TRIGGERS = [
  'alarm',
  'provider_alert',
  'adb_alert',
  'user_search',
  'user_refresh',
  'reconcile',
  'backfill',
  'cron',
  'import',
  'manual',
] as const;

/** Mirrors PROVIDER_CALL_RESULTS in @planeahead/shared. */
export const CALL_RESULTS = ['ok', 'not_found', 'rate_limited', 'error'] as const;

/** Mirrors ALERT_EVENTS in @planeahead/shared; a test asserts the lists agree. */
export const ALERT_EVENTS = [
  'filed',
  'departure',
  'arrival',
  'cancelled',
  'diverted',
  'out',
  'off',
  'on',
  'in',
  'hold_start',
  'hold_end',
] as const;

/** One row per outbound provider call (including LLM extractions). Purged at 90 days. */
export const providerCalls = pgTable(
  'provider_calls',
  {
    id: id(),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    trigger: text('trigger').notNull(),
    result: text('result').notNull(),
    httpStatus: smallint('http_status'),
    durationMs: integer('duration_ms'),
    costUnits: integer('cost_units').notNull().default(0),
    costUsdMicros: integer('cost_usd_micros').notNull().default(0),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    flightInstanceId: uuid('flight_instance_id'),
    flightKey: text('flight_key'),
    requestId: text('request_id'),
    errorCode: text('error_code'),
    ...createdOnly(),
  },
  (t) => [
    index('provider_calls_created_at_brin_idx').using('brin', t.createdAt),
    index('provider_calls_flight_instance_id_created_at_idx').on(t.flightInstanceId, t.createdAt),
    index('provider_calls_provider_created_at_idx').on(t.provider, t.createdAt),
    check('provider_calls_provider_check', sql`${t.provider} in (${inList(PROVIDERS)})`),
    check('provider_calls_trigger_check', sql`${t.trigger} in (${inList(CALL_TRIGGERS)})`),
    check('provider_calls_result_check', sql`${t.result} in (${inList(CALL_RESULTS)})`),
  ],
);

/** Durable daily series rolled up from provider_calls and Analytics Engine by housekeeping. */
export const providerCallDaily = pgTable(
  'provider_call_daily',
  {
    id: id(),
    day: date('day', { mode: 'string' }).notNull(),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    result: text('result').notNull(),
    calls: integer('calls').notNull().default(0),
    costUnits: bigint('cost_units', { mode: 'number' }).notNull().default(0),
    costUsdMicros: bigint('cost_usd_micros', { mode: 'number' }).notNull().default(0),
    tokensIn: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokensOut: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('provider_call_daily_day_provider_operation_result_key').on(
      t.day,
      t.provider,
      t.operation,
      t.result,
    ),
    check('provider_call_daily_provider_check', sql`${t.provider} in (${inList(PROVIDERS)})`),
    check('provider_call_daily_result_check', sql`${t.result} in (${inList(CALL_RESULTS)})`),
  ],
);

/** Per-provider caps and the kill switch. One row per provider, edited by admins. */
export const providerBudgetConfig = pgTable(
  'provider_budget_config',
  {
    id: id(),
    provider: text('provider').notNull(),
    dailyCapUnits: integer('daily_cap_units').notNull(),
    dailySoftCapUnits: integer('daily_soft_cap_units'),
    perFlightSoftCapPe: integer('per_flight_soft_cap_pe'),
    perFlightHardCapPe: integer('per_flight_hard_cap_pe'),
    refreshSubBudgetUnits: integer('refresh_sub_budget_units'),
    killSwitch: boolean('kill_switch').notNull().default(false),
    updatedBy: text('updated_by'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('provider_budget_config_provider_key').on(t.provider),
    check('provider_budget_config_provider_check', sql`${t.provider} in (${inList(PROVIDERS)})`),
    check('provider_budget_config_daily_cap_units_check', sql`${t.dailyCapUnits} >= 0`),
  ],
);

/**
 * AeroAPI and AeroDataBox alert registrations per flight, for reconciliation and deletion.
 * `events` records the AlertEvent set the registration covers (cadence A2 and B register
 * different sets), so the reconcile cron can tell a live registration with the wrong set from
 * one that only needs its delivery count refreshed. Null means the set was not recorded.
 */
export const providerAlertRegistrations = pgTable(
  'provider_alert_registrations',
  {
    id: id(),
    provider: text('provider').notNull(),
    externalAlertId: text('external_alert_id').notNull(),
    flightInstanceId: uuid('flight_instance_id').notNull(),
    events: jsonb('events'),
    maxWeekly: integer('max_weekly'),
    deliveries: integer('deliveries').notNull().default(0),
    expectedBy: instant('expected_by'),
    registeredAt: instant('registered_at')
      .notNull()
      .default(sql`now()`),
    cancelledAt: instant('cancelled_at'),
    ...timestamps(),
  },
  (t) => [
    foreignKey({
      name: 'provider_alert_registrations_flight_instance_fk',
      columns: [t.flightInstanceId],
      foreignColumns: [flightInstances.id],
    }).onDelete('cascade'),
    uniqueIndex('provider_alert_registrations_provider_external_alert_id_key').on(
      t.provider,
      t.externalAlertId,
    ),
    index('provider_alert_registrations_flight_instance_id_idx').on(t.flightInstanceId),
    check(
      'provider_alert_registrations_provider_check',
      sql`${t.provider} in (${inList(PROVIDERS)})`,
    ),
    jsonbArrayOfCheck('provider_alert_registrations_events_check', t.events, ALERT_EVENTS),
  ],
);

/** Raw inbound webhook envelopes; the provider-events queue consumer marks them processed. */
export const providerWebhookEvents = pgTable(
  'provider_webhook_events',
  {
    id: id(),
    provider: text('provider').notNull(),
    externalId: text('external_id').notNull(),
    receivedAt: instant('received_at')
      .notNull()
      .default(sql`now()`),
    signatureValid: boolean('signature_valid').notNull(),
    payload: jsonb('payload').notNull(),
    flightInstanceId: uuid('flight_instance_id'),
    processedAt: instant('processed_at'),
    processingError: text('processing_error'),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('provider_webhook_events_provider_external_id_key').on(t.provider, t.externalId),
    index('provider_webhook_events_received_at_idx')
      .on(t.receivedAt)
      .where(sql`${t.processedAt} is null`),
    check('provider_webhook_events_provider_check', sql`${t.provider} in (${inList(PROVIDERS)})`),
  ],
);

export const delayPredictions = pgTable(
  'delay_predictions',
  {
    id: id(),
    flightInstanceId: uuid('flight_instance_id')
      .notNull()
      .references(() => flightInstances.id, { onDelete: 'cascade' }),
    modelVersion: text('model_version').notNull(),
    predictedAt: instant('predicted_at')
      .notNull()
      .default(sql`now()`),
    horizonMinutes: integer('horizon_minutes'),
    pDelay15: real('p_delay_15').notNull(),
    pDelay60: real('p_delay_60'),
    pCancel: real('p_cancel'),
    expectedDelayMinutes: real('expected_delay_minutes'),
    features: jsonb('features'),
    ...createdOnly(),
  },
  (t) => [
    index('delay_predictions_flight_instance_id_predicted_at_idx').on(
      t.flightInstanceId,
      t.predictedAt,
    ),
    check('delay_predictions_probabilities_check', sql`${t.pDelay15} between 0 and 1`),
  ],
);

/** Ground truth per flight once it finishes, joined to predictions for calibration. */
export const delayOutcomes = pgTable(
  'delay_outcomes',
  {
    id: id(),
    flightInstanceId: uuid('flight_instance_id')
      .notNull()
      .references(() => flightInstances.id, { onDelete: 'cascade' }),
    departureDelayMinutes: integer('departure_delay_minutes'),
    arrivalDelayMinutes: integer('arrival_delay_minutes'),
    cancelled: boolean('cancelled').notNull().default(false),
    diverted: boolean('diverted').notNull().default(false),
    resolvedAt: instant('resolved_at')
      .notNull()
      .default(sql`now()`),
    ...createdOnly(),
  },
  (t) => [uniqueIndex('delay_outcomes_flight_instance_id_key').on(t.flightInstanceId)],
);

export const WX_KINDS = ['metar', 'taf'] as const;

/** METAR and TAF observations keyed by ICAO; 90-day retention, BRIN on insertion order. */
export const airportWxObservations = pgTable(
  'airport_wx_observations',
  {
    id: id(),
    icao: text('icao').notNull(),
    kind: text('kind').notNull(),
    observedAt: instant('observed_at').notNull(),
    raw: text('raw').notNull(),
    parsed: jsonb('parsed'),
    source: text('source').notNull().default('aviationweather'),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('airport_wx_observations_icao_kind_observed_at_key').on(
      t.icao,
      t.kind,
      t.observedAt,
    ),
    index('airport_wx_observations_created_at_brin_idx').using('brin', t.createdAt),
    check('airport_wx_observations_kind_check', sql`${t.kind} in (${inList(WX_KINDS)})`),
    check('airport_wx_observations_source_check', sql`${t.source} in (${inList(PROVIDERS)})`),
    // The KV cache key is `wx:metar:{ICAO}`; one lower-case row would fork the namespace.
    formatCheck('airport_wx_observations_icao_check', t.icao, ICAO_AIRPORT_SQL_RE),
  ],
);

export const NAS_EVENT_KINDS = [
  'ground_stop',
  'ground_delay',
  'arrival_delay',
  'departure_delay',
  'closure',
  'deicing',
  'other',
] as const;

/** FAA NAS status events (ground stops, delay programs). IATA-keyed because the feed is. */
export const airportNasEvents = pgTable(
  'airport_nas_events',
  {
    id: id(),
    airportIata: text('airport_iata').notNull(),
    airportIcao: text('airport_icao'),
    kind: text('kind').notNull(),
    reason: text('reason'),
    startedAt: instant('started_at').notNull(),
    endedAt: instant('ended_at'),
    avgDelayMinutes: integer('avg_delay_minutes'),
    raw: jsonb('raw'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('airport_nas_events_airport_iata_kind_started_at_key').on(
      t.airportIata,
      t.kind,
      t.startedAt,
    ),
    index('airport_nas_events_airport_iata_started_at_idx').on(t.airportIata, t.startedAt),
    check('airport_nas_events_kind_check', sql`${t.kind} in (${inList(NAS_EVENT_KINDS)})`),
    formatCheck('airport_nas_events_airport_iata_check', t.airportIata, IATA_AIRPORT_SQL_RE),
    formatCheck('airport_nas_events_airport_icao_check', t.airportIcao, ICAO_AIRPORT_SQL_RE),
  ],
);

/** Point-in-time delay index per airport (from boards), the input to airport_delay_hourly. */
export const airportDelaySnapshots = pgTable(
  'airport_delay_snapshots',
  {
    id: id(),
    icao: text('icao').notNull(),
    capturedAt: instant('captured_at').notNull(),
    departuresTotal: integer('departures_total').notNull().default(0),
    departuresDelayed: integer('departures_delayed').notNull().default(0),
    arrivalsTotal: integer('arrivals_total').notNull().default(0),
    arrivalsDelayed: integer('arrivals_delayed').notNull().default(0),
    avgDepartureDelayMinutes: real('avg_departure_delay_minutes'),
    avgArrivalDelayMinutes: real('avg_arrival_delay_minutes'),
    source: text('source').notNull(),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('airport_delay_snapshots_icao_captured_at_key').on(t.icao, t.capturedAt),
    check('airport_delay_snapshots_source_check', sql`${t.source} in (${inList(PROVIDERS)})`),
    formatCheck('airport_delay_snapshots_icao_check', t.icao, ICAO_AIRPORT_SQL_RE),
  ],
);

export const airportDelayHourly = pgTable(
  'airport_delay_hourly',
  {
    id: id(),
    icao: text('icao').notNull(),
    hourStart: instant('hour_start').notNull(),
    departures: integer('departures').notNull().default(0),
    arrivals: integer('arrivals').notNull().default(0),
    departuresDelayed: integer('departures_delayed').notNull().default(0),
    arrivalsDelayed: integer('arrivals_delayed').notNull().default(0),
    cancellations: integer('cancellations').notNull().default(0),
    avgDepartureDelayMinutes: real('avg_departure_delay_minutes'),
    avgArrivalDelayMinutes: real('avg_arrival_delay_minutes'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('airport_delay_hourly_icao_hour_start_key').on(t.icao, t.hourStart),
    formatCheck('airport_delay_hourly_icao_check', t.icao, ICAO_AIRPORT_SQL_RE),
  ],
);

export const BTS_IMPORT_STATUSES = ['running', 'succeeded', 'failed'] as const;

/** One row per BTS On-Time Performance month import; the aggregate tables reference it. */
export const btsImportRuns = pgTable(
  'bts_import_runs',
  {
    id: id(),
    year: smallint('year').notNull(),
    month: smallint('month').notNull(),
    sourceUrl: text('source_url').notNull(),
    sourceSha256: bytea('source_sha256'),
    sourceBytes: bigint('source_bytes', { mode: 'number' }),
    rowsRead: integer('rows_read').notNull().default(0),
    rowsWritten: integer('rows_written').notNull().default(0),
    status: text('status').notNull().default('running'),
    startedAt: instant('started_at')
      .notNull()
      .default(sql`now()`),
    finishedAt: instant('finished_at'),
    error: text('error'),
    ...createdOnly(),
  },
  (t) => [
    index('bts_import_runs_year_month_idx').on(t.year, t.month),
    check('bts_import_runs_status_check', sql`${t.status} in (${inList(BTS_IMPORT_STATUSES)})`),
    check('bts_import_runs_month_check', sql`${t.month} between 1 and 12`),
  ],
);

/**
 * Marketing carrier + flight number + route per month with operating carrier: the observed
 * source for regional operator ranges and per-flight delay priors. BTS codes are the carrier's
 * unique two-letter code, not ICAO; the import maps them.
 */
export const btsCarrierFlightMonthly = pgTable(
  'bts_carrier_flight_monthly',
  {
    id: id(),
    year: smallint('year').notNull(),
    month: smallint('month').notNull(),
    marketingCarrier: text('marketing_carrier').notNull(),
    operatingCarrier: text('operating_carrier').notNull(),
    flightNumber: text('flight_number').notNull(),
    originIata: text('origin_iata').notNull(),
    destinationIata: text('destination_iata').notNull(),
    flights: integer('flights').notNull().default(0),
    delayed15: integer('delayed_15').notNull().default(0),
    cancelled: integer('cancelled').notNull().default(0),
    diverted: integer('diverted').notNull().default(0),
    avgDepartureDelayMinutes: real('avg_departure_delay_minutes'),
    avgArrivalDelayMinutes: real('avg_arrival_delay_minutes'),
    importRunId: uuid('import_run_id')
      .notNull()
      .references(() => btsImportRuns.id, { onDelete: 'cascade' }),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('bts_carrier_flight_monthly_key').on(
      t.year,
      t.month,
      t.marketingCarrier,
      t.operatingCarrier,
      t.flightNumber,
      t.originIata,
      t.destinationIata,
    ),
    index('bts_carrier_flight_monthly_marketing_lookup_idx').on(
      t.marketingCarrier,
      t.flightNumber,
      t.year,
      t.month,
    ),
    check('bts_carrier_flight_monthly_month_check', sql`${t.month} between 1 and 12`),
    formatCheck(
      'bts_carrier_flight_monthly_flight_number_check',
      t.flightNumber,
      FLIGHT_NUMBER_SQL_RE,
    ),
    formatCheck('bts_carrier_flight_monthly_origin_iata_check', t.originIata, IATA_AIRPORT_SQL_RE),
    formatCheck(
      'bts_carrier_flight_monthly_destination_iata_check',
      t.destinationIata,
      IATA_AIRPORT_SQL_RE,
    ),
  ],
);

export const btsRouteMonthly = pgTable(
  'bts_route_monthly',
  {
    id: id(),
    year: smallint('year').notNull(),
    month: smallint('month').notNull(),
    operatingCarrier: text('operating_carrier').notNull(),
    originIata: text('origin_iata').notNull(),
    destinationIata: text('destination_iata').notNull(),
    flights: integer('flights').notNull().default(0),
    delayed15: integer('delayed_15').notNull().default(0),
    cancelled: integer('cancelled').notNull().default(0),
    diverted: integer('diverted').notNull().default(0),
    avgDepartureDelayMinutes: real('avg_departure_delay_minutes'),
    avgArrivalDelayMinutes: real('avg_arrival_delay_minutes'),
    avgTaxiOutMinutes: real('avg_taxi_out_minutes'),
    avgTaxiInMinutes: real('avg_taxi_in_minutes'),
    importRunId: uuid('import_run_id')
      .notNull()
      .references(() => btsImportRuns.id, { onDelete: 'cascade' }),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('bts_route_monthly_key').on(
      t.year,
      t.month,
      t.operatingCarrier,
      t.originIata,
      t.destinationIata,
    ),
    check('bts_route_monthly_month_check', sql`${t.month} between 1 and 12`),
    formatCheck('bts_route_monthly_origin_iata_check', t.originIata, IATA_AIRPORT_SQL_RE),
    formatCheck('bts_route_monthly_destination_iata_check', t.destinationIata, IATA_AIRPORT_SQL_RE),
  ],
);

export const BTS_DIRECTIONS = ['dep', 'arr'] as const;

export const btsAirportHourly = pgTable(
  'bts_airport_hourly',
  {
    id: id(),
    year: smallint('year').notNull(),
    month: smallint('month').notNull(),
    airportIata: text('airport_iata').notNull(),
    hourLocal: smallint('hour_local').notNull(),
    direction: text('direction').notNull(),
    flights: integer('flights').notNull().default(0),
    delayed15: integer('delayed_15').notNull().default(0),
    cancelled: integer('cancelled').notNull().default(0),
    avgDelayMinutes: real('avg_delay_minutes'),
    importRunId: uuid('import_run_id')
      .notNull()
      .references(() => btsImportRuns.id, { onDelete: 'cascade' }),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('bts_airport_hourly_key').on(
      t.year,
      t.month,
      t.airportIata,
      t.hourLocal,
      t.direction,
    ),
    check('bts_airport_hourly_month_check', sql`${t.month} between 1 and 12`),
    check('bts_airport_hourly_hour_local_check', sql`${t.hourLocal} between 0 and 23`),
    check('bts_airport_hourly_direction_check', sql`${t.direction} in (${inList(BTS_DIRECTIONS)})`),
    formatCheck('bts_airport_hourly_airport_iata_check', t.airportIata, IATA_AIRPORT_SQL_RE),
  ],
);
