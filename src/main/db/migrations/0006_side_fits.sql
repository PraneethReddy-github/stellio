-- Side-job check (the Fit tab of a side job): pay, hours, place, language and needs, each with a quote.
CREATE TABLE `side_fits` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`job_id` text NOT NULL,
	`profile_hash` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`score` integer NOT NULL,
	`verdict` text NOT NULL,
	`summary` text NOT NULL,
	`result_json` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `side_fits_job_idx` ON `side_fits` (`job_id`,`created_at`,`id`);
