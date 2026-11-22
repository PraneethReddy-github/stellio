import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { APPLICATIONS_DIR, SEED_FILES, STELLIO_DIRS, VERSIONED_PATHS, WATCHED_DIRS } from './layout';
import { GitError, commitFiles, gitInit, hasCommits } from './git';

const IGNORE_ENTRY = '.stellio/';

/** Creates the data folder structure, copies missing seed files (never overwrites), sets up git. Idempotent. */
export async function initDataFolder(
  dataDir: string,
  seedDir: string,
): Promise<{ created: string[]; gitAvailable: boolean; gitError?: string }> {
  const created: string[] = [];
  for (const d of [...WATCHED_DIRS, APPLICATIONS_DIR, ...STELLIO_DIRS]) {
    await mkdir(join(dataDir, d), { recursive: true });
  }

  for (const rel of SEED_FILES) {
    const dest = join(dataDir, rel);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await copyFile(join(seedDir, rel), dest, constants.COPYFILE_EXCL);
      created.push(rel);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }

  const ignorePath = join(dataDir, '.gitignore');
  const ignore = existsSync(ignorePath) ? await readFile(ignorePath, 'utf8') : null;
  if (ignore === null || !ignore.split(/\r?\n/).includes(IGNORE_ENTRY)) {
    const sep = ignore && !ignore.endsWith('\n') ? '\n' : '';
    await writeFile(ignorePath, `${ignore ?? ''}${sep}${IGNORE_ENTRY}\n`);
    if (ignore === null) created.push('.gitignore');
  }

  try {
    if (!existsSync(join(dataDir, '.git'))) await gitInit(dataDir);
    if (!(await hasCommits(dataDir)))
      await commitFiles(dataDir, [...VERSIONED_PATHS], 'init: Stellio data folder');
    else {
      // A new default shipped with an update (a rules file) is versioned like the others.
      const added = created.filter((f) => f !== '.gitignore');
      if (added.length > 0) await commitFiles(dataDir, added, `seed: add ${added.join(', ')}`);
    }
    return { created, gitAvailable: true };
  } catch (e) {
    if (e instanceof GitError && e.code === 'git_missing') return { created, gitAvailable: false };
    // Dubious ownership, corrupt repo: the files are fine, so a git problem must not make startup fatal.
    if (e instanceof GitError && e.code === 'git_failed')
      return { created, gitAvailable: false, gitError: e.message };
    throw e;
  }
}
