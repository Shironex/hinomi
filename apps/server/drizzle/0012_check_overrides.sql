CREATE TABLE `check_overrides` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`check` text NOT NULL,
	`deployment_id` integer,
	`repo_id` integer,
	`reason` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `check_overrides_deployment_unique` ON `check_overrides` (`check`,`deployment_id`) WHERE "check_overrides"."deployment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `check_overrides_repo_unique` ON `check_overrides` (`check`,`repo_id`) WHERE "check_overrides"."repo_id" is not null;--> statement-breakpoint
CREATE INDEX `check_overrides_deployment_idx` ON `check_overrides` (`deployment_id`);--> statement-breakpoint
CREATE INDEX `check_overrides_repo_idx` ON `check_overrides` (`repo_id`);