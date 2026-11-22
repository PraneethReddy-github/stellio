CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`full_name` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`company_id` text,
	`location_text` text DEFAULT '' NOT NULL,
	`country` text,
	`profile_urls_json` text DEFAULT '[]' NOT NULL,
	`public_contact_json` text DEFAULT '[]' NOT NULL,
	`sources_json` text DEFAULT '[]' NOT NULL,
	`shared_ground_json` text DEFAULT '[]' NOT NULL,
	`dedupe_key` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`purge_after` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_dedupe_key_uq` ON `people` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `people_purge_after_idx` ON `people` (`purge_after`);--> statement-breakpoint
CREATE TABLE `referral_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`person_id` text NOT NULL,
	`job_id` text,
	`application_id` text,
	`status` text DEFAULT 'not_contacted' NOT NULL,
	`why` text DEFAULT '' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`note_text` text,
	`message_subject` text,
	`message_body` text,
	`language` text,
	`checks_json` text,
	`rules_hash` text,
	`model` text,
	`prompt_version` text,
	`contacted_at` text,
	`next_action_at` text,
	`notes_md` text,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `referral_requests_job_id_idx` ON `referral_requests` (`job_id`);--> statement-breakpoint
CREATE INDEX `referral_requests_person_id_idx` ON `referral_requests` (`person_id`);
