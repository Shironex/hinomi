ALTER TABLE `findings` ADD `fixed_on_default_branch` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `release_tier` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `latest_release_tag` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `latest_release_at` integer;--> statement-breakpoint
ALTER TABLE `repos` ADD `release_installers` integer;--> statement-breakpoint
ALTER TABLE `repos` ADD `release_checked_at` integer;