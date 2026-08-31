CREATE TABLE `share_follows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`library_id` text,
	`share_url` text DEFAULT '' NOT NULL,
	`share_code` text NOT NULL,
	`receive_code` text DEFAULT '' NOT NULL,
	`watch_cid` text DEFAULT '0' NOT NULL,
	`watch_path` text DEFAULT '' NOT NULL,
	`scope` text DEFAULT '[""]' NOT NULL,
	`task_id` text NOT NULL,
	`sub_path` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`interval_minutes` integer DEFAULT 360 NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`error_streak` integer DEFAULT 0 NOT NULL,
	`last_checked_at` integer,
	`last_change_at` integer,
	`next_check_at` integer DEFAULT 0 NOT NULL,
	`known` text DEFAULT '[]' NOT NULL,
	`recent` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_follows_share_watch_uniq` ON `share_follows` (`share_code`,`watch_cid`);--> statement-breakpoint
CREATE INDEX `share_follows_due_idx` ON `share_follows` (`enabled`,`next_check_at`);--> statement-breakpoint
CREATE INDEX `share_follows_task_id_idx` ON `share_follows` (`task_id`);