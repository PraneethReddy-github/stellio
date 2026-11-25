import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareDatabase, type Db } from '../../../src/main/db/database';
import { detectInstall } from '../../../src/main/services/updates/install';
import { createUpdatesService, type UpdatesDeps } from '../../../src/main/services/updates/service';
import { isNewer, noteLines } from '../../../src/shared/settings/updates';

describe('isNewer', () => {
  it('compares numerically and refuses anything but x.y.z', () => {
    expect(isNewer('1.0.2', '1.0.1')).toBe(true);
    expect(isNewer('1.10.0', '1.9.9')).toBe(true);
    expect(isNewer('1.0.1', '1.0.1')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
    expect(isNewer('2.0.0-beta', '1.0.1')).toBe(false);
  });
});

describe('noteLines', () => {
  it('drops Markdown marks and keeps list depth', () => {
    expect(noteLines('\n- **Fix:** run `x`\n  - sub\n\n## Title\nplain')).toEqual([
      { depth: 0, text: 'Fix: run x', item: true },
      { depth: 1, text: 'sub', item: true },
      { depth: 0, text: 'Title', item: false },
      { depth: 0, text: 'plain', item: false },
    ]);
  });
});

describe('detectInstall', () => {
  const deb = ['/var/lib/dpkg/info/stellio.list', '/usr/bin/pkexec', '/usr/bin/apt-get'];
  const has = (list: string[]) => (p: string) => list.includes(p);
  it('tells deb, AppImage and anything else apart', () => {
    expect(detectInstall({}, '/opt/Stellio/stellio', has(deb))).toEqual({ kind: 'deb' });
    expect(detectInstall({}, '/opt/Stellio/stellio', has(deb.slice(0, 1)))).toEqual({ kind: 'manual' });
    expect(detectInstall({}, '/home/x/stellio', has(deb))).toEqual({ kind: 'manual' });
    expect(detectInstall({ APPIMAGE: '/a/S.AppImage' }, '/tmp/m/stellio', has(['/a/S.AppImage']))).toEqual({
      kind: 'appimage',
      file: '/a/S.AppImage',
    });
  });
});

describe('updates service', () => {
  let dir: string;
  let db: Db;
  let time = 0;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const FILE = Buffer.from('new stellio '.repeat(1000));
  const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
  const release = (tag: string, over: object = {}) => ({
    tag_name: tag,
    draft: false,
    prerelease: false,
    body: `- notes ${tag}`,
    assets: ['amd64.deb', 'x86_64.AppImage'].map((s) => ({
      name: `Stellio-${tag.slice(1)}-${s}`,
      size: FILE.length,
      digest: `sha256:${sha(FILE)}`,
      browser_download_url: 'https://evil.example/x',
    })),
    ...over,
  });
  const urls: string[] = [];
  const server = (releases: unknown, file: Buffer = FILE, code = 200) =>
    vi.fn<typeof fetch>((u) => {
      urls.push(u as string);
      return Promise.resolve(
        (u as string).includes('api.github.com')
          ? new Response(JSON.stringify(releases), { status: code })
          : new Response(new Uint8Array(file)),
      );
    });
  const make = (fetchFn: typeof fetch, over: Partial<UpdatesDeps> = {}) =>
    createUpdatesService({
      db,
      logger,
      current: '1.0.1',
      autoAllowed: true,
      install: { kind: 'deb' },
      workDir: join(dir, 'work'),
      fetchFn,
      now: () => time,
      ...over,
    });

  beforeEach(() => {
    time = 0;
    urls.length = 0;
    dir = mkdtempSync(join(tmpdir(), 'stellio-upd-'));
    db = prepareDatabase(join(dir, 'x.db'), join(dir, 'b'));
  });
  afterEach(() => {
    db.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('offers the newest stable release with the notes of every version in between', async () => {
    const list = [
      release('v1.0.2'),
      release('v1.10.0'),
      release('v1.2.0'),
      release('v1.0.1'),
      release('v9.0.0', { draft: true }),
      release('v9.0.0', { prerelease: true }),
      release('v9.0.0-rc.1'),
    ];
    const st = await make(server(list)).status();
    expect(st.available).toMatchObject({
      version: '1.10.0',
      url: 'https://github.com/PraneethReddy-github/stellio/releases/tag/v1.10.0',
      installable: true,
      size: FILE.length,
    });
    expect(st.available?.notes.map((n) => n.version)).toEqual(['1.10.0', '1.2.0', '1.0.2']);
  });
  it('checks automatically once a day, also after a failure', async () => {
    const f = server({}, FILE, 500);
    const u = make(f);
    expect((await u.status()).available).toBeNull();
    await u.status();
    expect(f).toHaveBeenCalledTimes(1);
    time += 25 * 60 * 60_000;
    await u.status();
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('never asks on its own when switched off or not allowed; Check now still does', async () => {
    const f = server([release('v1.0.1')]);
    const u = make(f);
    u.set({ autoCheck: false });
    await u.status();
    await make(f, { autoAllowed: false }).status();
    expect(f).not.toHaveBeenCalled();
    expect((await u.checkNow()).available).toBeNull();
    await expect(make(server('junk')).checkNow()).rejects.toThrow(/Could not reach GitHub/);
  });
  it('is not installable without a published checksum or for a manual install', async () => {
    const noDigest = release('v1.1.0');
    for (const a of noDigest.assets) a.digest = '';
    expect((await make(server([noDigest])).status()).available?.installable).toBe(false);
    const u = make(server([release('v1.1.0')]), { install: { kind: 'manual' } });
    expect((await u.status()).available?.installable).toBe(false);
    await expect(u.install('1.1.0', () => undefined)).rejects.toThrow(/no longer offered/);
  });

  it('deb: downloads from the built link, verifies, installs through pkexec apt-get, cleans up', async () => {
    const ran: string[][] = [];
    const phases = new Set<string>();
    const u = make(server([release('v1.1.0')]), {
      runProgram: (file, args) => {
        const pkg = args.at(-1) ?? '';
        expect(readFileSync(pkg)).toEqual(FILE);
        ran.push([file, ...args]);
        return Promise.resolve({ code: 0, output: '' });
      },
    });
    await u.status();
    expect(u.restartAllowed()).toBe(false);
    const st = await u.install('1.1.0', (p) => phases.add(p.phase));
    expect(st.installed).toBe('1.1.0');
    expect(u.restartAllowed()).toBe(true);
    expect([...phases]).toEqual(['download', 'verify', 'install']);
    const pkg = join(dir, 'work', 'Stellio-1.1.0-amd64.deb');
    expect(ran).toEqual([['/usr/bin/pkexec', '/usr/bin/apt-get', 'install', '-y', '--', pkg]]);
    expect(urls.at(-1)).toBe(
      'https://github.com/PraneethReddy-github/stellio/releases/download/v1.1.0/Stellio-1.1.0-amd64.deb',
    );
    expect(existsSync(join(dir, 'work'))).toBe(false);
  });
  it('a changed, short or long file is discarded and nothing runs', async () => {
    const run = vi.fn();
    const bad = Buffer.from(FILE);
    bad[0] = 0;
    for (const file of [bad, FILE.subarray(1), Buffer.concat([FILE, FILE])]) {
      const u = make(server([release('v1.1.0')], file), { runProgram: run });
      await u.status();
      await expect(u.install('1.1.0', () => undefined)).rejects.toThrow(/[Nn]othing was installed/);
      expect((await u.status()).installed).toBeNull();
    }
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'work'))).toBe(false);
  });
  it('a refused password and an apt error are reported, and it can be tried again', async () => {
    const results = [
      { code: 126, output: '' },
      { code: 100, output: 'Reading\nE: Could not get lock' },
      { code: 0, output: '' },
    ];
    const u = make(server([release('v1.1.0')]), {
      runProgram: () => Promise.resolve(results.shift() ?? { code: 1, output: '' }),
    });
    await u.status();
    await expect(u.install('1.1.0', () => undefined)).rejects.toThrow(/password prompt/);
    await expect(u.install('1.1.0', () => undefined)).rejects.toThrow(/Could not get lock/);
    expect((await u.install('1.1.0', () => undefined)).installed).toBe('1.1.0');
  });
  it('AppImage: replaced in place and executable; a bad download leaves the old file', async () => {
    const file = join(dir, 'My.AppImage');
    writeFileSync(file, 'old');
    const broken = make(server([release('v1.1.0')], Buffer.from('x')), {
      install: { kind: 'appimage', file },
    });
    await broken.status();
    await expect(broken.install('1.1.0', () => undefined)).rejects.toThrow(/checksum/);
    expect(readFileSync(file, 'utf8')).toBe('old');
    const u = make(server([release('v1.1.0')]), { install: { kind: 'appimage', file } });
    await u.status();
    await u.install('1.1.0', () => undefined);
    expect(readFileSync(file)).toEqual(FILE);
    expect(statSync(file).mode & 0o111).toBe(0o111);
    expect(readdirSync(dir).filter((f) => f.endsWith('.update'))).toEqual([]);
  });
  it('a download can be cancelled', async () => {
    const list = JSON.stringify([release('v1.1.0')]);
    const u = make((input, init) => {
      if ((input as string).includes('api.github.com')) return Promise.resolve(new Response(list));
      init?.signal?.throwIfAborted();
      return new Promise((_r, reject) =>
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    });
    await u.status();
    const p = u.install('1.1.0', () => undefined);
    const failed = expect(p).rejects.toThrow('Update cancelled.');
    await expect(u.install('1.1.0', () => undefined)).rejects.toThrow(/already being installed/);
    await vi.waitFor(() => expect(u.cancel()).toBe(true));
    await failed;
  });
});
