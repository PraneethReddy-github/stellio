import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../database';
import { analyses, applications, companies, jobSources, jobs, sideFits } from '../schema';

export type Company = typeof companies.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type JobSource = typeof jobSources.$inferSelect;
export type Analysis = typeof analyses.$inferSelect;
export type NewJob = Omit<typeof jobs.$inferInsert, 'id' | 'companyId' | 'createdAt' | 'updatedAt'>;
export type NewJobSource = Pick<typeof jobSources.$inferInsert, 'source' | 'externalId' | 'url' | 'rawJson'>;
export type NewAnalysis = Omit<typeof analyses.$inferInsert, 'id' | 'updatedAt'>;

/** Finds a company by case-insensitive name or creates it. */
export function upsertCompanyByName(db: Db, name: string): Company {
  const clean = name.trim();
  const found = db.orm
    .select()
    .from(companies)
    .where(sql`lower(${companies.name}) = lower(${clean})`)
    .get();
  return found ?? db.orm.insert(companies).values({ name: clean }).returning().get();
}

export function findJobByDedupeKey(db: Db, key: string): Job | undefined {
  return db.orm.select().from(jobs).where(eq(jobs.dedupeKey, key)).get();
}

export function findJobByHash(db: Db, hash: string): Job | undefined {
  return db.orm.select().from(jobs).where(eq(jobs.descriptionHash, hash)).get();
}

/** Inserts company (upsert), job and its source row in one transaction. */
export function createJob(db: Db, companyName: string, job: NewJob, source?: NewJobSource): Job {
  return db.sqlite.transaction(() => {
    const company = upsertCompanyByName(db, companyName);
    const row = db.orm
      .insert(jobs)
      .values({ ...job, companyId: company.id })
      .returning()
      .get();
    if (source)
      db.orm
        .insert(jobSources)
        .values({ ...source, jobId: row.id })
        .onConflictDoNothing()
        .run();
    return row;
  })();
}

const summaryColumns = {
  id: jobs.id,
  companyId: jobs.companyId,
  company: companies.name,
  title: jobs.title,
  locationText: jobs.locationText,
  country: jobs.country,
  remote: jobs.remote,
  employmentType: jobs.employmentType,
  seniority: jobs.seniority,
  salaryMin: jobs.salaryMin,
  salaryMax: jobs.salaryMax,
  salaryCurrency: jobs.salaryCurrency,
  salaryPeriod: jobs.salaryPeriod,
  language: jobs.language,
  url: jobs.url,
  applyUrl: jobs.applyUrl,
  postedAt: jobs.postedAt,
  deadlineAt: jobs.deadlineAt,
  state: jobs.state,
  firstSeenAt: jobs.firstSeenAt,
  fitScore: analyses.fitScore,
  verdict: analyses.verdict,
  sideJob: jobs.sideJob,
};

/** Joins company and the latest full (non-triage) analysis. */
function summaryQuery(db: Db) {
  return db.orm
    .select(summaryColumns)
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(
      analyses,
      eq(
        analyses.id,
        sql`(select a2.id from analyses a2 where a2.job_id = ${jobs.id} and a2.triage = 0 order by a2.created_at desc, a2.id desc limit 1)`,
      ),
    );
}
export type JobSummaryRow = ReturnType<ReturnType<typeof summaryQuery>['all']>[number];

export function listJobs(
  db: Db,
  { limit, offset, state }: { limit: number; offset: number; state?: Job['state'] },
): { items: JobSummaryRow[]; total: number } {
  const where = state ? eq(jobs.state, state) : undefined;
  const items = summaryQuery(db)
    .where(where)
    .orderBy(desc(jobs.firstSeenAt), desc(jobs.id))
    .limit(limit)
    .offset(offset)
    .all();
  const total = db.orm.select({ n: count() }).from(jobs).where(where).get()?.n ?? 0;
  return { items, total };
}

export function getJobSummary(db: Db, id: string): JobSummaryRow | undefined {
  return summaryQuery(db).where(eq(jobs.id, id)).get();
}

export function getJob(db: Db, id: string): Job | undefined {
  return db.orm.select().from(jobs).where(eq(jobs.id, id)).get();
}

export function setJobState(db: Db, id: string, state: Job['state']): boolean {
  return db.orm.update(jobs).set({ state }).where(eq(jobs.id, id)).run().changes > 0;
}

/** Sources and analyses cascade; so does its application (events, interviews). A frozen folder stays on disk. */
export function deleteJob(db: Db, id: string): boolean {
  return db.sqlite.transaction(() => {
    db.orm.delete(applications).where(eq(applications.jobId, id)).run();
    return db.orm.delete(jobs).where(eq(jobs.id, id)).run().changes > 0;
  })();
}

/** All or none. Returns how many existed. */
export const deleteJobs = (db: Db, ids: readonly string[]): number =>
  db.sqlite.transaction(() => ids.filter((id) => deleteJob(db, id)).length)();

export function listJobSources(db: Db, jobId: string): JobSource[] {
  return db.orm.select().from(jobSources).where(eq(jobSources.jobId, jobId)).all();
}

export function insertAnalysis(db: Db, a: NewAnalysis): Analysis {
  return db.orm.insert(analyses).values(a).returning().get();
}

export type SideFit = typeof sideFits.$inferSelect;
export const insertSideFit = (db: Db, v: typeof sideFits.$inferInsert): SideFit =>
  db.orm.insert(sideFits).values(v).returning().get();

/** Latest side-job check of a job. */
export function latestSideFit(db: Db, jobId: string): SideFit | undefined {
  return db.orm
    .select()
    .from(sideFits)
    .where(eq(sideFits.jobId, jobId))
    .orderBy(desc(sideFits.createdAt), desc(sideFits.id))
    .limit(1)
    .get();
}

/** Latest full analysis (triage rows excluded). */
export function latestAnalysis(db: Db, jobId: string): Analysis | undefined {
  return db.orm
    .select()
    .from(analyses)
    .where(and(eq(analyses.jobId, jobId), eq(analyses.triage, false)))
    .orderBy(desc(analyses.createdAt), desc(analyses.id))
    .limit(1)
    .get();
}

/**
 * Jobs still open to you (inbox or shortlisted, not closed, no application beyond saved / preparing / ready)
 * with their latest full analysis and structured JD. For the learning roadmap.
 */
export function listOpenJobs(db: Db): {
  id: string;
  company: string;
  title: string;
  structured: unknown;
  fit: number | null;
  verdict: 'apply' | 'stretch' | 'skip' | null;
}[] {
  return db.orm
    .select({
      id: jobs.id,
      company: companies.name,
      title: jobs.title,
      structured: jobs.structuredJson,
      fit: analyses.fitScore,
      verdict: analyses.verdict,
      appStatus: applications.status,
    })
    .from(jobs)
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .leftJoin(
      analyses,
      eq(
        analyses.id,
        sql`(select a2.id from analyses a2 where a2.job_id = ${jobs.id} and a2.triage = 0 order by a2.created_at desc, a2.id desc limit 1)`,
      ),
    )
    .leftJoin(applications, eq(applications.jobId, jobs.id))
    .where(and(inArray(jobs.state, ['new', 'shortlisted']), isNull(jobs.closedAt)))
    .all()
    .filter((r) => r.appStatus === null || ['saved', 'preparing', 'ready'].includes(r.appStatus))
    .map((r) => ({
      id: r.id,
      company: r.company,
      title: r.title,
      structured: r.structured,
      fit: r.fit,
      verdict: r.verdict,
    }));
}
