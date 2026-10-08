CREATE TABLE `post_image` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`brief_id` text,
	`draft_id` text,
	`position` integer DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`alt` text DEFAULT '' NOT NULL,
	`original` text NOT NULL,
	`variants` text DEFAULT '{}' NOT NULL,
	`ai_generated` integer DEFAULT false NOT NULL,
	`source_url` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `org`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`brief_id`) REFERENCES `brief`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `draft`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_image_brief_idx` ON `post_image` (`org_id`,`brief_id`,`position`);--> statement-breakpoint
CREATE INDEX `post_image_draft_idx` ON `post_image` (`org_id`,`draft_id`,`position`);--> statement-breakpoint
ALTER TABLE `draft` ADD `own_images` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Copy each existing single image (Sprint 6) into post_image as that post's own image. Nothing is deleted.
INSERT INTO `post_image` (`id`, `org_id`, `brief_id`, `draft_id`, `position`, `source`, `alt`, `original`, `variants`, `ai_generated`, `source_url`)
SELECT 'img_m_' || `id`, `org_id`, NULL, `id`, 0,
  coalesce(json_extract(`image`, '$.source'), 'upload'),
  coalesce(json_extract(`image`, '$.alt'), ''),
  json_object('key', json_extract(`image`, '$.key'), 'mime', json_extract(`image`, '$.mime'), 'bytes', json_extract(`image`, '$.bytes'), 'width', json_extract(`image`, '$.width'), 'height', json_extract(`image`, '$.height')),
  '{}',
  coalesce(json_extract(`image`, '$.aiGenerated'), 0),
  json_extract(`image`, '$.sourceUrl')
FROM `draft` WHERE `image` IS NOT NULL AND json_extract(`image`, '$.key') IS NOT NULL;
--> statement-breakpoint
UPDATE `draft` SET `own_images` = 1 WHERE `image` IS NOT NULL AND json_extract(`image`, '$.key') IS NOT NULL;
