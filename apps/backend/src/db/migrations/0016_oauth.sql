CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`redirect_uris` text DEFAULT '[]' NOT NULL,
	`secret_hash` text,
	`scope` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`fetched_at` integer,
	`cache_until` integer,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `oauth_clients_kind_idx` ON `oauth_clients` (`kind`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text DEFAULT '' NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`toolsets` text NOT NULL,
	`offline` integer DEFAULT false NOT NULL,
	`resource` text NOT NULL,
	`access_hash` text NOT NULL,
	`access_expires_at` integer NOT NULL,
	`prev_access_hash` text,
	`prev_access_expires_at` integer,
	`refresh_hash` text NOT NULL,
	`refresh_expires_at` integer NOT NULL,
	`approved_via` text,
	`approved_at` integer,
	`request_ip` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer,
	`last_used_ip` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_access_uniq` ON `oauth_grants` (`access_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_prev_access_uniq` ON `oauth_grants` (`prev_access_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_refresh_uniq` ON `oauth_grants` (`refresh_hash`);--> statement-breakpoint
CREATE INDEX `oauth_grants_client_idx` ON `oauth_grants` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`poll_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text DEFAULT '' NOT NULL,
	`client_kind` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`state` text,
	`code_challenge` text NOT NULL,
	`requested_scope` text DEFAULT '' NOT NULL,
	`resource` text NOT NULL,
	`pairing_code` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`granted_scopes` text,
	`granted_toolsets` text,
	`approved_via` text,
	`code_hash` text,
	`code_expires_at` integer,
	`used_at` integer,
	`grant_id` text,
	`ip` text DEFAULT '' NOT NULL,
	`ip_key` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_requests_code_uniq` ON `oauth_requests` (`code_hash`);--> statement-breakpoint
CREATE INDEX `oauth_requests_status_idx` ON `oauth_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `oauth_requests_ip_key_idx` ON `oauth_requests` (`ip_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `oauth_used_refresh` (
	`hash` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`used_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `oauth_used_refresh_used_at_idx` ON `oauth_used_refresh` (`used_at`);