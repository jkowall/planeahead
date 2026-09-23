ALTER TABLE `flight_subscriptions` ADD `added_as` text;--> statement-breakpoint
ALTER TABLE `flight_subscriptions` ADD `superseded` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `last_attempt_at` integer;