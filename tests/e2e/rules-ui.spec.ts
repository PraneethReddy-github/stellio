import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { invoke, launchApp, type Launched } from './helpers';

const BIN = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const FILES = [
  'rules/resume.md',
  'rules/cover-letter.md',
  'rules/skills-policy.md',
  'rules/referral-message.md',
  'templates/resume.tex',
  'templates/cover-letter.tex',
] as const;
const seedOf = (path: string): string => readFileSync(resolve('seed', path), 'utf8');
const RESUME = 'rules/resume.md';
const TEMPLATE = 'templates/resume.tex';

// One app launch; every test starts from the seed files (beforeEach), so a failure cannot hide the rest.
let l: Launched;
let page: Page;
let cspErrors: string[];
const onDisk = (path: string): string => readFileSync(join(l.dataDir, path), 'utf8');
const toast = (text: string): Locator => page.getByText(text, { exact: true }).last();
const editor = (name: string): Locator => page.getByRole('textbox', { name: `${name} content` });
const fileButton = (name: string): Locator =>
  page.getByRole('navigation', { name: 'Files' }).getByRole('button', { name: new RegExp(`^${name}`) });
const save = (path: string, content: string, message = 'test: edit'): Promise<unknown> =>
  invoke(page, 'rules:save', { path, content, expectedHash: null, message });

/**
 * Rewrites the one editor line that contains `find`. (Replacing the whole document with Ctrl+A makes Chromium
 * put a style attribute on the new lines, which the production CSP blocks; real edits do not.)
 */
async function editLine(name: string, find: string, replacement: string): Promise<void> {
  await editor(name).locator('.cm-line', { hasText: find }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.type(replacement);
}
const limit = (n: number): Promise<void> => editLine('resume.md', 'page_limit', `page_limit: ${String(n)}`);

async function openRules(): Promise<void> {
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Rules', level: 2 })).toBeVisible();
  await expect(fileButton('resume.md')).toBeVisible();
  await expect(editor('resume.md')).toBeVisible();
}

test.beforeAll(async () => {
  l = await launchApp({ STELLIO_TECTONIC_BIN: BIN });
  page = l.page;
  cspErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('Content Security Policy')) cspErrors.push(m.text());
  });
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.evaluate(() => {
    window.location.hash = '/rules';
  });
});
test.afterAll(async () => {
  await l.close();
});
test.beforeEach(async () => {
  cspErrors.length = 0;
  for (const f of FILES) await save(f, seedOf(f), 'test: reset');
  await openRules();
});
test.afterEach(() => {
  expect(cspErrors).toEqual([]);
});

test('the list shows the six files, clean and unmodified', async () => {
  const nav = page.getByRole('navigation', { name: 'Files' });
  await expect(nav.getByRole('button')).toHaveCount(6);
  for (const n of [
    'resume.md',
    'cover-letter.md',
    'skills-policy.md',
    'referral-message.md',
    'resume.tex',
    'cover-letter.tex',
  ])
    await expect(fileButton(n)).toBeVisible();
  await expect(nav.getByText('template')).toHaveCount(2);
  await expect(nav.getByText('modified')).toHaveCount(0);
  await expect(nav.getByText(/error|warning/)).toHaveCount(0);
  await expect(page.getByText('Stellio reads this file every time it drafts a resume.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Test compile' })).toHaveCount(0);
});

test('an invalid value shows a live diagnostic with its line; fixing and saving writes disk and history', async () => {
  await limit(9);
  const row = page.getByRole('button', { name: /^error .*L\d+$/ });
  await expect(row).toBeVisible();
  await expect(page.getByText(/^1 error · 0 warnings$/)).toBeVisible();
  await expect(fileButton('resume.md')).toContainText('1 error');
  await expect(fileButton('resume.md')).toContainText('unsaved');
  const line = (await row.getByText(/^L\d+$/).textContent())?.slice(1) ?? '';
  expect(Number(line)).toBeGreaterThan(1);

  await row.click();
  await expect(page.locator('.cm-activeLineGutter')).toHaveText(line);

  await limit(1);
  await expect(row).toHaveCount(0);
  await expect(page.getByText('No problems found.')).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(toast('resume.md saved')).toBeVisible();
  await expect.poll(() => onDisk(RESUME)).toContain('page_limit: 1');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(fileButton('resume.md')).toContainText('modified');

  await page.getByRole('tab', { name: 'History' }).click();
  const versions = page.getByRole('grid', { name: 'Versions' });
  await expect(versions.getByRole('row').nth(1)).toContainText('rules: edit resume.md');
  await expect(page.getByText('Current version')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);
});

test('referral-message.md edits like the others: a live diagnostic, then save writes disk', async () => {
  await fileButton('referral-message.md').click();
  await expect(editor('referral-message.md')).toContainText('connection_note');
  await editLine('referral-message.md', 'max_chars', '  max_chars: 200');
  await expect(fileButton('referral-message.md')).toContainText('unsaved');
  await page.keyboard.press('Control+s');
  await expect(toast('referral-message.md saved')).toBeVisible();
  await expect.poll(() => onDisk('rules/referral-message.md')).toContain('max_chars: 200');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('Discard drops unsaved edits; edits survive switching files', async () => {
  await limit(3);
  await fileButton('cover-letter.md').click();
  await expect(editor('cover-letter.md')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await fileButton('resume.md').click();
  await expect(editor('resume.md')).toContainText('page_limit: 3');
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(editor('resume.md')).toContainText('page_limit: 2');
  expect(onDisk(RESUME)).toBe(seedOf(RESUME));
});

test('history: restore an older version after confirming', async () => {
  const seed = seedOf(RESUME);
  await save(RESUME, seed.replace('page_limit: 2', 'page_limit: 1'), 'rules: edit resume.md');
  await save(RESUME, seed.replace('page_limit: 2', 'page_limit: 3'), 'rules: edit resume.md');
  await openRules();
  await page.getByRole('tab', { name: 'History' }).click();
  const versions = page.getByRole('grid', { name: 'Versions' });
  await expect(page.getByText('Current version')).toBeVisible();
  await versions.getByRole('row').nth(2).click(); // the page_limit: 1 version
  await expect(page.getByRole('table', { name: /^Changes in/ })).toContainText('page_limit: 1');
  await expect(page.getByRole('columnheader', { name: 'Before' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'After' })).toBeVisible();
  await page.getByRole('button', { name: 'Restore this version' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
  await expect(dialog).toContainText('kept in history');
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(toast('Version restored')).toBeVisible();
  await expect.poll(() => onDisk(RESUME)).toContain('page_limit: 1');
  await page.getByRole('tab', { name: 'Edit' }).click();
  await expect(editor('resume.md')).toContainText('page_limit: 1');
});

test('default tab shows the diff; reset keeps the old text in history', async () => {
  const seed = seedOf(RESUME);
  await save(RESUME, seed.replace('page_limit: 2', 'page_limit: 1'));
  await openRules();
  await page.getByRole('tab', { name: 'Default' }).click();
  await expect(page.getByRole('table', { name: 'Current to default' })).toContainText('page_limit: 2');
  await expect(page.getByRole('columnheader', { name: 'Current' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Default' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset to default' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reset to default?' });
  await expect(dialog).toContainText('kept in history');
  await dialog.getByRole('button', { name: 'Reset' }).click();
  await expect(toast('The previous version is in History.')).toBeVisible();
  await expect.poll(() => onDisk(RESUME)).toBe(seed);
  await expect(page.getByText('This file matches the default.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset to default' })).toBeDisabled();
  await expect(fileButton('resume.md')).not.toContainText('modified');
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('grid', { name: 'Versions' }).getByRole('row').nth(1)).toContainText(
    'reset to default',
  );
});

test('template test compile shows one page and draws the PDF without CSP errors', async () => {
  await fileButton('resume.tex').click();
  await expect(editor('resume.tex')).toBeVisible();
  await page.getByRole('button', { name: 'Test compile' }).click();
  await expect(page.getByText('Compiled')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('1 page', { exact: true })).toBeVisible();
  const canvas = page.getByRole('img', { name: 'PDF preview, page 1' });
  await expect(canvas).toBeVisible();
  // Drawn, not blank: the page is white with dark text, so some pixel must differ from white.
  await expect
    .poll(
      () =>
        canvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          if (c.width < 100) return false;
          const ctx = c.getContext('2d');
          if (!ctx) return false;
          const { data } = ctx.getImageData(0, 0, c.width, c.height);
          for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 255) < 200) return true;
          return false;
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
  const box = await canvas.boundingBox();
  const pane = await page.getByRole('complementary', { name: 'Checks' }).boundingBox();
  expect(box && pane && box.width <= pane.width).toBe(true);
});

test('a broken template shows a line-numbered compile error that jumps to the line', async () => {
  await fileButton('resume.tex').click();
  const seed = seedOf(TEMPLATE);
  const line = seed.split('\n').findIndex((x) => x.includes('\\pagestyle{empty}')) + 2;
  await editor('resume.tex').locator('.cm-line', { hasText: '\\pagestyle{empty}' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('\\thisisnotdefined');
  await page.getByRole('button', { name: 'Test compile' }).click(); // compiles the unsaved draft
  await expect(page.getByText('Failed')).toBeVisible({ timeout: 30_000 });
  const errors = page.getByRole('list', { name: 'Compile errors' });
  const row = errors.getByRole('button', { name: new RegExp(`L${String(line)}$`) });
  await expect(row).toContainText('Undefined control sequence');
  await expect(page.getByRole('img', { name: 'PDF preview, page 1' })).toHaveCount(0);

  await editor('resume.tex').click();
  await page.keyboard.press('Control+Home');
  await row.click();
  await expect(page.locator('.cm-activeLineGutter')).toHaveText(String(line));
  expect(onDisk(TEMPLATE)).toBe(seed); // nothing was saved
});

test('template diagnostics are live', async () => {
  await fileButton('resume.tex').click();
  await editor('resume.tex').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('%% STELLIO:END stray\n');
  await expect(page.getByRole('button', { name: /^error .*L\d+$/ }).first()).toBeVisible();
  await expect(fileButton('resume.tex')).toContainText('error');
});

test('external edit while clean reloads', async () => {
  writeFileSync(join(l.dataDir, RESUME), seedOf(RESUME).replace('page_limit: 2', 'page_limit: 1'));
  await expect(toast('Reloaded — the file changed outside Stellio')).toBeVisible();
  await expect(editor('resume.md')).toContainText('page_limit: 1');
  await expect(fileButton('resume.md')).toContainText('modified');
});

test('external edit while dirty warns; saving conflicts; reload recovers', async () => {
  await limit(3);
  writeFileSync(join(l.dataDir, RESUME), seedOf(RESUME).replace('page_limit: 2', 'page_limit: 1'));
  await expect(
    page.getByText('The file changed on disk. Your unsaved edits are based on the old version.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Could not save resume.md' });
  await expect(alert).toContainText('changed on disk');
  await alert.getByRole('button', { name: 'Reload from disk' }).click();
  await expect(alert).toHaveCount(0);
  await expect(editor('resume.md')).toContainText('page_limit: 1');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

/** Edit resume.md, change it on disk, then leave the file and come back: the editor remounts and re-reads disk. */
async function conflictAfterRemount(): Promise<void> {
  await limit(3);
  writeFileSync(join(l.dataDir, RESUME), seedOf(RESUME).replace('page_limit: 2', 'page_limit: 1'));
  await expect(page.getByText('The file changed on disk.')).toBeVisible();
  await fileButton('cover-letter.md').click();
  await expect(editor('cover-letter.md')).toBeVisible();
  await fileButton('resume.md').click();
  await expect(editor('resume.md')).toContainText('page_limit: 3');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}

test('a conflict is still caught after switching files and back (no silent overwrite)', async () => {
  await conflictAfterRemount();
  const alert = page.getByRole('alert').filter({ hasText: 'Could not save resume.md' });
  await expect(alert).toContainText('changed on disk');
  expect(onDisk(RESUME)).toContain('page_limit: 1');
  await alert.getByRole('button', { name: 'Reload from disk (discard mine)' }).click();
  await expect(editor('resume.md')).toContainText('page_limit: 1');
});

test('overwrite with my version needs a confirmation and keeps the disk version in history', async () => {
  await conflictAfterRemount();
  const alert = page.getByRole('alert').filter({ hasText: 'Could not save resume.md' });
  await alert.getByRole('button', { name: 'Overwrite with my version' }).click();
  const dialog = page.getByRole('dialog', { name: 'Overwrite the version on disk?' });
  await expect(dialog).toContainText('kept in history');
  expect(onDisk(RESUME)).toContain('page_limit: 1'); // nothing is written before the confirmation
  await dialog.getByRole('button', { name: 'Overwrite' }).click();
  await expect(toast('resume.md saved')).toBeVisible();
  await expect.poll(() => onDisk(RESUME)).toContain('page_limit: 3');
  await page.getByRole('tab', { name: 'History' }).click();
  const versions = page.getByRole('grid', { name: 'Versions' });
  await expect(versions.getByRole('row').nth(1)).toContainText('rules: edit resume.md');
  await versions.getByRole('row').nth(2).click(); // "snapshot before save": the external edit
  await expect(page.getByRole('table', { name: /^Changes in/ })).toContainText('page_limit: 1');
});

test('the on-disk warning goes away with the edits it was about', async () => {
  await limit(3);
  writeFileSync(join(l.dataDir, RESUME), seedOf(RESUME).replace('page_limit: 2', 'page_limit: 1'));
  const warning = page.getByText('The file changed on disk.');
  await expect(warning).toBeVisible();
  await editor('resume.md').click();
  for (let i = 0; i < 4; i++) await page.keyboard.press('Control+z'); // undo back to the text this edit started from
  await expect(warning).toHaveCount(0);
  await expect(editor('resume.md')).toContainText('page_limit: 1'); // and the file is shown as it is on disk now
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('Save and Discard belong to the Edit tab', async () => {
  await save(RESUME, seedOf(RESUME).replace('page_limit: 2', 'page_limit: 1')); // differs from the default
  await openRules();
  await limit(3);
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Discard' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Default' }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByText('Save or discard your unsaved edits on the Edit tab first.')).toBeVisible();
  await page.getByRole('tab', { name: 'Edit' }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

test('external edit of a file that is not open is kept as a warning on that file', async () => {
  await limit(3);
  await fileButton('cover-letter.md').click();
  writeFileSync(join(l.dataDir, RESUME), seedOf(RESUME).replace('page_limit: 2', 'page_limit: 1'));
  await fileButton('resume.md').click();
  await expect(page.getByText('The file changed on disk.')).toBeVisible();
  await page.getByRole('button', { name: 'Reload (discard my edits)' }).click();
  await expect(editor('resume.md')).toContainText('page_limit: 1');
});

test('with no engine the template says so and links to Settings', async () => {
  const bare = await launchApp({
    STELLIO_TECTONIC_BIN: '/nonexistent/tectonic',
    PATH: '/nonexistent',
  });
  try {
    await bare.page.setViewportSize({ width: 1360, height: 860 });
    await bare.page.evaluate(() => {
      window.location.hash = '/rules';
    });
    await bare.page
      .getByRole('navigation', { name: 'Files' })
      .getByRole('button', { name: /^resume\.tex/ })
      .click();
    await expect(bare.page.getByText('No LaTeX engine found.')).toBeVisible();
    await expect(bare.page.getByRole('button', { name: 'Test compile' })).toBeDisabled();
    await bare.page.getByRole('link', { name: 'Set up in Settings' }).click();
    await expect(bare.page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  } finally {
    await bare.close();
  }
});

const axeScenes: Record<string, () => Promise<void>> = {
  'rules edit tab': async () => {
    await limit(9);
    await expect(page.getByRole('button', { name: /^error .*L\d+$/ })).toBeVisible();
  },
  'template edit tab with compile result': async () => {
    await fileButton('resume.tex').click();
    await page.getByRole('button', { name: 'Test compile' }).click();
    await expect(page.getByRole('img', { name: 'PDF preview, page 1' })).toBeVisible({ timeout: 30_000 });
  },
  'history tab': async () => {
    await save(RESUME, seedOf(RESUME).replace('page_limit: 2', 'page_limit: 1'), 'rules: edit resume.md');
    await openRules();
    await page.getByRole('tab', { name: 'History' }).click();
    await page.getByRole('grid', { name: 'Versions' }).getByRole('row').nth(2).click();
    await expect(page.getByRole('table', { name: /^Changes in/ })).toBeVisible();
  },
  'default tab': async () => {
    await save(RESUME, seedOf(RESUME).replace('page_limit: 2', 'page_limit: 1'));
    await openRules();
    await page.getByRole('tab', { name: 'Default' }).click();
    await expect(page.getByRole('table', { name: 'Current to default' })).toBeVisible();
  },
  'reset dialog': async () => {
    await save(RESUME, seedOf(RESUME).replace('page_limit: 2', 'page_limit: 1'));
    await openRules();
    await page.getByRole('tab', { name: 'Default' }).click();
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
  },
};

for (const theme of ['dark', 'light'] as const) {
  for (const [scene, open] of Object.entries(axeScenes)) {
    test(`axe: ${scene} in the ${theme} theme`, async () => {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await open();
      // Axe reads colours mid-animation otherwise (a fading dialog lowers every contrast ratio).
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
  }
}
