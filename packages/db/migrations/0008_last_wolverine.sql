CREATE TABLE `payment_event` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_key` text NOT NULL,
	`type` text NOT NULL,
	`org_id` text,
	`outcome` text DEFAULT 'received' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_event_provider_key_uq` ON `payment_event` (`provider`,`event_key`);--> statement-breakpoint
CREATE INDEX `payment_event_org_idx` ON `payment_event` (`org_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`plan` text NOT NULL,
	`interval` text NOT NULL,
	`status` text NOT NULL,
	`provider_subscription_id` text NOT NULL,
	`provider_customer_id` text,
	`current_period_end` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_org_id_unique` ON `subscription` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_provider_sub_uq` ON `subscription` (`provider`,`provider_subscription_id`);--> statement-breakpoint
CREATE TABLE `team_invite` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by_user_id` text,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`accepted_by_user_id` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `team_invite_token_hash_unique` ON `team_invite` (`token_hash`);--> statement-breakpoint
CREATE INDEX `team_invite_org_idx` ON `team_invite` (`org_id`,`created_at`);