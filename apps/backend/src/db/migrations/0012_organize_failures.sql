ALTER TABLE `organize_items` ADD `error_kind` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_items` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_items` ADD `given_up` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `organize_runs` ADD `stage` text DEFAULT 'apply' NOT NULL;--> statement-breakpoint
UPDATE `organize_runs` SET `stage` = 'revert' WHERE `status` IN ('reverted', 'reverting') OR EXISTS (SELECT 1 FROM `organize_items` WHERE `organize_items`.`run_id` = `organize_runs`.`id` AND `organize_items`.`status` = 'reverted');--> statement-breakpoint
UPDATE `organize_items` SET `error_kind` = 'mirror' WHERE `status` IN ('done', 'reverted') AND `error` LIKE '本地镜像失败%';
