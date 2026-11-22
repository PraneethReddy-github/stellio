import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserError } from '../../src/main/ipc/dispatch';
import { initDataFolder } from '../../src/main/services/datafolder/init';
import { createRulesService } from '../../src/main/services/rules/service';
import { isolateGit, SEED_DIR, useTempDirs } from '../unit/datafolder/helpers';

isolateGit();
const tempDir = useTempDirs();

async function setup(opts: { noGit?: boolean } = {}) {
  const dataDir = await tempDir();
  const { gitAvailable: hasGit } = await initDataFolder(dataDir, SEED_DIR);
  const gitAvailable = hasGit && !opts.noGit;
  const service = createRulesService({ dataDir, seedDir: SEED_DIR, gitAvailable });
  return { dataDir, service };
}
const RESUME = 'rules/resume.md';

describe('rules service', () => {
  it('lists the six files with hashes and clean diagnostics', async () => {
    const { service } = await setup();
    const list = await service.list();
    expect(list.map((f) => f.path)).toEqual([
      'rules/resume.md',
      'rules/cover-letter.md',
      'rules/skills-policy.md',
      'rules/referral-message.md',
      'templates/resume.tex',
      'templates/cover-letter.tex',
    ]);
    for (const f of list) {
      expect(f.hash).toMatch(/^[0-9a-f]{64}$/);
      expect([f.errors, f.warnings, f.modified]).toEqual([0, 0, false]);
    }
    expect(list.map((f) => f.kind)).toEqual(['rules', 'rules', 'rules', 'rules', 'template', 'template']);
  });

  it('rejects paths outside the allow-list', async () => {
    const { service } = await setup();
    for (const bad of [
      'profile/praneethreddy.md',
      '../x.md',
      'rules/../profile/praneethreddy.md',
      'rules/new.md',
    ])
      await expect(service.get(bad)).rejects.toBeInstanceOf(UserError);
    await expect(service.save('rules/x.md', 'a', null, 'm')).rejects.toBeInstanceOf(UserError);
  });

  it('saves with diagnostics, marks modified, commits, shows history and diffs, and reverts', async () => {
    const { service } = await setup();
    const before = await service.get(RESUME);
    const edited = before.content.replace('page_limit: 1', 'page_limit: 2');
    const after = await service.save(RESUME, edited, before.hash, 'rules: allow 2 pages');
    expect(after.diagnostics).toEqual([]);
    expect((await service.list()).find((f) => f.path === RESUME)?.modified).toBe(true);

    const history = await service.history(RESUME, 10);
    expect(history.map((h) => h.message)).toEqual(['rules: allow 2 pages', expect.any(String)]);
    const [latest, initial] = history;
    if (!latest || !initial) throw new Error('expected two commits');
    expect(await service.changesIn(RESUME, latest.hash)).toContain('+page_limit: 2');
    // Another file's history stays separate.
    expect(await service.history('rules/skills-policy.md', 10)).toHaveLength(1);

    const reverted = await service.revert(RESUME, initial.hash);
    expect(reverted.content).toBe(before.content);
    expect((await service.history(RESUME, 10))[0]?.message).toMatch(/^revert: rules\/resume\.md to /);
  });

  it('save reports lint errors line-numbered but still writes', async () => {
    const { service } = await setup();
    const snap = await service.get(RESUME);
    const bad = await service.save(
      RESUME,
      snap.content.replace('page_limit: 1', 'page_limit: 9'),
      snap.hash,
      'x',
    );
    expect(bad.diagnostics[0]).toMatchObject({ severity: 'error', line: 4 });
    expect((await service.list()).find((f) => f.path === RESUME)?.errors).toBe(1);
  });

  it('template diagnostics come from the slot parser', async () => {
    const { service } = await setup();
    const t = await service.get('templates/resume.tex');
    const bad = await service.save(
      'templates/resume.tex',
      t.content.replace('%% STELLIO:END skills', ''),
      t.hash,
      'x',
    );
    expect(bad.diagnostics.map((d) => d.code)).toContain('slot_nested');
  });

  it('refuses to overwrite a file that changed on disk', async () => {
    const { service, dataDir } = await setup();
    const snap = await service.get(RESUME);
    await writeFile(join(dataDir, RESUME), snap.content + '\nexternal edit\n');
    await expect(service.save(RESUME, snap.content, snap.hash, 'x')).rejects.toBeInstanceOf(UserError);
    expect(await readFile(join(dataDir, RESUME), 'utf8')).toContain('external edit');
  });

  it('snapshots uncommitted external edits before overwriting', async () => {
    const { service, dataDir } = await setup();
    const snap = await service.get(RESUME);
    await writeFile(join(dataDir, RESUME), snap.content + '\nexternal\n');
    await service.save(RESUME, snap.content, null, 'rules: restore');
    const messages = (await service.history(RESUME, 10)).map((h) => h.message);
    expect(messages.slice(0, 2)).toEqual(['rules: restore', 'rules/resume.md: snapshot before save']);
  });

  it('reset previews the default, then restores it as a commit', async () => {
    const { service } = await setup();
    const snap = await service.get(RESUME);
    await service.save(RESUME, snap.content.replace('page_limit: 1', 'page_limit: 2'), snap.hash, 'edit');
    const preview = await service.resetPreview(RESUME);
    expect(preview.current).toContain('page_limit: 2');
    expect(preview.seedDefault).toBe(snap.content);

    const now = await service.get(RESUME);
    await expect(service.reset(RESUME, 'stale')).rejects.toBeInstanceOf(UserError);
    const reset = await service.reset(RESUME, now.hash);
    expect(reset.content).toBe(snap.content);
    expect((await service.history(RESUME, 1))[0]?.message).toBe('rules/resume.md: reset to default');
    expect((await service.list()).find((f) => f.path === RESUME)?.modified).toBe(false);
  });

  it('concurrent saves from the same base: exactly one wins', async () => {
    const { service } = await setup();
    const snap = await service.get(RESUME);
    const results = await Promise.allSettled([
      service.save(RESUME, snap.content.replace('page_limit: 1', 'page_limit: 2'), snap.hash, 'a'),
      service.save(RESUME, snap.content.replace('page_limit: 1', 'page_limit: 3'), snap.hash, 'b'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
  });

  it('without git, every save keeps a backup and history needs git', async () => {
    const { service, dataDir } = await setup({ noGit: true });
    const snap = await service.get(RESUME);
    await service.save(RESUME, '---\nversion: 1\n---\n', snap.hash, 'x');
    const backups = (await readdir(join(dataDir, '.stellio', 'backups'))).filter((f) =>
      f.startsWith('rules-resume.md'),
    );
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dataDir, '.stellio', 'backups', backups[0] ?? ''), 'utf8')).toBe(snap.content);
    expect(await service.history(RESUME, 5)).toEqual([]);
    await expect(service.revert(RESUME, 'abcd')).rejects.toBeInstanceOf(UserError);
  });
});
