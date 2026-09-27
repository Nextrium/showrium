CREATE TABLE `brief` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`context_item_id` text,
	`mode` text NOT NULL,
	`angle` text NOT NULL,
	`key_points` text NOT NULL,
	`model` text NOT NULL,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_item_id`) REFERENCES `context_item`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `brief_org_idx` ON `brief` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `context_item` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`source_id` text,
	`kind` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`url` text,
	`external_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `source`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `context_org_created_idx` ON `context_item` (`org_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `context_org_external_uq` ON `context_item` (`org_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `draft` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`brief_id` text,
	`platform` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`issues` text DEFAULT '[]' NOT NULL,
	`ai_generated` integer DEFAULT true NOT NULL,
	`scheduled_at` integer,
	`published_at` integer,
	`external_post_id` text,
	`external_url` text,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brief_id`) REFERENCES `brief`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `draft_org_status_idx` ON `draft` (`org_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `draft_due_idx` ON `draft` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE TABLE `persona` (
	`org_id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`expertise` text DEFAULT '[]' NOT NULL,
	`interests` text DEFAULT '[]' NOT NULL,
	`audience` text DEFAULT '' NOT NULL,
	`voice` text DEFAULT '' NOT NULL,
	`avoid` text DEFAULT '[]' NOT NULL,
	`blockers` text DEFAULT '[]' NOT NULL,
	`platforms` text DEFAULT '[]' NOT NULL,
	`monetization_safe` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `source` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`last_checked_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_org_kind_key_uq` ON `source` (`org_id`,`kind`,`key`);--> statement-breakpoint
CREATE TABLE `usage_counter` (
	`org_id` text NOT NULL,
	`period` text NOT NULL,
	`posts_generated` integer DEFAULT 0 NOT NULL,
	`videos_rendered` integer DEFAULT 0 NOT NULL,
	`x_api_posts` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_org_period_uq` ON `usage_counter` (`org_id`,`period`);