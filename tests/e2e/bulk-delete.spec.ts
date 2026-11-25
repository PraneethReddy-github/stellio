import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type Launched } from './helpers';
import { api, trackerEnv } from './trackerSeed';

let l: Launched;
let page: Page;
const go = (hash: string): Promise<void> =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
const axe = async (): Promise<void> => {
  const r = await new AxeBuilder({ page }).setLegacyMode().analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => v.id)).toEqual([]);
};

test.beforeAll(async () => {
  l = await launchApp(trackerEnv());
  page = l.page;
  const { ok, addJob, saveProfile } = api(l);
  await saveProfile();
  for (const [i, company] of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].entries()) {
    const id = await addJob(`${company} GmbH`, `Engineer ${company}`);
    if (i > 1) await ok('jobs:setState', { id, state: 'shortlisted' });
  }
});
test.afterAll(async () => {
  await l.close();
});

test('Workspace: no checkboxes until Select; Escape leaves; delete asks first and keeps the others', async () => {
  await go('/workspace');
  const grid = page.getByRole('grid', { name: 'Recent jobs' });
  await expect(grid.getByRole('row')).toHaveCount(6);
  await expect(grid.locator('[role=checkbox]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(grid.locator('[role=checkbox]')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Delete…' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(grid.locator('[role=checkbox]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await grid.getByRole('row', { name: /Alpha/ }).click();
  await grid.getByRole('row', { name: /Beta/ }).click();
  await expect(page).toHaveURL(/workspace$/); // a click selects, it does not open the job
  await expect(page.getByText('2 selected')).toBeVisible();
  await expect(grid.getByRole('row', { name: /Alpha/ })).toHaveAttribute('aria-selected', 'true');
  await axe();

  await page.getByRole('button', { name: 'Delete…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete 2 jobs?' });
  await page.keyboard.press('Escape'); // closes the dialog only
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByRole('button', { name: 'Delete…' }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Deleted 2 jobs').first()).toBeVisible();
  await expect(grid.getByRole('row')).toHaveCount(4);
  await expect(grid.locator('[role=checkbox]')).toHaveCount(0);
});

test('Applications table: keyboard selection, and a row hidden by a filter is never deleted', async () => {
  await go('/applications');
  await page.getByRole('tab', { name: 'Table' }).click();
  const grid = page.getByRole('grid', { name: 'Applications' });
  await expect(grid.getByRole('row')).toHaveCount(4);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await grid.getByRole('checkbox', { name: 'Select all' }).click();
  await expect(page.getByText('3 selected')).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search applications' }).fill('Gamma');
  await expect(page.getByText('1 selected')).toBeVisible();
  await grid.focus();
  await page.keyboard.press('Space');
  await expect(page.getByText('0 selected')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('1 selected')).toBeVisible();
  await axe();
  await page.getByRole('button', { name: 'Delete…' }).click();
  await page
    .getByRole('dialog', { name: 'Delete 1 job?' })
    .getByRole('button', { name: 'Delete', exact: true })
    .click();
  await expect(page.getByText('Deleted 1 job').last()).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search applications' }).fill('');
  await expect(grid.getByRole('row')).toHaveCount(3);
  await expect(grid.getByRole('row', { name: /Delta/ })).toBeVisible();
  await expect(grid.getByRole('row', { name: /Epsilon/ })).toBeVisible();
});
