import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, like } from 'drizzle-orm';
import type { Db } from '../db/database';
import { aiRuns } from '../db/schema';

/**
 * Deletes the run logs of `referrals.*` runs and clears their stored error text. `needles` limits it to runs whose
 * log mentions one of them (case-insensitive); omitted, every referrals run goes. Returns how many logs were removed.
 */
export async function deleteReferralLogs(
  db: Db,
  logDir: string,
  needles?: readonly string[],
): Promise<number> {
  const lower = needles?.map((n) => n.toLowerCase()).filter((n) => n !== '');
  const runs = db.orm.select({ id: aiRuns.id }).from(aiRuns).where(like(aiRuns.task, 'referrals.%')).all();
  let removed = 0;
  for (const { id } of runs) {
    const file = join(logDir, `${id}.json`);
    if (lower) {
      let text: string;
      try {
        text = (await readFile(file, 'utf8')).toLowerCase();
      } catch {
        continue;
      }
      if (!lower.some((n) => text.includes(n))) continue;
    }
    try {
      await rm(file);
      removed++;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    db.orm.update(aiRuns).set({ error: null }).where(eq(aiRuns.id, id)).run();
  }
  return removed;
}

/** Deletes `*.json` run logs older than `maxAgeDays` (by mtime). Returns how many were removed. */
export async function pruneAiLogs(dir: string, maxAgeDays = 30): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let removed = 0;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const f = join(dir, n);
    if ((await stat(f)).mtimeMs < cutoff) {
      await rm(f, { force: true });
      removed++;
    }
  }
  return removed;
}
