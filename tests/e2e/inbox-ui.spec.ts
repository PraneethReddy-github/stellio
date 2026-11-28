import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { allSourceRoutes, sourceUrlsEnv, type Routes } from '../fixtures/discovery';
import { invoke, launchApp, type Launched } from './helpers';
import { SHOTS } from './trackerSeed';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
interface Inbox {
  jobId: string;
  company: string;
  title: string;
  url: string | null;
  remote: string;
  score: number | null;
}

/** The fixture sources on one local server, with one source answering slowly and one failing. */
async function startSources(slowPath: string, failPath: string) {
  const routes: Routes = allSourceRoutes();
  const server = http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const route = routes[path];
    const found = typeof route === 'function' ? route(new URL(req.url ?? '/', 'http://x')) : route;
    const send = (): void => {
      if (path === failPath) return void res.writeHead(500).end('boom');
      if (!found) return void res.writeHead(404).end('not found');
      res
        .writeHead(found.status ?? 200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(found.body ?? {}));
    };
    if (path === slowPath) setTimeout(send, 2500);
    else send();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let sources: Awaited<ReturnType<typeof startSources>>;
let l: Launched;
let page: Page;
const cspErrors: string[] = [];

const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
  const r = (await invoke(page, channel, input)) as Res<T>;
  if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
  return r.data;
};
const go = (hash: string): Promise<void> =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
const grid = () => page.getByRole('grid', { name: 'Discovered jobs' });
const dataRows = () =>
  grid()
    .getByRole('row')
    .filter({ has: page.getByRole('gridcell') });
const profile = {
  name: 'Germany + remote',
  roles: ['Data Engineer', 'Analytics Engineer'],
  keywords: [],
  excludeKeywords: [],
  locations: ['Germany'],
  remoteOk: true,
  countries: ['Germany'],
  seniority: [],
  salaryFloor: null,
  currency: null,
  languages: [],
  excludedCompanies: [],
  enabled: true,
  kind: 'career',
  maxHoursPerWeek: null,
  minHourlyPay: null,
};

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  sources = await startSources('/api/job-board-api', '/pc/v6/jobs');
  l = await launchApp({
    STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
    FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
    FAKE_CLAUDE_TRIAGE_SCORES: JSON.stringify({ 'Spree Daten': 90 }),
    ...sourceUrlsEnv(sources.base),
  });
  page = l.page;
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('Content Security Policy')) cspErrors.push(m.text());
  });
  await page.setViewportSize({ width: 1360, height: 860 });
  await ok('profile:save', {
    markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
    expectedHash: null,
  });
});
test.afterAll(async () => {
  await l.close();
  await sources.close();
});
test.afterEach(() => {
  expect(cspErrors).toEqual([]);
});

test('first run: no search profile points to Settings', async () => {
  await go('/inbox');
  await expect(page.getByRole('heading', { name: 'Inbox', level: 2 })).toBeVisible();
  await expect(page.getByText('No search profile yet')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/inbox-first-run.png` });
  await expect(page.getByRole('button', { name: 'Scan now' })).toHaveCount(0);
  // the pointer may rest over the rail, which then covers the button: move it into the page first
  await page.mouse.move(2, 400);
  await page.mouse.move(700, 500, { steps: 6 });
  await page.getByRole('button', { name: 'Create a search profile' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Search profiles' })).toBeVisible();
});

test('scan now: live per-source progress, cancel offered, ranked rows, a failing source shown as partial', async () => {
  test.setTimeout(120_000);
  await ok('discovery:saveProfile', { profile });
  await ok('discovery:setApiKey', { id: 'adzuna', appId: 'app12345', appKey: 'sekret-key-98765432' });
  await go('/inbox');
  await expect(page.getByText('No new jobs', { exact: true })).toBeVisible();
  await expect(page.getByText('No scan yet.')).toBeVisible();

  await page.getByRole('button', { name: 'Scan now' }).click();
  const progress = page.getByRole('region', { name: 'Scan progress' });
  await expect(progress).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel scan' })).toBeVisible();
  // a fast source reports while the slow one is still waiting
  await expect(progress).toContainText('Remotive');
  await expect(progress).toContainText(/\d+ fetched · \d+ new/);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/inbox-scanning.png` });
  await expect(page.getByRole('button', { name: 'Scan now' })).toHaveCount(0);

  await expect(progress).toBeHidden({ timeout: 90_000 });
  const inbox = await ok<Inbox[]>('jobs:inbox', { filters: {}, sort: 'rank', limit: 50 });
  expect(inbox.length).toBeGreaterThan(3);
  await expect(dataRows()).toHaveCount(inbox.length);
  // ranked: the rows are in the order the backend ranks them
  await expect(dataRows().first()).toContainText(inbox[0]?.title ?? '');
  await expect(dataRows().nth(1)).toContainText(inbox[1]?.company ?? '');
  await expect(page.getByText(`${String(inbox.length)} jobs`)).toBeVisible();

  // Arbeitsagentur answered HTTP 500: partial, named, the rest still listed
  const errors = page.getByRole('list', { name: 'Source errors' });
  await expect(errors).toContainText('Arbeitsagentur');
  await expect(errors).toContainText('HTTP 500');
  await expect(page.getByText(/Last scan .* · partial · \d+ new/)).toBeVisible();
});

test('inspector, keys J/K, filters and "new since last scan"', async () => {
  const inbox = await ok<Inbox[]>('jobs:inbox', { filters: {}, sort: 'rank', limit: 50 });
  await go('/inbox');
  await expect(dataRows()).toHaveCount(inbox.length);

  const inspector = page.getByRole('complementary', { name: 'Job' });
  // A first click on a lower row opens that row, not row 1 (mouse focus must not pre-select row 1).
  await dataRows().last().click();
  await expect(dataRows().last()).toHaveAttribute('aria-selected', 'true');
  await expect(inspector.getByRole('heading', { name: inbox.at(-1)?.title ?? '', level: 3 })).toBeVisible();
  await dataRows().first().click();
  await expect(inspector.getByRole('heading', { name: inbox[0]?.title ?? '', level: 3 })).toBeVisible();
  await expect(inspector.getByRole('region', { name: 'Score' })).toContainText(/\d+ (fit|triage) score/);
  await expect(inspector.getByRole('region', { name: 'Red flags' })).toBeVisible();
  await expect(inspector.getByRole('region', { name: 'Job description' })).toBeVisible();
  await expect(inspector.getByRole('region', { name: 'Sources' })).toBeVisible();

  await grid().focus();
  await page.keyboard.press('j');
  await expect(dataRows().nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(inspector.getByText(inbox[1]?.company ?? '', { exact: true })).toBeVisible();
  await page.keyboard.press('k');
  await expect(dataRows().first()).toHaveAttribute('aria-selected', 'true');

  // remote filter
  const remote = inbox.filter((i) => i.remote === 'remote').length;
  await page.getByRole('combobox', { name: 'Remote' }).click();
  await page.getByRole('option', { name: 'Remote', exact: true }).click();
  await expect(dataRows()).toHaveCount(remote);
  // score band
  await page.getByRole('combobox', { name: 'Remote' }).click();
  await page.getByRole('option', { name: 'Any location' }).click();
  await page.getByRole('combobox', { name: 'Score' }).click();
  await page.getByRole('option', { name: '75 and up' }).click();
  await expect(dataRows()).toHaveCount(inbox.filter((i) => (i.score ?? 0) >= 75).length);
  await page.getByRole('combobox', { name: 'Score' }).click();
  await page.getByRole('option', { name: 'Any score' }).click();
  // source
  await page.getByRole('combobox', { name: 'Source' }).click();
  await page.getByRole('option', { name: 'Remotive' }).click();
  await expect(dataRows()).toHaveCount(
    (await ok<Inbox[]>('jobs:inbox', { filters: { source: 'remotive' }, sort: 'rank', limit: 50 })).length,
  );
  await page.getByRole('combobox', { name: 'Source' }).click();
  await page.getByRole('option', { name: 'All sources' }).click();
  // text
  await page.getByRole('searchbox', { name: 'Search' }).fill('zzz-nothing');
  await expect(page.getByText('No job matches these filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(dataRows()).toHaveCount(inbox.length);
  // everything was found by the last scan
  await page.getByRole('switch', { name: 'New since last scan' }).click();
  await expect(dataRows()).toHaveCount(inbox.length);
  await page.getByRole('switch', { name: 'New since last scan' }).click();
});

for (const theme of ['dark', 'light'] as const) {
  test(`axe and screenshots: inbox in the ${theme} theme`, async () => {
    await go('/inbox');
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await expect(dataRows().first()).toBeVisible();
    await dataRows().first().click();
    await expect(page.getByRole('complementary', { name: 'Job' })).toBeVisible();
    await settled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/inbox-${theme}.png` });
    await axe();

    await page.getByRole('combobox', { name: 'Score' }).click();
    await page.getByRole('option', { name: '75 and up' }).click();
    await page.getByRole('searchbox', { name: 'Search' }).fill('zzz-nothing');
    await expect(page.getByText('No job matches these filters')).toBeVisible();
    await axe();
    await page.getByRole('button', { name: 'Clear filters' }).click();

    await grid().focus();
    await page.keyboard.press('d');
    await expect(page.getByRole('dialog', { name: 'Dismiss this job' })).toBeVisible();
    await settled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/inbox-dismiss-${theme}.png` });
    await axe();
    await page.keyboard.press('Escape');
  });
}

test('S shortlists (toast opens the application), D dismisses with a reason, O opens the posting, Enter opens the Workspace', async () => {
  const before = await ok<Inbox[]>('jobs:inbox', { filters: {}, sort: 'rank', limit: 50 });
  await go('/inbox');
  await expect(dataRows()).toHaveCount(before.length);

  // S
  const first = before[0];
  await dataRows().first().click();
  await grid().focus();
  await page.keyboard.press('s');
  const toast = page.getByRole('status').filter({ hasText: 'Shortlisted' });
  await expect(toast).toContainText(first?.title ?? '');
  await expect(dataRows()).toHaveCount(before.length - 1);
  const app = await ok<{ id: string; status: string }>('apps:forJob', { jobId: first?.jobId });
  expect(app.status).toBe('saved');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('heading', { name: first?.title ?? '', level: 2 })).toBeVisible();
  await go('/inbox');
  await expect(dataRows()).toHaveCount(before.length - 1);

  // D
  const rows = await ok<Inbox[]>('jobs:inbox', { filters: {}, sort: 'rank', limit: 50 });
  await dataRows().first().click();
  await grid().focus();
  await page.keyboard.press('d');
  const dialog = page.getByRole('dialog', { name: 'Dismiss this job' });
  await expect(dialog).toContainText(rows[0]?.title ?? '');
  await dialog.getByRole('radio', { name: 'Salary' }).click();
  await dialog.getByRole('textbox', { name: 'Note (optional)' }).fill('below my floor');
  await dialog.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(dataRows()).toHaveCount(rows.length - 1);
  expect((await ok<{ job: { state: string } }>('jobs:get', { id: rows[0]?.jobId })).job.state).toBe(
    'dismissed',
  );

  // O
  const withUrl = rows.slice(1).find((r) => r.url?.startsWith('https://'));
  expect(withUrl).toBeDefined();
  await dataRows()
    .filter({ hasText: withUrl?.title ?? '' })
    .filter({ hasText: withUrl?.company ?? '' })
    .first()
    .click();
  await grid().focus();
  await page.keyboard.press('o');
  await expect
    .poll(() => l.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
    .toContain(withUrl?.url);

  // Enter
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/workspace/${withUrl?.jobId ?? ''}$`));
});

test('Today: new matches open that job in the Inbox, last scan lists per-source counts', async () => {
  await go('/');
  const matches = page.getByRole('region', { name: 'New matches' });
  const link = matches.getByRole('link').nth(1);
  await expect(link).toBeVisible();
  await link.click();
  await expect(page).toHaveURL(/#\/inbox\?job=/);
  await expect(page.getByRole('complementary', { name: 'Job' })).toBeVisible();

  await go('/');
  const scan = page.getByRole('region', { name: 'Last scan' });
  await expect(scan).toContainText(/\d+ new/);
  await expect(scan).toContainText('Remotive');
  await expect(scan).toContainText(/\d+ fetched · \d+ new/);
});

test('a second scan with nothing new: "No job matches" under "new since last scan", cancel works', async () => {
  test.setTimeout(120_000);
  await go('/inbox');
  await page.getByRole('button', { name: 'Scan now' }).click();
  await expect(page.getByRole('region', { name: 'Scan progress' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Scan progress' })).toBeHidden({ timeout: 90_000 });
  await page.getByRole('switch', { name: 'New since last scan' }).click();
  await expect(page.getByText('No job matches these filters')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();

  // cancel while the slow source is still answering
  await page.getByRole('button', { name: 'Scan now' }).click();
  await page.getByRole('button', { name: 'Cancel scan' }).click();
  await expect(page.getByRole('region', { name: 'Scan progress' })).toBeHidden({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Scan now' })).toBeVisible();
});

test('Re-score: the menu counts each choice and re-scores the list; one job from the inspector', async () => {
  // a pasted job lands in the Inbox unscored (every scanned job here already has a fit analysis);
  // the fake parse names it "Data Engineer" at "Nimbus Analytics GmbH" (the scanned one is "Nimbus Analytics")
  const text = `Werkstudent Data (m/w/d) at Elbe Werk GmbH in Hamburg. ${'Python and SQL for reports. '.repeat(8)}`;
  const added = await ok<{ jobId: string }>('jobs:intakeText', { text, requestId: crypto.randomUUID() });
  await go('/inbox');
  await page.reload();
  await go('/inbox');
  await expect(page.getByRole('button', { name: 'Re-score' })).toBeEnabled();
  await axe(); // before the menu opens: an open Radix menu hides the page behind it from assistive tech
  await page.getByRole('button', { name: 'Re-score' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Unscored jobs · 1' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'All jobs in this list · 1' })).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: /^Scored before your profile changed · 0/ }),
  ).toHaveAttribute('aria-disabled', 'true');
  await menu.getByRole('menuitem', { name: /^Unscored jobs/ }).click();
  await expect(page.getByText('Re-scored 1 job').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Re-score progress' })).toBeHidden();

  // one job: the button sits in the Score section; a job with a fit analysis has none
  const row = dataRows()
    .filter({ has: page.getByRole('gridcell', { name: 'Nimbus Analytics GmbH', exact: true }) })
    .first();
  await row.click();
  const score = page.getByRole('complementary', { name: 'Job' }).getByRole('region', { name: 'Score' });
  await expect(score).toContainText('triage score');
  // the panel shows a summary; the whole saved text is one click away, and a short text offers the full one
  const desc = page
    .getByRole('complementary', { name: 'Job' })
    .getByRole('region', { name: 'Job description' });
  await expect(desc.getByText('The source sent only part of this posting.')).toBeVisible();
  await expect(desc.getByRole('button', { name: 'Paste full text' })).toBeVisible();
  await expect(desc).toContainText('Python and SQL for reports.');
  // the summary already is the whole (short) text, so there is nothing more to show
  await expect(desc.getByRole('button', { name: 'Show full text' })).toHaveCount(0);
  await score.getByRole('button', { name: 'Re-score' }).click();
  await expect(page.getByText('Re-scored 1 job').nth(1)).toBeVisible({ timeout: 30_000 });
  await dataRows().filter({ hasText: 'Orbit Labs' }).first().click();
  await expect(score).toContainText('fit score');
  await expect(score.getByRole('button', { name: 'Re-score' })).toHaveCount(0);
  await ok('jobs:delete', { id: added.jobId });
});

test('a side-job profile adds the Career | Side jobs switch; career jobs stay under Career', async () => {
  const before = await ok<Inbox[]>('jobs:inbox', { filters: {}, sort: 'rank', limit: 50 });
  await go('/inbox');
  await expect(page.getByRole('tablist', { name: 'Which jobs' })).toHaveCount(0);
  const side = await ok<{ id: string }>('discovery:saveProfile', {
    profile: { ...profile, name: 'Side money', kind: 'side', maxHoursPerWeek: 20, minHourlyPay: 13.9 },
  });
  await page.reload();
  await go('/inbox');
  const tabs = page.getByRole('tablist', { name: 'Which jobs' });
  await expect(tabs.getByRole('tab', { name: 'Career' })).toHaveAttribute('aria-selected', 'true');
  await expect(dataRows()).toHaveCount(before.length);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/inbox-career-side.png` });
  await tabs.getByRole('tab', { name: 'Side jobs' }).click();
  await expect(page.getByText('No side jobs yet')).toBeVisible();
  await axe();
  await tabs.getByRole('tab', { name: 'Career' }).click();
  await expect(dataRows()).toHaveCount(before.length);
  await ok('discovery:deleteProfile', { id: side.id });
});

async function settled(): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}
async function axe(): Promise<void> {
  await settled();
  const results = await new AxeBuilder({ page }).setLegacyMode().analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
