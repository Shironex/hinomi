ALTER TABLE `advisories` ADD `description` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `dependency_path` text;--> statement-breakpoint
ALTER TABLE `findings` ADD `state_until_new_advisory` integer DEFAULT false NOT NULL;