import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initDataFolder } from '../../../src/main/services/datafolder/init';
import { hashText } from '../../../src/main/services/datafolder/files';
import { commitFiles, log } from '../../../src/main/services/datafolder/git';
import { PREVIOUS_SEEDS } from '../../../src/main/services/datafolder/seedHistory';
import { LEGACY_PROFILE_FILE, PROFILE_FILE, SEED_FILES } from '../../../src/main/services/datafolder/layout';
import { SEED_DIR, isolateGit, useTempDirs } from './helpers';

isolateGit();
const tmp = useTempDirs();

describe('initDataFolder', () => {
  it('creates structure, seed files, .gitignore, repo and initial commit', async () => {
    const d = join(await tmp(), 'Stellio');
    const { created, gitAvailable } = await initDataFolder(d, SEED_DIR);
    expect(gitAvailable).toBe(true);
    for (const f of SEED_FILES) {
      expect(created).toContain(f);
      expect(await readFile(join(d, f), 'utf8')).toBe(await readFile(join(SEED_DIR, f), 'utf8'));
    }
    for (const sub of ['applications', '.stellio/logs', '.stellio/backups', '.stellio/ai']) {
      expect((await stat(join(d, sub))).isDirectory()).toBe(true);
    }
    expect(await readFile(join(d, '.gitignore'), 'utf8')).toContain('.stellio/');
    expect(await log(d, { limit: 5 })).toHaveLength(1);
  });

  it('is idempotent and never overwrites existing files', async () => {
    const d = join(await tmp(), 'Stellio');
    await initDataFolder(d, SEED_DIR);
    await writeFile(join(d, 'rules/resume.md'), 'mine\n');
    const second = await initDataFolder(d, SEED_DIR);
    expect(second.created).toEqual([]);
    expect(await readFile(join(d, 'rules/resume.md'), 'utf8')).toBe('mine\n');
    expect(await log(d, { limit: 5 })).toHaveLength(1);
  });

  it('copies only missing seed files and appends to an existing .gitignore', async () => {
    const d = join(await tmp(), 'Stellio');
    await mkdir(join(d, 'rules'), { recursive: true });
    await writeFile(join(d, '.gitignore'), 'node_modules/');
    await writeFile(join(d, 'rules/resume.md'), 'mine\n');
    const { created } = await initDataFolder(d, SEED_DIR);
    expect(created).not.toContain('rules/resume.md');
    expect(created).toContain('rules/cover-letter.md');
    expect(await readFile(join(d, '.gitignore'), 'utf8')).toBe('node_modules/\n.stellio/\n');
    expect(await readFile(join(d, 'rules/resume.md'), 'utf8')).toBe('mine\n');
  });

  it('still creates files when git is missing', async () => {
    const d = join(await tmp(), 'Stellio');
    const old = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      const r = await initDataFolder(d, SEED_DIR);
      expect(r.gitAvailable).toBe(false);
      expect((await stat(join(d, 'profile/profile.md'))).isFile()).toBe(true);
    } finally {
      process.env.PATH = old;
    }
  });

  it('a corrupt .git keeps the files and reports gitAvailable=false with gitError', async () => {
    const d = join(await tmp(), 'Stellio');
    await mkdir(join(d, '.git'), { recursive: true });
    await writeFile(join(d, '.git/HEAD'), 'garbage\n');
    const res = await initDataFolder(d, SEED_DIR);
    expect(res.gitAvailable).toBe(false);
    expect(res.gitError).toEqual(expect.any(String));
    expect(res.gitError).not.toBe('');
    expect(await readFile(join(d, 'rules/resume.md'), 'utf8')).toBe(
      await readFile(join(SEED_DIR, 'rules/resume.md'), 'utf8'),
    );
  });
});

describe('initDataFolder: the profile file name', () => {
  it('is the neutral profile/profile.md', () => {
    expect(PROFILE_FILE).toBe('profile/profile.md');
  });

  it('moves a profile kept under the old fixed name, keeps its content and history, and seeds no template', async () => {
    const d = join(await tmp(), 'Stellio');
    await initDataFolder(d, SEED_DIR);
    await rename(join(d, PROFILE_FILE), join(d, LEGACY_PROFILE_FILE));
    await writeFile(join(d, LEGACY_PROFILE_FILE), '---\nname: Mine\n---\n\n# Mine\n');
    await commitFiles(d, [PROFILE_FILE, LEGACY_PROFILE_FILE], 'test: the old name');
    const r = await initDataFolder(d, SEED_DIR);
    expect(r.created).not.toContain(PROFILE_FILE);
    expect(await readFile(join(d, PROFILE_FILE), 'utf8')).toBe('---\nname: Mine\n---\n\n# Mine\n');
    expect(existsSync(join(d, LEGACY_PROFILE_FILE))).toBe(false);
    const [last] = await log(d, { limit: 1 });
    expect(last?.message).toBe(`rename: ${LEGACY_PROFILE_FILE} to ${PROFILE_FILE}`);
    // the file's history follows it
    expect((await log(d, { path: PROFILE_FILE, limit: 10 })).map((e) => e.message)).toContain(
      'test: the old name',
    );
    expect((await initDataFolder(d, SEED_DIR)).created).toEqual([]);
  });

  it('never touches either file when both names exist', async () => {
    const d = join(await tmp(), 'Stellio');
    await initDataFolder(d, SEED_DIR);
    await writeFile(join(d, LEGACY_PROFILE_FILE), 'old\n');
    await writeFile(join(d, PROFILE_FILE), 'new\n');
    await initDataFolder(d, SEED_DIR);
    expect(await readFile(join(d, LEGACY_PROFILE_FILE), 'utf8')).toBe('old\n');
    expect(await readFile(join(d, PROFILE_FILE), 'utf8')).toBe('new\n');
  });
});

describe('initDataFolder: new defaults for untouched seed files (D28)', () => {
  const OLD: [string, string][] = [
    ['templates/resume.tex', 'tests/fixtures/latex/resume-v1.tex'],
    ['templates/cover-letter.tex', 'tests/fixtures/latex/cover-letter-v1.tex'],
    ['rules/resume.md', 'tests/fixtures/latex/rules-resume-v1.md'],
    ['rules/cover-letter.md', 'tests/fixtures/latex/rules-cover-letter-v1.md'],
  ];

  it('the recorded hashes are the shipped v1 files', async () => {
    for (const [rel, fixture] of OLD)
      expect(PREVIOUS_SEEDS[rel]).toContain(hashText(await readFile(fixture, 'utf8')));
    expect(Object.keys(PREVIOUS_SEEDS)).not.toContain('profile/profile.md');
  });

  it('replaces a file that is exactly an old default, commits it, and keeps the old one in git', async () => {
    const d = join(await tmp(), 'Stellio');
    await initDataFolder(d, SEED_DIR);
    for (const [rel, fixture] of OLD) await writeFile(join(d, rel), await readFile(fixture));
    // an old default with CRLF line endings is still the old default
    await writeFile(
      join(d, 'rules/cover-letter.md'),
      (await readFile(OLD[3]?.[1] ?? '', 'utf8')).replace(/\n/g, '\r\n'),
    );
    await commitFiles(
      d,
      OLD.map(([rel]) => rel),
      'test: back to v1',
    );
    const r = await initDataFolder(d, SEED_DIR);
    expect(r.updated.sort()).toEqual(OLD.map(([rel]) => rel).sort());
    for (const [rel] of OLD)
      expect(await readFile(join(d, rel), 'utf8')).toBe(await readFile(join(SEED_DIR, rel), 'utf8'));
    const [last, previous] = await log(d, { limit: 2 });
    expect(last?.message).toMatch(/^seed: update .* to the new default$/);
    expect(previous?.message).toBe('test: back to v1');
    expect((await initDataFolder(d, SEED_DIR)).updated).toEqual([]);
  });

  it('a template and its rules move together: an edited template keeps its old rules (review finding)', async () => {
    const d = join(await tmp(), 'Stellio');
    await initDataFolder(d, SEED_DIR);
    const mine = `${await readFile('tests/fixtures/latex/resume-v1.tex', 'utf8')}% mine\n`;
    await writeFile(join(d, 'templates/resume.tex'), mine);
    await writeFile(join(d, 'rules/resume.md'), await readFile('tests/fixtures/latex/rules-resume-v1.md'));
    await writeFile(
      join(d, 'templates/cover-letter.tex'),
      await readFile('tests/fixtures/latex/cover-letter-v1.tex'),
    );
    await writeFile(
      join(d, 'rules/cover-letter.md'),
      await readFile('tests/fixtures/latex/rules-cover-letter-v1.md'),
    );
    const r = await initDataFolder(d, SEED_DIR);
    expect(r.updated.sort()).toEqual(['rules/cover-letter.md', 'templates/cover-letter.tex']);
    expect(await readFile(join(d, 'templates/resume.tex'), 'utf8')).toBe(mine);
    expect(await readFile(join(d, 'rules/resume.md'), 'utf8')).toBe(
      await readFile('tests/fixtures/latex/rules-resume-v1.md', 'utf8'),
    );
  });

  it('never touches a file the user changed, even by one character', async () => {
    const d = join(await tmp(), 'Stellio');
    await initDataFolder(d, SEED_DIR);
    const mine = (await readFile('tests/fixtures/latex/resume-v1.tex', 'utf8')).replace(
      'accent}{HTML}{1F2A37}',
      'accent}{HTML}{1F2A38}',
    );
    await writeFile(join(d, 'templates/resume.tex'), mine);
    const r = await initDataFolder(d, SEED_DIR);
    expect(r.updated).toEqual([]);
    expect(await readFile(join(d, 'templates/resume.tex'), 'utf8')).toBe(mine);
  });
});
