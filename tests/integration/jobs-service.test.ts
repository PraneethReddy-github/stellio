import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeRunner } from '../../src/main/ai/runner';
import { getAiRun } from '../../src/main/db/repos/aiRuns';
import { createDbRecorder } from '../../src/main/services/ai/recorder';
import { createRunsService, readRunLog } from '../../src/main/services/ai/runs';
import { createJobsService } from '../../src/main/services/jobs/service';
import { FetchError, type Fetcher } from '../../src/main/services/jobs/net';
import { createProfileService } from '../../src/main/services/profile/service';
import { createAiSettings } from '../../src/main/services/settings/ai';
import { createTaskRegistry } from '../../src/main/services/tasks/registry';
import { DEFAULT_AI_SETTINGS } from '../../src/shared/settings/ai';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { freshDb, tempDir } from '../unit/db/helpers';

const FAKE = resolve('tests/fixtures/fake-claude/claude.mjs');
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const read = (rel: string): string => readFileSync(resolve('tests', rel), 'utf8');

interface Opts {
  env?: Record<string, string>;
  fetcher?: Fetcher;
  profile?: string | null;
}

function setup({ env = {}, fetcher, profile = read('fixtures/profiles/full.md') }: Opts = {}) {
  const db = freshDb();
  const dir = tempDir();
  mkdirSync(join(dir, 'profile'), { recursive: true });
  if (profile !== null) writeFileSync(join(dir, 'profile/praneethreddy.md'), profile);
  const cap = join(dir, 'capture.ndjson');
  const logDir = join(dir, 'logs');
  const onUsageLimit = vi.fn();
  const settings = createAiSettings(db);
  const runner = createClaudeRunner({
    bin: FAKE,
    cwd: join(dir, 'cwd'),
    logger,
    recorder: createDbRecorder(db, onUsageLimit),
    logDir,
    retryDelayMs: 1,
    env: {
      FAKE_CLAUDE_MODE: 'ok',
      FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
      FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
      FAKE_CLAUDE_CAPTURE: cap,
      ...env,
    },
  });
  const profileSvc = createProfileService({
    dataDir: dir,
    gitAvailable: false,
    runner,
    importConfig: () => settings.forTask('profile.import'),
  });
  const jobs = createJobsService({ db, runner, settings, profile: profileSvc, fetcher });
  const calls = (): { argv: string[]; stdin: string }[] =>
    readdirSync(dir).includes('capture.ndjson')
      ? readFileSync(cap, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { kind: string; argv: string[]; stdin: string })
          .filter((r) => r.kind === 'call')
      : [];
  return { db, dir, logDir, jobs, profile: profileSvc, settings, calls, onUsageLimit };
}

const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

describe('intake text → parse → store', () => {
  it('stores the posting with normalized fields and links the AI run', async () => {
    const { jobs, db } = setup();
    const res = await jobs.intakeText(POSTING, { url: 'https://example.test/jobs/1' });
    expect(res).toMatchObject({ status: 'ok', duplicate: false });
    if (res.status !== 'ok') return;
    const { job, analysis } = await jobs.get(res.jobId);
    expect(analysis).toBeNull();
    expect(job).toMatchObject({
      title: 'Data Engineer',
      company: 'Nimbus Analytics GmbH',
      locationText: 'Berlin, Germany',
      country: 'Germany',
      remote: 'hybrid',
      employmentType: 'full_time',
      seniority: 'mid',
      salaryMin: 65000,
      salaryMax: 80000,
      salaryCurrency: 'EUR',
      salaryPeriod: 'year',
      language: 'en',
      deadlineAt: '2026-12-31',
      url: 'https://example.test/jobs/1',
      applyUrl: 'https://example.test/jobs/1',
      state: 'new',
      descriptionMd: POSTING.trim(),
    });
    expect(job.structured?.requirements[0]?.skills).toEqual(['Python', 'SQL']);
    expect(job.sources).toMatchObject([{ source: 'manual', url: 'https://example.test/jobs/1' }]);
    const run = db.sqlite.prepare('select task, status, related_type, related_id from ai_runs').all();
    expect(run).toEqual([{ task: 'jd.parse', status: 'ok', related_type: 'job', related_id: res.jobId }]);
  });

  it('uses the model and effort from settings', async () => {
    const { jobs, settings, calls } = setup();
    settings.set({
      ...DEFAULT_AI_SETTINGS,
      models: { ...DEFAULT_AI_SETTINGS.models, 'jd.parse': { model: 'sonnet', effort: 'high' } },
    });
    await jobs.intakeText(POSTING);
    const argv = calls()[0]?.argv ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high');
  });

  it('rejects text that is too short without calling Claude', async () => {
    const { jobs, calls } = setup();
    await expect(jobs.intakeText('too short')).rejects.toThrow(/too short/);
    expect(calls()).toHaveLength(0);
  });

  it('returns the existing job for the same text, before any AI call', async () => {
    const { jobs, calls } = setup();
    const a = await jobs.intakeText(POSTING);
    const b = await jobs.intakeText(`  ${POSTING.replace(/ /g, '  ')}\r\n`); // same words, other whitespace
    expect(b).toMatchObject({ status: 'ok', duplicate: true });
    expect(a.status === 'ok' && b.status === 'ok' && a.jobId === b.jobId).toBe(true);
    expect(calls()).toHaveLength(1);
  });

  it('returns the existing job for the same company+title+city in different words', async () => {
    const { jobs, db } = setup();
    const a = await jobs.intakeText(POSTING);
    const b = await jobs.intakeText(`${POSTING} Reposted on another board with a different footer.`);
    expect(b).toMatchObject({ status: 'ok', duplicate: true });
    expect(a.status === 'ok' && b.status === 'ok' && a.jobId === b.jobId).toBe(true);
    expect(jobs.list({ limit: 10, offset: 0 }).total).toBe(1);
    // the second parse run is attached to the existing job
    expect(db.sqlite.prepare('select count(*) n from ai_runs where related_id is not null').get()).toEqual({
      n: 2,
    });
  });

  it('survives two concurrent intakes of the same posting', async () => {
    const { jobs } = setup();
    const [a, b] = await Promise.all([jobs.intakeText(POSTING), jobs.intakeText(`${POSTING} Extra.`)]);
    expect(a.status === 'ok' && b.status === 'ok' && a.jobId === b.jobId).toBe(true);
    expect(jobs.list({ limit: 10, offset: 0 }).total).toBe(1);
  });

  it('falls back to placeholders when the posting names neither company nor title', async () => {
    const { jobs } = setup({
      env: { FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify({ ...sampleJd, title: null, company: null }) },
    });
    const res = await jobs.intakeText(POSTING);
    if (res.status !== 'ok') throw new Error('expected ok');
    expect((await jobs.get(res.jobId)).job).toMatchObject({
      company: 'Unknown company',
      title: 'Untitled role',
    });
  });

  it('placeholder company/title never make two different postings duplicates', async () => {
    for (const jd of [
      { title: null, company: null },
      { title: 'Data Engineer', company: null },
      { title: null, company: 'Nimbus Analytics' },
    ]) {
      const { jobs } = setup({
        env: { FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify({ ...sampleJd, ...jd }) },
      });
      const a = await jobs.intakeText(POSTING);
      const b = await jobs.intakeText(
        `Recruiter post, a different client. ${'Kafka and Scala streaming. '.repeat(4)}`,
      );
      expect(b).toMatchObject({ status: 'ok', duplicate: false });
      expect(a.status === 'ok' && b.status === 'ok' && a.jobId !== b.jobId).toBe(true);
      expect(jobs.list({ limit: 10, offset: 0 }).total).toBe(2);
      // the same text is still a duplicate
      expect(await jobs.intakeText(POSTING)).toMatchObject({ status: 'ok', duplicate: true });
    }
  });

  it('a failed parse stores nothing and a retry works', async () => {
    const bad = setup({ env: { FAKE_CLAUDE_MODE_JD_PARSE: 'invalid_always' } });
    await expect(bad.jobs.intakeText(POSTING)).rejects.toThrow(/wrong shape/);
    expect(bad.jobs.list({ limit: 10, offset: 0 }).total).toBe(0);
    expect(bad.db.sqlite.prepare('select status from ai_runs').all()).toEqual([{ status: 'invalid_output' }]);
  });
});

describe('usage limit and auth failures', () => {
  it('usage limit: readable error, recorder hook fires with the CLI message', async () => {
    const { jobs, onUsageLimit, db } = setup({ env: { FAKE_CLAUDE_MODE_JD_PARSE: 'usage_limit' } });
    await expect(jobs.intakeText(POSTING)).rejects.toThrow(/usage limit/i);
    expect(onUsageLimit).toHaveBeenCalledTimes(1);
    expect(onUsageLimit).toHaveBeenCalledWith({ message: expect.stringContaining('usage limit') as string });
    expect(db.sqlite.prepare('select status from ai_runs').all()).toEqual([{ status: 'usage_limit' }]);
  });
  it('auth failure does not fire the usage-limit hook', async () => {
    const { jobs, onUsageLimit } = setup({ env: { FAKE_CLAUDE_MODE_JD_PARSE: 'auth' } });
    await expect(jobs.intakeText(POSTING)).rejects.toThrow(/not logged in/i);
    expect(onUsageLimit).not.toHaveBeenCalled();
  });
});

describe('cancellation', () => {
  it('cancelling by request id aborts the run mid-flight; nothing is stored', async () => {
    const { jobs, db } = setup({ env: { FAKE_CLAUDE_MODE_JD_PARSE: 'hang' } });
    const tasks = createTaskRegistry();
    const p = tasks.run('req-1', (signal) => jobs.intakeText(POSTING, {}, signal));
    const settled = p.catch((e: unknown) => e);
    await vi.waitFor(() =>
      expect(db.sqlite.prepare('select count(*) n from ai_runs').get()).toEqual({ n: 1 }),
    );
    await new Promise((r) => setTimeout(r, 300)); // let the fake CLI start
    expect(tasks.cancel('req-1')).toBe(true);
    expect(String(await settled)).toMatch(/Cancelled/);
    expect(tasks.size).toBe(0);
    expect(jobs.list({ limit: 10, offset: 0 }).total).toBe(0);
    expect(db.sqlite.prepare('select status from ai_runs').all()).toEqual([{ status: 'cancelled' }]);
  }, 20_000);

  it('registry: unknown id is a no-op, a running id cannot be reused', async () => {
    const tasks = createTaskRegistry();
    expect(tasks.cancel('nope')).toBe(false);
    let release: () => void = () => undefined;
    const first = tasks.run('a', () => new Promise<void>((r) => (release = r)));
    await expect(tasks.run('a', () => Promise.resolve())).rejects.toThrow(/already running/);
    release();
    await first;
    await expect(tasks.run('a', () => Promise.resolve(1))).resolves.toBe(1); // free again afterwards
  });
});

describe('intake URL', () => {
  const html =
    (rel: string): Fetcher =>
    (url) =>
      Promise.resolve({ status: 200, finalUrl: url, contentType: 'text/html', body: read(rel) });

  it('generic page: Readability → Markdown → job; no HTML reaches the stored text', async () => {
    const { jobs, calls } = setup({ fetcher: html('evals/jds/20-senior-data-engineer-remote-us.html') });
    const res = await jobs.intakeUrl('https://careers.example.test/jobs/42');
    expect(res).toMatchObject({ status: 'ok', duplicate: false });
    if (res.status !== 'ok') return;
    const { job } = await jobs.get(res.jobId);
    expect(job.url).toBe('https://careers.example.test/jobs/42');
    expect(job.descriptionMd).toContain('# Senior Data Engineer');
    expect(job.descriptionMd).not.toMatch(/<\/?(div|p|ul|li|script)\b/i);
    expect(job.descriptionMd).not.toContain('Accept all');
    expect(calls()[0]?.stdin).toContain('$140,000 - $165,000 USD');
  });

  it('same page twice: duplicate without a second AI call', async () => {
    const { jobs, calls } = setup({ fetcher: html('evals/jds/20-senior-data-engineer-remote-us.html') });
    await jobs.intakeUrl('https://careers.example.test/jobs/42');
    const again = await jobs.intakeUrl('https://careers.example.test/jobs/42');
    expect(again).toMatchObject({ status: 'ok', duplicate: true });
    expect(calls()).toHaveLength(1);
  });

  it.each([
    ['login wall', 'fixtures/pages/login-wall.html', /sign-in/],
    ['JS-only shell', 'fixtures/pages/js-shell.html', /characters of text|JavaScript/],
  ])('%s → needs_text, nothing stored, no AI call', async (_n, file, reason) => {
    const { jobs, calls } = setup({ fetcher: html(file) });
    const res = await jobs.intakeUrl('https://example.test/x');
    expect(res.status).toBe('needs_text');
    expect(res.status === 'needs_text' && res.reason).toMatch(reason);
    expect(calls()).toHaveLength(0);
    expect(jobs.list({ limit: 10, offset: 0 }).total).toBe(0);
  });

  it('blocked by the site (403) → needs_text; 404 → error', async () => {
    const status =
      (s: number): Fetcher =>
      (url) =>
        Promise.resolve({ status: s, finalUrl: url, contentType: 'text/html', body: '' });
    expect((await setup({ fetcher: status(403) }).jobs.intakeUrl('https://example.test/x')).status).toBe(
      'needs_text',
    );
    await expect(setup({ fetcher: status(404) }).jobs.intakeUrl('https://example.test/x')).rejects.toThrow(
      /not found/,
    );
    await expect(setup({ fetcher: status(500) }).jobs.intakeUrl('https://example.test/x')).rejects.toThrow(
      /HTTP 500/,
    );
  });

  it('fetch errors become readable messages', async () => {
    const boom: Fetcher = () =>
      Promise.reject(new FetchError('Only http and https links can be fetched.', 'scheme'));
    await expect(setup({ fetcher: boom }).jobs.intakeUrl('file:///etc/passwd')).rejects.toThrow(
      /Only http and https/,
    );
  });

  it('known ATS link: uses the vendor JSON, trusts its company, title, apply URL and date', async () => {
    const seen: { url: string; hosts?: readonly string[] }[] = [];
    const fetcher: Fetcher = (url, opts) => {
      seen.push({ url, hosts: opts?.allowedHosts });
      return Promise.resolve({
        status: 200,
        finalUrl: url,
        contentType: 'application/json',
        body: read('fixtures/ats/greenhouse.json'),
      });
    };
    const { jobs, calls } = setup({
      fetcher,
      // the parse says another company: the ATS value wins
      env: {
        FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify({
          ...sampleJd,
          company: 'Someone Else',
          title: 'Whatever',
        }),
      },
    });
    const res = await jobs.intakeUrl('https://boards.greenhouse.io/larkspur/jobs/4400012');
    if (res.status !== 'ok') throw new Error('expected ok');
    expect(seen).toEqual([
      {
        url: 'https://boards-api.greenhouse.io/v1/boards/larkspur/jobs/4400012?pay_transparency=true',
        hosts: ['boards-api.greenhouse.io'],
      },
    ]);
    const { job } = await jobs.get(res.jobId);
    expect(job).toMatchObject({
      company: 'Larkspur Freight',
      title: 'Data Platform Engineer',
      url: 'https://boards.greenhouse.io/larkspur/jobs/4400012',
      postedAt: '2026-10-20T09:00:00.000Z',
    });
    expect(job.sources).toMatchObject([{ source: 'greenhouse' }]);
    const stdin = calls()[0]?.stdin ?? '';
    expect(stdin).toContain('Company: Larkspur Freight');
    expect(stdin).toContain('Salary: 65000-80000 EUR');
    expect(stdin).toContain('Build batch and streaming pipelines'); // entity-escaped HTML was decoded
  });

  it('stores only http(s) links: a pasted or ATS-supplied javascript:/file: URL is dropped', async () => {
    const { jobs } = setup();
    const pasted = await jobs.intakeText(POSTING, { url: 'javascript:alert(1)' });
    if (pasted.status !== 'ok') throw new Error('expected ok');
    expect((await jobs.get(pasted.jobId)).job).toMatchObject({ url: null, applyUrl: null });
    expect((await jobs.get(pasted.jobId)).job.sources).toMatchObject([{ url: null }]);

    const lever = JSON.parse(read('fixtures/ats/lever.json')) as Record<string, unknown>;
    const fetcher: Fetcher = (url) =>
      Promise.resolve({
        status: 200,
        finalUrl: url,
        contentType: 'application/json',
        body: JSON.stringify({ ...lever, hostedUrl: 'file:///etc/passwd', applyUrl: 'javascript:alert(1)' }),
      });
    const posting = 'https://jobs.lever.co/marigold/5f3e0f6a-1b2c-4d3e-8f90-123456789abc';
    const ats = setup({ fetcher });
    const res = await ats.jobs.intakeUrl(posting);
    if (res.status !== 'ok') throw new Error('expected ok');
    expect((await ats.jobs.get(res.jobId)).job).toMatchObject({ url: posting, applyUrl: posting });
  });

  it('ATS: unknown posting → error; garbage JSON → needs_text', async () => {
    const reply =
      (status: number, body: string): Fetcher =>
      (url) =>
        Promise.resolve({ status, finalUrl: url, contentType: 'application/json', body });
    const url = 'https://boards.greenhouse.io/larkspur/jobs/1';
    await expect(setup({ fetcher: reply(404, '{}') }).jobs.intakeUrl(url)).rejects.toThrow(/not found/);
    expect((await setup({ fetcher: reply(200, '{"unexpected":1}') }).jobs.intakeUrl(url)).status).toBe(
      'needs_text',
    );
    expect((await setup({ fetcher: reply(200, 'not json') }).jobs.intakeUrl(url)).status).toBe('needs_text');
  });
});

describe('analyze', () => {
  it('stores the analysis with profile hash, model and prompt version; drops invented evidence ids', async () => {
    const analysis = {
      ...sampleAnalysis,
      matched: [
        { requirement: 'Python', evidence_ids: ['exp-globex', 'exp-invented'], note: '' },
        { requirement: 'Kafka', evidence_ids: ['proj-nowhere'], note: '' },
      ],
    };
    const s = setup({ env: { FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(analysis) } });
    const intake = await s.jobs.intakeText(POSTING);
    if (intake.status !== 'ok') throw new Error('expected ok');
    const record = await s.jobs.analyze(intake.jobId);
    const snap = await s.profile.get();
    expect(record).toMatchObject({
      jobId: intake.jobId,
      profileHash: snap.hash,
      promptVersion: 'v1',
      profileStale: false,
    });
    expect(record.result.matched.map((m) => m.evidence_ids)).toEqual([['exp-globex']]);
    expect(record.result.unverified.map((m) => m.requirement)).toEqual(['Kafka']);
    expect(record.result.score_flag).toBe('unverified_evidence');
    expect(record.result.warnings).toEqual([
      '"Python": dropped unknown evidence id "exp-invented"',
      '"Kafka": dropped unknown evidence id "proj-nowhere"',
      '"Kafka": no valid evidence in the profile, moved to unverified',
      'score 88 counts 1 of 2 matched requirements that have no valid evidence',
      'verdict capped at "stretch" because a third or more of the matched requirements are unverified',
    ]);

    const argv = s.calls().at(-1)?.argv ?? [];
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
    const detail = await s.jobs.get(intake.jobId);
    // The displayed verdict is the capped one, everywhere.
    expect(detail.analysis).toMatchObject({ id: record.id, result: { fit_score: 88, verdict: 'stretch' } });
    expect(detail.job).toMatchObject({ fitScore: 88, verdict: 'stretch' });
    expect(s.jobs.list({ limit: 5, offset: 0 }).items[0]).toMatchObject({ fitScore: 88, verdict: 'stretch' });
    const run = s.db.sqlite.prepare("select related_id from ai_runs where task = 'job.analyze'").get();
    expect(run).toEqual({ related_id: intake.jobId });
  });

  it('marks the analysis stale after a profile edit; a re-run replaces it as the latest', async () => {
    const s = setup();
    const intake = await s.jobs.intakeText(POSTING);
    if (intake.status !== 'ok') throw new Error('expected ok');
    await s.jobs.analyze(intake.jobId);
    const snap = await s.profile.get();
    await s.profile.save(`${snap.markdown}\nExtra note.\n`, snap.hash, 'edit');
    expect((await s.jobs.get(intake.jobId)).analysis?.profileStale).toBe(true);
    const second = await s.jobs.analyze(intake.jobId);
    expect(second.profileStale).toBe(false);
    expect((await s.jobs.get(intake.jobId)).analysis?.id).toBe(second.id);
  });

  it('refuses an empty profile and unknown jobs; surfaces AI failures', async () => {
    const empty = setup({ profile: '---\nname: X\n---\n' });
    const intake = await empty.jobs.intakeText(POSTING);
    if (intake.status !== 'ok') throw new Error('expected ok');
    await expect(empty.jobs.analyze(intake.jobId)).rejects.toThrow(/no skills or experience/);
    await expect(empty.jobs.analyze('missing')).rejects.toThrow(/no longer exists/);

    const failing = setup({ env: { FAKE_CLAUDE_MODE_JOB_ANALYZE: 'usage_limit' } });
    const i2 = await failing.jobs.intakeText(POSTING);
    if (i2.status !== 'ok') throw new Error('expected ok');
    await expect(failing.jobs.analyze(i2.jobId)).rejects.toThrow(/usage limit/i);
    expect(failing.onUsageLimit).toHaveBeenCalledTimes(1);
    expect((await failing.jobs.get(i2.jobId)).analysis).toBeNull();
  });

  it('can be cancelled', async () => {
    const s = setup({ env: { FAKE_CLAUDE_MODE_JOB_ANALYZE: 'hang' } });
    const intake = await s.jobs.intakeText(POSTING);
    if (intake.status !== 'ok') throw new Error('expected ok');
    const ctl = new AbortController();
    const p = s.jobs.analyze(intake.jobId, ctl.signal).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 400));
    ctl.abort();
    expect(String(await p)).toMatch(/Cancelled/);
    expect((await s.jobs.get(intake.jobId)).analysis).toBeNull();
  }, 20_000);
});

describe('state and delete', () => {
  it('sets state, deletes with cascade', async () => {
    const s = setup();
    const intake = await s.jobs.intakeText(POSTING);
    if (intake.status !== 'ok') throw new Error('expected ok');
    await s.jobs.analyze(intake.jobId);
    expect(s.jobs.setState(intake.jobId, 'shortlisted')).toMatchObject({ state: 'shortlisted' });
    expect(s.jobs.list({ limit: 5, offset: 0, state: 'new' }).total).toBe(0);
    expect(s.jobs.delete(intake.jobId)).toBe(true);
    expect(s.jobs.delete(intake.jobId)).toBe(false);
    expect(() => s.jobs.setState(intake.jobId, 'new')).toThrow(/no longer exists/);
    await expect(s.jobs.get(intake.jobId)).rejects.toThrow(/no longer exists/);
    expect(s.db.sqlite.prepare('select count(*) n from analyses').get()).toEqual({ n: 0 });
  });
});

describe('activity (ai runs)', () => {
  it('lists runs and reads the saved prompt/output by id only', async () => {
    const s = setup();
    const intake = await s.jobs.intakeText(POSTING);
    if (intake.status !== 'ok') throw new Error('expected ok');
    const runs = createRunsService(s.db, s.logDir);
    const [row] = runs.list(10);
    expect(row).toMatchObject({
      task: 'jd.parse',
      status: 'ok',
      promptVersion: 'v1',
      relatedType: 'job',
      relatedId: intake.jobId,
    });
    const detail = await runs.get(row?.id ?? '');
    expect(detail.run.id).toBe(row?.id);
    expect(detail.log?.system).toMatch(/untrusted data/);
    expect(detail.log?.input).toContain('<job_description>');
    expect(detail.log?.attempts[0]?.stdout).toContain('Nimbus Analytics');
    expect(getAiRun(s.db, row?.id ?? '')).toBeDefined();
  });

  it('never reads outside the log dir and tolerates pruned logs', async () => {
    const s = setup();
    copyFileSync(resolve('package.json'), join(s.dir, 'secret.json'));
    expect(await readRunLog(s.logDir, '../secret')).toBeNull();
    expect(await readRunLog(s.logDir, '..%2Fsecret')).toBeNull();
    expect(await readRunLog(s.logDir, '01HZZZZZZZZZZZZZZZZZZZZZZZ')).toBeNull(); // valid shape, no file
    await expect(createRunsService(s.db, s.logDir).get('01HZZZZZZZZZZZZZZZZZZZZZZZ')).rejects.toThrow(
      /no longer exists/,
    );
  });
});
