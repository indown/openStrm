CREATE TABLE `agent_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_id` text NOT NULL,
	`token_name` text DEFAULT '' NOT NULL,
	`ip` text DEFAULT '' NOT NULL,
	`tool` text NOT NULL,
	`args` text DEFAULT '' NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error` text DEFAULT '' NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_audit_token_idx` ON `agent_audit` (`token_id`,`at`);--> statement-breakpoint
CREATE INDEX `agent_audit_at_idx` ON `agent_audit` (`at`);--> statement-breakpoint
CREATE TABLE `api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'manual' NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`toolsets` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer,
	`last_used_at` integer,
	`last_used_ip` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_hash_uniq` ON `api_tokens` (`token_hash`);