CREATE TABLE `fix_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`scan_run_id` integer NOT NULL,
	`version` integer NOT NULL,
	`plan` text NOT NULL,
	`findings_cleared` integer DEFAULT 0 NOT NULL,
	`safe_steps` integer DEFAULT 0 NOT NULL,
	`risky_steps` integer DEFAULT 0 NOT NULL,
	`unfixed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scan_run_id`) REFERENCES `scan_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fix_plans_repo_scan_unique` ON `fix_plans` (`repo_id`,`scan_run_id`);--> statement-breakpoint
CREATE INDEX `fix_plans_scan_idx` ON `fix_plans` (`scan_run_id`);