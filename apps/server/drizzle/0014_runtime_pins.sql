CREATE TABLE `runtime_pins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`ref` text NOT NULL,
	`runtime` text NOT NULL,
	`source` text NOT NULL,
	`path` text NOT NULL,
	`line` integer,
	`raw` text NOT NULL,
	`line_name` text,
	`floating` integer DEFAULT false NOT NULL,
	`kind` text NOT NULL,
	`version` text,
	`scope` text NOT NULL,
	`job` text,
	`stage` integer,
	`final_stage` integer,
	`scanned_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runtime_pins_repo_ref_idx` ON `runtime_pins` (`repo_id`,`ref`);