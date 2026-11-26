import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { APPLICATIONS_DIR, SEED_FILES, STELLIO_DIRS, VERSIONED_PATHS, WATCHED_DIRS } from './layout';
import { hashText, writeFileAtomic } from './files';
import { GitError, commitFiles, gitInit, hasCommits } from './git';
import { PREVIOUS_SEEDS, SEED_PAIRS } from './seedHistory';

const IGNORE_ENTRY = '.stellio/';

/**
 * Creates the data folder structure, copies missing seed files, sets up git. Idempotent. An existing file is
 * replaced only when it is exactly an earlier shipped default (D28: the user never changed it); the old content
 * stays in git history.
 */
export async function initDataFolder(
  dataDir: string,
  seedDir: string,
): Promise<{ created: string[]; updated: string[]; gitAvailable: boolean; gitError?: string }> {
  const created: string[] = [];
  const updated: string[] = [];
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

  // A template and its rules file belong together: replace them only when neither was changed by the user.
  const untouched = async (rel: string): Promise<boolean> =>
    created.includes(rel) ||
    (PREVIOUS_SEEDS[rel]?.includes(hashText(await readFile(join(dataDir, rel), 'utf8'))) ?? false);
  for (const pair of SEED_PAIRS) {
    if (!(await Promise.all(pair.map(untouched))).every(Boolean)) continue;
    for (const rel of pair.filter((r) => !created.includes(r))) {
      await writeFileAtomic(join(dataDir, rel), await readFile(join(seedDir, rel), 'utf8'));
      updated.push(rel);
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
      if (updated.length > 0)
        await commitFiles(dataDir, updated, `seed: update ${updated.join(', ')} to the new default`);
    }
    return { created, updated, gitAvailable: true };
  } catch (e) {
    if (e instanceof GitError && e.code === 'git_missing') return { created, updated, gitAvailable: false };
    // Dubious ownership, corrupt repo: the files are fine, so a git problem must not make startup fatal.
    if (e instanceof GitError && e.code === 'git_failed')
      return { created, updated, gitAvailable: false, gitError: e.message };
    throw e;
  }
}
