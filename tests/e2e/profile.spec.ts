import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const RESUME_PDF = resolve('tests/fixtures/resumes/jordan-vale.pdf');

const importOutput = {
  front: {
    name: 'Jordan Vale',
    headline: 'Data Engineer',
    email: 'jordan@example.com',
    phone: '',
    location: 'Leipzig, Germany',
    links: { linkedin: '', github: '', portfolio: '' },
    work_authorization: '',
    notice_period: '',
    languages_spoken: [],
  },
  summary: 'Data engineer.',
  skills: [],
  experience: [
    { id: 'exp-brightwater', title: 'Data Engineer — Brightwater', meta: {}, bullets: ['Built pipelines.'] },
  ],
  projects: [],
  education: [],
  certifications: [],
  awards: [],
  publications: [],
  notes: '',
};

interface Snapshot {
  markdown: string;
  hash: string;
  model: { frontMatter: { name: string; email: string } };
  diagnostics: { code: string; severity: string }[];
}
type Ok<T> = { ok: true; data: T };

let l: Launched;

test.beforeAll(async () => {
  l = await launchApp({
    STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT: JSON.stringify(importOutput),
  });
});
test.afterAll(async () => {
  await l.close();
});

test('first run creates the data folder, git repo and database', () => {
  for (const rel of [
    'profile/praneethreddy.md',
    'rules/resume.md',
    'templates/resume.tex',
    '.git',
    '.stellio/stellio.db',
  ])
    expect(existsSync(join(l.dataDir, rel)), rel).toBe(true);
});

test('profile: get, save, history, diff, revert', async () => {
  const got = (await invoke(l.page, 'profile:get')) as Ok<Snapshot>;
  expect(got.ok).toBe(true);
  expect(got.data.model.frontMatter.name).toBe('Praneeth Reddy');
  expect(got.data.diagnostics.map((d) => d.code)).toContain('profile_email_missing');

  const edited = got.data.markdown.replace('email: ""', 'email: "p@example.com"');
  const saved = (await invoke(l.page, 'profile:save', {
    markdown: edited,
    expectedHash: got.data.hash,
    message: 'profile: set email',
  })) as Ok<Snapshot>;
  expect(saved.data.model.frontMatter.email).toBe('p@example.com');
  expect(readFileSync(join(l.dataDir, 'profile/praneethreddy.md'), 'utf8')).toContain('p@example.com');

  // Stale hash is refused with a readable message.
  const stale = await invoke(l.page, 'profile:save', { markdown: edited, expectedHash: got.data.hash });
  expect(stale).toMatchObject({
    ok: false,
    error: { code: 'failed', message: expect.stringContaining('changed on disk') },
  });

  const history = (await invoke(l.page, 'profile:history', { limit: 10 })) as Ok<
    { hash: string; message: string }[]
  >;
  expect(history.data[0]?.message).toBe('profile: set email');
  const first = history.data.at(-1);
  if (!first) throw new Error('no history');

  const changes = (await invoke(l.page, 'profile:changes', { hash: history.data[0]?.hash })) as Ok<{
    diff: string;
  }>;
  expect(changes.data.diff).toContain('+email: "p@example.com"');

  const reverted = (await invoke(l.page, 'profile:revert', { hash: first.hash })) as Ok<Snapshot>;
  expect(reverted.data.model.frontMatter.email).toBe('');
});

test('rejects malformed commit hashes', async () => {
  const res = await invoke(l.page, 'profile:changes', { hash: '--output=/tmp/x' });
  expect(res).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
});

test('external edits reach the renderer as events', async () => {
  await l.page.evaluate(() => {
    const w = window as unknown as { __changes: string[] };
    w.__changes = [];
    window.stellio.on('datafolder:changed', ({ relPath }) => w.__changes.push(relPath));
  });
  const file = join(l.dataDir, 'rules/resume.md');
  writeFileSync(file, readFileSync(file, 'utf8') + '\n- extra rule\n');
  await expect
    .poll(() => l.page.evaluate(() => (window as unknown as { __changes: string[] }).__changes), {
      timeout: 5000,
    })
    .toContain('rules/resume.md');
});

test('import: PDF resume → draft via Claude CLI, nothing saved', async () => {
  const before = readFileSync(join(l.dataDir, 'profile/praneethreddy.md'), 'utf8');
  await l.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
  }, RESUME_PDF);
  const res = (await invoke(l.page, 'profile:importFromFile')) as Ok<{
    status: string;
    sourceName: string;
    draft: { markdown: string; model: { frontMatter: { name: string } } };
  }>;
  expect(res.ok).toBe(true);
  expect(res.data).toMatchObject({ status: 'draft', sourceName: 'jordan-vale.pdf' });
  expect(res.data.draft.model.frontMatter.name).toBe('Jordan Vale');
  expect(res.data.draft.markdown).toContain('### Data Engineer — Brightwater {#exp-brightwater}');
  expect(readFileSync(join(l.dataDir, 'profile/praneethreddy.md'), 'utf8')).toBe(before);
});

test('import: cancelled file picker', async () => {
  await l.app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: true, filePaths: [] });
  });
  expect(await invoke(l.page, 'profile:importFromFile')).toEqual({ ok: true, data: { status: 'cancelled' } });
});
