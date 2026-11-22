import {
  AnalysisResultSchema,
  JdSchema,
  type AnalysisRecord,
  type JobDetail,
  type JobSummary,
} from '@shared/jobs/schemas';
import { profileEntryIds } from '@shared/profile';
import { requireRealProfile } from '../profile/guard';
import { aiFailureMessage } from '../../ai/failure';
import { loadPrompt } from '../../ai/prompts';
import type { ClaudeRunner } from '../../ai/runner';
import { analyzeJob, validateAnalysis } from '../../ai/tasks/jobAnalyze';
import type { Db } from '../../db/database';
import { setAiRunRelated } from '../../db/repos/aiRuns';
import {
  deleteJob,
  getJob,
  getJobSummary,
  insertAnalysis,
  latestAnalysis,
  listJobSources,
  listJobs,
  setJobState,
  type Analysis,
  type Job,
} from '../../db/repos/jobs';
import { ensureApplication } from '../../db/repos/applications';
import { recomputeSkillDemand } from '../../db/repos/skills';
import { UserError } from '../../ipc/dispatch';
import type { ProfileService } from '../profile/service';
import type { AiSettingsService } from '../settings/ai';
import { createIntake } from './intake';
import type { Fetcher } from './net';

export interface JobsServiceDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  profile: ProfileService;
  fetcher?: Fetcher;
}

export function createJobsService({ db, runner, settings, profile, fetcher }: JobsServiceDeps) {
  const intake = createIntake({ db, runner, settings, fetcher });

  const currentProfileHash = async (): Promise<string | undefined> => {
    try {
      return (await profile.get()).hash;
    } catch {
      return undefined;
    }
  };

  function toRecord(a: Analysis, profileHash: string | undefined): AnalysisRecord | null {
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
    };
  }

  function requireJob(id: string): Job {
    const job = getJob(db, id);
    if (!job) throw new UserError('That job no longer exists.');
    return job;
  }

  return {
    ...intake,

    list(input: { limit: number; offset: number; state?: Job['state'] }): {
      items: JobSummary[];
      total: number;
    } {
      return listJobs(db, input);
    },

    async get(id: string): Promise<{ job: JobDetail; analysis: AnalysisRecord | null }> {
      const summary = getJobSummary(db, id);
      const job = getJob(db, id);
      if (!summary || !job) throw new UserError('That job no longer exists.');
      const latest = latestAnalysis(db, id);
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
        analysis: latest ? toRecord(latest, await currentProfileHash()) : null,
      };
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

    delete(id: string): boolean {
      const deleted = deleteJob(db, id);
      if (deleted) recomputeSkillDemand(db);
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
