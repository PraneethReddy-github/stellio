import { z } from 'zod';

/** Every AI task (docs/04 §2). */
export const AI_TASKS = [
  'jd.parse',
  'job.triage',
  'job.analyze',
  'job.sideFit',
  'resume.generate',
  'resume.revise',
  'cover.generate',
  'cover.revise',
  'resume.translate',
  'cover.translate',
  'skills.audit',
  'profile.import',
  'profile.suggest',
  'discovery.websearch',
  'referrals.search',
  'referrals.message',
  'insights.ask',
  'learning.resources',
] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** Tasks that get the longer timeout. */
const GENERATION_TASKS: readonly AiTask[] = [
  'resume.generate',
  'resume.revise',
  'cover.generate',
  'cover.revise',
  'resume.translate',
  'cover.translate',
  'profile.import',
  'referrals.search',
  'referrals.message',
];

export const EFFORTS = ['low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';

export const TaskModelSchema = z.object({
  /** Goes into argv: must start with a letter or digit so it can never read as a flag. */
  model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/, 'Not a valid model id'),
  effort: z.enum(EFFORTS),
});
export type TaskModel = z.infer<typeof TaskModelSchema>;

export const AiSettingsSchema = z.object({
  models: z.record(z.enum(AI_TASKS), TaskModelSchema),
  /** Parallel Claude CLI processes. */
  concurrency: z.number().int().min(1).max(4),
  timeoutsSec: z.object({
    default: z.number().int().min(10).max(1800),
    generation: z.number().int().min(10).max(1800),
  }),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

const m = (model: string, effort: Effort): TaskModel => ({ model, effort });
export const DEFAULT_AI_SETTINGS: AiSettings = {
  models: {
    'jd.parse': m(HAIKU, 'low'),
    'job.triage': m(HAIKU, 'low'),
    'job.analyze': m(SONNET, 'medium'),
    'job.sideFit': m(SONNET, 'low'),
    'resume.generate': m(SONNET, 'high'),
    'resume.revise': m(SONNET, 'medium'),
    'cover.generate': m(SONNET, 'high'),
    'cover.revise': m(SONNET, 'high'),
    'resume.translate': m(SONNET, 'medium'),
    'cover.translate': m(SONNET, 'medium'),
    'skills.audit': m(SONNET, 'medium'),
    'profile.import': m(SONNET, 'high'),
    'profile.suggest': m(SONNET, 'medium'),
    'discovery.websearch': m(SONNET, 'medium'),
    'referrals.search': m(SONNET, 'medium'),
    'referrals.message': m(SONNET, 'high'),
    'insights.ask': m(SONNET, 'medium'),
    'learning.resources': m(SONNET, 'low'),
  },
  concurrency: 2,
  timeoutsSec: { default: 180, generation: 300 },
};

export interface TaskConfig {
  model: string;
  effort: Effort;
  timeoutMs: number;
}

export function taskConfig(settings: AiSettings, task: AiTask): TaskConfig {
  const { model, effort } = settings.models[task];
  const sec = GENERATION_TASKS.includes(task)
    ? settings.timeoutsSec.generation
    : settings.timeoutsSec.default;
  return { model, effort, timeoutMs: sec * 1000 };
}

/** Fills gaps in a stored value with defaults; falls back to defaults entirely if it is not usable. */
export function resolveAiSettings(stored: unknown): AiSettings {
  const s = (typeof stored === 'object' && stored !== null ? stored : {}) as Partial<AiSettings>;
  const merged = {
    ...DEFAULT_AI_SETTINGS,
    ...s,
    models: { ...DEFAULT_AI_SETTINGS.models, ...s.models },
    timeoutsSec: { ...DEFAULT_AI_SETTINGS.timeoutsSec, ...s.timeoutsSec },
  };
  const parsed = AiSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_AI_SETTINGS;
}
