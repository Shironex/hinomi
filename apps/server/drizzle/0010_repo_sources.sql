CREATE TABLE `repo_sources` (
	`repo_id` integer NOT NULL,
	`source_id` integer NOT NULL,
	`alerts_readable` integer,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`repo_id`, `source_id`),
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `repo_sources_source_idx` ON `repo_sources` (`source_id`);--> statement-breakpoint
ALTER TABLE `repos` ADD `source_id` integer REFERENCES sources(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `repos` ADD `source_override_id` integer REFERENCES sources(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `repos_source_idx` ON `repos` (`source_id`);--> statement-breakpoint
-- Until now every repo was read through the first enabled GitHub source with a credential.
UPDATE `repos` SET `source_id` = (SELECT `id` FROM `sources` WHERE `kind` = 'github' AND `enabled` = 1 AND `token_encrypted` IS NOT NULL ORDER BY `id` LIMIT 1);
