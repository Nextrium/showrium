ALTER TABLE `brief` ADD `instructions` text;--> statement-breakpoint
ALTER TABLE `brief` ADD `stance` text DEFAULT 'own' NOT NULL;--> statement-breakpoint
ALTER TABLE `brief` ADD `research` text;--> statement-breakpoint
ALTER TABLE `usage_counter` ADD `research_runs` integer DEFAULT 0 NOT NULL;