ALTER TABLE `organize_items` ADD `error_kind` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_items` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_runs` ADD `stage` text DEFAULT 'apply' NOT NULL;--> statement-breakpoint
UPDATE `organize_runs` SET `stage` = 'revert' WHERE `status` IN ('reverted', 'reverting');--> statement-breakpoint
UPDATE `organize_items` SET `error_kind` = 'mirror' WHERE `status` = 'done' AND `error` LIKE '本地镜像失败%';
