CREATE TABLE `library_saves` (
	`source_id` text NOT NULL,
	`unit_key` text NOT NULL,
	`task_id` text NOT NULL,
	`sub_path` text DEFAULT '' NOT NULL,
	`saved_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `unit_key`, `task_id`),
	FOREIGN KEY (`source_id`) REFERENCES `media_library`(`id`) ON UPDATE no action ON DELETE cascade
);
