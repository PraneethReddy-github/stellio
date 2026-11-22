-- Hand-written (drizzle-kit cannot express FTS5).
-- job_id is stored instead of relying on jobs.rowid: VACUUM may renumber rowids of tables without an INTEGER PRIMARY KEY.
CREATE VIRTUAL TABLE `jobs_fts` USING fts5(title, company, description_md, job_id UNINDEXED);
--> statement-breakpoint
INSERT INTO `jobs_fts` (title, company, description_md, job_id)
SELECT j.title, c.name, j.description_md, j.id FROM `jobs` j JOIN `companies` c ON c.id = j.company_id;
--> statement-breakpoint
CREATE TRIGGER `jobs_fts_ai` AFTER INSERT ON `jobs` BEGIN
  INSERT INTO `jobs_fts` (title, company, description_md, job_id)
  VALUES (new.title, (SELECT name FROM `companies` WHERE id = new.company_id), new.description_md, new.id);
END;
--> statement-breakpoint
CREATE TRIGGER `jobs_fts_au` AFTER UPDATE OF title, company_id, description_md ON `jobs` BEGIN
  DELETE FROM `jobs_fts` WHERE job_id = old.id;
  INSERT INTO `jobs_fts` (title, company, description_md, job_id)
  VALUES (new.title, (SELECT name FROM `companies` WHERE id = new.company_id), new.description_md, new.id);
END;
--> statement-breakpoint
CREATE TRIGGER `jobs_fts_ad` AFTER DELETE ON `jobs` BEGIN
  DELETE FROM `jobs_fts` WHERE job_id = old.id;
END;
--> statement-breakpoint
CREATE TRIGGER `jobs_fts_company_au` AFTER UPDATE OF name ON `companies` BEGIN
  DELETE FROM `jobs_fts` WHERE job_id IN (SELECT id FROM `jobs` WHERE company_id = new.id);
  INSERT INTO `jobs_fts` (title, company, description_md, job_id)
  SELECT title, new.name, description_md, id FROM `jobs` WHERE company_id = new.id;
END;
