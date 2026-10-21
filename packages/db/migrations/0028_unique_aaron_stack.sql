CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`estimated` integer DEFAULT false NOT NULL,
	`ref_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created_idx` ON `ai_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_usage_org_created_idx` ON `ai_usage` (`org_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ai_usage_feature_ref_uq` ON `ai_usage` (`feature`,`ref_id`);--> statement-breakpoint
ALTER TABLE `org` ADD `paused_at` integer;--> statement-breakpoint
ALTER TABLE `org` ADD `paused_reason` text;--> statement-breakpoint
ALTER TABLE `org` ADD `paused_by` text;