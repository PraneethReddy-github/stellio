import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initDataFolder } from '../../../src/main/services/datafolder/init';
import { log } from '../../../src/main/services/datafolder/git';
import { SEED_FILES } from '../../../src/main/services/datafolder/layout';
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
      expect((await stat(join(d, 'profile/praneethreddy.md'))).isFile()).toBe(true);
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
