import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const read = (rel: string): string => readFileSync(resolve('tests', rel), 'utf8');
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;

const fakeEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
  STELLIO_ALLOW_LOOPBACK_FETCH: '1', // tests only: the page server below is on 127.0.0.1
  FAKE_CLAUDE_MODE: 'ok',
  FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
  FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify({
    ...sampleAnalysis,
    matched: [
      { requirement: 'Strong Python and SQL', evidence_ids: ['exp-globex', 'exp-invented'], note: '5 years' },
    ],
  }),
  ...extra,
});

let server: http.Server;
let base: string;
test.beforeAll(async () => {
  const pages: Record<string, string> = {
    '/job': read('evals/jds/20-senior-data-engineer-remote-us.html'),
    '/login': read('fixtures/pages/login-wall.html'),
  };
  server = http.createServer((req, res) => {
    const body = pages[req.url ?? ''];
    if (body === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** Every test gets its own app and data folder, so no test depends on another. */
async function withApp(env: Record<string, string>, body: (l: Launched) => Promise<void>): Promise<void> {
  const l = await launchApp(fakeEnv(env));
  try {
    await l.page.setViewportSize({ width: 1360, height: 860 });
    // analysis needs a real profile: the seeded template has no skills or experience
    const saved = await invoke(l.page, 'profile:save', {
      markdown: read('fixtures/profiles/full.md'),
      expectedHash: null,
    });
    expect(saved).toMatchObject({ ok: true });
    await body(l);
  } finally {
    await l.close();
  }
}

const go = async (page: Page, hash: string): Promise<void> => {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
};

/** Adds the sample posting through IPC and opens its page. */
async function addJob(page: Page): Promise<string> {
  const r = (await invoke(page, 'jobs:intakeText', { text: POSTING, requestId: randomUUID() })) as {
    ok: true;
    data: { jobId: string };
  };
  await go(page, `/workspace/${r.data.jobId}`);
  await expect(page.getByRole('heading', { name: 'Data Engineer', level: 2 })).toBeVisible();
  return r.data.jobId;
}

const opened = (l: Launched): Promise<string[]> =>
  l.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);

test('paste text: the job page shows the parsed requirements', async () => {
  await withApp({}, async ({ page }) => {
    await go(page, '/workspace');
    await expect(page.getByText('No jobs yet')).toBeVisible();
    await page.getByRole('tab', { name: 'Paste text' }).click();
    await page.getByLabel('Job description').fill(POSTING);
    await page.getByRole('button', { name: 'Read job' }).click();
    await expect(page.getByText(/^Reading the job description with Claude · \d+ s$/)).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Data Engineer', level: 2 })).toBeVisible();
    await expect(page.getByText('Nimbus Analytics GmbH · Berlin')).toBeVisible();
    await expect(page.getByText('Hybrid', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Job details').getByText('EUR 65,000–80,000 / year')).toBeVisible();
    const required = page.getByRole('region', { name: 'Required requirements' });
    await expect(required.getByText('Strong Python and SQL')).toBeVisible();
    await expect(required.getByText('Python', { exact: true })).toBeVisible();
    await expect(page.getByText('Build pipelines')).toBeVisible();

    await page.getByRole('button', { name: 'Raw text' }).click();
    await expect(page.getByRole('textbox', { name: 'Job description text' })).toContainText(
      'Nimbus Analytics',
    );
  });
});

test('fetch from a link: opens the job, and the posting link goes to the OS browser', async () => {
  await withApp({}, async (l) => {
    const { page } = l;
    await go(page, '/workspace');
    await page.getByLabel('Posting URL').fill(`${base}/job`);
    await page.getByRole('button', { name: 'Fetch job' }).click();
    await expect(page.getByRole('heading', { name: 'Data Engineer', level: 2 })).toBeVisible();
    await page.getByRole('link', { name: 'View posting' }).click();
    await expect.poll(() => opened(l)).toEqual([`${base}/job`]);
  });
});

test('cut-off text: Paste full text replaces it; Fetch full text reads the posting page again', async () => {
  await withApp({}, async ({ page }) => {
    // pasted without a link: only Paste is offered
    const id = await addJob(page);
    const note = page.getByRole('status').filter({ hasText: 'The source sent only part of this posting' });
    await expect(note).toBeVisible();
    await expect(note.getByRole('button', { name: 'Fetch full text' })).toHaveCount(0);
    await note.getByRole('button', { name: 'Paste full text' }).click();
    const dialog = page.getByRole('dialog', { name: 'Paste full text' });
    await dialog.getByLabel('Posting text').fill('too short');
    await dialog.getByRole('button', { name: 'Save text' }).click();
    await expect(dialog.getByText('That text is too short to be the full posting.')).toBeVisible();
    await dialog
      .getByLabel('Posting text')
      .fill(`${POSTING}\n\n${'We offer flexible hours and a learning budget. '.repeat(12)}`);
    await dialog.getByRole('button', { name: 'Save text' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText('Full text saved').first()).toBeVisible();
    await expect(note).toHaveCount(0);
    await page.getByRole('button', { name: 'Raw text' }).click();
    await expect(page.getByRole('textbox', { name: 'Job description text' })).toContainText(
      'learning budget',
    );
    await invoke(page, 'jobs:delete', { id });

    // a snippet with a link: Fetch reads the page and keeps its longer text
    await go(page, '/workspace');
    await page.getByLabel('Posting URL').fill(`${base}/job`);
    await page.getByRole('button', { name: 'Fetch job' }).click();
    await expect(page.getByRole('heading', { name: 'Data Engineer', level: 2 })).toBeVisible();
    const fetched = page.url().split('/').pop() ?? '';
    const got = (await invoke(page, 'jobs:get', { id: fetched })) as {
      ok: true;
      data: { job: { descriptionMd: string } };
    };
    const full = got.data.job.descriptionMd;
    await invoke(page, 'jobs:delete', { id: fetched });
    const snippet = (await invoke(page, 'jobs:intakeText', {
      text: `${full.slice(0, 300)}…`,
      url: `${base}/job`,
      requestId: randomUUID(),
    })) as { ok: true; data: { jobId: string } };
    await go(page, `/workspace/${snippet.data.jobId}`);
    await note.getByRole('button', { name: 'Fetch full text' }).click();
    await expect(page.getByText('Full text saved').first()).toBeVisible({ timeout: 30_000 });
    await expect(note).toHaveCount(0);
  });
});

test('needs text: the paste tab opens with the reason and the link prefilled', async () => {
  await withApp({}, async ({ page }) => {
    await go(page, '/workspace');
    await page.getByLabel('Posting URL').fill(`${base}/login`);
    await page.getByRole('button', { name: 'Fetch job' }).click();
    await expect(page.getByRole('tab', { name: 'Paste text' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('status').filter({ hasText: /sign-in/ })).toBeVisible();
    await expect(page.getByLabel('Posting URL (optional)')).toHaveValue(`${base}/login`);
    await page.getByLabel('Job description').fill(POSTING);
    await page.getByRole('button', { name: 'Read job' }).click();
    await expect(page.getByRole('heading', { name: 'Data Engineer', level: 2 })).toBeVisible();
  });
});

test('duplicate: says so and opens the existing job', async () => {
  await withApp({}, async ({ page }) => {
    const id = await addJob(page);
    await go(page, '/workspace');
    await page.getByRole('tab', { name: 'Paste text' }).click();
    await page.getByLabel('Job description').fill(POSTING);
    await page.getByRole('button', { name: 'Read job' }).click();
    await expect(page.getByText('Already in your jobs', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Data Engineer', level: 2 })).toBeVisible();
    expect(page.url()).toContain(id);
  });
});

test('recent jobs: the row opens the job', async () => {
  await withApp({}, async ({ page }) => {
    await addJob(page);
    await go(page, '/workspace');
    const row = page.getByRole('grid', { name: 'Recent jobs' }).getByRole('row', { name: /Data Engineer/ });
    await expect(row).toContainText('Nimbus Analytics GmbH');
    await row.click();
    await expect(page.getByRole('tab', { name: 'Fit' })).toBeVisible();
  });
});

test('analyze: the Fit tab shows score, verdict, matched evidence and the dropped-id note', async () => {
  await withApp({ FAKE_CLAUDE_DELAY_MS_JOB_ANALYZE: '1200' }, async ({ page }) => {
    await addJob(page);
    await page.getByRole('button', { name: 'Analyze fit' }).click();
    await expect(page.getByText(/^Analyzing fit with Claude · \d+ s$/)).toBeVisible();

    const meter = page.getByRole('meter', { name: 'Fit score' });
    await expect(meter).toHaveAttribute('aria-valuenow', '88');
    // score and verdict are each shown once: the number in the Stat, the verdict in the header tag
    await expect(page.getByLabel('Job details').getByText('Apply · 88')).toBeVisible();
    await expect(page.getByRole('tabpanel').getByText('Apply', { exact: true })).toHaveCount(0);
    await expect(meter.getByText('88')).toHaveCount(0);
    await expect(page.getByText('Meets all required items.')).toBeVisible();
    await expect(page.getByText('Strong Python and SQL — 5 years')).toBeVisible();
    // the evidence id resolves to the profile entry's title on hover
    await expect(page.locator('span[title]').filter({ hasText: 'exp-globex' })).toHaveAttribute(
      'title',
      /\S/,
    );
    await expect(page.getByText('1 cited item was not in your profile and was removed.')).toBeVisible();
    await expect(page.getByText(/dropped unknown evidence id/)).toHaveCount(0);
    await expect(page.getByText('dbt')).toBeVisible();
    await expect(page.getByText('Airflow ownership')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Re-analyze' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Analyze fit' })).toHaveCount(0);
  });
});

test('profile changed since the analysis: banner with Re-analyze', async () => {
  await withApp({}, async ({ page }) => {
    const id = await addJob(page);
    await invoke(page, 'jobs:analyze', { id, requestId: randomUUID() });
    const snap = (await invoke(page, 'profile:get')) as {
      ok: true;
      data: { markdown: string; hash: string };
    };
    await invoke(page, 'profile:save', {
      markdown: `${snap.data.markdown}\nMore.\n`,
      expectedHash: snap.data.hash,
    });
    await page.reload();
    await page.getByRole('tab', { name: 'Fit' }).click();
    await expect(page.getByText('Profile changed since this analysis.')).toBeVisible();
    await page.getByRole('status').getByRole('button', { name: 'Re-analyze' }).click();
    await expect(page.getByText('Profile changed since this analysis.')).toHaveCount(0);
  });
});

test('cancel during analyze: nothing is stored and the tab stays usable', async () => {
  await withApp({ FAKE_CLAUDE_MODE_JOB_ANALYZE: 'hang' }, async ({ page }) => {
    await addJob(page);
    await page.getByRole('button', { name: 'Analyze fit' }).click();
    await expect(page.getByText(/^Analyzing fit with Claude/)).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(page.getByText('No fit analysis yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Analyze fit' })).toBeEnabled();
  });
});

test('cancel during intake: back to the form with the text kept', async () => {
  await withApp({ FAKE_CLAUDE_MODE_JD_PARSE: 'hang' }, async ({ page }) => {
    await go(page, '/workspace');
    await page.getByRole('tab', { name: 'Paste text' }).click();
    await page.getByLabel('Job description').fill(POSTING);
    await page.getByRole('button', { name: 'Read job' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Job description')).toHaveValue(POSTING);
    await expect(page.getByText('No jobs yet')).toBeVisible();
  });
});

test('a failed read shows the message and a retry', async () => {
  await withApp({ FAKE_CLAUDE_MODE_JD_PARSE: 'nonzero_with_json' }, async ({ page }) => {
    await go(page, '/workspace');
    await page.getByRole('tab', { name: 'Paste text' }).click();
    await page.getByLabel('Job description').fill(POSTING);
    await page.getByRole('button', { name: 'Read job' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not add the job' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test('status menu drives the application: first change creates it, undo goes back, not applying asks why', async () => {
  await withApp({}, async ({ page }) => {
    await addJob(page);
    await page.getByRole('button', { name: 'Status: Not started' }).click();
    await page.getByRole('menuitem', { name: 'Saved' }).click();
    await expect(page.getByRole('button', { name: 'Status: Saved' })).toBeVisible();
    await page.getByRole('button', { name: /^Status:/ }).click();
    await page.getByRole('menuitem', { name: 'Preparing' }).click();
    await expect(page.getByRole('button', { name: 'Status: Preparing' })).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Status: Saved' })).toBeVisible();

    await page.getByRole('button', { name: /^Status:/ }).click();
    await page.getByRole('menuitem', { name: 'Not applying' }).click();
    const dialog = page.getByRole('dialog', { name: 'Why are you not applying?' });
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();
    await dialog.getByLabel('Reason').fill('Relocation required');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('button', { name: 'Status: Not applying' })).toBeVisible();
  });
});

test('delete: confirm, then back to an empty workspace', async () => {
  await withApp({}, async ({ page }) => {
    await addJob(page);
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^Status:/ }).click();
    await page.getByRole('menuitem', { name: 'Delete job' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText('No jobs yet')).toBeVisible();
    expect(await invoke(page, 'jobs:list', { limit: 10, offset: 0 })).toMatchObject({ data: { total: 0 } });
  });
});

test('the Apply tab offers to start the application when there is none', async () => {
  await withApp({}, async ({ page }) => {
    await addJob(page);
    await page.getByRole('tab', { name: 'Apply' }).click();
    await expect(page.getByText('No application yet')).toBeVisible();
    await page.getByRole('button', { name: 'Start application' }).click();
    await expect(page.getByRole('region', { name: 'Checklist' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Mark a version final first' })).toBeVisible();
  });
});

test('palette: New job from link and Analyze fit', async () => {
  await withApp({}, async ({ page }) => {
    await addJob(page);
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Analyze fit');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('meter', { name: 'Fit score' })).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.keyboard.type('Paste a job');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'Paste text' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Job description')).toBeFocused();
  });
});

test('usage limit: a banner, dismissible', async () => {
  await withApp({ FAKE_CLAUDE_MODE_JD_PARSE: 'usage_limit' }, async ({ page }) => {
    await go(page, '/workspace');
    await page.getByRole('tab', { name: 'Paste text' }).click();
    await page.getByLabel('Job description').fill(POSTING);
    await page.getByRole('button', { name: 'Read job' }).click();
    const banner = page.getByRole('status').filter({ hasText: 'Claude usage limit reached' });
    await expect(banner).toContainText(
      /usage limit · resets 5pm \(UTC\)\. Background tasks pause until it resets\./,
    );
    await banner.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner).toHaveCount(0);
  });
});

// Both themes: intake, job tab, fit tab.
for (const theme of ['dark', 'light'] as const) {
  for (const scene of ['intake', 'job', 'fit'] as const) {
    test(`axe: ${scene} in the ${theme} theme`, async () => {
      await withApp({}, async ({ page }) => {
        await page.evaluate((t) => {
          document.documentElement.dataset.theme = t;
        }, theme);
        if (scene === 'intake') {
          await addJob(page);
          await go(page, '/workspace');
          await expect(page.getByRole('grid', { name: 'Recent jobs' })).toBeVisible();
        } else {
          const id = await addJob(page);
          if (scene === 'fit') {
            await invoke(page, 'jobs:analyze', { id, requestId: randomUUID() });
            await page.reload();
            await page.getByRole('tab', { name: 'Fit' }).click();
            await expect(page.getByRole('meter', { name: 'Fit score' })).toBeVisible();
          }
        }
        // Axe reads colours mid-animation otherwise.
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
    });
  }
}
