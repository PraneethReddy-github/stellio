import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  GitError,
  commitFiles,
  diff,
  gitInit,
  log,
  restoreFile,
  showFileAt,
} from '../../../src/main/services/datafolder/git';
import { isolateGit, useTempDirs } from './helpers';

isolateGit();
const tmp = useTempDirs();

async function repo(): Promise<string> {
  const d = await tmp();
  await gitInit(d);
  return d;
}

async function commit(d: string, paths: string[], msg: string): Promise<string> {
  const h = await commitFiles(d, paths, msg);
  if (!h) throw new Error('expected a commit');
  return h;
}

const status = (d: string): string => execFileSync('git', ['status', '--porcelain'], { cwd: d }).toString();

describe('git', () => {
  it('commitFiles commits changes and is a no-op when nothing changed', async () => {
    const d = await repo();
    await mkdir(join(d, 'profile'));
    await writeFile(join(d, 'profile', 'p.md'), 'v1\n');
    const h = await commitFiles(d, ['profile/p.md'], 'profile: add');
    expect(h).toMatch(/^[0-9a-f]{40}$/);
    expect(await commitFiles(d, ['profile/p.md'], 'again')).toBeNull();
    expect(await commitFiles(d, ['profile/never-existed.md'], 'nothing')).toBeNull();
    expect((await log(d, { limit: 10 })).map((e) => e.message)).toEqual(['profile: add']);
  });

  it('commits only the given paths and deletions', async () => {
    const d = await repo();
    await writeFile(join(d, 'a.md'), '1');
    await writeFile(join(d, 'b.md'), '1');
    await commitFiles(d, ['a.md', 'b.md'], 'init');
    await writeFile(join(d, 'a.md'), '2');
    await writeFile(join(d, 'b.md'), '2');
    await commitFiles(d, ['a.md'], 'a only');
    expect(status(d)).toBe(' M b.md\n');
    await rm(join(d, 'b.md'));
    await commitFiles(d, ['b.md'], 'rm b');
    expect(status(d)).toBe('');
  });

  it('is robust to user hooks', async () => {
    const d = await repo();
    await mkdir(join(d, '.git', 'hooks'), { recursive: true });
    await writeFile(join(d, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await writeFile(join(d, 'a.md'), '1');
    expect(await commitFiles(d, ['a.md'], 'ok')).not.toBeNull();
  });

  it('log returns [] for a repo without commits and supports path/limit', async () => {
    const d = await repo();
    expect(await log(d, { limit: 5 })).toEqual([]);
    await writeFile(join(d, 'a.md'), '1');
    await writeFile(join(d, 'b.md'), '1');
    await commitFiles(d, ['a.md'], 'one');
    await commitFiles(d, ['b.md'], 'two');
    await writeFile(join(d, 'a.md'), '2');
    await commitFiles(d, ['a.md'], 'three');
    expect((await log(d, { limit: 2 })).map((e) => e.message)).toEqual(['three', 'two']);
    const forA = await log(d, { path: 'a.md', limit: 10 });
    expect(forA.map((e) => e.message)).toEqual(['three', 'one']);
    expect(forA[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(forA[0]?.date ?? '').getTime()).not.toBeNaN();
  });

  it('showFileAt and diff', async () => {
    const d = await repo();
    await writeFile(join(d, 'a.md'), 'one\n');
    const h1 = await commit(d, ['a.md'], 'one');
    await writeFile(join(d, 'a.md'), 'two\n');
    const h2 = await commit(d, ['a.md'], 'two');
    await writeFile(join(d, 'a.md'), 'three\n');
    expect(await showFileAt(d, h1, 'a.md')).toBe('one\n');
    const d12 = await diff(d, h1, h2, 'a.md');
    expect(d12).toContain('-one');
    expect(d12).toContain('+two');
    expect(await diff(d, h2, 'WORKTREE', 'a.md')).toContain('+three');
  });

  it('restoreFile restores content and commits a revert', async () => {
    const d = await repo();
    await writeFile(join(d, 'a.md'), 'one\n');
    const h1 = await commit(d, ['a.md'], 'one');
    await writeFile(join(d, 'a.md'), 'two\n');
    await commitFiles(d, ['a.md'], 'two');
    await restoreFile(d, h1, 'a.md');
    expect(await readFile(join(d, 'a.md'), 'utf8')).toBe('one\n');
    expect((await log(d, { limit: 1 }))[0]?.message).toBe(`revert: a.md to ${h1.slice(0, 7)}`);
  });

  it('rejects unsafe refs and paths', async () => {
    const d = await repo();
    await expect(showFileAt(d, '--output=x', 'a.md')).rejects.toBeInstanceOf(GitError);
    await expect(showFileAt(d, 'abcdef1', '../etc/passwd')).rejects.toBeInstanceOf(GitError);
    await expect(commitFiles(d, ['/etc/passwd'], 'x')).rejects.toBeInstanceOf(GitError);
  });

  it('serialises concurrent commits', async () => {
    const d = await repo();
    await Promise.all(
      ['a', 'b', 'c', 'd'].map(async (n) => {
        await writeFile(join(d, `${n}.md`), n);
        await commitFiles(d, [`${n}.md`], `add ${n}`);
      }),
    );
    expect(await log(d, { limit: 10 })).toHaveLength(4);
  });

  it('returns a typed error when git is missing', async () => {
    const d = await tmp();
    const old = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      await expect(log(d, { limit: 1 })).rejects.toMatchObject({ code: 'git_missing' });
    } finally {
      process.env.PATH = old;
    }
  });

  it('ignores inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE', async () => {
    const other = await repo();
    const d = await repo();
    await writeFile(join(d, 'a.md'), 'a');
    const saved = { ...process.env };
    process.env.GIT_DIR = join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    process.env.GIT_INDEX_FILE = join(other, '.git/index');
    try {
      expect(await commitFiles(d, ['a.md'], 'add a')).not.toBeNull();
      expect(await log(d, { limit: 5 })).toHaveLength(1);
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_WORK_TREE;
      delete process.env.GIT_INDEX_FILE;
      Object.assign(process.env, saved);
    }
    expect(await log(other, { limit: 5 })).toEqual([]);
  });
});
