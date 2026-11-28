import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import {
  allSourceRoutes,
  sourceUrlsEnv,
  startFixtureServer,
  type FixtureServer,
} from '../fixtures/discovery';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
type Res<T> = { ok: true; data: T } | { ok: false; error: { message: string } };

// The fake check quotes one sentence the posting holds and one it does not: code must drop the second quote.
const sideFitOutput = (realQuote: string) => ({
  side_score: 82,
  verdict: 'take',
  summary: 'Pay and hours fit; the place is in your area.',
  checks: [
    { aspect: 'pay', status: 'ok', finding: '15 €/h, above your 13.90 €/h.', quote: null },
    { aspect: 'hours', status: 'ok', finding: 'Within your 20 hours a week.', quote: realQuote },
    {
      aspect: 'language',
      status: 'warn',
      finding: 'German needed; yours is B1.',
      quote: 'Fließend Deutsch ist Pflicht',
    },
  ],
});

let server: FixtureServer;
let l: Launched;
let page: Page;
const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
  const r = (await invoke(page, channel, input)) as Res<T>;
  if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
  return r.data;
};

test.beforeAll(async () => {
  server = await startFixtureServer(allSourceRoutes());
  l = await launchApp({
    STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
    FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
    ...sourceUrlsEnv(server.base),
  });
  page = l.page;
  await page.setViewportSize({ width: 1360, height: 860 });
  await ok('profile:save', {
    markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
    expectedHash: null,
  });
  // only a side-job profile: everything the scan finds is a side job
  await ok('discovery:saveProfile', {
    profile: {
      name: 'Side money',
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
      kind: 'side',
      maxHoursPerWeek: 20,
      minHourlyPay: 13.9,
    },
  });
  await ok('discovery:scanNow', { requestId: crypto.randomUUID() });
});
test.afterAll(async () => {
  await l.close();
  await server.close();
});

test('a side job: its Fit tab is the side-job check, quotes only what the posting says, and the Inbox shows it', async () => {
  const inbox = await ok<{ jobId: string; sideJob: boolean }[]>('jobs:inbox', {
    filters: {},
    sort: 'rank',
    limit: 50,
  });
  expect(inbox.length).toBeGreaterThan(0);
  expect(inbox.every((i) => i.sideJob)).toBe(true);
  const id = inbox[0]?.jobId ?? '';
  const { job } = await ok<{ job: { descriptionMd: string } }>('jobs:get', { id });
  const realQuote = job.descriptionMd.replace(/\s+/g, ' ').trim().slice(0, 40);
  await l.app.evaluate(
    (_e, out) => {
      process.env.FAKE_CLAUDE_OUTPUT_JOB_SIDE_FIT = out;
    },
    JSON.stringify(sideFitOutput(realQuote)),
  );

  await page.evaluate((h) => {
    window.location.hash = h;
  }, `/workspace/${id}`);
  await page.getByRole('tab', { name: 'Fit' }).click();
  await expect(page.getByText('No side-job check yet')).toBeVisible();
  await page.getByRole('button', { name: 'Check side job' }).click();
  const checks = page.getByRole('list', { name: 'Side-job checks' });
  await expect(checks).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Take it', { exact: true })).toBeVisible();
  await expect(checks.getByRole('listitem')).toHaveCount(3);
  await expect(checks.getByRole('listitem').filter({ hasText: 'Hours' })).toContainText(realQuote);
  // the invented quote is gone, the finding stays
  await expect(checks.getByRole('listitem').filter({ hasText: 'Language' })).toContainText('German needed');
  await expect(checks).not.toContainText('Fließend Deutsch ist Pflicht');
  await expect(page.getByRole('button', { name: 'Re-check' })).toBeVisible();
  const r = await new AxeBuilder({ page }).setLegacyMode().analyze();
  expect(
    r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id),
  ).toEqual([]);

  // the Inbox shows the check as the job's score
  const after = await ok<{ jobId: string; score: number; scoreKind: string }[]>('jobs:inbox', {
    filters: {},
    sort: 'rank',
    limit: 50,
  });
  expect(after.find((i) => i.jobId === id)).toMatchObject({ score: 82, scoreKind: 'fit' });
});
