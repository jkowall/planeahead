ALTER TABLE `outbox` ADD `seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `entity_id` text;--> statement-breakpoint
CREATE INDEX `outbox_seq_idx` ON `outbox` (`seq`);--> statement-breakpoint
ALTER TABLE `sync_state` ADD `reset_pending` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `sync_state` ADD `store_version` text;