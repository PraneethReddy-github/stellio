import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_AI_SETTINGS, type AiSettings } from '../../src/shared/settings/ai';
import { invoke, launchApp, type Launched } from './helpers';

const BIN = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const claudeOk = {
  STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
  FAKE_CLAUDE_MODE: 'ok',
  FAKE_CLAUDE_OUTPUT: '{"ok":true}',
};

let l: Launched;
let page: Page;
let cspErrors: string[];

const stored = async (): Promise<AiSettings> =>
  ((await invoke(page, 'settings:getAi')) as { data: AiSettings }).data;

/** Radix Select: open by its accessible name, pick an option. */
async function choose(name: string | RegExp, option: string): Promise<void> {
  await page.getByRole('combobox', { name }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function openSettings(p: Page = page): Promise<void> {
  await p.reload();
  await expect(p.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  await expect(p.getByRole('heading', { name: 'AI', level: 3 })).toBeVisible();
}

test.beforeAll(async () => {
  l = await launchApp({ STELLIO_TECTONIC_BIN: BIN, ...claudeOk });
  page = l.page;
  cspErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('Content Security Policy')) cspErrors.push(m.text());
  });
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.evaluate(() => {
    window.location.hash = '/settings';
  });
});
test.afterAll(async () => {
  await l.close();
});
test.beforeEach(async () => {
  cspErrors.length = 0;
  await invoke(page, 'settings:setAi', DEFAULT_AI_SETTINGS);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await openSettings();
});
test.afterEach(() => {
  expect(cspErrors).toEqual([]);
});

test('General shows the data folder and switches theme and density, and keeps them across a reload', async () => {
  await expect(page.getByText(l.dataDir, { exact: true })).toBeVisible();
  const html = page.locator('html');

  await choose('Theme', 'Light');
  await expect(html).toHaveAttribute('data-theme', 'light');
  await choose('Theme', 'Dark');
  await expect(html).toHaveAttribute('data-theme', 'dark');

  await expect(html).not.toHaveAttribute('data-density', /.*/);
  await choose('Density', 'Compact');
  await expect(html).toHaveAttribute('data-density', 'compact');
  await page.reload();
  await expect(html).toHaveAttribute('data-density', 'compact');
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('combobox', { name: 'Density' })).toHaveText('Compact');
  await choose('Density', 'Comfortable');
  await expect(html).not.toHaveAttribute('data-density', /.*/);
});

test('AI: a changed task model and effort persist', async () => {
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await choose('Model for jd.parse', 'claude-opus-5-5');
  await choose('Effort for jd.parse', 'high');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('AI settings saved', { exact: true }).last()).toBeVisible();
  await expect(save).toBeDisabled();
  expect((await stored()).models['jd.parse']).toEqual({ model: 'claude-opus-5-5', effort: 'high' });

  await openSettings();
  await expect(page.getByRole('combobox', { name: 'Model for jd.parse' })).toHaveText('claude-opus-5-5');
  await expect(page.getByRole('combobox', { name: 'Effort for jd.parse' })).toHaveText('high');
});

test('AI: a custom model is validated by the shared schema before it can be saved', async () => {
  const save = page.getByRole('button', { name: 'Save', exact: true });
  await choose('Model for job.triage', 'Custom…');
  const input = page.getByRole('textbox', { name: 'Custom model id for job.triage' });
  await input.fill('--bad model');
  await expect(page.getByText(/Use letters, digits and/)).toBeVisible();
  await expect(save).toBeDisabled();
  expect((await stored()).models['job.triage']).toEqual(DEFAULT_AI_SETTINGS.models['job.triage']);

  await input.fill('claude-future-9');
  await expect(page.getByText(/Use letters, digits and/)).toHaveCount(0);
  await save.click();
  await expect(page.getByText('AI settings saved', { exact: true }).last()).toBeVisible();
  expect((await stored()).models['job.triage'].model).toBe('claude-future-9');

  await openSettings();
  await expect(page.getByRole('combobox', { name: 'Model for job.triage' })).toHaveText('Custom…');
  await expect(page.getByRole('textbox', { name: 'Custom model id for job.triage' })).toHaveValue(
    'claude-future-9',
  );
});

test('AI: concurrency and timeouts persist; bad timeouts are rejected', async () => {
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const def = page.getByRole('textbox', { name: 'Timeout, most tasks (seconds)' });
  await def.fill('5');
  await expect(page.getByText('Whole seconds from 10 to 1800.')).toBeVisible();
  await expect(save).toBeDisabled();
  await def.fill('120');
  await page.getByRole('textbox', { name: 'Timeout, drafting and import (seconds)' }).fill('400');
  await choose('Concurrency', '3');
  await save.click();
  await expect(page.getByText('AI settings saved', { exact: true }).last()).toBeVisible();
  const s = await stored();
  expect([s.concurrency, s.timeoutsSec]).toEqual([3, { default: 120, generation: 400 }]);
});

test('AI: Reset to defaults fills the form; Save writes it; Discard goes back', async () => {
  await choose('Model for resume.generate', 'claude-opus-5-5');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('AI settings saved', { exact: true }).last()).toBeVisible();

  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(page.getByRole('combobox', { name: 'Model for resume.generate' })).toHaveText(
    'claude-sonnet-5-5',
  );
  expect((await stored()).models['resume.generate'].model).toBe('claude-opus-5-5'); // not saved yet
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('combobox', { name: 'Model for resume.generate' })).toHaveText(
    'claude-opus-5-5',
  );

  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(stored).toEqual(DEFAULT_AI_SETTINGS);
});

test('AI: Claude CLI installed and logged in', async () => {
  await expect(page.getByText(/^Installed/)).toBeVisible();
  await expect(page.getByText('Logged in', { exact: true })).toBeVisible();
});

test('AI: not logged in shows the exact fix', async () => {
  const other = await launchApp({ ...claudeOk, FAKE_CLAUDE_MODE: 'auth' });
  try {
    await other.page.evaluate(() => {
      window.location.hash = '/settings';
    });
    await expect(other.page.getByText('Not logged in', { exact: true })).toBeVisible();
    await expect(other.page.getByText('Run claude in a terminal and log in.')).toBeVisible();
    await expect(other.page.locator('code', { hasText: 'claude' })).toBeVisible();
  } finally {
    await other.close();
  }
});

test('AI: CLI not found', async () => {
  const other = await launchApp({ STELLIO_CLAUDE_BIN: '/nonexistent/claude' });
  try {
    await other.page.evaluate(() => {
      window.location.hash = '/settings';
    });
    await expect(other.page.getByText('Not found', { exact: true })).toBeVisible();
    await expect(other.page.getByText(/Install Claude Code, then run/)).toBeVisible();
  } finally {
    await other.close();
  }
});

test('LaTeX: the detected engine, its path and the package cache', async () => {
  const section = page.getByRole('region', { name: 'LaTeX' });
  await expect(section.getByText(/^Tectonic \d/)).toBeVisible();
  await expect(section.getByText(BIN, { exact: true })).toBeVisible();
  await expect(section.getByText('Downloaded', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: /Install Tectonic/ })).toHaveCount(0);
  await expect(section.getByRole('button', { name: 'Download LaTeX packages' })).toHaveCount(0);
});

test('LaTeX: with no engine the install button is offered (not clicked: it would download)', async () => {
  const other = await launchApp({ STELLIO_TECTONIC_BIN: '/nonexistent/tectonic', PATH: '/nonexistent' });
  try {
    await other.page.evaluate(() => {
      window.location.hash = '/settings';
    });
    const section = other.page.getByRole('region', { name: 'LaTeX' });
    await expect(section.getByText('No LaTeX engine found')).toBeVisible();
    await expect(
      section.getByRole('button', { name: 'Install Tectonic (10 MB, verified download)' }),
    ).toBeEnabled();
    await expect(section.getByRole('button', { name: 'Download LaTeX packages' })).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('the index jumps to Notifications and Backups', async () => {
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  for (const name of ['Notifications', 'Backups']) {
    await nav.getByRole('button', { name }).click();
    await expect(page.getByRole('region', { name, exact: true })).toBeInViewport();
  }
});

const axeScenes: Record<string, () => Promise<void>> = {
  settings: async () => {
    await expect(page.getByText(/^Tectonic \d/)).toBeVisible();
  },
  'settings with backups': async () => {
    await page.getByRole('button', { name: 'Back up now' }).click();
    await expect(page.getByRole('table', { name: 'Backups' })).toBeVisible();
  },
  'settings with a custom model': async () => {
    await choose('Model for job.triage', 'Custom…');
    await page.getByRole('textbox', { name: 'Custom model id for job.triage' }).fill('--bad');
    await expect(page.getByText(/Use letters, digits and/)).toBeVisible();
  },
};

for (const theme of ['dark', 'light'] as const) {
  for (const [scene, open] of Object.entries(axeScenes)) {
    test(`axe: ${scene} in the ${theme} theme`, async () => {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await open();
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
