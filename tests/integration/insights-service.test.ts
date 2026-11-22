import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeRunner } from '../../src/main/ai/runner';
import type { Db } from '../../src/main/db/database';
import { appendEvent } from '../../src/main/db/repos/applications';
import { createJob } from '../../src/main/db/repos/jobs';
import { applications, documents } from '../../src/main/db/schema';
import { createDbRecorder } from '../../src/main/services/ai/recorder';
import { createInsightsService, loadInsightApps } from '../../src/main/services/insights/service';
import { createAiSettings } from '../../src/main/services/settings/ai';
import { seedTemplate } from '../fixtures/resume';
import { freshDb, tempDir } from '../unit/db/helpers';

const FAKE = resolve('tests/fixtures/fake-claude/claude.mjs');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = new Date('2026-11-21T12:00:00Z');

type Status = typeof applications.$inferInsert.status;
let n = 0;
/** One sent application from the "adzuna" board. `reply` is the status the company moved it to, if any. */
function sent(db: Db, appliedAt: string, status: Status, reply?: { to: Status; at: string }) {
  const job = createJob(
    db,
    `Co${String(n)}`,
    {
      title: 'Data Engineer',
      dedupeKey: `k${String(n)}`,
      remote: 'remote',
      postedAt: '2026-10-25T10:00:00Z',
    },
    { source: 'adzuna', externalId: `x${String(n++)}`, url: null, rawJson: null },
  );
  const app = db.orm
    .insert(applications)
    .values({ jobId: job.id, status, statusChangedAt: appliedAt, appliedAt })
    .returning()
    .get();
  appendEvent(db, app.id, 'status_change', {}, appliedAt, { to: 'applied' });
  if (reply) appendEvent(db, app.id, 'status_change', {}, reply.at, { to: reply.to });
  return { job, app };
}

/** 6 applications: 3 got a reply (screening, rejected, interviewing), 3 did not. */
function seed(db: Db): void {
  sent(db, '2026-11-01T10:00:00Z', 'screening', { to: 'screening', at: '2026-11-04T10:00:00Z' });
  sent(db, '2026-11-02T10:00:00Z', 'rejected', { to: 'rejected', at: '2026-11-12T10:00:00Z' });
  sent(db, '2026-11-03T10:00:00Z', 'interviewing', { to: 'interviewing', at: '2026-11-05T10:00:00Z' });
  sent(db, '2026-11-04T10:00:00Z', 'applied');
  sent(db, '2026-11-05T10:00:00Z', 'applied');
  sent(db, '2026-11-06T10:00:00Z', 'applied');
}

const RIGHT = {
  answer: 'Across your 6 applications, 50% got a reply.',
  numbers_used: [
    { label: 'applications', value: '6' },
    { label: 'response rate', value: '50%' },
  ],
};
const WRONG = {
  answer: 'Across your 6 applications, 55% got a reply.',
  numbers_used: [
    { label: 'applications', value: '6' },
    { label: 'response rate', value: '55%' },
  ],
};

function setup(env: Record<string, string> = {}, populate = true) {
  const db = freshDb();
  if (populate) seed(db);
  const dir = tempDir();
  const cap = join(dir, 'capture.ndjson');
  const settings = createAiSettings(db);
  const runner = createClaudeRunner({
    bin: FAKE,
    cwd: join(dir, 'cwd'),
    logger,
    recorder: createDbRecorder(db, vi.fn()),
    retryDelayMs: 1,
    env: { FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_CAPTURE: cap, ...env },
  });
  const insights = createInsightsService({
    db,
    runner,
    settings,
    learning: { roadmap: () => Promise.resolve({ items: [], openJobs: 0 }) },
    now: () => NOW,
  });
  const calls = (): { stdin: string }[] =>
    existsSync(cap)
      ? readFileSync(cap, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { kind: string; stdin: string })
          .filter((r) => r.kind === 'call')
      : [];
  return { db, insights, calls };
}

describe('insights summary from the database', () => {
  it('reads sources, fit, replies and the final resume skills', () => {
    const { db, insights } = setup();
    // the first application gets a final resume with a skills line and a final cover letter
    const first = db.orm.select().from(applications).all()[0];
    if (!first) throw new Error('seed missing');
    const tex = seedTemplate.replace(/\\skillLine\{[^}]*\}\{[^}]*\}/, '\\skillLine{Languages}{Python, SQL}');
    db.orm
      .insert(documents)
      .values({ jobId: first.jobId, kind: 'resume', version: 1, tex, isFinal: true })
      .run();
    db.orm
      .insert(documents)
      .values({ jobId: first.jobId, kind: 'cover_letter', version: 1, tex: '', isFinal: true })
      .run();

    const apps = loadInsightApps(db);
    expect(apps).toHaveLength(6);
    expect(apps.filter((a) => a.coverLetter)).toHaveLength(1);
    const s = insights.summary('all');
    expect(s.totals).toMatchObject({ applications: 6, responses: 3, interviews: 1, insufficient: false });
    expect(s.totals.responseRate).toBeCloseTo(0.5);
    expect(s.dimensions.find((d) => d.key === 'source')?.segments).toMatchObject([
      { label: 'adzuna', applications: 6 },
    ]);
    // 3, 10 and 2 days to the first reply
    expect(s.timeToResponse).toEqual({ medianDays: 3, responses: 3 });
    const skills = s.dimensions.find((d) => d.key === 'skills')?.segments ?? [];
    expect(skills.map((x) => x.label)).toEqual(expect.arrayContaining(['Python', 'SQL']));
    expect(skills.every((x) => x.applications === 1)).toBe(true);
  });

  it('a fresh install has no rows and no segments', () => {
    const s = setup({}, false).insights.summary('90d');
    expect(s.totals).toMatchObject({ applications: 0, insufficient: true });
    expect(s.dimensions).toEqual([]);
    expect(s.timeToResponse.medianDays).toBeNull();
  });
});

describe('insights.ask', () => {
  it('passes a correct answer in one run and sends only aggregated data', async () => {
    const { insights, calls } = setup({ FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK: JSON.stringify(RIGHT) });
    const a = await insights.ask('How is my search going?');
    expect(a).toEqual({
      answer: RIGHT.answer,
      numbersUsed: RIGHT.numbers_used,
      warning: null,
    });
    expect(calls()).toHaveLength(1);
    const sent = calls()[0]?.stdin ?? '';
    expect(sent).toContain('<insights>');
    expect(sent).toContain('"response_rate_pct": 50');
    // no company, job title or note ever reaches the model
    expect(sent).not.toMatch(/Co\d|Data Engineer|notes/);
  });

  it('a wrong number gets one repair round, then passes', async () => {
    const { insights, calls } = setup({
      FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK: JSON.stringify(WRONG),
      FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK_REPAIR: JSON.stringify(RIGHT),
    });
    const a = await insights.ask('How is my search going?');
    expect(a.answer).toBe(RIGHT.answer);
    expect(a.warning).toBeNull();
    expect(calls()).toHaveLength(2);
    expect(calls()[1]?.stdin).toContain('<repair_issues>');
    expect(calls()[1]?.stdin).toContain('55 does not appear in the data');
  });

  it('a number the answer states but does not list also gets the repair round', async () => {
    const unlisted = { answer: RIGHT.answer, numbers_used: [RIGHT.numbers_used[1]] };
    const { insights, calls } = setup({
      FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK: JSON.stringify(unlisted),
      FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK_REPAIR: JSON.stringify(RIGHT),
    });
    expect((await insights.ask('How is my search going?')).warning).toBeNull();
    expect(calls()[1]?.stdin).toContain('"6" is in the answer but not in numbers_used');
  });

  it('still wrong after the repair: the answer is shown with a warning', async () => {
    const { insights, calls } = setup({ FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK: JSON.stringify(WRONG) });
    const a = await insights.ask('How is my search going?');
    expect(a.answer).toBe(WRONG.answer);
    expect(a.warning).toMatch(/could not be matched to your data/);
    expect(a.warning).toMatch(/55 does not appear in the data/);
    expect(calls()).toHaveLength(2);
  });

  it('without any application it answers in code and never calls the model', async () => {
    const { insights, calls } = setup({}, false);
    const a = await insights.ask('What should I do?');
    expect(a.answer).toMatch(/nothing to analyse yet/);
    expect(a.warning).toBeNull();
    expect(calls()).toHaveLength(0);
  });

  it('a failed run is a readable error', async () => {
    const { insights } = setup({ FAKE_CLAUDE_MODE: 'auth' });
    await expect(insights.ask('How is my search going?')).rejects.toThrow(/not logged in/);
  });
});
