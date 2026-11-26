import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { badCover, coverPosting, goodCover } from '../fixtures/cover';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const SHOTS = process.env.SCREENSHOTS ? (process.env.SCREENSHOT_DIR ?? 'docs/screenshots/current') : null;
const revised = { ...goodCover, closing: 'Kind regards,' };

/** Every test gets its own app and data folder. Opens the Cover letter tab of an analysed job. */
async function withApp(
  env: Record<string, string>,
  body: (l: Launched, jobId: string) => Promise<void>,
): Promise<void> {
  const l = await launchApp({
    STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
    ...(existsSync(TECTONIC) ? { STELLIO_TECTONIC_BIN: TECTONIC } : {}),
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
    FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
    FAKE_CLAUDE_OUTPUT_COVER_GENERATE: JSON.stringify(goodCover),
    FAKE_CLAUDE_OUTPUT_COVER_REVISE: JSON.stringify(revised),
    ...env,
  });
  try {
    await l.page.setViewportSize({ width: 1360, height: 860 });
    await invoke(l.page, 'profile:save', {
      markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
      expectedHash: null,
    });
    const r = (await invoke(l.page, 'jobs:intakeText', { text: coverPosting, requestId: randomUUID() })) as {
      data: { jobId: string };
    };
    await invoke(l.page, 'jobs:analyze', { id: r.data.jobId, requestId: randomUUID() });
    await l.page.evaluate((id) => {
      window.location.hash = `/workspace/${id}`;
    }, r.data.jobId);
    await l.page.getByRole('tab', { name: 'Cover letter' }).click();
    await body(l, r.data.jobId);
  } finally {
    await l.close();
  }
}

const draft = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Draft cover letter' }).click();
  await expect(page.getByRole('region', { name: 'LaTeX source' })).toBeVisible({ timeout: 60_000 });
};
const onVersion = (page: Page, v: string): Promise<void> =>
  expect(page.getByRole('combobox', { name: 'Version' })).toHaveText(new RegExp(`^${v}\\b`), {
    timeout: 60_000,
  });
const opened = (l: Launched): Promise<string[]> =>
  l.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
const shot = async (page: Page, name: string, theme: string): Promise<void> => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
};

test('empty: says what to do; the draft shows its stages, the PDF and truth + lint checks without ATS', async () => {
  const csp: string[] = [];
  await withApp({ FAKE_CLAUDE_DELAY_MS_COVER_GENERATE: '1500' }, async ({ page }) => {
    page.on('console', (m) => {
      if (m.type() === 'error' && m.text().includes('Content Security Policy')) csp.push(m.text());
    });
    await expect(page.getByText('No letter yet.')).toBeVisible();
    await expect(page.getByText('Uses rules/cover-letter.md · Sonnet 5.5')).toBeVisible();
    await page.getByRole('button', { name: 'Draft cover letter' }).click();
    await expect(page.getByText(/^Drafting · \d+ s$/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

    await expect(page.getByRole('region', { name: 'LaTeX source' })).toBeVisible({ timeout: 60_000 });
    await onVersion(page, 'v1');
    await expect(page.getByRole('textbox', { name: 'Cover letter LaTeX' })).toContainText('documentclass');
    if (existsSync(TECTONIC))
      await expect(page.getByRole('region', { name: 'PDF preview' }).getByText('1 page')).toBeVisible();
    await expect(page.getByText('Every claim traces to your profile')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Lint' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'ATS check' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Skills' })).toHaveCount(0);
  });
  expect(csp).toEqual([]);
});

test('revise creates v2; Changes shows the instruction and a Before/After diff', async () => {
  await withApp({}, async ({ page }) => {
    await draft(page);
    const box = page.getByRole('textbox', { name: 'Revise instruction' });
    await box.fill('shorter closing');
    await box.press('Control+Enter');
    await onVersion(page, 'v2');
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page.getByText('shorter closing')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Change log' })).toHaveCount(0);
    const diff = page.getByRole('table', { name: 'Changes from v1 to v2' });
    await expect(diff.getByRole('columnheader', { name: 'Before' })).toBeVisible();
    await expect(diff.getByText(/added: .*Kind regards/)).toBeVisible();
  });
});

test('truth gate: the blocked letter shows the violation and Use anyway gates Copy', async () => {
  const bad = JSON.stringify(badCover);
  await withApp(
    { FAKE_CLAUDE_OUTPUT_COVER_GENERATE: bad, FAKE_CLAUDE_OUTPUT_COVER_GENERATE_REPAIR: bad },
    async (l) => {
      const { page } = l;
      await draft(page);
      await expect(page.getByRole('alert').filter({ hasText: 'Truth check failed' })).toBeVisible();
      await l.app.evaluate(({ clipboard: c }) => c.writeText('untouched'));
      await page.getByRole('button', { name: 'Copy LaTeX' }).click();
      const dialog = page.getByRole('dialog', { name: 'Use this version anyway?' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      expect(await l.app.evaluate(({ clipboard: c }) => c.readText())).toBe('untouched');
      await page.getByRole('button', { name: 'Copy LaTeX' }).click();
      await dialog.getByRole('button', { name: 'Use anyway' }).click();
      await expect
        .poll(() => l.app.evaluate(({ clipboard: c }) => c.readText()))
        .toContain('\\documentclass');
    },
  );
});

test('export .tex through the stubbed save dialog; Open in Overleaf only after the confirmation', async () => {
  await withApp({}, async (l) => {
    const { page } = l;
    await draft(page);
    const tex = join(l.sandbox, 'letter.tex');
    await l.app.evaluate(({ dialog }, f) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: f });
    }, tex);
    await page.getByRole('button', { name: 'Download' }).click();
    await page.getByRole('menuitem', { name: 'Download .tex' }).click();
    await expect.poll(() => existsSync(tex)).toBe(true);
    expect(readFileSync(tex, 'utf8')).toContain('\\documentclass');

    await page.getByRole('button', { name: 'Open in Overleaf' }).click();
    const dialog = page.getByRole('dialog', { name: 'Open in Overleaf?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await opened(l)).toEqual([]);
    await page.getByRole('button', { name: 'Open in Overleaf' }).click();
    await dialog.getByRole('button', { name: 'Open in Overleaf' }).click();
    await expect.poll(() => opened(l)).toHaveLength(1);
    const [url] = await opened(l);
    expect(readFileSync(fileURLToPath(url ?? ''), 'utf8')).toContain(
      'action="https://www.overleaf.com/docs"',
    );
  });
});

test('palette: Draft cover letter works from the Job tab and does not touch the resume', async () => {
  await withApp({}, async ({ page }, jobId) => {
    await page.getByRole('tab', { name: 'Job' }).click();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Draft cover letter');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'LaTeX source' })).toBeVisible({ timeout: 60_000 });
    expect(((await invoke(page, 'resume:list', { jobId })) as { data: unknown[] }).data).toEqual([]);
  });
});

for (const theme of ['dark', 'light'] as const) {
  test(`axe and screenshots: cover letter empty, draft, checks and changes in the ${theme} theme`, async () => {
    const csp: string[] = [];
    await withApp({}, async ({ page }, jobId) => {
      page.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('Content Security Policy')) csp.push(m.text());
      });
      const axe = async (): Promise<void> => {
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
      };
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await expect(page.getByText('No letter yet.')).toBeVisible();
      await axe();
      await shot(page, 'cover-empty', theme);
      await invoke(page, 'cover:generate', { jobId, requestId: randomUUID() });
      await invoke(page, 'cover:revise', {
        jobId,
        fromVersion: 1,
        instruction: 'shorter closing',
        requestId: randomUUID(),
      });
      await page.reload();
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.getByRole('tab', { name: 'Cover letter' }).click();
      await expect(page.getByText('Every claim traces to your profile')).toBeVisible();
      await axe();
      await shot(page, 'cover-draft', theme);
      await page.getByRole('tab', { name: 'Changes' }).click();
      await expect(page.getByRole('table', { name: 'Changes from v1 to v2' })).toBeVisible();
      await axe();
    });
    expect(csp).toEqual([]);
  });
}
