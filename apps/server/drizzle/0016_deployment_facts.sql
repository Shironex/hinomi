ALTER TABLE `deployments` ADD `facts` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `facts_version` text;--> statement-breakpoint
ALTER TABLE `deployments` ADD `facts_updated_at` integer;--> statement-breakpoint
ALTER TABLE `deployments` ADD `image_scanned_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `config` text;