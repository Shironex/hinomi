ALTER TABLE `sources` ADD `auth` text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `app_id` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `installation_id` text;