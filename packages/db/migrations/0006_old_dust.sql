CREATE TABLE `video_project` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`draft_id` text,
	`context_item_id` text,
	`timeline` text NOT NULL,
	`model` text NOT NULL,
	`revisions` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `video_org_idx` ON `video_project` (`org_id`,`created_at`);