import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import type { InsightsSummary } from '../../src/shared/insights';
import { launchApp, type Launched } from './helpers';
import { SHOTS, api, trackerEnv } from './trackerSeed';

const go = (page: Page, hash: string): Promise<void> =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);

const RIGHT = {
  answer: 'Across your 7 applications, 43% got a reply.',
  numbers_used: [
    { label: 'applications sent', value: '7' },
    { label: 'reply rate', value: '43%' },
  ],
};
const WRONG = {
  answer: 'Across your 7 applications, 61% got a reply.',
  numbers_used: [
    { label: 'applications sent', value: '7' },
    { label: 'reply rate', value: '61%' },
  ],
};

async function withApp(env: Record<string, string>, body: (l: Launched) => Promise<void>): Promise<void> {
  const l = await launchApp(trackerEnv(env));
  try {
    await l.page.setViewportSize({ width: 1360, height: 860 });
    await body(l);
  } finally {
    await l.close();
  }
}

/**
 * Seven sent applications: five "Data Engineer" (a screening, a rejection, an interview, two without
 * an answer) and two "Platform Engineer" (too few for a rate).
 */
async function seedSent(l: Launched): Promise<void> {
  const { ok, addJob, saveProfile } = api(l);
  await saveProfile();
  const send = async (
    role: string,
    n: number,
    then?: { status: string; meta?: Record<string, unknown> },
  ): Promise<void> => {
    const jobId = await addJob(`Company ${String(n)}`, role);
    const app = await ok<{ id: string }>('apps:create', { jobId });
    await ok('apps:setStatus', {
      id: app.id,
      status: 'applied',
      meta: { force: true, forceReason: 'e2e seed' },
    });
    if (then) await ok('apps:setStatus', { id: app.id, status: then.status, meta: then.meta });
  };
  await send('Data Engineer', 1, { status: 'screening' });
  await send('Data Engineer', 2, { status: 'rejected', meta: { stage: 'before_interview' } });
  await send('Data Engineer', 3, { status: 'interviewing' });
  await send('Data Engineer', 4);
  await send('Data Engineer', 5);
  await send('Platform Engineer', 6);
  await send('Platform Engineer', 7);
}

test('fresh install: honest empty state; asking answers in code, without the model', async () => {
  await withApp({ FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK: JSON.stringify(RIGHT) }, async (l) => {
    const { page } = l;
    await go(page, '/insights');
    await expect(page.getByRole('heading', { name: 'Insights', level: 2 })).toBeVisible();
    await expect(page.getByText('No application sent in this window')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Segments' })).toHaveCount(0);

    await page.getByRole('textbox', { name: 'Your question' }).fill('What should I do next?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByText(/nothing to analyse yet/)).toBeVisible();
    // the answer came from code: no model run was recorded
    const runs = await api(l).ok<{ task: string }[]>('ai:runs', { limit: 20 });
    expect(runs.filter((r) => r.task === 'insights.ask')).toEqual([]);
  });
});

test('seeded: every number is the number insights:summary returns; small segments are greyed', async () => {
  await withApp({ FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK: JSON.stringify(RIGHT) }, async (l) => {
    const { page } = l;
    await seedSent(l);
    const s = await api(l).ok<InsightsSummary>('insights:summary', { window: '90d' });
    expect(s.totals).toMatchObject({ applications: 7, responses: 3, interviews: 1 });

    await go(page, '/insights');
    const totals = page.getByRole('region', { name: 'Totals' });
    await expect(totals.locator('dl', { hasText: 'Applications' }).locator('dd')).toHaveText('7');
    await expect(totals.locator('dl', { hasText: 'Reply rate' }).locator('dd')).toHaveText('43%');
    await expect(totals.locator('dl', { hasText: 'Interview rate' }).locator('dd')).toHaveText('14%');
    await expect(totals.locator('dl', { hasText: 'Ghosted' }).locator('dd')).toHaveText('—');
    await expect(page.getByText(/at least 30 days old \(0 so far\)/)).toBeVisible();

    // role family: 5 Data Engineer applications show rates, the 2 Platform Engineer ones do not
    const roles = page.getByRole('table', { name: 'Role family' });
    const de = roles.getByRole('row', { name: /Data engineering/ });
    await expect(de).toContainText('5');
    await expect(de).toContainText('60%');
    await expect(de).toContainText('20%');
    const pe = roles.getByRole('row', { name: /DevOps \/ platform/ });
    await expect(pe).toContainText('not enough data');
    await expect(pe).not.toContainText('%');
    // every dimension of the spec is there
    for (const t of [
      'Source',
      'Role family',
      'Seniority',
      'Fit score',
      'Remote type',
      'Cover letter',
      'Days since posting when applied',
    ])
      await expect(page.getByRole('table', { name: t })).toBeVisible();
    await expect(
      page.getByRole('table', { name: 'Source' }).getByRole('row', { name: /Pasted by you/ }),
    ).toContainText('7');

    // the window toggle: all time has the same seven
    await page.getByRole('radio', { name: 'All time' }).click();
    await expect(page.getByRole('radio', { name: 'All time' })).toBeChecked();
    const all = await api(l).ok<InsightsSummary>('insights:summary', { window: 'all' });
    await expect(totals.locator('dl', { hasText: 'Applications' }).locator('dd')).toHaveText(
      String(all.totals.applications),
    );
  });
});

test('ask: the answer shows the numbers it used; a wrong number is repaired once, then shown with a warning', async () => {
  // repair answers right
  await withApp(
    {
      FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK: JSON.stringify(WRONG),
      FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK_REPAIR: JSON.stringify(RIGHT),
    },
    async (l) => {
      const { page } = l;
      await seedSent(l);
      await go(page, '/insights');
      await page.getByRole('textbox', { name: 'Your question' }).fill('How is my search going?');
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      await expect(page.getByText(RIGHT.answer)).toBeVisible();
      await expect(page.getByRole('alert').filter({ hasText: 'could not be matched' })).toHaveCount(0);
      const used = page.getByLabel('Numbers used');
      await expect(used).toContainText('applications sent');
      await expect(used).toContainText('43%');
      const runs = await api(l).ok<{ task: string }[]>('ai:runs', { limit: 20 });
      expect(runs.filter((r) => r.task === 'insights.ask')).toHaveLength(2);
    },
  );
  // the repair is wrong too: the answer stays, with a warning
  await withApp({ FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK: JSON.stringify(WRONG) }, async (l) => {
    const { page } = l;
    await seedSent(l);
    await go(page, '/insights');
    await page.getByRole('button', { name: 'Which roles should I prioritize?' }).click();
    await expect(page.getByText(WRONG.answer)).toBeVisible();
    await expect(
      page.getByRole('alert').filter({ hasText: 'could not be matched to your data' }),
    ).toBeVisible();
    await expect(page.getByLabel('Numbers used')).toContainText('61%');
  });
});

test('a failed run is an error with a retry, not a silent blank', async () => {
  await withApp({ FAKE_CLAUDE_MODE_INSIGHTS_ASK: 'auth' }, async (l) => {
    const { page } = l;
    await seedSent(l);
    await go(page, '/insights');
    await page.getByRole('textbox', { name: 'Your question' }).fill('How is my search going?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByText(/not logged in/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

for (const theme of ['dark', 'light'] as const) {
  test(`axe, zero CSP errors and screenshots on Insights in the ${theme} theme`, async () => {
    const csp: string[] = [];
    await withApp({ FAKE_CLAUDE_OUTPUT_INSIGHTS_ASK: JSON.stringify(RIGHT) }, async (l) => {
      const { page } = l;
      page.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('Content Security Policy')) csp.push(m.text());
      });
      const axe = async (): Promise<void> => {
        await page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((a) => a.effect?.getTiming().iterations !== Infinity)
              .map((a) => a.finished.catch(() => undefined)),
          ),
        );
        const results = await new AxeBuilder({ page }).setLegacyMode().analyze();
        const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
      };
      await go(page, '/insights');
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await expect(page.getByText('No application sent in this window')).toBeVisible();
      await axe();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/insights-empty-${theme}.png` });

      await seedSent(l);
      await page.reload();
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.getByRole('textbox', { name: 'Your question' }).fill('Which roles should I prioritize?');
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      await expect(page.getByText(RIGHT.answer)).toBeVisible();
      await axe();
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/insights-${theme}.png`, fullPage: true });
    });
    expect(csp).toEqual([]);
  });
}
