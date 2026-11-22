import { z } from 'zod';
import type { TaskConfig } from '@shared/settings/ai';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';

// ---- job.triage ------------------------------------------------------------------------------------------

export const TriageOutputSchema = z.object({
  scores: z.array(z.object({ id: z.string(), score: z.number().int().min(0).max(100), reason: z.string() })),
});
export type TriageOutput = z.infer<typeof TriageOutputSchema>;

export interface TriageJob {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remote: string;
  salary: string | null;
  excerpt: string;
}
export const TRIAGE_BATCH = 10;
const EXCERPT_CHARS = 1200;

export function buildTriageInput(profileText: string, jobs: readonly TriageJob[]): string {
  const blocks = jobs.map(
    (j) =>
      `<job id="${j.id}">\n${[
        `title: ${j.title}`,
        `company: ${j.company}`,
        j.location && `location: ${j.location}`,
        `workplace: ${j.remote}`,
        j.salary && `salary: ${j.salary}`,
        `excerpt: ${j.excerpt.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS)}`,
      ]
        .filter(Boolean)
        .join('\n')}\n</job>`,
  );
  return `<profile>\n${profileText}\n</profile>\n\n${wrapData('jobs', blocks.join('\n'))}`;
}

export function triageJobs(
  runner: ClaudeRunner,
  req: { profileText: string; jobs: readonly TriageJob[]; config: TaskConfig; signal?: AbortSignal },
): Promise<RunResult<TriageOutput>> {
  const prompt = loadPrompt('job.triage');
  return runner.run({
    task: 'job.triage',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: buildTriageInput(req.profileText, req.jobs),
    schema: TriageOutputSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'background',
    promptVersion: prompt.version,
  });
}

// ---- discovery.websearch ---------------------------------------------------------------------------------

export const WebSearchOutputSchema = z.object({
  results: z.array(
    z.object({ url: z.string(), title: z.string(), company: z.string(), snippet: z.string() }),
  ),
});
export type WebSearchOutput = z.infer<typeof WebSearchOutputSchema>;

export function searchTheWeb(
  runner: ClaudeRunner,
  req: { profileText: string; limit: number; today: string; config: TaskConfig; signal?: AbortSignal },
): Promise<RunResult<WebSearchOutput>> {
  const prompt = loadPrompt('discovery.websearch');
  return runner.run({
    task: 'discovery.websearch',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: `<search_profile>\n${req.profileText}\n</search_profile>\n<limit>${String(req.limit)}</limit>\n<date>${req.today}</date>`,
    schema: WebSearchOutputSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'background',
    promptVersion: prompt.version,
    tools: 'WebSearch,WebFetch',
  });
}
