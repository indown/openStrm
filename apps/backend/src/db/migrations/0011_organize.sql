CREATE TABLE `organize_items` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`unit_key` text DEFAULT '' NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`action` text DEFAULT 'skip' NOT NULL,
	`src_path` text DEFAULT '' NOT NULL,
	`dst_path` text DEFAULT '' NOT NULL,
	`node_id` text DEFAULT '' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`finished_at` integer,
	`cur_path` text DEFAULT '' NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `organize_items_run_idx` ON `organize_items` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `organize_items_node_idx` ON `organize_items` (`node_id`);--> statement-breakpoint
CREATE TABLE `organize_matches` (
	`account_name` text NOT NULL,
	`src_path` text NOT NULL,
	`media_type` text DEFAULT 'tv' NOT NULL,
	`tmdb_id` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`year` text DEFAULT '' NOT NULL,
	`season` integer,
	`episode_offset` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`account_name`, `src_path`)
);
--> statement-breakpoint
CREATE TABLE `organize_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`account_name` text DEFAULT '' NOT NULL,
	`scope_path` text DEFAULT '' NOT NULL,
	`scope_paths` text DEFAULT '[]' NOT NULL,
	`mode` text DEFAULT 'manual' NOT NULL,
	`trigger` text DEFAULT 'manual' NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`stats` text DEFAULT '{}' NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`log` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `organize_runs_task_idx` ON `organize_runs` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `organize_runs_status_idx` ON `organize_runs` (`status`);--> statement-breakpoint
CREATE TABLE `organize_units` (
	`run_id` text NOT NULL,
	`key` text NOT NULL,
	`root_path` text DEFAULT '' NOT NULL,
	`raw_name` text DEFAULT '' NOT NULL,
	`parsed_title` text DEFAULT '' NOT NULL,
	`parsed_year` text DEFAULT '' NOT NULL,
	`match` text,
	`season_override` integer,
	`episode_offset` integer DEFAULT 0 NOT NULL,
	`dst_root` text DEFAULT '' NOT NULL,
	`selected` integer DEFAULT true NOT NULL,
	`remember` integer DEFAULT false NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`video_count` integer DEFAULT 0 NOT NULL,
	`referenced_by` integer DEFAULT 0 NOT NULL,
	`notes` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`run_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `tmdb_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text DEFAULT '{}' NOT NULL,
	`fetched_at` integer DEFAULT 0 NOT NULL
);
