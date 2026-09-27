ALTER TABLE `org` ADD `personal_owner_user_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `org_personal_owner_user_id_unique` ON `org` (`personal_owner_user_id`);