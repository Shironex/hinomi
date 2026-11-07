CREATE TABLE `fix_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`fix_plan_id` integer,
	`plan_scan_run_id` integer NOT NULL,
	`plan_version` integer NOT NULL,
	`runner` text NOT NULL,
	`kind` text NOT NULL,
	`correlation_id` text NOT NULL,
	`branch` text NOT NULL,
	`checks_mode` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`state_reason` text,
	`github_run_id` integer,
	`github_run_attempt` integer,
	`head_sha` text,
	`pr_number` integer,
	`pr_url` text,
	`pr_draft` integer DEFAULT false NOT NULL,
	`merge_sha` text,
	`result` text,
	`run_etag` text,
	`pr_etag` text,
	`checks_etag` text,
	`created_at` integer NOT NULL,
	`dispatched_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`pushed_at` integer,
	`pr_opened_at` integer,
	`checks_updated_at` integer,
	`merged_at` integer,
	`closed_at` integer,
	`deployed_at` integer,
	`rescanned_at` integer,
	`ended_at` integer,
	`state_changed_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`fix_plan_id`) REFERENCES `fix_plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fix_runs_correlation_unique` ON `fix_runs` (`correlation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `fix_runs_github_run_unique` ON `fix_runs` (`repo_id`,`github_run_id`);--> statement-breakpoint
CREATE INDEX `fix_runs_repo_kind_idx` ON `fix_runs` (`repo_id`,`kind`,`id`);--> statement-breakpoint
CREATE INDEX `fix_runs_state_idx` ON `fix_runs` (`state`);--> statement-breakpoint
CREATE INDEX `fix_runs_plan_idx` ON `fix_runs` (`fix_plan_id`);