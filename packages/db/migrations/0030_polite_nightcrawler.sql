ALTER TABLE `idea` ADD `dismissed_reason` text;--> statement-breakpoint
ALTER TABLE `idea` ADD `kept` integer DEFAULT false NOT NULL;