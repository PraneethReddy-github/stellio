import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
  FAKE_CLAUDE_MODE: 'ok',
  FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
  FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
  ...extra,
});

/** Every test gets its own app and data folder, so no test depends on another. */
async function withApp(extra: Record<string, string>, body: (l: Launched) => Promise<void>): Promise<void> {
  const l = await launchApp(env(extra));
  try {
    await l.page.setViewportSize({ width: 1360, height: 860 });
    await body(l);
  } finally {
    await l.close();
  }
}

const openActivity = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    window.location.hash = '/activity';
  });
  await expect(page.getByRole('heading', { name: 'Activity', level: 2 })).toBeVisible();
};

const readJob = (page: Page): Promise<unknown> =>
  invoke(page, 'jobs:intakeText', { text: POSTING, requestId: randomUUID() });

test('empty: says there are no runs yet', async () => {
  await withApp({}, async ({ page }) => {
    await openActivity(page);
    await expect(page.getByText('No AI runs yet.')).toBeVisible();
  });
});

test('lists runs and opens the prompt, input and output of one', async () => {
  await withApp({}, async ({ page }) => {
    await readJob(page);
    await openActivity(page);
    const grid = page.getByRole('grid', { name: 'AI runs' });
    await expect(grid.getByRole('columnheader', { name: 'Time', exact: true })).toBeVisible();
    const row = grid.getByRole('row', { name: /jd\.parse/ });
    await expect(row).toContainText('ok');
    await row.click();
    const inspector = page.getByRole('complementary', { name: /^jd\.parse/ });
    await expect(inspector.getByText('Prompt', { exact: true })).toBeVisible();
    await expect(inspector.getByRole('textbox', { name: 'System prompt' })).toBeVisible();
    await expect(inspector.getByRole('textbox', { name: 'Input' })).toContainText('Nimbus Analytics');
    await expect(inspector.getByRole('textbox', { name: 'Output' })).toContainText('Strong Python and SQL');
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
  });
});

test('a running run says so instead of "pruned", then shows its log once it ends', async () => {
  await withApp({ FAKE_CLAUDE_MODE_JD_PARSE: 'hang' }, async ({ page }) => {
    const requestId = randomUUID();
    void invoke(page, 'jobs:intakeText', { text: POSTING, requestId });
    await openActivity(page);
    const row = page.getByRole('grid', { name: 'AI runs' }).getByRole('row', { name: /jd\.parse/ });
    await expect(row).toContainText('running');
    await row.click();
    const inspector = page.getByRole('complementary', { name: /^jd\.parse/ });
    await expect(
      inspector.getByText('Running — prompt and output are saved when it finishes.'),
    ).toBeVisible();
    await expect(inspector.getByText(/pruned/)).toHaveCount(0);

    await invoke(page, 'tasks:cancel', { requestId });
    await expect(row).toContainText('cancelled', { timeout: 10_000 }); // the list polls while a run is open
    await expect(inspector.getByText(/saved when it finishes/)).toHaveCount(0);
    await expect(inspector.getByRole('textbox', { name: 'System prompt' })).toBeVisible();
  });
});

test('failures: filter, error text and status', async () => {
  await withApp({ FAKE_CLAUDE_MODE_JD_PARSE: 'nonzero_with_json' }, async ({ page }) => {
    await readJob(page);
    await openActivity(page);
    const grid = page.getByRole('grid', { name: 'AI runs' });
    await expect(grid.getByRole('row', { name: /jd\.parse/ })).toContainText('error');
    await page.getByRole('combobox', { name: 'Show' }).click();
    await page.getByRole('option', { name: 'Failures only' }).click();
    await grid.getByRole('row', { name: /jd\.parse/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Run failed' })).toContainText(
      'boom: something broke',
    );
  });
});

test('failures only with no failures says so', async () => {
  await withApp({}, async ({ page }) => {
    await readJob(page);
    await openActivity(page);
    await page.getByRole('combobox', { name: 'Show' }).click();
    await page.getByRole('option', { name: 'Failures only' }).click();
    await expect(page.getByText('No failed runs.')).toBeVisible();
  });
});

for (const theme of ['dark', 'light'] as const) {
  test(`axe: activity with the inspector open in the ${theme} theme`, async () => {
    await withApp({}, async ({ page }) => {
      await readJob(page);
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await openActivity(page);
      await page
        .getByRole('grid', { name: 'AI runs' })
        .getByRole('row', { name: /jd\.parse/ })
        .click();
      await expect(page.getByRole('textbox', { name: 'Output' })).toBeVisible();
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished),
        ),
      );
      const results = await new AxeBuilder({ page }).setLegacyMode().analyze();
      const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    });
  });
}
