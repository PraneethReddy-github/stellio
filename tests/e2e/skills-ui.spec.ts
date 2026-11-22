import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { goodContent } from '../fixtures/resume';
import { invoke, launchApp, type Launched } from './helpers';

const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const POSTING = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;
const SHOTS = process.env.SCREENSHOTS ? (process.env.SCREENSHOT_DIR ?? 'docs/screenshots/current') : null;

const jd = {
  ...sampleJd,
  requirements: [
    ...sampleJd.requirements,
    { text: 'dbt is a plus', kind: 'preferred' as const, skills: ['dbt'] },
  ],
};
const wording = {
  rows: [
    { skill: 'PostgreSQL', rationale: 'The posting never mentions it.', learn_estimate_hours: null },
    { skill: 'Airflow', rationale: 'Not asked for.', learn_estimate_hours: null },
    { skill: 'dbt', rationale: 'Preferred and not in your profile.', learn_estimate_hours: 24 },
  ],
};
const withDbt = { ...goodContent, skills: [{ category_label: 'Tools', skills: ['Python', 'SQL', 'dbt'] }] };

/** Every test gets its own app and data folder. Opens the Resume tab of an analysed job. */
async function withApp(
  generate: unknown,
  body: (l: Launched, jobId: string) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const l = await launchApp({
    STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
    ...(existsSync(TECTONIC) ? { STELLIO_TECTONIC_BIN: TECTONIC } : {}),
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(jd),
    FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(sampleAnalysis),
    FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(generate),
    FAKE_CLAUDE_OUTPUT_SKILLS_AUDIT: JSON.stringify(wording),
    ...env,
  });
  try {
    await l.page.setViewportSize({ width: 1360, height: 860 });
    await invoke(l.page, 'profile:save', {
      markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
      expectedHash: null,
    });
    const r = (await invoke(l.page, 'jobs:intakeText', { text: POSTING, requestId: randomUUID() })) as {
      data: { jobId: string };
    };
    await invoke(l.page, 'jobs:analyze', { id: r.data.jobId, requestId: randomUUID() });
    await l.page.evaluate((id) => {
      window.location.hash = `/workspace/${id}`;
    }, r.data.jobId);
    await l.page.getByRole('tab', { name: 'Resume' }).click();
    await body(l, r.data.jobId);
  } finally {
    await l.close();
  }
}

const profileText = async (page: Page): Promise<string> =>
  ((await invoke(page, 'profile:get')) as { data: { markdown: string } }).data.markdown;
const draftAndOpenSkills = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Draft resume' }).click();
  await expect(page.getByRole('region', { name: 'LaTeX source' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Skills' }).click();
  await expect(page.getByRole('grid', { name: 'Skill audit' })).toBeVisible({ timeout: 30_000 });
};
const auditRow = (page: Page, skill: string) =>
  page.getByRole('grid', { name: 'Skill audit' }).getByRole('row', { name: new RegExp(`^${skill}\\b`) });
const shot = async (page: Page, name: string, theme: string): Promise<void> => {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
};
const settled = (page: Page): Promise<unknown> =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  );
const axe = async (page: Page): Promise<void> => {
  await settled(page);
  const results = await new AxeBuilder({ page }).setLegacyMode().analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
};

test('audit after the draft: rows, recommendation, rationale and the labelled estimate', async () => {
  const csp: string[] = [];
  await withApp(goodContent, async ({ page }) => {
    page.on('console', (m) => {
      if (m.type() === 'error' && m.text().includes('Content Security Policy')) csp.push(m.text());
    });
    await draftAndOpenSkills(page);
    const pg = auditRow(page, 'PostgreSQL');
    await expect(pg).toContainText('Remove');
    await expect(pg).toContainText('The posting never mentions it.');
    await expect(auditRow(page, 'dbt')).toContainText('~24 h (estimate)');
    await expect(
      page.getByRole('toolbar', { name: 'Skill decisions' }).getByRole('button', { name: /^Keep/ }),
    ).toBeVisible();
  });
  expect(csp).toEqual([]);
});

test('Remove creates a new version without the skill and selects it (key R)', async () => {
  await withApp(goodContent, async ({ page }, jobId) => {
    await draftAndOpenSkills(page);
    await auditRow(page, 'PostgreSQL').click();
    await page.getByRole('grid', { name: 'Skill audit' }).focus();
    await page.keyboard.press('r');
    await expect(page.getByText('Removed PostgreSQL — v2', { exact: true })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Version' })).toHaveText(/^v2\b/);
    await expect(auditRow(page, 'PostgreSQL')).toHaveCount(0);
    const v2 = (await invoke(page, 'resume:get', { jobId, version: 2 })) as {
      data: { content: { skills: { skills: string[] }[] } };
    };
    expect(v2.data.content.skills.flatMap((g) => g.skills)).not.toContain('PostgreSQL');
  });
});

test('Learn adds a learning item; the Skills screen lists it and updates its status', async () => {
  await withApp(goodContent, async ({ page }) => {
    await draftAndOpenSkills(page);
    await auditRow(page, 'dbt').click();
    await page
      .getByRole('toolbar', { name: 'Skill decisions' })
      .getByRole('button', { name: /^Learn/ })
      .click();
    await expect(page.getByText('Added dbt to Learning', { exact: true })).toBeVisible();

    await page.keyboard.press('Control+k');
    await page.keyboard.type('Open skills');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Skills', level: 2 })).toBeVisible();
    await page.getByRole('tab', { name: 'Learning' }).click();
    const item = (): Locator =>
      page.getByRole('list', { name: 'Learning roadmap' }).getByRole('listitem').filter({ hasText: 'dbt' });
    await expect(item()).toContainText('~24 h (estimate)');
    await item().getByRole('combobox', { name: 'Status of dbt' }).click();
    await page.getByRole('option', { name: 'done' }).click();
    await expect(item().getByRole('button', { name: 'Mark learned' })).toBeVisible();
    await shot(page, 'skills-learning-done', 'light');

    // done is stored: it survives a reload
    await page.reload();
    await page.getByRole('tab', { name: 'Learning' }).click();
    await expect(item().getByRole('combobox', { name: 'Status of dbt' })).toContainText('done');
  });
});

const stretchJd = {
  ...sampleJd,
  requirements: [
    { text: 'Strong Python and SQL', kind: 'required' as const, skills: ['Python', 'SQL'] },
    { text: 'dbt for modelling', kind: 'required' as const, skills: ['dbt'] },
  ],
};
const stretchAnalysis = { ...sampleAnalysis, fit_score: 66, verdict: 'stretch' as const };
const resources = {
  resources: [
    { title: 'A course on dbt', url: 'https://example.com/dbt-course', kind: 'course', why: 'Hands on.' },
    {
      title: 'dbt documentation',
      url: 'https://docs.getdbt.com/',
      kind: 'official_docs',
      why: 'The reference.',
    },
  ],
};

test('Learning roadmap: ranked with "unlocks N jobs", what-if counts stretch jobs, resources only on request', async () => {
  const csp: string[] = [];
  await withApp(
    goodContent,
    async ({ page }) => {
      page.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('Content Security Policy')) csp.push(m.text());
      });
      // dbt (24 h, required by the one open stretch job) and Terraform (80 h, named by no job)
      const dbt = (await invoke(page, 'learning:add', { skill: 'dbt' })) as { data: { id: string } };
      await invoke(page, 'learning:update', { id: dbt.data.id, estHours: 24 });
      const tf = (await invoke(page, 'learning:add', { skill: 'Terraform' })) as { data: { id: string } };
      await invoke(page, 'learning:update', { id: tf.data.id, estHours: 80 });

      await page.goto(page.url().replace(/#.*$/, '#/skills'));
      await page.getByRole('tab', { name: 'Learning' }).click();
      const items = page.getByRole('list', { name: 'Learning roadmap' }).locator(':scope > li');
      await expect(items).toHaveCount(2);
      await expect(items.nth(0)).toContainText('dbt');
      await expect(items.nth(0)).toContainText(
        'dbt: required in 100% of your jobs, ~24 h (estimate) to working level, unlocks 1 job in your inbox.',
      );
      await expect(items.nth(0).getByLabel('Priority 5')).toBeVisible();
      await expect(items.nth(1)).toContainText('Terraform');
      await expect(items.nth(1)).toContainText('not named by your stored jobs');

      // what-if: dbt lifts the one stretch job (66 + 6) to apply
      const whatIf = page.getByRole('region', { name: 'What if' });
      await expect(whatIf).toContainText('Nothing picked.');
      await whatIf.getByRole('checkbox', { name: 'dbt' }).click();
      await expect(whatIf.getByRole('status')).toHaveText(
        'Learning dbt would move 1 of 1 stretch job to apply.',
      );
      await expect(whatIf.getByRole('list', { name: 'Jobs that would move to apply' })).toContainText(
        '66 → 72',
      );
      await whatIf.getByRole('checkbox', { name: 'dbt' }).click();
      await whatIf.getByRole('checkbox', { name: 'Terraform' }).click();
      await expect(whatIf.getByRole('status')).toHaveText(
        'Learning Terraform would move none of your 1 stretch job to apply.',
      );

      // resources are never fetched on their own: the button asks, per item
      const runs = async (): Promise<number> =>
        ((await invoke(page, 'ai:runs', { limit: 50 })) as { data: { task: string }[] }).data.filter(
          (r) => r.task === 'learning.resources',
        ).length;
      expect(await runs()).toBe(0);
      await expect(page.getByText('Suggested resources (from Claude, not verified)')).toHaveCount(0);
      await items.nth(0).getByRole('button', { name: 'Suggest resources' }).click();
      await expect(page.getByText('Suggested resources (from Claude, not verified)')).toBeVisible();
      const links = items.nth(0).getByRole('list', { name: 'Resources for dbt' }).getByRole('link');
      await expect(links.nth(0)).toHaveText('dbt documentation'); // official docs first
      await expect(links.nth(0)).toHaveAttribute('href', 'https://docs.getdbt.com/');
      await expect(links.nth(1)).toHaveText('A course on dbt');
      expect(await runs()).toBe(1);
      await expect(items.nth(1).getByRole('button', { name: 'Suggest resources' })).toBeVisible();
      await shot(page, 'skills-roadmap', 'light');
    },
    {
      FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(stretchJd),
      FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(stretchAnalysis),
      FAKE_CLAUDE_OUTPUT_LEARNING_RESOURCES: JSON.stringify(resources),
    },
  );
  expect(csp).toEqual([]);
});

test('Add to profile: the diff follows the form, confirm writes the profile and approves, regenerate keeps the skill', async () => {
  await withApp(withDbt, async ({ page }, jobId) => {
    await draftAndOpenSkills(page);
    const before = await profileText(page);
    await auditRow(page, 'dbt').click();
    await page
      .getByRole('toolbar', { name: 'Skill decisions' })
      .getByRole('button', { name: /^Add to profile/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Add dbt to your profile' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Fill in the level to see the change.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save to profile' }).click();
    await expect(dialog.getByText('Level must be a whole number from 1 to 5.')).toBeVisible();

    await dialog.getByLabel('Level').fill('2');
    await dialog.getByLabel('Years').fill('1');
    await dialog.getByLabel('Last used').fill('2026');
    await dialog.getByRole('checkbox', { name: /exp-globex/ }).click();
    const diff = dialog.getByRole('table', { name: 'Profile change' });
    await expect(diff.getByRole('columnheader', { name: 'Before' })).toBeVisible();
    await expect(diff.getByText(/added: .*dbt/)).toBeVisible();
    await expect(diff).toContainText('exp-globex');
    expect(await profileText(page)).toBe(before); // nothing is written before Save
    await shot(page, 'skills-add-dialog', 'dark');

    await dialog.getByRole('button', { name: 'Save to profile' }).click();
    const saved = page.getByRole('dialog', { name: 'dbt is in your profile' });
    await expect(saved).toBeVisible();
    expect(await profileText(page)).toContain('| dbt |');
    await saved.getByRole('button', { name: 'Regenerate with dbt' }).click();
    await expect(page.getByRole('combobox', { name: 'Version' })).toHaveText(/^v2\b/, { timeout: 60_000 });
    const v2 = (await invoke(page, 'resume:get', { jobId, version: 2 })) as {
      data: { content: { skills: { skills: string[] }[] }; checks: { truth: { ok: boolean } } };
    };
    expect(v2.data.checks.truth.ok).toBe(true);
    expect(v2.data.content.skills.flatMap((g) => g.skills)).toContain('dbt');
  });
});

test('a failed AI wording is a quiet note and the rows stay', async () => {
  await withApp(
    goodContent,
    async ({ page }) => {
      await draftAndOpenSkills(page);
      await expect(
        page.getByRole('status').filter({ hasText: 'Rationale and hour estimates are missing' }),
      ).toBeVisible();
      await expect(auditRow(page, 'PostgreSQL')).toContainText('Remove');
    },
    { FAKE_CLAUDE_MODE_SKILLS_AUDIT: 'nonzero_with_json' },
  );
});

test('Skills screen: ledger edit saves the profile; gaps learn, I have it and ignore', async () => {
  await withApp(goodContent, async ({ page }, jobId) => {
    await invoke(page, 'resume:generate', { jobId, requestId: randomUUID() });
    await page.goto(page.url().replace(/#.*$/, '#/skills'));
    const ledger = page.getByRole('grid', { name: 'Skill ledger' });
    await expect(ledger.getByRole('row', { name: /^Python/ })).toContainText('%');
    await ledger.getByRole('row', { name: /^Python/ }).click();
    const edit = page.getByRole('dialog', { name: 'Edit skill: Python' });
    await expect(edit.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await edit.getByLabel('Years').fill('9');
    await edit.getByRole('button', { name: 'Update skill' }).click();
    await expect(page.getByText('Saved Python', { exact: true })).toBeVisible();
    expect(await profileText(page)).toMatch(/\| Python \|[^\n]*\b9\b/);

    await page.getByRole('tab', { name: 'Gaps' }).click();
    const gaps = page.getByRole('grid', { name: 'Skill gaps' });
    const dbt = gaps.getByRole('row', { name: /^dbt/ });
    await expect(dbt).toBeVisible();
    await dbt.getByRole('button', { name: 'Learn' }).click();
    await expect(page.getByText('Added dbt to Learning', { exact: true })).toBeVisible();
    await expect(dbt.getByRole('button', { name: 'In Learning' })).toBeDisabled();

    await dbt.getByRole('button', { name: 'I have it' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add dbt to your profile' });
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Cancel' }).click();
    expect(await profileText(page)).not.toContain('| dbt |');

    await dbt.getByRole('button', { name: 'Ignore' }).click();
    await expect(gaps.getByRole('row', { name: /^dbt/ })).toHaveCount(0);
    await page.reload();
    await page.getByRole('tab', { name: 'Gaps' }).click();
    await expect(page.getByText('Nothing left to decide.')).toBeVisible();
  });
});

for (const theme of ['dark', 'light'] as const) {
  test(`axe and screenshots: skills panel, add dialog, Skills screen in the ${theme} theme`, async () => {
    const csp: string[] = [];
    await withApp(withDbt, async ({ page }, jobId) => {
      page.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('Content Security Policy')) csp.push(m.text());
      });
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await draftAndOpenSkills(page);
      await auditRow(page, 'dbt').click();
      await axe(page);
      await shot(page, 'skills-panel', theme);
      await page
        .getByRole('toolbar', { name: 'Skill decisions' })
        .getByRole('button', { name: /^Add to profile/ })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Add dbt to your profile' });
      await dialog.getByLabel('Level').fill('2');
      await expect(dialog.getByRole('table', { name: 'Profile change' })).toBeVisible();
      await axe(page);
      await shot(page, 'skills-add-dialog', theme);
      await dialog.getByRole('button', { name: 'Cancel' }).click();

      await invoke(page, 'skills:decide', { jobId, version: 1, skill: 'dbt', decision: 'learn' });
      await page.keyboard.press('Control+k');
      await page.keyboard.type('Open skills');
      await page.keyboard.press('Enter');
      for (const tab of ['Ledger', 'Gaps', 'Learning']) {
        await page.getByRole('tab', { name: tab }).click();
        await expect(
          tab === 'Learning'
            ? page.getByRole('list', { name: 'Learning roadmap' })
            : page.getByRole('grid').first(),
        ).toBeVisible();
        await axe(page);
        await shot(page, `skills-${tab.toLowerCase()}`, theme);
      }
    });
    expect(csp).toEqual([]);
  });
}
