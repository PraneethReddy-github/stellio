import http from 'node:http';
import type { AddressInfo } from 'node:net';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { launchApp, type Launched } from './helpers';

let server: http.Server;
let hits = 0;
let l: Launched;

test.beforeAll(async () => {
  server = http.createServer((_req, res) => {
    hits++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ tag_name: 'v99.0.0' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/latest`;
  l = await launchApp({ STELLIO_UPDATE_URL: url });
});
test.afterAll(async () => {
  await l.close();
  server.close();
});

test('a newer release shows a banner with a download link; dismiss is remembered; the check can be switched off', async () => {
  const { page } = l;
  const banner = page.getByRole('status').filter({ hasText: 'Stellio 99.0.0 is available.' });
  await expect(banner).toBeVisible();
  expect((await new AxeBuilder({ page }).include('#root').setLegacyMode().analyze()).violations).toEqual([]);
  await banner.getByRole('link', { name: 'Download' }).click();
  const opened = await l.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
  expect(opened).toEqual(['https://github.com/PraneethReddy-github/stellio/releases/tag/v99.0.0']);

  await banner.getByRole('button', { name: 'Dismiss update' }).click();
  await expect(banner).toHaveCount(0);
  await page.evaluate(() => {
    window.location.hash = '/settings';
  });
  const section = page.getByRole('region', { name: 'General', exact: true });
  const auto = section.getByRole('switch', { name: 'Check for updates automatically' });
  await expect(auto).toBeChecked();
  await auto.click();
  await expect(auto).not.toBeChecked();
  expect(hits).toBe(1);
  await section.getByRole('button', { name: 'Check now' }).click();
  await expect(section.getByText('Version 99.0.0 is available.')).toBeVisible();
  await expect.poll(() => hits).toBe(2);

  await page.reload();
  await expect(auto).not.toBeChecked();
  await expect(banner).toHaveCount(0);
});
