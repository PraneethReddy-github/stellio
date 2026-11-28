import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClaudeRunner } from '../../src/main/ai/runner';
import { UserError } from '../../src/main/ipc/dispatch';
import { initDataFolder } from '../../src/main/services/datafolder/init';
import { createProfileService } from '../../src/main/services/profile/service';
import { parseProfile } from '../../src/shared/profile';
import { isolateGit, SEED_DIR, useTempDirs } from '../unit/datafolder/helpers';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude/claude.mjs', import.meta.url));
const RESUME = fileURLToPath(new URL('../fixtures/resumes/jordan-vale.txt', import.meta.url));
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

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
    languages_spoken: [{ language: 'English', level: 'C1' }],
  },
  summary: 'Data engineer.',
  skills: [
    {
      skill: 'Python',
      category: 'language',
      level: 3,
      years: 3,
      last_used: 'now',
      evidence: ['exp-brightwater'],
      status: 'have',
      aliases: [],
    },
  ],
  experience: [
    {
      id: 'exp-brightwater',
      title: 'Data Engineer — Brightwater',
      meta: { start: '2022-01', end: 'present' },
      bullets: ['Built pipelines.'],
    },
  ],
  projects: [],
  education: [],
  certifications: [],
  awards: [],
  publications: [],
  notes: '',
};

isolateGit();
const tempDir = useTempDirs();
afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_OUTPUT;
});

async function setup(opts: { noGit?: boolean } = {}) {
  const dataDir = await tempDir();
  const { gitAvailable: hasGit } = await initDataFolder(dataDir, SEED_DIR);
  const gitAvailable = hasGit && !opts.noGit;
  const runner = createClaudeRunner({ bin: FAKE, cwd: await tempDir(), logger, retryDelayMs: 1 });
  const service = createProfileService({
    dataDir,
    gitAvailable,
    runner,
    importConfig: () => ({ model: 'sonnet', effort: 'high', timeoutMs: 300_000 }),
  });
  return { dataDir, service };
}

describe('profile service', () => {
  it('loads the seeded profile with diagnostics', async () => {
    const { service } = await setup();
    const snap = await service.get();
    expect(snap.model.frontMatter.name).toBe('Praneeth Reddy');
    expect(snap.hash).toMatch(/^[0-9a-f]{64}$/);
    // The seed has an empty email: the validator must say so.
    expect(snap.diagnostics.map((d) => d.code)).toContain('profile_email_missing');
    expect(snap.diagnostics[0]?.severity).toBe('error');
  });

  it('saves, commits, shows history and diffs, and reverts', async () => {
    const { service } = await setup();
    const before = await service.get();
    const edited = before.markdown.replace('email: ""', 'email: "p@example.com"');
    const after = await service.save(edited, before.hash, 'profile: set email');
    expect(after.model.frontMatter.email).toBe('p@example.com');

    const history = await service.history(10);
    expect(history.map((h) => h.message)).toEqual(['profile: set email', expect.any(String)]);
    const [latest, initial] = history;
    if (!latest || !initial) throw new Error('expected two commits');
    expect(await service.changesIn(latest.hash)).toContain('+email: "p@example.com"');
    expect(await service.changesIn(initial.hash)).toContain('+# Praneeth Reddy');

    const reverted = await service.revert(initial.hash);
    expect(reverted.model.frontMatter.email).toBe('');
    expect((await service.history(10))[0]?.message).toMatch(/^revert: profile\/profile\.md to /);
  });

  it('refuses to overwrite a file that changed on disk', async () => {
    const { service } = await setup();
    const snap = await service.get();
    await writeFile(service.file, snap.markdown + '\nexternal edit\n');
    await expect(service.save(snap.markdown, snap.hash, 'x')).rejects.toBeInstanceOf(UserError);
    expect(await readFile(service.file, 'utf8')).toContain('external edit');
  });

  it('imports a resume into a reviewable draft without saving it', async () => {
    const { service } = await setup();
    process.env.FAKE_CLAUDE_MODE = 'ok';
    process.env.FAKE_CLAUDE_OUTPUT = JSON.stringify(importOutput);
    const original = await readFile(service.file, 'utf8');
    const draft = await service.importDraft(RESUME);
    expect(draft.model.frontMatter.name).toBe('Jordan Vale');
    expect(draft.model.experience[0]?.id).toBe('exp-brightwater');
    expect(parseProfile(draft.markdown).model.skills[0]?.skill).toBe('Python');
    expect(draft.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(await readFile(service.file, 'utf8')).toBe(original);
  });

  it('turns AI failures into user-readable errors', async () => {
    const { service } = await setup();
    process.env.FAKE_CLAUDE_MODE = 'auth';
    await expect(service.importDraft(RESUME)).rejects.toThrow(/not logged in/);
  });

  it('rejects unreadable files', async () => {
    const { service, dataDir } = await setup();
    await expect(service.importDraft(join(dataDir, 'nope.docx'))).rejects.toBeInstanceOf(UserError);
  });

  it('revert keeps edits made outside the app in history', async () => {
    const { service } = await setup();
    const v1 = await service.get();
    await service.save(v1.markdown.replace('email: ""', 'email: "v2@example.com"'), v1.hash, 'profile: v2');
    // Edit in another editor: never committed by the app.
    const external = (await readFile(service.file, 'utf8')).replace('v2@example.com', 'v3@example.com');
    await writeFile(service.file, external);

    const initial = (await service.history(10)).at(-1);
    if (!initial) throw new Error('no history');
    await service.revert(initial.hash);

    const history = await service.history(10);
    const snapshot = history.find((h) => h.message === 'profile: snapshot before revert');
    if (!snapshot) throw new Error('external edit was not preserved');
    expect(await service.changesIn(snapshot.hash)).toContain('v3@example.com');
  });

  it('saving over an unsaved external edit (import accept) snapshots it first', async () => {
    const { service } = await setup();
    const snap = await service.get();
    await writeFile(service.file, snap.markdown + '\nexternal\n');
    await service.save('# Replaced\n', null, 'profile: import');
    const messages = (await service.history(10)).map((h) => h.message);
    expect(messages.slice(0, 2)).toEqual(['profile: import', 'profile: snapshot before save']);
  });

  it('without git, every save keeps a backup copy of the previous file', async () => {
    const { service, dataDir } = await setup({ noGit: true });
    const snap = await service.get();
    await service.save('# New\n', snap.hash, 'x');
    const backups = (await readdir(join(dataDir, '.stellio', 'backups'))).filter((f) =>
      f.startsWith('profile-'),
    );
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dataDir, '.stellio', 'backups', backups[0] ?? ''), 'utf8')).toBe(
      snap.markdown,
    );
    expect(await service.history(5)).toEqual([]);
    await expect(service.revert('abcd')).rejects.toBeInstanceOf(UserError);
  });

  it('concurrent saves from the same base: exactly one wins, the other gets a conflict', async () => {
    const { service } = await setup();
    const snap = await service.get();
    const results = await Promise.allSettled([
      service.save(snap.markdown + '\nA\n', snap.hash, 'a'),
      service.save(snap.markdown + '\nB\n', snap.hash, 'b'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(UserError);
  });

  it('saving identical content is a no-op (no commit)', async () => {
    const { service } = await setup();
    const snap = await service.get();
    const before = (await service.history(10)).length;
    await service.save(snap.markdown, snap.hash, 'same');
    expect(await service.history(10)).toHaveLength(before);
  });
});
