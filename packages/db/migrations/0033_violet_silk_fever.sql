ALTER TABLE `ai_usage` ADD `duration_ms` integer;--> statement-breakpoint
ALTER TABLE `ai_usage` ADD `fallback` text;--> statement-breakpoint
ALTER TABLE `idea` ADD `topic_match` text;--> statement-breakpoint
ALTER TABLE `idea` ADD `relevance` real;--> statement-breakpoint
ALTER TABLE `passion` ADD `x_handles` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `passion` ADD `topics` text DEFAULT '[]' NOT NULL;