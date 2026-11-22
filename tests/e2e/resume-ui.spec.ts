import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { badContent, goodContent } from '../fixtures/resume';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const read = (rel: string): string => readFileSync(resolve('tests', rel), 'utf8');
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

const reviseOutput = { ...goodContent, projects: [], change_log: ['Dropped Ledger'] };
const fakeEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
  ...(existsSync(TECTONIC) ? { STELLIO_TECTONIC_BIN: TECTONIC } : {}),
  FAKE_CLAUDE_MODE: 'ok',
  FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
  FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
  FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(goodContent),
  FAKE_CLAUDE_OUTPUT_RESUME_REVISE: JSON.stringify(reviseOutput),
  ...extra,
});

/** Every test gets its own app and data folder, so no test depends on another. */
async function withApp(
  env: Record<string, string>,
  body: (l: Launched, jobId: string) => Promise<void>,
): Promise<void> {
  const l = await launchApp(fakeEnv(env));
  try {
    await l.page.setViewportSize({ width: 1360, height: 860 });
    await invoke(l.page, 'profile:save', { markdown: read('fixtures/profiles/full.md'), expectedHash: null });
    const r = (await invoke(l.page, 'jobs:intakeText', { text: POSTING, requestId: randomUUID() })) as {
      data: { jobId: string };
    };
    await invoke(l.page, 'jobs:analyze', { id: r.data.jobId, requestId: randomUUID() });
    await l.page.evaluate((id) => {
      window.location.hash = `/workspace/${id}`;
    }, r.data.jobId);
    await l.page.getByRole('tab', { name: 'Resume' }).click();
    await body(l, r.data.jobId);
  } finally {
    await l.close();
  }
}

const draft = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Draft resume' }).click();
  await expect(page.getByRole('region', { name: 'LaTeX source' })).toBeVisible({ timeout: 60_000 });
};
/** The version select shows this version. */
const onVersion = (page: Page, v: string): Promise<void> =>
  expect(page.getByRole('combobox', { name: 'Version' })).toHaveText(new RegExp(`^${v}\\b`), {
    timeout: 60_000,
  });
const clipboard = (l: Launched): Promise<string> => l.app.evaluate(({ clipboard: c }) => c.readText());
const opened = (l: Launched): Promise<string[]> =>
  l.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
const rendered = (canvas: Locator): Promise<boolean> =>
  canvas.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
    if (!d) return false;
    for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 255) < 200 && (d[i + 3] ?? 0) > 0) return true;
    return false;
  });
const stubSave = (l: Launched, file: string): Promise<void> =>
  l.app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: f });
  }, file);

test('empty: says what to do, then draft shows its stages and a rendered PDF with the ATS score', async () => {
  const cspErrors: string[] = [];
  await withApp({ FAKE_CLAUDE_DELAY_MS_RESUME_GENERATE: '1500' }, async ({ page }) => {
    page.on('console', (m) => {
      if (m.type() === 'error' && m.text().includes('Content Security Policy')) cspErrors.push(m.text());
    });
    await expect(page.getByText('No draft yet.')).toBeVisible();
    await expect(page.getByText('Uses rules/resume.md · Sonnet 5.5')).toBeVisible();
    await page.getByRole('button', { name: 'Draft resume' }).click();
    await expect(page.getByText(/^Drafting · \d+ s$/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

    await expect(page.getByRole('region', { name: 'LaTeX source' })).toBeVisible({ timeout: 60_000 });
    await onVersion(page, 'v1');
    await expect(page.getByRole('textbox', { name: 'Resume LaTeX' })).toContainText('documentclass');
    if (existsSync(TECTONIC)) {
      await expect(page.getByRole('region', { name: 'PDF preview' }).getByText('1 page')).toBeVisible();
      const canvas = page.getByRole('img', { name: 'PDF preview, page 1' });
      await expect.poll(() => rendered(canvas)).toBe(true);
    }
    const ats = page.getByRole('meter', { name: 'ATS score' });
    await expect(ats).toBeVisible();
    expect(Number(await ats.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
    await expect(page.getByText('Every claim traces to your profile')).toBeVisible();
    const required = page.getByRole('list', { name: 'Required keywords' });
    await expect(required.getByText('Python')).toBeVisible();
    await expect(required.getByText('Found').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Lint' })).toBeVisible();
  });
  expect(cspErrors).toEqual([]);
});

test('cancel during the draft: nothing is stored and Draft resume is back', async () => {
  await withApp({ FAKE_CLAUDE_MODE_RESUME_GENERATE: 'hang' }, async ({ page }) => {
    await page.getByRole('button', { name: 'Draft resume' }).click();
    await expect(page.getByText(/^Drafting · \d+ s$/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(page.getByText('No draft yet.')).toBeVisible();
  });
});

test('a failed draft shows the message and a retry', async () => {
  await withApp({ FAKE_CLAUDE_MODE_RESUME_GENERATE: 'nonzero_with_json' }, async ({ page }) => {
    await page.getByRole('button', { name: 'Draft resume' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not draft the resume' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test('revise with Ctrl+Enter creates v2; Changes shows the log and a Before/After diff', async () => {
  await withApp({}, async ({ page }) => {
    await draft(page);
    const box = page.getByRole('textbox', { name: 'Revise instruction' });
    await box.fill('drop the project');
    await box.press('Control+Enter');
    await onVersion(page, 'v2');
    await expect(box).toHaveValue('');

    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page.getByText('drop the project')).toBeVisible();
    await expect(page.getByText('Dropped Ledger')).toBeVisible();
    const diff = page.getByRole('table', { name: 'Changes from v1 to v2' });
    await expect(diff.getByRole('columnheader', { name: 'Before' })).toBeVisible();
    await expect(diff.getByRole('columnheader', { name: 'After' })).toBeVisible();
    await expect(diff.getByText(/removed: .*Ledger/).first()).toBeVisible();
  });
});

test('manual edit: Ctrl+S saves v3 with the not-applied note and no truth check', async () => {
  await withApp({}, async ({ page }) => {
    await draft(page);
    await page.getByRole('textbox', { name: 'Revise instruction' }).fill('drop the project');
    await page.getByRole('button', { name: 'Revise', exact: true }).click();
    await onVersion(page, 'v2');
    const save = page.getByRole('button', { name: 'Save as new version' });
    await expect(save).toBeDisabled();
    await page.getByRole('textbox', { name: 'Resume LaTeX' }).click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.type('% hand edit\n');
    await expect(save).toBeEnabled();
    await expect(page.getByText(/Unsaved edits/)).toBeVisible();
    await page.keyboard.press('Control+s');

    await onVersion(page, 'v3');
    await expect(page.getByText('Saved as v3', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'LaTeX source' }).getByText(/truth check not applied/),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Truth check' }).getByText(/truth check not applied/),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Resume LaTeX' })).toContainText('% hand edit');
    await expect(save).toBeDisabled();
    // Revise works on drafted versions only
    await expect(page.getByText(/edited by hand/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revise', exact: true })).toBeDisabled();
  });
});

test('truth violation: blocking error, and Use anyway gates the copy', async () => {
  const bad = JSON.stringify(badContent);
  await withApp(
    { FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: bad, FAKE_CLAUDE_OUTPUT_RESUME_GENERATE_REPAIR: bad },
    async (l) => {
      const { page } = l;
      await draft(page);
      const alert = page.getByRole('alert').filter({ hasText: 'Truth check failed' });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('73');
      await expect(page.getByRole('region', { name: 'Truth check' }).getByText('1 violation')).toBeVisible();

      await l.app.evaluate(({ clipboard: c }) => c.writeText('untouched'));
      await page.getByRole('button', { name: 'Copy LaTeX' }).click();
      const dialog = page.getByRole('dialog', { name: 'Use this version anyway?' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      expect(await clipboard(l)).toBe('untouched');

      await page.getByRole('button', { name: 'Copy LaTeX' }).click();
      await dialog.getByRole('button', { name: 'Use anyway' }).click();
      await expect.poll(() => clipboard(l)).toContain('\\documentclass');
    },
  );
});

test('copy LaTeX puts the source on the clipboard without a prompt', async () => {
  await withApp({}, async (l) => {
    await draft(l.page);
    await l.page.getByRole('button', { name: 'Copy LaTeX' }).click();
    await expect(l.page.getByText('LaTeX copied', { exact: true })).toBeVisible();
    const text = await clipboard(l);
    expect(text).toContain('\\documentclass');
    expect(text).toContain('{Globex}');
  });
});

test('download .tex and .pdf write through the stubbed save dialog', async () => {
  await withApp({}, async (l) => {
    const { page } = l;
    await draft(page);
    const tex = join(l.sandbox, 'out.tex');
    await stubSave(l, tex);
    await page.getByRole('button', { name: 'Download' }).click();
    await page.getByRole('menuitem', { name: 'Download .tex' }).click();
    await expect.poll(() => existsSync(tex)).toBe(true);
    expect(readFileSync(tex, 'utf8')).toContain('{Globex}');
    if (existsSync(TECTONIC)) {
      const pdf = join(l.sandbox, 'out.pdf');
      await stubSave(l, pdf);
      await page.getByRole('button', { name: 'Download' }).click();
      await page.getByRole('menuitem', { name: 'Download .pdf' }).click();
      await expect.poll(() => existsSync(pdf)).toBe(true);
      expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-');
    }
  });
});

test('Open in Overleaf: explains, and calls openExternal once only after the confirmation', async () => {
  await withApp({}, async (l) => {
    const { page } = l;
    await draft(page);
    await page.getByRole('button', { name: 'Open in Overleaf' }).click();
    const dialog = page.getByRole('dialog', { name: 'Open in Overleaf?' });
    await expect(dialog).toContainText('overleaf.com');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await opened(l)).toEqual([]);

    await page.getByRole('button', { name: 'Open in Overleaf' }).click();
    await dialog.getByRole('button', { name: 'Open in Overleaf' }).click();
    await expect.poll(() => opened(l)).toHaveLength(1);
    const [url] = await opened(l);
    expect(url).toMatch(/^file:\/\/.*stellio-overleaf-.*\.html$/);
    expect(readFileSync(fileURLToPath(url ?? ''), 'utf8')).toContain(
      'action="https://www.overleaf.com/docs"',
    );
  });
});

test('mark final: Final tag in the header and the version select', async () => {
  await withApp({}, async ({ page }) => {
    await draft(page);
    await page.getByRole('button', { name: 'Mark final' }).click();
    await expect(page.getByText('Final', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Version' })).toContainText('v1 · Final');
    await expect(page.getByRole('button', { name: 'Final', exact: true })).toBeDisabled();
  });
});

test('stale: editing rules/resume.md shows the banner, and Regenerate makes the next version', async () => {
  await withApp({}, async ({ page }) => {
    await draft(page);
    await expect(page.getByText(/changed since this version/)).toHaveCount(0);
    const rules = readFileSync('seed/rules/resume.md', 'utf8');
    const saved = await invoke(page, 'rules:save', {
      path: 'rules/resume.md',
      content: rules.replace('page_limit: 1', 'page_limit: 2'),
      expectedHash: null,
      message: 'rules: edit resume.md',
    });
    expect(saved).toMatchObject({ ok: true });
    // The Rules screen writes through the same IPC; the job page reads staleness when it opens.
    await page.reload();
    await page.getByRole('tab', { name: 'Resume' }).click();
    const banner = page.getByRole('status').filter({ hasText: 'changed since this version' });
    await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: 'Regenerate' }).click();
    await onVersion(page, 'v2');
    await expect(banner).toHaveCount(0);
  });
});

test('palette: Draft resume, Copy LaTeX and Open in Overleaf from the job page', async () => {
  await withApp({}, async (l) => {
    const { page } = l;
    await page.getByRole('tab', { name: 'Job' }).click();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Draft resume');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'LaTeX source' })).toBeVisible({ timeout: 60_000 });

    await page.getByRole('tab', { name: 'Job' }).click();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Copy LaTeX');
    await page.keyboard.press('Enter');
    await expect.poll(() => clipboard(l)).toContain('\\documentclass');

    await page.keyboard.press('Control+k');
    await page.keyboard.type('Revise resume');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Revise instruction' })).toBeFocused();

    await page.keyboard.press('Control+k');
    await page.keyboard.type('Open in Overleaf');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Open in Overleaf?' })).toBeVisible();
  });
});

// Both themes: empty, a draft with Checks and Changes, and a blocked draft.
for (const theme of ['dark', 'light'] as const) {
  const axe = async (page: Page): Promise<void> => {
    // Axe reads colours mid-animation otherwise.
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
  const setTheme = (page: Page): Promise<void> =>
    page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);

  test(`axe: empty, draft, checks and changes in the ${theme} theme`, async () => {
    const cspErrors: string[] = [];
    await withApp({}, async ({ page }, jobId) => {
      page.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('Content Security Policy')) cspErrors.push(m.text());
      });
      await setTheme(page);
      await expect(page.getByText('No draft yet.')).toBeVisible();
      await axe(page);
      await invoke(page, 'resume:generate', { jobId, requestId: randomUUID() });
      await invoke(page, 'resume:revise', {
        jobId,
        fromVersion: 1,
        instruction: 'drop the project',
        requestId: randomUUID(),
      });
      await page.reload();
      await setTheme(page);
      await page.getByRole('tab', { name: 'Resume' }).click();
      await expect(page.getByRole('meter', { name: 'ATS score' })).toBeVisible();
      if (existsSync(TECTONIC))
        await expect.poll(() => rendered(page.getByRole('img', { name: 'PDF preview, page 1' }))).toBe(true);
      await axe(page);
      await page.getByRole('tab', { name: 'Changes' }).click();
      await expect(page.getByRole('table', { name: 'Changes from v1 to v2' })).toBeVisible();
      await axe(page);
    });
    expect(cspErrors).toEqual([]);
  });

  test(`axe: blocked draft with the confirmation in the ${theme} theme`, async () => {
    const bad = JSON.stringify(badContent);
    await withApp(
      { FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: bad, FAKE_CLAUDE_OUTPUT_RESUME_GENERATE_REPAIR: bad },
      async ({ page }) => {
        await setTheme(page);
        await draft(page);
        await expect(page.getByRole('alert').filter({ hasText: 'Truth check failed' })).toBeVisible();
        await axe(page);
        await page.getByRole('button', { name: 'Copy LaTeX' }).click();
        await expect(page.getByRole('dialog', { name: 'Use this version anyway?' })).toBeVisible();
        await axe(page);
      },
    );
  });
}
