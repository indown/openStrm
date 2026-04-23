PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_media_library` (
	`id` text PRIMARY KEY NOT NULL,
	`share_url` text NOT NULL,
	`share_code` text NOT NULL,
	`receive_code` text DEFAULT '' NOT NULL,
	`share_path` text DEFAULT '' NOT NULL,
	`share_root_cid` text DEFAULT '' NOT NULL,
	`share_receive_ids` text DEFAULT '[]' NOT NULL,
	`raw_name` text DEFAULT '' NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`cover_url` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`media_type` text DEFAULT 'unknown' NOT NULL,
	`tmdb_id` integer,
	`year` text DEFAULT '' NOT NULL,
	`overview` text DEFAULT '' NOT NULL,
	`scrape_status` text DEFAULT 'done' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_media_library`("id", "share_url", "share_code", "receive_code", "share_path", "share_root_cid", "share_receive_ids", "raw_name", "title", "file_count", "cover_url", "tags", "notes", "media_type", "tmdb_id", "year", "overview", "scrape_status", "created_at", "updated_at") SELECT "id", "share_url", "share_code", "receive_code", "share_path", "share_root_cid", "share_receive_ids", "raw_name", "title", "file_count", "cover_url", "tags", "notes", "media_type", "tmdb_id", "year", "overview", "scrape_status", "created_at", "updated_at" FROM `media_library`;--> statement-breakpoint
DROP TABLE `media_library`;--> statement-breakpoint
ALTER TABLE `__new_media_library` RENAME TO `media_library`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `media_library_share_code_idx` ON `media_library` (`share_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_library_share_code_path_uniq` ON `media_library` (`share_code`,`share_path`);--> statement-breakpoint
CREATE INDEX `media_library_updated_at_idx` ON `media_library` (`updated_at`);--> statement-breakpoint
CREATE INDEX `media_library_scrape_status_idx` ON `media_library` (`scrape_status`);