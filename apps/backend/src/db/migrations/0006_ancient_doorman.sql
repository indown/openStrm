CREATE TABLE `life_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_name` text DEFAULT '' NOT NULL,
	`type` integer NOT NULL,
	`file_id` text NOT NULL,
	`parent_id` text DEFAULT '0' NOT NULL,
	`file_name` text DEFAULT '' NOT NULL,
	`file_category` integer DEFAULT 0 NOT NULL,
	`file_size` integer DEFAULT 0 NOT NULL,
	`sha1` text DEFAULT '' NOT NULL,
	`pick_code` text DEFAULT '' NOT NULL,
	`update_time` integer DEFAULT 0 NOT NULL,
	`create_time` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`handled_at` integer
);
--> statement-breakpoint
CREATE INDEX `life_events_file_id_idx` ON `life_events` (`file_id`);--> statement-breakpoint
CREATE INDEX `life_events_update_time_idx` ON `life_events` (`update_time`);--> statement-breakpoint
CREATE INDEX `life_events_type_idx` ON `life_events` (`type`);--> statement-breakpoint
CREATE TABLE `path_cache` (
	`file_id` text PRIMARY KEY NOT NULL,
	`parent_id` text DEFAULT '0' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`path` text NOT NULL,
	`is_dir` integer DEFAULT 1 NOT NULL,
	`account_name` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `path_cache_path_idx` ON `path_cache` (`path`);--> statement-breakpoint
CREATE INDEX `path_cache_parent_id_idx` ON `path_cache` (`parent_id`);