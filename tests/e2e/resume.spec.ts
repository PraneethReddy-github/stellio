import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { goodContent } from '../fixtures/resume';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface View {
  tex: string;
  content: unknown;
  pdfBase64?: string;
  checks: { truth: { ok: boolean } | null; compile: { ok: boolean; pages: number | null } | null };
  meta: { version: number; parentVersion: number | null; userEdited: boolean; isFinal: boolean };
}
interface Summary {
  meta: { version: number; isFinal: boolean };
  truthOk: boolean | null;
}

test.describe('resume pipeline over IPC (fake CLI)', () => {
  let l: Launched;
  let jobId = '';
  const call = <T>(channel: string, input?: unknown) => invoke(l.page, channel, input) as Promise<Res<T>>;
  const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
    const r = await call<T>(channel, input);
    if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
    return r.data;
  };

  test.beforeAll(async () => {
    l = await launchApp({
      STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
      ...(existsSync(TECTONIC) ? { STELLIO_TECTONIC_BIN: TECTONIC } : {}),
      FAKE_CLAUDE_MODE: 'ok',
      FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
      FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
      FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(goodContent),
      FAKE_CLAUDE_OUTPUT_RESUME_REVISE: JSON.stringify({
        ...goodContent,
        projects: [],
        change_log: ['Dropped Ledger'],
      }),
    });
    const markdown = readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8');
    await ok('profile:save', { markdown, expectedHash: null });
    const intake = await ok<{ status: string; jobId: string }>('jobs:intakeText', {
      text: POSTING,
      requestId: randomUUID(),
    });
    jobId = intake.jobId;
    await ok('jobs:analyze', { id: jobId, requestId: randomUUID() });
  });
  test.afterAll(async () => {
    await l.close();
  });

  test('generate → revise → manual edit → final → diff', async () => {
    expect(await ok('resume:list', { jobId })).toEqual([]);
    await l.page.evaluate(() => {
      const w = window as unknown as {
        __stages: string[];
        stellio: { on: (e: string, f: (p: { stage: string }) => void) => void };
      };
      w.__stages = [];
      w.stellio.on('resume:progress', (p) => w.__stages.push(p.stage));
    });
    const v1 = await ok<View>('resume:generate', { jobId, requestId: randomUUID() });
    expect(v1.meta).toMatchObject({ version: 1, parentVersion: null, userEdited: false });
    expect(v1.checks.truth?.ok).toBe(true);
    expect(v1.tex).toContain('\\resumeEntry{Data Engineer}{Mar 2022 -- Present}{Globex}{Berlin, Germany}');
    if (existsSync(TECTONIC)) {
      expect(v1.checks.compile).toMatchObject({ ok: true, pages: 1 });
      expect(v1.pdfBase64).toBeDefined();
    }
    expect(await l.page.evaluate(() => (window as unknown as { __stages: string[] }).__stages)).toEqual(
      expect.arrayContaining(['drafting', 'checking', 'compiling']),
    );

    const v2 = await ok<View>('resume:revise', {
      jobId,
      fromVersion: 1,
      instruction: 'drop the project',
      requestId: randomUUID(),
    });
    expect(v2.meta).toMatchObject({ version: 2, parentVersion: 1 });
    expect(v2.tex).not.toContain('\\section{Projects}');

    const v3 = await ok<View>('resume:saveManual', {
      jobId,
      fromVersion: 2,
      tex: v2.tex.replace('Owned the', 'Ran the'),
    });
    expect(v3.meta).toMatchObject({ version: 3, parentVersion: 2, userEdited: true });
    expect(v3.checks.truth).toBeNull();
    expect(v3.content).toBeNull();

    const list = await ok<Summary[]>('resume:markFinal', { jobId, version: 3 });
    expect(list.map((s) => [s.meta.version, s.meta.isFinal, s.truthOk])).toEqual([
      [1, false, true],
      [2, false, true],
      [3, true, null],
    ]);
    const diff = await ok<{ a: string; b: string }>('resume:diff', { jobId, a: 2, b: 3 });
    expect(diff.a).toContain('Owned the');
    expect(diff.b).toContain('Ran the');
    expect((await ok<View>('resume:get', { jobId, version: 1 })).tex).toBe(v1.tex);
  });

  test('inputs are validated', async () => {
    expect(await call('resume:get', { jobId, version: 0 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(
      await call('resume:revise', { jobId, fromVersion: 1, instruction: '  ', requestId: randomUUID() }),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('resume:export', { jobId, version: 1, format: 'docx' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('resume:get', { jobId, version: 42 })).toMatchObject({
      ok: false,
      error: { code: 'failed' },
    });
  });

  test('export through the save dialog (stubbed)', async () => {
    const target = join(l.sandbox, 'out.tex');
    await l.app.evaluate(({ dialog }, file) => {
      const g = globalThis as unknown as { __saveName?: string };
      dialog.showSaveDialog = (...a: unknown[]) => {
        const opts = a.at(-1) as { defaultPath?: string };
        g.__saveName = opts.defaultPath;
        return Promise.resolve({ canceled: false, filePath: file });
      };
    }, target);
    expect(await ok('resume:export', { jobId, version: 1, format: 'tex' })).toEqual({
      status: 'saved',
      path: target,
    });
    expect(readFileSync(target, 'utf8')).toContain('{Globex}');
    const name = await l.app.evaluate(() => (globalThis as unknown as { __saveName?: string }).__saveName);
    expect(name).toMatch(/Alex_Example_Resume_Nimbus_Analytics_GmbH\.tex$/);
    if (existsSync(TECTONIC)) {
      const pdf = join(l.sandbox, 'out.pdf');
      await l.app.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
      }, pdf);
      await ok('resume:export', { jobId, version: 1, format: 'pdf' });
      expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    }
    await l.app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: true, filePath: '' });
    });
    expect(await ok('resume:export', { jobId, version: 1, format: 'tex' })).toEqual({ status: 'cancelled' });
  });

  test('Open in Overleaf hands the OS browser a private auto-submit form', async () => {
    const v1 = await ok<View>('resume:get', { jobId, version: 1 });
    const { url } = await ok<{ url: string }>('resume:openOverleaf', { jobId, version: 1 });
    const opened = await l.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
    expect(opened).toEqual([url]);
    expect(url).toMatch(/^file:\/\/.*stellio-overleaf-.*\.html$/);
    const html = readFileSync(fileURLToPath(url), 'utf8');
    expect(html).toContain('action="https://www.overleaf.com/docs"');
    expect(html).toContain(`value="${encodeURIComponent(v1.tex)}"`);
    expect(html).toContain('name="engine" value="pdflatex"');
  });
});
