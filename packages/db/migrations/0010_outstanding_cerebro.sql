ALTER TABLE `org` ADD `full_access` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `org` ADD `full_access_note` text;--> statement-breakpoint
ALTER TABLE `org` ADD `full_access_by` text;--> statement-breakpoint
ALTER TABLE `org` ADD `full_access_at` integer;