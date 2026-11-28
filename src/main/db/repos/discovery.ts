import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { SearchProfileInput } from '@shared/discovery/schemas';
import type { Db } from '../database';
import { analyses, companies, jobSources, jobs, scanRuns, searchProfiles } from '../schema';
import type { Job } from './jobs';

export type SearchProfileRow = typeof searchProfiles.$inferSelect;
export type ScanRunRow = typeof scanRuns.$inferSelect;
type PerSource = NonNullable<ScanRunRow['perSourceJson']>;
const iso = (d = new Date()): string => d.toISOString();

// ---- search profiles ---------------------------------------------------------------------------------------

export const listSearchProfiles = (db: Db): SearchProfileRow[] =>
  db.orm.select().from(searchProfiles).orderBy(searchProfiles.createdAt, searchProfiles.id).all();

export const insertSearchProfile = (db: Db, v: SearchProfileInput): SearchProfileRow =>
  db.orm.insert(searchProfiles).values(v).returning().get();

export const updateSearchProfile = (
  db: Db,
  id: string,
  v: SearchProfileInput,
): SearchProfileRow | undefined =>
  db.orm
    .update(searchProfiles)
    .set({ ...v, updatedAt: iso() })
    .where(eq(searchProfiles.id, id))
    .returning()
    .get();

export const deleteSearchProfile = (db: Db, id: string): boolean =>
  db.orm.delete(searchProfiles).where(eq(searchProfiles.id, id)).run().changes > 0;

// ---- scan runs and the scan lock ---------------------------------------------------------------------------

/**
 * The lock is a `running` scan_runs row. Taking it runs in an IMMEDIATE transaction, so the app and a headless
 * `--scan` (two processes, one DB file) can never both get it. A row older than `staleMs` is a crashed scan:
 * it is closed as an error and the lock is free again.
 */
/** A running scan older than this is a crash, not a scan (the lock then frees itself). */
export const STALE_LOCK_MS = 2 * 60 * 60_000;

/** True while a scan holds the lock (a `running` row that is not stale). Read-only. */
export function scanIsRunning(db: Db, now: Date): boolean {
  return db.orm
    .select()
    .from(scanRuns)
    .where(eq(scanRuns.status, 'running'))
    .all()
    .some((r) => now.getTime() - Date.parse(r.startedAt) <= STALE_LOCK_MS);
}

export function acquireScanLock(
  db: Db,
  trigger: ScanRunRow['trigger'],
  now: Date,
  staleMs: number,
): ScanRunRow | null {
  return db.sqlite
    .transaction((): ScanRunRow | null => {
      const running = db.orm.select().from(scanRuns).where(eq(scanRuns.status, 'running')).all();
      let busy = false;
      for (const r of running) {
        if (now.getTime() - Date.parse(r.startedAt) > staleMs)
          db.orm
            .update(scanRuns)
            .set({
              status: 'error',
              finishedAt: iso(now),
              error: 'The scan did not finish (it was interrupted).',
            })
            .where(eq(scanRuns.id, r.id))
            .run();
        else busy = true;
      }
      if (busy) return null;
      return db.orm
        .insert(scanRuns)
        .values({ trigger, startedAt: iso(now), status: 'running' })
        .returning()
        .get();
    })
    .immediate();
}

export function finishScanRun(
  db: Db,
  id: string,
  v: { status: ScanRunRow['status']; perSource: PerSource; newJobs: number; error: string | null },
  now = new Date(),
): ScanRunRow {
  return db.orm
    .update(scanRuns)
    .set({
      status: v.status,
      finishedAt: iso(now),
      perSourceJson: v.perSource,
      newJobs: v.newJobs,
      error: v.error,
      updatedAt: iso(now),
    })
    .where(eq(scanRuns.id, id))
    .returning()
    .get();
}

export const listScanRuns = (db: Db, limit: number): ScanRunRow[] =>
  db.orm.select().from(scanRuns).orderBy(desc(scanRuns.startedAt), desc(scanRuns.id)).limit(limit).all();

/** Start time of the latest scan with the given outcome (any non-running one when `ok` is false). */
export function lastScanStart(db: Db, successOnly: boolean): Date | null {
  const row = db.orm
    .select({ at: scanRuns.startedAt })
    .from(scanRuns)
    .where(successOnly ? inArray(scanRuns.status, ['ok', 'partial']) : sql`${scanRuns.status} != 'running'`)
    .orderBy(desc(scanRuns.startedAt))
    .limit(1)
    .get();
  return row ? new Date(row.at) : null;
}

// ---- jobs found by scans -----------------------------------------------------------------------------------

export const findJobBySource = (db: Db, source: string, externalId: string): Job | undefined =>
  db.orm
    .select({ job: jobs })
    .from(jobSources)
    .innerJoin(jobs, eq(jobs.id, jobSources.jobId))
    .where(and(eq(jobSources.source, source as never), eq(jobSources.externalId, externalId)))
    .get()?.job;

export function addJobSource(
  db: Db,
  jobId: string,
  s: { source: string; externalId: string; url: string | null },
): void {
  db.orm
    .insert(jobSources)
    .values({ jobId, source: s.source as never, externalId: s.externalId, url: s.url })
    .onConflictDoNothing()
    .run();
}

/** Seen again: remember when, and reopen a job that had been marked closed. */
export function touchJob(db: Db, jobId: string, now: Date): void {
  db.orm
    .update(jobs)
    .set({ lastSeenAt: iso(now), closedAt: null })
    .where(eq(jobs.id, jobId))
    .run();
  db.orm
    .update(jobSources)
    .set({ fetchedAt: iso(now) })
    .where(eq(jobSources.jobId, jobId))
    .run();
}

/** Jobs of companies whose normalized name is in `companyIds`, for the SimHash comparison. */
export function jobsOfCompanies(db: Db, companyIds: string[]): Job[] {
  return companyIds.length === 0
    ? []
    : db.orm.select().from(jobs).where(inArray(jobs.companyId, companyIds)).all();
}

export const allCompanies = (db: Db) => db.orm.select().from(companies).all();

export function updateJobFields(db: Db, jobId: string, v: Partial<typeof jobs.$inferInsert>): void {
  db.orm
    .update(jobs)
    .set({ ...v, updatedAt: iso() })
    .where(eq(jobs.id, jobId))
    .run();
}

export function insertTriage(
  db: Db,
  v: {
    jobId: string;
    score: number;
    reason: string;
    model: string;
    promptVersion: string;
    profileHash: string;
  },
): void {
  db.orm
    .insert(analyses)
    .values({
      jobId: v.jobId,
      profileHash: v.profileHash,
      model: v.model,
      promptVersion: v.promptVersion,
      fitScore: v.score,
      summary: v.reason,
      triage: true,
    })
    .run();
}

/** Open inbox jobs that never got a triage score (a failed batch is retried by the next scan). */
export function untriagedInboxIds(db: Db, since: Date, limit: number): string[] {
  return db.sqlite
    .prepare(
      `select j.id from jobs j
       where j.state = 'new' and j.closed_at is null and j.first_seen_at >= ?
         and not exists (select 1 from analyses a where a.job_id = j.id)
       order by j.first_seen_at desc limit ?`,
    )
    .all(iso(since), limit)
    .map((r) => (r as { id: string }).id);
}

export interface Triaged {
  jobId: string;
  score: number;
}
export type RescoreScope = 'unscored' | 'all' | 'stale';

/**
 * Open inbox jobs Re-score may triage, newest first. A job with a full analysis or a side-job check is never one: the Inbox shows its
 * fit, so a new triage score would not be seen. `stale`: the latest triage used another profile version.
 * `sideJob` limits to side jobs (true) or career jobs (false).
 */
export function rescoreCandidates(
  db: Db,
  scope: RescoreScope,
  profileHash: string,
  sideJob: boolean | undefined,
  limit = 1000,
): string[] {
  const latest = `(select a.profile_hash from analyses a where a.job_id = j.id and a.triage = 1
                   order by a.created_at desc, a.id desc limit 1)`;
  const scoped = {
    unscored: 'not exists (select 1 from analyses a where a.job_id = j.id and a.triage = 1)',
    all: '1 = 1',
    stale: `${latest} is not null and ${latest} != @hash`,
  }[scope];
  return db.sqlite
    .prepare(
      `select j.id from jobs j
       where j.state = 'new' and j.closed_at is null
         and not exists (select 1 from analyses f where f.job_id = j.id and f.triage = 0)
         and not exists (select 1 from side_fits sf where sf.job_id = j.id)
         and (@side is null or j.side_job = @side) and ${scoped}
       order by j.first_seen_at desc, j.id limit @limit`,
    )
    .all({ hash: profileHash, side: sideJob === undefined ? null : Number(sideJob), limit })
    .map((r) => (r as { id: string }).id);
}

/** Triaged career jobs in the inbox at or above `threshold` with no full analysis yet, best first. */
export function analysisCandidates(db: Db, threshold: number, limit: number): Triaged[] {
  return db.sqlite
    .prepare(
      `select t.job_id as jobId, t.fit_score as score from analyses t
       join jobs j on j.id = t.job_id
       where t.triage = 1 and t.fit_score >= ? and j.state = 'new' and j.closed_at is null and j.side_job = 0
         and not exists (select 1 from analyses f where f.job_id = t.job_id and f.triage = 0)
         and t.id = (select t2.id from analyses t2 where t2.job_id = t.job_id and t2.triage = 1
                     order by t2.created_at desc, t2.id desc limit 1)
       order by t.fit_score desc, t.created_at desc limit ?`,
    )
    .all(threshold, limit) as Triaged[];
}

/** Jobs not seen for `days` days that are not marked closed: candidates for the closed check. */
export function staleOpenJobs(db: Db, cutoff: Date, limit: number): Pick<Job, 'id' | 'url'>[] {
  return db.orm
    .select({ id: jobs.id, url: jobs.url })
    .from(jobs)
    .where(
      and(
        isNull(jobs.closedAt),
        sql`${jobs.lastSeenAt} < ${iso(cutoff)}`,
        sql`${jobs.url} is not null`,
        sql`${jobs.state} != 'archived'`,
      ),
    )
    .orderBy(jobs.lastSeenAt)
    .limit(limit)
    .all();
}

export const markClosed = (db: Db, jobId: string, now: Date): void =>
  void db.orm
    .update(jobs)
    .set({ closedAt: iso(now) })
    .where(eq(jobs.id, jobId))
    .run();

// ---- watchlist ---------------------------------------------------------------------------------------------

export const listWatched = (db: Db) =>
  db.orm.select().from(companies).where(eq(companies.watch, true)).orderBy(companies.name).all();

// ---- inbox -------------------------------------------------------------------------------------------------

export interface InboxRow {
  id: string;
  company: string;
  title: string;
  locationText: string | null;
  remote: 'onsite' | 'hybrid' | 'remote' | 'unknown';
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  url: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  fit: number | null;
  fitReason: string | null;
  triage: number | null;
  triageReason: string | null;
  sideJob: number;
  /** Latest side-job check: it is the fit of a side job. */
  sideFit: number | null;
  sideFitReason: string | null;
}

/** Open (`new`, not closed) jobs with their latest full analysis and latest triage. */
export function inboxRows(db: Db): InboxRow[] {
  return db.sqlite
    .prepare(
      `select j.id, c.name as company, j.title, j.location_text as locationText, j.remote,
              j.salary_min as salaryMin, j.salary_max as salaryMax, j.salary_currency as salaryCurrency,
              j.salary_period as salaryPeriod, j.url, j.posted_at as postedAt, j.first_seen_at as firstSeenAt,
              f.fit_score as fit, f.summary as fitReason, t.fit_score as triage, t.summary as triageReason,
              j.side_job as sideJob, s.score as sideFit, s.summary as sideFitReason
       from jobs j join companies c on c.id = j.company_id
       left join side_fits s on s.id = (select x.id from side_fits x where x.job_id = j.id
                                        order by x.created_at desc, x.id desc limit 1)
       left join analyses f on f.id = (select a.id from analyses a where a.job_id = j.id and a.triage = 0
                                       order by a.created_at desc, a.id desc limit 1)
       left join analyses t on t.id = (select a.id from analyses a where a.job_id = j.id and a.triage = 1
                                       order by a.created_at desc, a.id desc limit 1)
       where j.state = 'new' and j.closed_at is null`,
    )
    .all() as InboxRow[];
}

export function sourcesByJob(db: Db, jobIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (jobIds.length === 0) return out;
  // One JSON parameter instead of thousands of bound ids: the inbox asks for every open job.
  const rows = db.sqlite
    .prepare(
      'select job_id as jobId, source from job_sources where job_id in (select value from json_each(?))',
    )
    .all(JSON.stringify(jobIds)) as { jobId: string; source: string }[];
  for (const r of rows) {
    const list = out.get(r.jobId);
    if (!list) out.set(r.jobId, [r.source]);
    else if (!list.includes(r.source)) list.push(r.source);
  }
  return out;
}

export const dismissJob = (db: Db, id: string, reason: string): boolean =>
  db.orm.update(jobs).set({ state: 'dismissed', dismissReason: reason }).where(eq(jobs.id, id)).run()
    .changes > 0;
