import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { launchApp, type Launched } from './helpers';

let l: Launched;
let page: Page;

const open = (hash: string): Promise<void> =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);

test.beforeAll(async () => {
  l = await launchApp({
    STELLIO_TECTONIC_BIN: '/nonexistent/tectonic',
    STELLIO_CLAUDE_BIN: resolve('tests/fixtures/fake-claude/claude.mjs'),
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT: '{"ok":true}',
  });
  page = l.page;
  await page.setViewportSize({ width: 1360, height: 860 });
});
test.afterAll(async () => {
  await l.close();
});

test('the rail collapses when the mouse leaves after a click, and still opens for the keyboard', async () => {
  const rail = page.getByRole('navigation', { name: 'Main' });
  const width = (): Promise<number> =>
    rail.locator('> div').evaluate((el) => el.getBoundingClientRect().width);
  await rail.hover();
  await rail.getByRole('link', { name: /Skills/ }).click();
  await expect.poll(width).toBeGreaterThan(150);
  await page.mouse.move(900, 500);
  await expect.poll(width).toBeLessThan(80);

  await page.keyboard.press('Tab');
  await expect.poll(width).toBeGreaterThan(150);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(width).toBeLessThan(80);
});

test('jumping to the last Settings section scrolls the page body, never the window', async () => {
  await open('/settings');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(page.getByText('No LaTeX engine found')).toBeAttached();
  for (const name of ['Backups', 'LaTeX', 'Notifications']) {
    await nav.getByRole('button', { name }).click();
    await expect(page.getByRole('region', { name, exact: true })).toBeInViewport();
    const scrolled = await page.evaluate(() =>
      [document.documentElement, document.body, document.getElementById('root')].map((e) => e?.scrollTop),
    );
    expect(scrolled).toEqual([0, 0, 0]);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(860);
  }
  await expect(page.getByRole('button', { name: /Search or run a command/ })).toBeInViewport();
});

test('a link to one Settings section lands on it, also while the sections above still load', async () => {
  await open('/');
  await page.getByRole('button', { name: 'Open LaTeX settings' }).click();
  await expect(page.getByText('No LaTeX engine found')).toBeVisible();
  await expect(page.getByRole('region', { name: 'LaTeX', exact: true })).toBeInViewport({ ratio: 0.9 });
  // At the top, or as far up as the page can scroll.
  const settled = (): Promise<boolean> =>
    page.evaluate(() => {
      const main = document.getElementById('main');
      const el = document.getElementById('settings-latex');
      if (!main || !el) return false;
      const top = el.getBoundingClientRect().top - main.getBoundingClientRect().top;
      return top < 40 || main.scrollTop + main.clientHeight >= main.scrollHeight - 1;
    });
  await expect.poll(settled).toBe(true);
});

test('the focus ring of an input is drawn inside its box, so no container can clip a side', async () => {
  await open('/settings');
  const input = page.getByRole('textbox', { name: 'Timeout, most tasks (seconds)' });
  await input.focus();
  const ring = await input.evaluate((el) => {
    const c = getComputedStyle(el);
    return { width: parseFloat(c.outlineWidth), offset: parseFloat(c.outlineOffset), style: c.outlineStyle };
  });
  expect(ring.style).toBe('solid');
  expect(ring.width).toBeGreaterThanOrEqual(2);
  expect(ring.width + ring.offset).toBeLessThanOrEqual(0);
});

test('a full-screen window is filled on every page, with the same left edge', async () => {
  await page.setViewportSize({ width: 1920, height: 1040 });
  for (const path of ['/', '/skills', '/insights', '/workspace', '/settings', '/profile', '/inbox']) {
    await open(path);
    const title = page.getByRole('heading', { level: 2 }).first();
    await expect(title).toBeVisible();
    const box = await page.locator('#main > div').first().boundingBox();
    expect(box?.x).toBe(56);
    expect(box?.width).toBeGreaterThan(1840);
  }
  await page.setViewportSize({ width: 1360, height: 860 });
});
