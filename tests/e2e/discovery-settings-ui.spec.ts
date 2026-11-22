import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  allSourceRoutes,
  sourceUrlsEnv,
  startFixtureServer,
  type FixtureServer,
} from '../fixtures/discovery';
import { invoke, launchApp, type Launched } from './helpers';
import { SHOTS } from './trackerSeed';

const FAKE_SYSTEMCTL = resolve('tests/fixtures/fake-systemctl.mjs');
type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };
const SECRET = 'sekret-key-98765432';

let server: FixtureServer;
let l: Launched;
let page: Page;
const cfg = join(tmpdir(), `stellio-e2e-cfg-${randomUUID()}`);
const cspErrors: string[] = [];

const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
  const r = (await invoke(page, channel, input)) as Res<T>;
  if (!r.ok) throw new Error(`${channel}: ${r.error.message}`);
  return r.data;
};
const section = (name: string) => page.getByRole('region', { name, exact: true });
const openSettings = async (): Promise<void> => {
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Search profiles', level: 3 })).toBeVisible();
  // the pointer may rest over the rail, which then covers the content: move it into the page
  await page.mouse.move(2, 400);
  await page.mouse.move(900, 500, { steps: 6 });
};
const textbox = (name: string) => page.getByRole('textbox', { name, exact: true });

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  server = await startFixtureServer(allSourceRoutes());
  chmodSync(FAKE_SYSTEMCTL, 0o755);
  mkdirSync(cfg, { recursive: true });
  l = await launchApp({
    ...sourceUrlsEnv(server.base),
    XDG_CONFIG_HOME: cfg,
    STELLIO_SYSTEMCTL: FAKE_SYSTEMCTL,
    FAKE_SYSTEMCTL_LOG: join(cfg, 'systemctl.ndjson'),
  });
  page = l.page;
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('Content Security Policy')) cspErrors.push(m.text());
  });
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.evaluate(() => {
    window.location.hash = '/settings';
  });
  await openSettings();
});
test.afterAll(async () => {
  await l.close();
  await server.close();
  rmSync(cfg, { recursive: true, force: true });
});
test.afterEach(() => {
  expect(cspErrors).toEqual([]);
});

test('search profiles: create, edit, delete', async () => {
  const sec = section('Search profiles');
  await expect(sec.getByText('No search profile yet')).toBeVisible();

  await sec.getByRole('button', { name: 'New search profile' }).click();
  const dialog = page.getByRole('dialog', { name: 'New search profile' });
  // a profile needs a name
  await dialog.getByRole('button', { name: 'Save profile' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Give the profile a name.');
  await textbox('Name').fill('Germany + remote');
  await textbox('Roles').fill('Data Engineer, Analytics Engineer');
  await textbox('Locations').fill('Germany, Berlin');
  await textbox('Salary floor').fill('65000');
  await textbox('Currency').fill('EUR');
  await dialog.getByRole('checkbox', { name: 'senior' }).click();
  await dialog.getByRole('switch', { name: 'Remote is fine' }).click();
  await dialog.getByRole('button', { name: 'Save profile' }).click();
  await expect(dialog).toBeHidden();

  const row = sec.getByRole('row', { name: /Germany \+ remote/ });
  await expect(row).toContainText('Data Engineer, Analytics Engineer');
  await expect(row).toContainText('Germany, Berlin');
  const [saved] =
    await ok<{ id: string; roles: string[]; salaryFloor: number; seniority: string[]; remoteOk: boolean }[]>(
      'discovery:profiles',
    );
  expect(saved).toMatchObject({
    roles: ['Data Engineer', 'Analytics Engineer'],
    salaryFloor: 65000,
    seniority: ['senior'],
    remoteOk: false,
  });

  await row.getByRole('button', { name: 'Edit Germany + remote' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit search profile' });
  await expect(textbox('Name')).toHaveValue('Germany + remote');
  await textbox('Name').fill('Main search');
  await textbox('Salary floor').fill('');
  await edit.getByRole('button', { name: 'Save profile' }).click();
  await expect(edit).toBeHidden();
  await expect(sec.getByRole('row', { name: /Main search/ })).toBeVisible();
  const after = await ok<{ id: string; name: string; salaryFloor: number | null }[]>('discovery:profiles');
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ id: saved?.id, name: 'Main search', salaryFloor: null });

  // a second profile, then delete it behind a confirmation
  await sec.getByRole('button', { name: 'New search profile' }).click();
  await textbox('Name').fill('Temp');
  await page
    .getByRole('dialog', { name: 'New search profile' })
    .getByRole('button', { name: 'Save profile' })
    .click();
  await sec.getByRole('button', { name: 'Delete Temp' }).click();
  await page
    .getByRole('dialog', { name: 'Delete this search profile?' })
    .getByRole('button', { name: 'Delete profile' })
    .click();
  await expect(sec.getByRole('row', { name: /Temp/ })).toHaveCount(0);
  expect(await ok<unknown[]>('discovery:profiles')).toHaveLength(1);
});

test('sources: switch, and an Adzuna key that is never shown back', async () => {
  const sec = section('Sources');
  await expect(sec.getByRole('row')).toHaveCount(8); // header + 7 (the web search agent lives under Discovery)
  const remotive = sec.getByRole('switch', { name: 'Remotive' });
  await expect(remotive).toBeChecked();
  await remotive.click();
  await expect(remotive).not.toBeChecked();
  expect(
    (await ok<{ id: string; enabled: boolean }[]>('discovery:sources')).find((x) => x.id === 'remotive')
      ?.enabled,
  ).toBe(false);
  await remotive.click();
  await expect(remotive).toBeChecked();

  await expect(sec.getByRole('link', { name: 'developer.adzuna.com' })).toBeVisible();
  await sec.getByRole('button', { name: 'Set API key' }).click();
  const dialog = page.getByRole('dialog', { name: 'Adzuna API key' });
  await expect(dialog.getByLabel('App id')).toHaveAttribute('type', 'password');
  await expect(dialog.getByLabel('App key')).toHaveAttribute('type', 'password');
  await expect(dialog.getByRole('button', { name: 'Save key' })).toBeDisabled();
  await dialog.getByLabel('App id').fill('app12345');
  await dialog.getByLabel('App key').fill(SECRET);
  await dialog.getByRole('button', { name: 'Save key' }).click();
  await expect(dialog).toBeHidden();
  await expect(sec.getByText('Key saved')).toBeVisible();
  await expect(sec.getByRole('button', { name: 'Set API key' })).toHaveCount(0);
  // never echoed: not in the page, not in what the app hands the renderer
  expect(await page.content()).not.toContain(SECRET);
  expect(JSON.stringify(await ok('discovery:sources'))).not.toContain(SECRET);
  await openSettings();
  await expect(section('Sources').getByText('Key saved')).toBeVisible();
  expect(await page.content()).not.toContain(SECRET);

  await section('Sources').getByRole('button', { name: 'Clear the Adzuna key' }).click();
  await expect(section('Sources').getByRole('button', { name: 'Set API key' })).toBeVisible();
  expect(
    (await ok<{ id: string; keySet: boolean }[]>('discovery:sources')).find((x) => x.id === 'adzuna')?.keySet,
  ).toBe(false);
  await section('Sources').getByRole('button', { name: 'Set API key' }).click();
  await expect(page.getByLabel('App key')).toHaveValue('');
  await page.keyboard.press('Escape');
});

test('watchlist: add by careers URL (ATS detected), reject a bad URL, remove', async () => {
  const sec = section('Watchlist');
  await expect(sec.getByText('No companies watched')).toBeVisible();
  await textbox('Careers page URL').fill('acme.com/jobs');
  await sec.getByRole('button', { name: 'Add company' }).click();
  await expect(sec.getByText('Enter the careers page address')).toBeVisible();

  await textbox('Careers page URL').fill('https://boards.greenhouse.io/acme');
  await textbox('Company name (optional)').fill('Acme Corp');
  await sec.getByRole('button', { name: 'Add company' }).click();
  const row = sec.getByRole('row', { name: /Acme Corp/ });
  await expect(row).toContainText('Greenhouse · acme');
  await expect(row).toContainText('https://boards.greenhouse.io/acme');
  expect(await ok<{ atsType: string }[]>('discovery:watchlist')).toMatchObject([{ atsType: 'greenhouse' }]);

  // a board that does not exist is an exact error, not a silent add
  await textbox('Careers page URL').fill('https://boards.greenhouse.io/missing');
  await sec.getByRole('button', { name: 'Add company' }).click();
  await expect(sec.getByRole('alert').or(sec.locator('p[id$="-error"]'))).toBeVisible();
  expect(await ok<unknown[]>('discovery:watchlist')).toHaveLength(1);
  await textbox('Careers page URL').fill('');

  await row.getByRole('button', { name: 'Remove Acme Corp' }).click();
  await expect(sec.getByText('No companies watched')).toBeVisible();
});

test('schedule: the daily scan switch and time persist; the timer previews its unit files, installs and removes', async () => {
  const sec = section('Schedule');
  const daily = sec.getByRole('switch', { name: 'Scan once a day while Stellio is open' });
  await expect(daily).not.toBeChecked();
  await daily.click();
  await expect(daily).toBeChecked();
  await sec.getByLabel('Scan time').fill('07:45');
  await expect.poll(() => ok('discovery:schedule')).toEqual({ enabled: true, time: '07:45' });
  await openSettings();
  await expect(
    section('Schedule').getByRole('switch', { name: 'Scan once a day while Stellio is open' }),
  ).toBeChecked();
  await expect(section('Schedule').getByLabel('Scan time')).toHaveValue('07:45');

  const timer = section('Schedule');
  await expect(timer.getByText('Not installed')).toBeVisible();
  await timer.getByRole('button', { name: 'Install…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Install the scan timer' });
  const preview = await ok<{ timer: { path: string } }>('discovery:timerPreview');
  await expect(dialog).toContainText('OnCalendar=*-*-* 07:45:00');
  await expect(dialog).toContainText('--scan');
  await expect(dialog).toContainText(preview.timer.path);
  expect(existsSync(preview.timer.path)).toBe(false); // nothing is written before the confirmation
  await dialog.getByRole('button', { name: 'Install timer' }).click();
  await expect(dialog).toBeHidden();
  await expect(timer.getByText('Installed, active')).toBeVisible();
  await expect(timer.getByText('07:45', { exact: true })).toBeVisible();
  expect(readFileSync(preview.timer.path, 'utf8')).toContain('OnCalendar=*-*-* 07:45:00');
  expect(await ok('discovery:timerStatus')).toMatchObject({ installed: true, enabled: true, active: true });

  await timer.getByRole('button', { name: 'Remove', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Remove the timer?' })
    .getByRole('button', { name: 'Remove timer' })
    .click();
  await expect(timer.getByText('Not installed')).toBeVisible();
  expect(existsSync(preview.timer.path)).toBe(false);
  const log = readFileSync(join(cfg, 'systemctl.ndjson'), 'utf8');
  expect(log).toContain('["enable","--now","stellio-scan.timer"]');
  expect(log).toContain('["disable","--now","stellio-scan.timer"]');
});

test('discovery: web search switch with its cost note, thresholds and weights save and persist', async () => {
  const sec = section('Discovery');
  await expect(sec.getByText('It spends Claude usage on every scan')).toBeVisible();
  const web = sec.getByRole('switch', { name: 'Web search agent' });
  await expect(web).not.toBeChecked();
  await web.click();
  await expect(web).toBeChecked();
  expect(
    (await ok<{ id: string; enabled: boolean }[]>('discovery:sources')).find((x) => x.id === 'websearch')
      ?.enabled,
  ).toBe(true);
  await web.click();

  const save = sec.getByRole('button', { name: 'Save discovery settings' });
  await expect(save).toBeDisabled();
  await sec.getByLabel('Analysis threshold').fill('101');
  await expect(sec.getByRole('alert')).toContainText('out of range');
  await expect(save).toBeDisabled();
  await sec.getByLabel('Analysis threshold').fill('80');
  await sec.getByLabel('Analyses per day').fill('5');
  await sec.getByLabel('Recency', { exact: true }).fill('0.3');
  await save.click();
  await expect(save).toBeDisabled();
  expect(await ok('discovery:settings')).toMatchObject({
    analyzeThreshold: 80,
    maxAnalyzePerDay: 5,
    weights: { fit: 0.6, recency: 0.3 },
  });
  await openSettings();
  await expect(section('Discovery').getByLabel('Analysis threshold')).toHaveValue('80');
});

for (const theme of ['dark', 'light'] as const) {
  test(`axe and screenshots: every discovery section and dialog in the ${theme} theme`, async () => {
    // content for every section: a profile, a watched company, a saved key, an installed timer
    if ((await ok<unknown[]>('discovery:profiles')).length > 1) throw new Error('unexpected profiles');
    if ((await ok<unknown[]>('discovery:watchlist')).length === 0)
      await ok('discovery:watchAdd', {
        url: 'https://boards.greenhouse.io/acme',
        name: 'Acme Corp',
        requestId: randomUUID(),
      });
    await ok('discovery:setApiKey', { id: 'adzuna', appId: 'app12345', appKey: SECRET });
    await ok('discovery:timerInstall');
    await openSettings();
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await expect(section('Watchlist').getByRole('row', { name: /Acme Corp/ })).toBeVisible();
    await expect(section('Schedule').getByText('Installed, active')).toBeVisible();

    await settled();
    await axe();
    if (SHOTS)
      for (const id of ['profiles', 'sources', 'watchlist', 'schedule', 'discovery'])
        await page.locator(`#settings-${id}`).screenshot({ path: `${SHOTS}/settings-${id}-${theme}.png` });

    await section('Search profiles').getByRole('button', { name: 'New search profile' }).click();
    const profile = page.getByRole('dialog', { name: 'New search profile' });
    await expect(profile).toBeVisible();
    await settled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-profile-dialog-${theme}.png` });
    await axe();
    await page.keyboard.press('Escape');

    await section('Sources').getByRole('button', { name: 'Clear the Adzuna key' }).click();
    await section('Sources').getByRole('button', { name: 'Set API key' }).click();
    await expect(page.getByRole('dialog', { name: 'Adzuna API key' })).toBeVisible();
    await axe();
    await page.keyboard.press('Escape');

    await section('Schedule').getByRole('button', { name: 'Reinstall…' }).click();
    const unit = page.getByRole('dialog', { name: 'Install the scan timer' });
    await expect(unit).toContainText('OnCalendar');
    await settled();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-timer-dialog-${theme}.png` });
    await axe();
    await page.keyboard.press('Escape');
    await ok('discovery:timerRemove');
  });
}

async function settled(): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
}
async function axe(): Promise<void> {
  await settled();
  const results = await new AxeBuilder({ page }).setLegacyMode().analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}
