CREATE TABLE `library_nodes` (
	`source_id` text NOT NULL,
	`node_id` text NOT NULL,
	`parent_id` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`is_dir` integer NOT NULL,
	`depth` integer NOT NULL,
	`size` integer,
	`token` text,
	`gen` integer NOT NULL,
	`listed_gen` integer DEFAULT 0 NOT NULL,
	`video_count` integer DEFAULT 0 NOT NULL,
	`video_total` integer DEFAULT 0 NOT NULL,
	`missing` integer DEFAULT false NOT NULL,
	`search_text` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`source_id`, `node_id`),
	FOREIGN KEY (`source_id`) REFERENCES `media_library`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `library_nodes_parent_idx` ON `library_nodes` (`source_id`,`parent_id`);--> statement-breakpoint
CREATE INDEX `library_nodes_crawl_idx` ON `library_nodes` (`source_id`,`is_dir`,`listed_gen`);--> statement-breakpoint
CREATE TABLE `library_shares` (
	`share_code` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'unknown' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`fail_streak` integer DEFAULT 0 NOT NULL,
	`checked_at` integer,
	`last_ok_at` integer,
	`expired_at` integer,
	`next_check_at` integer
);
--> statement-breakpoint
ALTER TABLE `media_library` ADD `share_title` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `index_status` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `index_error` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `index_gen` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `indexed_at` integer;--> statement-breakpoint
ALTER TABLE `media_library` ADD `index_started_at` integer;--> statement-breakpoint
ALTER TABLE `media_library` ADD `index_retry_at` integer;--> statement-breakpoint
ALTER TABLE `media_library` ADD `dirs_total` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `dirs_listed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `node_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `video_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `total_size` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_library` ADD `truncated` integer DEFAULT false NOT NULL;