import { execFile } from 'node:child_process';
import { posix, resolve } from 'node:path';
import { writeFileAtomic } from './files';

export type GitErrorCode = 'git_missing' | 'git_failed' | 'invalid_argument';

export class GitError extends Error {
  constructor(
    readonly code: GitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface LogEntry {
  hash: string;
  date: string;
  message: string;
}

// Identity and config pinned per call so user/global config and hooks cannot interfere.
const BASE_ARGS = [
  '-c',
  'user.name=Stellio',
  '-c',
  'user.email=stellio@localhost',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.quotepath=false',
];

/** Inherited GIT_* (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE...) override `-C`; global/system config could inject hooks or aliases. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

function run(dir: string, args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    execFile(
      'git',
      [...BASE_ARGS, '-C', dir, ...args],
      { maxBuffer: 64 * 1024 * 1024, env: gitEnv() },
      (err, stdout, stderr) => {
        if (!err) return res(stdout);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          return rej(new GitError('git_missing', 'git is not installed'));
        rej(new GitError('git_failed', stderr.trim() || err.message));
      },
    );
  });
}

// One write at a time per repo: parallel commits would fight over .git/index.lock.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(dir);
  const next = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function checkRef(ref: string): void {
  if (!/^[0-9a-fA-F]{4,64}$/.test(ref)) throw new GitError('invalid_argument', `invalid commit: ${ref}`);
}

function checkRel(rel: string): void {
  const n = posix.normalize(rel);
  if (
    !rel ||
    posix.isAbsolute(rel) ||
    rel.includes('\0') ||
    n === '..' ||
    n.startsWith('../') ||
    n.startsWith('-')
  )
    throw new GitError('invalid_argument', `invalid path: ${rel}`);
}

export async function gitInit(dir: string): Promise<void> {
  await run(dir, ['init']);
}

export async function hasCommits(dir: string): Promise<boolean> {
  try {
    await run(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch (e) {
    if (e instanceof GitError && e.code === 'git_failed') return false;
    throw e;
  }
}

/** Commits the changes under `relPaths` (and nothing else). Returns the new hash, or null if nothing changed. */
export async function commitFiles(dir: string, relPaths: string[], message: string): Promise<string | null> {
  relPaths.forEach(checkRel);
  return serial(dir, async () => {
    // status accepts pathspecs that match nothing; `add`/`commit` would error on them.
    const out = await run(dir, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...relPaths]);
    const changed: string[] = [];
    const tokens = out.split('\0').filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i] as string;
      changed.push(t.slice(3));
      if (t[0] === 'R' || t[0] === 'C') i++; // rename entries carry the old path as an extra token
    }
    if (changed.length === 0) return null;
    await run(dir, ['add', '-A', '--', ...changed]);
    await run(dir, ['commit', '--no-verify', '-m', message, '--only', '--', ...changed]);
    return (await run(dir, ['rev-parse', 'HEAD'])).trim();
  });
}

export async function log(dir: string, opts: { path?: string; limit: number }): Promise<LogEntry[]> {
  if (opts.path !== undefined) checkRel(opts.path);
  const args = ['log', '-n', String(Math.max(1, Math.floor(opts.limit))), '--format=%H%x1f%aI%x1f%s%x1e'];
  if (opts.path !== undefined) args.push('--', opts.path);
  let out: string;
  try {
    out = await run(dir, args);
  } catch (e) {
    if (e instanceof GitError && /does not have any commits/.test(e.message)) return [];
    throw e;
  }
  return out
    .split('\x1e')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash = '', date = '', message = ''] = r.split('\x1f');
      return { hash, date, message };
    });
}

export async function showFileAt(dir: string, hash: string, relPath: string): Promise<string> {
  checkRef(hash);
  checkRel(relPath);
  return run(dir, ['show', `${hash}:${relPath}`]);
}

export async function diff(dir: string, fromHash: string, to: string, relPath: string): Promise<string> {
  checkRef(fromHash);
  if (to !== 'WORKTREE') checkRef(to);
  checkRel(relPath);
  const range = to === 'WORKTREE' ? [fromHash] : [fromHash, to];
  return run(dir, ['diff', '--no-color', '--no-ext-diff', ...range, '--', relPath]);
}

/** Unified diff of what commit `hash` changed in `relPath` (works for the root commit too). */
export async function commitDiff(dir: string, hash: string, relPath: string): Promise<string> {
  checkRef(hash);
  checkRel(relPath);
  return run(dir, ['show', '--no-color', '--no-ext-diff', '--format=', hash, '--', relPath]);
}

/** Restores the file as of `hash` and commits `revert: <path> to <shortHash>`. Returns the commit hash or null. */
export async function restoreFile(dir: string, hash: string, relPath: string): Promise<string | null> {
  const content = await showFileAt(dir, hash, relPath);
  const short = (await run(dir, ['rev-parse', '--short', hash])).trim();
  await writeFileAtomic(resolve(dir, relPath), content);
  return commitFiles(dir, [relPath], `revert: ${relPath} to ${short}`);
}
