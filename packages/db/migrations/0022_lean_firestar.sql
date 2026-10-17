ALTER TABLE `autopilot` ADD `timezone` text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot` ADD `windows` text DEFAULT '["morning","midday","afternoon","evening"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot` ADD `per_day` text DEFAULT '{}' NOT NULL;