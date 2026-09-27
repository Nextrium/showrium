CREATE TABLE `waitlist_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`source` text DEFAULT 'website' NOT NULL,
	`invited_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `waitlist_entry_email_unique` ON `waitlist_entry` (`email`);