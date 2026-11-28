import { SideFitResultSchema, type Jd, type SideFitResult } from '@shared/jobs/schemas';
import { profileForPrompt, type Profile } from '@shared/profile';
import type { TaskConfig } from '@shared/settings/ai';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';
import { MAX_JD_CHARS } from './jdParse';

export interface SideFitRequest {
  /** The side-job limits (`sideJobBrief`). */
  sideJob: string;
  profile: Profile;
  jd: Jd | null;
  descriptionMd: string;
  config: TaskConfig;
  signal?: AbortSignal;
}

export function checkSideJob(runner: ClaudeRunner, req: SideFitRequest): Promise<RunResult<SideFitResult>> {
  const prompt = loadPrompt('job.sideFit');
  return runner.run({
    task: 'job.sideFit',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: [
      `<side_job>\n${req.sideJob}\n</side_job>`,
      wrapData('profile', profileForPrompt(req.profile)),
      wrapData('job_structured', JSON.stringify(req.jd)),
      wrapData('job_description', req.descriptionMd.slice(0, MAX_JD_CHARS)),
    ].join('\n\n'),
    schema: SideFitResultSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
  });
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Never trusts a quote: one the posting does not contain (whitespace and case aside) is dropped, so every quote
 * shown is the posting's own words. Also keeps one check per aspect and the verdict in line with the score bands.
 */
export function validateSideFit(out: SideFitResult, descriptionMd: string): SideFitResult {
  const text = flat(descriptionMd);
  const seen = new Set<string>();
  const checks = out.checks.flatMap((c) => {
    if (seen.has(c.aspect)) return [];
    seen.add(c.aspect);
    const quote = c.quote && flat(c.quote).length > 0 && text.includes(flat(c.quote)) ? c.quote.trim() : null;
    return [{ ...c, quote }];
  });
  const verdict = out.side_score >= 75 ? 'take' : out.side_score >= 45 ? 'maybe' : 'skip';
  return { ...out, verdict, checks };
}
