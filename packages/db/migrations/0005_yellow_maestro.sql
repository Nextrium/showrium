CREATE TABLE `connection` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`platform` text NOT NULL,
	`account_id` text NOT NULL,
	`handle` text NOT NULL,
	`secret` text NOT NULL,
	`expires_at` integer,
	`meta` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_org_platform_account_uq` ON `connection` (`org_id`,`platform`,`account_id`);--> statement-breakpoint
CREATE INDEX `connection_org_idx` ON `connection` (`org_id`);--> statement-breakpoint
CREATE TABLE `mastodon_app` (
	`instance` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_state` (
	`state` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`platform` text NOT NULL,
	`code_verifier` text NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `draft` ADD `connection_id` text;--> statement-breakpoint
ALTER TABLE `draft` ADD `publish_method` text;