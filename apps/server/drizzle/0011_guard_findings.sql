ALTER TABLE `findings` ADD `guard_check` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `guard_level` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `evidence` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `release_tag` text;--> statement-breakpoint
CREATE INDEX `findings_kind_check_idx` ON `findings` (`kind`,`guard_check`);