import type { SearchProfile } from '@shared/discovery/schemas';
import { profileForPrompt, type Profile } from '@shared/profile';
import { aiFailureMessage } from '../../ai/failure';
import { loadPrompt } from '../../ai/prompts';
import type { ClaudeRunner } from '../../ai/runner';
import { TRIAGE_BATCH, triageJobs, type TriageJob } from '../../ai/tasks/discoveryTasks';
import type { Db } from '../../db/database';
import { setAiRunRelated } from '../../db/repos/aiRuns';
import { insertTriage } from '../../db/repos/discovery';
import { getJob, getJobSummary } from '../../db/repos/jobs';
import type { ProfileService } from '../profile/service';
import type { AiSettingsService } from '../settings/ai';

export interface TriageDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  profile: Pick<ProfileService, 'get'>;
}

export interface TriageResult {
  /** Job id to its new score. */
  scores: Map<string, number>;
  /** Plain messages, prefixed "triage:", at most one per kind. */
  errors: string[];
  /** The Claude usage limit was hit: nothing more should be asked of the CLI. */
  blocked: boolean;
}

const salaryLabel = (j: {
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
}): string | null =>
  j.salaryMin === null && j.salaryMax === null
    ? null
    : `${[j.salaryMin, j.salaryMax].filter((x) => x !== null).join('-')} ${j.salaryCurrency ?? ''}${j.salaryPeriod ? `/${j.salaryPeriod}` : ''}`.trim();

/** What the side-job profiles ask for, for the side-job triage; the strictest limit wins when there are several. */
export function sideJobBrief(profiles: SearchProfile[]): string {
  const side = profiles.filter((p) => p.kind === 'side');
  const nums = (v: (number | null)[]): number[] => v.filter((x): x is number => x !== null);
  const hours = nums(side.map((p) => p.maxHoursPerWeek));
  const pay = nums(side.map((p) => p.minHourlyPay));
  const places = [...new Set(side.flatMap((p) => [...p.locations, ...p.countries]))];
  const langs = [...new Set(side.flatMap((p) => p.languages))];
  return [
    hours.length > 0 ? `max hours per week: ${String(Math.min(...hours))}` : null,
    pay.length > 0 ? `min hourly pay: ${String(Math.max(...pay))} ${side[0]?.currency ?? 'EUR'}` : null,
    places.length > 0 ? `places: ${places.join(', ')}` : null,
    `remote: ${side.some((p) => p.remoteOk) ? 'welcome' : 'not wanted'}`,
    langs.length > 0 ? `languages spoken: ${langs.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Scores the given jobs with `job.triage`: batches of 10, career and side jobs in separate batches (side jobs carry
 * the `<side_job>` block), `concurrency` batches at a time. Shared by the scan and by Re-score in the Inbox.
 */
export async function triageByIds(
  deps: TriageDeps,
  ids: readonly string[],
  profiles: SearchProfile[],
  signal?: AbortSignal,
  onBatch?: (done: number, total: number) => void,
): Promise<TriageResult> {
  const { db, runner, settings } = deps;
  const out: TriageResult = { scores: new Map(), errors: [], blocked: false };
  const error = (m: string): void => {
    if (!out.errors.includes(m)) out.errors.push(m);
  };
  if (ids.length === 0) return out;
  let snap: { model: Profile; hash: string };
  try {
    snap = await deps.profile.get();
  } catch {
    error('triage: your profile could not be read.');
    return out;
  }
  const profileText = profileForPrompt(snap.model);
  const side = sideJobBrief(profiles);
  const rows = [...new Set(ids)].flatMap((id) => {
    const j = getJob(db, id);
    const s = getJobSummary(db, id);
    if (!j || !s) return [];
    const job: TriageJob = {
      id,
      title: j.title,
      company: s.company,
      location: j.locationText,
      remote: j.remote,
      salary: salaryLabel(j),
      excerpt: j.descriptionMd,
    };
    return [{ side: j.sideJob, job }];
  });
  // Career and side jobs are judged on different things, so a batch holds only one kind.
  const batches: { side: boolean; jobs: TriageJob[] }[] = [];
  for (const kind of [false, true]) {
    const list = rows.filter((r) => r.side === kind).map((r) => r.job);
    for (let i = 0; i < list.length; i += TRIAGE_BATCH)
      batches.push({ side: kind, jobs: list.slice(i, i + TRIAGE_BATCH) });
  }
  const width = settings.get().concurrency;
  const config = settings.forTask('job.triage');
  const version = `v${String(loadPrompt('job.triage').version)}`;
  let done = 0;
  onBatch?.(0, batches.length);
  for (let i = 0; i < batches.length && !signal?.aborted && !out.blocked; i += width)
    await Promise.all(
      batches.slice(i, i + width).map(async ({ side: isSide, jobs: batch }) => {
        const res = await triageJobs(runner, {
          profileText,
          jobs: batch,
          config,
          signal,
          ...(isSide ? { sideJob: side } : {}),
        });
        onBatch?.(++done, batches.length);
        if (!res.ok) {
          if (res.status === 'usage_limit') out.blocked = true;
          if (res.status !== 'cancelled') error(`triage: ${aiFailureMessage(res.status, res.error)}`);
          return;
        }
        const inBatch = new Set(batch.map((b) => b.id));
        for (const r of res.data.scores) {
          if (!inBatch.has(r.id) || out.scores.has(r.id)) continue;
          out.scores.set(r.id, r.score);
          insertTriage(db, {
            jobId: r.id,
            score: r.score,
            reason: r.reason.replace(/\s+/g, ' ').trim().slice(0, 200),
            model: res.model ?? config.model,
            promptVersion: version,
            profileHash: snap.hash,
          });
          setAiRunRelated(db, res.runId, 'job', r.id);
        }
      }),
    );
  return out;
}
