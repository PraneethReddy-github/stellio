import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { goodContent } from '../fixtures/resume';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;
const DAY = 86_400_000;

type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface App {
  id: string;
  status: string;
  appliedAt: string | null;
  folderPath: string | null;
  nextAction: string | null;
}
interface Today {
  statusLine: { key: string; count: number; previous: number; current: number }[];
  needsYou: {
    followUps: { company: string; action: string }[];
    interviews: { round: number; when: string }[];
    ghosted: unknown[];
  };
  funnel: { steps: { key: string; count: number; conversion: number | null }[] };
  weekly: { weekStart: string; count: number }[];
}
const localDate = (d: Date): string =>
  `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
  ...(existsSync(TECTONIC) ? { STELLIO_TECTONIC_BIN: TECTONIC } : {}),
  FAKE_CLAUDE_MODE: 'ok',
  FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
  FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
  FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(goodContent),
  ...extra,
});

function helpers(get: () => Launched) {
  const call = <T>(channel: string, input?: unknown) => invoke(get().page, channel, input) as Promise<Res<T>>;
  const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
    const r = await call<T>(channel, input);
    if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
    return r.data;
  };
  /** Profile, one parsed + analysed job. */
  const seed = async (): Promise<string> => {
    const markdown = readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8');
    await ok('profile:save', { markdown, expectedHash: null });
    const intake = await ok<{ jobId: string }>('jobs:intakeText', { text: POSTING, requestId: randomUUID() });
    await ok('jobs:analyze', { id: intake.jobId, requestId: randomUUID() });
    return intake.jobId;
  };
  return { call, ok, seed };
}

test.describe('tracker lifecycle over IPC (fake CLI)', () => {
  let l: Launched;
  const { call, ok, seed } = helpers(() => l);
  test.beforeAll(async () => {
    l = await launchApp(env());
  });
  test.afterAll(async () => {
    await l.close();
  });

  test('saved → preparing → ready → applied (frozen) → screening → interviewing → rejected', async () => {
    const jobId = await seed();
    expect(await ok('apps:forJob', { jobId })).toBeNull();

    // shortlisting makes the application
    await ok('jobs:setState', { id: jobId, state: 'shortlisted' });
    const saved = await ok<App>('apps:forJob', { jobId });
    expect(saved).toMatchObject({ status: 'saved', appliedAt: null, folderPath: null });
    expect((await ok<{ id: string }>('apps:create', { jobId })).id).toBe(saved.id); // idempotent

    // starting a resume moves it to preparing
    await ok('resume:generate', { jobId, requestId: randomUUID() });
    expect((await ok<App>('apps:forJob', { jobId })).status).toBe('preparing');

    // applying needs a final resume
    expect(await call('apps:setStatus', { id: saved.id, status: 'applied' })).toMatchObject({
      ok: false,
      error: { code: 'failed', message: expect.stringContaining('final resume') as unknown },
    });
    await ok('resume:markFinal', { jobId, version: 1 });
    expect((await ok<App>('apps:setStatus', { id: saved.id, status: 'ready' })).status).toBe('ready');

    // inputs are validated at the boundary
    expect(await call('apps:setStatus', { id: saved.id, status: 'rejected' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('apps:setStatus', { id: saved.id, status: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('apps:update', { id: saved.id, patch: { priority: 5 } })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('apps:openFolder', { id: saved.id })).toMatchObject({
      ok: false,
      error: { code: 'failed' },
    });

    // apply: the folder is frozen on disk and committed
    const applied = await ok<App>('apps:setStatus', { id: saved.id, status: 'applied' });
    const rel = `applications/${localDate(new Date())}_nimbus-analytics-gmbh_data-engineer`;
    expect(applied).toMatchObject({ status: 'applied', folderPath: rel, nextAction: 'Follow up' });
    const files = readdirSync(join(l.dataDir, rel)).sort();
    expect(files).toEqual(
      existsSync(TECTONIC)
        ? ['analysis.json', 'jd.md', 'meta.json', 'resume.pdf', 'resume.tex']
        : ['analysis.json', 'jd.md', 'meta.json', 'resume.tex'],
    );
    const resume = await ok<{ tex: string }>('resume:get', { jobId, version: 1 });
    expect(readFileSync(join(l.dataDir, rel, 'resume.tex'), 'utf8')).toBe(resume.tex);
    expect(JSON.parse(readFileSync(join(l.dataDir, rel, 'meta.json'), 'utf8'))).toMatchObject({
      company: 'Nimbus Analytics GmbH',
      forced: null,
      resume: { version: 1 },
    });
    expect(readFileSync(join(l.dataDir, rel, 'jd.md'), 'utf8')).toContain('Build pipelines');
    expect(
      execFileSync('git', ['-C', l.dataDir, 'log', '-1', '--format=%s'], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      })
        .toString()
        .trim(),
    ).toBe('apply: Nimbus Analytics GmbH — Data Engineer');

    // open folder: only the frozen folder, through shell.openPath (stubbed)
    await l.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __openedPaths: string[] };
      g.__openedPaths = [];
      shell.openPath = (p: string) => {
        g.__openedPaths.push(p);
        return Promise.resolve('');
      };
    });
    expect(await ok('apps:openFolder', { id: saved.id })).toEqual({ path: join(l.dataDir, rel) });
    expect(
      await l.app.evaluate(() => (globalThis as unknown as { __openedPaths: string[] }).__openedPaths),
    ).toEqual([join(l.dataDir, rel)]);

    // after applying
    await ok('apps:setStatus', { id: saved.id, status: 'screening' });
    const now = Date.now();
    await ok('apps:interview:add', {
      applicationId: saved.id,
      kind: 'screen',
      scheduledAt: new Date(now - 2 * DAY).toISOString(),
      outcome: 'passed',
    });
    await ok('apps:setStatus', { id: saved.id, status: 'interviewing' });
    const round2 = await ok<{ round: number }>('apps:interview:add', {
      applicationId: saved.id,
      kind: 'technical',
      scheduledAt: new Date(now + DAY).toISOString(),
    });
    expect(round2.round).toBe(2);
    await ok('apps:note', { id: saved.id, text: 'Talked to the hiring manager' });

    // Today while interviewing: thank-you is due, round 2 is tomorrow
    const mid = await ok<Today>('today:summary');
    expect(mid.needsYou.followUps.map((f) => [f.company, f.action])).toEqual([
      ['Nimbus Analytics GmbH', 'Send a thank-you note'],
    ]);
    expect(mid.needsYou.interviews.map((i) => [i.round, i.when])).toEqual([[2, 'tomorrow']]);
    expect(mid.needsYou.ghosted).toEqual([]);

    // rejected needs a stage
    expect(await call('apps:setStatus', { id: saved.id, status: 'rejected', meta: {} })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    const rejected = await ok<App>('apps:setStatus', {
      id: saved.id,
      status: 'rejected',
      meta: { stage: 'after_interview', note: 'went with an internal candidate' },
    });
    expect(rejected).toMatchObject({ status: 'rejected', nextAction: null });

    // the detail's trail
    const detail = await ok<{
      events: { type: string; toStatus: string | null; payload: Record<string, unknown> | null }[];
      interviews: { round: number; outcome: string }[];
      frozen: { folder: string; files: string[] };
      analysisFrozen: boolean;
      analysis: { fitScore: number };
      documents: { resume: { version: number; isFinal: boolean }[] };
    }>('tracker:get', { id: saved.id });
    expect(detail.events.filter((e) => e.type === 'status_change').map((e) => e.toStatus)).toEqual([
      'saved',
      'preparing',
      'ready',
      'applied',
      'screening',
      'interviewing',
      'rejected',
    ]);
    expect(detail.events.find((e) => e.toStatus === 'rejected')?.payload).toMatchObject({
      stage: 'after_interview',
    });
    expect(detail.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['document', 'interview', 'note']),
    );
    expect(detail.interviews.map((i) => [i.round, i.outcome])).toEqual([
      [1, 'passed'],
      [2, 'pending'],
    ]);
    expect(detail.frozen.files).toEqual(files);
    expect(detail.analysisFrozen).toBe(true);
    expect(detail.analysis.fitScore).toBe(88);
    expect(detail.documents.resume).toMatchObject([{ version: 1, isFinal: true }]);

    // views
    const board = await ok<{ lanes: { id: string; cards: { company: string; daysInStatus: number }[] }[] }>(
      'tracker:board',
    );
    expect(board.lanes.map((x) => [x.id, x.cards.length])).toEqual([
      ['not_applied', 0],
      ['applied', 0],
      ['in_process', 0],
      ['waiting', 0],
      ['closed', 1],
    ]);
    expect(board.lanes[4]?.cards[0]).toMatchObject({ company: 'Nimbus Analytics GmbH', daysInStatus: 0 });
    const table = await ok<{
      rows: { status: string; fit: number; daysSince: number; resumeVersion: number }[];
    }>('tracker:table', {
      filters: { status: ['rejected'], text: 'nimbus' },
      sort: { by: 'company', dir: 'asc' },
    });
    expect(table.rows).toMatchObject([{ status: 'rejected', fit: 88, daysSince: 0, resumeVersion: 1 }]);
    const from = localDate(new Date(now - 3 * DAY));
    const to = localDate(new Date(now + 3 * DAY));
    const tl = await ok<{ items: { kind: string }[] }>('tracker:timeline', { from, to });
    expect(tl.items.map((i) => i.kind).sort()).toEqual(['applied', 'interview', 'interview']);

    // CSV through the save dialog (stubbed)
    const csvPath = join(l.sandbox, 'apps.csv');
    await l.app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
    }, csvPath);
    expect(await ok('tracker:exportCsv', { filters: { status: ['rejected'] } })).toEqual({
      status: 'saved',
      path: csvPath,
      rows: 1,
    });
    const csv = readFileSync(csvPath, 'utf8');
    expect(csv).toContain('Company,Role,Status,Fit');
    expect(csv).toContain('Nimbus Analytics GmbH,Data Engineer,rejected,88');

    // Today numbers match the database: one application, in every month bucket it entered
    const t = await ok<Today>('today:summary');
    const line = Object.fromEntries(t.statusLine.map((s) => [s.key, s]));
    expect(line.saved).toMatchObject({ count: 1, current: 0 });
    expect(line.ready).toMatchObject({ count: 1, current: 0 });
    expect(line.applied).toMatchObject({ count: 1, current: 0 });
    expect(line.in_process).toMatchObject({ count: 1, current: 0 });
    expect(line.rejected).toMatchObject({ count: 1, current: 1 });
    expect(line.offers).toMatchObject({ count: 0, current: 0 });
    expect(t.funnel.steps.map((s) => [s.key, s.count])).toEqual([
      ['discovered', 1],
      ['shortlisted', 1],
      ['applied', 1],
      ['response', 1],
      ['interview', 1],
      ['offer', 0],
    ]);
    expect(t.funnel.steps.map((s) => s.conversion)).toEqual([null, 1, 1, 1, 1, 0]);
    expect(t.weekly).toHaveLength(12);
    expect(t.weekly.reduce((n, w) => n + w.count, 0)).toBe(1);
    expect(t.weekly[11]?.count).toBe(1);
    expect(t.needsYou.followUps).toEqual([]);
    expect(t.needsYou.interviews).toEqual([]); // closed: nothing to prepare
  });
});

test.describe('follow-up digest notification', () => {
  let l: Launched;
  const { ok, seed } = helpers(() => l);
  test.afterAll(async () => {
    await l.close();
  });

  test('posts once when a follow-up is due (Notification stubbed), not again the same day', async () => {
    l = await launchApp(env({ STELLIO_DIGEST_INTERVAL_MS: '300' }));
    const notes = (): Promise<{ title: string; body: string }[]> =>
      l.app.evaluate(
        () =>
          (globalThis as unknown as { __notifications?: { title: string; body: string }[] })
            .__notifications ?? [],
      );
    // The digest goes out from its configured time on; midnight keeps this test independent of the clock.
    await ok('notifications:set', { digestEnabled: true, digestTime: '00:00', scanEnabled: true });
    const jobId = await seed();
    await ok('jobs:setState', { id: jobId, state: 'shortlisted' });
    const app = await ok<App>('apps:forJob', { jobId });
    await new Promise((r) => setTimeout(r, 800));
    expect(await notes()).toEqual([]); // nothing due yet
    await ok('apps:update', {
      id: app.id,
      patch: { nextAction: 'Email the recruiter', nextActionAt: new Date(Date.now() - DAY).toISOString() },
    });
    await expect.poll(async () => (await notes()).length, { timeout: 5000 }).toBe(1);
    expect((await notes())[0]).toEqual({
      title: '1 follow-up due',
      body: 'Nimbus Analytics GmbH — Data Engineer: Email the recruiter',
    });
    await new Promise((r) => setTimeout(r, 1200)); // several more hourly checks (300 ms here)
    expect(await notes()).toHaveLength(1);
  });
});
