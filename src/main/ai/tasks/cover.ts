import { CoverContentSchema, type CoverContent } from '@shared/documents';
import type { AnalysisResult, Jd } from '@shared/jobs/schemas';
import { profileForPrompt, type Profile } from '@shared/profile';
import type { TaskConfig } from '@shared/settings/ai';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';
import { MAX_JD_CHARS } from './jdParse';

export type CoverTask = 'cover.generate' | 'cover.revise';

export interface CoverTaskRequest {
  task: CoverTask;
  /** Excluded entries already removed. */
  profile: Profile;
  jd: Jd | null;
  descriptionMd: string;
  analysis: AnalysisResult | null;
  /** Raw rules files, embedded verbatim as USER RULES (docs/04 §4). */
  coverRules: string;
  skillsPolicy: string;
  /** Skills the letter may name, one per line with aliases. */
  allowedSkills: string[];
  /** revise: the draft to change; repair: the draft that failed the checks. */
  previous?: CoverContent;
  instruction?: string | null;
  /** Exact check failures for the one repair round. */
  repairIssues?: string[];
  config: TaskConfig;
  signal?: AbortSignal;
}

export function buildCoverInput(req: CoverTaskRequest): string {
  const blocks = [
    'USER RULES — follow exactly; they override style defaults, never override truth rules.',
    wrapData('cover_rules', req.coverRules),
    wrapData('skills_policy', req.skillsPolicy),
    wrapData('allowed_skills', req.allowedSkills.join('\n') || '(none)'),
    wrapData('profile', profileForPrompt({ ...req.profile, notes: '' })),
    wrapData('notes', req.profile.notes.trim() || '(none)'),
    wrapData('job_structured', JSON.stringify(req.jd)),
    wrapData('job_description', req.descriptionMd.slice(0, MAX_JD_CHARS)),
    wrapData('fit_analysis', JSON.stringify(req.analysis)),
  ];
  if (req.previous) blocks.push(wrapData('previous_draft', JSON.stringify(req.previous, null, 1)));
  if (req.instruction?.trim()) blocks.push(wrapData('user_instruction', req.instruction.trim()));
  if (req.repairIssues?.length)
    blocks.push(wrapData('repair_issues', req.repairIssues.map((i) => `- ${i}`).join('\n')));
  return blocks.join('\n\n');
}

/** One `cover.generate` / `cover.revise` CLI run. Returns structured content only; code renders the tex. */
export function runCoverTask(runner: ClaudeRunner, req: CoverTaskRequest): Promise<RunResult<CoverContent>> {
  const prompt = loadPrompt(req.task);
  return runner.run({
    task: req.task,
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: buildCoverInput(req),
    schema: CoverContentSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
  });
}
