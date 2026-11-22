import { readResume } from '@shared/documents';
import {
  MIN_SAMPLE,
  checkNumbers,
  computeInsights,
  type InsightApp,
  type InsightWindow,
  type InsightsAnswer,
  type InsightsAskOutput,
  type InsightsSummary,
} from '@shared/insights';
import { aiFailureMessage } from '../../ai/failure';
import type { ClaudeRunner } from '../../ai/runner';
import {
  askInsights,
  buildInsightsData,
  insightsDataText,
  type AskDemand,
  type AskLearning,
} from '../../ai/tasks/insights';
import type { Db } from '../../db/database';
import { demandMap } from '../../db/repos/skills';
import { documents, jobSources } from '../../db/schema';
import { UserError } from '../../ipc/dispatch';
import type { AiSettingsService } from '../settings/ai';
import type { LearningService } from '../skills/learning';
import { loadContexts } from '../tracker/context';

export interface InsightsServiceDeps {
  db: Db;
  runner: ClaudeRunner;
  settings: AiSettingsService;
  learning: Pick<LearningService, 'roadmap'>;
  now?: () => Date;
}

/** Every sent application with the job facts, the final resume's skills and whether it had a cover letter. */
export function loadInsightApps(db: Db): InsightApp[] {
  const sent = loadContexts(db).filter((c) => c.app.appliedAt !== null);
  if (sent.length === 0) return [];

  const source = new Map<string, string>();
  for (const s of db.orm.select().from(jobSources).orderBy(jobSources.createdAt).all())
    if (!source.has(s.jobId)) source.set(s.jobId, s.source);

  // Final resume of the job, else its latest version. A cover letter counts when one is final or linked.
  const resume = new Map<string, { version: number; final: boolean; tex: string }>();
  const cover = new Set<string>();
  for (const d of db.orm.select().from(documents).all()) {
    if (d.kind === 'cover_letter') {
      if (d.isFinal) cover.add(d.jobId);
      continue;
    }
    const prev = resume.get(d.jobId);
    if (!prev || (d.isFinal && !prev.final) || (d.isFinal === prev.final && d.version > prev.version))
      resume.set(d.jobId, { version: d.version, final: d.isFinal, tex: d.tex });
  }

  return sent.map((c) => {
    const tex = resume.get(c.job.id)?.tex;
    return {
      appliedAt: c.app.appliedAt as string,
      status: c.app.status,
      events: c.events.map((e) => ({ type: e.type, toStatus: e.toStatus, at: e.at })),
      interviews: c.interviews.map((i) => ({ outcome: i.outcome })),
      source: source.get(c.job.id) ?? null,
      title: c.job.title,
      seniority: c.job.seniority,
      fit: c.fit,
      remote: c.job.remote,
      postedAt: c.job.postedAt,
      coverLetter: c.app.coverDocId !== null || cover.has(c.job.id),
      skills: tex
        ? [...new Set(readResume(tex).sections.flatMap((s) => s.skillLines.flatMap((l) => l.skills)))]
        : [],
    };
  });
}

const NO_DATA: InsightsAnswer = {
  answer:
    'There is nothing to analyse yet: no application has been sent. Mark an application as applied; rates need a few applications per segment before they mean anything.',
  numbersUsed: [{ label: 'Applications needed per segment', value: String(MIN_SAMPLE) }],
  warning: null,
};

export function createInsightsService(deps: InsightsServiceDeps) {
  const { db, runner, settings } = deps;
  const now = deps.now ?? (() => new Date());

  const summary = (window: InsightWindow): InsightsSummary =>
    computeInsights(loadInsightApps(db), window, now());

  /**
   * Answers a strategy question from the aggregated tables only (docs/08 §5). Every number in the answer has to
   * be listed in `numbers_used` and exist in the data; a failed check gets one repair round, then the answer is
   * shown with a warning. All applications count, whatever the window of the screen.
   */
  async function ask(question: string, signal?: AbortSignal): Promise<InsightsAnswer> {
    const all = summary('all');
    if (all.totals.applications === 0) return NO_DATA;

    const demand: AskDemand[] = [...demandMap(db, '90d').values()].sort(
      (a, b) => b.jobCount - a.jobCount || a.skill.localeCompare(b.skill),
    );
    const learning: AskLearning[] = (await deps.learning.roadmap()).items
      .filter((i) => i.status === 'todo' || i.status === 'doing')
      .map((i) => ({
        skill: i.skill,
        status: i.status,
        priority: i.priority,
        estHours: i.estHours,
        unlocks: i.unlocks,
      }));
    const data = buildInsightsData(all, demand, learning);
    const config = settings.forTask('insights.ask');
    const dataText = insightsDataText(data);
    const shape = (out: InsightsAskOutput, warning: string | null): InsightsAnswer => ({
      answer: out.answer.trim(),
      numbersUsed: out.numbers_used,
      warning,
    });

    const first = await askInsights(runner, { question, data, config, signal });
    if (!first.ok) throw new UserError(aiFailureMessage(first.status, first.error));
    const firstCheck = checkNumbers(first.data, dataText);
    if (firstCheck.ok) return shape(first.data, null);

    const second = await askInsights(runner, {
      question,
      data,
      config,
      signal,
      repair: { previous: first.data, issues: firstCheck.issues },
    });
    if (second.ok) {
      const secondCheck = checkNumbers(second.data, dataText);
      if (secondCheck.ok) return shape(second.data, null);
      return shape(second.data, warningFor(secondCheck.issues));
    }
    if (second.status === 'cancelled') throw new UserError(aiFailureMessage(second.status, second.error));
    return shape(first.data, warningFor(firstCheck.issues));
  }

  return { summary, ask };
}
export type InsightsService = ReturnType<typeof createInsightsService>;

const warningFor = (issues: readonly string[]): string =>
  `Some numbers in this answer could not be matched to your data, even after a second try. Check them against the tables before you rely on them. ${issues.slice(0, 3).join(' ')}`;
