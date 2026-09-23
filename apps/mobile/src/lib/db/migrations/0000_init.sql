CREATE TABLE `flight_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`flight_key` text NOT NULL,
	`flight_instance_id` text,
	`trip_id` text,
	`label` text,
	`seat` text,
	`cabin` text,
	`muted` integer DEFAULT false NOT NULL,
	`notification_overrides` text DEFAULT '{}' NOT NULL,
	`source` text DEFAULT 'app' NOT NULL,
	`live_tracked` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`flight_status` text,
	`scheduled_out` text,
	`estimated_out` text,
	`actual_out` text,
	`scheduled_in` text,
	`estimated_in` text,
	`actual_in` text,
	`origin_icao` text,
	`origin_iata` text,
	`origin_tz` text,
	`destination_icao` text,
	`destination_iata` text,
	`destination_tz` text,
	`origin_terminal` text,
	`origin_gate` text,
	`destination_terminal` text,
	`destination_gate` text,
	`baggage_claim` text,
	`aircraft_type_icao` text,
	`departure_delay_sec` integer,
	`arrival_delay_sec` integer,
	`snapshot_json` text,
	`snapshot_fetched_at` text,
	`snapshot_source` text
);
--> statement-breakpoint
CREATE INDEX `flight_subscriptions_flight_key_idx` ON `flight_subscriptions` (`flight_key`);--> statement-breakpoint
CREATE INDEX `flight_subscriptions_live_scheduled_out_idx` ON `flight_subscriptions` (`deleted_at`,`scheduled_out`);--> statement-breakpoint
CREATE TABLE `logbook_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`row_json` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`row_json` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`body` text,
	`idempotency_key` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`last_status` integer,
	`last_error` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_next_attempt_idx` ON `outbox` (`next_attempt_at`,`id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`cursor` text,
	`last_pulled_at` text,
	CONSTRAINT "sync_state_single_row" CHECK("sync_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `trip_members` (
	`id` text PRIMARY KEY NOT NULL,
	`row_json` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`row_json` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`distance_unit` text NOT NULL,
	`temperature_unit` text NOT NULL,
	`time_format` text NOT NULL,
	`show_local_times` integer NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text
);
