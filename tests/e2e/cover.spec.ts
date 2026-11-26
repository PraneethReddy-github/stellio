import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { badCover, coverPosting, goodCover } from '../fixtures/cover';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');

type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface View {
  tex: string;
  content: unknown;
  pdfBase64?: string;
  checks: {
    truth: { ok: boolean; violations: { kind: string }[] } | null;
    lint: { ok: boolean };
    compile: { ok: boolean; pages: number | null } | null;
  };
  meta: { version: number; parentVersion: number | null; userEdited: boolean; isFinal: boolean };
}
interface Summary {
  meta: { version: number; isFinal: boolean };
  truthOk: boolean | null;
  words: number;
}

test.describe('cover letter pipeline over IPC (fake CLI)', () => {
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
      // The first draft invents a number and a company; the repair round fixes both.
      FAKE_CLAUDE_OUTPUT_COVER_GENERATE: JSON.stringify(badCover),
      FAKE_CLAUDE_OUTPUT_COVER_GENERATE_REPAIR: JSON.stringify(goodCover),
      FAKE_CLAUDE_OUTPUT_COVER_REVISE: JSON.stringify({ ...goodCover, closing: 'Best regards,' }),
    });
    const markdown = readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8');
    await ok('profile:save', { markdown, expectedHash: null });
    const intake = await ok<{ status: string; jobId: string }>('jobs:intakeText', {
      text: coverPosting,
      requestId: randomUUID(),
    });
    jobId = intake.jobId;
    await ok('jobs:analyze', { id: jobId, requestId: randomUUID() });
  });
  test.afterAll(async () => {
    await l.close();
  });

  test('generate (with a repair round) → revise → manual edit → final → diff', async () => {
    expect(await ok('cover:list', { jobId })).toEqual([]);
    await l.page.evaluate(() => {
      const w = window as unknown as {
        __stages: { stage: string; issues?: number }[];
        stellio: { on: (e: string, f: (p: { stage: string; issues?: number }) => void) => void };
      };
      w.__stages = [];
      w.stellio.on('cover:progress', (p) => w.__stages.push({ stage: p.stage, issues: p.issues }));
    });
    const v1 = await ok<View>('cover:generate', { jobId, requestId: randomUUID() });
    expect(v1.meta).toMatchObject({ version: 1, parentVersion: null, userEdited: false });
    expect(v1.checks.truth?.ok).toBe(true);
    expect(v1.checks.lint.ok).toBe(true);
    expect(v1.content).toEqual(goodCover);
    expect(v1.tex).toContain('\\letterTo{Nimbus Analytics GmbH}{Berlin, Germany}');
    expect(v1.tex).toContain('\\letterSubject{Application for the position of Data Engineer}');
    if (existsSync(TECTONIC)) {
      expect(v1.checks.compile).toMatchObject({ ok: true, pages: 1 });
      expect(v1.pdfBase64).toBeDefined();
    }
    const stages = await l.page.evaluate(
      () => (window as unknown as { __stages: { stage: string; issues?: number }[] }).__stages,
    );
    expect(stages.map((s) => s.stage)).toEqual(
      expect.arrayContaining(['drafting', 'checking', 'compiling', 'fixing']),
    );
    expect(stages.find((s) => s.stage === 'fixing')?.issues).toBe(2);

    const v2 = await ok<View>('cover:revise', {
      jobId,
      fromVersion: 1,
      instruction: 'sign off differently',
      requestId: randomUUID(),
    });
    expect(v2.meta).toMatchObject({ version: 2, parentVersion: 1 });
    expect(v2.tex).toContain('Best regards,');

    const v3 = await ok<View>('cover:saveManual', {
      jobId,
      fromVersion: 2,
      tex: v2.tex.replace('I live in Berlin', 'I am based in Berlin'),
    });
    expect(v3.meta).toMatchObject({ version: 3, parentVersion: 2, userEdited: true });
    expect(v3.checks.truth).toBeNull();
    expect(v3.content).toBeNull();

    const list = await ok<Summary[]>('cover:markFinal', { jobId, version: 3 });
    expect(list.map((s) => [s.meta.version, s.meta.isFinal, s.truthOk])).toEqual([
      [1, false, true],
      [2, false, true],
      [3, true, null],
    ]);
    expect(list[0]?.words).toBeGreaterThan(230);
    const diff = await ok<{ a: string; b: string }>('cover:diff', { jobId, a: 2, b: 3 });
    expect(diff.a).toContain('I live in Berlin');
    expect(diff.b).toContain('I am based in Berlin');
    expect((await ok<View>('cover:get', { jobId, version: 1 })).tex).toBe(v1.tex);
    // resume versions are a separate series
    expect(await ok('resume:list', { jobId })).toEqual([]);
  });

  test('inputs are validated', async () => {
    expect(await call('cover:get', { jobId, version: 0 })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(
      await call('cover:revise', { jobId, fromVersion: 1, instruction: '  ', requestId: randomUUID() }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(await call('cover:export', { jobId, version: 1, format: 'docx' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await call('cover:get', { jobId, version: 42 })).toMatchObject({
      ok: false,
      error: { code: 'failed' },
    });
  });

  test('export through the save dialog (stubbed)', async () => {
    const target = join(l.sandbox, 'cover.tex');
    await l.app.evaluate(({ dialog }, file) => {
      const g = globalThis as unknown as { __saveName?: string };
      dialog.showSaveDialog = (...a: unknown[]) => {
        const opts = a.at(-1) as { defaultPath?: string };
        g.__saveName = opts.defaultPath;
        return Promise.resolve({ canceled: false, filePath: file });
      };
    }, target);
    expect(await ok('cover:export', { jobId, version: 1, format: 'tex' })).toEqual({
      status: 'saved',
      path: target,
    });
    expect(readFileSync(target, 'utf8')).toContain('\\letterSender{Alex Example}');
    const name = await l.app.evaluate(() => (globalThis as unknown as { __saveName?: string }).__saveName);
    expect(name).toMatch(/Alex_Example_CoverLetter_Nimbus_Analytics_GmbH\.tex$/);
    if (existsSync(TECTONIC)) {
      const pdf = join(l.sandbox, 'cover.pdf');
      await l.app.evaluate(({ dialog }, file) => {
        dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
      }, pdf);
      await ok('cover:export', { jobId, version: 1, format: 'pdf' });
      expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    }
    await l.app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: true, filePath: '' });
    });
    expect(await ok('cover:export', { jobId, version: 1, format: 'tex' })).toEqual({ status: 'cancelled' });
  });

  test('Open in Overleaf hands the OS browser a private auto-submit form', async () => {
    const v1 = await ok<View>('cover:get', { jobId, version: 1 });
    const { url } = await ok<{ url: string }>('cover:openOverleaf', { jobId, version: 1 });
    const opened = await l.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
    expect(opened).toEqual([url]);
    expect(url).toMatch(/^file:\/\/.*stellio-overleaf-.*\.html$/);
    const html = readFileSync(fileURLToPath(url), 'utf8');
    expect(html).toContain('action="https://www.overleaf.com/docs"');
    expect(html).toContain(`value="${encodeURIComponent(v1.tex)}"`);
  });
});
