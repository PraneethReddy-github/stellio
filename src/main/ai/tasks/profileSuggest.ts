import type { Profile } from '@shared/profile';
import { ProfileSuggestOutputSchema, type ProfileSuggestOutput } from '@shared/profile/suggest';
import type { TaskConfig } from '@shared/settings/ai';
import { loadPrompt } from '../prompts';
import type { ClaudeRunner, RunResult } from '../runner';
import { wrapData } from '../wrap';

export interface SuggestRequest {
  profile: Profile;
  decisions: { skill: string; decision: string; job: string }[];
  learningDone: { skill: string; doneAt: string }[];
  notes: string;
  today: string;
  config: TaskConfig;
  signal?: AbortSignal;
}

export function buildSuggestInput(req: SuggestRequest): string {
  const skills = req.profile.skills
    .map((s) =>
      [
        s.skill,
        s.level ?? '?',
        s.years ?? '?',
        s.last_used || '?',
        s.status,
        s.evidence.join(',') || '-',
      ].join(' | '),
    )
    .join('\n');
  const entries = [...req.profile.experience, ...req.profile.projects]
    .map((e) => `${e.id}: ${e.title}`)
    .join('\n');
  return [
    `<today>${req.today}</today>`,
    wrapData('profile_skills', skills || '(none)'),
    wrapData('profile_entries', entries || '(none)'),
    wrapData(
      'decisions',
      req.decisions.map((d) => `${d.skill} | ${d.decision} | ${d.job}`).join('\n') || '(none)',
    ),
    wrapData('learning_done', req.learningDone.map((l) => `${l.skill} | ${l.doneAt}`).join('\n') || '(none)'),
    wrapData('notes', req.notes || '(none)'),
  ].join('\n\n');
}

/** One `profile.suggest` run. Nothing is written; `applySuggestions` checks the output in code. */
export function suggestProfile(
  runner: ClaudeRunner,
  req: SuggestRequest,
): Promise<RunResult<ProfileSuggestOutput>> {
  const prompt = loadPrompt('profile.suggest');
  return runner.run({
    task: 'profile.suggest',
    model: req.config.model,
    effort: req.config.effort,
    systemPrompt: prompt.system,
    input: buildSuggestInput(req),
    schema: ProfileSuggestOutputSchema,
    jsonSchema: prompt.jsonSchema,
    timeoutMs: req.config.timeoutMs,
    signal: req.signal,
    priority: 'user',
    promptVersion: prompt.version,
  });
}
