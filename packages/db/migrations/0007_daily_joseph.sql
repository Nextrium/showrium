CREATE TABLE `autopilot` (
	`org_id` text PRIMARY KEY NOT NULL,
	`level` text DEFAULT 'coach' NOT NULL,
	`mode` text DEFAULT 'build_in_public' NOT NULL,
	`platforms` text DEFAULT '[]' NOT NULL,
	`posts_per_week` integer DEFAULT 3 NOT NULL,
	`publish_hour_utc` integer DEFAULT 14 NOT NULL,
	`last_run_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `autopilot_run_idx` ON `autopilot` (`level`,`last_run_at`);--> statement-breakpoint
CREATE TABLE `engagement` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`platform` text NOT NULL,
	`origin` text NOT NULL,
	`external_id` text,
	`author` text DEFAULT '' NOT NULL,
	`text` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `engagement_org_external_uq` ON `engagement` (`org_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `engagement_org_created_idx` ON `engagement` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `engagement_draft_idx` ON `engagement` (`draft_id`);--> statement-breakpoint
CREATE TABLE `idea` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`context_item_id` text NOT NULL,
	`reason` text NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`drafted_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`context_item_id`) REFERENCES `context_item`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idea_org_context_uq` ON `idea` (`org_id`,`context_item_id`);--> statement-breakpoint
CREATE INDEX `idea_org_status_idx` ON `idea` (`org_id`,`status`,`score`);--> statement-breakpoint
CREATE TABLE `insight` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`themes` text NOT NULL,
	`based_on` integer NOT NULL,
	`model` text NOT NULL,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `insight_org_idx` ON `insight` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `post_metrics` (
	`draft_id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`likes` integer DEFAULT 0 NOT NULL,
	`replies` integer DEFAULT 0 NOT NULL,
	`reposts` integer DEFAULT 0 NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
