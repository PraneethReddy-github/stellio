import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { invoke, launchApp, type Launched } from './helpers';

const BIN = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const RESUME = 'rules/resume.md';

interface Snap {
  path: string;
  content: string;
  hash: string;
  diagnostics: { code: string; severity: string; line: number | null }[];
}
type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: { code: string; message: string } };

let l: Launched;
test.beforeAll(async () => {
  l = await launchApp({ STELLIO_TECTONIC_BIN: BIN });
});
test.afterAll(async () => {
  await l.close();
});

test('rules:list returns the six seeded files, unmodified and clean', async () => {
  const res = (await invoke(l.page, 'rules:list')) as Ok<
    { path: string; kind: string; errors: number; modified: boolean }[]
  >;
  expect(res.data.map((f) => f.path)).toEqual([
    'rules/resume.md',
    'rules/cover-letter.md',
    'rules/skills-policy.md',
    'rules/referral-message.md',
    'templates/resume.tex',
    'templates/cover-letter.tex',
  ]);
  expect(res.data.every((f) => f.errors === 0 && !f.modified)).toBe(true);
});

test('paths outside the allow-list are rejected by validation', async () => {
  for (const path of ['profile/praneethreddy.md', '../../etc/passwd', 'rules/x.md']) {
    const res = (await invoke(l.page, 'rules:get', { path })) as Err;
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe('invalid_input');
  }
});

test('get, save (line-numbered lint), history, changes, revert, resetPreview, reset', async () => {
  const first = (await invoke(l.page, 'rules:get', { path: RESUME })) as Ok<Snap>;
  expect(first.data.diagnostics).toEqual([]);

  const saved = (await invoke(l.page, 'rules:save', {
    path: RESUME,
    content: first.data.content.replace('page_limit: 1', 'page_limit: 9'),
    expectedHash: first.data.hash,
    message: 'rules: break it',
  })) as Ok<Snap>;
  expect(saved.data.diagnostics[0]).toMatchObject({ severity: 'error', line: 4 });

  const stale = (await invoke(l.page, 'rules:save', {
    path: RESUME,
    content: 'x',
    expectedHash: first.data.hash,
  })) as Err;
  expect(stale.error.message).toContain('changed on disk');

  const history = (await invoke(l.page, 'rules:history', { path: RESUME, limit: 10 })) as Ok<
    { hash: string; message: string }[]
  >;
  expect(history.data.map((h) => h.message)).toEqual(['rules: break it', expect.any(String)]);
  const [latest, initial] = history.data;
  if (!latest || !initial) throw new Error('expected two commits');

  const changes = (await invoke(l.page, 'rules:changes', { path: RESUME, hash: latest.hash })) as Ok<{
    diff: string;
  }>;
  expect(changes.data.diff).toContain('+page_limit: 9');

  const preview = (await invoke(l.page, 'rules:resetPreview', { path: RESUME })) as Ok<{
    current: string;
    seedDefault: string;
  }>;
  expect(preview.data.current).toContain('page_limit: 9');
  expect(preview.data.seedDefault).toBe(first.data.content);

  const reverted = (await invoke(l.page, 'rules:revert', { path: RESUME, hash: initial.hash })) as Ok<Snap>;
  expect(reverted.data.content).toBe(first.data.content);

  const edited = (await invoke(l.page, 'rules:save', {
    path: RESUME,
    content: first.data.content.replace('page_limit: 1', 'page_limit: 2'),
    expectedHash: reverted.data.hash,
  })) as Ok<Snap>;
  const reset = (await invoke(l.page, 'rules:reset', {
    path: RESUME,
    expectedHash: edited.data.hash,
  })) as Ok<Snap>;
  expect(reset.data.content).toBe(first.data.content);
  const list = (await invoke(l.page, 'rules:list')) as Ok<{ path: string; modified: boolean }[]>;
  expect(list.data.find((f) => f.path === RESUME)?.modified).toBe(false);
});

test('latex:status reports the engine', async () => {
  test.skip(!existsSync(BIN), 'no tectonic binary (STELLIO_TECTONIC_BIN or spikes/latex/bin/tectonic)');
  const res = (await invoke(l.page, 'latex:status')) as Ok<{
    engine: { kind: string; path: string; version: string } | null;
    cacheWarm: boolean | null;
    sandbox: string | null;
  }>;
  expect(res.data.engine).toMatchObject({ kind: 'tectonic', path: BIN });
  expect(res.data.sandbox).toBe('bwrap');
  expect(res.data.cacheWarm).toBe(true);
});

test('latex:compileTemplate compiles both seed templates to one page and flags broken ones', async () => {
  test.skip(!existsSync(BIN), 'no tectonic binary (STELLIO_TECTONIC_BIN or spikes/latex/bin/tectonic)');
  for (const path of ['templates/resume.tex', 'templates/cover-letter.tex']) {
    const res = (await invoke(l.page, 'latex:compileTemplate', { path })) as Ok<{
      ok: boolean;
      pages: number;
      errors: unknown[];
      pdfBase64: string;
    }>;
    expect(res.data).toMatchObject({ ok: true, pages: 1, errors: [] });
    expect(Buffer.from(res.data.pdfBase64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
  }
  const bad = (await invoke(l.page, 'latex:compileTemplate', {
    path: 'templates/resume.tex',
    content: '\\documentclass{article}\n\\begin{document}\n\\nope\n\\end{document}\n',
  })) as Ok<{ ok: boolean; errors: { line: number; message: string }[]; pdfBase64?: string }>;
  expect(bad.data.ok).toBe(false);
  expect(bad.data.errors[0]).toEqual({ line: 3, message: 'Undefined control sequence' });
  expect(bad.data.pdfBase64).toBeUndefined();
  // Template text is untrusted: file access is refused before TeX runs (and bwrap blocks it anyway).
  const evil = (await invoke(l.page, 'latex:compileTemplate', {
    path: 'templates/resume.tex',
    content: '\\documentclass{article}\n\\begin{document}\n\\input{/etc/hostname}\n\\end{document}\n',
  })) as Ok<{ ok: boolean; errors: { line: number; message: string }[] }>;
  expect(evil.data.ok).toBe(false);
  expect(evil.data.errors[0]).toEqual({
    line: 3,
    message: "Stellio templates can't read or write files: \\input on line 3",
  });
});

test('latex:compileTemplate rejects other paths', async () => {
  const res = (await invoke(l.page, 'latex:compileTemplate', { path: 'rules/resume.md' })) as Err;
  expect(res.error.code).toBe('invalid_input');
});
