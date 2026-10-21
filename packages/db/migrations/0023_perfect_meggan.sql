CREATE TABLE `passion` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`about` text DEFAULT '' NOT NULL,
	`disclosure` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`starts_on` text,
	`ends_on` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passion_org_idx` ON `passion` (`org_id`);--> statement-breakpoint
ALTER TABLE `source` ADD `passion_id` text REFERENCES passion(id);