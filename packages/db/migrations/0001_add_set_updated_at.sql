-- Custom migration (drizzle-kit generate --custom --name add_set_updated_at), body written by
-- scripts/gen-updated-at-migration.mjs. set_updated_at() stamps updated_at on every UPDATE so
-- writers that bypass Drizzle (queue consumers, raw SQL, admin tools) keep the column honest.
-- The WHEN clause skips no-op updates so the sync feed does not see phantom changes; tables
-- with a generated column cannot carry it (Postgres restriction) and always bump. The migrator
-- splits this file on the breakpoint marker: one marker separates the function from each
-- CREATE TRIGGER and none may appear inside the dollar-quoted body, not even in a comment.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
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
CREATE TRIGGER "flight_instances_set_updated_at" BEFORE UPDATE ON "flight_instances" FOR EACH ROW EXECUTE FUNCTION set_updated_at();
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
