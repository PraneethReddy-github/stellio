import {
  AnalysisResultSchema,
  JdSchema,
  type AnalysisRecord,
  type JobDetail,
  SideFitResultSchema,
  type SideFitRecord,
  type JobSummary,
} from '@shared/jobs/schemas';
import { profileEntryIds } from '@shared/profile';
import { requireRealProfile } from '../profile/guard';
import { aiFailureMessage } from '../../ai/failure';
import { loadPrompt } from '../../ai/prompts';
import type { ClaudeRunner } from '../../ai/runner';
import { analyzeJob, validateAnalysis } from '../../ai/tasks/jobAnalyze';
import { parseJd } from '../../ai/tasks/jdParse';
import { checkSideJob, validateSideFit } from '../../ai/tasks/sideFit';
import { listSearchProfiles, updateJobFields } from '../../db/repos/discovery';
import { sideJobBrief } from '../discovery/triage';
import type { Db } from '../../db/database';
import { setAiRunRelated } from '../../db/repos/aiRuns';
import {
  deleteJob,
  deleteJobs,
  getJob,
  getJobSummary,
  insertAnalysis,
  insertSideFit,
  latestAnalysis,
  latestSideFit,
  listJobSources,
  listJobs,
  setJobState,
  type Analysis,
  type Job,
  type SideFit,
} from '../../db/repos/jobs';
import { ensureApplication } from '../../db/repos/applications';
import { recomputeSkillDemand } from '../../db/repos/skills';
import { UserError } from '../../ipc/dispatch';
import type { ProfileService } from '../profile/service';
import type { AiSettingsService } from '../settings/ai';
import { createIntake, hashText } from './intake';
import { guardedFetch, type Fetcher } from './net';
import { fetchJobPage } from './page';

export interface JobsServiceDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  profile: ProfileService;
  fetcher?: Fetcher;
}

/** Shorter than this is not a full posting. */
const MIN_FULL_TEXT = 200;

export function createJobsService({ db, runner, settings, profile, fetcher }: JobsServiceDeps) {
  const intake = createIntake({ db, runner, settings, fetcher });

  const currentProfileHash = async (): Promise<string | undefined> => {
    try {
      return (await profile.get()).hash;
    } catch {
      return undefined;
    }
  };

  function toRecord(
    a: Analysis,
    profileHash: string | undefined,
    descriptionUpdatedAt: string | null = null,
  ): AnalysisRecord | null {
    const result = AnalysisResultSchema.safeParse(a.resultJson);
    if (!result.success) return null;
    return {
      id: a.id,
      jobId: a.jobId,
      createdAt: a.createdAt,
      profileHash: a.profileHash,
      model: a.model,
      promptVersion: a.promptVersion,
      result: result.data,
      profileStale: profileHash !== undefined && profileHash !== a.profileHash,
      postingStale: descriptionUpdatedAt !== null && descriptionUpdatedAt > a.createdAt,
    };
  }

  function toSideRecord(f: SideFit, profileHash: string | undefined, descriptionUpdatedAt: string | null) {
    const result = SideFitResultSchema.safeParse(f.resultJson);
    if (!result.success) return null;
    const r: SideFitRecord = {
      id: f.id,
      jobId: f.jobId,
      createdAt: f.createdAt,
      model: f.model,
      result: result.data,
      profileStale: profileHash !== undefined && profileHash !== f.profileHash,
      postingStale: descriptionUpdatedAt !== null && descriptionUpdatedAt > f.createdAt,
    };
    return r;
  }

  function requireJob(id: string): Job {
    const job = getJob(db, id);
    if (!job) throw new UserError('That job no longer exists.');
    return job;
  }

  /**
   * Replaces the posting text (the source sent only part of it): parses it again and fills the fields the
   * job does not have yet. Title and company stay. A fit analysis made before this is marked stale.
   */
  async function replaceText(id: string, text: string, signal?: AbortSignal): Promise<void> {
    const job = requireJob(id);
    const md = text.replace(/\r\n?/g, '\n').replaceAll('\0', '').trim();
    if (md.length < MIN_FULL_TEXT) throw new UserError('That text is too short to be the full posting.');
    const res = await parseJd(runner, { text: md, config: settings.forTask('jd.parse'), signal });
    if (!res.ok) throw new UserError(aiFailureMessage(res.status, res.error));
    setAiRunRelated(db, res.runId, 'job', id);
    const jd = res.data;
    updateJobFields(db, id, {
      descriptionMd: md,
      descriptionHash: hashText(md),
      descriptionUpdatedAt: new Date().toISOString(),
      structuredJson: jd,
      employmentType: job.employmentType ?? jd.employment_type,
      seniority: job.seniority ?? jd.seniority,
      language: job.language ?? jd.language,
      deadlineAt: job.deadlineAt ?? jd.deadline,
      ...(job.salaryMin === null && job.salaryMax === null && jd.salary
        ? {
            salaryMin: jd.salary.min,
            salaryMax: jd.salary.max,
            salaryCurrency: jd.salary.currency,
            salaryPeriod: jd.salary.period,
          }
        : {}),
    });
    try {
      recomputeSkillDemand(db);
    } catch {
      // derived data: the next intake or scan recomputes it
    }
  }

  return {
    ...intake,

    list(input: { limit: number; offset: number; state?: Job['state'] }): {
      items: JobSummary[];
      total: number;
    } {
      return listJobs(db, input);
    },

    async get(
      id: string,
    ): Promise<{ job: JobDetail; analysis: AnalysisRecord | null; sideFit: SideFitRecord | null }> {
      const summary = getJobSummary(db, id);
      const job = getJob(db, id);
      if (!summary || !job) throw new UserError('That job no longer exists.');
      const latest = latestAnalysis(db, id);
      const side = latestSideFit(db, id);
      const hash = await currentProfileHash();
      return {
        job: {
          ...summary,
          descriptionMd: job.descriptionMd,
          structured: JdSchema.safeParse(job.structuredJson).data ?? null,
          sources: listJobSources(db, id).map((s) => ({
            source: s.source,
            url: s.url,
            fetchedAt: s.fetchedAt,
          })),
        },
        analysis: latest ? toRecord(latest, hash, job.descriptionUpdatedAt) : null,
        sideFit: side ? toSideRecord(side, hash, job.descriptionUpdatedAt) : null,
      };
    },

    /**
     * The side-job check (the Fit tab of a side job): pay, hours, place, language and needs against the side-job
     * limits, each with the posting's own words. Quotes the posting does not hold are dropped in code.
     */
    async sideFit(id: string, signal?: AbortSignal): Promise<SideFitRecord> {
      const job = requireJob(id);
      if (!job.sideJob) throw new UserError('This is not a side job. Use Analyze fit.');
      const snap = await profile.get();
      requireRealProfile(snap.model);
      const brief = sideJobBrief(listSearchProfiles(db));
      const config = settings.forTask('job.sideFit');
      const res = await checkSideJob(runner, {
        sideJob: brief,
        profile: snap.model,
        jd: JdSchema.safeParse(job.structuredJson).data ?? null,
        descriptionMd: job.descriptionMd,
        config,
        signal,
      });
      if (!res.ok) throw new UserError(aiFailureMessage(res.status, res.error));
      setAiRunRelated(db, res.runId, 'job', id);
      const result = validateSideFit(res.data, job.descriptionMd);
      const row = insertSideFit(db, {
        jobId: id,
        profileHash: snap.hash,
        model: res.model ?? config.model,
        promptVersion: `v${String(loadPrompt('job.sideFit').version)}`,
        score: result.side_score,
        verdict: result.verdict,
        summary: result.summary,
        resultJson: result,
      });
      const record = toSideRecord(row, snap.hash, null);
      if (!record) throw new Error('stored side-job check failed validation');
      return record;
    },

    /** Full fit analysis against the current profile. Evidence ids are checked against the profile in code. */
    async analyze(id: string, signal?: AbortSignal): Promise<AnalysisRecord> {
      const job = requireJob(id);
      const snap = await profile.get();
      const m = snap.model;
      if (m.skills.length + m.experience.length + m.projects.length === 0)
        throw new UserError('Your profile has no skills or experience yet. Fill it in first.');
      requireRealProfile(m);
      const config = settings.forTask('job.analyze');
      const res = await analyzeJob(runner, {
        profile: m,
        jd: JdSchema.safeParse(job.structuredJson).data ?? null,
        descriptionMd: job.descriptionMd,
        config,
        signal,
      });
      if (!res.ok) throw new UserError(aiFailureMessage(res.status, res.error));
      setAiRunRelated(db, res.runId, 'job', id);
      const result = validateAnalysis(res.data, profileEntryIds(m));
      const row = insertAnalysis(db, {
        jobId: id,
        profileHash: snap.hash,
        model: res.model ?? config.model,
        promptVersion: `v${String(loadPrompt('job.analyze').version)}`,
        fitScore: result.fit_score,
        verdict: result.verdict,
        summary: result.summary,
        resultJson: result,
        triage: false,
      });
      const record = toRecord(row, snap.hash);
      if (!record) throw new Error('stored analysis failed validation');
      return record;
    },

    replaceText,

    /**
     * Reads the posting page again and keeps its text when it is longer and still holds the start of the stored
     * text (so a landing or search page never replaces the posting).
     */
    async fetchFullText(
      id: string,
      signal?: AbortSignal,
    ): Promise<{ status: 'replaced' } | { status: 'unchanged' | 'needs_text'; reason: string }> {
      const job = requireJob(id);
      const url = job.url ?? job.applyUrl;
      if (!url) throw new UserError('This job has no posting link. Paste the text instead.');
      const page = await fetchJobPage(url, fetcher ?? guardedFetch, signal);
      if (page.status === 'needs_text') return page;
      const flat = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
      const head = flat(job.descriptionMd)
        .replace(/(…|\.\.\.)$/, '')
        .slice(0, 80);
      const text = flat(page.markdown);
      if (text.length <= flat(job.descriptionMd).length)
        return {
          status: 'unchanged',
          reason: 'The page has no more text than Stellio already has. Paste it instead.',
        };
      if (head.length >= 20 && !text.includes(head))
        return {
          status: 'unchanged',
          reason:
            'The page Stellio could read is not this posting (often a redirect or a search page). Paste the text instead.',
        };
      await replaceText(id, page.markdown, signal);
      return { status: 'replaced' };
    },

    delete(id: string): boolean {
      const deleted = deleteJob(db, id);
      if (deleted) recomputeSkillDemand(db);
      return deleted;
    },

    deleteMany(ids: readonly string[]): number {
      const deleted = deleteJobs(db, ids);
      if (deleted > 0) recomputeSkillDemand(db);
      return deleted;
    },

    setState(id: string, state: Job['state']): JobSummary {
      if (!setJobState(db, id, state)) throw new UserError('That job no longer exists.');
      // Shortlisting makes it an application (docs/08 §1).
      if (state === 'shortlisted') ensureApplication(db, id, 'shortlisted');
      const row = getJobSummary(db, id);
      if (!row) throw new UserError('That job no longer exists.');
      return row;
    },
  };
}
export type JobsService = ReturnType<typeof createJobsService>;
