import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { sampleJd } from '../fixtures/jobs';
import { invoke, launchApp, type Launched } from './helpers';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

// A fresh user: empty HOME and XDG folders, no STELLIO_* path overrides, so the app picks the same default
// locations a real first run would. Run against the packaged app with STELLIO_E2E_EXECUTABLE (docs/PROGRESS.md).
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;
type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

let home: string;
let l: Launched;

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'stellio-home-'));
  for (const d of ['.config', '.local/share', '.cache']) mkdirSync(join(home, d), { recursive: true });
  l = await launchApp({
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    STELLIO_USER_DATA: '', // empty = unset: fall back to the default under XDG_CONFIG_HOME
    STELLIO_DATA_DIR: '',
    STELLIO_CLAUDE_BIN: resolve('tests/fixtures/fake-claude/claude.mjs'),
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
  });
});
test.afterAll(async () => {
  await l.close();
  rmSync(home, { recursive: true, force: true });
});

test('first run: the shell opens on an empty Today and the data folder is seeded in HOME', async () => {
  const { page } = l;
  await expect(page).toHaveTitle('Stellio');
  await expect(page.getByRole('heading', { name: 'Today', level: 2 })).toBeVisible();
  await expect(page.getByText('Nothing tracked yet')).toBeVisible();
  const info = (await invoke(page, 'app:getInfo')) as Res<{ dataDir: string; version: string }>;
  expect(info).toMatchObject({ ok: true, data: { dataDir: join(home, 'Stellio'), version: pkg.version } });
  const data = join(home, 'Stellio');
  for (const f of [
    'profile/praneethreddy.md',
    'rules/resume.md',
    'rules/cover-letter.md',
    'templates/resume.tex',
    '.git',
    '.stellio/stellio.db',
  ])
    expect(existsSync(join(data, f)), f).toBe(true);
  expect(readdirSync(join(home, '.config'))).toContain('Stellio');
});

test('Profile loads from the seeded file', async () => {
  const { page } = l;
  await page.evaluate(() => {
    window.location.hash = '/profile';
  });
  await expect(page.getByRole('heading', { name: 'Profile', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add skill' })).toBeVisible();
});

test('a pasted job description is parsed through the CLI and stored', async () => {
  const r = (await invoke(l.page, 'jobs:intakeText', {
    text: POSTING,
    requestId: randomUUID(),
  })) as Res<{ status: string; jobId: string }>;
  expect(r).toMatchObject({ ok: true, data: { status: 'ok' } });
  if (!r.ok || r.data.status !== 'ok') return;
  const job = (await invoke(l.page, 'jobs:get', { id: r.data.jobId })) as Res<{ job: { title: string } }>;
  expect(job).toMatchObject({ ok: true, data: { job: { title: sampleJd.title } } });
});
