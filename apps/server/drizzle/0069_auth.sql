CREATE TABLE `audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`action` text NOT NULL,
	`actor` text,
	`ip` text,
	`method` text,
	`path` text,
	`status` integer,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE TABLE `auth_passkeys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`algorithm` integer NOT NULL,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`name` text NOT NULL,
	`transports` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_passkeys_credential_unique` ON `auth_passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`csrf_token` text NOT NULL,
	`method` text NOT NULL,
	`subject` text NOT NULL,
	`passkey_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_public_id_unique` ON `auth_sessions` (`public_id`);