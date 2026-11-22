import { ResumeContentSchema, type ResumeContent } from '@shared/documents';
import type { AnalysisResult, Jd } from '@shared/jobs/schemas';
import { profileForPrompt, type Profile } from '@shared/profile';
import type { TaskConfig } from '@shared/settings/ai';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';
import { MAX_JD_CHARS } from './jdParse';

export type ResumeTask = 'resume.generate' | 'resume.revise';

export interface ResumeTaskRequest {
  task: ResumeTask;
  /** Excluded entries already removed. */
  profile: Profile;
  jd: Jd | null;
  descriptionMd: string;
  analysis: AnalysisResult | null;
  /** Raw rules files, embedded verbatim as USER RULES (docs/04 §4). */
  resumeRules: string;
  skillsPolicy: string;
  /** Skills the skills section may list, one per line with aliases. */
  allowedSkills: string[];
  /** revise: the draft to change; repair: the draft that failed the checks. */
  previous?: ResumeContent;
  instruction?: string | null;
  /** Exact check failures for the one repair round. */
  repairIssues?: string[];
  config: TaskConfig;
  signal?: AbortSignal;
}

export function buildResumeInput(req: ResumeTaskRequest): string {
  const blocks = [
    'USER RULES — follow exactly; they override style defaults, never override truth rules.',
    wrapData('resume_rules', req.resumeRules),
    wrapData('skills_policy', req.skillsPolicy),
    wrapData('allowed_skills', req.allowedSkills.join('\n') || '(none)'),
    wrapData('profile', profileForPrompt(req.profile)),
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

/** One `resume.generate` / `resume.revise` CLI run. Returns structured content only; code renders the tex. */
export function runResumeTask(
  runner: ClaudeRunner,
  req: ResumeTaskRequest,
): Promise<RunResult<ResumeContent>> {
  const prompt = loadPrompt(req.task);
  return runner.run({
    task: req.task,
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: buildResumeInput(req),
    schema: ResumeContentSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
  });
}
