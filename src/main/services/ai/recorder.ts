import type { AiRunRecorder } from '../../ai/runner';
import type { Db } from '../../db/database';
import { finishAiRun, insertAiRun } from '../../db/repos/aiRuns';

/** Persists every Claude CLI run to `ai_runs` (Activity screen, debugging). */
export function createDbRecorder(db: Db, onUsageLimit?: (info: { message: string }) => void): AiRunRecorder {
  return {
    start: (run) => {
      insertAiRun(db, {
        id: run.id,
        task: run.task,
        model: run.model,
        promptVersion: run.promptVersion === undefined ? 'none' : `v${String(run.promptVersion)}`,
        inputHash: run.inputHash,
        startedAt: run.startedAt,
      });
    },
    finish: (id, r) => {
      finishAiRun(db, id, {
        status: r.status,
        durationMs: r.durationMs,
        ...(r.exitCode != null ? { exitCode: r.exitCode } : {}),
        ...(r.error ? { error: r.error } : {}),
        tokens: { input: r.tokensIn, output: r.tokensOut },
      });
      if (r.status === 'usage_limit') onUsageLimit?.({ message: r.error ?? 'Claude usage limit reached' });
    },
  };
}
