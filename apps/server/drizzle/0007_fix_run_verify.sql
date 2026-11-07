ALTER TABLE `fix_runs` ADD `deploy_links` text;--> statement-breakpoint
ALTER TABLE `fix_runs` ADD `warnings` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `fix_runs` ADD `verification` text;