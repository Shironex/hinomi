CREATE TABLE `http_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`etag` text,
	`last_modified` text,
	`fetched_at` integer NOT NULL,
	`status` integer NOT NULL,
	`body` blob NOT NULL
);
