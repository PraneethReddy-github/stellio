import type { TaskConfig } from '@shared/settings/ai';
import { ResourcesOutputSchema, type ResourcesOutput } from '@shared/skills/resources';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';

export interface ResourcesRequest {
  skill: string;
  targetLevel: number | null;
  estHours: number | null;
  /** Names of the candidate's related skills (status have). */
  related: readonly string[];
  config: TaskConfig;
  signal?: AbortSignal;
}

export function buildResourcesInput(req: ResourcesRequest): string {
  const context = [
    `target level: ${req.targetLevel === null ? '3' : String(req.targetLevel)} of 5`,
    `estimated hours: ${req.estHours === null ? 'unknown' : String(req.estHours)}`,
    `related skills the candidate has: ${req.related.join(', ') || 'none listed'}`,
  ].join('\n');
  return [wrapData('skill', req.skill), wrapData('context', context)].join('\n\n');
}

/** One `learning.resources` run: suggestions only, cleaned by `cleanResources`. */
export function suggestResources(
  runner: ClaudeRunner,
  req: ResourcesRequest,
): Promise<RunResult<ResourcesOutput>> {
  const prompt = loadPrompt('learning.resources');
  return runner.run({
    task: 'learning.resources',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: buildResourcesInput(req),
    schema: ResourcesOutputSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
  });
}
