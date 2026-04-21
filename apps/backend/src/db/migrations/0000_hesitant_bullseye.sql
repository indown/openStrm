CREATE TABLE `accounts` (
	`name` text PRIMARY KEY NOT NULL,
	`account_type` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_history` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`start_time` integer NOT NULL,
	`end_time` integer,
	`status` text NOT NULL,
	`logs` text DEFAULT '[]' NOT NULL,
	`summary` text DEFAULT '{}' NOT NULL,
	`task_info` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `task_history_task_id_idx` ON `task_history` (`task_id`);--> statement-breakpoint
CREATE INDEX `task_history_start_time_idx` ON `task_history` (`start_time`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`account_name` text NOT NULL,
	`data` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_account_name_idx` ON `tasks` (`account_name`);