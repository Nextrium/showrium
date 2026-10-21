ALTER TABLE `autopilot` ADD `notify_email` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot` ADD `x_consent_at` integer;--> statement-breakpoint
ALTER TABLE `context_item` ADD `published_at` integer;--> statement-breakpoint
ALTER TABLE `draft` ADD `auto_approved` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `draft` ADD `auto_scheduled` integer DEFAULT false NOT NULL;