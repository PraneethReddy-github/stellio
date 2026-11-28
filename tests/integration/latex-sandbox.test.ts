import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compileTex,
  pdfText,
  warmUp,
  withoutPhoto,
  type CompileResult,
} from '../../src/main/services/latex/compile';
import { detectEngine, type Engine } from '../../src/main/services/latex/engine';
import { probeSandbox, SANDBOX_MISSING_MESSAGE } from '../../src/main/services/latex/sandbox';

/**
 * File-access escapes found in review (tectonic 0.17 `--untrusted` does not stop them): `\input`/`\openin` of
 * any readable file, `\openout` to absolute paths and `../`. Both layers must hold on their own.
 */
const BIN = process.env.STELLIO_TECTONIC_BIN || resolve('spikes/latex/bin/tectonic');
const engine: Engine | null = existsSync(BIN)
  ? await detectEngine({ override: BIN, env: { PATH: '' } })
  : null;
const probe = engine ? await probeSandbox(engine.path) : null;
const skipReason = !probe
  ? 'no tectonic binary (STELLIO_TECTONIC_BIN or spikes/latex/bin/tectonic)'
  : probe.ok
    ? ''
    : `bubblewrap sandbox unusable: ${probe.reason}`;
if (skipReason) console.warn(`\n!!! SKIPPING LaTeX sandbox escape tests: ${skipReason}\n`);

const seed = (f: string): string => readFileSync(resolve('seed/templates', f), 'utf8');
const doc = (body: string): string =>
  `\\documentclass{article}\n\\begin{document}\nok\n${body}\n\\end{document}\n`;

describe.skipIf(!!skipReason)('LaTeX sandbox (tectonic + bwrap)', { timeout: 60_000 }, () => {
  const e = engine as Engine;
  let dir: string;
  let secretFile: string;
  const secret = `SECRET${randomUUID().replaceAll('-', '')}`;
  const hostname = existsSync('/etc/hostname') ? readFileSync('/etc/hostname', 'utf8').trim() : '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'stellio-escape-'));
    secretFile = join(dir, 'secret.txt');
    await writeFile(secretFile, `${secret}\n`);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(join(tmpdir(), 'escaped.txt'), { force: true });
  });

  /** Nothing from `secret` or the hostname in the PDF, log or errors. */
  async function expectNoLeak(r: CompileResult) {
    const all = [r.log, JSON.stringify(r.errors), r.pdf ? await pdfText(r.pdf) : ''].join('\n');
    expect(all).not.toContain(secret);
    if (hostname.length >= 4) expect(all).not.toContain(hostname);
  }

  const reads = (f: () => string) =>
    [
      ['\\input', () => `\\input{${f()}}`],
      ['\\openin', () => `\\newread\\r\\openin\\r=${f()} \\read\\r to\\x \\x`],
    ] as const;

  for (const [name, body] of [...reads(() => secretFile), ...reads(() => '/etc/hostname')]) {
    it(`${name} of a host file is rejected by the pre-check`, async () => {
      const r = await compileTex({ engine: e, tex: doc(body()) });
      expect(r.ok).toBe(false);
      expect(r.errors[0]?.message).toMatch(/^Stellio templates can't read or write files: .* on line 4$/);
      await expectNoLeak(r);
    });
    it(`${name} of a host file is blocked by the sandbox without the pre-check`, async () => {
      const r = await compileTex({ engine: e, tex: doc(body()), precheck: false });
      await expectNoLeak(r);
    });
  }

  for (const precheck of [true, false]) {
    it(`\\openout to an absolute path and ../ creates nothing outside (precheck ${String(precheck)})`, async () => {
      const abs = join(dir, `abs-${String(precheck)}.txt`);
      const body = [
        `\\newwrite\\o\\newwrite\\p \\immediate\\openout\\o=${abs} \\immediate\\write\\o{pwned}\\immediate\\closeout\\o`,
        '\\immediate\\openout\\p=../escaped.txt \\immediate\\write\\p{pwned}\\immediate\\closeout\\p',
      ].join('\n');
      await compileTex({ engine: e, tex: doc(body), precheck });
      expect(existsSync(abs)).toBe(false);
      expect(existsSync(join(tmpdir(), 'escaped.txt'))).toBe(false);
      expect((await readdir(dir)).sort()).toEqual(['secret.txt']);
    });
  }

  it('a warm compile works offline inside the sandbox (no network namespace)', async () => {
    const r = await compileTex({ engine: e, tex: seed('resume.tex') });
    expect(r.errors).toEqual([]);
    expect([r.ok, r.pages]).toEqual([true, 1]);
  });

  it('refuses to compile when no sandbox is available', async () => {
    const r = await compileTex({ engine: e, tex: seed('resume.tex'), sandbox: null });
    expect(r.ok).toBe(false);
    expect(r.sandboxUnavailable).toBe(true);
    expect(r.errors).toEqual([{ message: SANDBOX_MISSING_MESSAGE }]);
  });

  it('the probe reports a missing bwrap', async () => {
    expect(await probeSandbox(`${e.path}-not-cached`, { PATH: '/nonexistent' })).toEqual({
      ok: false,
      reason: SANDBOX_MISSING_MESSAGE,
    });
  });

  it.skipIf(process.env.STELLIO_NET_TESTS !== '1')(
    'warm-up with a resume that shows the photo: works with the photo given, and with the photo switched off (STELLIO_NET_TESTS=1)',
    { timeout: 6 * 60_000 },
    async () => {
      const cache = await mkdtemp(join(tmpdir(), 'stellio-warmcache-'));
      const prev = process.env.XDG_CACHE_HOME;
      process.env.XDG_CACHE_HOME = cache;
      try {
        // as render.ts writes it when a photo is set
        const withPhoto = seed('resume.tex').replace(
          '%% STELLIO:SLOT header\n',
          '%% STELLIO:SLOT header\n\\resumephototrue\n',
        );
        expect(withPhoto).toMatch(/^\\resumephototrue$/m);
        const photo = new Uint8Array(await readFile('tests/fixtures/latex/photo.jpg'));
        const given = await warmUp(e, [withPhoto], undefined, photo);
        expect(given.errors).toEqual([]);
        expect(given.ok).toBe(true);
        const off = await warmUp(e, [withoutPhoto(withPhoto)]);
        expect(off.errors).toEqual([]);
        expect(off.ok).toBe(true);
      } finally {
        if (prev === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = prev;
        await rm(cache, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.env.STELLIO_NET_TESTS !== '1')(
    'warm-up downloads the packages inside the sandbox (STELLIO_NET_TESTS=1)',
    { timeout: 6 * 60_000 },
    async () => {
      const cache = await mkdtemp(join(tmpdir(), 'stellio-warmcache-'));
      const prev = process.env.XDG_CACHE_HOME;
      process.env.XDG_CACHE_HOME = cache;
      try {
        const r = await warmUp(e, [seed('resume.tex')]);
        expect(r.errors).toEqual([]);
        expect(r.ok).toBe(true);
        expect(await readdir(join(cache, 'tectonic'))).toContain('formats');
      } finally {
        if (prev === undefined) delete process.env.XDG_CACHE_HOME;
        else process.env.XDG_CACHE_HOME = prev;
        await rm(cache, { recursive: true, force: true });
      }
    },
  );
});
