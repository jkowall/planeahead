-- Custom migration (drizzle-kit generate --custom --name add_set_updated_at), body written by
-- scripts/gen-updated-at-migration.mjs. set_updated_at() stamps updated_at on every UPDATE so
-- writers that bypass Drizzle (queue consumers, raw SQL, admin tools) keep the column honest.
-- Every trigger has a WHEN clause that skips no-op updates, so a replayed identical upsert does
-- not move updated_at and the sync feed sees no phantom change. A table with a STORED generated
-- column cannot use OLD.* IS DISTINCT FROM NEW.* (Postgres restriction), so its clause names
-- every non-generated column explicitly; the generator derives that list from the snapshot.
-- The function pins search_path so the trigger cannot be redirected by a session setting.
-- The migrator splits this file on the breakpoint marker: one marker separates the function
-- from each CREATE TRIGGER and none may appear inside the dollar-quoted body, not even in a
-- comment.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "account_deletion_requests_set_updated_at" BEFORE UPDATE ON "account_deletion_requests" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "accounts_set_updated_at" BEFORE UPDATE ON "accounts" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "aircraft_set_updated_at" BEFORE UPDATE ON "aircraft" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "aircraft_types_set_updated_at" BEFORE UPDATE ON "aircraft_types" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "airlines_set_updated_at" BEFORE UPDATE ON "airlines" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "airport_delay_hourly_set_updated_at" BEFORE UPDATE ON "airport_delay_hourly" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "airport_nas_events_set_updated_at" BEFORE UPDATE ON "airport_nas_events" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "airport_profiles_set_updated_at" BEFORE UPDATE ON "airport_profiles" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "airports_set_updated_at" BEFORE UPDATE ON "airports" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "api_tokens_set_updated_at" BEFORE UPDATE ON "api_tokens" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "calendar_connections_set_updated_at" BEFORE UPDATE ON "calendar_connections" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "calendar_events_set_updated_at" BEFORE UPDATE ON "calendar_events" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "currency_rates_set_updated_at" BEFORE UPDATE ON "currency_rates" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "data_export_jobs_set_updated_at" BEFORE UPDATE ON "data_export_jobs" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "devices_set_updated_at" BEFORE UPDATE ON "devices" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "email_accounts_set_updated_at" BEFORE UPDATE ON "email_accounts" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "email_extractions_set_updated_at" BEFORE UPDATE ON "email_extractions" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "entitlements_set_updated_at" BEFORE UPDATE ON "entitlements" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "flight_designators_set_updated_at" BEFORE UPDATE ON "flight_designators" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "flight_instances_set_updated_at" BEFORE UPDATE ON "flight_instances" FOR EACH ROW WHEN (OLD."id" IS DISTINCT FROM NEW."id" OR OLD."operating_carrier_icao" IS DISTINCT FROM NEW."operating_carrier_icao" OR OLD."flight_number" IS DISTINCT FROM NEW."flight_number" OR OLD."scheduled_departure_date" IS DISTINCT FROM NEW."scheduled_departure_date" OR OLD."origin_icao" IS DISTINCT FROM NEW."origin_icao" OR OLD."leg_seq" IS DISTINCT FROM NEW."leg_seq" OR OLD."origin_airport_id" IS DISTINCT FROM NEW."origin_airport_id" OR OLD."origin_tz" IS DISTINCT FROM NEW."origin_tz" OR OLD."destination_icao" IS DISTINCT FROM NEW."destination_icao" OR OLD."destination_airport_id" IS DISTINCT FROM NEW."destination_airport_id" OR OLD."diverted_to_icao" IS DISTINCT FROM NEW."diverted_to_icao" OR OLD."status" IS DISTINCT FROM NEW."status" OR OLD."scheduled_out" IS DISTINCT FROM NEW."scheduled_out" OR OLD."estimated_out" IS DISTINCT FROM NEW."estimated_out" OR OLD."actual_out" IS DISTINCT FROM NEW."actual_out" OR OLD."scheduled_off" IS DISTINCT FROM NEW."scheduled_off" OR OLD."estimated_off" IS DISTINCT FROM NEW."estimated_off" OR OLD."actual_off" IS DISTINCT FROM NEW."actual_off" OR OLD."scheduled_on" IS DISTINCT FROM NEW."scheduled_on" OR OLD."estimated_on" IS DISTINCT FROM NEW."estimated_on" OR OLD."actual_on" IS DISTINCT FROM NEW."actual_on" OR OLD."scheduled_in" IS DISTINCT FROM NEW."scheduled_in" OR OLD."estimated_in" IS DISTINCT FROM NEW."estimated_in" OR OLD."actual_in" IS DISTINCT FROM NEW."actual_in" OR OLD."origin_terminal" IS DISTINCT FROM NEW."origin_terminal" OR OLD."origin_gate" IS DISTINCT FROM NEW."origin_gate" OR OLD."destination_terminal" IS DISTINCT FROM NEW."destination_terminal" OR OLD."destination_gate" IS DISTINCT FROM NEW."destination_gate" OR OLD."baggage_claim" IS DISTINCT FROM NEW."baggage_claim" OR OLD."aircraft_type_icao" IS DISTINCT FROM NEW."aircraft_type_icao" OR OLD."registration" IS DISTINCT FROM NEW."registration" OR OLD."icao_hex" IS DISTINCT FROM NEW."icao_hex" OR OLD."inbound_flight_instance_id" IS DISTINCT FROM NEW."inbound_flight_instance_id" OR OLD."aeroapi_fa_flight_id" IS DISTINCT FROM NEW."aeroapi_fa_flight_id" OR OLD."aerodatabox_ref" IS DISTINCT FROM NEW."aerodatabox_ref" OR OLD."tracking_state" IS DISTINCT FROM NEW."tracking_state" OR OLD."refresh_cadence" IS DISTINCT FROM NEW."refresh_cadence" OR OLD."next_refresh_at" IS DISTINCT FROM NEW."next_refresh_at" OR OLD."last_refreshed_at" IS DISTINCT FROM NEW."last_refreshed_at" OR OLD."provider_call_count" IS DISTINCT FROM NEW."provider_call_count" OR OLD."provider_cost_units" IS DISTINCT FROM NEW."provider_cost_units" OR OLD."subscriber_count" IS DISTINCT FROM NEW."subscriber_count" OR OLD."do_schema_version" IS DISTINCT FROM NEW."do_schema_version" OR OLD."superseded_by_id" IS DISTINCT FROM NEW."superseded_by_id" OR OLD."supersede_reason" IS DISTINCT FROM NEW."supersede_reason" OR OLD."finished_at" IS DISTINCT FROM NEW."finished_at" OR OLD."events_r2_key" IS DISTINCT FROM NEW."events_r2_key" OR OLD."timeline_summary" IS DISTINCT FROM NEW."timeline_summary" OR OLD."created_at" IS DISTINCT FROM NEW."created_at" OR OLD."updated_at" IS DISTINCT FROM NEW."updated_at") EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "flight_subscriptions_set_updated_at" BEFORE UPDATE ON "flight_subscriptions" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "ics_feed_tokens_set_updated_at" BEFORE UPDATE ON "ics_feed_tokens" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "import_rows_set_updated_at" BEFORE UPDATE ON "import_rows" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "imports_set_updated_at" BEFORE UPDATE ON "imports" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "inbound_addresses_set_updated_at" BEFORE UPDATE ON "inbound_addresses" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "live_activities_set_updated_at" BEFORE UPDATE ON "live_activities" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "logbook_entries_set_updated_at" BEFORE UPDATE ON "logbook_entries" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "meet_me_sessions_set_updated_at" BEFORE UPDATE ON "meet_me_sessions" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "notification_preferences_set_updated_at" BEFORE UPDATE ON "notification_preferences" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "provider_alert_registrations_set_updated_at" BEFORE UPDATE ON "provider_alert_registrations" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "provider_budget_config_set_updated_at" BEFORE UPDATE ON "provider_budget_config" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "provider_call_daily_set_updated_at" BEFORE UPDATE ON "provider_call_daily" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "push_tokens_set_updated_at" BEFORE UPDATE ON "push_tokens" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "regional_operators_set_updated_at" BEFORE UPDATE ON "regional_operators" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "sessions_set_updated_at" BEFORE UPDATE ON "sessions" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "share_links_set_updated_at" BEFORE UPDATE ON "share_links" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "subscriptions_set_updated_at" BEFORE UPDATE ON "subscriptions" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "trip_members_set_updated_at" BEFORE UPDATE ON "trip_members" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "trips_set_updated_at" BEFORE UPDATE ON "trips" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "usage_counters_set_updated_at" BEFORE UPDATE ON "usage_counters" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "user_keys_set_updated_at" BEFORE UPDATE ON "user_keys" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "user_preferences_set_updated_at" BEFORE UPDATE ON "user_preferences" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "user_stats_yearly_set_updated_at" BEFORE UPDATE ON "user_stats_yearly" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "users_set_updated_at" BEFORE UPDATE ON "users" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER "verifications_set_updated_at" BEFORE UPDATE ON "verifications" FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION set_updated_at();
