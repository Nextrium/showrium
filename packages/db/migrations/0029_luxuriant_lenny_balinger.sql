CREATE TABLE `platform_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`platform` text NOT NULL,
	`kind` text NOT NULL,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`draft_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `platform_usage_created_idx` ON `platform_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `platform_usage_org_created_idx` ON `platform_usage` (`org_id`,`created_at`);