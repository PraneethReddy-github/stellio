import { z } from 'zod';
import type { TextItem } from '@shared/documents';
import type { TaskConfig } from '@shared/settings/ai';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';

export type TranslateTask = 'resume.translate' | 'cover.translate';

/** What both translate tasks return: the same keys, German text. Code puts the texts back (D27). */
export const TranslationSchema = z.object({
  items: z.array(z.object({ key: z.string(), text: z.string() })),
});
export type Translation = z.infer<typeof TranslationSchema>;

export interface TranslateRequest {
  task: TranslateTask;
  /** The English texts with their keys. */
  items: TextItem[];
  /** Job title and company, for terminology. */
  context: string;
  /** Repair round: the previous translation and the exact check failures. */
  previous?: Translation;
  repairIssues?: string[];
  config: TaskConfig;
  signal?: AbortSignal;
}

export function buildTranslateInput(req: TranslateRequest): string {
  const blocks = [
    wrapData('job', req.context),
    wrapData('texts', JSON.stringify({ items: req.items }, null, 1)),
  ];
  if (req.previous) blocks.push(wrapData('previous_translation', JSON.stringify(req.previous, null, 1)));
  if (req.repairIssues?.length)
    blocks.push(wrapData('repair_issues', req.repairIssues.map((i) => `- ${i}`).join('\n')));
  return blocks.join('\n\n');
}

/** One `resume.translate` / `cover.translate` CLI run. */
export function runTranslateTask(
  runner: ClaudeRunner,
  req: TranslateRequest,
): Promise<RunResult<Translation>> {
  const prompt = loadPrompt(req.task);
  return runner.run({
    task: req.task,
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: buildTranslateInput(req),
    schema: TranslationSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
  });
}
