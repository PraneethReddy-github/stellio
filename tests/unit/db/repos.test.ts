import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { finishAiRun, insertAiRun, listRecentAiRuns, markStaleRuns } from '../../../src/main/db/repos/aiRuns';
import { getSetting, setSetting } from '../../../src/main/db/repos/settings';
import { freshDb } from './helpers';

describe('aiRuns repo', () => {
  it('inserts a running row and finishes it', () => {
    const db = freshDb();
    const run = insertAiRun(db, {
      task: 'analyze_job',
      model: 'sonnet',
      promptVersion: 'v1',
      inputHash: 'h',
    });
    expect(run.status).toBe('running');
    finishAiRun(db, run.id, {
      status: 'error',
      durationMs: 120,
      exitCode: 1,
      error: 'boom',
      tokens: { input: 5, output: 7 },
    });
    const [row] = listRecentAiRuns(db);
    expect(row).toMatchObject({
      id: run.id,
      status: 'error',
      durationMs: 120,
      exitCode: 1,
      error: 'boom',
      tokensJson: { input: 5, output: 7 },
    });
  });

  it('lists most recent first, honouring limit', () => {
    const db = freshDb();
    for (const [i, startedAt] of ['2026-11-01', '2026-11-03', '2026-11-02'].entries()) {
      insertAiRun(db, { task: `t${i}`, model: 'm', promptVersion: 'v1', startedAt });
    }
    expect(listRecentAiRuns(db, 2).map((r) => r.task)).toEqual(['t1', 't2']);
  });
});

describe('markStaleRuns', () => {
  it('flips only rows still running to error', () => {
    const db = freshDb();
    const stale = insertAiRun(db, { task: 'a', model: 'm', promptVersion: 'v1' });
    const done = insertAiRun(db, { task: 'b', model: 'm', promptVersion: 'v1' });
    finishAiRun(db, done.id, { status: 'ok', durationMs: 5 });
    expect(markStaleRuns(db)).toBe(1);
    const rows = Object.fromEntries(listRecentAiRuns(db).map((r) => [r.id, r]));
    expect(rows[stale.id]).toMatchObject({ status: 'error', error: 'interrupted (app closed)' });
    expect(rows[done.id]).toMatchObject({ status: 'ok', error: null });
    expect(markStaleRuns(db)).toBe(0);
  });
});

describe('settings repo', () => {
  const schema = z.object({ hour: z.number() });

  it('returns undefined when missing', () => {
    expect(getSetting(freshDb(), 'scan', schema)).toBeUndefined();
  });

  it('round-trips and overwrites', () => {
    const db = freshDb();
    setSetting(db, 'scan', { hour: 7 });
    setSetting(db, 'scan', { hour: 9 });
    expect(getSetting(db, 'scan', schema)).toEqual({ hour: 9 });
  });

  it('throws when the stored value fails validation', () => {
    const db = freshDb();
    setSetting(db, 'scan', { hour: 'x' });
    expect(() => getSetting(db, 'scan', schema)).toThrow();
  });
});
