CREATE TABLE `media_library` (
	`id` text PRIMARY KEY NOT NULL,
	`share_url` text NOT NULL,
	`share_code` text NOT NULL,
	`receive_code` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`cover_url` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_library_share_code_idx` ON `media_library` (`share_code`);--> statement-breakpoint
CREATE INDEX `media_library_updated_at_idx` ON `media_library` (`updated_at`);