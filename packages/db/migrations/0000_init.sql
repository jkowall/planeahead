CREATE TABLE "aircraft" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"registration" text NOT NULL,
	"icao_hex" text NOT NULL,
	"aircraft_type_icao" text,
	"operator_icao" text,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aircraft_icao_hex_check" CHECK ("aircraft"."icao_hex" ~ '^[0-9A-F]{6}$')
);
--> statement-breakpoint
CREATE TABLE "aircraft_types" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"icao" text NOT NULL,
	"manufacturer" text,
	"model" text NOT NULL,
	"engines" text,
	"engine_type_code" text,
	"engine_placement_code" text,
	"species_code" text,
	"wake_turbulence" text,
	"wake_source" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aircraft_types_wake_turbulence_check" CHECK ("aircraft_types"."wake_turbulence" is null or "aircraft_types"."wake_turbulence" in ('L', 'M', 'H', 'J', 'L/M', 'M/H')),
	CONSTRAINT "aircraft_types_wake_source_check" CHECK ("aircraft_types"."wake_source" is null or "aircraft_types"."wake_source" in ('vrs', 'coltjd45', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "airlines" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"icao" text NOT NULL,
	"iata" text,
	"vrs_code" text NOT NULL,
	"name" text NOT NULL,
	"positioning_flight_pattern" text,
	"charter_flight_pattern" text,
	"alliance" text,
	"alliance_status" text,
	"valid_from" date,
	"valid_to" date,
	"optd_pk" text,
	"checkin_url_template" text,
	"logo_r2_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airlines_icao_format_check" CHECK ("airlines"."icao" ~ '^[A-Z]{3}$'),
	CONSTRAINT "airlines_alliance_check" CHECK ("airlines"."alliance" is null or "airlines"."alliance" in ('oneworld', 'skyteam', 'star_alliance')),
	CONSTRAINT "airlines_alliance_status_check" CHECK ("airlines"."alliance_status" is null or "airlines"."alliance_status" in ('member', 'affiliate', 'former', 'future'))
);
--> statement-breakpoint
CREATE TABLE "airport_profiles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"airport_id" uuid NOT NULL,
	"terminals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"security_wait_minutes_typical" smallint,
	"checkin_cutoff_minutes_domestic" smallint,
	"checkin_cutoff_minutes_international" smallint,
	"transit_notes" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "airports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ourairports_id" integer NOT NULL,
	"ident" text NOT NULL,
	"icao" text NOT NULL,
	"icao_source" text NOT NULL,
	"iata" text,
	"gps_code" text,
	"local_code" text,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"elevation_ft" integer,
	"continent" text,
	"iso_country" text NOT NULL,
	"iso_region" text,
	"municipality" text,
	"scheduled_service" boolean DEFAULT false NOT NULL,
	"tz" text NOT NULL,
	"tz_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airports_type_check" CHECK ("airports"."type" in ('balloonport', 'closed', 'heliport', 'large_airport', 'medium_airport', 'seaplane_base', 'small_airport')),
	CONSTRAINT "airports_icao_source_check" CHECK ("airports"."icao_source" in ('icao_code', 'ident')),
	CONSTRAINT "airports_tz_source_check" CHECK ("airports"."tz_source" in ('mwgg', 'override')),
	CONSTRAINT "airports_icao_format_check" CHECK (("airports"."icao_source" = 'icao_code' and "airports"."icao" ~ '^[A-Z0-9]{4}$') or ("airports"."icao_source" = 'ident' and "airports"."icao" ~ '^[A-Z0-9-]{3,8}$')),
	CONSTRAINT "airports_latitude_check" CHECK ("airports"."latitude" between -90 and 90 and "airports"."longitude" between -180 and 180)
);
--> statement-breakpoint
CREATE TABLE "currency_rates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate" numeric(18, 8) NOT NULL,
	"as_of" date NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "currency_rates_codes_check" CHECK ("currency_rates"."base" ~ '^[A-Z]{3}$' and "currency_rates"."quote" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "regional_operators" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"marketing_iata" text NOT NULL,
	"number_from" integer NOT NULL,
	"number_to" integer NOT NULL,
	"operating_icao" text NOT NULL,
	"confidence" text NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"source" text NOT NULL,
	"source_confidence" text,
	"source_as_of" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "regional_operators_confidence_check" CHECK ("regional_operators"."confidence" in ('hint', 'observed')),
	CONSTRAINT "regional_operators_range_check" CHECK ("regional_operators"."number_from" >= 1 and "regional_operators"."number_to" <= 9999 and "regional_operators"."number_from" <= "regional_operators"."number_to"),
	CONSTRAINT "regional_operators_operating_icao_check" CHECK ("regional_operators"."operating_icao" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refresh_token_enc" "bytea",
	"refresh_token_key_version" smallint
);
--> statement-breakpoint
CREATE TABLE "deleted_subjects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject_id" uuid NOT NULL,
	"rc_app_user_id_hash" "bytea",
	"reason" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deleted_subjects_reason_check" CHECK ("deleted_subjects"."reason" in ('user_request', 'admin', 'inactivity', 'apple_revoke'))
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"install_id" text NOT NULL,
	"platform" text NOT NULL,
	"os_version" text,
	"app_version" text,
	"app_build" text,
	"model" text,
	"locale" text,
	"timezone" text,
	"attestation" jsonb,
	"attestation_verified_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_platform_check" CHECK ("devices"."platform" in ('ios', 'android', 'web'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"user_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"response_status" smallint NOT NULL,
	"response_body" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_consents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_consents_kind_check" CHECK ("user_consents"."kind" in ('terms', 'privacy', 'marketing_email', 'analytics', 'email_import', 'calendar_sync')),
	CONSTRAINT "user_consents_source_check" CHECK ("user_consents"."source" in ('app', 'web', 'api', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "user_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"kek_version" smallint NOT NULL,
	"wrap_algorithm" text DEFAULT 'A256KW' NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_keys_wrap_algorithm_check" CHECK ("user_keys"."wrap_algorithm" in ('A256KW')),
	CONSTRAINT "user_keys_kek_version_check" CHECK ("user_keys"."kek_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"distance_unit" text DEFAULT 'mi' NOT NULL,
	"temperature_unit" text DEFAULT 'f' NOT NULL,
	"time_format" text DEFAULT '12h' NOT NULL,
	"show_local_times" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_preferences_distance_unit_check" CHECK ("user_preferences"."distance_unit" in ('km', 'mi')),
	CONSTRAINT "user_preferences_temperature_unit_check" CHECK ("user_preferences"."temperature_unit" in ('c', 'f')),
	CONSTRAINT "user_preferences_time_format_check" CHECK ("user_preferences"."time_format" in ('12h', '24h'))
);
--> statement-breakpoint
CREATE TABLE "user_sync_changes" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_sync_changes_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"xid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"op" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sync_changes_entity_check" CHECK ("user_sync_changes"."entity" in ('flight_subscriptions', 'trips', 'trip_members', 'user_preferences', 'notification_preferences', 'logbook_entries')),
	CONSTRAINT "user_sync_changes_op_check" CHECK ("user_sync_changes"."op" in ('upsert', 'delete'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_anonymous" boolean DEFAULT false,
	"status" text DEFAULT 'active' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"locale" text,
	"home_airport_id" uuid,
	"last_seen_at" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	CONSTRAINT "users_status_check" CHECK ("users"."status" in ('active', 'suspended', 'deleting', 'deleted')),
	CONSTRAINT "users_plan_check" CHECK ("users"."plan" in ('free', 'premium'))
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flight_designators" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"marketing_carrier_icao" text NOT NULL,
	"marketing_carrier_iata" text,
	"flight_number" text NOT NULL,
	"scheduled_departure_date" date NOT NULL,
	"origin_icao" text NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"kind" text DEFAULT 'codeshare' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flight_designators_marketing_carrier_icao_check" CHECK ("flight_designators"."marketing_carrier_icao" ~ '^[A-Z]{3}$'),
	CONSTRAINT "flight_designators_flight_number_check" CHECK ("flight_designators"."flight_number" ~ '^[1-9][0-9]{0,3}[A-Z]?$'),
	CONSTRAINT "flight_designators_kind_check" CHECK ("flight_designators"."kind" in ('operating', 'codeshare')),
	CONSTRAINT "flight_designators_source_check" CHECK ("flight_designators"."source" in ('aerodatabox', 'aeroapi', 'user', 'seed', 'import'))
);
--> statement-breakpoint
CREATE TABLE "flight_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"type" text NOT NULL,
	"field" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"source" text NOT NULL,
	"provider_call_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flight_events_source_check" CHECK ("flight_events"."source" in ('aeroapi', 'aerodatabox', 'adsb_lol', 'adsb_fi', 'airplanes_live', 'aviationweather', 'nws', 'open_meteo', 'faa_nas', 'llm', 'mock', 'system', 'user')),
	CONSTRAINT "flight_events_seq_check" CHECK ("flight_events"."seq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "flight_instance_merges" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"survivor_flight_instance_id" uuid NOT NULL,
	"merged_flight_instance_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"subscribers_moved" integer DEFAULT 0 NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flight_instance_merges_reason_check" CHECK ("flight_instance_merges"."reason" in ('key_drift', 'provider_merge', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "flight_instances" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"operating_carrier_icao" text NOT NULL,
	"flight_number" text NOT NULL,
	"scheduled_departure_date" date NOT NULL,
	"origin_icao" text NOT NULL,
	"leg_seq" smallint DEFAULT 1 NOT NULL,
	"flight_key" text GENERATED ALWAYS AS (operating_carrier_icao || '-' || flight_number || '-' || lpad(extract(year from scheduled_departure_date)::text, 4, '0') || '-' || lpad(extract(month from scheduled_departure_date)::text, 2, '0') || '-' || lpad(extract(day from scheduled_departure_date)::text, 2, '0') || '-' || origin_icao || CASE WHEN leg_seq > 1 THEN '-L' || leg_seq::text ELSE '' END) STORED NOT NULL,
	"origin_airport_id" uuid,
	"origin_tz" text,
	"destination_icao" text,
	"destination_airport_id" uuid,
	"diverted_to_icao" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"scheduled_out" timestamp with time zone,
	"estimated_out" timestamp with time zone,
	"actual_out" timestamp with time zone,
	"scheduled_off" timestamp with time zone,
	"estimated_off" timestamp with time zone,
	"actual_off" timestamp with time zone,
	"scheduled_on" timestamp with time zone,
	"estimated_on" timestamp with time zone,
	"actual_on" timestamp with time zone,
	"scheduled_in" timestamp with time zone,
	"estimated_in" timestamp with time zone,
	"actual_in" timestamp with time zone,
	"origin_terminal" text,
	"origin_gate" text,
	"destination_terminal" text,
	"destination_gate" text,
	"baggage_claim" text,
	"aircraft_type_icao" text,
	"registration" text,
	"icao_hex" text,
	"inbound_flight_instance_id" uuid,
	"aeroapi_fa_flight_id" text,
	"aerodatabox_ref" text,
	"tracking_state" text DEFAULT 'pending' NOT NULL,
	"refresh_cadence" text,
	"next_refresh_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"provider_call_count" integer DEFAULT 0 NOT NULL,
	"provider_cost_units" integer DEFAULT 0 NOT NULL,
	"subscriber_count" integer DEFAULT 0 NOT NULL,
	"do_schema_version" smallint,
	"superseded_by_id" uuid,
	"supersede_reason" text,
	"finished_at" timestamp with time zone,
	"events_r2_key" text,
	"timeline_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flight_instances_operating_carrier_icao_check" CHECK ("flight_instances"."operating_carrier_icao" ~ '^[A-Z]{3}$'),
	CONSTRAINT "flight_instances_flight_number_check" CHECK ("flight_instances"."flight_number" ~ '^[1-9][0-9]{0,3}[A-Z]?$'),
	CONSTRAINT "flight_instances_origin_icao_check" CHECK ("flight_instances"."origin_icao" ~ '^[A-Z0-9]{4}$'),
	CONSTRAINT "flight_instances_leg_seq_check" CHECK ("flight_instances"."leg_seq" >= 1),
	CONSTRAINT "flight_instances_status_check" CHECK ("flight_instances"."status" in ('scheduled', 'boarding', 'departed', 'en_route', 'landed', 'arrived', 'cancelled', 'diverted', 'unknown')),
	CONSTRAINT "flight_instances_tracking_state_check" CHECK ("flight_instances"."tracking_state" in ('pending', 'tracking', 'airborne', 'landed', 'finished', 'archived', 'superseded')),
	CONSTRAINT "flight_instances_refresh_cadence_check" CHECK ("flight_instances"."refresh_cadence" is null or "flight_instances"."refresh_cadence" in ('literal', 'A1', 'A2', 'B')),
	CONSTRAINT "flight_instances_supersede_reason_check" CHECK ("flight_instances"."supersede_reason" is null or "flight_instances"."supersede_reason" in ('key_drift', 'provider_merge', 'manual')),
	CONSTRAINT "flight_instances_superseded_consistency_check" CHECK (("flight_instances"."superseded_by_id" is null) = ("flight_instances"."supersede_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "flight_tracks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"r2_key" text NOT NULL,
	"sample_count" integer NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"preview" jsonb,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flight_tracks_source_check" CHECK ("flight_tracks"."source" in ('aeroapi', 'aerodatabox', 'adsb_lol', 'adsb_fi', 'airplanes_live', 'aviationweather', 'nws', 'open_meteo', 'faa_nas', 'llm', 'mock', 'system', 'user')),
	CONSTRAINT "flight_tracks_sample_count_check" CHECK ("flight_tracks"."sample_count" >= 0 and "flight_tracks"."sample_count" <= 2000)
);
--> statement-breakpoint
CREATE TABLE "flight_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"trip_id" uuid,
	"label" text,
	"seat" text,
	"cabin" text,
	"confirmation_code_enc" "bytea",
	"confirmation_code_key_version" smallint,
	"notification_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "flight_subscriptions_source_check" CHECK ("flight_subscriptions"."source" in ('manual', 'import', 'email', 'share', 'calendar', 'api'))
);
--> statement-breakpoint
CREATE TABLE "logbook_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"flight_instance_id" uuid,
	"flight_subscription_id" uuid,
	"flight_date" date NOT NULL,
	"operating_carrier_icao" text,
	"flight_number" text,
	"origin_icao" text NOT NULL,
	"destination_icao" text NOT NULL,
	"distance_km" integer,
	"duration_minutes" integer,
	"aircraft_type_icao" text,
	"registration" text,
	"seat" text,
	"cabin" text,
	"notes" text,
	"source" text DEFAULT 'auto' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "logbook_entries_cabin_check" CHECK ("logbook_entries"."cabin" is null or "logbook_entries"."cabin" in ('economy', 'premium_economy', 'business', 'first')),
	CONSTRAINT "logbook_entries_source_check" CHECK ("logbook_entries"."source" in ('auto', 'manual', 'import'))
);
--> statement-breakpoint
CREATE TABLE "trip_members" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"trip_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"invited_by_user_id" uuid,
	"joined_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "trip_members_role_check" CHECK ("trip_members"."role" in ('owner', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"notes" text,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "trips_dates_check" CHECK ("trips"."start_date" is null or "trips"."end_date" is null or "trips"."start_date" <= "trips"."end_date")
);
--> statement-breakpoint
CREATE TABLE "usage_counters" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"scope" text NOT NULL,
	"subject" text NOT NULL,
	"counter" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counters_scope_check" CHECK ("usage_counters"."scope" in ('user', 'email', 'ip', 'token', 'install')),
	CONSTRAINT "usage_counters_counter_check" CHECK ("usage_counters"."counter" in ('active_subscriptions', 'instances_created', 'magic_links', 'refreshes', 'anonymous_creations', 'imports', 'exports', 'mcp_calls', 'share_links')),
	CONSTRAINT "usage_counters_count_check" CHECK ("usage_counters"."count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "user_stats_yearly" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"flights" integer DEFAULT 0 NOT NULL,
	"distance_km" integer DEFAULT 0 NOT NULL,
	"minutes_airborne" integer DEFAULT 0 NOT NULL,
	"airports" integer DEFAULT 0 NOT NULL,
	"airlines" integer DEFAULT 0 NOT NULL,
	"countries" integer DEFAULT 0 NOT NULL,
	"delayed_flights" integer DEFAULT 0 NOT NULL,
	"cancelled_flights" integer DEFAULT 0 NOT NULL,
	"details" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_stats_yearly_year_check" CHECK ("user_stats_yearly"."year" between 1900 and 2200)
);
--> statement-breakpoint
CREATE TABLE "airport_delay_hourly" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"icao" text NOT NULL,
	"hour_start" timestamp with time zone NOT NULL,
	"departures" integer DEFAULT 0 NOT NULL,
	"arrivals" integer DEFAULT 0 NOT NULL,
	"departures_delayed" integer DEFAULT 0 NOT NULL,
	"arrivals_delayed" integer DEFAULT 0 NOT NULL,
	"cancellations" integer DEFAULT 0 NOT NULL,
	"avg_departure_delay_minutes" real,
	"avg_arrival_delay_minutes" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "airport_delay_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"icao" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"departures_total" integer DEFAULT 0 NOT NULL,
	"departures_delayed" integer DEFAULT 0 NOT NULL,
	"arrivals_total" integer DEFAULT 0 NOT NULL,
	"arrivals_delayed" integer DEFAULT 0 NOT NULL,
	"avg_departure_delay_minutes" real,
	"avg_arrival_delay_minutes" real,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airport_delay_snapshots_source_check" CHECK ("airport_delay_snapshots"."source" in ('aeroapi', 'aerodatabox', 'adsb_lol', 'adsb_fi', 'airplanes_live', 'aviationweather', 'nws', 'open_meteo', 'faa_nas', 'llm', 'mock'))
);
--> statement-breakpoint
CREATE TABLE "airport_nas_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"airport_iata" text NOT NULL,
	"airport_icao" text,
	"kind" text NOT NULL,
	"reason" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"avg_delay_minutes" integer,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airport_nas_events_kind_check" CHECK ("airport_nas_events"."kind" in ('ground_stop', 'ground_delay', 'arrival_delay', 'departure_delay', 'closure', 'deicing', 'other'))
);
--> statement-breakpoint
CREATE TABLE "airport_wx_observations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"icao" text NOT NULL,
	"kind" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"raw" text NOT NULL,
	"parsed" jsonb,
	"source" text DEFAULT 'aviationweather' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "airport_wx_observations_kind_check" CHECK ("airport_wx_observations"."kind" in ('metar', 'taf')),
	CONSTRAINT "airport_wx_observations_source_check" CHECK ("airport_wx_observations"."source" in ('aeroapi', 'aerodatabox', 'adsb_lol', 'adsb_fi', 'airplanes_live', 'aviationweather', 'nws', 'open_meteo', 'faa_nas', 'llm', 'mock'))
);
--> statement-breakpoint
CREATE TABLE "bts_airport_hourly" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"year" smallint NOT NULL,
	"month" smallint NOT NULL,
	"airport_iata" text NOT NULL,
	"hour_local" smallint NOT NULL,
	"direction" text NOT NULL,
	"flights" integer DEFAULT 0 NOT NULL,
	"delayed_15" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"avg_delay_minutes" real,
	"import_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bts_airport_hourly_month_check" CHECK ("bts_airport_hourly"."month" between 1 and 12),
	CONSTRAINT "bts_airport_hourly_hour_local_check" CHECK ("bts_airport_hourly"."hour_local" between 0 and 23),
	CONSTRAINT "bts_airport_hourly_direction_check" CHECK ("bts_airport_hourly"."direction" in ('dep', 'arr'))
);
--> statement-breakpoint
CREATE TABLE "bts_carrier_flight_monthly" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"year" smallint NOT NULL,
	"month" smallint NOT NULL,
	"marketing_carrier" text NOT NULL,
	"operating_carrier" text NOT NULL,
	"flight_number" text NOT NULL,
	"origin_iata" text NOT NULL,
	"destination_iata" text NOT NULL,
	"flights" integer DEFAULT 0 NOT NULL,
	"delayed_15" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"diverted" integer DEFAULT 0 NOT NULL,
	"avg_departure_delay_minutes" real,
	"avg_arrival_delay_minutes" real,
	"import_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bts_carrier_flight_monthly_month_check" CHECK ("bts_carrier_flight_monthly"."month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "bts_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"year" smallint NOT NULL,
	"month" smallint NOT NULL,
	"source_url" text NOT NULL,
	"source_sha256" "bytea",
	"source_bytes" bigint,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"rows_written" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bts_import_runs_status_check" CHECK ("bts_import_runs"."status" in ('running', 'succeeded', 'failed')),
	CONSTRAINT "bts_import_runs_month_check" CHECK ("bts_import_runs"."month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "bts_route_monthly" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"year" smallint NOT NULL,
	"month" smallint NOT NULL,
	"operating_carrier" text NOT NULL,
	"origin_iata" text NOT NULL,
	"destination_iata" text NOT NULL,
	"flights" integer DEFAULT 0 NOT NULL,
	"delayed_15" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"diverted" integer DEFAULT 0 NOT NULL,
	"avg_departure_delay_minutes" real,
	"avg_arrival_delay_minutes" real,
	"avg_taxi_out_minutes" real,
	"avg_taxi_in_minutes" real,
	"import_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bts_route_monthly_month_check" CHECK ("bts_route_monthly"."month" between 1 and 12)
);
--> statement-breakpoint
CREATE TABLE "delay_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"departure_delay_minutes" integer,
	"arrival_delay_minutes" integer,
	"cancelled" boolean DEFAULT false NOT NULL,
	"diverted" boolean DEFAULT false NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delay_predictions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"model_version" text NOT NULL,
	"predicted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"horizon_minutes" integer,
	"p_delay_15" real NOT NULL,
	"p_delay_60" real,
	"p_cancel" real,
	"expected_delay_minutes" real,
	"features" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delay_predictions_probabilities_check" CHECK ("delay_predictions"."p_delay_15" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "provider_alert_registrations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"external_alert_id" text NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"max_weekly" integer,
	"deliveries" integer DEFAULT 0 NOT NULL,
	"expected_by" timestamp with time zone,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_alert_registrations_provider_check" CHECK ("provider_alert_registrations"."provider" in ('aeroapi', 'aerodatabox', 'adsb_lol', 'adsb_fi', 'airplanes_live', 'aviationweather', 'nws', 'open_meteo', 'faa_nas', 'llm', 'mock'))
);
--> statement-breakpoint
CREATE TABLE "provider_budget_config" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"daily_cap_units" integer NOT NULL,
	"daily_soft_cap_units" integer,
	"per_flight_soft_cap_pe" integer,
	"per_flight_hard_cap_pe" integer,
	"refresh_sub_budget_units" integer,
	"kill_switch" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_budget_config_provider_check" CHECK ("provider_budget_config"."provider" in ('aeroapi', 'aerodatabox', 'adsb_lol', 'adsb_fi', 'airplanes_live', 'aviationweather', 'nws', 'open_meteo', 'faa_nas', 'llm', 'mock')),
	CONSTRAINT "provider_budget_config_daily_cap_units_check" CHECK ("provider_budget_config"."daily_cap_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_call_daily" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"result" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"cost_units" bigint DEFAULT 0 NOT NULL,
	"cost_usd_micros" bigint DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_call_daily_provider_check" CHECK ("provider_call_daily"."provider" in ('aeroapi', 'aerodatabox', 'adsb_lol', 'adsb_fi', 'airplanes_live', 'aviationweather', 'nws', 'open_meteo', 'faa_nas', 'llm', 'mock')),
	CONSTRAINT "provider_call_daily_result_check" CHECK ("provider_call_daily"."result" in ('ok', 'not_found', 'rate_limited', 'error'))
);
--> statement-breakpoint
CREATE TABLE "provider_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"trigger" text NOT NULL,
	"result" text NOT NULL,
	"http_status" smallint,
	"duration_ms" integer,
	"cost_units" integer DEFAULT 0 NOT NULL,
	"cost_usd_micros" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer,
	"tokens_out" integer,
	"flight_instance_id" uuid,
	"flight_key" text,
	"request_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_calls_provider_check" CHECK ("provider_calls"."provider" in ('aeroapi', 'aerodatabox', 'adsb_lol', 'adsb_fi', 'airplanes_live', 'aviationweather', 'nws', 'open_meteo', 'faa_nas', 'llm', 'mock')),
	CONSTRAINT "provider_calls_trigger_check" CHECK ("provider_calls"."trigger" in ('alarm', 'provider_alert', 'adb_alert', 'user_search', 'user_refresh', 'reconcile', 'backfill', 'cron', 'import', 'manual')),
	CONSTRAINT "provider_calls_result_check" CHECK ("provider_calls"."result" in ('ok', 'not_found', 'rate_limited', 'error'))
);
--> statement-breakpoint
CREATE TABLE "provider_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signature_valid" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"flight_instance_id" uuid,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_webhook_events_provider_check" CHECK ("provider_webhook_events"."provider" in ('aeroapi', 'aerodatabox', 'adsb_lol', 'adsb_fi', 'airplanes_live', 'aviationweather', 'nws', 'open_meteo', 'faa_nas', 'llm', 'mock'))
);
--> statement-breakpoint
CREATE TABLE "live_activities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"flight_subscription_id" uuid NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"activity_id" text NOT NULL,
	"push_token" text NOT NULL,
	"push_token_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_state_hash" "bytea",
	"last_pushed_at" timestamp with time zone,
	"stale_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"notification_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"push_token_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_channel_check" CHECK ("notification_deliveries"."channel" in ('apns', 'fcm', 'email', 'live_activity')),
	CONSTRAINT "notification_deliveries_status_check" CHECK ("notification_deliveries"."status" in ('queued', 'sent', 'failed', 'invalid_token', 'suppressed'))
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"push_enabled" boolean DEFAULT true NOT NULL,
	"email_enabled" boolean DEFAULT false NOT NULL,
	"live_activities_enabled" boolean DEFAULT true NOT NULL,
	"quiet_hours_start_minutes" smallint,
	"quiet_hours_end_minutes" smallint,
	"quiet_hours_tz" text,
	"events" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "notification_preferences_quiet_hours_check" CHECK (("notification_preferences"."quiet_hours_start_minutes" is null or "notification_preferences"."quiet_hours_start_minutes" between 0 and 1439) and ("notification_preferences"."quiet_hours_end_minutes" is null or "notification_preferences"."quiet_hours_end_minutes" between 0 and 1439))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"flight_instance_id" uuid,
	"flight_subscription_id" uuid,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_kind_check" CHECK ("notifications"."kind" in ('schedule_change', 'gate_change', 'delay', 'cancellation', 'diversion', 'boarding', 'departure', 'arrival', 'baggage', 'reminder', 'trip_share', 'system'))
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token" text NOT NULL,
	"environment" text DEFAULT 'production' NOT NULL,
	"invalidated_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_kind_check" CHECK ("push_tokens"."kind" in ('apns', 'fcm', 'apns_live_activity_start', 'expo')),
	CONSTRAINT "push_tokens_environment_check" CHECK ("push_tokens"."environment" in ('sandbox', 'production'))
);
--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_account_id" text NOT NULL,
	"calendar_id" text,
	"access_token_enc" "bytea",
	"access_token_key_version" smallint,
	"refresh_token_enc" "bytea",
	"refresh_token_key_version" smallint,
	"token_expires_at" timestamp with time zone,
	"sync_token" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_connections_provider_check" CHECK ("calendar_connections"."provider" in ('google', 'microsoft', 'apple_caldav')),
	CONSTRAINT "calendar_connections_status_check" CHECK ("calendar_connections"."status" in ('active', 'paused', 'revoked', 'error'))
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"calendar_connection_id" uuid NOT NULL,
	"flight_subscription_id" uuid,
	"external_event_id" text NOT NULL,
	"etag" text,
	"content_hash" "bytea",
	"last_written_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"email_address" text NOT NULL,
	"external_account_id" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"access_token_enc" "bytea",
	"access_token_key_version" smallint,
	"refresh_token_enc" "bytea",
	"refresh_token_key_version" smallint,
	"token_expires_at" timestamp with time zone,
	"history_cursor" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_accounts_provider_check" CHECK ("email_accounts"."provider" in ('gmail', 'outlook', 'imap')),
	CONSTRAINT "email_accounts_status_check" CHECK ("email_accounts"."status" in ('active', 'paused', 'revoked', 'error'))
);
--> statement-breakpoint
CREATE TABLE "email_extractions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"email_message_processed_id" uuid,
	"inbound_message_id" uuid,
	"extractor" text NOT NULL,
	"model_version" text,
	"extracted" jsonb NOT NULL,
	"confidence" real,
	"status" text DEFAULT 'pending' NOT NULL,
	"flight_subscription_id" uuid,
	"tokens_in" integer,
	"tokens_out" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_extractions_extractor_check" CHECK ("email_extractions"."extractor" in ('rules', 'llm')),
	CONSTRAINT "email_extractions_status_check" CHECK ("email_extractions"."status" in ('pending', 'accepted', 'rejected', 'applied'))
);
--> statement-breakpoint
CREATE TABLE "email_messages_processed" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email_account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_message_id" text NOT NULL,
	"outcome" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_processed_outcome_check" CHECK ("email_messages_processed"."outcome" in ('extracted', 'no_flight', 'skipped', 'error'))
);
--> statement-breakpoint
CREATE TABLE "ics_feed_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"token_prefix" text NOT NULL,
	"name" text,
	"last_fetched_at" timestamp with time zone,
	"fetch_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"import_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"raw" jsonb NOT NULL,
	"parsed" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"flight_subscription_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_rows_status_check" CHECK ("import_rows"."status" in ('pending', 'matched', 'unmatched', 'applied', 'skipped', 'error'))
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"file_name" text,
	"r2_key" text,
	"row_count" integer,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imports_kind_check" CHECK ("imports"."kind" in ('csv', 'ics', 'tripit', 'app_in_the_air', 'flighty', 'manual')),
	CONSTRAINT "imports_status_check" CHECK ("imports"."status" in ('uploaded', 'parsing', 'review', 'applied', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "inbound_addresses" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"local_part" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_addresses_status_check" CHECK ("inbound_addresses"."status" in ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "inbound_messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"inbound_address_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"message_id" text,
	"from_domain" text,
	"size_bytes" integer,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"reject_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_messages_status_check" CHECK ("inbound_messages"."status" in ('received', 'processed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "meet_me_sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"flight_instance_id" uuid NOT NULL,
	"flight_subscription_id" uuid,
	"token_hash" "bytea" NOT NULL,
	"token_prefix" text NOT NULL,
	"guest_label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_guest_seen_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meet_me_sessions_status_check" CHECK ("meet_me_sessions"."status" in ('active', 'expired', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "share_link_views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"share_link_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_hash" "bytea",
	"user_agent_hash" "bytea",
	"country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"flight_subscription_id" uuid,
	"flight_instance_id" uuid,
	"trip_id" uuid,
	"token_hash" "bytea" NOT NULL,
	"token_prefix" text NOT NULL,
	"og_image_key" text,
	"view_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_links_kind_check" CHECK ("share_links"."kind" in ('flight', 'trip')),
	CONSTRAINT "share_links_target_check" CHECK (("share_links"."kind" = 'flight' and "share_links"."flight_instance_id" is not null and "share_links"."trip_id" is null) or ("share_links"."kind" = 'trip' and "share_links"."trip_id" is not null and "share_links"."flight_instance_id" is null))
);
--> statement-breakpoint
CREATE TABLE "account_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject_id" uuid NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_deletion_requests_source_check" CHECK ("account_deletion_requests"."source" in ('app', 'web', 'admin', 'apple_s2s')),
	CONSTRAINT "account_deletion_requests_status_check" CHECK ("account_deletion_requests"."status" in ('pending', 'processing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"token_prefix" text NOT NULL,
	"name" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_kind_check" CHECK ("api_tokens"."kind" in ('pat', 'mcp', 'device', 'service'))
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subject_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"request_id" text,
	"ip_hash" "bytea",
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("audit_log"."actor_type" in ('user', 'admin', 'system', 'api_token', 'webhook'))
);
--> statement-breakpoint
CREATE TABLE "data_export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"r2_key" text,
	"size_bytes" bigint,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_export_jobs_status_check" CHECK ("data_export_jobs"."status" in ('queued', 'running', 'ready', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"rc_app_user_id" text NOT NULL,
	"entitlement_id" text NOT NULL,
	"product_id" text,
	"store" text,
	"status" text NOT NULL,
	"will_renew" boolean,
	"expires_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlements_status_check" CHECK ("entitlements"."status" in ('active', 'grace', 'paused', 'expired', 'revoked')),
	CONSTRAINT "entitlements_store_check" CHECK ("entitlements"."store" is null or "entitlements"."store" in ('app_store', 'play_store', 'stripe', 'promo'))
);
--> statement-breakpoint
CREATE TABLE "revenuecat_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"rc_app_user_id" text NOT NULL,
	"environment" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"rc_app_user_id" text NOT NULL,
	"subject_id" uuid,
	"store" text NOT NULL,
	"product_id" text NOT NULL,
	"original_transaction_id" text,
	"status" text NOT NULL,
	"purchased_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"renewed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"price_micros" bigint,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_store_check" CHECK ("subscriptions"."store" in ('app_store', 'play_store', 'stripe', 'promo')),
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" in ('trial', 'active', 'grace', 'cancelled', 'expired', 'refunded'))
);
--> statement-breakpoint
ALTER TABLE "airport_profiles" ADD CONSTRAINT "airport_profiles_airport_id_airports_id_fk" FOREIGN KEY ("airport_id") REFERENCES "public"."airports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_keys" ADD CONSTRAINT "user_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sync_changes" ADD CONSTRAINT "user_sync_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_home_airport_id_airports_id_fk" FOREIGN KEY ("home_airport_id") REFERENCES "public"."airports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_designators" ADD CONSTRAINT "flight_designators_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_events" ADD CONSTRAINT "flight_events_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instance_merges" ADD CONSTRAINT "flight_instance_merges_survivor_fk" FOREIGN KEY ("survivor_flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instance_merges" ADD CONSTRAINT "flight_instance_merges_merged_fk" FOREIGN KEY ("merged_flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instances" ADD CONSTRAINT "flight_instances_origin_airport_id_airports_id_fk" FOREIGN KEY ("origin_airport_id") REFERENCES "public"."airports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_instances" ADD CONSTRAINT "flight_instances_destination_airport_id_airports_id_fk" FOREIGN KEY ("destination_airport_id") REFERENCES "public"."airports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_tracks" ADD CONSTRAINT "flight_tracks_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_subscriptions" ADD CONSTRAINT "flight_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_subscriptions" ADD CONSTRAINT "flight_subscriptions_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flight_subscriptions" ADD CONSTRAINT "flight_subscriptions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logbook_entries" ADD CONSTRAINT "logbook_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logbook_entries" ADD CONSTRAINT "logbook_entries_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_members" ADD CONSTRAINT "trip_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_stats_yearly" ADD CONSTRAINT "user_stats_yearly_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bts_airport_hourly" ADD CONSTRAINT "bts_airport_hourly_import_run_id_bts_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."bts_import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bts_carrier_flight_monthly" ADD CONSTRAINT "bts_carrier_flight_monthly_import_run_id_bts_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."bts_import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bts_route_monthly" ADD CONSTRAINT "bts_route_monthly_import_run_id_bts_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."bts_import_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delay_outcomes" ADD CONSTRAINT "delay_outcomes_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delay_predictions" ADD CONSTRAINT "delay_predictions_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_alert_registrations" ADD CONSTRAINT "provider_alert_registrations_flight_instance_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_activities" ADD CONSTRAINT "live_activities_subscription_fk" FOREIGN KEY ("flight_subscription_id") REFERENCES "public"."flight_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_connection_fk" FOREIGN KEY ("calendar_connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_subscription_fk" FOREIGN KEY ("flight_subscription_id") REFERENCES "public"."flight_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_extractions" ADD CONSTRAINT "email_extractions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_extractions" ADD CONSTRAINT "email_extractions_message_fk" FOREIGN KEY ("email_message_processed_id") REFERENCES "public"."email_messages_processed"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_extractions" ADD CONSTRAINT "email_extractions_subscription_fk" FOREIGN KEY ("flight_subscription_id") REFERENCES "public"."flight_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages_processed" ADD CONSTRAINT "email_messages_processed_email_account_id_email_accounts_id_fk" FOREIGN KEY ("email_account_id") REFERENCES "public"."email_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_messages_processed" ADD CONSTRAINT "email_messages_processed_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ics_feed_tokens" ADD CONSTRAINT "ics_feed_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_flight_subscription_id_flight_subscriptions_id_fk" FOREIGN KEY ("flight_subscription_id") REFERENCES "public"."flight_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_addresses" ADD CONSTRAINT "inbound_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_inbound_address_id_inbound_addresses_id_fk" FOREIGN KEY ("inbound_address_id") REFERENCES "public"."inbound_addresses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_me_sessions" ADD CONSTRAINT "meet_me_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_me_sessions" ADD CONSTRAINT "meet_me_sessions_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meet_me_sessions" ADD CONSTRAINT "meet_me_sessions_subscription_fk" FOREIGN KEY ("flight_subscription_id") REFERENCES "public"."flight_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_link_views" ADD CONSTRAINT "share_link_views_share_link_id_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_flight_subscription_id_flight_subscriptions_id_fk" FOREIGN KEY ("flight_subscription_id") REFERENCES "public"."flight_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_flight_instance_id_flight_instances_id_fk" FOREIGN KEY ("flight_instance_id") REFERENCES "public"."flight_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_jobs" ADD CONSTRAINT "data_export_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "aircraft_registration_valid_from_key" ON "aircraft" USING btree ("registration","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "aircraft_icao_hex_valid_from_key" ON "aircraft" USING btree ("icao_hex","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "aircraft_types_icao_key" ON "aircraft_types" USING btree ("icao");--> statement-breakpoint
CREATE UNIQUE INDEX "airlines_icao_key" ON "airlines" USING btree ("icao");--> statement-breakpoint
CREATE UNIQUE INDEX "airlines_vrs_code_key" ON "airlines" USING btree ("vrs_code");--> statement-breakpoint
CREATE INDEX "airlines_iata_idx" ON "airlines" USING btree ("iata");--> statement-breakpoint
CREATE UNIQUE INDEX "airport_profiles_airport_id_key" ON "airport_profiles" USING btree ("airport_id");--> statement-breakpoint
CREATE UNIQUE INDEX "airports_icao_key" ON "airports" USING btree ("icao");--> statement-breakpoint
CREATE UNIQUE INDEX "airports_ident_key" ON "airports" USING btree ("ident");--> statement-breakpoint
CREATE UNIQUE INDEX "airports_ourairports_id_key" ON "airports" USING btree ("ourairports_id");--> statement-breakpoint
CREATE UNIQUE INDEX "airports_iata_key" ON "airports" USING btree ("iata") WHERE "airports"."iata" is not null;--> statement-breakpoint
CREATE INDEX "airports_iso_country_idx" ON "airports" USING btree ("iso_country");--> statement-breakpoint
CREATE UNIQUE INDEX "currency_rates_pair_as_of_key" ON "currency_rates" USING btree ("base","quote","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "regional_operators_block_key" ON "regional_operators" USING btree ("marketing_iata","number_from","number_to");--> statement-breakpoint
CREATE INDEX "regional_operators_marketing_iata_idx" ON "regional_operators" USING btree ("marketing_iata");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deleted_subjects_subject_id_key" ON "deleted_subjects" USING btree ("subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_user_id_install_id_key" ON "devices" USING btree ("user_id","install_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limits_key_key" ON "rate_limits" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_consents_user_id_kind_idx" ON "user_consents" USING btree ("user_id","kind","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_keys_user_id_key" ON "user_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_user_id_key" ON "user_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sync_changes_user_id_xid_seq_idx" ON "user_sync_changes" USING btree ("user_id","xid","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_at_idx" ON "verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flight_designators_designator_key" ON "flight_designators" USING btree ("marketing_carrier_icao","flight_number","scheduled_departure_date","origin_icao");--> statement-breakpoint
CREATE INDEX "flight_designators_iata_lookup_idx" ON "flight_designators" USING btree ("marketing_carrier_iata","flight_number","scheduled_departure_date");--> statement-breakpoint
CREATE INDEX "flight_designators_flight_instance_id_idx" ON "flight_designators" USING btree ("flight_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flight_events_flight_instance_id_seq_key" ON "flight_events" USING btree ("flight_instance_id","seq");--> statement-breakpoint
CREATE INDEX "flight_events_created_at_brin_idx" ON "flight_events" USING brin ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "flight_instance_merges_merged_flight_instance_id_key" ON "flight_instance_merges" USING btree ("merged_flight_instance_id");--> statement-breakpoint
CREATE INDEX "flight_instance_merges_survivor_flight_instance_id_idx" ON "flight_instance_merges" USING btree ("survivor_flight_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flight_instances_flight_key_key" ON "flight_instances" USING btree ("flight_key");--> statement-breakpoint
CREATE INDEX "flight_instances_tracking_state_next_refresh_at_idx" ON "flight_instances" USING btree ("tracking_state","next_refresh_at") WHERE "flight_instances"."tracking_state" in ('pending', 'tracking', 'airborne', 'landed');--> statement-breakpoint
CREATE INDEX "flight_instances_origin_airport_date_idx" ON "flight_instances" USING btree ("origin_airport_id","scheduled_departure_date");--> statement-breakpoint
CREATE INDEX "flight_instances_destination_airport_date_idx" ON "flight_instances" USING btree ("destination_airport_id","scheduled_departure_date");--> statement-breakpoint
CREATE INDEX "flight_instances_icao_hex_idx" ON "flight_instances" USING btree ("icao_hex") WHERE "flight_instances"."tracking_state" = 'airborne';--> statement-breakpoint
CREATE INDEX "flight_instances_aeroapi_fa_flight_id_idx" ON "flight_instances" USING btree ("aeroapi_fa_flight_id") WHERE "flight_instances"."aeroapi_fa_flight_id" is not null;--> statement-breakpoint
CREATE INDEX "flight_instances_superseded_by_id_idx" ON "flight_instances" USING btree ("superseded_by_id") WHERE "flight_instances"."superseded_by_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "flight_tracks_flight_instance_id_key" ON "flight_tracks" USING btree ("flight_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "flight_subscriptions_user_id_flight_instance_id_key" ON "flight_subscriptions" USING btree ("user_id","flight_instance_id") WHERE "flight_subscriptions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "flight_subscriptions_flight_instance_id_idx" ON "flight_subscriptions" USING btree ("flight_instance_id") WHERE "flight_subscriptions"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "flight_subscriptions_user_id_updated_at_idx" ON "flight_subscriptions" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "flight_subscriptions_trip_id_idx" ON "flight_subscriptions" USING btree ("trip_id") WHERE "flight_subscriptions"."trip_id" is not null;--> statement-breakpoint
CREATE INDEX "logbook_entries_user_id_flight_date_idx" ON "logbook_entries" USING btree ("user_id","flight_date");--> statement-breakpoint
CREATE INDEX "logbook_entries_user_id_updated_at_idx" ON "logbook_entries" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trip_members_trip_id_user_id_key" ON "trip_members" USING btree ("trip_id","user_id") WHERE "trip_members"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "trip_members_user_id_idx" ON "trip_members" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "trips_user_id_idx" ON "trips" USING btree ("user_id","updated_at") WHERE "trips"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_counters_scope_subject_counter_window_start_key" ON "usage_counters" USING btree ("scope","subject","counter","window_start");--> statement-breakpoint
CREATE INDEX "usage_counters_window_start_idx" ON "usage_counters" USING btree ("window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "user_stats_yearly_user_id_year_key" ON "user_stats_yearly" USING btree ("user_id","year");--> statement-breakpoint
CREATE UNIQUE INDEX "airport_delay_hourly_icao_hour_start_key" ON "airport_delay_hourly" USING btree ("icao","hour_start");--> statement-breakpoint
CREATE UNIQUE INDEX "airport_delay_snapshots_icao_captured_at_key" ON "airport_delay_snapshots" USING btree ("icao","captured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "airport_nas_events_airport_iata_kind_started_at_key" ON "airport_nas_events" USING btree ("airport_iata","kind","started_at");--> statement-breakpoint
CREATE INDEX "airport_nas_events_airport_iata_started_at_idx" ON "airport_nas_events" USING btree ("airport_iata","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "airport_wx_observations_icao_kind_observed_at_key" ON "airport_wx_observations" USING btree ("icao","kind","observed_at");--> statement-breakpoint
CREATE INDEX "airport_wx_observations_created_at_brin_idx" ON "airport_wx_observations" USING brin ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bts_airport_hourly_key" ON "bts_airport_hourly" USING btree ("year","month","airport_iata","hour_local","direction");--> statement-breakpoint
CREATE UNIQUE INDEX "bts_carrier_flight_monthly_key" ON "bts_carrier_flight_monthly" USING btree ("year","month","marketing_carrier","operating_carrier","flight_number","origin_iata","destination_iata");--> statement-breakpoint
CREATE INDEX "bts_carrier_flight_monthly_marketing_lookup_idx" ON "bts_carrier_flight_monthly" USING btree ("marketing_carrier","flight_number","year","month");--> statement-breakpoint
CREATE INDEX "bts_import_runs_year_month_idx" ON "bts_import_runs" USING btree ("year","month");--> statement-breakpoint
CREATE UNIQUE INDEX "bts_route_monthly_key" ON "bts_route_monthly" USING btree ("year","month","operating_carrier","origin_iata","destination_iata");--> statement-breakpoint
CREATE UNIQUE INDEX "delay_outcomes_flight_instance_id_key" ON "delay_outcomes" USING btree ("flight_instance_id");--> statement-breakpoint
CREATE INDEX "delay_predictions_flight_instance_id_predicted_at_idx" ON "delay_predictions" USING btree ("flight_instance_id","predicted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_alert_registrations_provider_external_alert_id_key" ON "provider_alert_registrations" USING btree ("provider","external_alert_id");--> statement-breakpoint
CREATE INDEX "provider_alert_registrations_flight_instance_id_idx" ON "provider_alert_registrations" USING btree ("flight_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_budget_config_provider_key" ON "provider_budget_config" USING btree ("provider");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_call_daily_day_provider_operation_result_key" ON "provider_call_daily" USING btree ("day","provider","operation","result");--> statement-breakpoint
CREATE INDEX "provider_calls_created_at_brin_idx" ON "provider_calls" USING brin ("created_at");--> statement-breakpoint
CREATE INDEX "provider_calls_flight_instance_id_created_at_idx" ON "provider_calls" USING btree ("flight_instance_id","created_at");--> statement-breakpoint
CREATE INDEX "provider_calls_provider_created_at_idx" ON "provider_calls" USING btree ("provider","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_webhook_events_provider_external_id_key" ON "provider_webhook_events" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "provider_webhook_events_received_at_idx" ON "provider_webhook_events" USING btree ("received_at") WHERE "provider_webhook_events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "live_activities_activity_id_key" ON "live_activities" USING btree ("activity_id");--> statement-breakpoint
CREATE INDEX "live_activities_flight_instance_id_idx" ON "live_activities" USING btree ("flight_instance_id") WHERE "live_activities"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "live_activities_user_id_idx" ON "live_activities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_created_at_brin_idx" ON "notification_deliveries" USING brin ("created_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_notification_id_idx" ON "notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_subject_id_created_at_idx" ON "notification_deliveries" USING btree ("subject_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_user_id_key" ON "notification_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key_key" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_kind_token_key" ON "push_tokens" USING btree ("kind","token");--> statement-breakpoint
CREATE INDEX "push_tokens_user_id_idx" ON "push_tokens" USING btree ("user_id") WHERE "push_tokens"."invalidated_at" is null;--> statement-breakpoint
CREATE INDEX "push_tokens_device_id_idx" ON "push_tokens" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_user_id_provider_external_account_id_key" ON "calendar_connections" USING btree ("user_id","provider","external_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_connection_event_key" ON "calendar_events" USING btree ("calendar_connection_id","external_event_id");--> statement-breakpoint
CREATE INDEX "calendar_events_flight_subscription_id_idx" ON "calendar_events" USING btree ("flight_subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_accounts_user_id_provider_email_address_key" ON "email_accounts" USING btree ("user_id","provider","email_address");--> statement-breakpoint
CREATE INDEX "email_extractions_user_id_created_at_idx" ON "email_extractions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_messages_processed_account_message_key" ON "email_messages_processed" USING btree ("email_account_id","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ics_feed_tokens_token_hash_key" ON "ics_feed_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ics_feed_tokens_user_id_idx" ON "ics_feed_tokens" USING btree ("user_id") WHERE "ics_feed_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_import_id_row_number_key" ON "import_rows" USING btree ("import_id","row_number");--> statement-breakpoint
CREATE INDEX "imports_user_id_created_at_idx" ON "imports" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_addresses_local_part_key" ON "inbound_addresses" USING btree ("local_part");--> statement-breakpoint
CREATE INDEX "inbound_addresses_user_id_idx" ON "inbound_addresses" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_messages_inbound_address_id_message_id_key" ON "inbound_messages" USING btree ("inbound_address_id","message_id") WHERE "inbound_messages"."message_id" is not null;--> statement-breakpoint
CREATE INDEX "inbound_messages_user_id_received_at_idx" ON "inbound_messages" USING btree ("user_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "meet_me_sessions_token_hash_key" ON "meet_me_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "meet_me_sessions_user_id_idx" ON "meet_me_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "meet_me_sessions_flight_instance_id_idx" ON "meet_me_sessions" USING btree ("flight_instance_id");--> statement-breakpoint
CREATE INDEX "share_link_views_share_link_id_viewed_at_idx" ON "share_link_views" USING btree ("share_link_id","viewed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_user_id_idx" ON "share_links" USING btree ("user_id") WHERE "share_links"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "account_deletion_requests_subject_id_idx" ON "account_deletion_requests" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "account_deletion_requests_status_idx" ON "account_deletion_requests" USING btree ("status","requested_at") WHERE "account_deletion_requests"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_token_hash_key" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_user_id_idx" ON "api_tokens" USING btree ("user_id") WHERE "api_tokens"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "audit_log_created_at_brin_idx" ON "audit_log" USING brin ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_subject_id_created_at_idx" ON "audit_log" USING btree ("subject_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "data_export_jobs_user_id_requested_at_idx" ON "data_export_jobs" USING btree ("user_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_user_id_entitlement_id_key" ON "entitlements" USING btree ("user_id","entitlement_id");--> statement-breakpoint
CREATE INDEX "entitlements_rc_app_user_id_idx" ON "entitlements" USING btree ("rc_app_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revenuecat_events_event_id_key" ON "revenuecat_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "revenuecat_events_rc_app_user_id_occurred_at_idx" ON "revenuecat_events" USING btree ("rc_app_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "revenuecat_events_unprocessed_idx" ON "revenuecat_events" USING btree ("created_at") WHERE "revenuecat_events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_store_original_transaction_id_key" ON "subscriptions" USING btree ("store","original_transaction_id") WHERE "subscriptions"."original_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "subscriptions_rc_app_user_id_idx" ON "subscriptions" USING btree ("rc_app_user_id");--> statement-breakpoint
CREATE INDEX "subscriptions_subject_id_idx" ON "subscriptions" USING btree ("subject_id");