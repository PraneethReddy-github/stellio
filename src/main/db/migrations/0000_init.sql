CREATE TABLE `ai_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`task` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`input_hash` text,
	`started_at` text NOT NULL,
	`duration_ms` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_code` integer,
	`tokens_json` text,
	`error` text,
	`related_type` text,
	`related_id` text
);
--> statement-breakpoint
CREATE INDEX `ai_runs_started_at_idx` ON `ai_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`job_id` text NOT NULL,
	`profile_hash` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`fit_score` integer,
	`verdict` text,
	`summary` text,
	`result_json` text,
	`triage` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `application_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`application_id` text NOT NULL,
	`contact_id` text NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_contacts_uq` ON `application_contacts` (`application_id`,`contact_id`);--> statement-breakpoint
CREATE TABLE `application_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`application_id` text NOT NULL,
	`type` text NOT NULL,
	`from_status` text,
	`to_status` text,
	`at` text NOT NULL,
	`payload_json` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `application_events_application_id_at_idx` ON `application_events` (`application_id`,`at`);--> statement-breakpoint
CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`job_id` text NOT NULL,
	`status` text DEFAULT 'saved' NOT NULL,
	`status_changed_at` text NOT NULL,
	`applied_at` text,
	`channel` text,
	`priority` integer,
	`next_action` text,
	`next_action_at` text,
	`folder_path` text,
	`resume_doc_id` text,
	`cover_doc_id` text,
	`salary_expectation` text,
	`notes_md` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resume_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`cover_doc_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `applications_job_id_unique` ON `applications` (`job_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`name` text NOT NULL,
	`domain` text,
	`careers_url` text,
	`ats_type` text,
	`ats_slug` text,
	`watch` integer DEFAULT false NOT NULL,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`company_id` text,
	`name` text NOT NULL,
	`role` text,
	`email` text,
	`linkedin_url` text,
	`notes_md` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`application_id` text,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`tex` text NOT NULL,
	`pdf_path` text,
	`profile_hash` text,
	`rules_hash` text,
	`template_hash` text,
	`model` text,
	`prompt_version` text,
	`truth_report_json` text,
	`ats_report_json` text,
	`user_edited` integer DEFAULT false NOT NULL,
	`is_final` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `interviews` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`application_id` text NOT NULL,
	`round` integer DEFAULT 1 NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`scheduled_at` text,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`notes_md` text,
	FOREIGN KEY (`application_id`) REFERENCES `applications`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `job_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`job_id` text NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text,
	`raw_json` text,
	`fetched_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_sources_source_external_id_uq` ON `job_sources` (`source`,`external_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`company_id` text NOT NULL,
	`title` text NOT NULL,
	`location_text` text,
	`country` text,
	`remote` text DEFAULT 'unknown' NOT NULL,
	`employment_type` text,
	`seniority` text,
	`salary_min` integer,
	`salary_max` integer,
	`salary_currency` text,
	`salary_period` text,
	`language` text,
	`url` text,
	`apply_url` text,
	`posted_at` text,
	`deadline_at` text,
	`description_md` text DEFAULT '' NOT NULL,
	`description_hash` text,
	`structured_json` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`closed_at` text,
	`dedupe_key` text NOT NULL,
	`state` text DEFAULT 'new' NOT NULL,
	`dismiss_reason` text,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_key_uq` ON `jobs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `jobs_state_idx` ON `jobs` (`state`);--> statement-breakpoint
CREATE TABLE `learning_items` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`skill` text NOT NULL,
	`priority` integer DEFAULT 3 NOT NULL,
	`reason` text,
	`target_level` integer,
	`est_hours` integer,
	`status` text DEFAULT 'todo' NOT NULL,
	`resources_md` text,
	`linked_jobs` integer DEFAULT 0 NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `scan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`per_source_json` text,
	`new_jobs` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `search_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`name` text NOT NULL,
	`roles` text DEFAULT '[]' NOT NULL,
	`keywords` text DEFAULT '[]' NOT NULL,
	`exclude_keywords` text DEFAULT '[]' NOT NULL,
	`locations` text DEFAULT '[]' NOT NULL,
	`remote_ok` integer DEFAULT true NOT NULL,
	`countries` text DEFAULT '[]' NOT NULL,
	`seniority` text DEFAULT '[]' NOT NULL,
	`salary_floor` integer,
	`currency` text,
	`languages` text DEFAULT '[]' NOT NULL,
	`excluded_companies` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings_kv` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `skill_audits` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`document_id` text NOT NULL,
	`skill` text NOT NULL,
	`origin` text NOT NULL,
	`jd_importance` text NOT NULL,
	`evidence_ids` text,
	`recommendation` text NOT NULL,
	`decision` text DEFAULT 'pending' NOT NULL,
	`decided_at` text,
	`rationale` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `skill_demand` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`skill` text NOT NULL,
	`window` text NOT NULL,
	`job_count` integer NOT NULL,
	`share` real NOT NULL,
	`required_share` real NOT NULL,
	`computed_at` text NOT NULL
);
