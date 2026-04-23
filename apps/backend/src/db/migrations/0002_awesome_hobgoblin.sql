ALTER TABLE `media_library` ADD `share_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `share_root_cid` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `raw_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `media_type` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `tmdb_id` integer;--> statement-breakpoint
ALTER TABLE `media_library` ADD `year` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `overview` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `scrape_status` text DEFAULT 'done' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `media_library_share_code_path_uniq` ON `media_library` (`share_code`,`share_path`);--> statement-breakpoint
CREATE INDEX `media_library_scrape_status_idx` ON `media_library` (`scrape_status`);