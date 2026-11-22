import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const read = (rel: string): string => readFileSync(resolve('tests', rel), 'utf8');
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface Job {
  id: string;
  title: string;
  company: string;
  state: string;
  fitScore: number | null;
  descriptionMd: string;
  url: string | null;
}
interface Analysis {
  id: string;
  profileHash: string;
  promptVersion: string;
  profileStale: boolean;
  result: { fit_score: number; verdict: string; warnings: string[]; matched: { evidence_ids: string[] }[] };
}
type Intake = { status: 'ok'; jobId: string; duplicate: boolean } | { status: 'needs_text'; reason: string };

const fakeEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
  STELLIO_ALLOW_LOOPBACK_FETCH: '1', // tests only: the page server below is on 127.0.0.1
  FAKE_CLAUDE_MODE: 'ok',
  FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
  FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify({
    ...sampleAnalysis,
    matched: [{ requirement: 'Python', evidence_ids: ['exp-globex', 'exp-invented'], note: '' }],
  }),
  ...extra,
});

let server: http.Server;
let base: string;
test.beforeAll(async () => {
  const pages: Record<string, string> = {
    '/job': read('evals/jds/20-senior-data-engineer-remote-us.html'),
    '/login': read('fixtures/pages/login-wall.html'),
  };
  server = http.createServer((req, res) => {
    const body = pages[req.url ?? ''];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test.describe('jobs flow (fake CLI)', () => {
  let l: Launched;
  test.beforeAll(async () => {
    l = await launchApp(fakeEnv());
    // analysis needs a real profile: the seeded template has no skills or experience
    const markdown = read('fixtures/profiles/full.md');
    expect(await invoke(l.page, 'profile:save', { markdown, expectedHash: null })).toMatchObject({
      ok: true,
    });
  });
  test.afterAll(async () => {
    await l.close();
  });
  const call = <T>(channel: string, input?: unknown) => invoke(l.page, channel, input) as Promise<Res<T>>;
  const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
    const r = await call<T>(channel, input);
    if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
    return r.data;
  };
  let jobId = '';

  test('AI settings: defaults, change persists, bad values are refused', async () => {
    const s = await ok<{ concurrency: number; models: Record<string, { model: string; effort: string }> }>(
      'settings:getAi',
    );
    expect(s.models['jd.parse']).toEqual({ model: 'claude-haiku-5-5', effort: 'low' });
    expect(s.models['job.analyze']).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(s.concurrency).toBe(2);
    const changed = { ...s, concurrency: 3 };
    expect((await ok<{ concurrency: number }>('settings:setAi', changed)).concurrency).toBe(3);
    expect((await ok<{ concurrency: number }>('settings:getAi')).concurrency).toBe(3);
    expect(await call('settings:setAi', { ...s, concurrency: 50 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(
      await call('settings:setAi', {
        ...s,
        models: { ...s.models, 'jd.parse': { model: '--bad', effort: 'low' } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  test('inputs are validated at the boundary', async () => {
    const requestId = randomUUID();
    expect(
      await call('jobs:intakeUrl', { url: 'https://x.test/' + 'a'.repeat(2100), requestId }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await call('jobs:intakeText', { text: 'x'.repeat(200_001), requestId })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('jobs:intakeText', { text: POSTING, requestId: 'not-a-uuid' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('jobs:list', { limit: 0, offset: 0 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('jobs:setState', { id: 'x', state: 'bogus' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('ai:run', { id: '../../etc/passwd' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('tasks:cancel', { requestId: 'nope' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
  });

  test('paste text: parsed, stored, listed; pasting it again is a duplicate', async () => {
    const first = await ok<Intake>('jobs:intakeText', {
      text: POSTING,
      url: 'https://example.test/jobs/1',
      requestId: randomUUID(),
    });
    expect(first).toMatchObject({ status: 'ok', duplicate: false });
    if (first.status !== 'ok') return;
    jobId = first.jobId;
    const got = await ok<{ job: Job; analysis: Analysis | null }>('jobs:get', { id: jobId });
    expect(got.job).toMatchObject({
      title: 'Data Engineer',
      company: 'Nimbus Analytics GmbH',
      state: 'new',
      url: 'https://example.test/jobs/1',
    });
    expect(got.analysis).toBeNull();
    const list = await ok<{ items: Job[]; total: number }>('jobs:list', { limit: 10, offset: 0 });
    expect(list.total).toBe(1);
    expect(await ok('jobs:intakeText', { text: POSTING, requestId: randomUUID() })).toEqual({
      status: 'ok',
      jobId,
      duplicate: true,
    });
  });

  test('analyze: stored with profile hash and prompt version; invented evidence ids are dropped', async () => {
    const { analysis } = await ok<{ analysis: Analysis }>('jobs:analyze', {
      id: jobId,
      requestId: randomUUID(),
    });
    expect(analysis).toMatchObject({
      promptVersion: 'v1',
      profileStale: false,
      result: { fit_score: 88, verdict: 'apply' },
    });
    expect(analysis.result.matched[0]?.evidence_ids).toEqual(['exp-globex']);
    expect(analysis.result.warnings).toEqual(['"Python": dropped unknown evidence id "exp-invented"']);
    const got = await ok<{ job: Job; analysis: Analysis }>('jobs:get', { id: jobId });
    expect(got.analysis.id).toBe(analysis.id);
    expect(got.job.fitScore).toBe(88);

    // editing the profile makes the analysis stale
    const snap = await ok<{ markdown: string; hash: string }>('profile:get');
    await ok('profile:save', { markdown: `${snap.markdown}\nMore.\n`, expectedHash: snap.hash });
    expect((await ok<{ analysis: Analysis }>('jobs:get', { id: jobId })).analysis.profileStale).toBe(true);
  });

  test('Activity: runs list and per-run prompt/output detail', async () => {
    const runs = await ok<
      { id: string; task: string; status: string; relatedType: string | null; relatedId: string | null }[]
    >('ai:runs', { limit: 50 });
    expect(runs.map((r) => r.task)).toEqual(expect.arrayContaining(['jd.parse', 'job.analyze']));
    const analyze = runs.find((r) => r.task === 'job.analyze');
    expect(analyze).toMatchObject({ status: 'ok', relatedType: 'job', relatedId: jobId });
    const detail = await ok<{ run: { id: string }; log: { system: string; input: string } | null }>(
      'ai:run',
      { id: analyze?.id },
    );
    expect(detail.log?.system).toMatch(/SCORING RUBRIC/);
    expect(detail.log?.input).toContain('<profile>');
    expect(await call('ai:run', { id: '01HZZZZZZZZZZZZZZZZZZZZZZZ' })).toMatchObject({
      ok: false,
      error: { code: 'failed' },
    });
  });

  test('state change and delete', async () => {
    expect(await ok<Job>('jobs:setState', { id: jobId, state: 'shortlisted' })).toMatchObject({
      state: 'shortlisted',
    });
    expect(
      (await ok<{ total: number }>('jobs:list', { limit: 10, offset: 0, state: 'shortlisted' })).total,
    ).toBe(1);
    expect(await ok('jobs:delete', { id: jobId })).toEqual({ deleted: true });
    expect(await call('jobs:get', { id: jobId })).toMatchObject({ ok: false, error: { code: 'failed' } });
  });
});

test('URL intake: article extracted as Markdown; login wall asks for pasted text; unsafe links refused', async () => {
  const l = await launchApp(fakeEnv());
  const call = <T>(channel: string, input?: unknown) => invoke(l.page, channel, input) as Promise<Res<T>>;
  const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
    const r = await call<T>(channel, input);
    if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
    return r.data;
  };
  try {
    const res = await ok<Intake>('jobs:intakeUrl', { url: `${base}/job`, requestId: randomUUID() });
    expect(res).toMatchObject({ status: 'ok' });
    if (res.status !== 'ok') return;
    const { job } = await ok<{ job: Job }>('jobs:get', { id: res.jobId });
    expect(job.descriptionMd).toContain('Kafka, Spark and Snowflake');
    expect(job.descriptionMd).not.toMatch(/<\/?(script|div|p)\b|Accept all/);
    expect(job.url).toBe(`${base}/job`);

    const wall = await ok<Intake>('jobs:intakeUrl', { url: `${base}/login`, requestId: randomUUID() });
    expect(wall).toMatchObject({ status: 'needs_text' });
    expect(wall.status === 'needs_text' && wall.reason).toMatch(/sign-in/);

    for (const [url, msg] of [
      ['file:///etc/passwd', /http and https/],
      ['ftp://example.com/job', /http and https/],
      ['http://169.254.169.254/latest/meta-data', /public internet/],
      ['http://10.0.0.1/', /public internet/],
      [`${base}/missing`, /not found/],
    ] as const) {
      const r = await call('jobs:intakeUrl', { url, requestId: randomUUID() });
      expect(r, url).toMatchObject({ ok: false, error: { code: 'failed' } });
      expect(!r.ok && r.error.message, url).toMatch(msg);
    }
  } finally {
    await l.close();
  }
});

test('cancel: tasks:cancel aborts a run mid-flight and nothing is stored', async () => {
  const l = await launchApp(fakeEnv({ FAKE_CLAUDE_MODE_JD_PARSE: 'hang' }));
  try {
    const requestId = randomUUID();
    await l.page.evaluate(
      ([text, id]) => {
        const w = window as unknown as {
          __p: Promise<unknown>;
          stellio: { invoke: (c: string, i: unknown) => Promise<unknown> };
        };
        w.__p = w.stellio.invoke('jobs:intakeText', { text, requestId: id });
      },
      [POSTING, requestId] as const,
    );
    await new Promise((r) => setTimeout(r, 1500)); // let the (hanging) CLI start
    expect(await invoke(l.page, 'tasks:cancel', { requestId })).toEqual({
      ok: true,
      data: { cancelled: true },
    });
    const result = await l.page.evaluate(() => (window as unknown as { __p: Promise<unknown> }).__p);
    expect(result).toMatchObject({ ok: false, error: { code: 'failed', message: 'Cancelled.' } });
    expect(await invoke(l.page, 'jobs:list', { limit: 10, offset: 0 })).toMatchObject({
      ok: true,
      data: { total: 0 },
    });
    const runs = (await invoke(l.page, 'ai:runs', { limit: 5 })) as Res<{ status: string }[]>;
    expect(runs.ok && runs.data[0]?.status).toBe('cancelled');
    // cancelling again, or an unknown id, is harmless
    expect(await invoke(l.page, 'tasks:cancel', { requestId })).toEqual({
      ok: true,
      data: { cancelled: false },
    });
  } finally {
    await l.close();
  }
});

test('usage limit: readable failure and an ai:usageLimit event', async () => {
  const l = await launchApp(fakeEnv({ FAKE_CLAUDE_MODE_JD_PARSE: 'usage_limit' }));
  try {
    await l.page.evaluate(() => {
      const w = window as unknown as { __limit: { message: string }[] };
      w.__limit = [];
      window.stellio.on('ai:usageLimit', (p) => w.__limit.push(p));
    });
    const res = await invoke(l.page, 'jobs:intakeText', { text: POSTING, requestId: randomUUID() });
    expect(res).toMatchObject({ ok: false, error: { code: 'failed' } });
    expect(!(res as Res<unknown>).ok && (res as { error: { message: string } }).error.message).toMatch(
      /usage limit/i,
    );
    await expect
      .poll(() =>
        l.page.evaluate(() => (window as unknown as { __limit: { message: string }[] }).__limit.length),
      )
      .toBe(1);
    const events = await l.page.evaluate(
      () => (window as unknown as { __limit: { message: string }[] }).__limit,
    );
    expect(events[0]?.message).toMatch(/usage limit/i);
    expect(await invoke(l.page, 'jobs:list', { limit: 10, offset: 0 })).toMatchObject({
      ok: true,
      data: { total: 0 },
    });
  } finally {
    await l.close();
  }
});
