/**
 * Flight core. `flight_instances` is the registry of every flight the system has ever tracked
 * (Durable Objects cannot be enumerated, so the reconcile cron reads this table). The persist
 * queue consumer is the only writer of `flight_instances` and `flight_events` (ADR 0007).
 *
 * The natural key (ADR 0003) is operating carrier ICAO + flight number + origin-local scheduled
 * date + origin ICAO, with `leg_seq` for same-day number reuse. `flight_key` is a STORED
 * generated column with a unique index. The expression is FROZEN: drizzle-kit 0.31 drops and
 * recreates a changed generated column and does not recreate dependent indexes (drizzle-orm
 * issue 4929). It is written with `extract`/`lpad` rather than `date::text` because the text
 * cast of a date depends on `DateStyle` and Postgres rejects it as not immutable.
 *
 * `origin_icao`, `origin_airport_id` and `origin_tz` (and the destination pair) describe one
 * airport and are derived from a single `airports` lookup (`resolveAirportEndpoint` in
 * src/queries/airports.ts), never from separate provider fields. The composite foreign key
 * `(origin_airport_id, origin_icao) -> airports (id, icao)` makes a mismatch impossible to
 * store, and `origin_tz` must be present whenever the airport is known.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  FLIGHT_NUMBER_SQL_RE,
  IATA_CARRIER_SQL_RE,
  ICAO_AIRCRAFT_TYPE_SQL_RE,
  ICAO_AIRPORT_SQL_RE,
  ICAO_CARRIER_SQL_RE,
  ICAO_HEX_SQL_RE,
  createdOnly,
  formatCheck,
  id,
  inList,
  instant,
  literal,
  timestamps,
  xid8,
} from './columns';
import { airports } from './reference';

/** Mirrors FLIGHT_STATUS_VALUES in @planeahead/shared; a test asserts the lists agree. */
export const FLIGHT_STATUSES = [
  'scheduled',
  'boarding',
  'departed',
  'en_route',
  'landed',
  'arrived',
  'cancelled',
  'diverted',
  'unknown',
] as const;

export const TRACKING_STATES = [
  'pending',
  'tracking',
  'airborne',
  'landed',
  'finished',
  'archived',
  'superseded',
] as const;
export const ACTIVE_TRACKING_STATES = ['pending', 'tracking', 'airborne', 'landed'] as const;
/** Every state that is not active: a row here never gets a new FlightTracker lifetime (L9). */
export const TERMINAL_TRACKING_STATES = TRACKING_STATES.filter(
  (state) => !(ACTIVE_TRACKING_STATES as readonly string[]).includes(state),
);
export const REFRESH_CADENCES = ['literal', 'A1', 'A2', 'B'] as const;
export const SUPERSEDE_REASONS = ['key_drift', 'provider_merge', 'manual'] as const;
/** Mirrors FlightStatus.operatorSource in @planeahead/shared (increment 6). */
export const OPERATOR_SOURCES = ['provider', 'callsign', 'hint', 'marketing'] as const;

/**
 * The frozen flight_key expression. Equivalent to
 * `carrier-number-YYYY-MM-DD-origin[-L<leg_seq>]` and matches FLIGHT_KEY_RE in shared.
 */
export const FLIGHT_KEY_EXPRESSION = sql`operating_carrier_icao || '-' || flight_number || '-' || lpad(extract(year from scheduled_departure_date)::text, 4, '0') || '-' || lpad(extract(month from scheduled_departure_date)::text, 2, '0') || '-' || lpad(extract(day from scheduled_departure_date)::text, 2, '0') || '-' || origin_icao || CASE WHEN leg_seq > 1 THEN '-L' || leg_seq::text ELSE '' END`;

export const flightInstances = pgTable(
  'flight_instances',
  {
    id: id(),
    // natural key
    operatingCarrierIcao: text('operating_carrier_icao').notNull(),
    flightNumber: text('flight_number').notNull(),
    scheduledDepartureDate: date('scheduled_departure_date', { mode: 'string' }).notNull(),
    originIcao: text('origin_icao').notNull(),
    legSeq: smallint('leg_seq').notNull().default(1),
    flightKey: text('flight_key').notNull().generatedAlwaysAs(FLIGHT_KEY_EXPRESSION),
    // airports
    originAirportId: uuid('origin_airport_id'),
    originTz: text('origin_tz'),
    destinationIcao: text('destination_icao'),
    destinationAirportId: uuid('destination_airport_id'),
    divertedToIcao: text('diverted_to_icao'),
    // status and OOOI (all instants, timestamptz)
    status: text('status').notNull().default('scheduled'),
    scheduledOut: instant('scheduled_out'),
    estimatedOut: instant('estimated_out'),
    actualOut: instant('actual_out'),
    scheduledOff: instant('scheduled_off'),
    estimatedOff: instant('estimated_off'),
    actualOff: instant('actual_off'),
    scheduledOn: instant('scheduled_on'),
    estimatedOn: instant('estimated_on'),
    actualOn: instant('actual_on'),
    scheduledIn: instant('scheduled_in'),
    estimatedIn: instant('estimated_in'),
    actualIn: instant('actual_in'),
    // ground details
    originTerminal: text('origin_terminal'),
    originGate: text('origin_gate'),
    destinationTerminal: text('destination_terminal'),
    destinationGate: text('destination_gate'),
    baggageClaim: text('baggage_claim'),
    // aircraft
    aircraftTypeIcao: text('aircraft_type_icao'),
    registration: text('registration'),
    icaoHex: text('icao_hex'),
    inboundFlightInstanceId: uuid('inbound_flight_instance_id'),
    // provider references
    aeroapiFaFlightId: text('aeroapi_fa_flight_id'),
    aerodataboxRef: text('aerodatabox_ref'),
    // tracking
    trackingState: text('tracking_state').notNull().default('pending'),
    refreshCadence: text('refresh_cadence'),
    nextRefreshAt: instant('next_refresh_at'),
    lastRefreshedAt: instant('last_refreshed_at'),
    providerCallCount: integer('provider_call_count').notNull().default(0),
    providerCostUnits: integer('provider_cost_units').notNull().default(0),
    subscriberCount: integer('subscriber_count').notNull().default(0),
    doSchemaVersion: smallint('do_schema_version'),
    /**
     * Monotonic snapshot version set by the FlightTracker; the persist consumer's upsert only
     * applies a row whose version is greater than the stored one (Queues deliver at least once
     * and out of order, increment 7).
     */
    version: integer('version').notNull().default(0),
    /**
     * The FlightTracker LIFETIME this row was last written from (`created_at_ms` of the object,
     * the `@{epochMs}` of its outbox origin; migration 0002, increment 7 ruling L9). The persist
     * consumer ignores instance and event rows from an older lifetime and refuses a newer one
     * for a row whose tracking state is terminal: a finished flight never gets a second
     * lifetime. Null on rows written before the column existed.
     */
    doLifetimeEpochMs: bigint('do_lifetime_epoch_ms', { mode: 'number' }),
    /** How the operating carrier in the key was determined (increment 6, ADR 0010). */
    operatorSource: text('operator_source'),
    // merge and archive
    supersededById: uuid('superseded_by_id'),
    supersedeReason: text('supersede_reason'),
    finishedAt: instant('finished_at'),
    eventsR2Key: text('events_r2_key'),
    timelineSummary: jsonb('timeline_summary'),
    ...timestamps(),
  },
  (t) => [
    // Composite keys: the code and the airport row can never disagree (MATCH SIMPLE, so an
    // unresolved airport with a null id is still allowed). Restrict: an airport that a flight
    // names cannot be deleted from under it.
    foreignKey({
      name: 'flight_instances_origin_airport_fk',
      columns: [t.originAirportId, t.originIcao, t.originTz],
      foreignColumns: [airports.id, airports.icao, airports.tz],
    }).onDelete('restrict'),
    foreignKey({
      name: 'flight_instances_destination_airport_fk',
      columns: [t.destinationAirportId, t.destinationIcao],
      foreignColumns: [airports.id, airports.icao],
    }).onDelete('restrict'),
    uniqueIndex('flight_instances_flight_key_key').on(t.flightKey),
    index('flight_instances_tracking_state_next_refresh_at_idx')
      .on(t.trackingState, t.nextRefreshAt)
      .where(sql`${t.trackingState} in (${inList(ACTIVE_TRACKING_STATES)})`),
    index('flight_instances_origin_airport_date_idx').on(
      t.originAirportId,
      t.scheduledDepartureDate,
    ),
    index('flight_instances_destination_airport_date_idx').on(
      t.destinationAirportId,
      t.scheduledDepartureDate,
    ),
    index('flight_instances_icao_hex_idx')
      .on(t.icaoHex)
      .where(sql`${t.trackingState} = 'airborne'`),
    index('flight_instances_aeroapi_fa_flight_id_idx')
      .on(t.aeroapiFaFlightId)
      .where(sql`${t.aeroapiFaFlightId} is not null`),
    index('flight_instances_superseded_by_id_idx')
      .on(t.supersededById)
      .where(sql`${t.supersededById} is not null`),
    check(
      'flight_instances_operating_carrier_icao_check',
      sql`${t.operatingCarrierIcao} ~ ${literal(ICAO_CARRIER_SQL_RE)}`,
    ),
    check(
      'flight_instances_flight_number_check',
      sql`${t.flightNumber} ~ ${literal(FLIGHT_NUMBER_SQL_RE)}`,
    ),
    check(
      'flight_instances_origin_icao_check',
      sql`${t.originIcao} ~ ${literal(ICAO_AIRPORT_SQL_RE)}`,
    ),
    formatCheck('flight_instances_destination_icao_check', t.destinationIcao, ICAO_AIRPORT_SQL_RE),
    formatCheck('flight_instances_diverted_to_icao_check', t.divertedToIcao, ICAO_AIRPORT_SQL_RE),
    formatCheck(
      'flight_instances_aircraft_type_icao_check',
      t.aircraftTypeIcao,
      ICAO_AIRCRAFT_TYPE_SQL_RE,
    ),
    formatCheck('flight_instances_icao_hex_check', t.icaoHex, ICAO_HEX_SQL_RE),
    // Knowing the airport row implies knowing its code and its zone (the zone decides the
    // origin-local date in the frozen key). The composite FK above ties all three together once
    // present; this check makes the zone mandatory whenever the airport is known, because a
    // MATCH SIMPLE foreign key skips rows with a null in any referencing column.
    check(
      'flight_instances_origin_tz_check',
      sql`${t.originAirportId} is null or ${t.originTz} is not null`,
    ),
    check(
      'flight_instances_destination_consistency_check',
      sql`${t.destinationAirportId} is null or ${t.destinationIcao} is not null`,
    ),
    check('flight_instances_leg_seq_check', sql`${t.legSeq} >= 1`),
    check('flight_instances_status_check', sql`${t.status} in (${inList(FLIGHT_STATUSES)})`),
    check(
      'flight_instances_tracking_state_check',
      sql`${t.trackingState} in (${inList(TRACKING_STATES)})`,
    ),
    check(
      'flight_instances_refresh_cadence_check',
      sql`${t.refreshCadence} is null or ${t.refreshCadence} in (${inList(REFRESH_CADENCES)})`,
    ),
    check(
      'flight_instances_supersede_reason_check',
      sql`${t.supersedeReason} is null or ${t.supersedeReason} in (${inList(SUPERSEDE_REASONS)})`,
    ),
    check(
      'flight_instances_superseded_consistency_check',
      sql`(${t.supersededById} is null) = (${t.supersedeReason} is null)`,
    ),
    check('flight_instances_version_check', sql`${t.version} >= 0`),
    check(
      'flight_instances_operator_source_check',
      sql`${t.operatorSource} is null or ${t.operatorSource} in (${inList(OPERATOR_SOURCES)})`,
    ),
  ],
);

/** Audit of every merge: which instance survived, which was folded in, and why. */
export const flightInstanceMerges = pgTable(
  'flight_instance_merges',
  {
    id: id(),
    survivorFlightInstanceId: uuid('survivor_flight_instance_id').notNull(),
    mergedFlightInstanceId: uuid('merged_flight_instance_id').notNull(),
    reason: text('reason').notNull(),
    subscribersMoved: integer('subscribers_moved').notNull().default(0),
    details: jsonb('details'),
    ...createdOnly(),
  },
  (t) => [
    // Explicit names: Drizzle's generated FK names exceed Postgres's 63-character limit.
    foreignKey({
      name: 'flight_instance_merges_survivor_fk',
      columns: [t.survivorFlightInstanceId],
      foreignColumns: [flightInstances.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'flight_instance_merges_merged_fk',
      columns: [t.mergedFlightInstanceId],
      foreignColumns: [flightInstances.id],
    }).onDelete('cascade'),
    uniqueIndex('flight_instance_merges_merged_flight_instance_id_key').on(
      t.mergedFlightInstanceId,
    ),
    index('flight_instance_merges_survivor_flight_instance_id_idx').on(t.survivorFlightInstanceId),
    check(
      'flight_instance_merges_reason_check',
      sql`${t.reason} in (${inList(SUPERSEDE_REASONS)})`,
    ),
  ],
);

export const DESIGNATOR_KINDS = ['operating', 'codeshare'] as const;
export const DESIGNATOR_SOURCES = ['aerodatabox', 'aeroapi', 'user', 'seed', 'import'] as const;

/**
 * Marketing designator (carrier + number + origin-local date + origin) to instance. The search
 * route reads this before KV and before spending a DesignatorResolver call.
 */
export const flightDesignators = pgTable(
  'flight_designators',
  {
    id: id(),
    marketingCarrierIcao: text('marketing_carrier_icao').notNull(),
    marketingCarrierIata: text('marketing_carrier_iata'),
    flightNumber: text('flight_number').notNull(),
    scheduledDepartureDate: date('scheduled_departure_date', { mode: 'string' }).notNull(),
    originIcao: text('origin_icao').notNull(),
    flightInstanceId: uuid('flight_instance_id')
      .notNull()
      .references(() => flightInstances.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('codeshare'),
    source: text('source').notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('flight_designators_designator_key').on(
      t.marketingCarrierIcao,
      t.flightNumber,
      t.scheduledDepartureDate,
      t.originIcao,
    ),
    index('flight_designators_iata_lookup_idx').on(
      t.marketingCarrierIata,
      t.flightNumber,
      t.scheduledDepartureDate,
    ),
    index('flight_designators_flight_instance_id_idx').on(t.flightInstanceId),
    check(
      'flight_designators_marketing_carrier_icao_check',
      sql`${t.marketingCarrierIcao} ~ ${literal(ICAO_CARRIER_SQL_RE)}`,
    ),
    check(
      'flight_designators_flight_number_check',
      sql`${t.flightNumber} ~ ${literal(FLIGHT_NUMBER_SQL_RE)}`,
    ),
    check(
      'flight_designators_origin_icao_check',
      sql`${t.originIcao} ~ ${literal(ICAO_AIRPORT_SQL_RE)}`,
    ),
    formatCheck(
      'flight_designators_marketing_carrier_iata_check',
      t.marketingCarrierIata,
      IATA_CARRIER_SQL_RE,
    ),
    check('flight_designators_kind_check', sql`${t.kind} in (${inList(DESIGNATOR_KINDS)})`),
    check('flight_designators_source_check', sql`${t.source} in (${inList(DESIGNATOR_SOURCES)})`),
  ],
);

/** Mirrors PROVIDER_IDS in @planeahead/shared plus the two non-provider sources of an event. */
export const EVENT_SOURCES = [
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
  'system',
  'user',
] as const;

/**
 * Append-only timeline, flushed from the FlightTracker outbox by the persist consumer. `seq`
 * is the DO's own event sequence, so replays are idempotent on (flight_instance_id, seq). Rows
 * purge at 90 days; the R2 archive and `timeline_summary` keep the history. `type` is not
 * check-constrained: the DO's zod schema owns the vocabulary and unknown types must persist.
 */
export const flightEvents = pgTable(
  'flight_events',
  {
    id: id(),
    flightInstanceId: uuid('flight_instance_id')
      .notNull()
      .references(() => flightInstances.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    occurredAt: instant('occurred_at').notNull(),
    type: text('type').notNull(),
    field: text('field'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    source: text('source').notNull(),
    providerCallId: uuid('provider_call_id'),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('flight_events_flight_instance_id_seq_key').on(t.flightInstanceId, t.seq),
    index('flight_events_created_at_brin_idx').using('brin', t.createdAt),
    check('flight_events_source_check', sql`${t.source} in (${inList(EVENT_SOURCES)})`),
    check('flight_events_seq_check', sql`${t.seq} >= 0`),
  ],
);

/** Pointer to the track sample archived in R2 at finish, plus a small preview for detail pages. */
export const flightTracks = pgTable(
  'flight_tracks',
  {
    id: id(),
    flightInstanceId: uuid('flight_instance_id')
      .notNull()
      .references(() => flightInstances.id, { onDelete: 'cascade' }),
    r2Key: text('r2_key').notNull(),
    sampleCount: integer('sample_count').notNull(),
    firstSeenAt: instant('first_seen_at'),
    lastSeenAt: instant('last_seen_at'),
    preview: jsonb('preview'),
    source: text('source').notNull(),
    ...createdOnly(),
  },
  (t) => [
    uniqueIndex('flight_tracks_flight_instance_id_key').on(t.flightInstanceId),
    check('flight_tracks_source_check', sql`${t.source} in (${inList(EVENT_SOURCES)})`),
    check(
      'flight_tracks_sample_count_check',
      sql`${t.sampleCount} >= 0 and ${t.sampleCount} <= 2000`,
    ),
  ],
);

/**
 * The flight half of the sync feed (migration 0003, increment 8, ADR 0012): one row per applied
 * `flight_instances` write, carrying the snapshot that write stored. Inserted by the persist
 * consumer inside the SAME transaction as the monotonic upsert it records, and only when that
 * upsert changed the row, so a replayed or stale delivery adds nothing. Never updated or upserted:
 * `xid` is a column DEFAULT, and a default does not fire on the `DO UPDATE` branch of
 * `ON CONFLICT`. Shares the watermark rule of `user_sync_changes`
 * (`xid < pg_snapshot_xmin(pg_current_snapshot())`); `GET /v1/sync` reads the rows of the
 * caller's subscribed instances. `seq` is drawn from `user_sync_changes`'s own identity sequence
 * rather than one of its own (ruling O3, ADR 0012 item 3): the persist consumer writes rows to
 * BOTH tables in one transaction (the upsert's snapshot, and the `live_tracked` changes of the
 * flight's subscriptions), so one xid can carry rows in both, and only a shared sequence keeps an
 * `(xid, seq)` pair naming at most one row across the two tables. Purged by the housekeeping cron
 * (increment 12) together with `user_sync_changes`, below one horizon (`sync_horizon`), through
 * the same two indexes (migration 0005): a btree on `xid` and a BRIN on `created_at`.
 */
export const flightSyncChanges = pgTable(
  'flight_sync_changes',
  {
    seq: bigint('seq', { mode: 'number' })
      .primaryKey()
      .default(sql`nextval('user_sync_changes_seq_seq'::regclass)`),
    flightInstanceId: uuid('flight_instance_id')
      .notNull()
      .references(() => flightInstances.id, { onDelete: 'cascade' }),
    xid: xid8('xid')
      .notNull()
      .default(sql`pg_current_xact_id()`),
    /** The `FlightStatus` the upsert stored, with `key` set. */
    snapshot: jsonb('snapshot').notNull(),
    ...createdOnly(),
  },
  (t) => [
    index('flight_sync_changes_flight_instance_id_xid_seq_idx').on(
      t.flightInstanceId,
      t.xid,
      t.seq,
    ),
    index('flight_sync_changes_xid_idx').on(t.xid),
    index('flight_sync_changes_created_at_brin_idx').using('brin', t.createdAt),
  ],
);
