import { JdSchema, type Jd } from '@shared/jobs/schemas';
import type { TaskConfig } from '@shared/settings/ai';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';

/** Longer postings are cut: the structure is in the first pages and the prompt stays cheap. */
export const MAX_JD_CHARS = 60_000;

export interface JdParseRequest {
  text: string;
  config: TaskConfig;
  signal?: AbortSignal;
  /** Scans run in the background; manual intake keeps the default `user`. */
  priority?: 'user' | 'background';
}

export function parseJd(runner: ClaudeRunner, req: JdParseRequest): Promise<RunResult<Jd>> {
  const prompt = loadPrompt('jd.parse');
  return runner.run({
    task: 'jd.parse',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: wrapData('job_description', req.text.slice(0, MAX_JD_CHARS)),
    schema: JdSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: req.priority ?? 'user',
    promptVersion: prompt.version,
  });
}
