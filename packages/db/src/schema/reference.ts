/**
 * Reference data: airports, airlines, regional operators, aircraft types and registrations,
 * currency rates. Seeded from committed derived files (seed/data) by the loaders in src/seed;
 * no user data, no PII, no foreign keys to users.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  AIRPORT_CODE_SQL_RE,
  IATA_AIRPORT_SQL_RE,
  IATA_CARRIER_SQL_RE,
  ICAO_AIRCRAFT_TYPE_SQL_RE,
  ICAO_AIRPORT_SQL_RE,
  ICAO_CARRIER_SQL_RE,
  ICAO_HEX_SQL_RE,
  formatCheck,
  id,
  inList,
  instant,
  literal,
  timestamps,
} from './columns';

export const AIRPORT_TYPES = [
  'balloonport',
  'closed',
  'heliport',
  'large_airport',
  'medium_airport',
  'seaplane_base',
  'small_airport',
] as const;
export const ICAO_SOURCES = ['icao_code', 'ident'] as const;
export const TZ_SOURCES = ['mwgg', 'override'] as const;

/**
 * OurAirports rows filtered to scheduled_service = yes or type in (large, medium). `icao` is
 * COALESCE(icao_code, ident) with `icao_source` recording which; an ident-derived pseudo-ICAO
 * does not resolve against AeroAPI. `tz` is NOT NULL because the flight key's date is
 * origin-local and the loader fails rather than guess.
 */
export const airports = pgTable(
  'airports',
  {
    id: id(),
    ourairportsId: integer('ourairports_id').notNull(),
    ident: text('ident').notNull(),
    icao: text('icao').notNull(),
    icaoSource: text('icao_source').notNull(),
    iata: text('iata'),
    gpsCode: text('gps_code'),
    localCode: text('local_code'),
    name: text('name').notNull(),
    type: text('type').notNull(),
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),
    elevationFt: integer('elevation_ft'),
    continent: text('continent'),
    isoCountry: text('iso_country').notNull(),
    isoRegion: text('iso_region'),
    municipality: text('municipality'),
    scheduledService: boolean('scheduled_service').notNull().default(false),
    tz: text('tz').notNull(),
    tzSource: text('tz_source').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('airports_icao_key').on(t.icao),
    // A unique constraint (not an index) because flight_instances' composite foreign keys
    // reference it and drizzle-kit emits foreign keys before indexes.
    unique('airports_id_icao_key').on(t.id, t.icao),
    unique('airports_id_icao_tz_key').on(t.id, t.icao, t.tz),
    uniqueIndex('airports_ident_key').on(t.ident),
    uniqueIndex('airports_ourairports_id_key').on(t.ourairportsId),
    uniqueIndex('airports_iata_key')
      .on(t.iata)
      .where(sql`${t.iata} is not null`),
    index('airports_iso_country_idx').on(t.isoCountry),
    check('airports_type_check', sql`${t.type} in (${inList(AIRPORT_TYPES)})`),
    check('airports_icao_source_check', sql`${t.icaoSource} in (${inList(ICAO_SOURCES)})`),
    check('airports_tz_source_check', sql`${t.tzSource} in (${inList(TZ_SOURCES)})`),
    // A real ICAO code is four characters. An ident-derived pseudo code (OurAirports idents such
    // as ID-0004 or 03N) is kept as-is so the airport exists for display and search; a code that
    // is not four characters cannot be a flight origin or destination until a synthetic ZZxx
    // code is assigned (open decision in schema-review.md section 16, counts pinned by a test).
    check(
      'airports_icao_format_check',
      sql`(${t.icaoSource} = 'icao_code' and ${t.icao} ~ ${literal(ICAO_AIRPORT_SQL_RE)}) or (${t.icaoSource} = 'ident' and ${t.icao} ~ ${literal(AIRPORT_CODE_SQL_RE)})`,
    ),
    formatCheck('airports_iata_check', t.iata, IATA_AIRPORT_SQL_RE),
    check(
      'airports_latitude_check',
      sql`${t.latitude} between -90 and 90 and ${t.longitude} between -180 and 180`,
    ),
  ],
);

/** Curated per-airport operational data (terminal map, typical security wait). Hand-edited. */
export const airportProfiles = pgTable(
  'airport_profiles',
  {
    id: id(),
    airportId: uuid('airport_id')
      .notNull()
      .references(() => airports.id, { onDelete: 'cascade' }),
    terminals: jsonb('terminals')
      .notNull()
      .default(sql`'[]'::jsonb`),
    securityWaitMinutesTypical: smallint('security_wait_minutes_typical'),
    checkinCutoffMinutesDomestic: smallint('checkin_cutoff_minutes_domestic'),
    checkinCutoffMinutesInternational: smallint('checkin_cutoff_minutes_international'),
    transitNotes: text('transit_notes'),
    source: text('source'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('airport_profiles_airport_id_key').on(t.airportId)],
);

export const AIRLINE_ALLIANCES = ['oneworld', 'skyteam', 'star_alliance'] as const;
export const AIRLINE_ALLIANCE_STATUSES = ['member', 'affiliate', 'former', 'future'] as const;

/**
 * vradarserver standing-data airlines.csv is the spine (CC0); OPTD supplies alliance and validity
 * for the ICAO codes it knows. `icao` is unique; the same IATA code is reused across carriers,
 * so `iata` is a plain index.
 */
export const airlines = pgTable(
  'airlines',
  {
    id: id(),
    icao: text('icao').notNull(),
    iata: text('iata'),
    vrsCode: text('vrs_code').notNull(),
    name: text('name').notNull(),
    positioningFlightPattern: text('positioning_flight_pattern'),
    charterFlightPattern: text('charter_flight_pattern'),
    alliance: text('alliance'),
    allianceStatus: text('alliance_status'),
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    optdPk: text('optd_pk'),
    checkinUrlTemplate: text('checkin_url_template'),
    logoR2Key: text('logo_r2_key'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('airlines_icao_key').on(t.icao),
    uniqueIndex('airlines_vrs_code_key').on(t.vrsCode),
    index('airlines_iata_idx').on(t.iata),
    check('airlines_icao_format_check', sql`${t.icao} ~ ${literal(ICAO_CARRIER_SQL_RE)}`),
    formatCheck('airlines_iata_check', t.iata, IATA_CARRIER_SQL_RE),
    check(
      'airlines_alliance_check',
      sql`${t.alliance} is null or ${t.alliance} in (${inList(AIRLINE_ALLIANCES)})`,
    ),
    check(
      'airlines_alliance_status_check',
      sql`${t.allianceStatus} is null or ${t.allianceStatus} in (${inList(AIRLINE_ALLIANCE_STATUSES)})`,
    ),
  ],
);

export const REGIONAL_OPERATOR_CONFIDENCES = ['hint', 'observed'] as const;

/**
 * Marketing carrier flight-number block to probable operating carrier. A display hint only: the
 * DesignatorResolver's provider answer decides the flight key. Seeded from
 * `@planeahead/shared` regional-operators.seed.json with confidence `hint`; a BTS-derived
 * loader adds `observed` rows with validity dates and counts later.
 */
export const regionalOperators = pgTable(
  'regional_operators',
  {
    id: id(),
    marketingIata: text('marketing_iata').notNull(),
    numberFrom: integer('number_from').notNull(),
    numberTo: integer('number_to').notNull(),
    operatingIcao: text('operating_icao').notNull(),
    confidence: text('confidence').notNull(),
    observationCount: integer('observation_count').notNull().default(0),
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    source: text('source').notNull(),
    sourceConfidence: text('source_confidence'),
    sourceAsOf: date('source_as_of', { mode: 'string' }),
    note: text('note'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('regional_operators_block_key').on(t.marketingIata, t.numberFrom, t.numberTo),
    index('regional_operators_marketing_iata_idx').on(t.marketingIata),
    check(
      'regional_operators_confidence_check',
      sql`${t.confidence} in (${inList(REGIONAL_OPERATOR_CONFIDENCES)})`,
    ),
    check(
      'regional_operators_range_check',
      sql`${t.numberFrom} >= 1 and ${t.numberTo} <= 9999 and ${t.numberFrom} <= ${t.numberTo}`,
    ),
    check(
      'regional_operators_operating_icao_check',
      sql`${t.operatingIcao} ~ ${literal(ICAO_CARRIER_SQL_RE)}`,
    ),
    formatCheck('regional_operators_marketing_iata_check', t.marketingIata, IATA_CARRIER_SQL_RE),
  ],
);

export const WAKE_TURBULENCE_CATEGORIES = ['L', 'M', 'H', 'J', 'L/M', 'M/H'] as const;
export const WAKE_SOURCES = ['vrs', 'coltjd45', 'manual'] as const;

/** ICAO Doc 8643 designators from vradarserver model-type CSVs, J patched from ColtJD45. */
export const aircraftTypes = pgTable(
  'aircraft_types',
  {
    id: id(),
    icao: text('icao').notNull(),
    manufacturer: text('manufacturer'),
    model: text('model').notNull(),
    /** VRS `Engines`: usually a count, but also `C` (coupled) and blank; kept as text. */
    engines: text('engines'),
    engineTypeCode: text('engine_type_code'),
    enginePlacementCode: text('engine_placement_code'),
    speciesCode: text('species_code'),
    wakeTurbulence: text('wake_turbulence'),
    wakeSource: text('wake_source'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('aircraft_types_icao_key').on(t.icao),
    formatCheck('aircraft_types_icao_check', t.icao, ICAO_AIRCRAFT_TYPE_SQL_RE),
    check(
      'aircraft_types_wake_turbulence_check',
      sql`${t.wakeTurbulence} is null or ${t.wakeTurbulence} in (${inList(WAKE_TURBULENCE_CATEGORIES)})`,
    ),
    check(
      'aircraft_types_wake_source_check',
      sql`${t.wakeSource} is null or ${t.wakeSource} in (${inList(WAKE_SOURCES)})`,
    ),
  ],
);

/**
 * Airframes: registration and Mode S hex with validity ranges (registrations move between
 * airframes). Empty in Phase 0; OpenSky was ruled out as a source until its licence is read.
 */
export const aircraft = pgTable(
  'aircraft',
  {
    id: id(),
    registration: text('registration').notNull(),
    icaoHex: text('icao_hex').notNull(),
    aircraftTypeIcao: text('aircraft_type_icao'),
    operatorIcao: text('operator_icao'),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    validTo: date('valid_to', { mode: 'string' }),
    source: text('source'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('aircraft_registration_valid_from_key').on(t.registration, t.validFrom),
    uniqueIndex('aircraft_icao_hex_valid_from_key').on(t.icaoHex, t.validFrom),
    check('aircraft_icao_hex_check', sql`${t.icaoHex} ~ ${literal(ICAO_HEX_SQL_RE)}`),
    formatCheck('aircraft_operator_icao_check', t.operatorIcao, ICAO_CARRIER_SQL_RE),
    formatCheck('aircraft_aircraft_type_icao_check', t.aircraftTypeIcao, ICAO_AIRCRAFT_TYPE_SQL_RE),
  ],
);

/** Daily FX rates for displaying fare and fee amounts; one row per pair per day. */
export const currencyRates = pgTable(
  'currency_rates',
  {
    id: id(),
    base: text('base').notNull(),
    quote: text('quote').notNull(),
    rate: numeric('rate', { precision: 18, scale: 8 }).notNull(),
    asOf: date('as_of', { mode: 'string' }).notNull(),
    source: text('source').notNull(),
    fetchedAt: instant('fetched_at')
      .notNull()
      .default(sql`now()`),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('currency_rates_pair_as_of_key').on(t.base, t.quote, t.asOf),
    check(
      'currency_rates_codes_check',
      sql`${t.base} ~ '^[A-Z]{3}$' and ${t.quote} ~ '^[A-Z]{3}$'`,
    ),
  ],
);
