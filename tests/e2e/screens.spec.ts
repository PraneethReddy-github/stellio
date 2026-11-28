import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, type Page } from '@playwright/test';
import { sampleAnalysis, sampleJd } from '../fixtures/jobs';
import { badContent, goodContent } from '../fixtures/resume';
import { invoke, launchApp, type Launched } from './helpers';

// Captures review screenshots of every screen in both themes (docs/12 §4.8).
// Run: SCREENSHOTS=1 SCREENSHOT_DIR=docs/screenshots/<phase> npm run e2e -- screens
test.skip(!process.env.SCREENSHOTS, 'screenshots only on demand');

const TECTONIC = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const FAKE_CLAUDE = resolve('tests/fixtures/fake-claude/claude.mjs');
const RESUME_PDF = resolve('tests/fixtures/resumes/jordan-vale.pdf');
const importOutput = {
  front: {
    name: 'Jordan Vale',
    headline: 'Data Engineer',
    email: 'jordan@example.com',
    phone: '',
    location: 'Leipzig, Germany',
    links: { linkedin: '', github: '', portfolio: '' },
    work_authorization: '',
    notice_period: '',
    languages_spoken: [],
  },
  summary: 'Data engineer.',
  skills: [],
  experience: [
    { id: 'exp-brightwater', title: 'Data Engineer — Brightwater', meta: {}, bullets: ['Built pipelines.'] },
  ],
  projects: [],
  education: [],
  certifications: [],
  awards: [],
  publications: [],
  notes: '',
};

const jdOutput = {
  ...sampleJd,
  requirements: [
    { text: 'Strong Python and SQL', kind: 'required', skills: ['Python', 'SQL'] },
    { text: 'Experience running Airflow in production', kind: 'required', skills: ['Airflow'] },
    { text: 'dbt or similar transformation tooling', kind: 'preferred', skills: ['dbt'] },
  ],
  responsibilities: ['Build and run batch and streaming pipelines', 'Own data quality checks'],
  about: 'Nimbus Analytics builds forecasting tools for energy retailers.',
  benefits: ['30 days of leave', 'Learning budget'],
};
const analysisOutput = {
  ...sampleAnalysis,
  matched: [
    { requirement: 'Strong Python and SQL', evidence_ids: ['exp-globex'], note: '5 years across two roles' },
    {
      requirement: 'Experience running Airflow in production',
      evidence_ids: ['exp-globex', 'exp-invented'],
      note: '',
    },
  ],
  missing_skills: [
    { skill: 'dbt', importance: 'preferred', have_adjacent: 'SQL-based modelling in Snowflake' },
    { skill: 'Kubernetes', importance: 'required' },
  ],
  missing_experience: ['No streaming work at the stated scale'],
  red_flags: ['Salary band is wide for the seniority asked'],
};

const WIDTH = 1360;
const HEIGHT = 860;
const MAX_HEIGHT = 5000;
const dir = process.env.SCREENSHOT_DIR ?? 'docs/screenshots/current';

let l: Launched;
let seed: string;
test.beforeAll(async () => {
  l = await launchApp({
    STELLIO_TECTONIC_BIN: TECTONIC,
    STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT: '{"ok":true}', // the login check in Settings
    FAKE_CLAUDE_OUTPUT_PROFILE_IMPORT: JSON.stringify(importOutput),
    FAKE_CLAUDE_DELAY_MS: '3000',
    // Phase 4 scenes: richer job and analysis, no delay
    FAKE_CLAUDE_DELAY_MS_JD_PARSE: '0',
    FAKE_CLAUDE_DELAY_MS_JOB_ANALYZE: '0',
    FAKE_CLAUDE_OUTPUT_JD_PARSE: JSON.stringify(jdOutput),
    FAKE_CLAUDE_OUTPUT_JOB_ANALYZE: JSON.stringify(analysisOutput),
    // Phase 5 scenes: a good draft; revisions are blocked by an invented number, slowly enough to catch the running state
    FAKE_CLAUDE_DELAY_MS_RESUME_GENERATE: '0',
    FAKE_CLAUDE_OUTPUT_RESUME_GENERATE: JSON.stringify(goodContent),
    FAKE_CLAUDE_DELAY_MS_RESUME_REVISE: '2500',
    FAKE_CLAUDE_OUTPUT_RESUME_REVISE: JSON.stringify(badContent),
    FAKE_CLAUDE_OUTPUT_RESUME_REVISE_REPAIR: JSON.stringify(badContent),
  });
  await l.app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] });
  }, RESUME_PDF);
  await l.page.setViewportSize({ width: WIDTH, height: HEIGHT });
  seed = readFileSync(join(l.dataDir, 'profile/profile.md'), 'utf8');
});
test.afterAll(async () => {
  await l.close();
});

/** Same profile and a fresh page for every capture, so scenes never leak into each other. */
async function open(page: Page, hash: string): Promise<void> {
  await invoke(page, 'profile:save', { markdown: seed, expectedHash: null, message: 'screens: reset' });
  await page.setViewportSize({ width: WIDTH, height: HEIGHT });
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await page.reload();
  await page.waitForTimeout(500);
}

/** Full page: grows the window until the scroll region fits, so the image is exactly the content. */
async function shotFull(page: Page, path: string, scroller: string): Promise<void> {
  const grow = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
  }, scroller);
  if (grow > 0) {
    await page.setViewportSize({ width: WIDTH, height: Math.min(HEIGHT + grow, MAX_HEIGHT) });
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path });
}

interface Scene {
  name: string;
  hash: string;
  /** Leave the page in the state to capture. */
  prepare?: (page: Page) => Promise<void>;
  /** Overlays are fixed, so they are captured at window size. */
  overlay?: boolean;
  /** The element that scrolls and decides the cropped height. Default: the main area. */
  scroller?: string;
}

/** Full profile, one job and its analysis; returns the job id. Reruns are duplicates, so the id is stable. */
async function seedJob(page: Page): Promise<string> {
  await invoke(page, 'profile:save', {
    markdown: readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'),
    expectedHash: null,
    message: 'screens: job profile',
  });
  const posting = `Data Engineer (m/w/d) at Nimbus Analytics GmbH in Berlin. ${'Build pipelines in Python and SQL. '.repeat(5)}`;
  const intake = (await invoke(page, 'jobs:intakeText', { text: posting, requestId: randomUUID() })) as {
    data: { jobId: string };
  };
  await invoke(page, 'jobs:analyze', { id: intake.data.jobId, requestId: randomUUID() });
  return intake.data.jobId;
}

const openJob = async (page: Page): Promise<void> => {
  const id = await seedJob(page);
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `/workspace/${id}`);
  await page.reload();
  await page.getByRole('tab', { name: 'Fit' }).waitFor();
};

type Res<T> = { ok: true; data: T };
/** A job with no resume versions: the posting is a duplicate on reruns, so delete it first. Returns the page's hash. */
async function freshJob(page: Page): Promise<string> {
  const id = await seedJob(page);
  await invoke(page, 'jobs:delete', { id });
  return seedJob(page);
}
const resumeCall = (page: Page, channel: string, input: unknown): Promise<unknown> =>
  invoke(page, channel, { requestId: randomUUID(), ...(input as object) });
/** Opens the job's Resume tab; `ready` waits for what the scene shows. */
async function openResume(page: Page, id: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, `/workspace/${id}`);
  await page.reload();
  await page.getByRole('tab', { name: 'Resume' }).click();
}
const drafted = async (page: Page): Promise<string> => {
  const id = await freshJob(page);
  await resumeCall(page, 'resume:generate', { jobId: id });
  return id;
};
const pdfDrawn = (page: Page): Promise<unknown> =>
  page.getByRole('img', { name: 'PDF preview, page 1' }).waitFor({ timeout: 15_000 });

const tab = (name: string) => async (page: Page) => {
  await page.getByRole('tab', { name }).click();
  await page.waitForTimeout(300);
};

/** Rules scenes start from the seed files, whatever an earlier scene saved. */
async function seedRules(page: Page, ...edits: [string, string][]): Promise<void> {
  for (const f of ['rules/resume.md', 'templates/resume.tex'])
    await invoke(page, 'rules:save', {
      path: f,
      content: readFileSync(`seed/${f}`, 'utf8'),
      expectedHash: null,
      message: 'screens: reset',
    });
  for (const [path, content] of edits)
    await invoke(page, 'rules:save', { path, content, expectedHash: null, message: 'rules: edit resume.md' });
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? '');
  await page.reload(); // reloading resets the theme to the stored preference
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(500);
}
const resumeMd = (): string => readFileSync('seed/rules/resume.md', 'utf8');

const scenes: Scene[] = [
  { name: 'today', hash: '/' },
  { name: 'profile-overview', hash: '/profile', scroller: '[role="tabpanel"][data-state="active"]' },
  { name: 'profile-markdown', hash: '/profile', prepare: tab('Markdown') },
  {
    name: 'profile-history',
    hash: '/profile',
    prepare: async (page) => {
      const withEmail = seed.replace('email: ""', 'email: jordan@example.com');
      await invoke(page, 'profile:save', {
        markdown: withEmail,
        expectedHash: null,
        message: 'profile: edit identity',
      });
      await invoke(page, 'profile:save', {
        markdown: withEmail.replace('headline: ""', 'headline: "Data Engineer"'),
        expectedHash: null,
        message: 'profile: edit identity',
      });
      await page.reload();
      await tab('History')(page);
      await page.getByRole('grid', { name: 'Profile versions' }).getByRole('row').nth(2).click(); // an older version
      await page.getByRole('table', { name: /^Changes in/ }).waitFor();
    },
  },
  {
    name: 'rules-edit',
    hash: '/rules',
    prepare: async (page) => {
      await seedRules(page);
      const line = page
        .getByRole('textbox', { name: 'resume.md content' })
        .locator('.cm-line', { hasText: 'page_limit' });
      await line.click();
      await page.keyboard.press('End');
      await page.keyboard.press('Shift+Home');
      await page.keyboard.type('page_limit: 9');
      await page.getByRole('button', { name: /^error/ }).waitFor();
    },
  },
  {
    name: 'rules-compile',
    hash: '/rules',
    prepare: async (page) => {
      await seedRules(page);
      await page
        .getByRole('navigation', { name: 'Files' })
        .getByRole('button', { name: /^resume\.tex/ })
        .click();
      await page.getByRole('button', { name: 'Test compile' }).click();
      await page.getByRole('img', { name: 'PDF preview, page 1' }).waitFor({ timeout: 30_000 });
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'rules-history',
    hash: '/rules',
    prepare: async (page) => {
      await seedRules(
        page,
        ['rules/resume.md', resumeMd().replace('page_limit: 1', 'page_limit: 2')],
        ['rules/resume.md', resumeMd().replace('page_limit: 1', 'page_limit: 3')],
      );
      await tab('History')(page);
      await page.getByRole('grid', { name: 'Versions' }).getByRole('row').nth(2).click();
      await page.getByRole('table', { name: /^Changes in/ }).waitFor();
    },
  },
  {
    name: 'rules-default',
    hash: '/rules',
    prepare: async (page) => {
      await seedRules(page, ['rules/resume.md', resumeMd().replace('page_limit: 1', 'page_limit: 2')]);
      await tab('Default')(page);
    },
  },
  {
    name: 'settings',
    hash: '/settings',
    prepare: async (page) => {
      await page.getByText('Logged in', { exact: true }).waitFor({ timeout: 15_000 });
    },
  },
  { name: 'dev-ui', hash: '/dev/ui' },
  {
    name: 'workspace-intake',
    hash: '/workspace',
    prepare: async (page) => {
      await seedJob(page);
      await page.reload();
      await page.getByRole('grid', { name: 'Recent jobs' }).waitFor();
    },
  },
  { name: 'workspace-job', hash: '/workspace', prepare: openJob },
  {
    name: 'workspace-fit',
    hash: '/workspace',
    prepare: async (page) => {
      await openJob(page);
      await tab('Fit')(page);
    },
  },
  {
    name: 'resume-empty',
    hash: '/workspace',
    prepare: async (page) => openResume(page, await freshJob(page)),
  },
  {
    name: 'resume-draft',
    hash: '/workspace',
    prepare: async (page) => {
      await openResume(page, await drafted(page));
      await pdfDrawn(page);
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'resume-changes',
    hash: '/workspace',
    prepare: async (page) => {
      const id = await drafted(page);
      const v1 = (await invoke(page, 'resume:get', { jobId: id, version: 1 })) as Res<{ tex: string }>;
      await invoke(page, 'resume:saveManual', {
        jobId: id,
        fromVersion: 1,
        tex: v1.data.tex.replace('Owned the', 'Ran the'),
      });
      await openResume(page, id);
      await pdfDrawn(page);
      await page.getByRole('tab', { name: 'Changes' }).click();
      await page.getByRole('table', { name: /^Changes from/ }).waitFor();
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'resume-blocked',
    hash: '/workspace',
    prepare: async (page) => {
      const id = await drafted(page);
      await resumeCall(page, 'resume:revise', { jobId: id, fromVersion: 1, instruction: 'add cost savings' });
      await openResume(page, id);
      await page.getByRole('alert').filter({ hasText: 'Truth check failed' }).waitFor();
      await pdfDrawn(page);
      await page.waitForTimeout(800);
    },
  },
  {
    name: 'resume-running',
    hash: '/workspace',
    prepare: async (page) => {
      await openResume(page, await drafted(page));
      await pdfDrawn(page);
      await page.getByRole('textbox', { name: 'Revise instruction' }).fill('add cost savings');
      await page.getByRole('button', { name: 'Revise', exact: true }).click();
      await page.getByText(/^Drafting · \d+ s$/).waitFor();
    },
  },
  {
    name: 'resume-confirm',
    hash: '/workspace',
    overlay: true,
    prepare: async (page) => {
      const id = await drafted(page);
      await resumeCall(page, 'resume:revise', { jobId: id, fromVersion: 1, instruction: 'add cost savings' });
      await openResume(page, id);
      await page.getByRole('button', { name: 'Open in Overleaf' }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'activity',
    hash: '/workspace',
    prepare: async (page) => {
      await seedJob(page);
      await page.evaluate(() => {
        window.location.hash = '/activity';
      });
      await page.reload();
      await page
        .getByRole('grid', { name: 'AI runs' })
        .getByRole('row', { name: /job\.analyze/ })
        .first()
        .click();
      await page.getByRole('textbox', { name: 'Output' }).waitFor();
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'profile-skill-dialog',
    hash: '/profile',
    overlay: true,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Add skill' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Add skill' }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'profile-import-busy',
    hash: '/profile',
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Import resume' }).click();
      await page.getByText(/^Drafting profile with Claude/).waitFor();
      await page.waitForTimeout(1500);
    },
  },
  {
    name: 'profile-import-review',
    hash: '/profile',
    overlay: true,
    prepare: async (page) => {
      await page.getByRole('button', { name: 'Import resume' }).click();
      await page.getByRole('dialog', { name: /^Review import/ }).waitFor();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'palette',
    hash: '/profile',
    overlay: true,
    prepare: async (page) => {
      await page.keyboard.press('Control+k');
      await page.keyboard.type('prof');
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'profile-toast',
    hash: '/profile',
    overlay: true,
    prepare: async (page) => {
      await page.getByLabel('Email').fill('jordan@example.com');
      await page.getByRole('button', { name: 'Save' }).click();
      await page.getByText('Profile saved', { exact: true }).waitFor();
      await page.waitForTimeout(300);
    },
  },
];

for (const theme of ['dark', 'light'] as const) {
  for (const scene of scenes) {
    test(`${theme} ${scene.name}`, async () => {
      const { page } = l;
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await open(page, scene.hash);
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await scene.prepare?.(page);
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t; // a reload inside prepare drops it
      }, theme);
      await page.waitForTimeout(400); // let colour transitions finish
      const path = `${dir}/${scene.name}-${theme}.png`;
      if (scene.overlay) await page.screenshot({ path });
      else await shotFull(page, path, scene.scroller ?? '#main');
    });
  }
}
