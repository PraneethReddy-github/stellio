import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AiRunLogSchema, RunIdSchema, type AiRunInfo, type AiRunLog } from '@shared/ai/runs';
import type { Db } from '../../db/database';
import { getAiRun, listRecentAiRuns, type AiRun } from '../../db/repos/aiRuns';
import { UserError } from '../../ipc/dispatch';

const toInfo = (r: AiRun): AiRunInfo => ({
  id: r.id,
  task: r.task,
  model: r.model,
  promptVersion: r.promptVersion,
  startedAt: r.startedAt,
  durationMs: r.durationMs,
  status: r.status,
  exitCode: r.exitCode,
  tokens: r.tokensJson,
  error: r.error,
  relatedType: r.relatedType,
  relatedId: r.relatedId,
});

/** Reads one run log from `logDir` by id only. Null when pruned, missing or unreadable. */
export async function readRunLog(logDir: string, id: string): Promise<AiRunLog | null> {
  if (!RunIdSchema.safeParse(id).success) return null;
  try {
    const raw = JSON.parse(await readFile(join(logDir, `${id}.json`), 'utf8')) as unknown;
    const parsed = AiRunLogSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createRunsService(db: Db, logDir: string) {
  return {
    list: (limit: number): AiRunInfo[] => listRecentAiRuns(db, limit).map(toInfo),
    async get(id: string): Promise<{ run: AiRunInfo; log: AiRunLog | null }> {
      const run = getAiRun(db, id);
      if (!run) throw new UserError('That run no longer exists.');
      return { run: toInfo(run), log: await readRunLog(logDir, id) };
    },
  };
}
export type RunsService = ReturnType<typeof createRunsService>;
