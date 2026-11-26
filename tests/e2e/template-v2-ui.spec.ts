import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { coverTexts, resumeTexts } from '../../src/shared/documents';
import { goodCover } from '../fixtures/cover';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { fullContent } from '../fixtures/resume';
import { invoke, launchApp, type Launched } from './helpers';

// Template format 2 (phase 11): the Profile photo section and the Workspace German version, axe-clean in both
// themes, no CSP errors. SCREENSHOTS=1 SCREENSHOT_DIR=docs/screenshots/phase-11 saves the screens.
const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const SHOTS = process.env.SCREENSHOTS ? (process.env.SCREENSHOT_DIR ?? 'docs/screenshots/current') : null;
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

const axe = async (page: Page): Promise<void> => {
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
const shot = async (page: Page, name: string, theme: string): Promise<void> => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
};
const setTheme = (page: Page, theme: string): Promise<void> =>
  page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);

for (const theme of ['dark', 'light'] as const) {
  test(`photo section and German versions: axe and no CSP errors in the ${theme} theme`, async () => {
    const csp: string[] = [];
    const l: Launched = await launchApp({
      STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
      ...(existsSync(TECTONIC) ? { STELLIO_TECTONIC_BIN: TECTONIC } : {}),
      FAKE_CLAUDE_MODE: 'ok',
      FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
      FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
      FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(fullContent),
      FAKE_CLAUDE_OUTPUT_RESUME_TRANSLATE: JSON.stringify({ items: resumeTexts(fullContent) }),
      FAKE_CLAUDE_OUTPUT_COVER_GENERATE: JSON.stringify(goodCover),
      FAKE_CLAUDE_OUTPUT_COVER_TRANSLATE: JSON.stringify({ items: coverTexts(goodCover) }),
    });
    const { page } = l;
    try {
      page.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('Content Security Policy')) csp.push(m.text());
      });
      await page.setViewportSize({ width: 1360, height: 860 });
      await invoke(page, 'profile:save', {
        markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
        expectedHash: null,
      });
      await l.app.evaluate(({ dialog }, f) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
      }, resolve('tests/fixtures/latex/photo.jpg'));

      await page.evaluate(() => {
        window.location.hash = '/profile';
      });
      await setTheme(page, theme);
      const section = page.getByRole('region', { name: 'Resume photo' });
      await expect(section.getByRole('button', { name: 'Choose photo…' })).toBeVisible();
      await axe(page);
      await section.getByRole('button', { name: 'Choose photo…' }).click();
      await expect(section.getByRole('img', { name: 'Your resume photo' })).toBeVisible();
      await section.scrollIntoViewIfNeeded();
      await axe(page);
      await shot(page, 'profile-photo', theme);

      const r = (await invoke(page, 'jobs:intakeText', { text: POSTING, requestId: randomUUID() })) as {
        data: { jobId: string };
      };
      const jobId = r.data.jobId;
      await invoke(page, 'jobs:analyze', { id: jobId, requestId: randomUUID() });
      await invoke(page, 'resume:generate', { jobId, requestId: randomUUID() });
      await invoke(page, 'resume:translate', { jobId, fromVersion: 1, requestId: randomUUID() });
      await invoke(page, 'cover:generate', { jobId, requestId: randomUUID() });
      await invoke(page, 'cover:translate', { jobId, fromVersion: 1, requestId: randomUUID() });

      await page.evaluate((id) => {
        window.location.hash = `/workspace/${id}`;
      }, jobId);
      await setTheme(page, theme);
      await page.getByRole('tab', { name: 'Resume' }).click();
      await expect(page.getByRole('combobox', { name: 'Version' })).toHaveText(/^v2 · German/, {
        timeout: 30_000,
      });
      await expect(page.getByRole('button', { name: 'German version' })).toBeDisabled();
      if (existsSync(TECTONIC))
        await expect(page.getByRole('img', { name: 'PDF preview, page 1' })).toBeVisible({ timeout: 30_000 });
      await axe(page);
      await shot(page, 'resume-german', theme);

      await page.getByRole('tab', { name: 'Cover letter' }).click();
      await expect(page.getByRole('combobox', { name: 'Version' }).last()).toHaveText(/^v2 · German/);
      if (existsSync(TECTONIC))
        await expect(page.getByRole('img', { name: 'PDF preview, page 1' }).last()).toBeVisible({
          timeout: 30_000,
        });
      await axe(page);
      await shot(page, 'cover-german', theme);
    } finally {
      await l.close();
    }
    expect(csp).toEqual([]);
  });
}
