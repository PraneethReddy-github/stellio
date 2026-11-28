-- Side-job search profiles (part-time work for money, judged on pay, hours and distance).
ALTER TABLE `search_profiles` ADD `kind` text DEFAULT 'career' NOT NULL;
--> statement-breakpoint
ALTER TABLE `search_profiles` ADD `max_hours_per_week` integer;
--> statement-breakpoint
ALTER TABLE `search_profiles` ADD `min_hourly_pay` real;
--> statement-breakpoint
ALTER TABLE `jobs` ADD `side_job` integer DEFAULT false NOT NULL;
