import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { TodaySummary } from '../../src/shared/tracker';
import { launchApp, type Launched } from './helpers';
import { SHOTS, api, seedTracker, trackerEnv } from './trackerSeed';

async function withApp(
  body: (l: Launched) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const l = await launchApp(trackerEnv(env));
  try {
    await l.page.setViewportSize({ width: 1360, height: 860 });
    await body(l);
  } finally {
    await l.close();
  }
}

const go = (page: Page, hash: string): Promise<void> =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);

test('fresh install: honest empty states, nothing invented', async () => {
  await withApp(async ({ page }) => {
    await go(page, '/');
    await expect(page.getByRole('heading', { name: 'Today', level: 2 })).toBeVisible();
    await expect(page.getByText('Nothing tracked yet')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Needs you' })).toContainText(
      'Nothing needs you right now.',
    );
    await expect(page.getByRole('region', { name: 'New matches' })).toContainText('No new matches.');
    await expect(page.getByRole('region', { name: 'Funnel' })).toContainText(
      'No jobs stored in the last 90 days.',
    );
    await expect(page.getByRole('region', { name: 'Applications per week' })).toContainText(
      'No application sent in the last 12 weeks.',
    );
    await expect(page.getByRole('region', { name: 'Skills pulse' })).toContainText(
      'the skills it asks for that you lack show up here',
    );
    await expect(page.getByRole('region', { name: 'Last scan' })).toContainText('No scan has run.');
    const tiles = page.getByRole('region', { name: 'Status line' }).locator('dl');
    await expect(tiles).toHaveCount(7);
    for (const dd of await tiles.locator('dd:first-of-type').all()) await expect(dd).toHaveText('0');

    // the way out of the empty state
    await page.getByRole('button', { name: 'Add a job' }).click();
    await expect(page.getByRole('heading', { name: 'Workspace', level: 2 })).toBeVisible();
  });
});

test('setup checklist: fresh install shows live status, the profile step flips when the profile is real, dismiss persists', async () => {
  await withApp(
    async (l) => {
      const { page } = l;
      const setup = page.getByRole('region', { name: 'Setup' });
      const row = (id: string) => setup.locator(`li[data-step="${id}"]`);
      await go(page, '/');
      await expect(setup).toBeVisible();
      // the seed profile still has its example entries and no email: not "filled"
      await expect(row('profile')).toHaveAttribute('data-status', 'todo');
      await expect(row('profile')).toContainText('example entry "Job Title — Company"');
      await expect(row('rules')).toHaveAttribute('data-status', 'todo');
      await expect(row('search')).toHaveAttribute('data-status', 'todo');
      await expect(row('scan')).toContainText('Daily scan on (optional)');
      await expect(row('claude')).toHaveAttribute('data-status', 'done'); // the fake CLI is installed and logged in
      // one primary action on the page: the first step that is still to do
      await expect(page.locator('button[class*="primary"]')).toHaveCount(1);
      await expect(row('profile').locator('button[class*="primary"]')).toHaveCount(1);

      // visiting Rules is the whole "reviewed" step
      await setup.getByRole('button', { name: 'Review rules' }).click();
      await expect(page.getByRole('heading', { name: 'Rules', level: 2 })).toBeVisible();
      await go(page, '/');
      await expect(row('rules')).toHaveAttribute('data-status', 'done');

      // a real profile flips its step
      await api(l).ok('profile:save', {
        markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
        expectedHash: null,
      });
      await page.reload();
      await expect(row('profile')).toHaveAttribute('data-status', 'done');
      await expect(row('profile')).toContainText('no example entries');
      await expect(row('search').locator('button[class*="primary"]')).toHaveCount(1);

      // the step button goes to the right place
      await row('search').getByRole('button', { name: 'Add a search profile' }).click();
      await expect(page.getByRole('heading', { name: 'Search profiles', level: 3 })).toBeVisible();
      await go(page, '/');

      // dismiss persists (stored in settings_kv, read back through IPC)
      await setup.getByRole('button', { name: 'Dismiss' }).click();
      await expect(setup).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Today', level: 2 })).toBeVisible();
      await expect(page.getByRole('region', { name: 'Setup' })).toHaveCount(0);
      expect(await api(l).ok('setup:get')).toEqual({
        dismissed: true,
        completed: false,
        rulesReviewed: true,
      });
    },
    { FAKE_CLAUDE_OUTPUT: '{"ok":true}' },
  ); // the login check
});

test('seeded: every number on screen is the number today:summary returns, and rows lead to the application', async () => {
  await withApp(async (l) => {
    const { page } = l;
    const s = await seedTracker(l);
    const t = await api(l).ok<TodaySummary>('today:summary');
    await page.reload(); // Today was already open, and showing the empty install
    await expect(page.getByRole('region', { name: 'Needs you' }).getByRole('link').first()).toBeVisible();

    // status line: count, delta and "now" per tile
    const line = page.getByRole('region', { name: 'Status line' });
    for (const x of t.statusLine) {
      const tile = line.locator('dl', { hasText: x.label }).locator('..');
      await expect(tile.locator('dd').first()).toHaveText(String(x.count));
      await expect(tile).toContainText(`${String(x.current)} now`);
      if (x.delta !== 0)
        await expect(tile.locator('dd').nth(1)).toContainText(
          `${x.delta > 0 ? '+' : '−'}${String(Math.abs(x.delta))}`,
        );
    }
    // the seed has entered saved (3), applied (1), in process (1) this month
    expect(Object.fromEntries(t.statusLine.map((x) => [x.key, [x.count, x.current]]))).toMatchObject({
      saved: [3, 1],
      applied: [1, 0],
      in_process: [1, 1],
    });

    // needs you: the interview tomorrow, the deadline, the follow-up is not due yet
    const needs = page.getByRole('region', { name: 'Needs you' });
    expect(t.needsYou.interviews).toHaveLength(1);
    expect(t.needsYou.deadlines).toHaveLength(1);
    await expect(needs.getByRole('link')).toHaveCount(
      t.needsYou.interviews.length + t.needsYou.deadlines.length + t.needsYou.nudges.length,
    );
    await expect(
      needs.getByRole('link', { name: /Interview.*Nimbus Analytics GmbH.*tomorrow/ }),
    ).toBeVisible();
    await expect(needs.getByRole('link', { name: /Deadline.*Contoso Data AG.*in 2 days/ })).toBeVisible();
    await needs.getByRole('link', { name: /Deadline.*Contoso/ }).click();
    await expect(page).toHaveURL(new RegExp(`/applications/${s.b.appId}$`));
    await go(page, '/');

    // funnel: count and conversion per step
    const funnel = page.getByRole('region', { name: 'Funnel' });
    for (const step of t.funnel.steps) {
      const row = funnel.getByRole('listitem').filter({ hasText: step.label });
      await expect(row).toContainText(String(step.count));
      if (step.conversion !== null)
        await expect(row).toContainText(`${String(Math.round(step.conversion * 100))}%`);
    }
    expect(t.funnel.steps.map((x) => x.count)).toEqual([3, 3, 1, 1, 1, 0]);

    // weekly bars: the chart's own text lists the same 12 weeks
    const label = t.weekly.map((w) => `${w.weekStart.slice(5)} ${String(w.count)}`).join(', ');
    await expect(page.getByRole('img', { name: `Applications per week: ${label}` })).toBeVisible();
    expect(t.weekly.reduce((n, w) => n + w.count, 0)).toBe(1);

    // skills pulse shows the missing skill the analyses name
    await expect(page.getByRole('region', { name: 'Skills pulse' })).toContainText('dbt');
    expect(t.skills.missing.map((m) => m.skill)).toContain('dbt');
  });
});

test('nudges: a skill unused for years that is still on a resume, and an old review date', async () => {
  await withApp(async (l) => {
    const { page } = l;
    await seedTracker(l); // saves the profile and drafts a resume with Python and SQL
    const md = readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8')
      .replace('last_reviewed: 2026-11-01', 'last_reviewed: 2025-12-01')
      .replace('| Python | language | 4 | 5 | now |', '| Python | language | 4 | 5 | 2020 |');
    await api(l).ok('profile:save', { markdown: md, expectedHash: null });
    const t = await api(l).ok<TodaySummary>('today:summary');
    expect(t.needsYou.nudges.map((n) => n.kind)).toEqual(['stale_skill', 'profile_review']);

    await page.reload();
    const needs = page.getByRole('region', { name: 'Needs you' });
    await expect(
      needs.getByRole('link', {
        name: /Stale skill.*Python was last used in 2020 and is still on your resumes/,
      }),
    ).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/today-nudges.png` });
    await needs.getByRole('link', { name: /Profile review.*Profile last reviewed \d+ days ago/ }).click();
    await expect(page).toHaveURL(/#\/profile$/);
  });
});

for (const theme of ['dark', 'light'] as const) {
  test(`axe and zero CSP errors on Today in the ${theme} theme, empty and seeded`, async () => {
    const cspErrors: string[] = [];
    const settled = (page: Page): Promise<unknown> =>
      page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => undefined)),
        ),
      );
    const axe = async (page: Page): Promise<void> => {
      await settled(page);
      const results = await new AxeBuilder({ page }).setLegacyMode().analyze();
      const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
    };
    await withApp(async (l) => {
      const { page } = l;
      page.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('Content Security Policy')) cspErrors.push(m.text());
      });
      await go(page, '/');
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await expect(page.getByText('Nothing tracked yet')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Setup' })).toBeVisible();
      await axe(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/today-empty-${theme}.png` });

      await seedTracker(l);
      await page.reload();
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await expect(page.getByRole('region', { name: 'Needs you' }).getByRole('link').first()).toBeVisible();
      await axe(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/today-${theme}.png` });
    });
    expect(cspErrors).toEqual([]);
  });
}
