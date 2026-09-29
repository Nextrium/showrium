CREATE TABLE `image_setting` (
	`org_id` text PRIMARY KEY NOT NULL,
	`sizes` text DEFAULT '{}' NOT NULL,
	`auto` integer DEFAULT true NOT NULL,
	`allow_ai` integer DEFAULT true NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `draft` ADD `image` text;