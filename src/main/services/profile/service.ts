import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseProfile,
  profileToMarkdown,
  validateProfile,
  type Diagnostic,
  type Profile,
} from '@shared/profile';
import type { TaskConfig } from '@shared/settings/ai';
import type { ClaudeRunner } from '../../ai/runner';
import { aiFailureMessage } from '../../ai/failure';
import { importProfile } from '../../ai/tasks/profileImport';
import { extractResumeText } from '../../ai/extract';
import { UserError } from '../../ipc/dispatch';
import { hashText, writeFileAtomic } from '../datafolder/files';
import { commitDiff, commitFiles, log, restoreFile, type LogEntry } from '../datafolder/git';
import { PROFILE_FILE } from '../datafolder/layout';

export interface ProfileSnapshot {
  markdown: string;
  model: Profile;
  diagnostics: Diagnostic[];
  hash: string;
}

/** Parse diagnostics + model validation, errors first. */
export function analyzeProfile(markdown: string, today = new Date()): Omit<ProfileSnapshot, 'hash'> {
  const { model, diagnostics } = parseProfile(markdown);
  const all = [...diagnostics, ...validateProfile(model, { today })];
  all.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return { markdown, model, diagnostics: all };
}

export interface ProfileServiceDeps {
  dataDir: string;
  gitAvailable: boolean;
  runner: ClaudeRunner;
  importConfig: () => TaskConfig;
}

export function createProfileService({ dataDir, gitAvailable, runner, importConfig }: ProfileServiceDeps) {
  const file = join(dataDir, PROFILE_FILE);

  // Writes run one at a time, so a conflict check and its write can never interleave with another save.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  /**
   * Preserves the current file before it is replaced: edits made outside the app are never in git yet.
   * With git: commit them. Without git: copy the file to .stellio/backups/.
   */
  async function preserveCurrent(reason: string): Promise<void> {
    if (gitAvailable) {
      await commitFiles(dataDir, [PROFILE_FILE], `profile: snapshot before ${reason}`);
      return;
    }
    const dir = join(dataDir, '.stellio', 'backups');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(file, join(dir, `profile-${stamp}.md`));
  }

  async function get(): Promise<ProfileSnapshot> {
    const markdown = await readFile(file, 'utf8');
    return { ...analyzeProfile(markdown), hash: hashText(markdown) };
  }

  /**
   * Writes the profile. `expectedHash` is the hash the editor started from; a mismatch means the file
   * changed on disk meanwhile, and saving would silently drop those changes.
   */
  function save(markdown: string, expectedHash: string | null, message: string): Promise<ProfileSnapshot> {
    return exclusive(async () => {
      const current = await readFile(file, 'utf8');
      if (expectedHash !== null && hashText(current) !== expectedHash) {
        throw new UserError(
          'The profile changed on disk since you opened it. Reload it, then apply your edit again.',
        );
      }
      if (current === markdown) return get();
      await preserveCurrent('save');
      await writeFileAtomic(file, markdown);
      if (gitAvailable) await commitFiles(dataDir, [PROFILE_FILE], message);
      return get();
    });
  }

  async function history(limit: number): Promise<LogEntry[]> {
    if (!gitAvailable) return [];
    return log(dataDir, { path: PROFILE_FILE, limit });
  }

  /** Changes introduced by one commit. */
  async function changesIn(hash: string): Promise<string> {
    requireGit();
    return commitDiff(dataDir, hash, PROFILE_FILE);
  }

  async function revert(hash: string): Promise<ProfileSnapshot> {
    requireGit();
    return exclusive(async () => {
      await preserveCurrent('revert');
      await restoreFile(dataDir, hash, PROFILE_FILE);
      return get();
    });
  }

  /** Reads an old resume and returns a profile draft. Nothing is saved: the user reviews it first. */
  async function importDraft(
    resumeFile: string,
    signal?: AbortSignal,
  ): Promise<Omit<ProfileSnapshot, 'hash'>> {
    let text: string;
    try {
      text = await extractResumeText(resumeFile);
    } catch (err) {
      throw new UserError(`Could not read that file: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (text.trim().length < 50)
      throw new UserError('That file has almost no readable text. Is it a scanned image?');
    const res = await importProfile(runner, { resumeText: text, config: importConfig(), signal });
    if (!res.ok) throw new UserError(aiFailureMessage(res.status, res.error));
    const { importToProfile } = await import('./importMapper');
    const today = new Date().toISOString().slice(0, 10);
    return analyzeProfile(profileToMarkdown(importToProfile(res.data, today)));
  }

  function requireGit(): void {
    if (!gitAvailable) throw new UserError('History needs git, which is not installed.');
  }

  return { file, get, save, history, changesIn, revert, importDraft };
}

export type ProfileService = ReturnType<typeof createProfileService>;
