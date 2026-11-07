ALTER TABLE `repos` ADD `runner_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `runner_workflow` text;