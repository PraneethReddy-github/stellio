import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type Launched } from './helpers';

const FILE = Buffer.from('#!/bin/sh\n# new stellio\n'.repeat(50_000));
const release = (v: string, body: string) => ({
  tag_name: `v${v}`,
  draft: false,
  prerelease: false,
  body,
  assets: [
    {
      name: `Stellio-${v}-x86_64.AppImage`,
      size: FILE.length,
      digest: `sha256:${createHash('sha256').update(FILE).digest('hex')}`,
    },
  ],
});
let server: http.Server;
let url: string;
let checks = 0;
let corrupt = true;
const downloads: string[] = [];
let dir: string;
let appImage: string;
let l: Launched;

const axe = async (page: Page): Promise<void> => {
  const r = await new AxeBuilder({ page }).setLegacyMode().analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
};

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'stellio-appimage-'));
  appImage = join(dir, 'Stellio.AppImage');
  writeFileSync(appImage, 'old');
  server = http.createServer((req, res) => {
    if (req.url === '/releases') {
      checks++;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify([
          release('99.1.0', '- **Faster:** scans\n  - and `quieter`'),
          release('99.0.0', '- Older fix <b>not html</b>'),
          release('0.0.1', '- ancient'),
        ]),
      );
    } else {
      downloads.push(req.url ?? '');
      res.end(corrupt ? Buffer.alloc(FILE.length) : FILE);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  l = await launchApp({ STELLIO_UPDATE_URL: url, APPIMAGE: appImage });
});
test.afterAll(async () => {
  await l.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test('a newer release: notes, a failed checksum changes nothing, then download, install and restart prompt', async () => {
  const { page } = l;
  const banner = page.getByRole('status').filter({ hasText: 'Stellio 99.1.0 is available.' });
  await expect(banner).toBeVisible();
  await axe(page);
  await banner.getByRole('button', { name: 'See what is new' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stellio 99.1.0' });
  const notes = dialog.getByRole('region', { name: 'What is new' });
  await expect(notes.getByText('Faster: scans')).toBeVisible();
  await expect(notes.getByText('and quieter')).toBeVisible();
  await expect(notes.getByText('Older fix <b>not html</b>')).toBeVisible();
  await expect(notes.getByText('ancient')).toHaveCount(0);
  for (const t of ['dark', 'light']) {
    await page.evaluate((x) => {
      document.documentElement.dataset.theme = x;
    }, t);
    await page.waitForTimeout(400); // theme and dialog transitions
    await axe(page);
  }

  await dialog.getByRole('button', { name: 'Download and install' }).click();
  await expect(dialog.getByText(/does not match the published checksum/)).toBeVisible();
  expect(readFileSync(appImage, 'utf8')).toBe('old');

  corrupt = false;
  await dialog.getByRole('button', { name: 'Download and install' }).click();
  await expect(dialog.getByRole('button', { name: 'Restart Stellio' })).toBeVisible();
  expect(readFileSync(appImage).equals(FILE)).toBe(true);
  expect(downloads.at(-1)).toBe('/download/v99.1.0/Stellio-99.1.0-x86_64.AppImage');
  await dialog.getByRole('button', { name: 'Later' }).click();
  await expect(page.getByText('Stellio 99.1.0 is installed. Restart to use it.')).toBeVisible();
});

test('Settings: the check can be switched off, Check now still works; a dismissed version stays quiet', async () => {
  const { page } = l;
  await page.getByRole('button', { name: 'Dismiss update' }).click();
  await page.evaluate(() => {
    window.location.hash = '/settings';
  });
  const section = page.getByRole('region', { name: 'General', exact: true });
  const auto = section.getByRole('switch', { name: 'Check for updates automatically' });
  await expect(auto).toBeChecked();
  await auto.click();
  await expect(auto).not.toBeChecked();
  expect(checks).toBe(1);
  await section.getByRole('button', { name: 'Check now' }).click();
  await expect.poll(() => checks).toBe(2);
  await expect(section.getByText('Version 99.1.0 is available.')).toBeVisible();
  await page.reload();
  await expect(auto).not.toBeChecked();
  await expect(page.getByRole('button', { name: 'Dismiss update' })).toHaveCount(0);
});

test('Restart closes the app (a real one starts again)', async () => {
  const { page } = l;
  await page
    .getByRole('region', { name: 'General', exact: true })
    .getByRole('button', { name: 'See what is new' })
    .click();
  const closed = new Promise((r) => l.app.process().once('exit', r));
  await page.getByRole('button', { name: 'Restart Stellio' }).click();
  await closed;
});

test('an install Stellio cannot replace offers only the release page', async () => {
  const other = await launchApp({ STELLIO_UPDATE_URL: url, APPIMAGE: '' });
  try {
    await other.page.getByRole('button', { name: 'See what is new' }).click();
    const dialog = other.page.getByRole('dialog', { name: 'Stellio 99.1.0' });
    await expect(dialog.getByText('This copy cannot update itself.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download and install' })).toHaveCount(0);
    await dialog.getByRole('link', { name: 'Release page' }).click();
    const opened = await other.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
    expect(opened).toEqual(['https://github.com/PraneethReddy-github/stellio/releases/tag/v99.1.0']);
  } finally {
    await other.close();
  }
});
