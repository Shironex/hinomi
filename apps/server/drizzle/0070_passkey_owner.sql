ALTER TABLE `auth_passkeys` ADD `owner_method` text DEFAULT 'setup-code' NOT NULL;--> statement-breakpoint
ALTER TABLE `auth_passkeys` ADD `owner_subject` text DEFAULT 'admin' NOT NULL;