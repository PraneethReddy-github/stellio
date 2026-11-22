import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { launchApp, type Launched } from './helpers';
import { SHOTS, api, localDate, seedTracker, trackerEnv, type Seeded } from './trackerSeed';

const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');

async function withApp(
  body: (l: Launched, a: ReturnType<typeof api>) => Promise<void>,
  extraEnv: Record<string, string> = {},
): Promise<void> {
  const l = await launchApp(trackerEnv(extraEnv));
  try {
    await l.page.setViewportSize({ width: 1360, height: 860 });
    await body(l, api(l));
  } finally {
    await l.close();
  }
}

const go = (page: Page, hash: string): Promise<void> =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
const lane = (page: Page, name: string): Locator => page.getByRole('region', { name, exact: true });
const card = (page: Page, company: string): Locator =>
  page.getByRole('button', { name: new RegExp(company) });
const clipboard = (l: Launched): Promise<string> => l.app.evaluate(({ clipboard: c }) => c.readText());

test('lifecycle through the UI: shortlist, draft, mark final, Apply tab, I applied, folder exists', async () => {
  test.setTimeout(90_000); // a real PDF compile

  await withApp(async (l, { ok, addJob, saveProfile }) => {
    const { page } = l;
    await saveProfile();
    const jobId = await addJob('Nimbus Analytics GmbH', 'Data Engineer');
    await go(page, `/workspace/${jobId}`);
    await expect(page.getByRole('heading', { name: 'Data Engineer', level: 2 })).toBeVisible();

    // shortlist = first status change: creates the application
    await expect(page.getByRole('button', { name: 'Status: Not started' })).toBeVisible();
    await page.getByRole('button', { name: /^Status:/ }).click();
    await page.getByRole('menuitem', { name: 'Saved' }).click();
    await expect(page.getByRole('button', { name: 'Status: Saved' })).toBeVisible();

    // drafting moves it to preparing; mark the version final
    await page.getByRole('tab', { name: 'Resume' }).click();
    await page.getByRole('button', { name: 'Draft resume' }).click();
    await expect(page.getByRole('region', { name: 'LaTeX source' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Status: Preparing' })).toBeVisible();
    await page.getByRole('button', { name: 'Mark final' }).click();
    await expect(page.getByRole('button', { name: 'Final', exact: true })).toBeVisible();

    // Apply tab: checklist and copy-ready fields
    await page.getByRole('tab', { name: 'Apply' }).click();
    const checklist = page.getByRole('region', { name: 'Checklist' });
    await expect(checklist.getByText('Version 1 is final')).toBeVisible();
    await expect(checklist.getByText('A cover letter is optional')).toBeVisible();
    const fields = page.getByRole('region', { name: 'Copy-ready fields' });
    await expect(fields.getByText('alex@example.test')).toBeVisible();
    await fields.getByRole('button', { name: 'Copy Email' }).click();
    await expect.poll(() => clipboard(l)).toBe('alex@example.test');
    await fields.getByRole('button', { name: 'Copy Notice period' }).click();
    await expect.poll(() => clipboard(l)).toBe('1 month');
    await expect(fields.getByRole('textbox', { name: 'Salary expectation' })).toHaveValue('60000 EUR');

    // I applied: the confirm explains the freeze
    await page.getByRole('button', { name: 'I applied' }).click();
    const dialog = page.getByRole('dialog', { name: 'Mark as applied?' });
    await expect(dialog).toContainText('never overwritten');
    await dialog.getByRole('button', { name: 'I applied' }).click();
    await expect(page.getByRole('button', { name: 'Status: Applied' })).toBeVisible();
    const folder = `applications/${localDate(new Date())}_nimbus-analytics-gmbh_data-engineer`;
    expect(readdirSync(join(l.dataDir, folder)).sort()).toEqual(
      existsSync(TECTONIC)
        ? ['analysis.json', 'jd.md', 'meta.json', 'resume.pdf', 'resume.tex']
        : ['analysis.json', 'jd.md', 'meta.json', 'resume.tex'],
    );
    await expect(page.getByRole('region', { name: 'Apply' }).getByText(folder)).toBeVisible();

    // Open folder goes through shell.openPath (stubbed)
    await l.app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __openedPaths: string[] };
      g.__openedPaths = [];
      shell.openPath = (p: string) => {
        g.__openedPaths.push(p);
        return Promise.resolve('');
      };
    });
    await page.getByRole('button', { name: 'Open folder' }).click();
    await expect
      .poll(() => l.app.evaluate(() => (globalThis as unknown as { __openedPaths: string[] }).__openedPaths))
      .toEqual([join(l.dataDir, folder)]);

    // it is on the board in the Applied lane, and the timeline shows it this week
    await go(page, '/applications');
    await expect(lane(page, 'Applied').getByRole('button', { name: /Nimbus Analytics GmbH/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await expect(
      page.getByRole('list', { name: 'Timeline, 12 weeks' }).getByRole('button', { name: /Applied.*Nimbus/ }),
    ).toBeVisible();
    expect(await ok('apps:forJob', { jobId })).toMatchObject({ status: 'applied', folderPath: folder });
  });
});

test('Apply tab without a final resume: the way to mark one, and a forced apply behind a second confirm', async () => {
  await withApp(async (l, { ok, addJob, saveProfile }) => {
    const { page } = l;
    await saveProfile();
    const jobId = await addJob('Nimbus Analytics GmbH', 'Data Engineer');
    await ok('jobs:setState', { id: jobId, state: 'shortlisted' });
    await go(page, `/workspace/${jobId}`);
    await page.getByRole('tab', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'I applied' }).click();
    await page
      .getByRole('dialog', { name: 'Mark as applied?' })
      .getByRole('button', { name: 'I applied' })
      .click();

    const blocked = page.getByRole('dialog', { name: 'No final resume' });
    await expect(blocked).toBeVisible();
    await expect(blocked.getByRole('button', { name: 'Mark a version final first' })).toBeVisible();
    await blocked.getByRole('button', { name: /Apply without a final resume/ }).click();
    const force = page.getByRole('dialog', { name: 'No final resume' });
    await expect(force.getByRole('button', { name: 'Apply anyway' })).toBeDisabled();
    await force.getByLabel('Why apply without a final resume?').fill('Applied through a referral form');
    await force.getByRole('button', { name: 'Apply anyway' }).click();
    await expect(page.getByRole('button', { name: 'Status: Applied' })).toBeVisible();
    const detail = await ok<{ frozen: { files: string[] } }>('tracker:get', {
      id: (await ok<{ id: string }>('apps:forJob', { jobId })).id,
    });
    expect(detail.frozen.files).toEqual(expect.arrayContaining(['jd.md', 'meta.json']));
    expect(detail.frozen.files).not.toContain('resume.tex');
  });
});

test('board: arrows move focus, digits set the status, a stage is asked for, Enter opens the page', async () => {
  await withApp(async (l, { ok }) => {
    const { page } = l;
    const s = await seedTracker(l);
    await go(page, '/applications');
    await expect(lane(page, 'Not applied').getByRole('button', { name: /Contoso Data AG/ })).toBeVisible();
    await expect(
      lane(page, 'In process').getByRole('button', { name: /Nimbus Analytics GmbH/ }),
    ).toBeVisible();
    await expect(lane(page, 'Closed').getByRole('button', { name: /Initech Systems/ })).toBeVisible();

    // the only card in the tab order is the first one; arrows move across lanes
    await card(page, 'Contoso').focus();
    await page.keyboard.press('ArrowRight');
    await expect(card(page, 'Nimbus')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(card(page, 'Contoso')).toBeFocused();

    // 6 = interviewing: no question, the card moves to In process and keeps the keyboard
    await page.keyboard.press('6');
    await expect(lane(page, 'In process').getByRole('button', { name: /Contoso Data AG/ })).toBeVisible();
    await expect(card(page, 'Contoso')).toBeFocused();
    expect(await ok('apps:forJob', { jobId: s.b.jobId })).toMatchObject({ status: 'interviewing' });

    // 9 = rejected asks at which stage
    await page.keyboard.press('9');
    const dialog = page.getByRole('dialog', { name: /rejected/ });
    await expect(dialog.getByRole('button', { name: 'Mark rejected' })).toBeDisabled();
    await dialog.getByRole('radio', { name: 'After an interview' }).click();
    await dialog.getByRole('button', { name: 'Mark rejected' }).click();
    await expect(lane(page, 'Closed').getByRole('button', { name: /Contoso Data AG/ })).toBeVisible();
    await expect(card(page, 'Contoso')).toBeFocused();

    // Enter opens the full page
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Analytics Engineer', level: 2 })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/applications/${s.b.appId}$`));
  });
});

test('table: filter, sort, saved view and CSV export', async () => {
  await withApp(async (l) => {
    const { page } = l;
    await seedTracker(l);
    await go(page, '/applications');
    await page.getByRole('tab', { name: 'Table' }).click();
    const grid = page.getByRole('grid', { name: 'Applications' });
    await expect(grid.getByRole('row')).toHaveCount(4); // header + three

    await page.getByRole('searchbox', { name: 'Search applications' }).fill('contoso');
    await expect(grid.getByRole('row')).toHaveCount(2);
    await expect(grid.getByRole('row').nth(1)).toContainText('Analytics Engineer');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(grid.getByRole('row')).toHaveCount(4);

    await page
      .getByRole('search')
      .getByRole('button', { name: /^Status/ })
      .click();
    await page.getByRole('checkbox', { name: 'Screening' }).click();
    await page.keyboard.press('Escape');
    await expect(grid.getByRole('row')).toHaveCount(2);
    await expect(grid.getByRole('row').nth(1)).toContainText('Nimbus Analytics GmbH');

    // save this view, reload, find it again
    await page.getByRole('button', { name: 'Views' }).click();
    await page.getByRole('menuitem', { name: 'Save current view…' }).click();
    await page.getByRole('dialog', { name: 'Save this view' }).getByLabel('Name').fill('Screening now');
    await page.getByRole('button', { name: 'Save view' }).click();
    await page.reload();
    await page.getByRole('tab', { name: 'Table' }).click();
    await expect(grid.getByRole('row')).toHaveCount(4);
    await page.getByRole('button', { name: 'Views' }).click();
    await page.getByRole('menuitem', { name: 'Screening now', exact: true }).click();
    await expect(grid.getByRole('row')).toHaveCount(2);
    await page.getByRole('button', { name: 'Clear filters' }).click();

    // sort by company, ascending, then descending
    await page.getByRole('button', { name: 'Company' }).click();
    await expect(page.getByRole('columnheader', { name: 'Company' })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    await expect(grid.getByRole('row').nth(1)).toContainText('Contoso Data AG');
    await page.getByRole('button', { name: 'Company' }).click();
    await expect(grid.getByRole('row').nth(1)).toContainText('Nimbus Analytics GmbH');

    // CSV through the stubbed save dialog
    const csvPath = join(l.sandbox, 'apps.csv');
    await l.app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: file });
    }, csvPath);
    await page.getByRole('button', { name: 'Export CSV' }).click();
    await expect(page.getByText('Exported 3 rows', { exact: true })).toBeVisible();
    const csv = readFileSync(csvPath, 'utf8');
    expect(csv).toContain('Company,Role,Status,Fit');
    expect(csv).toContain('Contoso Data AG,Analytics Engineer,saved');
    expect(csv).toContain('Nimbus Analytics GmbH,Data Engineer,screening');
  });
});

test('detail: timeline, rejected with a stage, interview and contact CRUD', async () => {
  await withApp(async (l, { ok }) => {
    const { page } = l;
    const s = await seedTracker(l);
    await ok('apps:note', { id: s.a.appId, text: 'Talked to the recruiter' });
    await go(page, `/applications/${s.a.appId}`);
    await expect(page.getByRole('heading', { name: 'Data Engineer', level: 2 })).toBeVisible();

    // overview: next action (follow up, since applied; screening has none, so the interview comes first), trail
    const trail = page.getByRole('region', { name: 'Timeline' });
    await expect(trail.getByText('Applied → Screening')).toBeVisible();
    await expect(trail.getByText('Preparing → Applied')).toBeVisible();
    await expect(trail.getByText('Documents frozen')).toBeVisible();
    await expect(trail.getByText('Talked to the recruiter')).toBeVisible();
    await page.getByLabel('Add a note to the timeline').fill('Sent my availability');
    await page.getByRole('button', { name: 'Add note' }).click();
    await expect(trail.getByText('Sent my availability')).toBeVisible();

    // interview: add a technical round, then change its outcome, then delete it
    await page.getByRole('tab', { name: 'Interviews' }).click();
    await expect(page.getByText('Round 1 · Screen')).toBeVisible();
    await page.getByRole('button', { name: 'Add interview' }).click();
    const add = page.getByRole('dialog', { name: 'Add interview' });
    await add.getByRole('combobox', { name: 'Kind' }).click();
    await page.getByRole('option', { name: 'Technical' }).click();
    await add.getByLabel('When').fill('2026-12-01T10:00');
    await add.getByRole('button', { name: 'Add interview' }).click();
    await expect(page.getByText('Round 2 · Technical')).toBeVisible();
    await expect(page.getByText('2026-12-01 10:00')).toBeVisible();
    await page
      .getByRole('listitem')
      .filter({ hasText: 'Round 2' })
      .getByRole('button', { name: 'Edit' })
      .click();
    const edit = page.getByRole('dialog', { name: 'Edit round 2' });
    await edit.getByRole('combobox', { name: 'Outcome' }).click();
    await page.getByRole('option', { name: 'Passed' }).click();
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('listitem').filter({ hasText: 'Round 2' })).toContainText('Passed');
    await page
      .getByRole('listitem')
      .filter({ hasText: 'Round 2' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('Round 2 · Technical')).toHaveCount(0);

    // contacts: add, then unlink
    await page.getByRole('tab', { name: 'Contacts' }).click();
    await expect(page.getByText('No contacts linked')).toBeVisible();
    await page.getByRole('button', { name: 'Add contact' }).click();
    const contact = page.getByRole('dialog', { name: 'Add contact' });
    await contact.getByLabel('Name').fill('Jo Recruiter');
    await contact.getByLabel('Email').fill('jo@nimbus.example.test');
    await contact.getByRole('button', { name: 'Add contact' }).click();
    await expect(page.getByText('Jo Recruiter')).toBeVisible();
    await page.getByRole('button', { name: 'Unlink' }).click();
    await expect(page.getByText('No contacts linked')).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Link a saved contact' })).toBeVisible();

    // documents and analysis snapshots
    await page.getByRole('tab', { name: 'Documents' }).click();
    await expect(page.getByText('resume.tex')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open folder' })).toBeVisible();
    await page.getByRole('tab', { name: 'Analysis' }).click();
    await expect(page.getByText('Fit when you applied')).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Fit' }).getByRole('meter', { name: 'Fit score' }),
    ).toHaveAttribute('aria-valuenow', '88');

    // rejected asks for the stage and records it
    await page.getByRole('tab', { name: 'Overview' }).click();
    await page.getByRole('button', { name: 'Status: Screening' }).click();
    await page.getByRole('menuitem', { name: 'Rejected' }).click();
    const reject = page.getByRole('dialog', { name: /rejected/ });
    await reject.getByRole('radio', { name: 'Before an interview' }).click();
    await reject.getByRole('button', { name: 'Mark rejected' }).click();
    await expect(page.getByRole('button', { name: 'Status: Rejected' })).toBeVisible();
    await expect(trail.getByText('Screening → Rejected')).toBeVisible();
    await expect(trail.getByText('Before an interview')).toBeVisible();
  });
});

test('timeline: this week holds the interview and the deadline, and a click opens the inspector', async () => {
  await withApp(async (l) => {
    const { page } = l;
    await seedTracker(l);
    await go(page, '/applications');
    await page.getByRole('tab', { name: 'Timeline' }).click();
    const tl = page.getByRole('list', { name: 'Timeline, 12 weeks' });
    await expect(tl.getByRole('button', { name: /Interview.*Nimbus/ })).toBeVisible();
    await expect(tl.getByRole('button', { name: /Deadline.*Contoso/ })).toBeVisible();
    await tl.getByRole('button', { name: /Deadline.*Contoso/ }).click();
    const inspector = page.getByRole('complementary', { name: 'Application' });
    await expect(inspector.getByText('Analytics Engineer')).toBeVisible();
    await inspector.getByRole('button', { name: 'Open details' }).click();
    await expect(page.getByRole('heading', { name: 'Analytics Engineer', level: 2 })).toBeVisible();
  });
});

for (const theme of ['dark', 'light'] as const) {
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
  const shot = async (page: Page, name: string): Promise<void> => {
    await settled(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
  };

  test(`axe and zero CSP errors: board, table, timeline, detail, Apply tab in the ${theme} theme`, async () => {
    const cspErrors: string[] = [];
    await withApp(async (l, { ok }) => {
      const { page } = l;
      page.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('Content Security Policy')) cspErrors.push(m.text());
      });
      const s: Seeded = await seedTracker(l);
      await ok('apps:note', { id: s.a.appId, text: 'Talked to the recruiter' });
      await ok('apps:contact:add', { applicationId: s.a.appId, name: 'Jo Recruiter', role: 'Recruiter' });
      await go(page, '/applications');
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);

      await expect(card(page, 'Nimbus')).toBeVisible();
      await card(page, 'Nimbus').click();
      await expect(page.getByRole('complementary', { name: 'Application' })).toBeVisible();
      await axe(page);
      await shot(page, 'board');

      await page.getByRole('tab', { name: 'Table' }).click();
      await expect(page.getByRole('grid', { name: 'Applications' }).getByRole('row')).toHaveCount(4);
      await axe(page);
      await shot(page, 'table');

      await page.getByRole('tab', { name: 'Timeline' }).click();
      await expect(page.getByRole('list', { name: 'Timeline, 12 weeks' })).toBeVisible();
      await axe(page);
      await shot(page, 'timeline');

      await go(page, `/applications/${s.a.appId}`);
      await expect(page.getByRole('heading', { name: 'Data Engineer', level: 2 })).toBeVisible();
      await expect(page.getByText('Documents frozen')).toBeVisible();
      await axe(page);
      await shot(page, 'application');
      await page.getByRole('tab', { name: 'Interviews' }).click();
      await page.getByRole('button', { name: 'Add interview' }).click();
      await axe(page);
      await page.keyboard.press('Escape');
      await page.getByRole('tab', { name: 'Contacts' }).click();
      await expect(page.getByText('Jo Recruiter')).toBeVisible();
      await axe(page);
      await page.getByRole('tab', { name: 'Analysis' }).click();
      await expect(
        page.getByRole('region', { name: 'Fit' }).getByRole('meter', { name: 'Fit score' }),
      ).toBeVisible();
      await axe(page);

      // Apply tab: not yet applied, no final resume, then the blocked confirmation
      await go(page, `/workspace/${s.b.jobId}`);
      await page.getByRole('tab', { name: 'Apply' }).click();
      await expect(
        page.getByRole('region', { name: 'Copy-ready fields' }).getByText('alex@example.test'),
      ).toBeVisible();
      await axe(page);
      await shot(page, 'apply');
      await page.getByRole('button', { name: 'I applied' }).click();
      await page
        .getByRole('dialog', { name: 'Mark as applied?' })
        .getByRole('button', { name: 'I applied' })
        .click();
      await expect(page.getByRole('dialog', { name: 'No final resume' })).toBeVisible();
      await axe(page);
      await page.getByRole('button', { name: /Apply without a final resume/ }).click();
      await axe(page);
      await page.keyboard.press('Escape');

      // status question dialog
      await page.getByRole('button', { name: /^Status:/ }).click();
      await page.getByRole('menuitem', { name: 'Not applying' }).click();
      await expect(page.getByRole('dialog', { name: 'Why are you not applying?' })).toBeVisible();
      await axe(page);
    });
    expect(cspErrors).toEqual([]);
  });
}
