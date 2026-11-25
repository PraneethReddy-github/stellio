import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { coverPosting } from '../fixtures/cover';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { JOB_URL, TEAM_PAGE, goodMessage, jane, john } from '../fixtures/referrals';
import { invoke, launchApp, type Launched } from './helpers';
import { SHOTS } from './trackerSeed';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const DAY = 86_400_000;
type Res<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

const first = [jane(), john()];
const second = [
  jane(), // already found: must be asked to exclude and dropped
  john({
    full_name: 'Priya Sample',
    title: 'Analytics Engineer',
    profile_urls: ['https://www.linkedin.com/in/priya-sample-12'],
    facts: [{ text: 'Analytics Engineer at Nimbus Analytics', source_url: TEAM_PAGE }],
    why: 'Works on the analytics platform.',
  }),
];

let l: Launched;
let capture = '';
let jobId = '';
const cspErrors: string[] = [];

test.beforeAll(async () => {
  capture = join(mkdtempSync(join(tmpdir(), 'stellio-ref-')), 'capture.ndjson');
  l = await launchApp({
    STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_CAPTURE: capture,
    FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(sampleJd),
    FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
    FAKE_CLAUDE_OUTPUT_REFERRALS_SEARCH: JSON.stringify({ candidates: first }),
    FAKE_CLAUDE_OUTPUT_REFERRALS_MESSAGE: JSON.stringify(goodMessage(JOB_URL)),
  });
  await l.page.setViewportSize({ width: 1360, height: 900 });
  l.page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('Content Security Policy')) cspErrors.push(m.text());
  });
  const saved = await invoke(l.page, 'profile:save', {
    markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
    expectedHash: null,
  });
  expect(saved).toMatchObject({ ok: true });
  const r = (await invoke(l.page, 'jobs:intakeText', {
    text: coverPosting,
    url: JOB_URL,
    requestId: randomUUID(),
  })) as Res<{ jobId: string }>;
  if (!r.ok) throw new Error(r.error.message);
  jobId = r.data.jobId;
});
test.afterAll(async () => {
  await l.close();
  rmSync(join(capture, '..'), { recursive: true, force: true });
});

const ok = async <T>(channel: string, input?: unknown): Promise<T> => {
  const r = (await invoke(l.page, channel, input)) as Res<T>;
  if (!r.ok) throw new Error(`${channel}: ${r.error.code} ${r.error.message}`);
  return r.data;
};
const go = (hash: string): Promise<void> =>
  l.page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
const theme = (t: 'dark' | 'light'): Promise<void> =>
  l.page.evaluate((x) => {
    document.documentElement.dataset.theme = x;
  }, t);
const settled = (): Promise<unknown> =>
  l.page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
const axe = async (page: Page): Promise<void> => {
  await settled();
  const results = await new AxeBuilder({ page }).setLegacyMode().analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
};
const searchCalls = (): { stdin: string }[] =>
  readFileSync(capture, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((x) => JSON.parse(x) as { kind: string; stdin: string })
    .filter((r) => r.kind === 'call' && r.stdin.includes('<shared_ground>'));
const openTab = async (): Promise<void> => {
  await go(`/workspace/${jobId}`);
  await l.page.getByRole('tab', { name: 'Referrals' }).click();
};

test.describe.configure({ mode: 'serial' });

test('tab: boundary line, prefilled target, find people shows rows and the inspector shows sourced facts', async () => {
  const { page } = l;
  await openTab();
  await expect(
    page.getByText('Public sources only. Stellio never guesses emails or sends messages.'),
  ).toBeVisible();
  const form = page.getByRole('form', { name: 'Who to look for' });
  await expect(form.getByLabel('Company')).toHaveValue('Nimbus Analytics GmbH');
  await expect(form.getByLabel('Role')).toHaveValue('Data Engineer');
  await expect(page.getByText('No people yet')).toBeVisible();

  await form.getByRole('button', { name: 'Find people' }).click();
  const table = page.getByRole('grid', { name: 'People at the company' });
  await expect(table.getByRole('row', { name: /Jane Doe/ })).toBeVisible();
  await expect(table.getByRole('row', { name: /John Roe/ })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '2 people' })).toBeVisible();
  await expect(page.getByText('Found 2 people. Search for more?')).toBeVisible();
  await expect(page.getByText('Each search uses Claude usage.')).toBeVisible();

  await table.getByRole('row', { name: /Jane Doe/ }).click();
  const inspector = page.getByRole('complementary');
  await expect(inspector.getByRole('heading', { name: 'Jane Doe' })).toBeVisible();
  const facts = inspector.getByRole('region', { name: 'Facts and sources' });
  const fact = facts.getByRole('listitem').filter({ hasText: 'Spoke at the Berlin Data Meetup' });
  await expect(fact.getByRole('link')).toHaveAttribute(
    'href',
    'https://meetup-berlin.test/events/columnar-storage',
  );
  await expect(fact).toContainText('seen 20');
  await expect(
    inspector.getByRole('region', { name: 'Profile links' }).getByRole('link').first(),
  ).toHaveAttribute('target', '_blank');
  await expect(inspector.getByRole('region', { name: 'Shared ground' })).toContainText('Example University');
  await expect(inspector.getByRole('region', { name: 'Published contact' })).toContainText('None published');

  // external links go to the OS browser
  await inspector.getByRole('region', { name: 'Profile links' }).getByRole('link').first().click();
  await expect
    .poll(() => l.app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
    .toContain('https://www.linkedin.com/in/jane-doe-0a1b2c');
});

test('search more passes the people already found and appends only new ones', async () => {
  const { page } = l;
  await l.app.evaluate(
    (_, out) => {
      process.env.FAKE_CLAUDE_OUTPUT_REFERRALS_SEARCH = out;
    },
    JSON.stringify({ candidates: second }),
  );
  await page.getByRole('button', { name: 'Search more' }).click();
  const table = page.getByRole('grid', { name: 'People at the company' });
  await expect(table.getByRole('row', { name: /Priya Sample/ })).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(4); // header + 3
  await expect(page.getByText('Found 3 people. Search for more?')).toBeVisible();

  const calls = searchCalls();
  expect(calls).toHaveLength(2);
  expect(calls[0]?.stdin).not.toContain('<exclude>');
  expect(calls[1]?.stdin).toContain('<exclude>');
  expect(calls[1]?.stdin).toContain('name: Jane Doe');
  expect(calls[1]?.stdin).toContain('url: https://www.linkedin.com/in/jane-doe-0a1b2c');
});

test('draft message: note within the limit, copy buttons, clean checks stay quiet', async () => {
  const { page } = l;
  await page
    .getByRole('grid', { name: 'People at the company' })
    .getByRole('row', { name: /Jane Doe/ })
    .click();
  const inspector = page.getByRole('complementary');
  await inspector.getByRole('button', { name: 'Draft message' }).click();
  const message = inspector.getByRole('region', { name: 'Message' });
  await expect(message.getByText('Connection note')).toBeVisible();
  const counter = await message.getByText(/\d+ \/ 300 characters/).textContent();
  expect(Number(/(\d+) \//.exec(counter ?? '')?.[1])).toBeLessThanOrEqual(300);
  await expect(message).toContainText('Data Engineer role at Nimbus Analytics');
  await expect(message).toContainText('English');
  await expect(message.getByText('Rules and truth checks passed')).toBeVisible();
  await expect(message.getByRole('alert')).toHaveCount(0);

  await message.getByRole('button', { name: 'Copy connection note' }).click();
  await expect
    .poll(() => l.app.evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('May I message you');
  await message.getByRole('button', { name: 'Copy message' }).click();
  await expect.poll(() => l.app.evaluate(({ clipboard }) => clipboard.readText())).toContain(JOB_URL);
});

test('status contacted with a note; the follow-up shows in Today and on the screen after a clock shift', async () => {
  const { page } = l;
  const inspector = page.getByRole('complementary');
  const outreach = inspector.getByRole('region', { name: 'Outreach' });
  await outreach.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Contacted', exact: true }).click();
  await outreach.getByLabel('Note (optional)').fill('Sent on LinkedIn');
  await outreach.getByRole('button', { name: 'Save status' }).click();
  await expect(outreach).toContainText('follow up 20');
  await expect(outreach).toContainText('Sent on LinkedIn');
  expect(await ok<unknown[]>('referrals:due')).toEqual([]);

  // the app's clock moves 8 days ahead (main process only)
  await l.app.evaluate((_, ms) => {
    const Real = Date;
    globalThis.Date = class extends Real {
      constructor(...a: unknown[]) {
        if (a.length === 0) super(Real.now() + ms);
        else super(...(a as [number]));
      }
      static override now(): number {
        return Real.now() + ms;
      }
    } as DateConstructor;
  }, 8 * DAY);
  expect(
    (await ok<{ person: { fullName: string } }[]>('referrals:due')).map((i) => i.person.fullName),
  ).toEqual(['Jane Doe']);
  await go('/');
  await page.reload();
  const needs = page.getByRole('region', { name: 'Needs you' });
  await expect(needs).toContainText('Follow up with Jane D. about the referral');
  await expect(needs).toContainText('Data Engineer');
});

for (const t of ['dark', 'light'] as const) {
  test(`axe, screenshots and zero CSP errors on the tab in the ${t} theme`, async () => {
    const { page } = l;
    await openTab();
    await theme(t);
    const table = page.getByRole('grid', { name: 'People at the company' });
    await expect(table.getByRole('row', { name: /Jane Doe/ })).toBeVisible();
    await axe(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/referrals-tab-${t}.png` });
    await table.getByRole('row', { name: /Jane Doe/ }).click();
    await expect(page.getByRole('complementary').getByRole('region', { name: 'Message' })).toContainText(
      'Connection note',
    );
    await axe(page);
    if (SHOTS) {
      await page.screenshot({ path: `${SHOTS}/referrals-inspector-${t}.png` });
      await page.getByRole('complementary').getByRole('region', { name: 'Message' }).scrollIntoViewIfNeeded();
      await page
        .getByRole('complementary')
        .getByRole('region', { name: 'Outreach' })
        .scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/referrals-draft-${t}.png` });
    }
    await page.getByRole('complementary').getByRole('button', { name: 'Delete person' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await axe(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test(`axe, screenshots and zero CSP errors on the Referrals screen in the ${t} theme`, async () => {
    const { page } = l;
    await go('/referrals');
    await theme(t);
    await expect(page.getByRole('heading', { name: 'Referrals', level: 2 })).toBeVisible();
    const table = page.getByRole('grid', { name: 'All referral requests' });
    await expect(table.getByRole('row', { name: /Jane Doe/ })).toContainText('Contacted');
    await expect(table.getByRole('row', { name: /Jane Doe/ })).toContainText('(due)');
    await axe(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/referrals-screen-${t}.png` });
    await page.getByRole('button', { name: 'Delete all people' }).click();
    await expect(page.getByRole('dialog')).toContainText('This cannot be undone');
    await axe(page);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/referrals-delete-all-${t}.png` });
    await page.keyboard.press('Escape');
  });
}

test('referrals screen: filter by status, delete one person, retention persists, delete all', async () => {
  const { page } = l;
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Referrals' }).click();
  const table = page.getByRole('grid', { name: 'All referral requests' });
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('row', { name: /Jane Doe/ })).toContainText('Nimbus Analytics');
  await expect(table.getByRole('row', { name: /Jane Doe/ })).toContainText('Data Engineer');

  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Contacted', exact: true }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(page.getByText('1 follow-up due')).toBeVisible();
  await page.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'All statuses' }).click();

  // delete one person from the inspector
  await table.getByRole('row', { name: /Priya Sample/ }).click();
  await page.getByRole('button', { name: 'Delete person' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete person' }).click();
  await expect(table.getByRole('row', { name: /Priya Sample/ })).toHaveCount(0);
  expect(await ok<unknown[]>('referrals:list', {})).toHaveLength(2);

  // retention
  const retention = page.getByRole('form', { name: 'Retention' });
  await expect(retention.getByLabel(/Keep people you never contacted/)).toHaveValue('90');
  await retention.getByLabel(/Keep people you never contacted/).fill('0');
  await expect(retention.getByText('Enter a whole number from 1 to 3650.')).toBeVisible();
  await expect(retention.getByRole('button', { name: 'Save' })).toBeDisabled();
  await retention.getByLabel(/Keep people you never contacted/).fill('30');
  await retention.getByRole('button', { name: 'Save' }).click();
  await expect.poll(() => ok('referrals:settings')).toEqual({ retentionDays: 30 });
  await page.reload();
  await expect(
    page.getByRole('form', { name: 'Retention' }).getByLabel(/Keep people you never contacted/),
  ).toHaveValue('30');

  // delete all
  // multi-select: checkboxes only on demand; cancelling the confirm deletes nothing
  const people = page.getByRole('grid', { name: 'All referral requests' });
  await expect(people.locator('[role=checkbox]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await people.getByRole('checkbox', { name: 'Select all' }).click();
  await page.getByRole('button', { name: 'Delete…' }).click();
  await expect(page.getByRole('dialog')).toContainText('This cannot be undone');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await page.keyboard.press('Escape');
  await expect(people.locator('[role=checkbox]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Delete all people' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete all people' }).click();
  await expect(page.getByText('No people yet')).toBeVisible();
  expect(await ok<unknown[]>('referrals:list', {})).toEqual([]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/referrals-empty-dark.png` });
});

test('no CSP errors were logged', () => {
  expect(cspErrors).toEqual([]);
});
