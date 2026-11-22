import { desc, eq } from 'drizzle-orm';
import type { Db } from '../database';
import { aiRuns } from '../schema';

export type AiRun = typeof aiRuns.$inferSelect;
type NewAiRun = Pick<typeof aiRuns.$inferInsert, 'task' | 'model' | 'promptVersion'> &
  Partial<Pick<typeof aiRuns.$inferInsert, 'id' | 'inputHash' | 'relatedType' | 'relatedId' | 'startedAt'>>;

/** Records the start of an AI run (status `running`). */
export function insertAiRun(db: Db, run: NewAiRun): AiRun {
  return db.orm.insert(aiRuns).values(run).returning().get();
}

export function finishAiRun(
  db: Db,
  id: string,
  result: {
    status: Exclude<AiRun['status'], 'running'>;
    durationMs: number;
    exitCode?: number;
    error?: string;
    tokens?: { input?: number; output?: number };
  },
): void {
  const { tokens, ...rest } = result;
  db.orm
    .update(aiRuns)
    .set({ ...rest, tokensJson: tokens ?? null })
    .where(eq(aiRuns.id, id))
    .run();
}

/** Rows still `running` at startup belong to a previous process that died. Returns how many were fixed. */
export function markStaleRuns(db: Db): number {
  return db.orm
    .update(aiRuns)
    .set({ status: 'error', error: 'interrupted (app closed)' })
    .where(eq(aiRuns.status, 'running'))
    .run().changes;
}

export function listRecentAiRuns(db: Db, limit = 50): AiRun[] {
  return db.orm.select().from(aiRuns).orderBy(desc(aiRuns.startedAt)).limit(limit).all();
}

/** Links a run to the entity it worked on (Activity screen). */
export function setAiRunRelated(db: Db, id: string, relatedType: string, relatedId: string): void {
  db.orm.update(aiRuns).set({ relatedType, relatedId }).where(eq(aiRuns.id, id)).run();
}

export function getAiRun(db: Db, id: string): AiRun | undefined {
  return db.orm.select().from(aiRuns).where(eq(aiRuns.id, id)).get();
}
