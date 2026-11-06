CREATE TABLE `advisories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`advisory_key` text NOT NULL,
	`ghsa_id` text,
	`cve_ids` text DEFAULT '[]' NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`ecosystem` text NOT NULL,
	`package_name` text NOT NULL,
	`severity` text DEFAULT 'unknown' NOT NULL,
	`cvss_score` real,
	`cvss_vector` text,
	`summary` text,
	`url` text,
	`vulnerable_ranges` text DEFAULT '[]' NOT NULL,
	`first_patched_version` text,
	`published_at` integer,
	`withdrawn_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `advisories_key_package_unique` ON `advisories` (`advisory_key`,`ecosystem`,`package_name`);--> statement-breakpoint
CREATE INDEX `advisories_ghsa_idx` ON `advisories` (`ghsa_id`);--> statement-breakpoint
CREATE TABLE `deployment_repo_overrides` (
	`deployment_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`deployment_id`, `repo_id`),
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deployment_repo_overrides_repo_idx` ON `deployment_repo_overrides` (`repo_id`);--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`domains` text DEFAULT '[]' NOT NULL,
	`reach` text DEFAULT 'unknown' NOT NULL,
	`server` text,
	`status` text,
	`image` text,
	`git_repository` text,
	`git_branch` text,
	`repo_id` integer,
	`last_deployed_at` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deployments_source_external_unique` ON `deployments` (`source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `deployments_repo_idx` ON `deployments` (`repo_id`);--> statement-breakpoint
CREATE TABLE `finding_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`finding_id` integer NOT NULL,
	`type` text NOT NULL,
	`from_state` text,
	`to_state` text,
	`reason` text,
	`until` integer,
	`actor` text DEFAULT 'system' NOT NULL,
	`data` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `finding_events_finding_idx` ON `finding_events` (`finding_id`,`at`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dedupe_key` text NOT NULL,
	`kind` text NOT NULL,
	`advisory_id` integer,
	`blind_spot_type` text,
	`repo_id` integer,
	`deployment_id` integer,
	`scope` text DEFAULT 'unknown' NOT NULL,
	`reported_by` text DEFAULT '[]' NOT NULL,
	`manifest_paths` text DEFAULT '[]' NOT NULL,
	`installed_version` text,
	`state` text DEFAULT 'open' NOT NULL,
	`state_reason` text,
	`state_until` integer,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`fixed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`advisory_id`) REFERENCES `advisories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_dedupe_key_unique` ON `findings` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `findings_repo_idx` ON `findings` (`repo_id`);--> statement-breakpoint
CREATE INDEX `findings_advisory_idx` ON `findings` (`advisory_id`);--> statement-breakpoint
CREATE INDEX `findings_deployment_idx` ON `findings` (`deployment_id`);--> statement-breakpoint
CREATE INDEX `findings_state_idx` ON `findings` (`state`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`default_branch` text,
	`archived` integer DEFAULT false NOT NULL,
	`alerts_enabled` integer,
	`last_scanned_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_owner_name_unique` ON `repos` (`owner`,`name`);--> statement-breakpoint
CREATE TABLE `scan_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`source_results` text DEFAULT '{}' NOT NULL,
	`findings_opened` integer DEFAULT 0 NOT NULL,
	`findings_fixed` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `scan_runs_started_idx` ON `scan_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text,
	`token_encrypted` text,
	`enabled` integer DEFAULT true NOT NULL,
	`last_ok_at` integer,
	`last_error_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_kind_name_unique` ON `sources` (`kind`,`name`);