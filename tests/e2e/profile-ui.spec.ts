import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { invoke, launchApp, type Launched } from './helpers';

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

// profile.suggest: Docker was finished (learning item done); Rust has no source and Python no 5-point jump.
const suggestOutput = {
  summary: 'Based on the Docker learning item you finished.',
  skill_updates: [
    {
      skill: 'Docker',
      level: 3,
      years: 1,
      last_used: 'now',
      status: 'have',
      evidence: ['exp-example', 'exp-invented'],
      reason: 'You finished the Docker learning item.',
    },
    { skill: 'Rust', level: 3, years: 1, last_used: '2026', status: 'have', evidence: [], reason: 'Notes.' },
  ],
};
const today = (): string => new Date().toISOString().slice(0, 10);

// One app launch for the file; every test starts from the same profile (see beforeEach), so a failure
// can never hide the tests after it.
let l: Launched;
let page: Page;
let seed: string;
let cspErrors: string[];
const profileFile = (): string => join(l.dataDir, 'profile/praneethreddy.md');
const onDisk = (): string => readFileSync(profileFile(), 'utf8');
const toast = (text: string): Locator => page.getByText(text, { exact: true }).last();
const saved = (): Promise<void> => expect(toast('Profile saved')).toBeVisible();
const save = (markdown: string, message: string): Promise<unknown> =>
  invoke(page, 'profile:save', { markdown, expectedHash: null, message });
const editor = (): Locator => page.getByRole('textbox', { name: 'Profile markdown' });
const importButton = (): Locator => page.getByRole('button', { name: /^Import/ });

/** Writes `markdown` through IPC (an own write, so no watcher event) and reloads the screen onto it. */
async function resetTo(markdown: string, message = 'test: reset'): Promise<void> {
  await save(markdown, message);
  await reloadProfile();
}

/** Reloads and waits until the profile editor (and its palette commands) is mounted. */
async function reloadProfile(): Promise<void> {
  await page.reload();
  // Let the reload's own requests finish; axe's evaluate otherwise races them (AbortError).
  await page.waitForLoadState('load');
  await expect(page.getByRole('heading', { name: 'Profile', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add skill' })).toBeVisible();
}

const mockOpenDialog = (file: string | null): Promise<void> =>
  l.app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: f === null, filePaths: f === null ? [] : [f] });
  }, file);

test.beforeAll(async () => {
  l = await launchApp({
    STELLIO_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_MODE: 'ok',
    FAKE_CLAUDE_OUTPUT: JSON.stringify(importOutput),
    FAKE_CLAUDE_OUTPUT_PROFILE_SUGGEST: JSON.stringify(suggestOutput),
    FAKE_CLAUDE_DELAY_MS: '1500',
  });
  page = l.page;
  cspErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && m.text().includes('Content Security Policy')) cspErrors.push(m.text());
  });
  await page.setViewportSize({ width: 1360, height: 860 });
  await page.evaluate(() => {
    window.location.hash = '/profile';
  });
  await expect(page.getByRole('button', { name: 'Add skill' })).toBeVisible();
  seed = onDisk();
});
test.afterAll(async () => {
  await l.close();
});
test.beforeEach(async () => {
  await resetTo(seed);
});
test.afterEach(() => {
  expect(cspErrors).toEqual([]);
});

test('loads the seed profile with its diagnostics in plain words', async () => {
  await expect(page.getByRole('heading', { name: 'Profile', level: 2 })).toBeVisible();
  await expect(page.getByText('profile/praneethreddy.md')).toBeVisible();
  await expect(page.getByText('last reviewed 2026-11-19')).toBeVisible();
  const panel = page.getByRole('complementary', { name: 'Diagnostics' });
  await expect(panel.getByText(/^\d+ errors? · \d+ warnings?$/)).toBeVisible();
  const email = panel.getByText('Email is missing.');
  await expect(email).toBeVisible();
  await expect(email).toHaveAttribute('title', 'profile_email_missing');
  // the seed's example entries are errors until replaced
  const example = panel.getByText(
    'Your profile still has the example entry "Job Title — Company". Replace it.',
  );
  await expect(example).toBeVisible();
  await expect(example).toHaveAttribute('title', 'profile_placeholder');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Discard' })).toHaveCount(0);
});

test('identity edit saves to disk and clears the diagnostic', async () => {
  await page.getByLabel('Email').fill('p@example.com');
  await expect(page.getByRole('button', { name: 'Discard' })).toBeVisible();
  await expect(page.getByText('Email is missing.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save' }).click();
  await saved();
  await expect.poll(onDisk).toContain('email: p@example.com');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('with no problems the diagnostics panel collapses to a ghost button', async () => {
  await resetTo(readFileSync(resolve('tests/fixtures/profiles/full.md'), 'utf8'));
  await expect(page.getByRole('complementary', { name: 'Diagnostics' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show diagnostics (0)' })).toBeVisible();
});

test('discard drops unsaved edits', async () => {
  await page.getByLabel('Headline').fill('Temp');
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByLabel('Headline')).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('skills are grouped by category then name; empty cells show a dash', async () => {
  await resetTo(seed.replace('| Docker | tool | 2 | 1 | 2026 |', '| Docker | tool | 2 |  |  |'));
  const grid = page.getByRole('grid', { name: 'Skills' });
  await expect(grid.getByRole('row').nth(1)).toContainText('SQL'); // data < language < tool
  await expect(grid.getByRole('row').nth(2)).toContainText('Python');
  await expect(grid.getByRole('row').nth(3)).toContainText('Docker');
  await expect(grid.getByRole('row').nth(3).getByText('—')).toHaveCount(2);
});

test('add a skill through the dialog (nothing prefilled), then save with Ctrl+S', async () => {
  await page.getByRole('button', { name: 'Add skill' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add skill' });
  await expect(dialog.getByLabel('Level')).toHaveValue('');
  await expect(dialog.getByLabel('Last used')).toHaveValue('');
  await dialog.getByLabel('Skill', { exact: true }).fill('Rust');
  await dialog.getByLabel('Level').fill('4');
  await dialog.getByLabel('Years').fill('2');
  await dialog.getByLabel('Last used').fill('now');
  await dialog.getByLabel('Evidence').fill('exp-example');
  await dialog.getByRole('button', { name: 'Add skill' }).click();
  await expect(page.getByRole('row', { name: /Rust/ })).toBeVisible();
  await page.keyboard.press('Control+s');
  await saved();
  await expect.poll(onDisk).toMatch(/\| Rust \| language \| 4 \| 2 \| now \| exp-example \| have \|/);
});

test('invalid skill input is explained on its own field, which gets focus', async () => {
  await page.getByRole('button', { name: 'Add skill' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add skill' });
  await dialog.getByLabel('Skill', { exact: true }).fill('Go');
  await dialog.getByRole('button', { name: 'Add skill' }).click();
  const level = dialog.getByLabel('Level');
  await expect(dialog.getByText('Level must be a whole number from 1 to 5.')).toBeVisible();
  await expect(level).toHaveAttribute('aria-invalid', 'true');
  await expect(level).toBeFocused();
  await expect(dialog.getByRole('alert')).toHaveCount(0);

  await level.fill('9');
  await dialog.getByRole('button', { name: 'Add skill' }).click();
  await expect(level).toBeFocused();
  await expect(dialog.getByLabel('Skill', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('a skill that already exists is rejected, by name or alias, case-insensitively', async () => {
  await page.getByRole('button', { name: 'Add skill' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add skill' });
  const name = dialog.getByLabel('Skill', { exact: true });
  await name.fill('python');
  await dialog.getByLabel('Level').fill('3');
  await dialog.getByRole('button', { name: 'Add skill' }).click();
  await expect(dialog.getByText('Python is already in the profile — edit it instead.')).toBeVisible();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toBeFocused();

  await name.fill('Snake'); // "py" is an alias of Python
  await dialog.getByLabel('Aliases').fill('PY');
  await dialog.getByRole('button', { name: 'Add skill' }).click();
  await expect(dialog.getByText('Python is already in the profile — edit it instead.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('renaming a skill onto another one is rejected; keeping its own name is fine', async () => {
  await page.getByRole('row', { name: /SQL/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit skill: SQL' });
  await dialog.getByLabel('Skill', { exact: true }).fill('docker');
  await dialog.getByRole('button', { name: 'Update skill' }).click();
  await expect(dialog.getByText('Docker is already in the profile — edit it instead.')).toBeVisible();
  await dialog.getByLabel('Skill', { exact: true }).fill('sql');
  await dialog.getByLabel('Level').fill('5');
  await dialog.getByRole('button', { name: 'Update skill' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Save' }).click();
  await saved();
  await expect.poll(onDisk).toContain('| sql | data | 5 |');
});

test('edit a skill, then delete it with confirmation', async () => {
  await page.getByRole('row', { name: /Python/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit skill: Python' });
  await dialog.getByLabel('Level').fill('5');
  await dialog.getByRole('button', { name: 'Update skill' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await saved();
  await expect.poll(onDisk).toContain('| Python | language | 5 |');

  await page.getByRole('row', { name: /Python/ }).click();
  await page
    .getByRole('dialog', { name: 'Edit skill: Python' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await page
    .getByRole('dialog', { name: 'Delete skill "Python"?' })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(page.getByRole('row', { name: /Python/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect.poll(onDisk).not.toMatch(/\| Python \|/);
});

test('focus returns to the opener after Escape and after Cancel', async () => {
  const add = page.getByRole('button', { name: 'Add skill' });
  for (const close of ['Escape', 'Cancel']) {
    await add.click();
    const dialog = page.getByRole('dialog', { name: 'Add skill' });
    await expect(dialog).toBeVisible();
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(add).toBeFocused();
  }
});

test('Ctrl+S does nothing while a dialog is open', async () => {
  await page.getByLabel('Email').fill('p@example.com');
  await page.getByRole('button', { name: 'Add skill' }).click();
  await expect(page.getByRole('dialog', { name: 'Add skill' })).toBeVisible();
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(400);
  expect(onDisk()).not.toContain('p@example.com');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
});

test('the skills grid starts on its first row when focused, so Enter opens it', async () => {
  await page.getByRole('grid', { name: 'Skills' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Edit skill: SQL' })).toBeVisible();
});

test('Escape in the diagnostics panel hands focus to the Show diagnostics button', async () => {
  const panel = page.getByRole('complementary', { name: 'Diagnostics' });
  await panel.getByRole('button', { name: 'Close inspector' }).focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Show diagnostics/ })).toBeFocused();
});

test('markdown tab edits save with Ctrl+S; diagnostics jump to their line', async () => {
  await page.getByRole('tab', { name: 'Markdown' }).click();
  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('raw edit marker');
  await page.keyboard.press('Control+s');
  await saved();
  await expect.poll(onDisk).toContain('raw edit marker');

  // An unclosed comment is an error with a line number.
  await page.keyboard.press('Enter');
  await page.keyboard.type('<!-- never closed');
  const row = page.getByRole('button', { name: /HTML comment is never closed/ });
  await expect(row).toBeVisible();
  const line = (await row.getByText(/^L\d+$/).textContent())?.slice(1);
  expect(Number(line)).toBeGreaterThan(10);

  await page.getByRole('tab', { name: 'Overview' }).click();
  await row.click();
  await expect(page.getByRole('tab', { name: 'Markdown' })).toHaveAttribute('data-state', 'active');
  await expect(page.locator('.cm-activeLineGutter')).toHaveText(line ?? '');

  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('button', { name: /HTML comment is never closed/ })).toHaveCount(0);
});

test('typing while a save is pending keeps the new text, the caret and a dirty state', async () => {
  await page.getByRole('tab', { name: 'Markdown' }).click();
  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('AAA');
  await page.keyboard.press('Control+s');
  await page.keyboard.type('BBB'); // the save is still in flight
  await saved();
  await page.keyboard.type('C'); // lands at the caret only if it never moved
  await expect(editor()).toContainText('AAABBBC');
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  await page.keyboard.press('Control+s');
  await expect.poll(onDisk).toContain('AAABBBC');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await expect(editor()).toContainText('AAABBBC');
});

test('the markdown editor keeps its undo history across tab switches', async () => {
  await page.getByRole('tab', { name: 'Markdown' }).click();
  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('ZZZ');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('tab', { name: 'Markdown' }).click();
  await editor().click();
  await page.keyboard.press('Control+z');
  await expect(editor()).not.toContainText('ZZZ');
});

test('history lists commits with a diff; the newest cannot be restored', async () => {
  const withEmail = seed.replace('email: ""', 'email: p@example.com');
  await save(withEmail, 'profile: edit identity');
  await save(`${withEmail}\nraw edit marker\n`, 'profile: edit');
  await reloadProfile();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Open history');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'History' })).toHaveAttribute('data-state', 'active');

  const versions = page.getByRole('grid', { name: 'Profile versions' });
  for (const m of ['profile: edit identity', 'profile: edit'])
    await expect(versions.getByRole('row', { name: new RegExp(m) }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore this version' })).toHaveCount(0);
  await expect(page.getByText('Current version')).toBeVisible();

  await versions
    .getByRole('row', { name: /profile: edit identity/ })
    .first() // newest first: earlier tests leave rows with the same message
    .click();
  await expect(page.getByRole('table', { name: /^Changes in/ })).toContainText('email: p@example.com');
  await expect(page.getByRole('button', { name: 'Restore this version' })).toBeVisible();

  // One compact date per row ("11-19 21:57"), no sideways scrolling in the list.
  await expect(versions.getByRole('row').nth(1).getByRole('gridcell').first()).toHaveText(
    /^\d\d-\d\d \d\d:\d\d$/,
  );
  expect(await versions.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('restore an older version', async () => {
  const withEmail = seed.replace('email: ""', 'email: p@example.com');
  await save(withEmail, 'profile: edit identity');
  await save(`${withEmail}\nraw edit marker\n`, 'profile: edit');
  await reloadProfile();
  await page.getByRole('tab', { name: 'History' }).click();
  await page
    .getByRole('grid', { name: 'Profile versions' })
    .getByRole('row', { name: /profile: edit identity/ })
    .first() // newest first: this test's commit, not one left by an earlier test
    .click();
  await page.getByRole('button', { name: 'Restore this version' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore this version?' });
  await expect(dialog.getByText('Your current file is kept in history first.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore' }).click();
  await expect(toast('Version restored')).toBeVisible();
  const text = onDisk();
  expect(text).toContain('email: p@example.com');
  expect(text).not.toContain('raw edit marker');
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(page.getByLabel('Email')).toHaveValue('p@example.com');
});

test('external edit while clean reloads', async () => {
  writeFileSync(profileFile(), onDisk().replace('headline: ""', 'headline: "From outside"'));
  await expect(toast('Reloaded — the file changed outside Stellio')).toBeVisible();
  await expect(page.getByLabel('Headline')).toHaveValue('From outside');
});

test('external edit while dirty warns; saving conflicts; reload recovers', async () => {
  await page.getByRole('textbox', { name: 'Location', exact: true }).fill('Mine');
  writeFileSync(profileFile(), onDisk().replace('phone: ""', 'phone: "123"'));
  await expect(
    page.getByText('The file changed on disk. Your unsaved edits are based on the old version.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page.getByText('The file changed on disk.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Save' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Could not save the profile' });
  await expect(alert).toContainText('changed on disk');
  await alert.getByRole('button', { name: 'Reload from disk' }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByLabel('Phone')).toHaveValue('123');
  await expect(page.getByRole('textbox', { name: 'Location', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('external edit while dirty can be reloaded from the banner', async () => {
  await page.getByRole('textbox', { name: 'Location', exact: true }).fill('Mine');
  writeFileSync(profileFile(), onDisk().replace('phone: ""', 'phone: "456"'));
  await page.getByRole('button', { name: 'Reload (discard my edits)' }).click();
  await expect(page.getByLabel('Phone')).toHaveValue('456');
  await expect(page.getByRole('textbox', { name: 'Location', exact: true })).toHaveValue('');
});

test('cancelled import does nothing', async () => {
  await mockOpenDialog(null);
  await importButton().click();
  await expect(importButton()).toBeEnabled();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('import: busy state keeps its label, then review the draft and replace the profile', async () => {
  await mockOpenDialog(RESUME_PDF);
  const before = onDisk();
  await importButton().click();
  await expect(page.getByRole('button', { name: 'Importing…' })).toBeVisible();
  await expect(page.getByText(/^Drafting profile with Claude · \d+ s$/)).toBeVisible();
  // The status line must not push the layout into a second scrollbar.
  expect(await page.locator('#main').evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);

  const dialog = page.getByRole('dialog', { name: 'Review import from jordan-vale.pdf' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Your current profile is kept in history.')).toBeVisible();
  await expect(dialog.getByRole('table', { name: 'Current profile against import' })).toContainText(
    'Jordan Vale',
  );
  // "current → import" per section; a drop reads in the bad colour.
  await expect(dialog.getByText('3 → 0', { exact: true })).toBeVisible();
  await expect(dialog.getByText('1 → 1', { exact: true })).toBeVisible();
  const scrollers = await dialog.evaluate((el) =>
    [...el.querySelectorAll('*')]
      .filter((n) => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 1)
      .map((n) => n.getAttribute('aria-label')),
  );
  expect(scrollers).toEqual(['Diff']);
  expect(onDisk()).toBe(before);

  await dialog.getByRole('button', { name: 'Replace profile' }).click();
  await expect(toast('Profile replaced')).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Jordan Vale');
  await expect.poll(onDisk).toContain('name: Jordan Vale');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(
    page
      .getByRole('grid', { name: 'Profile versions' })
      .getByRole('row', { name: /profile: import from jordan-vale.pdf/ }),
  ).toBeVisible();
});

test('the import review returns focus to the Import button on Escape and Cancel', async () => {
  await mockOpenDialog(RESUME_PDF);
  for (const close of ['Escape', 'Cancel']) {
    await importButton().click();
    const dialog = page.getByRole('dialog', { name: 'Review import from jordan-vale.pdf' });
    await expect(dialog).toBeVisible();
    if (close === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Import resume' })).toBeFocused();
  }
});

/** Docker is a finished learning item: the one thing profile.suggest may base an edit on here. */
async function finishDocker(): Promise<void> {
  const item = (await invoke(page, 'learning:add', { skill: 'Docker' })) as { data: { id: string } };
  await invoke(page, 'learning:update', { id: item.data.id, status: 'done' });
}
const suggestButton = (): Locator => page.getByRole('button', { name: 'Suggest updates' });

test('suggest updates: a preview with the diff; nothing is written until you confirm', async () => {
  await finishDocker();
  const before = onDisk();
  await suggestButton().click();
  await expect(page.getByRole('button', { name: 'Reading…' })).toBeVisible();
  await expect(page.getByText(/^Reading your recent decisions and notes · \d+ s$/)).toBeVisible();

  const dialog = page.getByRole('dialog', { name: 'Suggested profile updates' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Based on the Docker learning item you finished.')).toBeVisible();
  const edits = dialog.getByRole('list', { name: 'Suggested edits' });
  await expect(edits).toContainText('Docker');
  await expect(edits).toContainText(
    'level 2 to 3; last used 2026 to now; status learning to have; evidence exp-example added',
  );
  await expect(edits).toContainText('You finished the Docker learning item.');
  // Rust has no source: refused, and said so
  await expect(dialog.getByText(/Not applied: Rust \(no decision/)).toBeVisible();
  const diff = dialog.getByRole('table', { name: 'Profile before and after the suggested updates' });
  await expect(diff).toContainText(`last_reviewed: ${today()}`);
  await expect(diff).toContainText('| Docker | tool | 3 | 1 | now | proj-example, exp-example | have |');
  await expect(diff).not.toContainText('exp-invented');
  expect(onDisk()).toBe(before);

  // cancel: still nothing written, focus is back on the button
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(onDisk()).toBe(before);
  await expect(suggestButton()).toBeFocused();

  // confirm: saved and committed through profile:save with the preview's hash
  await suggestButton().click();
  await page
    .getByRole('dialog', { name: 'Suggested profile updates' })
    .getByRole('button', { name: 'Save these changes' })
    .click();
  await expect(toast('Profile updated')).toBeVisible();
  await expect.poll(onDisk).toContain('| Docker | tool | 3 | 1 | now | proj-example, exp-example | have |');
  expect(onDisk()).toContain(`last_reviewed: ${today()}`);
  expect(onDisk()).not.toContain('Rust');
  await expect(page.getByText(`last reviewed ${today()}`)).toBeVisible();
  await page.getByRole('tab', { name: 'History' }).click();
  await expect(
    page
      .getByRole('grid', { name: 'Profile versions' })
      .getByRole('row', { name: /profile: apply suggested updates/ }),
  ).toBeVisible();
});

test('suggest updates is off while there are unsaved edits', async () => {
  await page.getByLabel('Headline').fill('Temp');
  await expect(suggestButton()).toBeDisabled();
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(suggestButton()).toBeEnabled();
});

// Both themes: tabs, every dialog, the palette and a toast.
const axeScenes: Record<string, () => Promise<void>> = {
  Overview: async () => {
    await expect(page.getByRole('grid', { name: 'Skills' })).toBeVisible();
  },
  Markdown: async () => {
    await page.getByRole('tab', { name: 'Markdown' }).click();
    await expect(page.locator('.cm-editor')).toBeVisible();
  },
  History: async () => {
    await save(`${seed}\n`, 'profile: edit');
    await reloadProfile();
    await page.getByRole('tab', { name: 'History' }).click();
    await expect(page.getByRole('table', { name: /^Changes in/ })).toBeVisible();
  },
  'Skill dialog': async () => {
    await page.getByRole('button', { name: 'Add skill' }).click();
    await page.getByRole('dialog', { name: 'Add skill' }).getByRole('button', { name: 'Add skill' }).click();
    await expect(page.getByText('Skill name is required.')).toBeVisible();
  },
  'Import dialog': async () => {
    await mockOpenDialog(RESUME_PDF);
    await importButton().click();
    await expect(page.getByRole('dialog', { name: /^Review import/ })).toBeVisible();
  },
  'Suggest dialog': async () => {
    await finishDocker();
    await suggestButton().click();
    await expect(page.getByRole('dialog', { name: 'Suggested profile updates' })).toBeVisible();
  },
  'Confirm dialog': async () => {
    await page.getByRole('row', { name: /Python/ }).click();
    await page
      .getByRole('dialog', { name: 'Edit skill: Python' })
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(page.getByRole('dialog', { name: 'Delete skill "Python"?' })).toBeVisible();
  },
  Palette: async () => {
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  },
  Toast: async () => {
    await page.getByLabel('Email').fill('p@example.com');
    await page.getByRole('button', { name: 'Save' }).click();
    await saved();
  },
};

for (const theme of ['dark', 'light'] as const) {
  for (const [scene, open] of Object.entries(axeScenes)) {
    test(`axe: ${scene} in the ${theme} theme`, async () => {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await open();
      // Axe reads colours mid-animation otherwise (a fading dialog lowers every contrast ratio).
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
      if (process.env.SCREENSHOTS && scene === 'Suggest dialog')
        await page.screenshot({
          path: `${process.env.SCREENSHOT_DIR ?? 'docs/screenshots/current'}/profile-suggest-${theme}.png`,
        });
    });
  }
}

test('resume photo: choose a transparent PNG, see it, remove it; a non-image is refused', async () => {
  const section = page.getByRole('region', { name: 'Resume photo' });
  await expect(section.getByText('No photo. Resumes are made without one.')).toBeVisible();
  await mockOpenDialog(resolve('tests/fixtures/latex/photo.png'));
  await section.getByRole('button', { name: 'Choose photo…' }).click();
  await expect(page.getByText('Photo saved', { exact: true })).toBeVisible();
  await expect(section.getByRole('img', { name: 'Your resume photo' })).toBeVisible();
  // Electron decoded the PNG, put the transparent pixels on white and stored a JPEG.
  const state = (await invoke(page, 'photo:get')) as { data: { dataUrl: string } };
  expect(state.data.dataUrl.startsWith('data:image/jpeg;base64,/9j/')).toBe(true);

  await mockOpenDialog(resolve('tests/fixtures/profiles/full.md'));
  await section.getByRole('button', { name: 'Change photo…' }).click();
  await expect(page.getByText('Pick a PNG or JPEG image.')).toBeVisible();
  await expect(section.getByRole('img', { name: 'Your resume photo' })).toBeVisible();

  await section.getByRole('button', { name: 'Remove' }).click();
  await expect(section.getByText('No photo. Resumes are made without one.')).toBeVisible();
});
