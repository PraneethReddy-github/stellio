import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CHANGED_ON_DISK } from '@shared/messages';
import type { Diagnostic } from '@shared/profile';
import { parseTemplate } from '@shared/latex/template';
import {
  isRuleFile,
  lintRules,
  RULE_KIND,
  RULES_AND_TEMPLATE_FILES,
  TEMPLATE_KIND,
  isTemplateFile,
  type RulesFile,
} from '@shared/rules';
import { UserError } from '../../ipc/dispatch';
import { hashText, writeFileAtomic } from '../datafolder/files';
import { commitDiff, commitFiles, log, restoreFile, type LogEntry } from '../datafolder/git';

export interface RulesFileInfo {
  path: RulesFile;
  name: string;
  kind: 'rules' | 'template';
  hash: string;
  errors: number;
  warnings: number;
  /** Differs from the bundled default. */
  modified: boolean;
}

export interface RulesFileSnapshot {
  path: RulesFile;
  content: string;
  hash: string;
  diagnostics: Diagnostic[];
}

/** Lints a rules file or template by its path. Pure. */
export function diagnose(path: RulesFile, content: string): Diagnostic[] {
  if (isRuleFile(path)) return lintRules(RULE_KIND[path], content).diagnostics;
  return parseTemplate(content, TEMPLATE_KIND[path]).diagnostics;
}

export interface RulesServiceDeps {
  dataDir: string;
  seedDir: string;
  gitAvailable: boolean;
}

export function createRulesService({ dataDir, seedDir, gitAvailable }: RulesServiceDeps) {
  // Writes run one at a time, so a conflict check and its write can never interleave with another save.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  /** The allow-list is the only path check: callers pass user input here. */
  function allowed(path: string): RulesFile {
    if (!(RULES_AND_TEMPLATE_FILES as readonly string[]).includes(path))
      throw new UserError(`"${path}" is not an editable rules or template file.`);
    return path as RulesFile;
  }
  const abs = (path: RulesFile): string => join(dataDir, path);

  /** Edits made outside the app are not in git yet: commit them before replacing the file. */
  async function preserveCurrent(path: RulesFile, reason: string): Promise<void> {
    if (gitAvailable) {
      await commitFiles(dataDir, [path], `${path}: snapshot before ${reason}`);
      return;
    }
    const dir = join(dataDir, '.stellio', 'backups');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await copyFile(abs(path), join(dir, `${path.replace('/', '-')}-${stamp}`));
  }

  const readDefault = (path: RulesFile): Promise<string> => readFile(join(seedDir, path), 'utf8');

  async function get(rawPath: string): Promise<RulesFileSnapshot> {
    const path = allowed(rawPath);
    const content = await readFile(abs(path), 'utf8');
    return { path, content, hash: hashText(content), diagnostics: diagnose(path, content) };
  }

  async function list(): Promise<RulesFileInfo[]> {
    return Promise.all(
      RULES_AND_TEMPLATE_FILES.map(async (path) => {
        const snap = await get(path);
        const seeded = await readDefault(path).catch(() => null);
        return {
          path,
          name: path.split('/')[1] ?? path,
          kind: isTemplateFile(path) ? ('template' as const) : ('rules' as const),
          hash: snap.hash,
          errors: snap.diagnostics.filter((d) => d.severity === 'error').length,
          warnings: snap.diagnostics.filter((d) => d.severity === 'warning').length,
          modified: seeded !== null && hashText(seeded) !== snap.hash,
        };
      }),
    );
  }

  /** `expectedHash` is the hash the editor started from; a mismatch means the file changed on disk meanwhile. */
  async function save(
    rawPath: string,
    content: string,
    expectedHash: string | null,
    message: string,
  ): Promise<RulesFileSnapshot> {
    const path = allowed(rawPath);
    return exclusive(async () => {
      const current = await readFile(abs(path), 'utf8');
      if (expectedHash !== null && hashText(current) !== expectedHash) {
        throw new UserError(`${path} ${CHANGED_ON_DISK}. Reload it, then apply your edit again.`);
      }
      if (current === content) return get(path);
      await preserveCurrent(path, 'save');
      await writeFileAtomic(abs(path), content);
      if (gitAvailable) await commitFiles(dataDir, [path], message);
      return get(path);
    });
  }

  async function history(rawPath: string, limit: number): Promise<LogEntry[]> {
    const path = allowed(rawPath);
    if (!gitAvailable) return [];
    return log(dataDir, { path, limit });
  }

  async function changesIn(rawPath: string, hash: string): Promise<string> {
    const path = allowed(rawPath);
    requireGit();
    return commitDiff(dataDir, hash, path);
  }

  async function revert(rawPath: string, hash: string): Promise<RulesFileSnapshot> {
    const path = allowed(rawPath);
    requireGit();
    return exclusive(async () => {
      await preserveCurrent(path, 'revert');
      await restoreFile(dataDir, hash, path);
      return get(path);
    });
  }

  /** What "reset to default" would replace and with what; the UI shows the diff before calling reset. */
  async function resetPreview(rawPath: string): Promise<{ current: string; seedDefault: string }> {
    const path = allowed(rawPath);
    return { current: (await get(path)).content, seedDefault: await readDefault(path) };
  }

  async function reset(rawPath: string, expectedHash: string | null): Promise<RulesFileSnapshot> {
    const path = allowed(rawPath);
    return save(path, await readDefault(path), expectedHash, `${path}: reset to default`);
  }

  function requireGit(): void {
    if (!gitAvailable) throw new UserError('History needs git, which is not installed.');
  }

  return { get, list, save, history, changesIn, revert, resetPreview, reset };
}

export type RulesService = ReturnType<typeof createRulesService>;
