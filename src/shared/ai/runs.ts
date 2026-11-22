import { z } from 'zod';

/** Mirror of AI_RUN_STATUSES in src/main/db/schema.ts (a unit test keeps them equal). */
export const AI_RUN_STATUSES = [
  'running',
  'ok',
  'error',
  'timeout',
  'cancelled',
  'invalid_output',
  'auth',
  'usage_limit',
  'bad_model',
] as const;

/** Run ids are ULIDs; the log file name is derived from them, so the format is enforced. */
export const RunIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

export const AiRunSchema = z.object({
  id: z.string(),
  task: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  startedAt: z.string(),
  durationMs: z.number().nullable(),
  status: z.enum(AI_RUN_STATUSES),
  exitCode: z.number().nullable(),
  tokens: z.object({ input: z.number().optional(), output: z.number().optional() }).nullable(),
  error: z.string().nullable(),
  relatedType: z.string().nullable(),
  relatedId: z.string().nullable(),
});
export type AiRunInfo = z.infer<typeof AiRunSchema>;

/** The saved prompt and raw output of a run (from `.stellio/logs/ai/<id>.json`; pruned after 30 days). */
export const AiRunLogSchema = z.object({
  system: z.string(),
  input: z.string(),
  attempts: z.array(
    z.object({
      stdout: z.string(),
      stderr: z.string(),
      exitCode: z.number().nullable(),
      timedOut: z.boolean(),
      aborted: z.boolean(),
    }),
  ),
});
export type AiRunLog = z.infer<typeof AiRunLogSchema>;
