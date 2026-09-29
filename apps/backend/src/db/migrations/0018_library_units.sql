CREATE TABLE `library_units` (
	`source_id` text NOT NULL,
	`unit_key` text NOT NULL,
	`node_id` text NOT NULL,
	`path` text NOT NULL,
	`raw_name` text NOT NULL,
	`owns_dir` integer NOT NULL,
	`file_ids` text DEFAULT '[]' NOT NULL,
	`parsed_title` text DEFAULT '' NOT NULL,
	`parsed_titles` text DEFAULT '[]' NOT NULL,
	`parsed_year` text DEFAULT '' NOT NULL,
	`kind_hint` text DEFAULT 'unknown' NOT NULL,
	`seasons` text DEFAULT '[]' NOT NULL,
	`video_count` integer DEFAULT 0 NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`sample_file` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`tmdb_id` integer,
	`media_type` text,
	`title` text DEFAULT '' NOT NULL,
	`original_title` text DEFAULT '' NOT NULL,
	`en_title` text DEFAULT '' NOT NULL,
	`year` text DEFAULT '' NOT NULL,
	`poster_url` text DEFAULT '' NOT NULL,
	`confidence` text DEFAULT 'none' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`candidates` text DEFAULT '[]' NOT NULL,
	`aka` text DEFAULT '' NOT NULL,
	`identified_at` integer,
	`retry_at` integer,
	`error` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `unit_key`),
	FOREIGN KEY (`source_id`) REFERENCES `media_library`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `library_units_tmdb_idx` ON `library_units` (`media_type`,`tmdb_id`);--> statement-breakpoint
CREATE INDEX `library_units_status_idx` ON `library_units` (`status`,`retry_at`);--> statement-breakpoint
CREATE INDEX `library_units_node_idx` ON `library_units` (`source_id`,`node_id`);--> statement-breakpoint
ALTER TABLE `library_nodes` ADD `aka` text DEFAULT '' NOT NULL;