import { expect, test, type Page } from '@playwright/test';
import { launchApp, type Launched } from './helpers';
import { api, trackerEnv } from './trackerSeed';

// Regression: the first click on a lower row of a long, scrolled list opened row 1 instead.
// Mouse focus selected row 1 and scrolled the list back to the top, so the click was lost.
const N = 30;
let l: Launched;
let page: Page;
const go = (hash: string): Promise<void> =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);

test.beforeAll(async () => {
  l = await launchApp(trackerEnv());
  page = l.page;
  const { ok, addJob, saveProfile } = api(l);
  await saveProfile();
  for (let i = 1; i <= N; i++) {
    const id = await addJob(`Company ${String(i)} GmbH`, `Engineer ${String(i)}`);
    await ok('jobs:setState', { id, state: 'shortlisted' });
  }
});
test.afterAll(async () => {
  await l.close();
});

/** Scrolls the grid to the bottom and clicks its last row; returns that row's text. */
async function clickLastRow(name: string): Promise<string> {
  const grid = page.getByRole('grid', { name });
  await expect(grid.getByRole('row')).toHaveCount(N + 1);
  await grid.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const last = grid.getByRole('row').last();
  await expect(last).toBeInViewport();
  const text = (await last.innerText()).split('\n')[0] ?? '';
  expect(await grid.evaluate((el) => el.scrollTop)).toBeGreaterThan(0); // the list really scrolled
  await last.click();
  return text;
}

test('Workspace: a first click on a lower row opens that job', async () => {
  await go('/workspace');
  const picked = await clickLastRow('Recent jobs');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(picked);
});

test('Applications table: a first click on a lower row selects that row', async () => {
  await go('/applications');
  await page.getByRole('tab', { name: 'Table' }).click();
  const grid = page.getByRole('grid', { name: 'Applications' });
  await clickLastRow('Applications');
  await expect(grid.getByRole('row').last()).toHaveAttribute('aria-selected', 'true');
  await expect(grid.getByRole('row').nth(1)).toHaveAttribute('aria-selected', 'false');
});
