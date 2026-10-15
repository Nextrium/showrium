ALTER TABLE `autopilot` ADD `find_ideas` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot` ADD `rules` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot` ADD `mix` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot` ADD `days` text DEFAULT '[0,1,2,3,4,5,6]' NOT NULL;--> statement-breakpoint
ALTER TABLE `autopilot` ADD `week_log` text DEFAULT '[]' NOT NULL;