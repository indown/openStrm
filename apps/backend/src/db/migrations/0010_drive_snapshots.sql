CREATE TABLE `drive_snapshots` (
	`account_name` text NOT NULL,
	`root_path` text NOT NULL,
	`entries` text DEFAULT '[]' NOT NULL,
	`scanned_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`account_name`, `root_path`)
);
--> statement-breakpoint
ALTER TABLE `life_events` ADD `kind` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `life_events` ADD `path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `life_events` ADD `old_path` text DEFAULT '' NOT NULL;