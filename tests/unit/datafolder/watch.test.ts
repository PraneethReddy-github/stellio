import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashText, writeFileAtomic } from '../../../src/main/services/datafolder/files';
import { noteOwnWrite, watchDataFolder } from '../../../src/main/services/datafolder/watch';
import { sleep, useTempDirs, waitFor } from './helpers';

const tmp = useTempDirs();

describe('watchDataFolder', () => {
  let dir: string;
  let events: string[];
  let stop: () => void;

  beforeEach(async () => {
    dir = await tmp();
    for (const s of ['profile', 'rules', 'templates', 'applications']) await mkdir(join(dir, s));
    await writeFile(join(dir, 'profile/p.md'), 'v1\n');
    events = [];
    stop = watchDataFolder(dir, (rel) => events.push(rel));
    await sleep(100);
  });
  afterEach(() => stop());

  it('fires once (debounced) for external edits, with posix relative path', async () => {
    for (let i = 0; i < 5; i++) await writeFile(join(dir, 'profile/p.md'), `edit ${i}\n`);
    await waitFor(() => events.length > 0);
    await sleep(700);
    expect(events).toEqual(['profile/p.md']);
  });

  it('watches rules/ and templates/ but not applications/', async () => {
    await writeFile(join(dir, 'applications/x.md'), 'x');
    await writeFile(join(dir, 'rules/r.md'), 'r');
    await writeFile(join(dir, 'templates/t.tex'), 't');
    await waitFor(() => events.length >= 2);
    await sleep(500);
    expect([...events].sort()).toEqual(['rules/r.md', 'templates/t.tex']);
  });

  it('stays silent for own writes (atomic write and noteOwnWrite)', async () => {
    await writeFileAtomic(join(dir, 'profile/p.md'), 'own\n');
    const f = join(dir, 'rules/r.md');
    await writeFile(f, 'noted\n');
    noteOwnWrite(f, hashText('noted\n'));
    await writeFile(join(dir, 'templates/sentinel.tex'), 's');
    await waitFor(() => events.includes('templates/sentinel.tex'));
    await sleep(500);
    expect(events).toEqual(['templates/sentinel.tex']);
  });

  it('fires for an external edit after an own write, even back to the same bytes', async () => {
    const f = join(dir, 'profile/p.md');
    await writeFileAtomic(f, 'own\n');
    await sleep(600);
    await writeFile(f, 'external\n');
    await waitFor(() => events.length === 1);
    await writeFile(f, 'own\n');
    await waitFor(() => events.length === 2);
  });

  it('survives editors that save via rename, repeatedly', async () => {
    const f = join(dir, 'profile/p.md');
    for (let i = 0; i < 3; i++) {
      events.length = 0;
      await writeFile(join(dir, 'profile/.p.md.swp-tmp'), `renamed ${i}\n`);
      await rename(join(dir, 'profile/.p.md.swp-tmp'), f);
      await waitFor(() => events.includes('profile/p.md'));
      expect(await readFile(f, 'utf8')).toBe(`renamed ${i}\n`);
      await sleep(400);
    }
  });

  it('reports deletions', async () => {
    await rm(join(dir, 'profile/p.md'));
    await waitFor(() => events.includes('profile/p.md'));
  });

  it('stops after dispose', async () => {
    stop();
    await writeFile(join(dir, 'profile/p.md'), 'after\n');
    await sleep(700);
    expect(events).toEqual([]);
  });
});
