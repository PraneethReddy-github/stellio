-- When the posting text was last replaced (Fetch / Paste full text); a fit analysis older than it is stale.
ALTER TABLE `jobs` ADD `description_updated_at` text;
