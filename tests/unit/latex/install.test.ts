import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { InstallError, installTectonic, TECTONIC_RELEASE } from '../../../src/main/services/latex/install';
import { useTempDirs } from '../datafolder/helpers';

const tempDir = useTempDirs();
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

let tarball: Buffer;
let evil: Buffer;
beforeAll(async () => {
  const dir = await tempDir();
  writeFileSync(join(dir, 'tectonic'), '#!/bin/sh\necho fake\n');
  writeFileSync(join(dir, 'other'), 'x');
  execFileSync('tar', ['-czf', join(dir, 'good.tar.gz'), '-C', dir, 'tectonic', 'other']);
  tarball = readFileSync(join(dir, 'good.tar.gz'));
  execFileSync('tar', ['-czf', join(dir, 'evil.tar.gz'), '-C', dir, 'other']);
  evil = readFileSync(join(dir, 'evil.tar.gz'));
});

const fakeFetch =
  (body: Buffer, init: ResponseInit = {}): typeof fetch =>
  () =>
    Promise.resolve(new Response(new Uint8Array(body), { status: 200, ...init }));
const URL_OK = 'https://example.invalid/tectonic.tar.gz';

describe('installTectonic', () => {
  it('pins https GitHub release 0.17.0 with a sha256', () => {
    expect(TECTONIC_RELEASE.url).toMatch(/^https:\/\/github\.com\/tectonic-typesetting\/.*0\.17\.0/);
    expect(TECTONIC_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies the hash, extracts only the tectonic binary, makes it executable, reports progress', async () => {
    const dest = await tempDir();
    const phases: string[] = [];
    const path = await installTectonic(dest, {
      fetchFn: fakeFetch(tarball),
      url: URL_OK,
      sha256: sha(tarball),
      onProgress: (p) => phases.push(p.phase),
    });
    expect(path).toBe(join(dest, 'tectonic'));
    expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(execFileSync(path).toString()).toBe('fake\n');
    expect(await readdir(dest)).toEqual(['tectonic']); // no `other`, no staging dir
    expect(phases[0]).toBe('download');
    expect(phases.slice(-3)).toEqual(['verify', 'extract', 'done']);
  });

  it('a hash mismatch is rejected and nothing is written or run', async () => {
    const dest = await tempDir();
    await expect(
      installTectonic(dest, { fetchFn: fakeFetch(tarball), url: URL_OK, sha256: 'f'.repeat(64) }),
    ).rejects.toThrow(/checksum/);
    expect(existsSync(join(dest, 'tectonic'))).toBe(false);
    expect(await readdir(dest)).toEqual([]);
  });

  it('rejects a verified archive without the binary', async () => {
    const dest = await tempDir();
    await expect(
      installTectonic(dest, { fetchFn: fakeFetch(evil), url: URL_OK, sha256: sha(evil) }),
    ).rejects.toBeInstanceOf(InstallError);
    expect(await readdir(dest)).toEqual([]);
  });

  it('refuses non-https URLs and non-https redirects', async () => {
    const dest = await tempDir();
    await expect(
      installTectonic(dest, { fetchFn: fakeFetch(tarball), url: 'http://x/t.tgz', sha256: sha(tarball) }),
    ).rejects.toThrow(/https/);
    const redirected: typeof fetch = () => {
      const r = new Response(new Uint8Array(tarball));
      Object.defineProperty(r, 'url', { value: 'http://evil/t.tgz' });
      return Promise.resolve(r);
    };
    await expect(
      installTectonic(dest, { fetchFn: redirected, url: URL_OK, sha256: sha(tarball) }),
    ).rejects.toThrow(/https/);
  });

  it('reports HTTP failures and oversize downloads', async () => {
    const dest = await tempDir();
    await expect(
      installTectonic(dest, { fetchFn: fakeFetch(Buffer.alloc(0), { status: 404 }), url: URL_OK }),
    ).rejects.toThrow(/HTTP 404/);
    await expect(
      installTectonic(dest, {
        fetchFn: fakeFetch(tarball, { headers: { 'content-length': String(1024 ** 3) } }),
        url: URL_OK,
      }),
    ).rejects.toThrow(/larger/);
  });

  it('can be aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const abortingFetch: typeof fetch = (_u, init) => {
      init?.signal?.throwIfAborted();
      return Promise.resolve(new Response('x'));
    };
    await expect(
      installTectonic(await tempDir(), { fetchFn: abortingFetch, url: URL_OK, signal: ac.signal }),
    ).rejects.toThrow();
  });
});
