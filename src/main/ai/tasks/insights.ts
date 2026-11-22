import { InsightsAskOutputSchema, type InsightsAskOutput, type InsightsSummary } from '@shared/insights';
import type { TaskConfig } from '@shared/settings/ai';
import type { DemandShare } from '@shared/skills/schemas';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';

export interface AskDemand extends DemandShare {
  skill: string;
}
export interface AskLearning {
  skill: string;
  status: string;
  priority: number;
  estHours: number | null;
  unlocks: number;
}

const pct = (x: number | null): number | null => (x === null ? null : Math.round(x * 100));

/**
 * The only data `insights.ask` sees (docs/08 §5): the aggregated tables, skill demand and learning items.
 * Never a document, a note, a company or a job title. Rates are whole percentages so the numbers check can
 * compare the model's figures with this text character for character.
 */
export function buildInsightsData(
  summary: InsightsSummary,
  demand: readonly AskDemand[],
  learning: readonly AskLearning[],
): { insights: string; demand: string; learning: string } {
  const tables = Object.fromEntries(
    summary.dimensions.map((d) => [
      d.title,
      d.segments.map((s) => ({
        segment: s.label,
        applications: s.applications,
        responses: s.responses,
        interviews: s.interviews,
        response_rate_pct: pct(s.responseRate),
        interview_rate_pct: pct(s.interviewRate),
        insufficient: s.insufficient,
      })),
    ]),
  );
  const t = summary.totals;
  return {
    insights: JSON.stringify(
      {
        window_days: summary.window === '90d' ? 90 : null,
        applications: t.applications,
        responses: t.responses,
        interviews: t.interviews,
        response_rate_pct: pct(t.responseRate),
        interview_rate_pct: pct(t.interviewRate),
        median_days_to_first_response: summary.timeToResponse.medianDays,
        ghosting: {
          eligible_applications: summary.ghosting.eligible,
          ghosted: summary.ghosting.ghosted,
          rate_pct: pct(summary.ghosting.rate),
        },
        tables,
      },
      null,
      1,
    ),
    demand: JSON.stringify(
      demand.slice(0, 15).map((d) => ({
        skill: d.skill,
        jobs: d.jobCount,
        share_pct: pct(d.share),
        required_pct: pct(d.requiredShare),
      })),
      null,
      1,
    ),
    learning: JSON.stringify(
      learning.map((l) => ({
        skill: l.skill,
        status: l.status,
        priority: l.priority,
        est_hours: l.estHours,
        unlocks_jobs: l.unlocks,
      })),
      null,
      1,
    ),
  };
}

export interface InsightsAskRequest {
  question: string;
  data: ReturnType<typeof buildInsightsData>;
  /** The first answer and the exact problems found, for the one repair round. */
  repair?: { previous: InsightsAskOutput; issues: string[] };
  config: TaskConfig;
  signal?: AbortSignal;
}

/** Text the numbers check compares against: exactly the data blocks the model saw. */
export const insightsDataText = (d: InsightsAskRequest['data']): string =>
  [d.insights, d.demand, d.learning].join('\n');

export function buildInsightsAskInput(req: InsightsAskRequest): string {
  const blocks = [
    wrapData('question', req.question),
    wrapData('insights', req.data.insights),
    wrapData('skill_demand', req.data.demand),
    wrapData('learning', req.data.learning),
  ];
  if (req.repair) {
    blocks.push(wrapData('previous_answer', JSON.stringify(req.repair.previous, null, 1)));
    blocks.push(wrapData('repair_issues', req.repair.issues.map((i) => `- ${i}`).join('\n')));
  }
  return blocks.join('\n\n');
}

/** One `insights.ask` CLI run (also the repair round). The numbers check runs in code. */
export function askInsights(
  runner: ClaudeRunner,
  req: InsightsAskRequest,
): Promise<RunResult<InsightsAskOutput>> {
  const prompt = loadPrompt('insights.ask');
  return runner.run({
    task: 'insights.ask',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: buildInsightsAskInput(req),
    schema: InsightsAskOutputSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
  });
}
