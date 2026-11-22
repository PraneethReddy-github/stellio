import type { Jd } from '@shared/jobs/schemas';
import { canonicalSkillKey, type Profile } from '@shared/profile';
import type { SkillAuditRow, SkillsAuditOutput } from '@shared/skills/schemas';
import { SkillsAuditOutputSchema } from '@shared/skills/schemas';
import type { TaskConfig } from '@shared/settings/ai';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';

/** Recommendations that get a sentence; only learn and ask_have also get an hours estimate. */
const NEEDS_WORDING: readonly SkillAuditRow['recommendation'][] = ['learn', 'ask_have', 'remove'];
const NEEDS_HOURS: readonly SkillAuditRow['recommendation'][] = ['learn', 'ask_have'];
const MAX_HOURS = 400;
const MAX_RATIONALE = 300;

/** Rows the model is asked about. */
export const rowsNeedingWording = (rows: readonly SkillAuditRow[]): SkillAuditRow[] =>
  rows.filter((r) => NEEDS_WORDING.includes(r.recommendation));

export interface SkillsAuditRequest {
  rows: readonly SkillAuditRow[];
  profile: Profile;
  jd: Jd | null;
  config: TaskConfig;
  signal?: AbortSignal;
}

export function buildSkillsAuditInput(req: SkillsAuditRequest): string {
  const skills = req.profile.skills
    .map(
      (s) =>
        `${s.skill} — level ${s.level === null ? '?' : String(s.level)}, ${s.years === null ? '?' : String(s.years)} years, ${s.status}`,
    )
    .join('\n');
  const rows = req.rows.map((r) => ({
    skill: r.skill,
    recommendation: r.recommendation,
    jd_importance: r.jdImportance,
    origin: r.origin,
    on_resume: r.onResume,
    adjacent_to: r.adjacentTo,
    demand_share: r.demand ? Math.round(r.demand.share * 100) / 100 : null,
  }));
  return [
    wrapData('job', `${req.jd?.title ?? 'Unknown role'} at ${req.jd?.company ?? 'unknown company'}`),
    wrapData('profile_skills', skills || '(none)'),
    wrapData('audit_rows', JSON.stringify(rows, null, 1)),
  ].join('\n\n');
}

/** One `skills.audit` CLI run: wording only. Use `applyAuditWording` before trusting the output. */
export function runSkillsAudit(
  runner: ClaudeRunner,
  req: SkillsAuditRequest,
): Promise<RunResult<SkillsAuditOutput>> {
  const prompt = loadPrompt('skills.audit');
  return runner.run({
    task: 'skills.audit',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: buildSkillsAuditInput(req),
    schema: SkillsAuditOutputSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
  });
}

export interface Wording {
  rationale: string;
  learnEstimateHours: number | null;
}

/**
 * Keeps only what the model may decide: a sentence and an hours estimate, for the rows that asked for them.
 * Skills it invented, repeated or renamed are dropped, so it can change neither a recommendation nor the set of
 * skills. Hours are clamped to 1-400 and only kept for learn / ask_have rows. Keyed by canonical skill name.
 */
export function validateWording(
  rows: readonly SkillAuditRow[],
  out: SkillsAuditOutput,
): Map<string, Wording> {
  const asked = new Map(rowsNeedingWording(rows).map((r) => [canonicalSkillKey(r.skill), r]));
  const result = new Map<string, Wording>();
  for (const item of out.rows) {
    const key = canonicalSkillKey(item.skill);
    const row = asked.get(key);
    const rationale = item.rationale.replace(/\s+/g, ' ').trim().slice(0, MAX_RATIONALE);
    if (!row || result.has(key) || rationale === '') continue;
    const hours = item.learn_estimate_hours;
    result.set(key, {
      rationale,
      learnEstimateHours:
        NEEDS_HOURS.includes(row.recommendation) && hours !== null && hours >= 1
          ? Math.min(Math.round(hours), MAX_HOURS)
          : null,
    });
  }
  return result;
}
